'use strict';

/**
 * chat-overlay plugin
 *
 * Serves two transparent OBS browser-source overlays:
 *   http://localhost:<OVERLAY_PORT>/ip/yt_chat      — YouTube chat
 *   http://localhost:<OVERLAY_PORT>/ip/twitch_chat  — Twitch chat
 *
 * Messages scroll upward, newest at the bottom.
 * Each platform has its own colour scheme and badge.
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

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  youtube: /** @type {ChatMessage[]} */ ([]),
  twitch:  /** @type {ChatMessage[]} */ ([]),
};

/** @typedef {{ id: number, username: string, message: string, color: string }} ChatMessage */

let msgId = 0;

/**
 * @param {'youtube'|'twitch'} platform
 * @param {string} username
 * @param {string} message
 * @param {string} [color]
 */
function pushMessage(platform, username, message, color) {
  const list = state[platform];
  list.push({ id: ++msgId, username, message, color: color ?? '' });
  if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
  updateSection(`chat-overlay-${platform}`, { messages: list });
}

// ─── Overlay sections (dashboard only — the real overlay is the HTML routes) ──

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

// ─── Shared HTML builder ──────────────────────────────────────────────────────

/**
 * @param {'youtube'|'twitch'} platform
 */
function buildPage(platform) {
  const isYT      = platform === 'youtube';
  const accentHex = isYT ? '#FF0000' : '#9146FF';
  const badgeBg   = isYT ? '#FF0000' : '#9146FF';
  const badgeLabel = isYT ? 'YT' : 'TW';
  const sseId     = `chat-overlay-${platform}`;

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${isYT ? 'YouTube' : 'Twitch'} Chat Overlay</title>
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

  /* ── individual message row ── */
  .msg {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    animation: fadeSlideIn 0.25s ease forwards;
    max-width: 100%;
  }

  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0);   }
  }

  /* platform badge */
  .badge {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background: ${badgeBg};
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.03em;
    margin-top: 1px;
  }

  /* bubble */
  .bubble {
    background: rgba(0, 0, 0, 0.72);
    border-left: 3px solid ${accentHex};
    border-radius: 0 6px 6px 0;
    padding: 5px 9px;
    line-height: 1.35;
    word-break: break-word;
    max-width: calc(100% - 30px);
  }

  .username {
    font-weight: 600;
    font-size: 0.78em;
    color: ${accentHex};
    margin-bottom: 2px;
    text-shadow: 0 0 8px ${accentHex}66;
  }

  .text {
    color: #f0f0f0;
    font-size: 0.97em;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
  }

  /* custom username colours applied via inline style on .username */
</style>
</head>
<body>
<div id="feed"></div>

<script>
(function () {
  var feed   = document.getElementById('feed');
  var MAX    = ${MAX_MESSAGES};
  var SSE_ID = '${sseId}';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function appendMessage(msg) {
    var row = document.createElement('div');
    row.className = 'msg';
    row.dataset.id = msg.id;

    var badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = '${badgeLabel}';

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    var nameEl = document.createElement('div');
    nameEl.className = 'username';
    if (msg.color) nameEl.style.color = msg.color;
    nameEl.textContent = msg.username;

    var textEl = document.createElement('div');
    textEl.className = 'text';
    textEl.innerHTML = esc(msg.message);

    bubble.appendChild(nameEl);
    bubble.appendChild(textEl);
    row.appendChild(badge);
    row.appendChild(bubble);
    feed.appendChild(row);

    // trim old messages
    while (feed.children.length > MAX) {
      feed.removeChild(feed.firstChild);
    }
  }

  function syncMessages(messages) {
    // Full replace (e.g. on reconnect)
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