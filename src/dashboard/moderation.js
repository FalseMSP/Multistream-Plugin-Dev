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
  // Await every handler and COLLECT the per-handler outcome instead of
  // logging errors into the void (review W2: "the moderation endpoint
  // reports success before dispatching the ban"). Each handler's result
  // is returned so the HTTP response can carry real outcomes the UI shows.
  const results = [];
  for (const h of _modHandlers) {
    try {
      if (action === 'ban' && h.ban) {
        await h.ban(platform, username, 'Banned from dashboard');
        results.push({ handler: h.name || 'handler', ok: true });
      } else if (action === 'timeout' && h.timeout) {
        await h.timeout(platform, username, duration, 'Timed out from dashboard');
        results.push({ handler: h.name || 'handler', ok: true });
      }
    } catch (err) {
      log.error(`[dashboard] Moderate action "${action}" on ${username} failed:`, err.message);
      _broadcastLog('error', `Mod action "${action}" on ${username} (${platform}) failed: ${err.message}`);
      results.push({ handler: h.name || 'handler', ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * HTTP route handler for POST /dashboard/moderate.
 * Expects JSON body: { username, platform, action, duration? }
 *
 * Awaits the dispatch, then broadcasts ONLY the real outcome and returns it
 * in the JSON body (legacy always returned { ok: true } and broadcast before
 * dispatch, so a failed Twitch ban was indistinguishable from a successful
 * one — review W2). Response shape:
 *   { ok: boolean, results: [{ handler, ok, error? }] }
 */
async function handleModerate(req, res) {
  const { _readJsonBody } = require('./http-helpers');
  const body = await _readJsonBody(req);
  const { username, platform, action, duration } = body;
  if (!username || !platform || !action) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'username, platform and action are required' }));
    return;
  }
  log.info(`[dashboard] Moderation: ${action} ${username} on ${platform}${duration ? ' for ' + duration + 's' : ''}`);
  let results = [];
  try {
    results = await _dispatchModerate(username, platform, action, duration ?? 0);
  } catch (err) {
    log.error('[dashboard] _dispatchModerate threw:', err.message);
    results = [{ handler: 'dispatch', ok: false, error: err.message }];
  }
  const ok = results.length > 0 && results.every(r => r.ok);
  broadcast({ type: 'moderate', username, platform, action, duration: duration ?? 0, ts: Date.now(), ok, results });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok, results }));
}

module.exports = {
  onModerate,
  _dispatchModerate,
  handleModerate,
};
