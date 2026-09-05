'use strict';

/**
 * sub-counter plugin
 *
 * Keeps Discord voice channel names in sync with live counts:
 *   • YouTube subscriber count  → voice channel VOICE_CHANNEL_ID
 *   • Twitch follower count     → voice channel FOLLOWER_CHANNEL_ID
 *
 * Counts are updated:
 *   • At startup — fetched from the respective APIs.
 *   • On every event — incremented locally and debounced before rename.
 *
 * Discord rate-limits channel renames to ~2 per 10 minutes per channel.
 * Updates are debounced: rapid bursts are coalesced into a single rename,
 * and a minimum interval is enforced between API calls per channel.
 *
 * Uses the twitch and youtube modules' public APIs (getFollowerCount /
 * getSubscriberCount) via init(context) — no Helix or YouTube Data API
 * plumbing reimplemented locally.
 *
 * Voice channel IDs:
 *   YouTube subs:    1503249335884841060  →  "📊 Subs: 1,234"
 *   Twitch followers: 1503266381989281813  →  "👥 Followers: 5,678"
 */

const log       = require('../../logger');
const dashboard = require('../../dashboard');
const overlay   = require('../../overlay-server');
const fs        = require('fs');
const path      = require('path');

const OVERLAY_HTML = path.resolve(__dirname, 'overlay.html');

// ── Config ────────────────────────────────────────────────────────────────────

const VOICE_CHANNEL_ID    = '1503249335884841060';
const FOLLOWER_CHANNEL_ID = '1503266381989281813';

const YT_LABEL_PREFIX     = '📊 Subs: ';
const TW_LABEL_PREFIX     = '👥 Followers: ';

// Discord allows ~2 renames per 10 min. We enforce a 5-minute hard floor
// between actual API calls, and debounce rapid bursts with a short window.
const DEBOUNCE_MS     = 5_000;          // coalesce rapid events, then rename
const MIN_INTERVAL_MS = 5 * 60 * 1000; // never rename more often than once per 5 min

// ── State ─────────────────────────────────────────────────────────────────────

let _client = null; // discord.js Client, captured from init context

// Per-counter state — keyed by channel ID for symmetry
const _state = {
  [VOICE_CHANNEL_ID]: {
    count:        null,
    lastRenameAt: 0,
    debounceTimer: null,
    pendingCount:  null,
    formatName:   n => YT_LABEL_PREFIX + Number(n).toLocaleString('en-US'),
  },
  [FOLLOWER_CHANNEL_ID]: {
    count:        null,
    lastRenameAt: 0,
    debounceTimer: null,
    pendingCount:  null,
    formatName:   n => TW_LABEL_PREFIX + Number(n).toLocaleString('en-US'),
  },
};

// ── Dashboard widget ──────────────────────────────────────────────────────────

