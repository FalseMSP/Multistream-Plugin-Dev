'use strict';

/**
 * overlay-server.js
 * ─────────────────
 * Plugin-driven stream overlay server. Any plugin can register a "section"
 * that renders into the OBS browser source overlay.
 *
 * ── Plugin API ────────────────────────────────────────────────────────────
 *
 *   const overlay = require('./overlay-server');
 *
 *   overlay.registerSection('my-plugin', {
 *     title:  'My Widget',         // header text
 *     icon:   '<svg>…</svg>',      // raw SVG string shown left of title (22×22)
 *     order:  10,                  // sort order among sections (default: 50)
 *     render: renderFn.toString(), // client-side render fn, serialised to string
 *                                  // signature: function render(data, el, esc) {}
 *                                  //   data = whatever you passed to updateSection()
 *                                  //   el   = the section's <div class="section-body">
 *                                  //   esc  = HTML-escape helper
 *   });
 *
 *   overlay.updateSection('my-plugin', { ...anyData });  // triggers SSE push
 *
 * ── HTTP endpoints ────────────────────────────────────────────────────────
 *
 *   GET /overlay          — OBS Browser Source page (add this URL in OBS)
 *   GET /sse              — SSE stream (all sections share one connection)
 *   GET /state            — full JSON snapshot of all section data (debug)
 *   GET /state/:sectionId — single-section JSON snapshot
 */

const http = require('http');
const log  = require('./logger');

// ── Section registry ──────────────────────────────────────────────────────

/** @type {Map<string, { title: string, icon: string, order: number, render: string, data: * }>} */
const _sections = new Map();

function registerSection(id, { title, icon = '', order = 50, render }) {
  if (typeof render !== 'string') {
    throw new TypeError(
      `[overlay] registerSection('${id}'): opts.render must be a function serialised ` +
      `to a string via myFn.toString() — the browser will eval it.`
    );
  }
  _sections.set(id, { title, icon, order, render, data: null });
  log.info(`[overlay] Section registered: ${id}`);
}

