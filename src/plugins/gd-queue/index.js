'use strict';

/**
 * Plugin: gd-queue
 * ────────────────
 * Geometry Dash level request queue.
 *
 * Chat commands (Twitch + YouTube):
 *   !q <levelId> [notes]  — add a level to the queue (numbers only)
 *                           optional notes appended after the ID
 *                           if the user already has a level in the queue,
 *                           their previous entry is replaced with the new one
 *   !queue <levelId> [notes] — alias for !q
 *   !q                    — show the current queue (alias for /queue list)
 *   !ql                   — bot replies with the current queue length in that chat
 *   !p                    — show your own position in the queue
 *
 * Discord slash commands:
 *   /next          — dequeue and display the next level ID
 *   /queue list    — show all levels currently in the queue
 *   /queue clear   — empty the entire queue
 *   /queue remove <user> — remove a specific user's entry
 *   /queue toggle  — enable or disable the queue plugin
 *
 * Dashboard widgets:
 *   gd-queue          — shows the queue list (the next level is highlighted)
 *   gd-level-preview  — fetches & displays metadata for the next level in
 *                       the queue from gdbrowser.com API. Shows level name,
 *                       description, author, song, difficulty, downloads,
 *                       likes, object count — enough info to screen for NSFW
 *                       content before playing the level.
 *                       Has "Copy & Play" (copies ID + dequeues) and
 *                       "Skip" (dequeues without copying) buttons.
 *
 * All chat commands are suppressed from #stream-chat (they're bot triggers,
 * not conversation).
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');
const { registerSection, updateSection, addRoute, buildStandaloneSectionPage } = require('../../overlay-server');
const dashboard = require('../../dashboard');

// ── State ─────────────────────────────────────────────────────────────────
// Queue entries: Array<{ username, platform, levelId, notes, addedAt }>
// Ordered by insertion time. One entry per username (case-insensitive).

const _queue = [];
let _enabled = true;

const CMD_ADD      = /^!(?:q|queue|r|request)\s+(\S+)(?:\s+(.+))?\s*$/i;
const CMD_LIST     = /^!q\s*$/i;
const CMD_LENGTH   = /^!ql\s*$/i;
const CMD_POS      = /^!p\s*$/i;

// Injected by onChatReady()
let _chatReply = { twitch: null, youtube: null };

// ─── GD Level Preview API ──────────────────────────────────────────────────
//
// Uses gdbrowser.com's public API — it proxies the official GD servers and
// returns clean JSON instead of the raw pipe-delimited GD format.
//   GET https://gdbrowser.com/api/level/<levelId>
//   → JSON with name, description, author, difficulty, song, stats
//   → "-1" if level not found
//
// The GD servers (boomling.com) redirect to a survey page now, so the
// raw endpoint is unusable. gdbrowser.com is the de facto community API.

const GD_BROWSER_API = 'https://gdbrowser.com/api/level/';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** @type {Map<string, { data: object, fetchedAt: number }>} */
const _levelInfoCache = new Map();

/** Tracks the levelId currently being fetched, to prevent duplicate requests */
let _fetchingLevelId = null;

/**
 * Fetch level info from gdbrowser.com, with a 5-minute cache.
 * Returns { ...levelFields } on success, or { error: string } on failure.
 *
 * @param {string|number} levelId
 * @returns {Promise<object>}
 */
