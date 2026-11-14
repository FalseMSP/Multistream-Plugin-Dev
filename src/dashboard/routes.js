'use strict';

/**
 * Dashboard route dispatcher.
 * ────────────────────────────────────────────────────────────────────────────
 * Single entry point for every /dashboard* HTTP request. Iterates a small
 * route table and delegates to the appropriate handler module.
 *
 * Auth gate is applied to every route except /dashboard/login (which is
 * where the user POSTs their password — obviously can't require auth to
 * log in).
 *
 * Returns true if the request was handled, false if it should fall through
 * (e.g. the URL doesn't start with /dashboard).
 */

const log = require('../logger');
const auth   = require('./auth');
const { _readBody, _parseFormBody } = require('./http-helpers');
const { buildLoginPage } = require('./views/login');
const { buildDashboardPage } = require('./views/dashboard-page');
const { handleModerate } = require('./moderation');
const { handleAction }   = require('./actions');
const { handleCommand }  = require('./command-dispatch');
const widgetRegistry = require('./widget-registry');
const sse     = require('./sse');
const loggerTap = require('./logger-tap');

// Importing logger-tap is side-effectful (it monkey-patches the logger).
// Requiring it here ensures that side effect runs as soon as the dashboard
// is mounted — no other module needs to import it explicitly.
void loggerTap;

// ── Login rate limiting (review W1) ────────────────────────────────────────
// Unlimited attempts against the single shared password; exponential backoff
// per source IP after 3 failures, hard 15-minute lockout after 8.
const LOGIN_RATE_LIMIT_BASE_MS = 2000; // 2s → 4s → 8s… capped at 15 min
const _loginAttempts = new Map(); // ip → { failures, until }
function _recordLoginFailure(ip) {
  const rec = _loginAttempts.get(ip) || { failures: 0, until: 0 };
  rec.failures += 1;
  if (rec.failures >= 3) {
    const delay = LOGIN_RATE_LIMIT_BASE_MS * Math.pow(2, rec.failures - 3);
    rec.until = Date.now() + Math.min(delay, 15 * 60 * 1000);
    if (rec.failures >= 8) rec.until = Date.now() + 15 * 60 * 1000; // hard lockout
  }
  _loginAttempts.set(ip, rec);
}
function _resetLoginFailures(ip) { _loginAttempts.delete(ip); }

/**
 * Handle an incoming request destined for the dashboard.
 * Returns true if the request was handled, false if it should fall through.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 */
async function handleRequest(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;

  // ── POST /dashboard/login ────────────────────────────────────────────────
  if (method === 'POST' && url === '/dashboard/login') {
    // Rate limit gate (review W1): block attempts from IPs still inside
    // their backoff window before even reading the body.
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const rec = _loginAttempts.get(ip) || { failures: 0, until: 0 };
    if (now < rec.until) {
      res.writeHead(429, {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': Math.ceil((rec.until - now) / 1000),
      });
      res.end(buildLoginPage(`Too many attempts — try again in ${Math.ceil((rec.until - now) / 1000)}s.`, ''));
      return true;
    }

    const raw    = await _readBody(req);
    const fields = _parseFormBody(raw);
    // The redirect field comes from the hidden input in the login form.
    // It preserves where the user originally wanted to go (e.g. /clipcurator).
    const redirect = fields.redirect || '';
    if (fields.password && auth._checkPassword(fields.password)) {
      _resetLoginFailures(ip);
      const token = auth._createSession();
      const location = redirect || '/dashboard';
      res.writeHead(302, {
        'Set-Cookie': auth._sessionCookieHeader(token),
        'Location':   location,
      });
      res.end();
    } else {
      _recordLoginFailure(ip);
      const after = _loginAttempts.get(ip) || { failures: 0, until: 0 };
      const hint = after.failures >= 3
        ? `Incorrect password. ${after.failures} failed attempts — further attempts blocked for ${Math.max(1, Math.ceil((after.until - Date.now()) / 1000))}s.`
        : 'Incorrect password.';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildLoginPage(hint, redirect));
    }
    return true;
  }

  // ── GET /dashboard/logout ────────────────────────────────────────────────
  if (method === 'GET' && url === '/dashboard/logout') {
    const token = auth._getSessionToken(req);
    if (token) auth._destroySession(token);
    res.writeHead(302, {
      'Set-Cookie': auth._clearSessionCookieHeader(),
      'Location':   '/dashboard',
    });
    res.end();
    return true;
  }

  // ── All other /dashboard* routes need auth ────────────────────────────────
  if (!url.startsWith('/dashboard')) return false;

  if (!auth._isAuthenticated(req)) {
    // Extract the redirect query param so the login form can preserve it.
    const qs = req.url.split('?')[1] || '';
    const redirectParam = new URLSearchParams(qs).get('redirect') || '';
    // Session expiry used to return the login page HTML with HTTP 200 for
    // EVERY request, so the SPA's resp.json() threw on the unexpected token
    // and EventSource retried forever under a "Lost connection" bar
    // (review W2). Distinguish real page navigations (browser GET with an
    // HTML-preferring Accept header) from programmatic requests: the
    // latter get a clean 401 JSON the client can redirect on.
    const accept = (req.headers.accept || '');
    const wantsHtml = accept.includes('text/html');
    const isNavigationLike = method === 'GET' && wantsHtml;
    if (!isNavigationLike) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'session expired', loginUrl: '/dashboard/login?redirect=' + encodeURIComponent(redirectParam) }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildLoginPage('', redirectParam));
    return true;
  }

  // ── GET /dashboard ───────────────────────────────────────────────────────
  if (method === 'GET' && url === '/dashboard') {
    const html = buildDashboardPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  // ── GET /dashboard/sse ───────────────────────────────────────────────────
  if (method === 'GET' && url === '/dashboard/sse') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers now and heartbeat (review W2: the overlay SSE endpoint
    // already does both; without them idle dashboard connections drop
    // silently behind NAT/proxies and the 3 s client retry re-flushes the
    // full widget snapshot each time).
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    try { req.socket.setKeepAlive(true, 15000); req.socket.setNoDelay(true); } catch {}
    res.write(': connected\n\n');
    const _hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(_hb); }
    }, Number(process.env.DASHBOARD_SSE_HEARTBEAT_MS) || 15000);
    // Flush current state to the new client
    for (const [id, widget] of widgetRegistry._widgetsMap()) {
      res.write(`data: ${JSON.stringify({ type: 'widget', id, data: widget.data })}\n\n`);
    }
    // Flush buffered log entries
    for (const entry of loggerTap.getLogBuffer()) {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    }
    sse.addClient(res);
    req.on('close', () => { clearInterval(_hb); sse.removeClient(res); });
    return true;
  }

  // ── GET /dashboard/state ─────────────────────────────────────────────────
  if (method === 'GET' && url === '/dashboard/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(widgetRegistry.getWidgetStateSnapshot()));
    return true;
  }

  // ── POST /dashboard/command ───────────────────────────────────────────────
  if (method === 'POST' && url === '/dashboard/command') {
    await handleCommand(req, res);
    return true;
  }

  // ── POST /dashboard/moderate ──────────────────────────────────────────────
  if (method === 'POST' && url === '/dashboard/moderate') {
    await handleModerate(req, res);
    return true;
  }

  // ── POST /dashboard/action ────────────────────────────────────────────────
  if (method === 'POST' && url === '/dashboard/action') {
    await handleAction(req, res);
    return true;
  }

  return false;
}

module.exports = { handleRequest };
