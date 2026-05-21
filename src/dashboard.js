'use strict';

/**
 * dashboard.js
 * ────────────
 * Password-protected dashboard served at GET /dashboard.
 * Plugins can register widgets that appear as live-updating cards.
 *
 * ── Setup ─────────────────────────────────────────────────────────────────
 *
 *   # .env
 *   DASHBOARD_PASSWORD=your-secret-here
 *
 * ── Widget API ────────────────────────────────────────────────────────────
 *
 *   const dashboard = require('./dashboard');
 *
 *   dashboard.registerWidget('my-plugin', {
 *     title:   'My Widget',            // card header text
 *     icon:    '<svg>…</svg>',         // raw SVG string shown left of title (20×20)
 *     order:   10,                     // sort order (default: 50)
 *     render:  renderFn.toString(),    // client-side render fn serialised to string
 *                                      // signature: function render(data, el, esc) {}
 *                                      //   data = whatever you passed to updateWidget()
 *                                      //   el   = the widget's <div class="widget-body">
 *                                      //   esc  = HTML-escape helper
 *   });
 *
 *   dashboard.updateWidget('my-plugin', { ...anyData });  // triggers SSE push
 *
 * ── HTTP endpoints ────────────────────────────────────────────────────────
 *
 *   GET  /dashboard          — dashboard UI (requires auth cookie)
 *   POST /dashboard/login    — submit password → sets session cookie
 *   GET  /dashboard/logout   — clears session cookie
 *   GET  /dashboard/sse      — SSE stream for live widget updates (requires auth)
 *   GET  /dashboard/state    — full JSON snapshot of all widget data (requires auth)
 *
 * ── Integration with overlay-server ──────────────────────────────────────
 *
 *   Call mountOnOverlayServer(overlayModule) after both are required to
 *   automatically register all dashboard routes on the overlay HTTP server:
 *
 *   const overlay   = require('./overlay-server');
 *   const dashboard = require('./dashboard');
 *   dashboard.mountOnOverlayServer(overlay);
 *   overlay.startOverlayServer(2999);
 */

require('dotenv').config();

const crypto = require('crypto');
const log    = require('./logger');

// ── Auth config ───────────────────────────────────────────────────────────

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
if (!DASHBOARD_PASSWORD) {
  log.warn('[dashboard] DASHBOARD_PASSWORD is not set in .env — the dashboard will be inaccessible.');
}

const COOKIE_NAME    = 'dash_session';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours in seconds

/** Active session tokens → expiry timestamp */
const _sessions = new Map();

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

// ── Widget registry ───────────────────────────────────────────────────────

/** @type {Map<string, { title: string, icon: string, order: number, render: string, data: * }>} */
const _widgets = new Map();

/**
 * Register a dashboard widget.
 * @param {string} id     Unique widget id
 * @param {{ title: string, icon?: string, order?: number, render: string }} opts
 */
function registerWidget(id, { title, icon = '', order = 50, render }) {
  if (typeof render !== 'string') {
    throw new TypeError(
      `[dashboard] registerWidget('${id}'): opts.render must be a function serialised ` +
      `to a string via myFn.toString() — the browser will eval it.`
    );
  }
  _widgets.set(id, { title, icon, order, render, data: null });
  log.info(`[dashboard] Widget registered: ${id}`);
}

/**
 * Push new data to a widget and broadcast to connected dashboard clients.
 * @param {string} id
 * @param {*}      data
 */
function updateWidget(id, data) {
  const widget = _widgets.get(id);
  if (!widget) {
    log.warn(`[dashboard] updateWidget('${id}'): widget not registered — did you call registerWidget() first?`);
    return;
  }
  widget.data = data;
  _broadcast({ type: 'widget', id, data });
}

// ── SSE broadcast ─────────────────────────────────────────────────────────

const _clients = new Set();

function _broadcast(payload) {
  if (_clients.size === 0) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of _clients) {
    try { res.write(msg); } catch { _clients.delete(res); }
  }
}

// ── Read POST body ─────────────────────────────────────────────────────────

function _readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) { body = ''; req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function _parseFormBody(raw) {
  return Object.fromEntries(
    raw.split('&').map(p => p.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' '))))
  );
}

// ── HTML builders ──────────────────────────────────────────────────────────