async function _fetchLevelInfo(levelId) {
  const idStr = String(levelId);

  // Only numeric IDs can be looked up — non-numeric IDs are user typos
  // or YouTube-style IDs that the GD API doesn't understand.
  if (!/^\d+$/.test(idStr)) {
    return { error: 'Level ID must be numeric to fetch preview' };
  }

  // Cache hit?
  const cached = _levelInfoCache.get(idStr);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  // Prevent duplicate concurrent fetches for the same level
  if (_fetchingLevelId === idStr) return null;
  _fetchingLevelId = idStr;

  try {
    // Prefer native fetch (Node 18+), fall back to node-fetch for older Node
    // or environments where native fetch is disabled. The rest of the
    // codebase uses node-fetch via dynamic import, so we try that second.
    let fetch;
    if (typeof globalThis.fetch === 'function') {
      fetch = globalThis.fetch;
    } else {
      ({ default: fetch } = await import('node-fetch'));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(GD_BROWSER_API + idStr, {
      signal: controller.signal,
      headers: { 'User-Agent': 'chat-mirror-gd-queue' },
    });
    clearTimeout(timeout);

    // gdbrowser.com returns HTTP 500 with body "-1" for some non-existent
    // levels, and HTTP 200 with body "-1" for others. Read the body in
    // either case and check for the "-1" sentinel.
    const text = await response.text();
    if (text === '-1' || !text.trim()) {
      const notFound = { error: 'Level not found on GD servers', levelId: idStr };
      _levelInfoCache.set(idStr, { data: notFound, fetchedAt: Date.now() });
      return notFound;
    }

    // If the server returned a non-OK status with a non-"-1" body, it's
    // a genuine API error (rate limit, maintenance, etc.)
    if (!response.ok) {
      throw new Error(`GD API returned HTTP ${response.status}: ${text.substring(0, 100)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('GD API returned invalid JSON');
    }

    const data = {
      levelId:    json.id || idStr,
      name:       json.name || 'Unknown',
      description: (json.description && json.description !== '(No description provided)')
                     ? json.description : '',
      author:     json.author || 'Unknown',
      difficulty: json.difficulty || 'N/A',
      stars:      json.stars || 0,
      downloads:  json.downloads || 0,
      likes:      json.likes || 0,
      objects:    json.objects || 0,
      length:     json.length || 'Unknown',
      songName:   json.songName || '',
      songAuthor: json.songAuthor || '',
      twoPlayer:  json.twoPlayer || false,
      coins:      json.coins || 0,
      epic:       json.epic || false,
      featured:   json.featured || false,
    };

    _levelInfoCache.set(idStr, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    log.error(`[gd-queue] Failed to fetch level ${idStr}:`, err.message);
    return { error: err.message || 'Failed to fetch level info', levelId: idStr };
  } finally {
    _fetchingLevelId = null;
  }
}

// ─── Preview state ─────────────────────────────────────────────────────────

let _lastPreviewedLevelId = null;

/**
 * Update the gd-level-preview widget to reflect the current head of the queue.
 * Called from _notify() whenever the queue changes.
 *
 * - Empty queue → shows "No levels in queue"
 * - Non-numeric ID → shows error (can't fetch)
 * - Numeric ID → shows loading, then fetches metadata, then shows it
 *
 * Race-condition safe: if the queue changes while a fetch is in flight,
 * the result is discarded and _updatePreview is re-invoked.
 */
async function _updatePreview() {
  const nextEntry = _queue[0] || null;

  if (!nextEntry) {
    _lastPreviewedLevelId = null;
    dashboard.updateWidget('gd-level-preview', {
      state: 'empty',
      queueEmpty: true,
    });
    return;
  }

  // If the next level hasn't changed, the preview is already correct
  if (nextEntry.levelId === _lastPreviewedLevelId) {
    return;
  }

  _lastPreviewedLevelId = nextEntry.levelId;

  // Non-numeric IDs can't be looked up
  if (!/^\d+$/.test(String(nextEntry.levelId))) {
    dashboard.updateWidget('gd-level-preview', {
      state: 'error',
      error: 'Level ID is not numeric — cannot fetch preview',
      levelId: nextEntry.levelId,
      requestedBy: nextEntry.username,
      platform: nextEntry.platform,
      notes: nextEntry.notes,
      queueEmpty: false,
    });
    return;
  }

  // Show loading state immediately
  dashboard.updateWidget('gd-level-preview', {
    state: 'loading',
    levelId: nextEntry.levelId,
    requestedBy: nextEntry.username,
    platform: nextEntry.platform,
    notes: nextEntry.notes,
    queueEmpty: false,
  });

  // Fetch level info
  const info = await _fetchLevelInfo(nextEntry.levelId);

  // Race-condition guard: if the queue head changed during the fetch,
  // discard this result and re-update for the new head.
  const currentNext = _queue[0];
  if (!currentNext || currentNext.levelId !== nextEntry.levelId) {
    _updatePreview();
    return;
  }

  // If _fetchLevelInfo returned null (duplicate fetch in progress), skip update
  if (info === null) return;

  dashboard.updateWidget('gd-level-preview', {
    state: info.error ? 'error' : 'loaded',
    levelId: nextEntry.levelId,
    info,
    requestedBy: nextEntry.username,
    platform: nextEntry.platform,
    notes: nextEntry.notes,
    queueEmpty: false,
  });
}

// Push current state to the overlay and dashboard
function _notify() {
  updateSection('gd-queue', { queue: _queue, enabled: _enabled });
  dashboard.updateWidget('gd-queue', { queue: _queue, enabled: _enabled });
  _updatePreview(); // async, fire-and-forget — updates gd-level-preview widget
}

// ── Overlay section registration ──────────────────────────────────────────
// The render function is serialised to a string so overlay-server.js can
// inject it into the browser page. It must be self-contained (no closures).

registerSection('gd-queue', {
  title: 'Level Queue',
  order: 10,
  icon: `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polygon points="11,2 13.5,8.5 20.5,8.5 14.9,12.7 17,19.5 11,15.3 5,19.5 7.1,12.7 1.5,8.5 8.5,8.5"
             fill="none" stroke="#00e5ff" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`,

  render: /* the fn below is serialised — no outer-scope references allowed */
    (function render(data, el, esc, { card, badge }) {
      if (!data) { el.innerHTML = ''; return; }
      const { queue, enabled } = data;

      card.dataset.state = enabled ? '' : 'closed';

      badge.textContent = queue.length === 1 ? '1 level' : queue.length + ' levels';

      if (queue.length === 0) {
        el.innerHTML = '<div class="msg ' + (enabled ? 'msg-empty' : 'msg-closed') + '">'
          + (enabled ? 'NO LEVELS IN QUEUE' : 'QUEUE CLOSED') + '</div>';
        return;
      }

      el.innerHTML = queue.map((e, i) => {
        const hasNotes = e.notes && e.notes.trim();
        return '<div class="entry">'
          + '<span class="entry-pos">#' + (i + 1) + '</span>'
          + '<div class="entry-main">'
          +   '<span class="entry-id">'   + esc(e.levelId)  + '</span>'
          +   '<span class="entry-user">'
          +     '<span class="platform-dot ' + esc(e.platform) + '"></span>'
          +     esc(e.username)
          +   '</span>'
          + '</div>'
          + (hasNotes ? '<span class="entry-notes">' + esc(e.notes) + '</span>' : '')
          + '</div>';
      }).join('');
    }).toString(),
});

// ── Dashboard widget: gd-queue (queue list) ──────────────────────────────────

dashboard.registerWidget('gd-queue', {
  title: 'GD Level Queue',
  order: 10,
  icon: `<svg width="20" height="20" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polygon points="11,2 13.5,8.5 20.5,8.5 14.9,12.7 17,19.5 11,15.3 5,19.5 7.1,12.7 1.5,8.5 8.5,8.5"
             fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`,
  render: (function render(data, el, esc, { badge }) {
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px">Waiting for data…</p>';
      badge.textContent = '';
      return;
    }
    var queue   = data.queue   || [];
    var enabled = data.enabled !== false;

    badge.textContent  = queue.length === 1 ? '1 level' : queue.length + ' levels';

    if (queue.length === 0) {
      el.innerHTML =
        '<p style="color:var(--muted);font-size:12px;text-align:center;padding:10px 0">' +
        (enabled ? 'No levels in queue' : '🔒 Queue closed') + '</p>';
      return;
    }

    // Render the queue list. The first entry (#1) is highlighted to visually
    // connect it with the gd-level-preview widget above, which shows its
    // metadata. The "Next / Copy & Play" button lives on the preview widget,
    // NOT here — this avoids the bug where SSE re-renders would destroy the
    // button (and its click handler) between the click and the fetch response.
    el.innerHTML = queue.map(function (e, i) {
      var platformColor = e.platform === 'twitch' ? '#9147ff' : '#ff0000';
      var notesHtml = e.notes
        ? '<div style="font-size:10px;color:var(--muted);font-style:italic;margin-top:1px;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(e.notes) + '</div>'
        : '';
      var isNext = i === 0;
      var highlight = isNext
        ? 'background:rgba(0,229,255,0.06);border-radius:4px;'
        : '';
      var posColor = isNext ? 'var(--accent)' : 'var(--muted)';
      return '<div style="display:grid;grid-template-columns:24px 1fr;gap:4px 8px;' +
          'align-items:center;padding:6px 8px;border-bottom:1px solid var(--border);' + highlight + '">' +
        '<span style="font-family:var(--mono);font-size:10px;color:' + posColor + ';text-align:right">' +
          (isNext ? '▶' : '') + ' #' + (i + 1) +
        '</span>' +
        '<div style="min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<span style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--accent)">' +
              esc(e.levelId) +
            '</span>' +
            '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;flex-shrink:0;background:' +
              platformColor + '"></span>' +
            '<span style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
              esc(e.username) +
            '</span>' +
          '</div>' +
          notesHtml +
        '</div>' +
      '</div>';
    }).join('');
  }).toString(),
});

// ── Dashboard widget: gd-level-preview ───────────────────────────────────────
//
// Shows metadata for the next level in the queue, fetched from
// gdbrowser.com. Gives the streamer enough info to screen for NSFW content
// (level name, description, author, song) before playing the level.
//
// The "Copy & Play" and "Skip" buttons are created ONCE and inserted as a
// SIBLING of el (not inside el). This is critical: el.innerHTML is replaced
// on every SSE-driven re-render, which would destroy any buttons created
// inside el — that was the root cause of the original "Next button doesn't
// work" bug. By using the sibling pattern (same approach as the
// stream-events plugin's Clear button), the buttons survive re-renders.

dashboard.registerWidget('gd-level-preview', {
  title: 'Level Preview',
  order: 9, // before gd-queue (10) so it appears above the queue list
  icon: `<svg width="20" height="20" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="11" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="11" cy="11" r="3" fill="currentColor"/>
  </svg>`,
  render: (function render(data, el, esc, { badge }) {
    // ── Create button container once, as a sibling of el ──────────────────
    // Using el.parentNode.querySelector instead of document.getElementById
    // ensures we find the existing button container even after minimize/
    // restore cycles (where the card is detached and re-attached).
    var btnId = 'gd-preview-btns';
    var btnContainer = el.parentNode
      ? el.parentNode.querySelector('#' + btnId)
      : null;

    if (!btnContainer && el.parentNode) {
      btnContainer = document.createElement('div');
      btnContainer.id = btnId;
      btnContainer.style.cssText =
        'display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--border);' +
        'background:var(--card-bg,rgba(0,0,0,0.2))';

      // ── "Copy & Play" button ──────────────────────────────────────────
      // POSTs to /api/gd-queue/next which dequeues the level and returns
      // it as JSON. The level ID is then copied to the clipboard.
      var playBtn = document.createElement('button');
      playBtn.id = 'gd-preview-play';
      playBtn.textContent = '⏭ Copy & Play';
      playBtn.style.cssText =
        'flex:1;display:flex;align-items:center;justify-content:center;gap:4px;' +
        'padding:6px 10px;border-radius:5px;border:none;cursor:pointer;' +
        'background:var(--accent);color:#fff;font-size:12px;font-weight:700;' +
        'letter-spacing:0.03em;transition:opacity 0.15s';

      playBtn.onclick = function () {
        playBtn.disabled = true;
        playBtn.style.opacity = '0.5';
        playBtn.textContent = '⏳ Loading…';

        fetch('/api/gd-queue/next', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (entry) {
            if (entry && entry.levelId) {
              // Copy level ID to clipboard — works in both secure (HTTPS)
              // and plain-HTTP contexts (the dashboard is often accessed
              // over LAN via http://ip:2999).
              try {
                if (navigator.clipboard && window.isSecureContext) {
                  navigator.clipboard.writeText(entry.levelId).catch(function () {});
                } else {
                  var ta = document.createElement('textarea');
                  ta.value = entry.levelId;
                  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                  document.body.appendChild(ta);
                  ta.focus();
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                }
              } catch (_) {}
              playBtn.textContent = '✅ Copied ' + entry.levelId;
              playBtn.style.background = '#00b5ad';
            } else {
              playBtn.textContent = '📭 Queue empty';
              playBtn.style.background = 'var(--muted)';
            }
            setTimeout(function () {
              playBtn.textContent = '⏭ Copy & Play';
              playBtn.style.background = 'var(--accent)';
              playBtn.disabled = false;
              playBtn.style.opacity = '1';
            }, 2000);
          })
          .catch(function () {
            playBtn.textContent = '❌ Error';
            playBtn.style.background = '#e53935';
            playBtn.disabled = false;
            playBtn.style.opacity = '1';
            setTimeout(function () {
              playBtn.textContent = '⏭ Copy & Play';
              playBtn.style.background = 'var(--accent)';
            }, 2000);
          });
      };

      // ── "Skip" button ──────────────────────────────────────────────────
      // POSTs to /api/gd-queue/skip which dequeues the level WITHOUT
      // copying it. Used to discard NSFW levels without playing them.
      var skipBtn = document.createElement('button');
      skipBtn.id = 'gd-preview-skip';
      skipBtn.textContent = '⏭ Skip';
      skipBtn.style.cssText =
        'display:flex;align-items:center;justify-content:center;gap:4px;' +
        'padding:6px 12px;border-radius:5px;border:1px solid var(--border);cursor:pointer;' +
        'background:none;color:var(--muted);font-size:12px;font-weight:600;' +
        'transition:color 0.15s,border-color 0.15s';

      skipBtn.onmouseover = function () {
        skipBtn.style.color = 'var(--text)';
        skipBtn.style.borderColor = 'var(--muted)';
      };
      skipBtn.onmouseout = function () {
        skipBtn.style.color = 'var(--muted)';
        skipBtn.style.borderColor = 'var(--border)';
      };

      skipBtn.onclick = function () {
        skipBtn.disabled = true;
        skipBtn.style.opacity = '0.5';
        skipBtn.textContent = '⏳ Skipping…';

        fetch('/api/gd-queue/skip', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (entry) {
            if (entry && entry.levelId) {
              skipBtn.textContent = '⏭ Skipped ' + entry.levelId;
            } else {
              skipBtn.textContent = '📭 Queue empty';
            }
            setTimeout(function () {
              skipBtn.textContent = '⏭ Skip';
              skipBtn.disabled = false;
              skipBtn.style.opacity = '1';
            }, 2000);
          })
          .catch(function () {
            skipBtn.textContent = '❌ Error';
            skipBtn.disabled = false;
            skipBtn.style.opacity = '1';
            setTimeout(function () { skipBtn.textContent = '⏭ Skip'; }, 2000);
          });
      };

      btnContainer.appendChild(playBtn);
      btnContainer.appendChild(skipBtn);

      // Insert AFTER el so buttons appear below the level info
      if (el.nextSibling) {
        el.parentNode.insertBefore(btnContainer, el.nextSibling);
      } else {
        el.parentNode.appendChild(btnContainer);
      }
    }

    // ── Update button container visibility ────────────────────────────────
    if (btnContainer) {
      btnContainer.style.display =
        (!data || data.queueEmpty) ? 'none' : 'flex';
    }

    // ── Badge ─────────────────────────────────────────────────────────────
    if (badge) badge.textContent = '';

    // ── Render content ─────────────────────────────────────────────────────
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:10px 0">Waiting for data…</p>';
      return;
    }

    if (data.queueEmpty || data.state === 'empty') {
      el.innerHTML =
        '<p style="color:var(--muted);font-size:12px;text-align:center;padding:20px 0">' +
        'No levels in queue</p>';
      return;
    }

    // Loading state
    if (data.state === 'loading') {
      el.innerHTML =
        '<div style="padding:10px 0;text-align:center">' +
          '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">Fetching level…</div>' +
          '<div style="font-family:var(--mono);font-size:18px;font-weight:700;color:var(--accent)">' +
            esc(data.levelId || '') +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:4px">' +
            'requested by ' + esc(data.requestedBy || '') +
          '</div>' +
        '</div>';
      return;
    }

    // Error state (level not found, API down, non-numeric ID)
    if (data.state === 'error') {
      el.innerHTML =
        '<div style="padding:8px 0">' +
          '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">' +
            '<span style="font-size:10px;color:var(--muted)">ID:</span>' +
            '<span style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--accent)">' +
              esc(data.levelId || '') +
            '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:#ff6b6b;padding:4px 0">⚠ ' +
            esc(data.error || 'Failed to load level info') +
          '</div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:4px">' +
            'requested by ' + esc(data.requestedBy || '') +
          '</div>' +
        '</div>';
      return;
    }

    // Loaded state — show full level metadata
    if (data.state === 'loaded' && data.info) {
      var info = data.info;

      var songLine = info.songName
        ? esc(info.songName) + (info.songAuthor ? ' — ' + esc(info.songAuthor) : '')
        : '<span style="color:var(--muted)">Unknown</span>';

      var diffStars = esc(info.difficulty || 'N/A');
      if (info.stars > 0) diffStars += ' ★' + info.stars;
      if (info.epic) diffStars = '⭐ ' + diffStars;
      else if (info.featured) diffStars = '✦ ' + diffStars;

      var twoPlayerTag = info.twoPlayer ? ' 👥2P' : '';
      var lengthTag = info.length && info.length !== 'Unknown'
        ? ' • ' + esc(info.length) : '';
      var coinsTag = info.coins > 0 ? ' • 🪙' + info.coins : '';

      // Description — shown in a subtle box, preserved whitespace, word-broken
      // This is the key field for NSFW screening: streamers should read this
      // before deciding to play the level.
      var descHtml = info.description
        ? '<div style="font-size:11px;color:var(--text);background:rgba(255,255,255,0.04);' +
          'border-radius:4px;padding:5px 7px;margin:4px 0 6px;white-space:pre-wrap;' +
          'word-break:break-word;max-height:120px;overflow-y:auto">' +
          esc(info.description) + '</div>'
        : '<div style="font-size:10px;color:var(--muted);font-style:italic;margin:4px 0 6px">' +
          '(No description provided)</div>';

      el.innerHTML =
        '<div style="padding:6px 0">' +
          // Level ID + requested by
          '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">' +
            '<span style="font-size:10px;color:var(--muted)">ID:</span>' +
            '<span style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--accent)">' +
              esc(info.levelId || '') +
            '</span>' +
            '<span style="font-size:10px;color:var(--muted);margin-left:auto">' +
              'by ' + esc(data.requestedBy || '') +
            '</span>' +
          '</div>' +
          // Level name (prominent)
          '<div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:2px">' +
            esc(info.name || 'Unknown') +
          '</div>' +
          // Author + difficulty + stars + tags
          '<div style="font-size:11px;color:var(--muted);margin-bottom:2px">' +
            'by ' + esc(info.author || 'Unknown') + ' • ' + diffStars +
            twoPlayerTag + lengthTag + coinsTag +
          '</div>' +
          // Description
          descHtml +
          // Song
          '<div style="font-size:11px;color:var(--muted);margin-bottom:4px">🎵 ' +
            songLine +
          '</div>' +
          // Stats row
          '<div style="display:flex;gap:12px;font-size:10px;color:var(--muted)">' +
            '<span>⬇ ' + Number(info.downloads || 0).toLocaleString() + '</span>' +
            '<span>👍 ' + Number(info.likes || 0).toLocaleString() + '</span>' +
            '<span>📦 ' + Number(info.objects || 0) + ' objects</span>' +
          '</div>' +
        '</div>';
      return;
    }

    // Fallback
    el.innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:10px 0">…</p>';
  }).toString(),
});

// ── Dashboard API routes ──────────────────────────────────────────────────
// POST /api/gd-queue/next — dequeues the first entry and returns it as JSON.
// Called by the "Copy & Play" button on the gd-level-preview widget.
// The level ID is copied to the clipboard client-side.

addRoute('/api/gd-queue/next', (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  const entry = _next();
  _notify();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(entry ?? null));
});

// POST /api/gd-queue/skip — dequeues the first entry WITHOUT returning
// the level ID for clipboard copy. Used to discard NSFW levels.
// Server-side this is identical to /next — the difference is purely
// client-side (no clipboard copy). Having a separate route makes the
// intent clearer in logs.

addRoute('/api/gd-queue/skip', (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  const entry = _next();
  if (entry) {
    log.info(`[gd-queue] Skipped level ${entry.levelId} (requested by ${entry.username}) — not copied to clipboard`);
  }
  _notify();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(entry ?? null));
});

// Serves a self-contained overlay page showing only the queue section.
// Add http://<host>:2999/gd-queue as a Browser Source in OBS.
//
// Uses overlay-server's buildStandaloneSectionPage() public helper instead
// of reaching into private _getSectionMeta / _getSectionData exports. This
// drops ~95 lines of duplicated HTML/CSS/JS boilerplate that was previously
// inlined here.

addRoute('/gd-queue', (req, res) => {
  const html = buildStandaloneSectionPage('gd-queue', { title: 'GD Level Queue' });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// ── Queue helpers ─────────────────────────────────────────────────────────

function _findByUser(username) {
  return _queue.findIndex(e => e.username.toLowerCase() === username.toLowerCase());
}

function _add(username, platform, levelId, notes) {
  const existing = _findByUser(username);
  if (existing !== -1) {
    const old = _queue[existing].levelId;
    _queue.splice(existing, 1);
    log.info(`[gd-queue] Replaced ${username}'s entry ${old} → ${levelId}`);
  }
  _queue.push({ username, platform, levelId, notes: notes || null, addedAt: new Date() });
  log.info(`[gd-queue] Added: ${username} → ${levelId}${notes ? ` (notes: ${notes})` : ''} (queue length: ${_queue.length})`);
  return existing !== -1; // true = was a replacement
}

function _next() {
  return _queue.shift() ?? null;
}

// ── processMessage ────────────────────────────────────────────────────────

async function processMessage(msg) {
  const text = msg.message.trim();

  // !q (no args) — show the current queue
  if (CMD_LIST.test(text)) {
    if (!_enabled) {
      const send = _chatReply[msg.platform];
      if (send) send('The level queue is currently closed.')
        ?.catch(e => log.error('[gd-queue] chat reply error:', e.message));
      return { message: null };
    }

    const len = _queue.length;
    let reply;
    if (len === 0) {
      reply = 'The level queue is currently empty!';
    } else {
      const entries = _queue.map((e, i) => `#${i + 1}: ${e.levelId} (${e.username}${e.notes ? ` — ${e.notes}` : ''})`).join(' | ');
      reply = `Queue (${len}): ${entries}`;
    }

    const send = _chatReply[msg.platform];
    if (send) send(reply)?.catch(e => log.error('[gd-queue] chat reply error:', e.message));

    return { message: null };
  }

  // !q <levelId> [notes] / !queue <levelId> [notes]
  if (CMD_ADD.test(text)) {
    if (!_enabled) {
      const send = _chatReply[msg.platform];
      if (send) send(`${msg.username} the level queue is currently closed.`)
        ?.catch(e => log.error('[gd-queue] chat reply error:', e.message));
      return { message: null }; // still suppress from #stream-chat
    }

    const addMatch  = text.match(CMD_ADD);
    const levelId   = addMatch[1];
    const notes     = addMatch[2] ? addMatch[2].trim() : null;
    const replaced  = _add(msg.username, msg.platform, levelId, notes);
    _notify();
    const notesHint = notes ? ` (notes: ${notes})` : '';
    const reply     = replaced
      ? `${msg.username} updated your request to level ${levelId}${notesHint}! Queue position: #${_queue.length}`
      : `${msg.username} added level ${levelId}${notesHint} to the queue! Position: #${_queue.length}`;

    const send = _chatReply[msg.platform];
    if (send) send(reply)?.catch(e => log.error('[gd-queue] chat reply error:', e.message))

    return { message: null };
  }

  // !ql
  if (CMD_LENGTH.test(text)) {
    if (!_enabled) {
      const send = _chatReply[msg.platform];
      if (send) send('The level queue is currently closed.')
        ?.catch(e => log.error('[gd-queue] chat reply error:', e.message));
      return { message: null };
    }

    const len   = _queue.length;
    const reply = len === 0
      ? 'The level queue is currently empty!'
      : `There ${len === 1 ? 'is' : 'are'} ${len} level${len === 1 ? '' : 's'} in the queue.`;

    const send = _chatReply[msg.platform];
    if (send) send(reply)?.catch(e => log.error('[gd-queue] chat reply error:', e.message));

    return { message: null };
  }

  // !p — show the calling user's position in the queue
  if (CMD_POS.test(text)) {
    const send = _chatReply[msg.platform];
    const idx  = _findByUser(msg.username);
    let reply;
    if (!_enabled && idx === -1) {
      reply = 'The level queue is currently closed.';
    } else if (idx === -1) {
      reply = `${msg.username} you are not in the queue.`;
    } else {
      const entry = _queue[idx];
      reply = `${msg.username} you are #${idx + 1} in the queue (level ${entry.levelId}${entry.notes ? ` — ${entry.notes}` : ''}).`;
    }
    if (send) send(reply)?.catch(e => log.error('[gd-queue] chat reply error:', e.message));
    return { message: null };
  }

  return { message: msg };
}

// ── Slash commands ────────────────────────────────────────────────────────

const GD_BLUE = 0x00a8ff;

function _buildQueueEmbed() {
  const embed = new EmbedBuilder()
    .setColor(GD_BLUE)
    .setTitle('🎮 GD Level Queue')
    .setTimestamp();

  if (_queue.length === 0) {
    embed.setDescription('The queue is empty.');
    return embed;
  }

  const lines = _queue.map((e, i) => {
    const platform = e.platform === 'twitch' ? '🟣' : '🔴';
    const notesStr = e.notes ? ` — *${e.notes}*` : '';
    return `**${i + 1}.** \`${e.levelId}\` — ${platform} ${e.username}${notesStr}`;
  });

  embed.setDescription(lines.join('\n'));
  embed.setFooter({ text: `${_queue.length} level${_queue.length === 1 ? '' : 's'} in queue` });
  return embed;
}

const commandNext = new SlashCommandBuilder()
  .setName('next')
  .setDescription('Dequeue and show the next GD level request')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

const commandQueue = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Manage the GD level request queue')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('list').setDescription('Show all levels currently in the queue'))
  .addSubcommand(sub =>
    sub.setName('clear').setDescription('Empty the entire queue'))
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription("Remove a specific user's entry from the queue")
      .addStringOption(o =>
        o.setName('user').setDescription('The username to remove').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('toggle').setDescription('Enable or disable the level queue'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const cmd = interaction.commandName;

  // /next — works regardless of whether the queue is open or closed
  if (cmd === 'next') {
    const entry = _next();
    _notify();
    if (!entry) {
      return interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(GD_BLUE).setDescription('📭 The queue is empty — no more levels!'),
      ]});
    }
    const platform = entry.platform === 'twitch' ? '🟣 Twitch' : '🔴 YouTube';
    const embed = new EmbedBuilder()
      .setColor(GD_BLUE)
      .setTitle('Next Level')
      .addFields(
        { name: 'Level ID',     value: `\`${entry.levelId}\``,          inline: true },
        { name: 'Requested by', value: `(${platform}) ${entry.username}`, inline: true },
      )
      .setFooter({ text: `${_queue.length} level${_queue.length === 1 ? '' : 's'} remaining` })
      .setTimestamp();
    if (entry.notes) {
      embed.addFields({ name: 'Notes', value: entry.notes, inline: false });
    }
    return interaction.editReply({ embeds: [embed] });
  }

  // /queue subcommands
  if (cmd === 'queue') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'toggle') {
      _enabled = !_enabled;
      _notify();
      log.info(`[gd-queue] Queue ${_enabled ? 'enabled' : 'disabled'} by Discord command`);
      return interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setColor(GD_BLUE)
          .setDescription(_enabled
            ? '✅ Level queue is now **open** — viewers can submit levels.'
            : '🔒 Level queue is now **closed** — submissions are paused.'),
      ]});
    }

    if (sub === 'list') {
      return interaction.editReply({ embeds: [_buildQueueEmbed()] });
    }

    if (sub === 'clear') {
      const count = _queue.length;
      _queue.length = 0;
      _notify();
      log.info('[gd-queue] Queue cleared by Discord command');
      return interaction.editReply(`Queue cleared — removed ${count} level${count === 1 ? '' : 's'}.`);
    }

    if (sub === 'remove') {
      const user = interaction.options.getString('user');
      const idx  = _findByUser(user);
      if (idx === -1) {
        return interaction.editReply(`⚠️ No entry found for **${user}** in the queue.`);
      }
      const removed = _queue.splice(idx, 1)[0];
      _notify();
      log.info(`[gd-queue] Removed ${removed.username}'s entry (${removed.levelId}) via Discord`);
      return interaction.editReply(`Removed **${removed.username}**'s level \`${removed.levelId}\` from the queue.`);
    }
  }

  return interaction.editReply('⚠️ Unknown command.');
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[gd-queue] Chat reply handlers registered.');
  _notify(); // pushes initial state + kicks off preview fetch
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'gd-queue',
  commands: [commandNext, commandQueue],
  handleInteraction,
  processMessage,
  onChatReady,
};
