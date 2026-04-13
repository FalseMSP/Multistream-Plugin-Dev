'use strict';

/**
 * In-memory async queue.
 * Producers call queue.pushMessage() / queue.pushRedeem().
 * Discord module registers callbacks via queue.onMessage() / queue.onRedeem().
 *
 * All chat messages pass through the plugin pipeline (src/plugins/index.js)
 * before being dispatched to Discord. This allows plugins to:
 *   • modify the message (e.g. strip prefixes, translate)
 *   • suppress the message from the main feed (return { message: null })
 *   • send the message to an alternate channel (return { sideEffect: fn })
 *   • do all of the above
 *
 * Redeems and donations bypass the pipeline intentionally — they are
 * structured events, not freeform chat, and plugins should not need to
 * intercept them.
 */

const log = require('./src/logger');

const MAX = 500;

let _onMessage  = null;
let _onRedeem   = null;
let _onDonation = null;

const msgBuffer      = [];
const redeemBuffer   = [];
const donationBuffer = [];

// Lazy-load the plugin pipeline so queue.js can be required before plugins
// are initialised (avoids circular-require issues at startup).
let _pipeline = null;
function getPipeline() {
  if (!_pipeline) _pipeline = require('./plugins/index');
  return _pipeline;
}

function _drain(buffer, handler) {
  while (buffer.length) handler(buffer.shift()).catch((e) => log.error('Queue drain error:', e));
}

// ── Pipeline wrapper ──────────────────────────────────────────────────────

/**
 * Run msg through the plugin pipeline, then dispatch to the main feed
 * handler and any side-effect channels.
 */
async function _dispatch(msg) {
  let finalMsg, sideEffects;

  try {
    ({ finalMsg, sideEffects } = await getPipeline().runPipeline(msg));
  } catch (err) {
    log.error('[Queue] Plugin pipeline error:', err.message);
    // Fail open — send the original message so nothing is silently lost
    finalMsg    = msg;
    sideEffects = [];
  }

  // Run side effects (alternate-channel sends) regardless of main feed routing
  for (const fn of sideEffects) {
    fn().catch((e) => log.error('[Queue] Side-effect error:', e));
  }

  // Send to main feed
  if (finalMsg && _onMessage) {
    _onMessage(finalMsg).catch((e) => log.error('[Queue] onMessage error:', e));
  }
}

// ── Public API ────────────────────────────────────────────────────────────

module.exports = {
  onMessage(fn) {
    _onMessage = fn;
    _drain(msgBuffer, (msg) => _dispatch(msg));
  },

  onRedeem(fn) {
    _onRedeem = fn;
    _drain(redeemBuffer, fn);
  },

  onDonation(fn) {
    _onDonation = fn;
    _drain(donationBuffer, fn);
  },

  /**
   * @param {{ platform: 'twitch'|'youtube', username: string, message: string }} msg
   */
  pushMessage(msg) {
    if (_onMessage) {
      _dispatch(msg);
    } else {
      if (msgBuffer.length >= MAX) { log.warn('Message queue full — dropping'); return; }
      msgBuffer.push(msg);
    }
  },

  /**
   * @param {{ username: string, title: string, cost: number, input?: string, timestamp: Date }} redeem
   */
  pushRedeem(redeem) {
    if (_onRedeem) {
      _onRedeem(redeem).catch((e) => log.error('onRedeem error:', e));
    } else {
      if (redeemBuffer.length >= MAX) { log.warn('Redeem queue full — dropping'); return; }
      redeemBuffer.push(redeem);
    }
  },

  /**
   * @param {{ platform: string, type: string, username: string, amount?: number, message?: string }} donation
   */
  pushDonation(donation) {
    if (_onDonation) {
      _onDonation(donation).catch((e) => log.error('onDonation error:', e));
    } else {
      if (donationBuffer.length >= MAX) { log.warn('Donation queue full — dropping'); return; }
      donationBuffer.push(donation);
    }
  },
};