function _buildLoginPage(errorMsg = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard · Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:      #0d0d0f;
    --surface: #16171a;
    --border:  #2a2b30;
    --accent:  #e53935;
    --text:    #e8e8ec;
    --muted:   #5a5a6a;
  }
  html, body { height: 100%; background: var(--bg); font-family: system-ui, sans-serif; color: var(--text); display: flex; align-items: center; justify-content: center; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 36px 32px; width: 100%; max-width: 360px; }
  h1 { font-size: 18px; font-weight: 700; margin-bottom: 24px; display: flex; align-items: center; gap: 10px; }
  h1 svg { color: var(--accent); }
  label { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 6px; }
  input[type=password] {
    width: 100%; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 5px; color: var(--text); font-size: 14px; outline: none; transition: border-color 0.15s;
  }
  input[type=password]:focus { border-color: var(--accent); }
  button {
    width: 100%; margin-top: 18px; padding: 10px; background: var(--accent); color: #fff;
    border: none; border-radius: 5px; font-size: 14px; font-weight: 700; cursor: pointer;
    letter-spacing: 0.04em; transition: opacity 0.15s;
  }
  button:hover { opacity: 0.88; }
  .error { margin-top: 14px; font-size: 12px; color: var(--accent); text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
    Stream Dashboard
  </h1>
  <form method="POST" action="/dashboard/login">
    <label for="pwd">Password</label>
    <input id="pwd" type="password" name="password" autofocus autocomplete="current-password" placeholder="Enter dashboard password">
    <button type="submit">Sign in</button>
  </form>
  ${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}
</div>
</body>
</html>`;
}

function _buildDashboardPage() {
  const sorted = [..._widgets.values()]
    .sort((a, b) => a.order - b.order);

  const widgetMeta    = sorted.map(({ title, icon, render }, i) => {
    const id = [..._widgets.keys()].find(k => _widgets.get(k) === sorted[i]);
    return { id, title, icon, render };
  });
  const initialData   = Object.fromEntries(
    [..._widgets.entries()].map(([id, w]) => [id, w.data])
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stream Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:        #0d0d0f;
    --surface:   #16171a;
    --surface2:  #1c1d21;
    --border:    #2a2b30;
    --accent:    #e53935;
    --accent-lo: rgba(229, 57, 53, 0.12);
    --text:      #e8e8ec;
    --muted:     #5a5a6a;
    --mono:      'JetBrains Mono', monospace;
  }
  html, body { height: 100%; background: var(--bg); font-family: 'Inter', system-ui, sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
  /* ── Layout ── */
  .shell { display: flex; flex-direction: column; min-height: 100vh; }
  /* ── Topbar ── */
  .topbar {
    display: flex; align-items: center; gap: 12px; padding: 0 20px; height: 52px;
    background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .topbar-logo { display: flex; align-items: center; gap: 8px; font-weight: 900; font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text); }
  .topbar-logo svg { color: var(--accent); }
  .topbar-badge { background: var(--accent-lo); border: 1px solid rgba(229, 57, 53, 0.35); color: var(--accent); font-family: var(--mono); font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 3px; letter-spacing: 0.06em; text-transform: uppercase; }
  .topbar-spacer { flex: 1; }
  .topbar-status { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,0.25); animation: pulse 2s ease infinite; }
  .status-dot.offline { background: var(--muted); box-shadow: none; animation: none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  .topbar-logout { font-size: 12px; color: var(--muted); text-decoration: none; padding: 5px 10px; border: 1px solid var(--border); border-radius: 4px; transition: color 0.15s, border-color 0.15s; }
  .topbar-logout:hover { color: var(--text); border-color: var(--muted); }
  /* ── Grid ── */
  .grid { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; padding: 20px; align-content: start; }
  /* ── Widget card ── */
  .widget-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .widget-header { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--border); background: var(--accent-lo); }
  .widget-icon { width: 20px; height: 20px; flex-shrink: 0; color: var(--accent); }
  .widget-title { font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  .widget-badge { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .widget-body { padding: 12px 14px; font-size: 13px; line-height: 1.5; }
  /* ── Empty state ── */
  .empty { grid-column: 1/-1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: var(--muted); gap: 12px; text-align: center; }
  .empty svg { opacity: 0.3; }
  .empty p { font-size: 14px; }
  /* ── Reconnect bar ── */
  .reconnect-bar { display: none; padding: 8px 20px; background: rgba(229,57,53,0.1); border-top: 1px solid rgba(229,57,53,0.25); font-family: var(--mono); font-size: 11px; color: var(--accent); animation: blink 1s step-start infinite; }
  @keyframes blink { 50%{opacity:0} }
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="topbar-logo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
      Dashboard
    </div>
    <span class="topbar-badge">LIVE</span>
    <div class="topbar-spacer"></div>
    <div class="topbar-status">
      <span class="status-dot" id="status-dot"></span>
      <span id="status-text">connected</span>
    </div>
    <a class="topbar-logout" href="/dashboard/logout">Sign out</a>
  </header>

  <main class="grid" id="widget-grid">
    ${_widgets.size === 0 ? `
    <div class="empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <p>No widgets registered yet.<br>Call <code>dashboard.registerWidget()</code> to add one.</p>
    </div>` : ''}
  </main>

  <div class="reconnect-bar" id="reconnect-bar">⚠ Lost connection — reconnecting…</div>
</div>

<script>
(function () {
  const WIDGETS     = ${JSON.stringify(widgetMeta)};
  const initialData = ${JSON.stringify(initialData)};

  // Compile render functions
  const renderers = {};
  for (const w of WIDGETS) {
    try {
      renderers[w.id] = new Function('return (' + w.render + ')')();
    } catch (e) {
      console.error('[dashboard] compile error in', w.id, e);
      renderers[w.id] = () => {};
    }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Build widget cards
  const grid   = document.getElementById('widget-grid');
  const bodies = {};
  const badges = {};

  // Clear empty-state placeholder if widgets exist
  if (WIDGETS.length > 0) grid.innerHTML = '';

  for (const w of WIDGETS) {
    const card  = document.createElement('div');
    card.className = 'widget-card';
    card.id        = 'wcard-' + w.id;
    card.innerHTML =
      '<div class="widget-header">' +
        '<span class="widget-icon">'  + w.icon          + '</span>' +
        '<span class="widget-title">' + esc(w.title)    + '</span>' +
        '<span class="widget-badge" id="wbadge-' + w.id + '"></span>' +
      '</div>' +
      '<div class="widget-body" id="wbody-' + w.id + '"></div>';
    grid.appendChild(card);
    bodies[w.id] = card.querySelector('.widget-body');
    badges[w.id] = card.querySelector('.widget-badge');
  }

  function invoke(id, data) {
    if (!renderers[id] || !bodies[id]) return;
    try {
      renderers[id](data, bodies[id], esc, { badge: badges[id] });
    } catch (e) { console.error('[dashboard] render error in', id, e); }
  }

  for (const w of WIDGETS) invoke(w.id, initialData[w.id]);

  // SSE
  const statusDot  = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const reconnBar  = document.getElementById('reconnect-bar');

  function setOnline(online) {
    statusDot.className  = 'status-dot' + (online ? '' : ' offline');
    statusText.textContent = online ? 'connected' : 'disconnected';
    reconnBar.style.display = online ? 'none' : 'block';
  }

  let es;
  function connect() {
    es = new EventSource('/dashboard/sse');
    es.onopen    = () => setOnline(true);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'widget') invoke(msg.id, msg.data);
      } catch {}
    };
    es.onerror = () => {
      setOnline(false);
      es.close();
      setTimeout(connect, 3000);
    };
  }
  connect();
})();
</script>
</body>
</html>`;
}

