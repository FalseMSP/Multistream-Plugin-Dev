'use strict';

/**
 * Logger tap.
 * ────────────────────────────────────────────────────────────────────────────
 * Mirrors log.info / log.warn / log.error output into the dashboard's SSE
 * stream so the operator can see live logs in the dashboard's log console.
 *
 * This module is SIDE-EFFECTFUL: requiring it monkey-patches the shared
 * logger object. Other modules that later `require('./logger')` get the
 * patched version. This is intentional — we want every log line across
 * the entire process to be mirrored.
 *
 * Capped ring buffer keeps the last 200 entries so a freshly-loaded
 * dashboard sees some recent history even before new logs arrive.
 */

const log       = require('../logger');
const { broadcast } = require('./sse');

const LOG_BUFFER_SIZE = 200;
const _logBuffer = [];

function _broadcastLog(level, message) {
  const entry = { level, message, ts: Date.now() };
  _logBuffer.push(entry);
  if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
  broadcast({ type: 'log', entry });
}

// Snapshot the originals before patching so we can call them after also
// broadcasting. Optional chaining guards against a logger that doesn't
// expose one of these methods (unlikely, but defensive).
const _origLog = {
  info:  log.info  ? log.info.bind(log)  : null,
  warn:  log.warn  ? log.warn.bind(log)  : null,
  error: log.error ? log.error.bind(log) : null,
};

if (log.info) {
  log.info  = (...a) => { if (_origLog.info)  _origLog.info(...a);  _broadcastLog('info',  a.join(' ')); };
  log.warn  = (...a) => { if (_origLog.warn)  _origLog.warn(...a);  _broadcastLog('warn',  a.join(' ')); };
  log.error = (...a) => { if (_origLog.error) _origLog.error(...a); _broadcastLog('error', a.join(' ')); };
}

/** Returns a shallow copy of the buffered log entries (newest last). */
function getLogBuffer() {
  return [..._logBuffer];
}

module.exports = {
  _broadcastLog,
  getLogBuffer,
  LOG_BUFFER_SIZE,
};
