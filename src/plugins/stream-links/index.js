'use strict';

/**
 * stream-links plugin
 * ───────────────────
 * Dashboard widget that shows all active stream links (YouTube video IDs +
 * Twitch channel) with an × button to disable each one.
 *
 * ── Prerequisites ────────────────────────────────────────────────────────────
 *
 * Add the following export to youtube.js so this plugin can stop sessions:
 *
 *   stopSession(videoId) {
 *     const session = _activeSessions.get(videoId);
 *     if (!session) return false;
 *     session.stopSignal.stopped = true;
 *     if (session.likePollerTimer) clearInterval(session.likePollerTimer);
 *     _activeSessions.delete(videoId);
 *     return true;
 *   },
 *
 * ── Env vars ─────────────────────────────────────────────────────────────────
 *
 *   TWITCH_CHANNEL  — Twitch channel name (set automatically by the Twitch
 *                     module; read here for display purposes)
 *   YT_CHANNEL_ID   — YouTube channel ID (used to build the channel link)
 *
 * Place this file at:  src/plugins/stream-links/index.js
 */

const log       = require('../../logger');
const dashboard = require('../../dashboard');

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * streams: Map<id, { platform, label, url, addedAt }>
 *   id       — unique key: 'twitch' | 'yt:<videoId>'
 *   platform — 'twitch' | 'youtube'
 *   label    — display string shown in the widget
 *   url      — full link to the stream
 *   addedAt  — ISO timestamp when this entry was first seen
 */
const _streams = new Map();

// Track which YouTube video IDs we've already registered (to avoid duplication)
const _seenVideoIds = new Set();

// Whether Twitch has been registered (we add it once on chatReady)
let _twitchRegistered = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _notify() {
  const list = [..._streams.values()].map(s => ({ ...s }));
  dashboard.updateWidget('stream-links', { streams: list });
}

function _addStream(id, platform, label, url) {
  if (_streams.has(id)) return; // already tracked
  _streams.set(id, { id, platform, label, url, addedAt: new Date().toISOString() });
  log.info(`[stream-links] Added: ${platform} — ${label}`);
  _notify();
}

function _removeStream(id) {
  if (!_streams.has(id)) return false;
  _streams.delete(id);
  log.info(`[stream-links] Removed: ${id}`);
  _notify();
  return true;
}

// ── Dashboard widget ──────────────────────────────────────────────────────────

