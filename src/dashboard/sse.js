'use strict';

/**
 * SSE client registry + broadcast helper.
 * ────────────────────────────────────────────────────────────────────────────
 * One Set of open ServerResponse objects, shared by the widget registry,
 * logger tap, and moderation broadcaster. Any module that needs to push
 * real-time updates to dashboard clients calls broadcast(payload).
 *
 * Payload shape (wire format):
 *   data: <json>\n\n
 *
 * Payload types:
 *   { type: 'widget',   id, data }   — widget state update
 *   { type: 'log',      entry }      — log line (level, message, ts)
 *   { type: 'moderate', username, platform, action, duration } — mod event
 *
 * Note: the 'moderate' SSE event is currently broadcast but ignored by the
 * browser-side handler. It's preserved here for backward compat — a future
 * dashboard revision could surface moderation events as a toast.
 */

const _clients = new Set();

/**
 * Broadcast a payload to every connected SSE client.
 * Best-effort: clients that fail to write are removed from the set.
 */
function broadcast(payload) {
  if (_clients.size === 0) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of _clients) {
    try { res.write(msg); }
    catch { _clients.delete(res); }
  }
}

function addClient(res) {
  _clients.add(res);
}

function removeClient(res) {
  _clients.delete(res);
}

function getClientCount() {
  return _clients.size;
}

module.exports = {
  broadcast,
  addClient,
  removeClient,
  getClientCount,
};
