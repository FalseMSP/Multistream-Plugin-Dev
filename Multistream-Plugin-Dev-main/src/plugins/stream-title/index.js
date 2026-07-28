// src/plugins/stream-title/index.js
'use strict';

const log       = require('../../logger');
const dashboard = require('../../dashboard');

// ── Lazy refs to platform modules (set by init) ───────────────────────────
let _twitch  = null;
let _youtube = null;

// ── Last known state ──────────────────────────────────────────────────────
const _state = {
  twitch:  { title: null, category: null, tags: null, status: 'idle' },
  youtube: { title: null, tags: null, categoryId: null, status: 'idle' },
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

    function statusColor(s) {
      if (s === 'saving') return 'var(--muted)';
      if (s === 'ok')     return '#4ade80';
      if (s === 'error')  return '#f87171';
      return 'transparent';
    }
    function statusLabel(s) {
      if (s === 'saving') return '…';
      if (s === 'ok')     return '✓';
      if (s === 'error')  return '✗';
      return '';
    }

    var INPUT_STYLE =
      'width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;' +
      'color:var(--text);font-size:12px;padding:5px 8px;outline:none;font-family:inherit;' +
      'box-sizing:border-box;';

    var LABEL_STYLE =
      'font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;' +
      'color:var(--muted);display:block;margin-bottom:3px;';

    function platformSection(platform, label, color, iconPath) {
      var st   = data[platform] || { title: '', tags: '', status: 'idle' };
      var tags = Array.isArray(st.tags) ? st.tags.join(', ') : (st.tags || '');

      var extraFields = '';
      if (platform === 'twitch') {
        extraFields =
          '<div style="display:flex;gap:8px;margin-top:6px">' +
            '<div style="flex:1">' +
              '<label style="' + LABEL_STYLE + '">Category / Game</label>' +
              '<input id="st-category-twitch" type="text" value="' + esc(st.category || '') + '" ' +
                'placeholder="e.g. Just Chatting" style="' + INPUT_STYLE + '" />' +
            '</div>' +
            '<div style="flex:1">' +
              '<label style="' + LABEL_STYLE + '">Tags <span style="font-weight:400;text-transform:none;letter-spacing:0">(comma-separated)</span></label>' +
              '<input id="st-tags-twitch" type="text" value="' + esc(tags) + '" ' +
                'placeholder="e.g. English, FPS" style="' + INPUT_STYLE + '" />' +
            '</div>' +
          '</div>';
      } else {
        extraFields =
          '<div style="display:flex;gap:8px;margin-top:6px">' +
            '<div style="flex:0 0 90px">' +
              '<label style="' + LABEL_STYLE + '">Category ID</label>' +
              '<input id="st-category-youtube" type="text" value="' + esc(st.categoryId || '') + '" ' +
                'placeholder="e.g. 20" style="' + INPUT_STYLE + '" />' +
            '</div>' +
            '<div style="flex:1">' +
              '<label style="' + LABEL_STYLE + '">Tags <span style="font-weight:400;text-transform:none;letter-spacing:0">(comma-separated)</span></label>' +
              '<input id="st-tags-youtube" type="text" value="' + esc(tags) + '" ' +
                'placeholder="e.g. gaming, live" style="' + INPUT_STYLE + '" />' +
            '</div>' +
          '</div>';
      }

      var sLabel = statusLabel(st.status);
      var sColor = statusColor(st.status);

      return (
        '<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)">' +
          // Platform header
          '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="' + color + '" ' +
              'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
              iconPath +
            '</svg>' +
            '<span style="font-size:11px;font-weight:700;letter-spacing:0.08em;' +
              'text-transform:uppercase;color:' + color + '">' + label + '</span>' +
            (sLabel
              ? '<span style="margin-left:auto;font-size:11px;font-family:var(--mono);' +
                  'color:' + sColor + '">' + sLabel + '</span>'
              : '') +
          '</div>' +
          // Title row
          '<label style="' + LABEL_STYLE + '">Title</label>' +
          '<input id="st-title-' + platform + '" type="text" ' +
            'value="' + esc(st.title || '') + '" ' +
            'placeholder="Stream title…" ' +
            'style="' + INPUT_STYLE + '" />' +
          // Category + tags
          extraFields +
          // Submit button
          '<div style="display:flex;justify-content:flex-end;margin-top:8px">' +
            '<button id="st-btn-' + platform + '" data-platform="' + platform + '" ' +
              'style="padding:5px 14px;background:var(--accent);color:#fff;border:none;' +
                'border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;' +
                'letter-spacing:0.04em;font-family:inherit;transition:opacity 0.15s">' +
              'Apply' +
            '</button>' +
          '</div>' +
        '</div>'
      );
    }

    el.innerHTML =
      platformSection('twitch',  'Twitch',  '#9146FF',
        '<path d="M21 2H3v16h5v4l4-4h5l4-4V2z"/>' +
        '<line x1="9" y1="9" x2="9" y2="14"/><line x1="15" y1="9" x2="15" y2="14"/>') +
      platformSection('youtube', 'YouTube', '#FF0000',
        '<path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46' +
        'A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58 2.78 2.78 0 0 0 ' +
        '1.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 ' +
        '0 23 12a29 29 0 0 0-.46-5.58z"/>' +
        '<polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02"/>');

    // ── Wire up inputs and buttons ─────────────────────────────────────────
    ['twitch', 'youtube'].forEach(function(platform) {
      var btn      = document.getElementById('st-btn-' + platform);
      var titleEl  = document.getElementById('st-title-' + platform);
      var tagsEl   = document.getElementById('st-tags-' + platform);
      var catEl    = document.getElementById('st-category-' + platform);
      if (!btn) return;

      // Focus highlight on all inputs in this section
      [titleEl, tagsEl, catEl].forEach(function(inp) {
        if (!inp) return;
        inp.addEventListener('focus',  function() { inp.style.borderColor = 'var(--accent)'; });
        inp.addEventListener('blur',   function() { inp.style.borderColor = 'var(--border)'; });
        inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') btn.click(); });
      });

      btn.addEventListener('mouseover', function() { btn.style.opacity = '0.85'; });
      btn.addEventListener('mouseout',  function() { btn.style.opacity = '1'; });

      btn.addEventListener('click', function() {
        var title = titleEl ? titleEl.value.trim() : '';
        var tags  = tagsEl  ? tagsEl.value.trim()  : '';
        var cat   = catEl   ? catEl.value.trim()   : '';

        btn.disabled = true;
        btn.style.opacity = '0.4';

        var body = { action: 'set-stream-info', platform: platform };
        if (title) body.title = title;
        if (tags)  body.tags  = tags.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
        if (cat) {
          if (platform === 'twitch')  body.category   = cat;
          if (platform === 'youtube') body.categoryId = cat;
        }

        fetch('/dashboard/action', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        })
          .then(function(r) { return r.json(); })
          .finally(function() {
            btn.disabled = false;
            btn.style.opacity = '1';
          });
      });
    });

  }).toString(),
});