dashboard.registerWidget('stream-links', {
  title: 'Stream Links',
  order: 5,
  icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
           <path d="M15 10l4.553-2.277A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14"/>
           <rect x="2" y="6" width="13" height="12" rx="2"/>
         </svg>`,

  render: (function render(data, el, esc, { badge }) {
    if (!data || !data.streams || data.streams.length === 0) {
      el.innerHTML =
        '<p style="color:var(--muted);font-size:12px;font-family:var(--mono);padding:4px 0">' +
        'No active streams</p>';
      badge.textContent = '';
      return;
    }

    badge.textContent = data.streams.length + ' live';

    const platformColors = { twitch: '#9146ff', youtube: '#ff0000' };
    const platformIcons  = {
      twitch:  'T',
      youtube: 'YT',
    };

    el.innerHTML = data.streams.map(s => {
      const color = platformColors[s.platform] || 'var(--accent)';
      const icon  = platformIcons[s.platform]  || '?';

      return (
        '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;' +
          'border-bottom:1px solid var(--border)">' +

          // Platform pill
          '<span style="font-size:10px;font-weight:700;font-family:var(--mono);' +
            'background:' + color + '22;color:' + color + ';' +
            'border:1px solid ' + color + '55;border-radius:4px;' +
            'padding:1px 5px;flex-shrink:0">' +
            esc(icon) +
          '</span>' +

          // Link
          '<a href="' + esc(s.url) + '" target="_blank" ' +
            'style="flex:1;min-width:0;font-size:12px;color:var(--text);' +
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
              'text-decoration:none" ' +
            'onmouseover="this.style.color=\'var(--accent)\'" ' +
            'onmouseout="this.style.color=\'var(--text)\'">' +
            esc(s.label) +
          '</a>' +

          // Added-at timestamp
          '<span style="font-size:10px;color:var(--muted);font-family:var(--mono);' +
            'flex-shrink:0">' +
            esc(new Date(s.addedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) +
          '</span>' +

          // Disable (×) button
          '<button ' +
            'onclick="(function(btn){' +
              'btn.disabled=true;btn.textContent=\'…\';' +
              'fetch(\'/dashboard/action\',{' +
                'method:\'POST\',' +
                'headers:{\'Content-Type\':\'application/json\'},' +
                'body:JSON.stringify({action:\'stream-links:disable\',id:\'' + esc(s.id) + '\'})' +
              '}).then(r=>r.json()).then(d=>{' +
                'if(!d.ok){btn.textContent=\'×\';btn.disabled=false;console.error(d.error);}' +
              '}).catch(()=>{btn.textContent=\'×\';btn.disabled=false;})' +
            '})(this)" ' +
            'title="Disable this stream" ' +
            'style="background:transparent;border:1px solid var(--border);' +
              'color:var(--muted);border-radius:4px;cursor:pointer;' +
              'font-size:12px;padding:1px 6px;flex-shrink:0;' +
              'transition:color .15s,border-color .15s" ' +
            'onmouseover="this.style.color=\'#e55\';this.style.borderColor=\'#e55\'" ' +
            'onmouseout="this.style.color=\'var(--muted)\';this.style.borderColor=\'var(--border)\'">' +
            '×' +
          '</button>' +
        '</div>'
      );
    }).join('');
  }).toString(),
});

// ── Dashboard action handler ───────────────────────────────────────────────────

dashboard.registerAction('stream-links:disable', async (body) => {
  const { id } = body;
  if (!id) return { ok: false, error: 'Missing stream id' };

  const stream = _streams.get(id);
  if (!stream) return { ok: false, error: `Stream not found: ${id}` };

  if (stream.platform === 'youtube') {
    const videoId = id.replace(/^yt:/, '');
    try {
      const youtube = require('../../youtube');
      if (typeof youtube.stopSession === 'function') {
        const stopped = youtube.stopSession(videoId);
        if (!stopped) {
          log.warn(`[stream-links] youtube.stopSession(${videoId}) returned false — session may already be gone`);
        }
      } else {
        // Fallback: youtube.js doesn't yet export stopSession.
        // We still remove it from our widget so the operator knows we tried.
        log.warn('[stream-links] youtube.stopSession not available — add it to youtube.js exports. Removing from widget only.');
      }
    } catch (err) {
      log.error(`[stream-links] Failed to stop YouTube session ${videoId}:`, err.message);
      return { ok: false, error: err.message };
    }

    _seenVideoIds.delete(videoId);
  }

  if (stream.platform === 'twitch') {
    _twitchRegistered = false;
    // Twitch disconnect: no public API in this codebase to stop the IRC client,
    // so we just remove the entry from the widget. Log a clear note.
    log.warn('[stream-links] Twitch stream removed from widget. To fully disconnect Twitch, restart the bot without TWITCH_CHANNEL set.');
  }

  _removeStream(id);
  return { ok: true };
});

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

/**
 * init — seed Twitch entry from env if configured.
 * YouTube entries are picked up lazily via processMessage.
 */
function init(context) {
  const twitchChannel = process.env.TWITCH_CHANNEL;
  if (twitchChannel && !_twitchRegistered) {
    _twitchRegistered = true;
    _addStream(
      'twitch',
      'twitch',
      `twitch.tv/${twitchChannel}`,
      `https://www.twitch.tv/${twitchChannel}`,
    );
  }
}

/**
 * onChatReady — re-check Twitch in case TWITCH_CHANNEL wasn't readable at init.
 */
function onChatReady(chatReply) {
  const twitchChannel = process.env.TWITCH_CHANNEL;
  if (twitchChannel && !_twitchRegistered) {
    _twitchRegistered = true;
    _addStream(
      'twitch',
      'twitch',
      `twitch.tv/${twitchChannel}`,
      `https://www.twitch.tv/${twitchChannel}`,
    );
  }
}

/**
 * processMessage — detect YouTube video IDs from messages and register them.
 * YouTube messages carry a `videoId` field set by the YouTube module.
 */
async function processMessage(msg) {
  if (msg.platform === 'youtube' && msg.videoId && !_seenVideoIds.has(msg.videoId)) {
    _seenVideoIds.add(msg.videoId);
    _addStream(
      `yt:${msg.videoId}`,
      'youtube',
      `youtu.be/${msg.videoId}`,
      `https://www.youtube.com/watch?v=${msg.videoId}`,
    );
  }
  return { message: msg };
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  id: 'stream-links',
  init,
  onChatReady,
  processMessage,
};