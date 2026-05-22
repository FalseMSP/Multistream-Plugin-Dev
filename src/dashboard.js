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
 *   POST /dashboard/command  — run a slash command { name, user, platform?, reason? } (requires auth)
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

/**
 * Append a single chat message to the dashboard chat feed.
 * Only call this with messages that have already passed through runPipeline,
 * so the dashboard sees exactly what Discord sees.
 * @param {{ platform: string, username: string, message: string, id?: *, firstTimer?: boolean }} msg
 */
function pushChatMessage(msg) {
  const widgetId = `chat-overlay-${msg.platform}`;
  const widget   = _widgets.get(widgetId);

  // Assign a monotonic id if the message doesn't already have one
  const entry = { ...msg, id: msg.id ?? Date.now() };

  if (widget) {
    const data     = widget.data ?? { messages: [] };
    const messages = [...(data.messages ?? []), entry].slice(-200);
    updateWidget(widgetId, { ...data, messages });
  }

  // Also push to the combined widget if it exists
  const combined = _widgets.get('chat-overlay-combined');
  if (combined) {
    const data     = combined.data ?? { messages: [] };
    const messages = [...(data.messages ?? []), entry].slice(-200);
    updateWidget('chat-overlay-combined', { ...data, messages });
  }
}



const _clients = new Set();

function _broadcast(payload) {
  if (_clients.size === 0) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of _clients) {
    try { res.write(msg); } catch { _clients.delete(res); }
  }
}

// ── Moderation callbacks ──────────────────────────────────────────────────

/** Handlers registered by plugins to perform actual mod actions */
const _modHandlers = [];

/**
 * Register a handler for moderation actions dispatched from the dashboard.
 * @param {{ ban: Function, timeout: Function }} handlers
 */
function onModerate(handlers) {
  _modHandlers.push(handlers);
}

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

// ── Log broadcasting ───────────────────────────────────────────────────────

const LOG_BUFFER_SIZE = 200;
const _logBuffer = [];

function _broadcastLog(level, message) {
  const entry = { level, message, ts: Date.now() };
  _logBuffer.push(entry);
  if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
  _broadcast({ type: 'log', entry });
}

