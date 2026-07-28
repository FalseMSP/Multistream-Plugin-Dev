'use strict';

/**
 * Auth helpers for the dashboard.
 * ────────────────────────────────────────────────────────────────────────────
 * Session-token store + cookie helpers + password check.
 *
 * Sessions are stored in-process (Map<token, expiryTimestamp>) — restarts
 * log everyone out, which is the desired behaviour for a stream dashboard.
 *
 * Cookie attributes:
 *   HttpOnly       — not readable from JS (mitigates XSS token theft)
 *   SameSite=Strict — not sent on cross-site requests (mitigates CSRF)
 *   Max-Age         — 8h session lifetime
 *   Path=/          — sent on every route under the host
 */

const crypto = require('crypto');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const COOKIE_NAME        = 'dash_session';
const COOKIE_MAX_AGE     = 60 * 60 * 8; // 8 hours in seconds

/** Active session tokens → expiry timestamp */
const _sessions = new Map();

function isPasswordConfigured() {
  return !!DASHBOARD_PASSWORD;
}

function getPassword() {
  return DASHBOARD_PASSWORD;
}

function getCookieName() {
  return COOKIE_NAME;
}

function getCookieMaxAge() {
  return COOKIE_MAX_AGE;
}

function _createSession() {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + COOKIE_MAX_AGE * 1000;
  _sessions.set(token, expires);
  return token;
}

function _isValidSession(token) {
  if (!token) return false;
  const expires = _sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) { _sessions.delete(token); return false; }
  return true;
}

function _destroySession(token) {
  _sessions.delete(token);
}

function _parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader.split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
}

function _getSessionToken(req) {
  return _parseCookies(req.headers.cookie || '')[COOKIE_NAME] || null;
}

function _isAuthenticated(req) {
  return _isValidSession(_getSessionToken(req));
}

/** Build the Set-Cookie header value for a freshly-created session token. */
function _sessionCookieHeader(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`;
}

/** Build the Set-Cookie header value that clears the session cookie. */
function _clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/`;
}

/**
 * Constant-time password comparison.
 * Falls back to plain === if lengths differ (which is fine — we just always
 * return false in that case, no timing leak of length info beyond what's
 * already obvious from the network round-trip).
 */
function _checkPassword(submitted) {
  if (!DASHBOARD_PASSWORD || !submitted) return false;
  const a = Buffer.from(String(submitted));
  const b = Buffer.from(DASHBOARD_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  isPasswordConfigured,
  getPassword,
  getCookieName,
  getCookieMaxAge,
  _createSession,
  _isValidSession,
  _destroySession,
  _parseCookies,
  _getSessionToken,
  _isAuthenticated,
  _sessionCookieHeader,
  _clearSessionCookieHeader,
  _checkPassword,
};
