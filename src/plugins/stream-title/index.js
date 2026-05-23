// src/plugins/stream-title/index.js
'use strict';

const log       = require('../../logger');
const dashboard = require('../../dashboard');

// ── Lazy refs to platform modules (set by init) ───────────────────────────
let _twitch  = null;
let _youtube = null;

// ── Last known titles ─────────────────────────────────────────────────────
const _state = {
  twitch:  { title: null, status: 'idle' },   // status: idle | saving | ok | error
  youtube: { title: null, status: 'idle' },
};

// ── Dashboard widget ──────────────────────────────────────────────────────
dashboard.registerWidget('stream-title', {
  title: 'Stream Title',
  order: 5,
  icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
           <path d="M12 20h9"/>
           <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
         </svg>`,

  render: (function render(data, el, esc, { badge }) {
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px">Loading…</p>';
      badge.textContent = '';
      return;
    }

    // ── Helpers ────────────────────────────────────────────────────────────
    function statusColor(s) {
      if (s === 'saving') return 'var(--muted)';
      if (s === 'ok')     return '#4ade80';
      if (s === 'error')  return '#f87171';
      return 'var(--muted)';
    }
    function statusLabel(s) {
      if (s === 'saving') return '…';
      if (s === 'ok')     return '✓';
      if (s === 'error')  return '✗';
      return '';
    }

    // ── Section builder ────────────────────────────────────────────────────
    function section(platform, label, color, iconPath) {
      const st     = data[platform] ?? { title: null, status: 'idle' };
      const current = st.title ?? '';
      const sLabel  = statusLabel(st.status);
      const sColor  = statusColor(st.status);

      return (
        '<div style="margin-bottom:14px">' +
          '<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
              iconPath +
            '</svg>' +
            '<span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' + color + '">' + label + '</span>' +
            (sLabel ? '<span style="margin-left:auto;font-size:11px;font-family:var(--mono);color:' + sColor + '">' + sLabel + '</span>' : '') +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center">' +
            '<input id="title-input-' + platform + '"' +
              ' type="text"' +
              ' value="' + esc(current) + '"' +
              ' placeholder="Enter ' + label + ' title…"' +
              ' style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:4px;' +
                      'color:var(--text);font-size:12px;padding:6px 8px;outline:none;font-family:inherit"' +
              ' data-platform="' + platform + '"' +
            '/>' +
            '<button id="title-btn-' + platform + '"' +
              ' data-action="set-title"' +
              ' data-platform="' + platform + '"' +
              ' style="flex-shrink:0;padding:6px 10px;background:var(--accent);color:#fff;border:none;' +
                      'border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:0.04em;' +
                      'font-family:inherit;transition:opacity 0.15s"' +
            '>Set</button>' +
          '</div>' +
        '</div>'
      );
    }

    el.innerHTML =
      section('twitch',  'Twitch',  '#9146FF',
        '<path d="M21 2H3v16h5v4l4-4h5l4-4V2z"/><line x1="9" y1="9" x2="9" y2="14"/><line x1="15" y1="9" x2="15" y2="14"/>') +
      section('youtube', 'YouTube', '#FF0000',
        '<path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58 2.78 2.78 0 0 0 1.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02"/>');

    // Attach button handlers
    ['twitch', 'youtube'].forEach(function(platform) {
      const btn   = document.getElementById('title-btn-' + platform);
      const input = document.getElementById('title-input-' + platform);
      if (!btn || !input) return;

      // Style input on focus
      input.addEventListener('focus', function() {
        input.style.borderColor = 'var(--accent)';
      });
      input.addEventListener('blur', function() {
        input.style.borderColor = 'var(--border)';
      });
      // Submit on Enter
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') btn.click();
      });

      btn.addEventListener('click', function() {
        const title = input.value.trim();
        if (!title) return;
        btn.disabled = true;
        btn.style.opacity = '0.4';
        fetch('/dashboard/action', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action: 'set-title', platform, title }),
        })
          .then(function(r) { return r.json(); })
          .then(function() {
            btn.disabled = false;
            btn.style.opacity = '1';
          })
          .catch(function() {
            btn.disabled = false;
            btn.style.opacity = '1';
          });
      });
    });

  }).toString(),
});

// ── Push updated state to widget ──────────────────────────────────────────
function _notify() {
  dashboard.updateWidget('stream-title', {
    twitch:  { title: _state.twitch.title,  status: _state.twitch.status  },
    youtube: { title: _state.youtube.title, status: _state.youtube.status },
  });
}

// ── Action handler registered with dashboard ──────────────────────────────
async function _handleAction(body) {
  const { platform, title } = body;

  if (!title || typeof title !== 'string') {
    return { ok: false, error: 'title is required' };
  }
  if (platform !== 'twitch' && platform !== 'youtube') {
    return { ok: false, error: `unknown platform: ${platform}` };
  }

  _state[platform].status = 'saving';
  _notify();

  try {
    if (platform === 'twitch') {
      if (!_twitch) throw new Error('Twitch module not available');
      await _twitch.updateStreamTitle(title);
    } else {
      if (!_youtube) throw new Error('YouTube module not available');
      await _youtube.updateVideoTitle(title);
    }
    _state[platform].title  = title;
    _state[platform].status = 'ok';
    log.info(`[stream-title] ${platform} title updated: "${title}"`);
    // Reset status pill after 3 s
    setTimeout(() => {
      _state[platform].status = 'idle';
      _notify();
    }, 3000);
    _notify();
    return { ok: true };
  } catch (err) {
    _state[platform].status = 'error';
    log.error(`[stream-title] Failed to update ${platform} title:`, err.message);
    // Reset after 5 s
    setTimeout(() => {
      _state[platform].status = 'idle';
      _notify();
    }, 5000);
    _notify();
    return { ok: false, error: err.message };
  }
}

// ── Plugin export ─────────────────────────────────────────────────────────
module.exports = {
  id: 'stream-title',

  init(context) {
    // Lazy-require so this plugin doesn't break if either platform is absent
    try { _twitch  = require('../../twitch');  } catch { log.warn('[stream-title] twitch module not found'); }
    try { _youtube = require('../../youtube'); } catch { log.warn('[stream-title] youtube module not found'); }

    // Register the action handler with the dashboard
    dashboard.registerAction('set-title', _handleAction);

    // Seed widget with empty state so the card renders immediately
    _notify();
  },

  async processMessage(msg) {
    return { message: msg };
  },
};