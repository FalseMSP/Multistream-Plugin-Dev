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
 *   GET /sfx/*            — static audio files from src/overlay/public/sfx/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

// ── Static file root ──────────────────────────────────────────────────────
// Files in src/overlay/public/ are served at their relative path.
// e.g. src/overlay/public/sfx/vine-boom.mp3 → GET /sfx/vine-boom.mp3

const PUBLIC_DIR = path.resolve(__dirname, 'overlay', 'public');

const MIME_TYPES = {
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.webm': 'audio/webm',
  '.mp4':  'video/mp4',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
};

function serveStatic(url, res) {
  // Prevent path traversal
  const rel     = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
  const absPath = path.join(PUBLIC_DIR, rel);
  if (!absPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return true;
  }

  let stat;
  try { stat = fs.statSync(absPath); } catch { return false; }
  if (!stat.isFile()) return false;

  const ext      = path.extname(absPath).toLowerCase();
  const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type':  mimeType,
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(absPath).pipe(res);
  return true;
}


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

// ── Poll overlay state ────────────────────────────────────────────────────

let _pollState = null;

function updatePollOverlay(data) {
  _pollState = data;
  _broadcast({ type: 'poll', data });
}

// ── Poll overlay HTML ─────────────────────────────────────────────────────

function _buildPollHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Poll Overlay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;900&family=JetBrains+Mono:wght@500;700&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --red:      #e53935;
    --red-glow: rgba(229, 57, 53, 0.15);
    --bg:       rgba(10, 8, 8, 0.92);
    --border:   rgba(229, 57, 53, 0.3);
    --text:     #f0e0e0;
    --muted:    #6b4040;
    --twitch:   #9147ff;
    --youtube:  #ff0000;
  }
  html, body { background: transparent; width: 420px; font-family: 'Inter', sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
  @keyframes slideIn {
    from { opacity: 0; transform: translateX(30px); }
    to   { opacity: 1; transform: translateX(0);    }
  }
  @keyframes slideOut {
    from { opacity: 1; transform: translateX(0);    }
    to   { opacity: 0; transform: translateX(30px); }
  }
  .overlay-card { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; width: 420px; opacity: 0; }
  .overlay-card.is-visible  { animation: slideIn  0.35s cubic-bezier(0.22,1,0.36,1) forwards; }
  .overlay-card.is-hiding   { animation: slideOut 0.3s  ease-in                     forwards; }
  .section-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: rgba(229, 57, 53, 0.08); }
  .section-icon { width: 22px; height: 22px; flex-shrink: 0; }
  .section-title { font-size: 13px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase; color: var(--red); }
  .section-badge { margin-left: auto; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); letter-spacing: 0.04em; }
  .poll-title { padding: 12px 14px 8px; font-size: 14px; font-weight: 700; color: var(--text); line-height: 1.3; border-bottom: 1px solid rgba(229, 57, 53, 0.12); }
  .option { padding: 8px 14px; border-bottom: 1px solid rgba(229, 57, 53, 0.08); position: relative; overflow: hidden; }
  .option:last-of-type { border-bottom: none; }
  .option-bar { position: absolute; inset: 0; background: rgba(229, 57, 53, 0.12); transition: width 0.5s ease; }
  .option.leading .option-bar { background: rgba(229, 57, 53, 0.22); border-left: 3px solid var(--red); }
  .option-row { position: relative; display: flex; align-items: center; gap: 8px; }
  .option-num { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); font-weight: 700; width: 16px; flex-shrink: 0; text-align: right; }
  .option.leading .option-num { color: var(--red); }
  .option-lbl { font-size: 13px; font-weight: 700; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .option.leading .option-lbl { color: #fff; }
  .option-pct { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted); font-weight: 700; min-width: 36px; text-align: right; }
  .option.leading .option-pct { color: var(--red); }
  .option-votes { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: rgba(107, 64, 64, 0.7); min-width: 28px; text-align: right; }
  .poll-footer { display: flex; align-items: center; justify-content: space-between; padding: 7px 14px; border-top: 1px solid rgba(229, 57, 53, 0.12); background: rgba(229, 57, 53, 0.04); }
  .footer-total { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); }
  .footer-platforms { display: flex; gap: 6px; align-items: center; }
  .platform-dot { width: 6px; height: 6px; border-radius: 50%; }
  .platform-dot.twitch  { background: var(--twitch); }
  .platform-dot.youtube { background: var(--youtube); }
  .platform-label { font-size: 10px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
  .footer-timer { display: flex; align-items: center; gap: 5px; }
  .timer-bar-track { width: 60px; height: 3px; background: rgba(229, 57, 53, 0.12); border-radius: 2px; overflow: hidden; }
  .timer-bar-fill { height: 100%; background: var(--red); border-radius: 2px; transition: width 1s linear; }
  .timer-text { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); min-width: 32px; }
  .msg-reconnecting { padding: 6px 14px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--red); border-top: 1px solid rgba(229, 57, 53, 0.2); display: none; animation: blink 1s step-start infinite; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div class="overlay-card" id="card" class="${_pollState ? 'is-visible' : ''}">
  <div class="section-header">
    <span class="section-icon">
      <svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="5" width="5" height="13" rx="1" fill="#e53935" opacity="0.5"/>
        <rect x="9" y="9" width="5" height="9" rx="1" fill="#e53935" opacity="0.75"/>
        <rect x="16" y="3" width="5" height="15" rx="1" fill="#e53935"/>
      </svg>
    </span>
    <span class="section-title" id="header-label">Poll</span>
    <span class="section-badge" id="header-badge"></span>
  </div>
  <div id="content"></div>
  <div class="msg-reconnecting" id="reconnect-msg">⚠ RECONNECTING…</div>
</div>

<script>
(function () {
  const initialData = ${JSON.stringify(_pollState)};
  const card        = document.getElementById('card');
  const content     = document.getElementById('content');
  const headerLabel = document.getElementById('header-label');
  const headerBadge = document.getElementById('header-badge');
  const reconnectMsg = document.getElementById('reconnect-msg');
  let _timerInterval = null;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtTime(ms) {
    if (ms <= 0) return '0s';
    const s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function render(data) {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }

    if (!data) {
      card.classList.remove('is-visible');
      card.classList.add('is-hiding');
      setTimeout(() => {
        card.classList.remove('is-hiding');
        headerLabel.textContent = 'Poll';
        headerBadge.textContent = '';
        content.innerHTML = '';
      }, 300);
      return;
    }

    if (!card.classList.contains('is-visible')) {
      card.classList.remove('is-hiding');
      card.classList.add('is-visible');
    }
    headerLabel.textContent = data.type === 'prediction' ? 'Prediction' : 'Poll';

    const total    = Object.values((data.combinedVotes ?? data.ytVotes)).reduce((a, b) => a + b, 0) || 0;
    const hasVotes = total > 0;
    const leadIdx  = data.options.reduce((best, _, i) =>
      ((data.combinedVotes ?? data.ytVotes)[i] ?? 0) > ((data.combinedVotes ?? data.ytVotes)[best] ?? 0) ? i : best, 0);

    const optionHtml = data.options.map((opt, i) => {
      const v   = (data.combinedVotes ?? data.ytVotes)[i] ?? 0;
      const pct = hasVotes ? Math.round((v / total) * 100) : 0;
      const lead = hasVotes && i === leadIdx;
      return \`<div class="option\${lead ? ' leading' : ''}" id="opt-\${i}">
        <div class="option-bar" id="bar-\${i}" style="width:\${pct}%"></div>
        <div class="option-row">
          <span class="option-num">\${i + 1}</span>
          <span class="option-lbl">\${esc(opt)}</span>
          <span class="option-pct" id="pct-\${i}">\${pct}%</span>
          <span class="option-votes" id="votes-\${i}">\${v}</span>
        </div>
      </div>\`;
    }).join('');

    const platformsHtml = data.platforms.map(p =>
      \`<span class="platform-dot \${p}"></span><span class="platform-label">\${p}</span>\`
    ).join('');

    content.innerHTML =
      \`<div class="poll-title">\${esc(data.title)}</div>\` +
      optionHtml +
      \`<div class="poll-footer">
        <span class="footer-total" id="footer-total">\${total} vote\${total !== 1 ? 's' : ''}</span>
        <div class="footer-platforms">\${platformsHtml}</div>
        <div class="footer-timer">
          <div class="timer-bar-track"><div class="timer-bar-fill" id="timer-fill"></div></div>
          <span class="timer-text" id="timer-text"></span>
        </div>
      </div>\`;

    headerBadge.textContent = total + ' votes';

    function tick() {
      const remaining = data.ended
        ? 0
        : Math.max(0, data.durationMs - (Date.now() - data.startedAt));
      const pctLeft   = Math.round((remaining / data.durationMs) * 100);
      const tf = document.getElementById('timer-fill');
      const tt = document.getElementById('timer-text');
      if (tf) tf.style.width = pctLeft + '%';
      if (tt) tt.textContent = data.ended ? 'ended' : fmtTime(remaining);
      if (remaining === 0 && _timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    }
    tick();
    _timerInterval = setInterval(tick, 1000);
  }

  function applyVoteUpdate(data) {
    if (!data) { render(null); return; }
    if (!document.getElementById('opt-0')) { render(data); return; }

    const total    = Object.values((data.combinedVotes ?? data.ytVotes)).reduce((a, b) => a + b, 0) || 0;
    const hasVotes = total > 0;
    const leadIdx  = data.options.reduce((best, _, i) =>
      ((data.combinedVotes ?? data.ytVotes)[i] ?? 0) > ((data.combinedVotes ?? data.ytVotes)[best] ?? 0) ? i : best, 0);

    data.options.forEach((_, i) => {
      const v   = (data.combinedVotes ?? data.ytVotes)[i] ?? 0;
      const pct = hasVotes ? Math.round((v / total) * 100) : 0;
      const lead = hasVotes && i === leadIdx;
      const optEl   = document.getElementById('opt-' + i);
      const barEl   = document.getElementById('bar-' + i);
      const pctEl   = document.getElementById('pct-' + i);
      const voteEl  = document.getElementById('votes-' + i);
      if (!optEl) return;
      optEl.classList.toggle('leading', lead);
      if (barEl)  barEl.style.width    = pct + '%';
      if (pctEl)  pctEl.textContent    = pct + '%';
      if (voteEl) voteEl.textContent   = v;
    });

    const ft = document.getElementById('footer-total');
    if (ft) ft.textContent = total + ' vote' + (total !== 1 ? 's' : '');
    headerBadge.textContent = total + ' votes';
  }

  render(initialData);

  let es;
  function connect() {
    es = new EventSource('/sse');
    es.onopen    = () => { reconnectMsg.style.display = 'none'; };
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'poll') return;
        if (!msg.data || !document.getElementById('opt-0')) render(msg.data);
        else applyVoteUpdate(msg.data);
      } catch {}
    };
    es.onerror = () => {
      reconnectMsg.style.display = 'block';
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

  return `<!DOCTYPE html>
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


// ── Extra route registry (plugins can add GET routes to this server) ──────

/** @type {Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>} */
const _extraRoutes = new Map();

