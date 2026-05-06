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
      // Swallow promise rejections so one bad handler can't break others
      if (result && typeof result.catch === 'function') {
        result.catch(err => log.error(`[queue] ${label} handler error:`, err?.message ?? err));
      }
    } catch (err) {
      log.error(`[queue] ${label} handler threw:`, err?.message ?? err);
    }
  }
}

// ── Push (producer API) ───────────────────────────────────────────────────

/**
 * Push a chat message from a platform into the queue.
 * @param {{ platform: 'twitch'|'youtube', username: string, message: string }} msg
 */
function pushMessage(msg) {
  log.debug(`[queue] message | ${msg.platform} | ${msg.username}: ${msg.message}`);
  _dispatch(_messageHandlers, msg, 'message');
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
};