function updateSection(id, data) {
  const section = _sections.get(id);
  if (!section) {
    log.warn(`[overlay] updateSection('${id}'): section not registered — did you call registerSection() first?`);
    return;
  }
  section.data = data;
  _broadcast({ type: 'section', id, data });
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

// ── Overlay HTML shell ────────────────────────────────────────────────────

function _buildHtml() {
  const ordered = [..._sections.entries()]
    .sort(([, a], [, b]) => a.order - b.order);

  const sectionMeta = ordered.map(([id, s]) => ({
    id,
    title:  s.title,
    icon:   s.icon,
    render: s.render,
  }));

  const initialData = Object.fromEntries(
    [..._sections.entries()].map(([id, s]) => [id, s.data])
  );

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Stream Overlay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;900&family=JetBrains+Mono:wght@500;700&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --red:      #e53935;
    --red-dim:  #7f1d1d;
    --red-glow: rgba(229, 57, 53, 0.15);
    --bg:       rgba(10, 8, 8, 0.92);
    --bg-row:   rgba(229, 57, 53, 0.05);
    --border:   rgba(229, 57, 53, 0.3);
    --text:     #f0e0e0;
    --muted:    #6b4040;
    --danger:   #ff1744;
    --twitch:   #9147ff;
    --youtube:  #ff0000;
  }

  html, body {
    background: transparent;
    width: 420px;
    font-family: 'Inter', sans-serif;
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }

  /* ── card ─────────────────────────────────────────────────────── */
  .overlay-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    width: 420px;
    margin-bottom: 10px;
  }

  .overlay-card[data-state="closed"] {
    border-color: var(--red-dim);
    opacity: 0.55;
  }
  .overlay-card[data-state="closed"] .section-header {
    background: rgba(127, 29, 29, 0.4);
  }
  .overlay-card[data-state="closed"] .section-title {
    color: var(--muted);
  }

  /* ── section header ───────────────────────────────────────────── */
  .section-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: rgba(229, 57, 53, 0.08);
  }
  .section-icon  { width: 22px; height: 22px; flex-shrink: 0; }
  .section-title {
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--red);
  }
  .section-badge {
    margin-left: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.04em;
  }

  /* ── entry rows ───────────────────────────────────────────────── */
  .entry {
    display: grid;
    grid-template-columns: 28px 1fr;
    align-items: center;
    gap: 4px 10px;
    padding: 8px 14px;
    border-bottom: 1px solid rgba(229, 57, 53, 0.08);
    animation: fadeIn 0.2s ease;
  }
  .entry:last-child  { border-bottom: none; }
  .entry:first-child {
    background: var(--red-glow);
    border-left: 3px solid var(--red);
  }
  .entry:first-child .entry-id  { color: #fff; }
  .entry:first-child .entry-pos { color: var(--red); }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .entry-pos {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--muted);
    text-align: right;
    font-weight: 700;
  }
  .entry-main   { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .entry-id     { font-size: 18px; font-weight: 700; color: var(--red); letter-spacing: 0.02em; line-height: 1.1; }
  .entry-user   {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .entry-notes {
    grid-column: 1 / -1;
    font-size: 11px;
    color: rgba(229, 57, 53, 0.4);
    font-style: italic;
    padding-left: 38px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .platform-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .platform-dot.twitch  { background: var(--twitch); }
  .platform-dot.youtube { background: var(--youtube); }

  /* ── utility ──────────────────────────────────────────────────── */
  .msg {
    padding: 16px 14px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-align: center;
  }
  .msg-empty  { color: var(--muted); }
  .msg-closed { color: var(--red-dim); }
  .msg-reconnecting {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--red);
    border-top: 1px solid rgba(229, 57, 53, 0.2);
    animation: blink 1s step-start infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div id="overlay-root"></div>

<script>
(function () {
  const SECTIONS    = ${JSON.stringify(sectionMeta)};
  const initialData = ${JSON.stringify(initialData)};

  const renderers = {};
  for (const s of SECTIONS) {
    try {
      renderers[s.id] = new Function('return (' + s.render + ')')();
    } catch (e) {
      console.error('[overlay] compile error in', s.id, e);
      renderers[s.id] = () => {};
    }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const root   = document.getElementById('overlay-root');
  const cards  = {};
  const bodies = {};

  for (const s of SECTIONS) {
    const card = document.createElement('div');
    card.className = 'overlay-card';
    card.id        = 'card-' + s.id;
    card.innerHTML =
      '<div class="section-header">' +
        '<span class="section-icon">'  + s.icon          + '</span>' +
        '<span class="section-title">' + esc(s.title)    + '</span>' +
        '<span class="section-badge" id="badge-' + s.id + '"></span>' +
      '</div>' +
      '<div class="section-body" id="body-' + s.id + '"></div>';
    root.appendChild(card);
    cards[s.id]  = card;
    bodies[s.id] = card.querySelector('.section-body');
  }

  function invoke(id, data) {
    if (!renderers[id] || !bodies[id]) return;
    try {
      renderers[id](data, bodies[id], esc, {
        card:  cards[id],
        badge: document.getElementById('badge-' + id),
      });
    } catch (e) { console.error('[overlay] render error in', id, e); }
  }

  for (const s of SECTIONS) invoke(s.id, initialData[s.id]);

  const reconnEl = document.createElement('div');
  reconnEl.className     = 'msg msg-reconnecting';
  reconnEl.style.display = 'none';
  reconnEl.textContent   = '⚠ RECONNECTING…';
  root.appendChild(reconnEl);

  let es;
  function connect() {
    es = new EventSource('/sse');
    es.onopen    = () => { reconnEl.style.display = 'none'; };
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'section') invoke(msg.id, msg.data);
      } catch {}
    };
    es.onerror = () => {
      reconnEl.style.display = 'block';
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

// ── HTTP server ───────────────────────────────────────────────────────────

function startOverlayServer(port = 2999) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/overlay') {
      const html = _buildHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url === '/sse') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      for (const [id, section] of _sections) {
        res.write(`data: ${JSON.stringify({ type: 'section', id, data: section.data })}\n\n`);
      }
      _clients.add(res);
      req.on('close', () => _clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(Object.fromEntries([..._sections.entries()].map(([id, s]) => [id, s.data]))));
      return;
    }

    const m = url.match(/^\/state\/(.+)$/);
    if (req.method === 'GET' && m) {
      const s = _sections.get(m[1]);
      if (!s) { res.writeHead(404); res.end('Section not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(s.data));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    log.info(`[overlay] Listening  → ${port}`);
    log.info(`[overlay] OBS source → ${port}/overlay`);
  });
  server.on('error', (err) => log.error('[overlay] Server error:', err.message));
  return server;
}

module.exports = { startOverlayServer, registerSection, updateSection };