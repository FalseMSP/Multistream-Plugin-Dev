'use strict';

/**
 * queue.js
 * ────────
 * In-memory event bus that decouples platform modules (Twitch, YouTube)
 * from consumers (Discord, overlay, plugins).
 *
 * Three event types:
 *  • message  — a chat message from any platform
 *  • redeem   — a Twitch channel point redemption
 *  • donation — bits, subs, resubscriptions, gifted subs
 *
 * Usage (producer):
 *   queue.pushMessage({ platform, username, message });
 *   queue.pushRedeem({ username, title, cost, input, timestamp });
 *   queue.pushDonation({ platform, type, username, ... });
 *
 * Usage (consumer — called once at startup):
 *   queue.onMessage(msg     => discord.sendChat(msg));
 *   queue.onRedeem(redeem   => discord.sendRedeem(redeem));
 *   queue.onDonation(don    => discord.sendDonation(don));
 */

const log = require('./logger');
// Lazy-required to avoid circular dependency (plugins → queue → plugins).
// Safe because pushMessage is only called after all modules have loaded.
let _runPipeline = null;
function _getPipeline() {
  if (!_runPipeline) _runPipeline = require('./plugins').runPipeline;
  return _runPipeline;
}

// ── Internal handler registries ───────────────────────────────────────────

/** @type {Array<(msg: object) => void>} */
const _messageHandlers  = [];

/** @type {Array<(redeem: object) => void>} */
const _redeemHandlers   = [];

/** @type {Array<(donation: object) => void>} */
const _donationHandlers = [];

// ── Registration (consumer API) ───────────────────────────────────────────

/**
 * Register a handler to be called for every chat message.
 * @param {(msg: { platform: string, username: string, message: string }) => void} fn
 */
function onMessage(fn) {
  if (typeof fn !== 'function') throw new TypeError('queue.onMessage: handler must be a function');
  _messageHandlers.push(fn);
}

/**
 * Register a handler to be called for every channel point redemption.
 * @param {(redeem: { username: string, title: string, cost: number, input: string|null, timestamp: Date }) => void} fn
 */
function onRedeem(fn) {
  if (typeof fn !== 'function') throw new TypeError('queue.onRedeem: handler must be a function');
  _redeemHandlers.push(fn);
}

/**
 * Register a handler to be called for every donation/sub/cheer event.
 * @param {(donation: object) => void} fn
 */
function onDonation(fn) {
  if (typeof fn !== 'function') throw new TypeError('queue.onDonation: handler must be a function');
  _donationHandlers.push(fn);
}

// ── Dispatch helpers ──────────────────────────────────────────────────────

function _dispatch(handlers, payload, label) {
  for (const fn of handlers) {
    try {
      const result = fn(payload);
      if (result && typeof result.catch === 'function') {
        result.catch(err => {
          log.error(`[queue] ${label} handler error:`, err?.message ?? err);
          log.error(`[queue] ${label} handler stack:`, err?.stack ?? 'no stack');
        });
      }
    } catch (err) {
      log.error(`[queue] ${label} handler threw:`, err?.message ?? err);
      log.error(`[queue] ${label} handler stack:`, err?.stack ?? 'no stack');
    }
  }
}

// ── Push (producer API) ───────────────────────────────────────────────────

/**
 * Push a chat message from a platform into the queue.
 * Runs the message through the plugin pipeline first — suppressed messages
 * are dropped here and never reach any consumer (Discord, overlay, etc.).
 * @param {{ platform: 'twitch'|'youtube', username: string, message: string }} msg
 */
async function pushMessage(msg) {
  log.debug(`[queue] message | ${msg.platform} | ${msg.username}: ${msg.message}`);

  const { finalMsg, sideEffects } = await _getPipeline()(msg);

  if (finalMsg === null) {
    log.debug(`[queue] message suppressed | ${msg.platform} | ${msg.username}`);
    // Suppressed messages can still have side effects (e.g. first-time-chatter's
    // own Discord embed) — run them, but there's nothing to wait on afterwards.
    for (const fn of sideEffects) {
      Promise.resolve().then(fn).catch(err => log.error('[queue] sideEffect error:', err?.message ?? err));
    }
    return;
  }

  // Dispatch to consumers (Discord, overlay, dashboard) immediately.
  // Side effects (Discord webhook sends, rate-limited to 2/sec, etc.) used to
  // be awaited here BEFORE dispatch, which meant every chat message's arrival
  // on the dashboard/overlay was delayed by however long those side effects
  // took. They no longer block delivery — they run concurrently in the
  // background instead.
  _dispatch(_messageHandlers, finalMsg, 'message');

  for (const fn of sideEffects) {
    Promise.resolve().then(fn).catch(err => log.error('[queue] sideEffect error:', err?.message ?? err));
  }
}

/**
 * Push a channel point redemption into the queue.
 * @param {{ username: string, title: string, cost: number, input: string|null, timestamp: Date }} redeem
 */
function pushRedeem(redeem) {
  log.debug(`[queue] redeem  | ${redeem.username} → "${redeem.title}" (${redeem.cost} pts)`);
  _dispatch(_redeemHandlers, redeem, 'redeem');
}

/**
 * Push a donation/sub/cheer event into the queue.
 *
 * Common shape:
 *   { platform, type, username, amount?, message?, tier?, months?, streak?,
 *     quantity?, recipient?, cumulative?, timestamp }
 *
 * type values: 'bits' | 'sub' | 'resub' | 'subgift'
 */
function pushDonation(donation) {
  log.debug(`[queue] donation| ${donation.platform} | ${donation.type} | ${donation.username}`);
  _dispatch(_donationHandlers, donation, 'donation');
}

// ── Reward title normalisation ─────────────────────────────────────────────
//
// Several plugins (gacha, gacha-at-home, sfx, event-feed, 0yt-points) each
// reimplemented this same regex to strip the "[YT]" suffix that 0yt-points
// appends when mirroring YouTube redeems into the redeem pipeline.
// Centralising it here means a future change to the suffix format only
// needs to happen in one place.
//
// Usage:
//   const canonical = queue.normaliseRedeemTitle(rawTitle);
//   // → 'gacha pull' for 'Gacha Pull [YT]', 'GACHA PULL', '  gacha pull  ', etc.

/**
 * Normalise a redeem title for case-insensitive matching.
 * Strips trailing "[YT]" suffix, trims whitespace, and lowercases.
 * @param {string} raw
 * @returns {string}
 */
function normaliseRedeemTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*\[YT\]\s*$/i, '')
    .trim()
    .toLowerCase();
}

// ── Module exports ────────────────────────────────────────────────────────

module.exports = {
  // Consumer registration
  onMessage,
  onRedeem,
  onDonation,

  // Producer push
  pushMessage,
  pushRedeem,
  pushDonation,

  // Helpers
  normaliseRedeemTitle,
};