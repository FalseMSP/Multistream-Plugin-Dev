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
    const raw    = await _readBody(req);
    const fields = _parseFormBody(raw);
    // The redirect field comes from the hidden input in the login form.
    // It preserves where the user originally wanted to go (e.g. /clipcurator).
    const redirect = fields.redirect || '';
    if (fields.password && auth._checkPassword(fields.password)) {
      const token = auth._createSession();
      const location = redirect || '/dashboard';
      res.writeHead(302, {
        'Set-Cookie': auth._sessionCookieHeader(token),
        'Location':   location,
      });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildLoginPage('Incorrect password.', redirect));
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
    });
    // Flush current state to the new client
    for (const [id, widget] of widgetRegistry._widgetsMap()) {
      res.write(`data: ${JSON.stringify({ type: 'widget', id, data: widget.data })}\n\n`);
    }
    // Flush buffered log entries
    for (const entry of loggerTap.getLogBuffer()) {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    }
    sse.addClient(res);
    req.on('close', () => sse.removeClient(res));
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
