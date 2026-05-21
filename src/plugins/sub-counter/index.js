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
 * Required env vars:
 *   YT_API_KEY            — YouTube Data API v3 key (shared with youtube.js)
 *   YT_CHANNEL_ID         — YouTube channel ID     (shared with youtube.js)
 *   TWITCH_CLIENT_ID      — Twitch app client ID   (shared with twitch.js)
 *   TWITCH_CLIENT_SECRET  — Twitch app secret      (shared with twitch.js)
 *   TWITCH_BROADCASTER_LOGIN — Twitch broadcaster login (shared with twitch.js)
 *
 * Voice channel IDs:
 *   YouTube subs:    1503249335884841060  →  "📊 Subs: 1,234"
 *   Twitch followers: 1503266381989281813  →  "👥 Followers: 5,678"
 */

const log       = require('../../logger');
const dashboard = require('../../dashboard');

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
  dashboard.updateWidget('sub-counter', {
    yt: _state[VOICE_CHANNEL_ID].count,
    tw: _state[FOLLOWER_CHANNEL_ID].count,
  });
}



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
  const apiKey    = process.env.YT_API_KEY;
  const channelId = process.env.YT_CHANNEL_ID;

  if (!apiKey || !channelId) {
    log.warn('[sub-counter] YT_API_KEY or YT_CHANNEL_ID not set — cannot fetch initial count');
    return null;
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`;
    const res  = await fetch(url);
    if (!res.ok) {
      log.warn(`[sub-counter] YouTube API error ${res.status} fetching subscriber count`);
      return null;
    }
    const data = await res.json();
    const raw  = data?.items?.[0]?.statistics?.subscriberCount;
    if (raw == null) {
      log.warn('[sub-counter] Subscriber count missing from API response');
      return null;
    }
    return parseInt(raw, 10);
  } catch (err) {
    log.error('[sub-counter] Failed to fetch YouTube subscriber count:', err.message);
    return null;
  }
}

// ── Twitch ────────────────────────────────────────────────────────────────────

/**
 * Fetch a Twitch app access token (client credentials).
 * We get our own here rather than importing from twitch.js to keep this
 * plugin self-contained.
 */
let _twAppToken       = null;
let _twAppTokenExpiry = 0;

async function _getTwitchAppToken() {
  if (_twAppToken && Date.now() < _twAppTokenExpiry) return _twAppToken;

  const clientId     = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res  = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      { method: 'POST' }
    );
    const data = await res.json();
    if (!data.access_token) throw new Error(JSON.stringify(data));
    _twAppToken       = data.access_token;
    _twAppTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return _twAppToken;
  } catch (err) {
    log.error('[sub-counter] Failed to get Twitch app token:', err.message);
    return null;
  }
}

async function _fetchTwitchFollowerCount() {
  const clientId   = process.env.TWITCH_CLIENT_ID;
  const broadcaster = (process.env.TWITCH_BROADCASTER_LOGIN ?? '').trim();

  if (!clientId || !broadcaster) {
    log.warn('[sub-counter] TWITCH_CLIENT_ID or TWITCH_BROADCASTER_LOGIN not set — cannot fetch follower count');
    return null;
  }

  try {
    const appToken = await _getTwitchAppToken();
    if (!appToken) return null;

    // First resolve broadcaster login → ID
    const userRes  = await fetch(
      `https://api.twitch.tv/helix/users?login=${broadcaster}`,
      { headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${appToken}` } }
    );
    const userData = await userRes.json();
    const broadcasterId = userData?.data?.[0]?.id;
    if (!broadcasterId) {
      log.warn('[sub-counter] Could not resolve Twitch broadcaster ID');
      return null;
    }

    // /channels/followers returns total in the pagination object
    const res  = await fetch(
      `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}&first=1`,
      { headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${appToken}` } }
    );
    if (!res.ok) {
      const text = await res.text();
      log.warn(`[sub-counter] Twitch followers API error ${res.status}: ${text}`);
      return null;
    }
    const data = await res.json();
    const total = data?.total;
    if (total == null) {
      log.warn('[sub-counter] Follower count missing from Twitch API response');
      return null;
    }
    return total;
  } catch (err) {
    log.error('[sub-counter] Failed to fetch Twitch follower count:', err.message);
    return null;
  }
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

function init(context) {
  _client = context?.client ?? null;

  function _whenReady(cb) {
    if (_client?.isReady?.()) { cb(); return; }
    if (_client) { _client.once('ready', cb); return; }
    const poll = setInterval(() => {
      if (!context?.client) return;
      _client = context.client;
      clearInterval(poll);
      if (_client.isReady()) cb();
      else _client.once('ready', cb);
    }, 500);
  }

  const queue = require('../../queue');

  if (!queue?.onMessage) {
    log.warn('[sub-counter] queue.onMessage not available — no events will be received.');
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