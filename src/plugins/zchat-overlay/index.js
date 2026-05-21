'use strict';

/**
 * chat-overlay plugin
 *
 * Serves three transparent OBS browser-source overlays:
 *   http://localhost:<OVERLAY_PORT>/yt_chat      — YouTube chat
 *   http://localhost:<OVERLAY_PORT>/twitch_chat  — Twitch chat
 *   http://localhost:<OVERLAY_PORT>/combined     — Both platforms interleaved
 *
 * Messages scroll upward, newest at the bottom.
 * Each platform has its own accent colour; combined shows both with per-platform colouring.
 *
 * Env vars (all optional):
 *   CHAT_OVERLAY_MAX_MESSAGES   — max messages kept on screen (default: 30)
 *   CHAT_OVERLAY_FONT_SIZE      — base font size in px (default: 16)
 *   CHAT_OVERLAY_WIDTH          — widget width in px   (default: 420)
 */

const { addRoute, registerSection, updateSection } = require('../../overlay-server');
const queue = require('../../queue');
const log   = require('../../logger');

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_MESSAGES = parseInt(process.env.CHAT_OVERLAY_MAX_MESSAGES ?? '30', 10);
const FONT_SIZE    = parseInt(process.env.CHAT_OVERLAY_FONT_SIZE    ?? '16', 10);
const WIDTH        = parseInt(process.env.CHAT_OVERLAY_WIDTH        ?? '420', 10);

const ACCENT = { youtube: '#FF0000', twitch: '#9146FF' };

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  youtube:  /** @type {ChatMessage[]} */ ([]),
  twitch:   /** @type {ChatMessage[]} */ ([]),
  combined: /** @type {ChatMessage[]} */ ([]),
};

/** @typedef {{ id: number, platform: string, username: string, message: string, color: string }} ChatMessage */

let msgId = 0;

/**
 * @param {'youtube'|'twitch'} platform
 * @param {string} username
 * @param {string} message
 * @param {string} [color]
 */
function pushMessage(platform, username, message, color) {
  const entry = { id: ++msgId, platform, username, message, color: color ?? '' };

  const list = state[platform];
  list.push(entry);
  if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  updateSection(`chat-overlay-${platform}`, { messages: list });

  state.combined.push(entry);
  if (state.combined.length > MAX_MESSAGES) state.combined.splice(0, state.combined.length - MAX_MESSAGES);
  updateSection('chat-overlay-combined', { messages: state.combined });
}

// ─── Overlay sections (dashboard only) ───────────────────────────────────────

for (const platform of ['youtube', 'twitch']) {
  const isYT = platform === 'youtube';
  registerSection(`chat-overlay-${platform}`, {
    title: isYT ? 'YouTube Chat' : 'Twitch Chat',
    order: isYT ? 10 : 11,
    icon: isYT
      ? `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
           <rect width="22" height="22" rx="5" fill="#FF0000"/>
           <polygon points="9,7 16,11 9,15" fill="#fff"/>
         </svg>`
      : `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
           <rect width="22" height="22" rx="5" fill="#9146FF"/>
           <rect x="6" y="5" width="10" height="8" rx="1" fill="#fff"/>
           <rect x="8" y="15" width="3" height="2" fill="#fff"/>
           <rect x="11" y="15" width="3" height="2" fill="#fff"/>
         </svg>`,
    render: (function render(data, el, esc, { badge }) {
      const count = data?.messages?.length ?? 0;
      badge.textContent = count + ' msgs';
      el.style.cssText = 'padding:8px 12px;font-family:monospace;font-size:13px;max-height:160px;overflow:hidden';
      if (!count) { el.textContent = 'No messages yet.'; return; }
      el.innerHTML = data.messages.slice(-5).map(m =>
        '<div><b>' + esc(m.username) + ':</b> ' + esc(m.message) + '</div>'
      ).join('');
    }).toString(),
  });
  updateSection(`chat-overlay-${platform}`, { messages: [] });
}

registerSection('chat-overlay-combined', {
  title: 'Combined Chat',
  order: 12,
  icon: `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
    <rect width="22" height="22" rx="5" fill="#333"/>
    <rect x="3" y="3" width="7" height="7" rx="1" fill="#FF0000"/>
    <rect x="12" y="3" width="7" height="7" rx="1" fill="#9146FF"/>
    <rect x="3" y="12" width="16" height="2" rx="1" fill="#fff" opacity="0.5"/>
    <rect x="3" y="16" width="10" height="2" rx="1" fill="#fff" opacity="0.3"/>
  </svg>`,
  render: (function render(data, el, esc, { badge }) {
    const count = data?.messages?.length ?? 0;
    badge.textContent = count + ' msgs';
    el.style.cssText = 'padding:8px 12px;font-family:monospace;font-size:13px;max-height:160px;overflow:hidden';
    if (!count) { el.textContent = 'No messages yet.'; return; }
    el.innerHTML = data.messages.slice(-5).map(m =>
      '<div><b>' + esc(m.username) + '</b> [' + esc(m.platform) + ']: ' + esc(m.message) + '</div>'
    ).join('');
  }).toString(),
});
updateSection('chat-overlay-combined', { messages: [] });