// Intercept the logger so dashboard captures output
const _origLog = { info: log.info?.bind(log), warn: log.warn?.bind(log), error: log.error?.bind(log) };
if (log.info) {
  log.info  = (...a) => { _origLog.info(...a);  _broadcastLog('info',  a.join(' ')); };
  log.warn  = (...a) => { _origLog.warn(...a);  _broadcastLog('warn',  a.join(' ')); };
  log.error = (...a) => { _origLog.error(...a); _broadcastLog('error', a.join(' ')); };
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

  // Gather all slash command metadata for the command panel
  const discord = require('./discord');
  const allCommandsMeta = [
    ...(discord.coreCommandsMeta ?? []),
    ...(typeof discord.getPluginCommandsMeta === 'function' ? discord.getPluginCommandsMeta() : []),
  ];

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
  .shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
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
  .topbar-console-btn {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--muted); background: none;
    border: 1px solid var(--border); border-radius: 4px;
    padding: 5px 10px; cursor: pointer; font-family: inherit;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .topbar-console-btn:hover { color: var(--text); border-color: var(--muted); }
  .topbar-console-btn.active { color: var(--accent); border-color: rgba(229,57,53,0.35); background: var(--accent-lo); }
  /* ── Layout shell ── */
  .dashboard-layout { flex: 1; display: flex; overflow: hidden; min-height: 0; }
  /* ── Left: widget grid ── */
  .grid { flex: 1; position: relative; overflow: auto; min-height: 0; }
  .grid-inner { position: relative; width: 100%; min-height: 100%; }
  /* ── Right: chat column ── */
  .chat-column {
    width: 380px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface);
    overflow: hidden;
  }
  .chat-column-header {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 14px; border-bottom: 1px solid var(--border);
    background: var(--accent-lo); flex-shrink: 0;
  }
  .chat-column-title { font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  .chat-column-tabs { display: flex; gap: 6px; margin-left: auto; }
  .chat-tab {
    font-size: 10px; font-family: var(--mono); font-weight: 700;
    padding: 3px 8px; border-radius: 3px; border: 1px solid var(--border);
    background: transparent; color: var(--muted); cursor: pointer; transition: all 0.15s;
  }
  .chat-tab.active { background: var(--accent-lo); border-color: rgba(229,57,53,0.35); color: var(--accent); }
  .chat-tab:hover:not(.active) { color: var(--text); border-color: var(--muted); }
  .chat-feed {
    flex: 1; overflow-y: auto; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 4px;
    scroll-behavior: smooth;
  }
  .chat-feed::-webkit-scrollbar { width: 4px; }
  .chat-feed::-webkit-scrollbar-track { background: transparent; }
  .chat-feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .chat-msg { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; line-height: 1.45; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
  .chat-msg:last-child { border-bottom: none; }
  /* First-time chatter highlight */
  .chat-msg--first-timer {
    background: rgba(145, 70, 255, 0.10);
    border-radius: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid rgba(145, 70, 255, 0.18);
    margin: 1px 0;
  }
  .chat-msg--first-timer .chat-text { color: #d4b8ff; }
  .chat-msg--first-timer .chat-sep  { color: #9146FF; }
  .chat-first-timer-badge {
    font-size: 9px; font-family: var(--mono); font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: #9146FF; background: rgba(145,70,255,0.18);
    border: 1px solid rgba(145,70,255,0.4);
    border-radius: 3px; padding: 1px 5px;
    flex-shrink: 0; align-self: center; white-space: nowrap;
  }
  .chat-platform-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
  .chat-platform-dot.youtube { background: #FF0000; }
  .chat-platform-dot.twitch  { background: #9146FF; }
  .chat-username {
    font-weight: 700; font-size: 12px; flex-shrink: 0;
    cursor: pointer; text-decoration: none;
    transition: opacity 0.15s;
    background: none; border: none; padding: 0;
    font-family: inherit; line-height: inherit;
  }
  .chat-username:hover { opacity: 0.7; text-decoration: underline; }
  .chat-sep { color: var(--muted); flex-shrink: 0; }
  .chat-text { color: var(--text); word-break: break-word; min-width: 0; flex: 1; }
  .chat-empty { color: var(--muted); font-size: 12px; font-family: var(--mono); padding: 20px 0; text-align: center; }
  /* ── Moderation modal ── */
  .mod-overlay {
    display: none; position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.6); align-items: center; justify-content: center;
  }
  .mod-overlay.open { display: flex; }
  .mod-modal {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 24px; width: 320px; position: relative;
  }
  .mod-modal h3 { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
  .mod-modal .mod-platform { font-size: 11px; font-family: var(--mono); color: var(--muted); margin-bottom: 18px; }
  .mod-actions { display: flex; flex-direction: column; gap: 8px; }
  .mod-btn {
    width: 100%; padding: 9px 14px; border-radius: 5px; border: 1px solid var(--border);
    font-size: 13px; font-weight: 600; cursor: pointer; text-align: left;
    background: var(--surface2); color: var(--text); transition: all 0.15s; font-family: inherit;
  }
  .mod-btn:hover { border-color: var(--muted); }
  .mod-btn.danger { color: #ff5252; border-color: rgba(255,82,82,0.3); }
  .mod-btn.danger:hover { background: rgba(255,82,82,0.1); border-color: #ff5252; }
  .mod-btn.cancel { color: var(--muted); }
  .mod-close { position: absolute; top: 12px; right: 14px; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; }
  /* ── Widget card ── */
  .widget-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; overflow: hidden; position: absolute;
    width: 320px; min-width: 200px; min-height: 80px;
  }
  .widget-card.snap-preview { outline: 2px dashed var(--accent); outline-offset: 2px; }
  .widget-resize-handle {
    position: absolute; bottom: 0; right: 0;
    width: 14px; height: 14px; cursor: se-resize;
    opacity: 0; transition: opacity 0.15s;
    z-index: 10;
  }
  .widget-resize-handle::after {
    content: '';
    position: absolute; bottom: 3px; right: 3px;
    width: 6px; height: 6px;
    border-right: 2px solid var(--muted);
    border-bottom: 2px solid var(--muted);
    border-radius: 0 0 2px 0;
  }
  .widget-card:hover .widget-resize-handle { opacity: 1; }
  .widget-card.is-resizing { user-select: none; }
  .widget-header { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--border); background: var(--accent-lo); }
  .widget-icon { width: 20px; height: 20px; flex-shrink: 0; color: var(--accent); }
  .widget-title { font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  .widget-badge { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .widget-body { padding: 12px 14px; font-size: 13px; line-height: 1.5; }
  /* ── Empty state ── */
  .empty { grid-column: 1/-1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: var(--muted); gap: 12px; text-align: center; }
  .empty svg { opacity: 0.3; }
  .empty p { font-size: 14px; }
  /* ── Drag handle ── */
  .widget-card { cursor: default; user-select: none; }
  .widget-header { cursor: grab; }
  .widget-header:active { cursor: grabbing; }
  .widget-card.dragging { opacity: 0.85; box-shadow: 0 12px 40px rgba(0,0,0,0.6); z-index: 50; cursor: grabbing; }
  .widget-card.minimized .widget-body { display: none; }
  .widget-minimize {
    margin-left: 6px; background: none; border: none; color: var(--muted);
    cursor: pointer; padding: 2px 5px; border-radius: 3px; font-size: 14px;
    line-height: 1; transition: color 0.15s, background 0.15s; display: flex; align-items: center;
  }
  .widget-minimize:hover { color: var(--text); background: rgba(255,255,255,0.07); }
  /* ── Widgets menu in topbar ── */
  .widgets-menu-wrap { position: relative; }
  .widgets-menu-btn {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--muted); background: none;
    border: 1px solid var(--border); border-radius: 4px;
    padding: 5px 10px; cursor: pointer; font-family: inherit;
    transition: color 0.15s, border-color 0.15s;
  }
  .widgets-menu-btn:hover { color: var(--text); border-color: var(--muted); }
  .widgets-menu-btn .wm-count {
    background: var(--accent); color: #fff; font-size: 9px; font-weight: 700;
    padding: 1px 5px; border-radius: 3px; font-family: var(--mono);
    display: none;
  }
  .widgets-menu-btn .wm-count.has-items { display: inline-block; }
  .widgets-dropdown {
    display: none; position: absolute; top: calc(100% + 6px); right: 0;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; min-width: 220px; z-index: 200;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden;
  }
  .widgets-dropdown.open { display: block; }
  .widgets-dropdown-header {
    padding: 8px 14px; font-size: 10px; font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .widgets-dropdown-empty {
    padding: 14px; font-size: 12px; color: var(--muted); text-align: center; font-family: var(--mono);
  }
  .widgets-dropdown-item {
    display: flex; align-items: center; gap: 10px; padding: 9px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer;
    transition: background 0.12s;
  }
  .widgets-dropdown-item:last-child { border-bottom: none; }
  .widgets-dropdown-item:hover { background: var(--surface2); }
  .widgets-dropdown-item-icon { width: 16px; height: 16px; color: var(--accent); flex-shrink: 0; }
  .widgets-dropdown-item-title { font-size: 12px; font-weight: 600; flex: 1; }
  .widgets-dropdown-item-restore {
    font-size: 10px; font-family: var(--mono); color: var(--accent);
    background: var(--accent-lo); border: 1px solid rgba(229,57,53,0.3);
    border-radius: 3px; padding: 2px 7px; cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }
  .widgets-dropdown-item-restore:hover { background: rgba(229,57,53,0.2); }
  /* ── Log console ── */
  .log-console {
    height: 180px; flex-shrink: 0;
    border-top: 1px solid var(--border);
    display: flex; flex-direction: column;
    background: #0a0a0c;
    transition: height 0.2s ease;
  }
  .log-console.hidden { height: 0 !important; overflow: hidden; border-top: none; }
  .log-console-header {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 14px; border-bottom: 1px solid var(--border);
    background: var(--surface); flex-shrink: 0;
  }
  .log-console-title { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
  .log-console-clear { margin-left: auto; font-size: 10px; font-family: var(--mono); color: var(--muted); background: none; border: 1px solid var(--border); border-radius: 3px; padding: 2px 7px; cursor: pointer; transition: all 0.15s; }
  .log-console-clear:hover { color: var(--text); border-color: var(--muted); }
  .log-console-resize { height: 4px; background: var(--border); cursor: ns-resize; flex-shrink: 0; transition: background 0.15s; }
  .log-console-resize:hover { background: var(--accent); }
  .log-feed { flex: 1; overflow-y: auto; padding: 6px 12px; font-family: var(--mono); font-size: 11px; line-height: 1.6; }
  .log-feed::-webkit-scrollbar { width: 3px; }
  .log-feed::-webkit-scrollbar-thumb { background: var(--border); }
  .log-entry { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-all; }
  .log-entry .log-ts { color: #3a3a4a; flex-shrink: 0; }
  .log-entry.info  .log-msg { color: #a0a0b0; }
  .log-entry.warn  .log-msg { color: #f59e0b; }
  .log-entry.error .log-msg { color: #f87171; }
  .log-entry.info  .log-lvl { color: #4a4a6a; }
  .log-entry.warn  .log-lvl { color: #f59e0b; }
  .log-entry.error .log-lvl { color: #f87171; }
  /* ── Reconnect bar ── */
  .reconnect-bar { display: none; padding: 8px 20px; background: rgba(229,57,53,0.1); border-top: 1px solid rgba(229,57,53,0.25); font-family: var(--mono); font-size: 11px; color: var(--accent); animation: blink 1s step-start infinite; }
  @keyframes blink { 50%{opacity:0} }
  /* ── Slash command panel ── */
  .cmd-panel {
    border-top: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }
  .cmd-panel-resize { height: 4px; background: var(--border); cursor: ns-resize; flex-shrink: 0; transition: background 0.15s; }
  .cmd-panel-resize:hover { background: var(--accent); }
  .cmd-panel-header {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 14px; border-bottom: 1px solid var(--border);
    background: var(--surface); flex-shrink: 0; cursor: pointer;
    user-select: none;
  }
  .cmd-panel-title { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
  .cmd-panel-toggle { margin-left: auto; font-size: 11px; color: var(--muted); font-family: var(--mono); }
  .cmd-panel-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .cmd-panel-body.hidden { display: none; }
  .cmd-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
  .cmd-field { display: flex; flex-direction: column; gap: 4px; }
  .cmd-field label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .cmd-select, .cmd-input {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-size: 13px; font-family: inherit; padding: 6px 10px;
    outline: none; transition: border-color 0.15s;
  }
  .cmd-select:focus, .cmd-input:focus { border-color: var(--accent); }
  .cmd-select { cursor: pointer; }
  .cmd-input { width: 180px; }
  .cmd-input.wide { width: 240px; }
  .cmd-submit {
    padding: 7px 16px; background: var(--accent); color: #fff;
    border: none; border-radius: 4px; font-size: 12px; font-weight: 700;
    cursor: pointer; letter-spacing: 0.04em; font-family: inherit;
    transition: opacity 0.15s; white-space: nowrap; align-self: flex-end;
  }
  .cmd-submit:hover { opacity: 0.85; }
  .cmd-submit:disabled { opacity: 0.4; cursor: not-allowed; }
  .cmd-result-bar {
    font-family: var(--mono); font-size: 11px; line-height: 1.55;
    padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--bg); color: var(--muted); white-space: pre-wrap;
    display: none;
  }
  .cmd-result-bar.visible { display: block; }
  .cmd-result-bar.ok    { color: #4ade80; border-color: rgba(74,222,128,0.3); }
  .cmd-result-bar.warn  { color: #f59e0b; border-color: rgba(245,158,11,0.3); }
  .cmd-result-bar.error { color: #f87171; border-color: rgba(248,113,113,0.3); }
  /* ── Command autocomplete ── */
  .cmd-autocomplete {
    position: fixed; z-index: 9999;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 4px; display: none; max-height: 260px; overflow-y: auto;
    box-shadow: 0 -8px 32px rgba(0,0,0,0.55);
    min-width: 320px;
  }
  .cmd-autocomplete.open { display: block; }
  .cmd-ac-item {
    padding: 6px 10px; cursor: pointer; font-size: 12px; font-family: var(--mono);
    display: flex; align-items: baseline; gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .cmd-ac-item:last-child { border-bottom: none; }
  .cmd-ac-item:hover, .cmd-ac-item.active { background: var(--accent-lo); color: var(--text); }
  .cmd-ac-name  { color: var(--accent); font-weight: 700; white-space: nowrap; }
  .cmd-ac-desc  { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
    <div class="widgets-menu-wrap" id="widgets-menu-wrap">
      <button class="widgets-menu-btn" id="widgets-menu-btn" title="Minimized widgets">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Widgets
        <span class="wm-count" id="wm-count">0</span>
      </button>
      <div class="widgets-dropdown" id="widgets-dropdown">
        <div class="widgets-dropdown-header">Minimized Widgets</div>
        <div id="widgets-dropdown-list"><div class="widgets-dropdown-empty">No minimized widgets</div></div>
      </div>
    </div>
    <button class="topbar-console-btn" id="console-toggle-btn" title="Toggle console">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      Console
    </button>
    <div class="topbar-status">
      <span class="status-dot" id="status-dot"></span>
      <span id="status-text">connected</span>
    </div>
    <a class="topbar-logout" href="/dashboard/logout">Sign out</a>
  </header>

  <div class="dashboard-layout">
    <div class="grid" id="widget-grid-wrap">
      <main class="grid-inner" id="widget-grid">
        ${_widgets.size === 0 ? `
        <div class="empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <p>No widgets registered yet.<br>Call <code>dashboard.registerWidget()</code> to add one.</p>
        </div>` : ''}
      </main>
    </div>

    <aside class="chat-column">
      <div class="chat-column-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="chat-column-title">Live Chat</span>
        <div class="chat-column-tabs">
          <button class="chat-tab active" data-feed="combined">All</button>
          <button class="chat-tab" data-feed="youtube">
            <span style="color:#FF0000">▶</span> YT
          </button>
          <button class="chat-tab" data-feed="twitch">
            <span style="color:#9146FF">◆</span> TW
          </button>
        </div>
      </div>
      <div class="chat-feed" id="chat-feed">
        <div class="chat-empty">No messages yet</div>
      </div>
    </aside>
  </div>

  <div class="reconnect-bar" id="reconnect-bar">⚠ Lost connection — reconnecting…</div>

  <!-- Slash command panel -->
  <div class="cmd-panel" id="cmd-panel">
    <div class="cmd-panel-resize" id="cmd-resize"></div>
    <div class="cmd-panel-header" id="cmd-panel-header">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      <span class="cmd-panel-title">/ Commands</span>
      <span class="cmd-panel-toggle" id="cmd-toggle">▲</span>
    </div>
    <div class="cmd-panel-body" id="cmd-panel-body">
      <div class="cmd-row">
        <div class="cmd-field">
          <label for="cmd-input">Command</label>
          <input class="cmd-input wide" id="cmd-input" type="text" placeholder="e.g. /ban or /queue list" autocomplete="off" spellcheck="false">
        </div>
        <div class="cmd-field" id="cmd-dynamic-fields"></div>
        <button class="cmd-submit" id="cmd-submit">Run</button>
      </div>
      <div class="cmd-result-bar" id="cmd-result"></div>
    </div>
  </div>

  <!-- Log console -->
  <div class="log-console" id="log-console">
    <div class="log-console-resize" id="log-resize"></div>
    <div class="log-console-header">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="color:var(--muted)"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      <span class="log-console-title">Console</span>
      <button class="log-console-clear" id="log-clear">Clear</button>
    </div>
    <div class="log-feed" id="log-feed"></div>
  </div>
</div>

<!-- Moderation modal -->
<div class="mod-overlay" id="mod-overlay">
  <div class="mod-modal">
    <button class="mod-close" id="mod-close">×</button>
    <h3 id="mod-username"></h3>
    <div class="mod-platform" id="mod-platform"></div>
    <div class="mod-actions">
      <button class="mod-btn" id="mod-timeout-60">⏱ Timeout 60s</button>
      <button class="mod-btn" id="mod-timeout-600">⏱ Timeout 10 min</button>
      <button class="mod-btn" id="mod-timeout-3600">⏱ Timeout 1 hour</button>
      <button class="mod-btn danger" id="mod-ban">🚫 Ban permanently</button>
      <button class="mod-btn cancel" id="mod-cancel">Cancel</button>
    </div>
  </div>
</div>

<!-- Autocomplete portal (top-level to avoid clipping) -->
<div class="cmd-autocomplete" id="cmd-autocomplete"></div>

<script>
(function () {
  const WIDGETS     = ${JSON.stringify(widgetMeta)};
  const initialData = ${JSON.stringify(initialData)};
  const ALL_COMMANDS = ${JSON.stringify(allCommandsMeta)};

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
        '<button class="widget-minimize" data-widget-id="' + w.id + '" title="Minimize widget">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="widget-body" id="wbody-' + w.id + '"></div>' +
      '<div class="widget-resize-handle" data-widget-resize="' + w.id + '"></div>';
    grid.appendChild(card);
    bodies[w.id] = card.querySelector('.widget-body');
    badges[w.id] = card.querySelector('.widget-badge');
  }

  // ── Freeform widget positioning ──────────────────────────────────────────
  const SNAP_GRID = 20; // px grid when shift held
  const widgetPositions = JSON.parse(localStorage.getItem('dash-positions') || '{}');

  function savePositions() {
    const pos = {};
    document.querySelectorAll('.widget-card').forEach(c => {
      pos[c.id] = { x: parseInt(c.style.left) || 0, y: parseInt(c.style.top) || 0,
                    w: c.style.width || '', h: c.style.height || '' };
    });
    localStorage.setItem('dash-positions', JSON.stringify(pos));
  }

  function applyPositions() {
    // Auto-layout: place widgets in a loose grid as default
    let col = 0, row = 0, maxRowH = 0;
    const PAD = 20, COLS = 3, DEF_W = 320;
    document.querySelectorAll('.widget-card').forEach((card) => {
      const saved = widgetPositions[card.id];
      if (saved) {
        card.style.left   = saved.x + 'px';
        card.style.top    = saved.y + 'px';
        if (saved.w) card.style.width  = saved.w;
        if (saved.h) card.style.height = saved.h;
      } else {
        // Initial grid placement
        const x = PAD + col * (DEF_W + PAD);
        const y = PAD + row * (maxRowH || 160 + PAD);
        card.style.left = x + 'px';
        card.style.top  = y + 'px';
        col++;
        if (col >= COLS) { col = 0; row++; maxRowH = 0; }
      }
    });
  }

  // Apply positions after cards are in DOM
  applyPositions();

  // Expand canvas to fit all cards
  function expandCanvas() {
    let maxX = 0, maxY = 0;
    document.querySelectorAll('.widget-card').forEach(c => {
      maxX = Math.max(maxX, (parseInt(c.style.left) || 0) + c.offsetWidth + 20);
      maxY = Math.max(maxY, (parseInt(c.style.top)  || 0) + c.offsetHeight + 20);
    });
    grid.querySelector('.grid-inner').style.width  = maxX + 'px';
    grid.querySelector('.grid-inner').style.height = maxY + 'px';
  }

  // ── Mouse drag on widget headers ─────────────────────────────────────────
  let wDrag = null;
  grid.addEventListener('mousedown', (e) => {
    const header = e.target.closest('.widget-header');
    if (!header) return;
    // Don't hijack minimize button
    if (e.target.closest('.widget-minimize')) return;
    const card = header.closest('.widget-card');
    if (!card) return;
    e.preventDefault();
    const startX   = e.clientX;
    const startY   = e.clientY;
    const startL   = parseInt(card.style.left) || 0;
    const startT   = parseInt(card.style.top)  || 0;
    card.style.zIndex = '50';
    card.classList.add('dragging');
    wDrag = { card, startX, startY, startL, startT };
  });

  document.addEventListener('mousemove', (e) => {
    if (!wDrag) return;
    const { card, startX, startY, startL, startT } = wDrag;
    let nx = startL + (e.clientX - startX);
    let ny = startT + (e.clientY - startY);
    if (e.shiftKey) {
      nx = Math.round(nx / SNAP_GRID) * SNAP_GRID;
      ny = Math.round(ny / SNAP_GRID) * SNAP_GRID;
      card.classList.add('snap-preview');
    } else {
      card.classList.remove('snap-preview');
    }
    card.style.left = Math.max(0, nx) + 'px';
    card.style.top  = Math.max(0, ny) + 'px';
  });

  document.addEventListener('mouseup', (e) => {
    if (!wDrag) return;
    wDrag.card.classList.remove('dragging', 'snap-preview');
    wDrag.card.style.zIndex = '';
    expandCanvas();
    savePositions();
    wDrag = null;
  });

  // ── Widget resize ────────────────────────────────────────────────────────
  let wResizing = null;
  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.widget-resize-handle');
    if (!handle) return;
    const card = handle.closest('.widget-card');
    if (!card) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = card.offsetWidth, startH = card.offsetHeight;
    card.classList.add('is-resizing');
    wResizing = { card, startX, startY, startW, startH };
    document.body.style.cursor = 'se-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!wResizing) return;
    const { card, startX, startY, startW, startH } = wResizing;
    const newW = Math.max(220, startW + (e.clientX - startX));
    const newH = Math.max(120, startH + (e.clientY - startY));
    card.style.width  = newW + 'px';
    card.style.height = newH + 'px';
    // Make body fill remaining height
    const body = card.querySelector('.widget-body');
    if (body) {
      const headerH = card.querySelector('.widget-header')?.offsetHeight || 0;
      body.style.height = (newH - headerH) + 'px';
      body.style.overflow = 'auto';
    }
  });
  document.addEventListener('mouseup', () => {
    if (!wResizing) return;
    wResizing.card.classList.remove('is-resizing');
    wResizing = null;
    document.body.style.cursor = '';
    expandCanvas();
    savePositions();
  });

  function invoke(id, data) {
    if (!renderers[id] || !bodies[id]) return;
    try {
      renderers[id](data, bodies[id], esc, { badge: badges[id] });
    } catch (e) { console.error('[dashboard] render error in', id, e); }
  }

  for (const w of WIDGETS) invoke(w.id, initialData[w.id]);
  expandCanvas();

  // ── Chat column ──────────────────────────────────────────────────────────

  const chatFeed   = document.getElementById('chat-feed');
  const chatTabs   = document.querySelectorAll('.chat-tab');
  let   chatFilter = 'combined';  // 'combined' | 'youtube' | 'twitch'

  // All received messages, keyed by platform
  const allMessages = { youtube: [], twitch: [], combined: [] };
  const MAX_CHAT = 200;

  const PLATFORM_COLORS = { youtube: '#FF0000', twitch: '#9146FF' };

  chatTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      chatTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      chatFilter = tab.dataset.feed;
      rerenderChat();
    });
  });

  function buildChatRow(msg) {
    const row = document.createElement('div');
    row.className = 'chat-msg' + (msg.firstTimer ? ' chat-msg--first-timer' : '');

    const dot = document.createElement('span');
    dot.className = 'chat-platform-dot ' + msg.platform;
    row.appendChild(dot);

    const nameBtn = document.createElement('button');
    nameBtn.className = 'chat-username';
    nameBtn.textContent = msg.username;
    const nameColor = msg.firstTimer
      ? '#b084ff'
      : (msg.color || PLATFORM_COLORS[msg.platform] || '#ffffff');
    nameBtn.style.color = nameColor;
    nameBtn.addEventListener('click', () => openModModal(msg.username, msg.platform));
    row.appendChild(nameBtn);

    const sep = document.createElement('span');
    sep.className = 'chat-sep';
    sep.textContent = ':';
    row.appendChild(sep);

    const text = document.createElement('span');
    text.className = 'chat-text';
    if (Array.isArray(msg.segments) && msg.segments.length) {
      for (const seg of msg.segments) {
        if (seg.type === 'emote') {
          const img = document.createElement('img');
          img.src = seg.url; img.alt = seg.alt || '';
          img.style.cssText = 'height:1.3em;vertical-align:middle;margin:0 1px';
          text.appendChild(img);
        } else {
          text.appendChild(document.createTextNode(seg.text));
        }
      }
    } else {
      text.textContent = msg.message;
    }
    row.appendChild(text);

    if (msg.firstTimer) {
      const badge = document.createElement('span');
      badge.className = 'chat-first-timer-badge';
      badge.textContent = '✦ first chat';
      row.appendChild(badge);
    }

    return row;
  }

  function rerenderChat() {
    const msgs = allMessages[chatFilter] || [];
    chatFeed.innerHTML = '';
    if (!msgs.length) {
      chatFeed.innerHTML = '<div class="chat-empty">No messages yet</div>';
      return;
    }
    for (const m of msgs) chatFeed.appendChild(buildChatRow(m));
    chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  function pushChatMessages(platform, messages) {
    const list = allMessages[platform];
    // Determine new messages by tracking last known length; just push all for combined
    for (const m of messages) {
      if (m.dashboardSuppress) continue; // filtered by a plugin (e.g. yt-bot-filter)
      if (!list.find(x => x.id === m.id)) {
        list.push(m);
        if (platform !== 'combined') {
          // Also add to combined if not already there
          if (!allMessages.combined.find(x => x.id === m.id)) {
            allMessages.combined.push(m);
          }
        }
      }
    }
    // Trim
    if (list.length > MAX_CHAT) list.splice(0, list.length - MAX_CHAT);
    if (allMessages.combined.length > MAX_CHAT) allMessages.combined.splice(0, allMessages.combined.length - MAX_CHAT);
    // Sort combined by id
    allMessages.combined.sort((a, b) => a.id - b.id);

    // If currently viewing this platform or combined, append new rows
    const activeList = allMessages[chatFilter];
    const atBottom   = chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 60;

    // Full re-render is simplest; only perf-sensitive at very high volume
    rerenderChat();
    if (atBottom) chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  // Handle SSE widget updates that carry chat data
  const CHAT_SECTION_IDS = {
    'chat-overlay-youtube':  'youtube',
    'chat-overlay-twitch':   'twitch',
    'chat-overlay-combined': 'combined',
  };

  // ── Log console ──────────────────────────────────────────────────────────
  const logFeed    = document.getElementById('log-feed');
  const logClear   = document.getElementById('log-clear');
  const logConsole = document.getElementById('log-console');
  const logResize  = document.getElementById('log-resize');

  function addLogEntry(entry) {
    const atBottom = logFeed.scrollHeight - logFeed.scrollTop - logFeed.clientHeight < 40;
    const row = document.createElement('div');
    row.className = 'log-entry ' + (entry.level || 'info');
    const ts = new Date(entry.ts);
    const pad = n => String(n).padStart(2, '0');
    const timeStr = pad(ts.getHours()) + ':' + pad(ts.getMinutes()) + ':' + pad(ts.getSeconds());
    row.innerHTML =
      '<span class="log-ts">' + timeStr + '</span>' +
      '<span class="log-lvl">[' + (entry.level || 'info').toUpperCase().padEnd(5) + ']</span>' +
      '<span class="log-msg">' + esc(entry.message) + '</span>';
    logFeed.appendChild(row);
    // Cap at 500 entries
    while (logFeed.children.length > 500) logFeed.removeChild(logFeed.firstChild);
    if (atBottom) logFeed.scrollTop = logFeed.scrollHeight;
  }

  logClear.addEventListener('click', () => { logFeed.innerHTML = ''; });

  // Resizable console (drag the top border)
  let resizing = false, resizeStartY = 0, resizeStartH = 0;
  logResize.addEventListener('mousedown', (e) => {
    resizing     = true;
    resizeStartY = e.clientY;
    resizeStartH = logConsole.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const delta = resizeStartY - e.clientY;
    logConsole.style.height = Math.max(80, Math.min(600, resizeStartH + delta)) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
  });

  // ── Console show/hide toggle ─────────────────────────────────────────────
  const consoleToggleBtn = document.getElementById('console-toggle-btn');
  let consoleVisible = true;

  consoleToggleBtn.addEventListener('click', () => {
    consoleVisible = !consoleVisible;
    logConsole.classList.toggle('hidden', !consoleVisible);
    consoleToggleBtn.classList.toggle('active', consoleVisible);
  });
  // Start with console visible and button highlighted
  consoleToggleBtn.classList.add('active');

  // ── Cmd panel resize ─────────────────────────────────────────────────────
  const cmdPanel  = document.getElementById('cmd-panel');
  const cmdResize = document.getElementById('cmd-resize');
  let cmdResizing = false, cmdResizeStartY = 0, cmdResizeStartH = 0;

  cmdResize.addEventListener('mousedown', (e) => {
    cmdResizing     = true;
    cmdResizeStartY = e.clientY;
    cmdResizeStartH = cmdPanel.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!cmdResizing) return;
    const delta = cmdResizeStartY - e.clientY;
    cmdPanel.style.maxHeight = Math.max(48, Math.min(400, cmdResizeStartH + delta)) + 'px';
    cmdPanel.style.overflow  = 'hidden';
  });
  document.addEventListener('mouseup', () => {
    if (!cmdResizing) return;
    cmdResizing = false;
    document.body.style.cursor = '';
  });

  // ── Moderation modal ─────────────────────────────────────────────────────

  const modOverlay  = document.getElementById('mod-overlay');
  let   modTarget   = { username: '', platform: '' };

  function openModModal(username, platform) {
    modTarget = { username, platform };
    document.getElementById('mod-username').textContent = username;
    document.getElementById('mod-platform').textContent =
      (platform === 'youtube' ? '▶ YouTube' : '◆ Twitch') + ' · click an action below';
    modOverlay.classList.add('open');
  }

  function closeModModal() { modOverlay.classList.remove('open'); }

  async function sendModAction(action, duration) {
    closeModModal();
    try {
      await fetch('/dashboard/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: modTarget.username, platform: modTarget.platform, action, duration }),
      });
    } catch (e) {
      console.warn('[dashboard] moderate request failed:', e);
    }
  }

  document.getElementById('mod-close').addEventListener('click', closeModModal);
  document.getElementById('mod-cancel').addEventListener('click', closeModModal);
  document.getElementById('mod-timeout-60').addEventListener('click',   () => sendModAction('timeout', 60));
  document.getElementById('mod-timeout-600').addEventListener('click',  () => sendModAction('timeout', 600));
  document.getElementById('mod-timeout-3600').addEventListener('click', () => sendModAction('timeout', 3600));
  document.getElementById('mod-ban').addEventListener('click',          () => sendModAction('ban', 0));
  modOverlay.addEventListener('click', (e) => { if (e.target === modOverlay) closeModModal(); });

  // ── SSE ──────────────────────────────────────────────────────────────────

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
        if (msg.type === 'widget') {
          invoke(msg.id, msg.data);
          // Also feed chat column
          const platform = CHAT_SECTION_IDS[msg.id];
          if (platform && msg.data && Array.isArray(msg.data.messages)) {
            pushChatMessages(platform, msg.data.messages);
          }
        } else if (msg.type === 'log' && msg.entry) {
          addLogEntry(msg.entry);
        }
      } catch {}
    };
    es.onerror = () => {
      setOnline(false);
      es.close();
      setTimeout(connect, 3000);
    };
  }
  connect();

  // Bootstrap chat from initial data
  for (const [sectionId, platform] of Object.entries(CHAT_SECTION_IDS)) {
    const d = initialData[sectionId];
    if (d && Array.isArray(d.messages)) pushChatMessages(platform, d.messages);
  }
  // ── Minimize / restore widgets ───────────────────────────────────────────

  const minimizedSet = new Set(
    JSON.parse(localStorage.getItem('dash-minimized') || '[]')
  );

  function saveMinimized() {
    localStorage.setItem('dash-minimized', JSON.stringify([...minimizedSet]));
  }

  const wmCount      = document.getElementById('wm-count');
  const wmDropdown   = document.getElementById('widgets-dropdown');
  const wmList       = document.getElementById('widgets-dropdown-list');
  const wmBtn        = document.getElementById('widgets-menu-btn');
  const wmWrap       = document.getElementById('widgets-menu-wrap');

  function updateWidgetsMenu() {
    const minimized = WIDGETS.filter(w => minimizedSet.has(w.id));
    const count = minimized.length;
    wmCount.textContent = count;
    wmCount.classList.toggle('has-items', count > 0);

    if (count === 0) {
      wmList.innerHTML = '<div class="widgets-dropdown-empty">No minimized widgets</div>';
    } else {
      wmList.innerHTML = '';
      for (const w of minimized) {
        const item = document.createElement('div');
        item.className = 'widgets-dropdown-item';
        item.innerHTML =
          '<span class="widgets-dropdown-item-icon">' + w.icon + '</span>' +
          '<span class="widgets-dropdown-item-title">' + esc(w.title) + '</span>' +
          '<button class="widgets-dropdown-item-restore" data-restore-id="' + w.id + '">Restore</button>';
        wmList.appendChild(item);
      }
    }
  }

  // Store removed cards so they can be restored
  const removedCards = {};

  function minimizeWidget(id) {
    minimizedSet.add(id);
    saveMinimized();
    const card = document.getElementById('wcard-' + id);
    if (card) {
      removedCards[id] = card;
      card.remove();
    }
    updateWidgetsMenu();
  }

  function restoreWidget(id) {
    minimizedSet.delete(id);
    saveMinimized();
    const card = removedCards[id];
    if (card) {
      grid.querySelector('.grid-inner').appendChild(card);
      // Re-apply saved position
      const savedPos = widgetPositions[card.id];
      if (savedPos) {
        card.style.left = savedPos.x + 'px';
        card.style.top  = savedPos.y + 'px';
      }
      delete removedCards[id];
      expandCanvas();
    }
    updateWidgetsMenu();
  }

  // Apply persisted minimized state on load
  for (const id of minimizedSet) {
    const card = document.getElementById('wcard-' + id);
    if (card) {
      removedCards[id] = card;
      card.remove();
    }
  }
  updateWidgetsMenu();

  // Delegate minimize button clicks on grid
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.widget-minimize');
    if (!btn) return;
    e.stopPropagation();
    minimizeWidget(btn.dataset.widgetId);
  });

  // Delegate restore button clicks in dropdown
  wmList.addEventListener('click', (e) => {
    const btn = e.target.closest('.widgets-dropdown-item-restore');
    if (!btn) return;
    restoreWidget(btn.dataset.restoreId);
    if (!minimizedSet.size) wmDropdown.classList.remove('open');
  });

  // Toggle dropdown
  wmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    wmDropdown.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!wmWrap.contains(e.target)) wmDropdown.classList.remove('open');
  });

  // ── Slash command panel ──────────────────────────────────────────────────

  const cmdPanelBody = document.getElementById('cmd-panel-body');
  const cmdHeader    = document.getElementById('cmd-panel-header');
  const cmdToggle    = document.getElementById('cmd-toggle');
  const cmdInput     = document.getElementById('cmd-input');
  const cmdAC        = document.getElementById('cmd-autocomplete');
  const cmdDynFields = document.getElementById('cmd-dynamic-fields');
  const cmdSubmit    = document.getElementById('cmd-submit');
  const cmdResult    = document.getElementById('cmd-result');

  // ── Build a flat list of every invocable command token ──────────────────
  // For commands with subcommands: "/queue list", "/queue clear", etc.
  // For plain commands: "/ban", "/sendchat", etc.
  // acItems: [{ token, name, subcommand, subcommandGroup, description, leafOptions }]
  const OPT_SUB = 1, OPT_SUB_GROUP = 2;

  const acItems = [];
  for (const cmd of ALL_COMMANDS) {
    const hasSubcommands = cmd.options.some(o => o.type === OPT_SUB || o.type === OPT_SUB_GROUP);
    if (!hasSubcommands) {
      acItems.push({
        token:           '/' + cmd.name,
        name:            cmd.name,
        subcommand:      null,
        subcommandGroup: null,
        description:     cmd.description,
        leafOptions:     cmd.options,
      });
    } else {
      for (const opt of cmd.options) {
        if (opt.type === OPT_SUB) {
          acItems.push({
            token:           '/' + cmd.name + ' ' + opt.name,
            name:            cmd.name,
            subcommand:      opt.name,
            subcommandGroup: null,
            description:     opt.description,
            leafOptions:     opt.options ?? [],
          });
        } else if (opt.type === OPT_SUB_GROUP) {
          for (const sub of (opt.options ?? [])) {
            acItems.push({
              token:           '/' + cmd.name + ' ' + opt.name + ' ' + sub.name,
              name:            cmd.name,
              subcommand:      sub.name,
              subcommandGroup: opt.name,
              description:     sub.description,
              leafOptions:     sub.options ?? [],
            });
          }
        }
      }
    }
  }

  // ── Autocomplete state ───────────────────────────────────────────────────
  let acVisible  = false;
  let acIndex    = -1;
  let acFiltered = [];
  let _currentItem    = null;   // resolved acItem
  let _currentInputs  = {};     // optName → <input|select>

  function acFilter(raw) {
    const q = raw.startsWith('/') ? raw.toLowerCase() : ('/' + raw).toLowerCase();
    return acItems.filter(i => i.token.toLowerCase().startsWith(q));
  }

  function acRender(items) {
    acFiltered = items;
    acIndex    = -1;
    acAC();
  }

  function acAC() {
    if (!acFiltered.length) { acClose(); return; }
    acAC_inner();
    // Position above the input using fixed coords so no clipping
    const rect = cmdInput.getBoundingClientRect();
    cmdAC.style.left  = rect.left + 'px';
    cmdAC.style.width = Math.max(rect.width, 320) + 'px';
    // Show above, but flip below if not enough room
    const acH = Math.min(260, acFiltered.length * 36);
    if (rect.top - acH > 8) {
      cmdAC.style.top    = '';
      cmdAC.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    } else {
      cmdAC.style.bottom = '';
      cmdAC.style.top    = (rect.bottom + 4) + 'px';
    }
    acVisible = true;
    cmdAC.classList.add('open');
  }

  function acAC_inner() {
    cmdAC.innerHTML = '';
    acFiltered.slice(0, 20).forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'cmd-ac-item' + (i === acIndex ? ' active' : '');
      el.innerHTML = '<span class="cmd-ac-name">' + esc(item.token) + '</span>' +
                     '<span class="cmd-ac-desc">'  + esc(item.description) + '</span>';
      el.addEventListener('mousedown', (e) => { e.preventDefault(); selectItem(item); });
      cmdAC.appendChild(el);
    });
  }

  function acClose() {
    acVisible = false;
    acIndex   = -1;
    cmdAC.classList.remove('open');
    cmdAC.innerHTML = '';
  }

  function selectItem(item) {
    _currentItem = item;
    cmdInput.value = item.token;
    acClose();
    renderDynamicFields(item);
    // Focus first dynamic input if any
    const first = cmdDynFields.querySelector('input, select');
    if (first) first.focus();
  }

  cmdInput.addEventListener('input', () => {
    cmdResult.className = 'cmd-result-bar';
    const val = cmdInput.value.trim();
    if (!val) { acClose(); _currentItem = null; renderDynamicFields(null); return; }

    // Check for exact match — resolve immediately without showing dropdown
    const exact = acItems.find(i => i.token.toLowerCase() === val.toLowerCase());
    if (exact) { _currentItem = exact; acClose(); renderDynamicFields(exact); return; }

    _currentItem = null;
    renderDynamicFields(null);
    acRender(acFilter(val));
  });

  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'ArrowDown') {
      if (!acVisible && cmdInput.value.trim()) {
        acRender(acFilter(cmdInput.value.trim()));
      }
      if (acVisible) {
        e.preventDefault();
        acIndex = (acIndex + 1) % acFiltered.length;
        acAC_inner();
      }
    } else if (e.key === 'ArrowUp') {
      if (acVisible) {
        e.preventDefault();
        acIndex = (acIndex - 1 + acFiltered.length) % acFiltered.length;
        acAC_inner();
      }
    } else if (e.key === 'Enter') {
      if (acVisible && acIndex >= 0) {
        e.preventDefault();
        selectItem(acFiltered[acIndex]);
      } else if (_currentItem) {
        cmdSubmit.click();
      }
    } else if (e.key === 'Escape') {
      acClose();
    }
  });

  document.addEventListener('click', (e) => {
    if (!cmdInput.contains(e.target) && !cmdAC.contains(e.target)) acClose();
  });

  // ── Dynamic fields ───────────────────────────────────────────────────────

  function renderDynamicFields(item) {
    _currentInputs = {};
    cmdDynFields.innerHTML = '';
    if (!item || !item.leafOptions.length) return;

    for (const opt of item.leafOptions) {
      const wrap = document.createElement('div');
      wrap.className = 'cmd-field';

      const lbl = document.createElement('label');
      lbl.setAttribute('for', 'cmd-opt-' + opt.name);
      lbl.innerHTML = esc(opt.name.charAt(0).toUpperCase() + opt.name.slice(1)) +
        (opt.required ? ' <span style="color:var(--accent)">*</span>' : '');
      wrap.appendChild(lbl);

      let input;
      if (opt.choices && opt.choices.length) {
        input = document.createElement('select');
        input.className = 'cmd-select';
        if (!opt.required) {
          const none = document.createElement('option');
          none.value = ''; none.textContent = '—';
          input.appendChild(none);
        }
        for (const ch of opt.choices) {
          const o = document.createElement('option');
          o.value = ch.value; o.textContent = ch.name;
          input.appendChild(o);
        }
      } else {
        input = document.createElement('input');
        input.className = 'cmd-input' + (opt.name === 'reason' ? ' wide' : '');
        input.type = 'text';
        input.placeholder = opt.required ? opt.name : 'optional';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') cmdSubmit.click(); });
      }
      input.id = 'cmd-opt-' + opt.name;
      wrap.appendChild(input);
      cmdDynFields.appendChild(wrap);
      _currentInputs[opt.name] = input;
    }
  }

  // Collapse / expand panel
  cmdHeader.addEventListener('click', () => {
    const hidden = cmdPanelBody.classList.toggle('hidden');
    cmdToggle.textContent = hidden ? '▼' : '▲';
  });

  function showResult(lines) {
    const hasError = lines.some(l => l.startsWith('❌') || l.startsWith('⚠️'));
    const allOk    = lines.every(l => l.startsWith('✅'));
    cmdResult.textContent = lines.join('\\n');
    cmdResult.className   = 'cmd-result-bar visible ' + (allOk ? 'ok' : hasError ? 'error' : 'warn');
  }

  cmdSubmit.addEventListener('click', async () => {
    if (!_currentItem) {
      showResult(['⚠️ Type a command first, e.g. /ban or /queue list']);
      cmdInput.focus();
      return;
    }

    const optionValues = {};
    let missingField = null;
    for (const opt of _currentItem.leafOptions) {
      const el  = _currentInputs[opt.name];
      const val = el ? el.value.trim() : '';
      if (opt.required && !val) { missingField = opt.name; break; }
      if (val) optionValues[opt.name] = val;
    }

    if (missingField) {
      showResult(['⚠️ ' + missingField.charAt(0).toUpperCase() + missingField.slice(1) + ' is required']);
      if (_currentInputs[missingField]) _currentInputs[missingField].focus();
      return;
    }

    // Pass subcommand info as special keys so the server can set them on the synthetic interaction
    if (_currentItem.subcommand)      optionValues._subcommand      = _currentItem.subcommand;
    if (_currentItem.subcommandGroup) optionValues._subcommandGroup = _currentItem.subcommandGroup;

    cmdSubmit.disabled  = true;
    cmdResult.className = 'cmd-result-bar';

    try {
      const resp = await fetch('/dashboard/command', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: _currentItem.name, options: optionValues }),
      });
      const data = await resp.json();
      showResult(data.results ?? ['⚠️ No response from server']);
    } catch (e) {
      showResult(['❌ Request failed: ' + e.message]);
    } finally {
      cmdSubmit.disabled = false;
    }
  });

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
    const html = _buildDashboardPage();
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
    for (const [id, widget] of _widgets) {
      res.write(`data: ${JSON.stringify({ type: 'widget', id, data: widget.data })}\n\n`);
    }
    // Flush buffered log entries
    for (const entry of _logBuffer) {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
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

  // ── POST /dashboard/command ───────────────────────────────────────────────
  if (method === 'POST' && url === '/dashboard/command') {
    const raw = await _readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }

    // Support both legacy flat shape { name, user, reason, platform }
    // and new shape { name, options: { optionName: value, … } }
    const { name } = body;
    const optionValues = body.options
      ? { ...body.options }
      : { user: body.user, reason: body.reason, platform: body.platform };

    let results;
    if (!name) {
      results = ['⚠️ Missing required field: name'];
    } else {
      try {
        const discord = require('./discord');
        results = await discord.dispatchCommand(name, { _raw: optionValues });
        log.info(`[dashboard] /command /${name}: ${results.join(' | ')}`);
      } catch (err) {
        results = ['❌ Command dispatch error: ' + err.message];
        log.error('[dashboard] /command error:', err.message);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, results }));
    return true;
  }

  // ── POST /dashboard/moderate ──────────────────────────────────────────────
  if (method === 'POST' && url === '/dashboard/moderate') {
    const raw = await _readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }
    const { username, platform, action, duration } = body;
    if (username && platform && action) {
      log.info(`[dashboard] Moderation: ${action} ${username} on ${platform}${duration ? ' for ' + duration + 's' : ''}`);
      _broadcast({ type: 'moderate', username, platform, action, duration: duration ?? 0 });
      _dispatchModerate(username, platform, action, duration ?? 0).catch(err => {
        log.error('[dashboard] _dispatchModerate threw:', err.message);
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
  for (const route of ['/dashboard', '/dashboard/login', '/dashboard/logout', '/dashboard/sse', '/dashboard/state', '/dashboard/moderate', '/dashboard/command']) {
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
  pushChatMessage,
  handleRequest,
  mountOnOverlayServer,
  onModerate,
};