// ── Route handler ──────────────────────────────────────────────────────────

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
    if (fields.password && fields.password === DASHBOARD_PASSWORD) {
      const token = _createSession();
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`,
        'Location':   '/dashboard',
      });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(_buildLoginPage('Incorrect password.'));
    }
    return true;
  }

  // ── GET /dashboard/logout ────────────────────────────────────────────────
  if (method === 'GET' && url === '/dashboard/logout') {
    const token = _getSessionToken(req);
    if (token) _sessions.delete(token);
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/`,
      'Location':   '/dashboard',
    });
    res.end();
    return true;
  }

  // ── All other /dashboard* routes need auth ────────────────────────────────
  if (!url.startsWith('/dashboard')) return false;

  if (!_isAuthenticated(req)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(_buildLoginPage());
    return true;
  }

  // ── GET /dashboard ───────────────────────────────────────────────────────
  if (method === 'GET' && url === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(_buildDashboardPage());
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
    for (const [id, widget] of _widgets) {
      res.write(`data: ${JSON.stringify({ type: 'widget', id, data: widget.data })}\n\n`);
    }
    _clients.add(res);
    req.on('close', () => _clients.delete(res));
    return true;
  }

  // ── GET /dashboard/state ─────────────────────────────────────────────────
  if (method === 'GET' && url === '/dashboard/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(
      Object.fromEntries([..._widgets.entries()].map(([id, w]) => [id, w.data]))
    ));
    return true;
  }

  return false;
}

// ── Integration helper ─────────────────────────────────────────────────────

/**
 * Mount dashboard routes onto an existing overlay-server instance.
 *
 * This wraps overlay's addRoute to inject the async handleRequest middleware
 * before each overlay request is dispatched.
 *
 * Call this BEFORE overlay.startOverlayServer().
 *
 * @param {{ addRoute: Function }} overlayModule
 */
function mountOnOverlayServer(overlayModule) {
  for (const route of ['/dashboard', '/dashboard/login', '/dashboard/logout', '/dashboard/sse', '/dashboard/state']) {
    overlayModule.addRoute(route, (req, res) => {
      handleRequest(req, res).then(handled => {
        if (!handled) { res.writeHead(404); res.end('Not found'); }
      }).catch(err => {
        log.error('[dashboard] Unhandled error:', err.message);
        res.writeHead(500); res.end('Internal error');
      });
    });
  }
  log.info('[dashboard] Mounted on overlay server at /dashboard');
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  registerWidget,
  updateWidget,
  handleRequest,
  mountOnOverlayServer,
};