// ─── HTML builder ─────────────────────────────────────────────────────────────

/**
 * Build the overlay page HTML.
 * @param {'youtube'|'twitch'|'combined'} mode
 */
function buildPage(mode) {
  const isCombined = mode === 'combined';
  const title      = isCombined ? 'Combined Chat Overlay' : (mode === 'youtube' ? 'YouTube' : 'Twitch') + ' Chat Overlay';
  // For single-platform pages the accent is fixed; for combined it's overridden per-message in JS.
  const accentHex  = isCombined ? '#ffffff' : ACCENT[mode];
  const sseId      = isCombined ? 'chat-overlay-combined' : `chat-overlay-${mode}`;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    background: transparent;
    width: ${WIDTH}px;
    overflow: hidden;
    font-family: 'Inter', sans-serif;
    font-size: ${FONT_SIZE}px;
  }

  #feed {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 5px;
    padding: 8px;
    width: 100%;
  }

  .msg {
    display: flex;
    align-items: baseline;
    gap: 5px;
    animation: fadeSlideIn 0.25s ease forwards;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
  }

  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0);   }
  }

  .username {
    flex-shrink: 0;
    font-weight: 700;
    font-size: 1em;
    color: ${accentHex};
    text-shadow: 0 0 8px ${accentHex}88, 0 1px 3px rgba(0,0,0,0.9);
  }

  .separator {
    flex-shrink: 0;
    color: rgba(255,255,255,0.4);
    font-size: 1em;
  }

  .text {
    color: #f0f0f0;
    font-size: 1em;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
</head>
<body>
<div id="feed"></div>

<script>
(function () {
  var feed      = document.getElementById('feed');
  var MAX       = ${MAX_MESSAGES};
  var SSE_ID    = '${sseId}';
  var COMBINED  = ${isCombined};
  var ACCENTS   = { youtube: '#FF0000', twitch: '#9146FF' };

  function appendMessage(msg) {
    var row = document.createElement('div');
    row.className = 'msg';
    row.dataset.id = msg.id;

    var nameEl = document.createElement('span');
    nameEl.className = 'username';
    // Per-user Twitch colour takes priority; fall back to platform accent for combined
    var nameColor = msg.color || (COMBINED ? (ACCENTS[msg.platform] || '#ffffff') : null);
    if (nameColor) {
      nameEl.style.color = nameColor;
      nameEl.style.textShadow = '0 0 8px ' + nameColor + '88, 0 1px 3px rgba(0,0,0,0.9)';
    }
    nameEl.textContent = msg.username;

    var sep = document.createElement('span');
    sep.className = 'separator';
    sep.textContent = ':';

    var textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = msg.message;

    row.appendChild(nameEl);
    row.appendChild(sep);
    row.appendChild(textEl);
    feed.appendChild(row);

    while (feed.children.length > MAX) {
      feed.removeChild(feed.firstChild);
    }
  }

  function syncMessages(messages) {
    feed.innerHTML = '';
    messages.forEach(appendMessage);
  }

  function connect() {
    var es = new EventSource('/sse');
    es.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'section' && msg.id === SSE_ID && msg.data) {
          syncMessages(msg.data.messages ?? []);
        }
      } catch (_) {}
    };
    es.onerror = function () { es.close(); setTimeout(connect, 2000); };
  }

  connect();
})();
</script>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

addRoute('/yt_chat', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(buildPage('youtube'));
});

addRoute('/twitch_chat', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(buildPage('twitch'));
});

addRoute('/combined', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(buildPage('combined'));
});

// ─── Plugin entry point ───────────────────────────────────────────────────────

function init(_context) {
  if (!queue?.onMessage) {
    log.warn('[chat-overlay] queue.onMessage not available — chat messages will not appear.');
    return;
  }

  queue.onMessage(msg => {
    const { platform, username, message, color } = msg ?? {};
    if (!message || !username) return;

    if (platform === 'youtube') {
      pushMessage('youtube', username, message, color);
      return;
    }
    if (platform === 'twitch') {
      pushMessage('twitch', username, message, color);
    }
  });
}

module.exports = {
  id: 'chat-overlay',
  init,
  async processMessage(msg) { return { message: msg }; },
};