dashboard.registerWidget('sub-counter', {
  title: 'Sub Counter',
  order: 50,
  icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
           <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
           <circle cx="9" cy="7" r="4"/>
           <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
           <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
         </svg>`,
  render: (function render(data, el, esc, { badge }) {
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px">Waiting for data…</p>';
      badge.textContent = '';
      return;
    }
    var yt = data.yt  != null ? Number(data.yt).toLocaleString('en-US')  : '—';
    var tw = data.tw  != null ? Number(data.tw).toLocaleString('en-US')  : '—';
    badge.textContent = yt + ' / ' + tw;
    el.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:8px;padding:4px 0">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;' +
            'padding:6px 0;border-bottom:1px solid var(--border)">' +
          '<span style="color:var(--muted);font-size:12px">📊 YouTube Subs</span>' +
          '<span style="font-family:var(--mono);font-size:22px;font-weight:900;color:var(--accent)">' +
            esc(yt) +
          '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0">' +
          '<span style="color:var(--muted);font-size:12px">👥 Twitch Followers</span>' +
          '<span style="font-family:var(--mono);font-size:22px;font-weight:900;color:var(--accent)">' +
            esc(tw) +
          '</span>' +
        '</div>' +
      '</div>';
  }).toString(),
});

function _notifyDashboard() {
  const data = {
    yt: _state[VOICE_CHANNEL_ID].count,
    tw: _state[FOLLOWER_CHANNEL_ID].count,
  };
  dashboard.updateWidget('sub-counter', data);
  overlay.updateSection('sub-counter', data);
}

// ── OBS overlay ───────────────────────────────────────────────────────────────
// Minimalist standalone browser-source page — separate from the dashboard
// widget above so it can be sized/positioned independently in OBS.

overlay.registerSection('sub-counter', {
  title: 'Sub Counter',
  order: 50,
  render: (function render() {}).toString(), // unused — standalone page has its own renderer
});

overlay.addRoute('/sub-counter', (req, res) => {
  try {
    const html = fs.readFileSync(OVERLAY_HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    log.error('[sub-counter] Could not read overlay.html:', e.message);
    res.writeHead(500); res.end('Sub counter overlay not found');
  }
});



/**
 * Rename a voice channel immediately, unless inside the rate-limit window —
 * in which case schedule a retry for when the cooldown expires.
 */
async function _applyRename(channelId, count) {
  const s    = _state[channelId];
  const now  = Date.now();
  const wait = MIN_INTERVAL_MS - (now - s.lastRenameAt);

  if (wait > 0) {
    if (!s.debounceTimer) {
      log.info(`[sub-counter] Rate-limit cooldown on ${channelId} — will rename in ${Math.ceil(wait / 1000)}s`);
      s.pendingCount  = count;
      s.debounceTimer = setTimeout(() => {
        s.debounceTimer = null;
        const n = s.pendingCount;
        s.pendingCount = null;
        _applyRename(channelId, n).catch(err =>
          log.error(`[sub-counter] Deferred rename error (${channelId}):`, err.message));
      }, wait);
    } else {
      s.pendingCount = count;
    }
    return;
  }

  if (!_client) {
    log.warn('[sub-counter] Discord client not available — skipping rename');
    return;
  }

  try {
    const channel = await _client.channels.fetch(channelId);
    if (!channel) {
      log.warn(`[sub-counter] Channel ${channelId} not found`);
      return;
    }

    const newName = s.formatName(count);
    if (channel.name === newName) {
      log.info(`[sub-counter] Channel ${channelId} name already correct — skipping rename`);
      return;
    }

    await channel.setName(newName);
    s.lastRenameAt = Date.now();
    log.info(`[sub-counter] Channel ${channelId} renamed → "${newName}"`);
  } catch (err) {
    if (err.code === 50013) {
      log.error(`[sub-counter] Missing Permissions — grant the bot "Manage Channel" on channel ${channelId}`);
    } else {
      log.error(`[sub-counter] Failed to rename channel ${channelId}: code=${err.code} message=${err.message}`);
    }
  }
}

/**
 * Debounce wrapper — gift sub / follow bursts fire many events quickly.
 * Waits DEBOUNCE_MS of quiet before issuing the rename.
 */
function _scheduleRename(channelId, count) {
  const s = _state[channelId];
  s.pendingCount = count;

  if (s.debounceTimer) return; // already pending; pendingCount updated above

  s.debounceTimer = setTimeout(() => {
    s.debounceTimer = null;
    const n = s.pendingCount;
    s.pendingCount = null;
    _applyRename(channelId, n).catch(err =>
      log.error(`[sub-counter] Rename error (${channelId}):`, err.message));
  }, DEBOUNCE_MS);
}

// ── YouTube ───────────────────────────────────────────────────────────────────

async function _fetchYtSubCount() {
  if (!_youtube) {
    log.warn('[sub-counter] youtube module not in init context — cannot fetch YT sub count');
    return null;
  }
  try {
    return await _youtube.getSubscriberCount();
  } catch (err) {
    log.error('[sub-counter] Failed to fetch YouTube subscriber count:', err.message);
    return null;
  }
}

// ── Twitch ────────────────────────────────────────────────────────────────────

async function _fetchTwitchFollowerCount() {
  if (!_twitch) {
    log.warn('[sub-counter] twitch module not in init context — cannot fetch follower count');
    return null;
  }
  try {
    return await _twitch.getFollowerCount();
  } catch (err) {
    log.error('[sub-counter] Failed to fetch Twitch follower count:', err.message);
    return null;
  }
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

// Captured from init(context). _twitch + _youtube are the main-module refs
// exposed via the documented init contract; _client is the discord.js Client
// (attached to context.discord.client after the bot logs in).
let _twitch  = null;
let _youtube = null;

function init(context) {
  _twitch  = context.twitch  ?? null;
  _youtube = context.youtube ?? null;
  _client  = context?.discord?.client ?? context?.client ?? null;

  function _whenReady(cb) {
    if (_client?.isReady?.()) { cb(); return; }
    if (_client) { _client.once('ready', cb); return; }
    // Poll for the discord client to be attached after login. The discord
    // module sets api.client = client inside startDiscordBot after login
    // completes, so we read it back via the same context reference.
    const poll = setInterval(() => {
      const client = context?.discord?.client ?? context?.client;
      if (!client) return;
      _client = client;
      clearInterval(poll);
      if (_client.isReady()) cb();
      else _client.once('ready', cb);
    }, 500);
  }

  const queue = context.queue;

  if (!queue?.onMessage) {
    log.warn('[sub-counter] queue not in init context — no events will be received.');
  } else {
    queue.onMessage(msg => {
      // YouTube subscriber
      if (msg?.platform === 'youtube' && msg?.type === 'subscribe') {
        const s = _state[VOICE_CHANNEL_ID];
        if (s.count !== null) {
          s.count += 1;
          log.info(
            `[sub-counter] New YouTube subscriber: ${msg.username ?? '<anonymous>'} ` +
            `— count now ${s.count.toLocaleString()}`
          );
          _scheduleRename(VOICE_CHANNEL_ID, s.count);
          _notifyDashboard();
        }
        return;
      }

      // Twitch follow
      if (msg?.platform === 'twitch' && msg?.type === 'follow') {
        const s = _state[FOLLOWER_CHANNEL_ID];
        if (s.count !== null) {
          s.count += 1;
          log.info(
            `[sub-counter] New Twitch follower: ${msg.username ?? '<anonymous>'} ` +
            `— count now ${s.count.toLocaleString()}`
          );
          _scheduleRename(FOLLOWER_CHANNEL_ID, s.count);
          _notifyDashboard();
        }
        return;
      }
    });
  }

  // Fetch both counts and do initial renames once Discord is ready.
  _whenReady(() => {
    // YouTube subs
    _fetchYtSubCount().then(count => {
      if (count == null) return;
      _state[VOICE_CHANNEL_ID].count = count;
      log.info(`[sub-counter] Initial YouTube subscriber count: ${count.toLocaleString()}`);
      _notifyDashboard();
      _applyRename(VOICE_CHANNEL_ID, count).catch(err =>
        log.error('[sub-counter] Initial YT rename error:', err.message));
    });

    // Twitch followers
    _fetchTwitchFollowerCount().then(count => {
      if (count == null) return;
      _state[FOLLOWER_CHANNEL_ID].count = count;
      log.info(`[sub-counter] Initial Twitch follower count: ${count.toLocaleString()}`);
      _notifyDashboard();
      _applyRename(FOLLOWER_CHANNEL_ID, count).catch(err =>
        log.error('[sub-counter] Initial Twitch rename error:', err.message));
    });
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  id: 'sub-counter',
  init,
  async processMessage(msg) { return { message: msg }; },
};