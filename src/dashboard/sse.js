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
 *   { type: 'moderate', username, platform, action, duration, ts } — mod event
 *
 * Note: the 'moderate' SSE event is consumed by the dashboard client — it
 * surfaces as a toast and an entry in the Mod history tab (see
 * views/dashboard-page.js). The 'ts' field is the action timestamp.
 */

const log = require('../logger');
const _clients = new Set();

/**
 * Broadcast a payload to every connected SSE client.
 * Best-effort: clients that fail to write are removed from the set.
 */
function broadcast(payload) {
  if (_clients.size === 0) return;
  // Serialize INSIDE the guard (review W2): a circular widget payload threw
  // before the per-client try/catch, taking the whole updateWidget call
  // chain down with it. Skip the event on serialization failure.
  let msg;
  try { msg = `data: ${JSON.stringify(payload)}\n\n`; }
  catch (e) { log.warn('[dashboard:sse] broadcast skipped unserializable payload:', e.message); return; }
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