// ── Push state to widget ──────────────────────────────────────────────────
function _notify() {
  dashboard.updateWidget('stream-title', {
    twitch:  { ..._state.twitch  },
    youtube: { ..._state.youtube },
  });
}

// ── Action handler ────────────────────────────────────────────────────────
async function _handleAction(body) {
  const { platform, title, tags, category, categoryId } = body;

  if (platform !== 'twitch' && platform !== 'youtube') {
    return { ok: false, error: `unknown platform: ${platform}` };
  }

  _state[platform].status = 'saving';
  _notify();

  try {
    if (platform === 'twitch') {
      if (!_twitch) throw new Error('Twitch module not available');
      await _twitch.updateStreamInfo({ title, tags, category });
      if (title)    _state.twitch.title    = title;
      if (tags)     _state.twitch.tags     = tags;
      if (category) _state.twitch.category = category;

    } else {
      if (!_youtube) throw new Error('YouTube module not available');
      await _youtube.updateVideoInfo({ title, tags, categoryId });
      if (title)      _state.youtube.title      = title;
      if (tags)       _state.youtube.tags       = tags;
      if (categoryId) _state.youtube.categoryId = categoryId;
    }

    _state[platform].status = 'ok';
    log.info(`[stream-title] ${platform} info updated`);
    setTimeout(() => { _state[platform].status = 'idle'; _notify(); }, 3000);
    _notify();
    return { ok: true };

  } catch (err) {
    _state[platform].status = 'error';
    log.error(`[stream-title] Failed to update ${platform} info:`, err.message);
    setTimeout(() => { _state[platform].status = 'idle'; _notify(); }, 5000);
    _notify();
    return { ok: false, error: err.message };
  }
}

// ── Plugin export ─────────────────────────────────────────────────────────
module.exports = {
  id: 'stream-title',

  init(context) {
    // Use the twitch + youtube modules provided via the documented init
    // contract instead of lazy-requiring them. This both removes a hidden
    // circular-dependency risk and makes the dependency explicit.
    _twitch  = context.twitch  ?? null;
    _youtube = context.youtube ?? null;
    if (!_twitch)  log.warn('[stream-title] twitch module not in init context');
    if (!_youtube) log.warn('[stream-title] youtube module not in init context');

    dashboard.registerAction('set-stream-info', _handleAction);
    _notify();
  },

  async processMessage(msg) {
    return { message: msg };
  },
};