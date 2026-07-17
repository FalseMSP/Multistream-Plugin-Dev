'use strict';

/**
 * HTTP helpers for dashboard route handlers.
 * ────────────────────────────────────────────────────────────────────────────
 *   _readBody(req)              → Promise<string>   (raw body, max 4 KB)
 *   _readJsonBody(req)          → Promise<object>   (parsed JSON, {} on error)
 *   _parseFormBody(raw)         → object            (URL-encoded form fields)
 *   _resolveContent(payload)    → string            (Discord reply → display string)
 *
 * The 4 KB cap on _readBody matches the previous inline implementation.
 * It's intentionally small — dashboard POSTs are tiny JSON or form payloads.
 */

const MAX_BODY_BYTES = 4096;

function _readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        body = '';
        req.destroy();
      }
    });
    req.on('end',  () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

/**
 * Read + JSON-parse the request body. Returns {} on parse failure or empty body.
 * Deduplicates the previous "raw = await _readBody; try { body = JSON.parse(raw) }"
 * pattern that appeared 3× in the original dashboard.js.
 */
async function _readJsonBody(req) {
  const raw = await _readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}

function _parseFormBody(raw) {
  return Object.fromEntries(
    raw.split('&').map(p => p.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' '))))
  );
}

/**
 * Normalise a Discord reply payload to a plain string for dashboard display.
 * Plugins pass either a plain string or a { content, embeds, … } object.
 */
function _resolveContent(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.embeds) && payload.embeds.length) {
    const e = payload.embeds[0];
    return [e.title, e.description].filter(Boolean).join(' — ');
  }
  return JSON.stringify(payload);
}

module.exports = {
  MAX_BODY_BYTES,
  _readBody,
  _readJsonBody,
  _parseFormBody,
  _resolveContent,
};
