'use strict';

/**
 * Moderation registry + dispatcher.
 * ────────────────────────────────────────────────────────────────────────────
 * Plugins (twitch.js, youtube.js) register { ban, timeout } handlers via
 * onModerate(). The dashboard's POST /dashboard/moderate route invokes
 * _dispatchModerate() to fan out a moderation action to every registered
 * handler.
 *
 * The handler signature matches the existing twitch.js / youtube.js
 * modHandlers.{ban,timeout} shape: (platform, username, [duration], reason).
 */

const log           = require('../logger');
const { broadcast } = require('./sse');
const { _broadcastLog } = require('./logger-tap');

/** Handlers registered by plugins to perform actual mod actions */
const _modHandlers = [];

/**
 * Register a handler for moderation actions dispatched from the dashboard.
 * @param {{ ban: Function, timeout: Function }} handlers
 */
function onModerate(handlers) {
  _modHandlers.push(handlers);
}

/**
 * Dispatch a moderation action to every registered handler.
 * @param {string} username
 * @param {string} platform    'twitch' | 'youtube'
 * @param {string} action      'ban' | 'timeout'
 * @param {number} [duration]  seconds (only for timeout)
 */
async function _dispatchModerate(username, platform, action, duration) {
  for (const h of _modHandlers) {
    try {
      if (action === 'ban' && h.ban) {
        await h.ban(platform, username, 'Banned from dashboard');
      } else if (action === 'timeout' && h.timeout) {
        await h.timeout(platform, username, duration, 'Timed out from dashboard');
      }
    } catch (err) {
      log.error(`[dashboard] Moderate action "${action}" on ${username} failed:`, err.message);
      _broadcastLog('error', `Mod action "${action}" on ${username} (${platform}) failed: ${err.message}`);
    }
  }
}

/**
 * HTTP route handler for POST /dashboard/moderate.
 * Expects JSON body: { username, platform, action, duration? }
 * Broadcasts a 'moderate' SSE event (so the dashboard UI can reflect the
 * action immediately) then dispatches to registered handlers.
 */
async function handleModerate(req, res) {
  const { _readJsonBody } = require('./http-helpers');
  const body = await _readJsonBody(req);
  const { username, platform, action, duration } = body;
  if (username && platform && action) {
    log.info(`[dashboard] Moderation: ${action} ${username} on ${platform}${duration ? ' for ' + duration + 's' : ''}`);
    broadcast({ type: 'moderate', username, platform, action, duration: duration ?? 0 });
    _dispatchModerate(username, platform, action, duration ?? 0).catch(err => {
      log.error('[dashboard] _dispatchModerate threw:', err.message);
    });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

module.exports = {
  onModerate,
  _dispatchModerate,
  handleModerate,
};