/**
 * Register a custom GET route on the overlay server.
 * Safe to call before startOverlayServer() — routes are stored in a Map
 * and consulted at request time.
 *
 * @param {string}   path     Exact path to match, e.g. '/tnt_placing'
 * @param {Function} handler  (req, res) => void
 */
function addRoute(path, handler) {
  _extraRoutes.set(path, handler);
  log.info(`[overlay] Extra route registered: GET ${path}`);
}

// ── HTTP server ───────────────────────────────────────────────────────────

function startOverlayServer(port = 2999) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/polls') {
      const html = _buildPollHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

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
      if (_pollState !== undefined) {
        res.write(`data: ${JSON.stringify({ type: 'poll', data: _pollState })}\n\n`);
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

    // Plugin-registered extra routes
    const extraHandler = _extraRoutes.get(url);
    if (extraHandler) {
      try { extraHandler(req, res); } catch (e) {
        log.error('[overlay] Extra route error:', e.message);
        res.writeHead(500); res.end('Internal error');
      }
      return;
    }

    // ── Static files from src/overlay/public/ ─────────────────────────────
    // Serves any file under that directory at its relative URL path.
    // e.g. src/overlay/public/sfx/vine-boom.mp3 → GET /sfx/vine-boom.mp3
    if (req.method === 'GET' && serveStatic(url, res)) return;

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    log.info(`[overlay] Listening  → ${port}`);
    log.info(`[overlay] OBS source → ${port}/overlay`);
    log.info(`[overlay] Static files served from: ${PUBLIC_DIR}`);
  });
  server.on('error', (err) => log.error('[overlay] Server error:', err.message));
  return server;
}

function _getSectionMeta(id) {
  const s = _sections.get(id);
  if (!s) return null;
  return { id, title: s.title, icon: s.icon, render: s.render };
}

function _getSectionData(id) {
  return _sections.get(id)?.data ?? null;
}

module.exports = { startOverlayServer, registerSection, updateSection, updatePollOverlay, addRoute, _getSectionMeta, _getSectionData };