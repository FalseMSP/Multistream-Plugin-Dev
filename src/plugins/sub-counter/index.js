'use strict';

/**
 * sub-counter plugin
 *
 * Keeps a Discord voice channel name in sync with the current YouTube
 * subscriber count.
 *
 * The channel name is updated:
 *   • At startup — fetches the live count from the YouTube Data API.
 *   • On every subscribe event — increments the local count immediately
 *     (both named and anonymous events emitted by youtube.js).
 *
 * Discord rate-limits channel renames to ~2 per 10 minutes per channel.
 * Updates are debounced: rapid bursts (e.g. gift subs) are coalesced into
 * a single rename, and a minimum interval is enforced between API calls.
 *
 * Required env vars:
 *   YT_API_KEY      — YouTube Data API v3 key (shared with youtube.js)
 *   YT_CHANNEL_ID   — YouTube channel ID     (shared with youtube.js)
 *
 * Voice channel ID: 1503249335884841060
 * Name format:      "📊 Subs: 1,234"
 */

const log = require('../../logger');

// ── Config ────────────────────────────────────────────────────────────────────

const VOICE_CHANNEL_ID = '1503249335884841060';
const LABEL_PREFIX     = '📊 Subs: ';

// Discord allows ~2 renames per 10 min. We enforce a 5-minute hard floor
// between actual API calls, and debounce rapid bursts with a short window.
const DEBOUNCE_MS    = 5_000;          // coalesce rapid events, then rename
const MIN_INTERVAL_MS = 5 * 60 * 1000; // never rename more often than once per 5 min

// ── State ─────────────────────────────────────────────────────────────────────

let _client       = null;   // discord.js Client, captured from init context
let _subCount     = null;   // current known count (null until first API fetch returns)
let _lastRenameAt = 0;      // ms timestamp of last successful rename
let _debounceTimer = null;  // pending debounce timer handle
let _pendingCount  = null;  // count queued for when the timer fires

// ── Helpers ───────────────────────────────────────────────────────────────────

function _formatName(n) {
  return LABEL_PREFIX + Number(n).toLocaleString('en-US');
}

/**
 * Rename the voice channel immediately, unless we're inside the rate-limit
 * window — in which case schedule a retry for when the cooldown expires.
 */
async function _applyRename(count) {
  const now  = Date.now();
  const wait = MIN_INTERVAL_MS - (now - _lastRenameAt);

  if (wait > 0) {
    // Too soon after the last rename — schedule a deferred attempt.
    if (!_debounceTimer) {
      log.info(`[sub-counter] Rate-limit cooldown — will rename in ${Math.ceil(wait / 1000)}s`);
      _pendingCount  = count;
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        const n = _pendingCount;
        _pendingCount = null;
        _applyRename(n).catch(err => log.error('[sub-counter] Deferred rename error:', err.message));
      }, wait);
    } else {
      // Timer already running — just update the queued count.
      _pendingCount = count;
    }
    return;
  }

  if (!_client) {
    log.warn('[sub-counter] Discord client not available — skipping rename');
    return;
  }

  try {
    const channel = await _client.channels.fetch(VOICE_CHANNEL_ID);
    if (!channel) {
      log.warn(`[sub-counter] Voice channel ${VOICE_CHANNEL_ID} not found`);
      return;
    }
    log.info(`[sub-counter] channel found: name="${channel.name}" guildId=${channel.guildId}`);
    log.info(`[sub-counter] bot perms in channel: ${channel.permissionsFor(_client.user)?.toArray().join(', ')}`);
    const newName = _formatName(count);
    log.info(`[sub-counter] guild=${channel.guild?.id} botUser=${_client.user?.id} tag=${_client.user?.tag}`);
    await channel.setName(newName);
    _lastRenameAt = Date.now();
    log.info(`[sub-counter] Voice channel renamed → "${newName}"`);
  } catch (err) {
    log.error('[sub-counter] Failed to rename voice channel:', err.message);
  }
}

/**
 * Debounce wrapper — gift sub bursts fire many events in quick succession.
 * We wait DEBOUNCE_MS of quiet before issuing the rename, always using the
 * latest count.
 */
function _scheduleRename(count) {
  _pendingCount = count;

  if (_debounceTimer) return; // already pending; pendingCount updated above

  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    const n = _pendingCount;
    _pendingCount = null;
    _applyRename(n).catch(err => log.error('[sub-counter] Rename error:', err.message));
  }, DEBOUNCE_MS);
}

/**
 * Fetch the live subscriber count from the YouTube Data API v3.
 * Uses the same env vars as youtube.js. Returns null on any failure.
 */
async function _fetchSubCount() {
  const apiKey    = process.env.YT_API_KEY;
  const channelId = process.env.YT_CHANNEL_ID;

  if (!apiKey || !channelId) {
    log.warn('[sub-counter] YT_API_KEY or YT_CHANNEL_ID not set — cannot fetch initial count');
    return null;
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`;
    const res = await fetch(url);
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
    log.error('[sub-counter] Failed to fetch subscriber count:', err.message);
    return null;
  }
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

function init(context) {
  // Grab the discord.js Client from context.
  // discord.js sets api.client after login; plugins receive that api object as context.
  // Because initPlugins() runs before client.login(), api.client may still be undefined
  // here — we capture the reference and wait for the 'ready' event before using it.
  _client = context?.client ?? null;

  // If the client isn't on context yet, poll briefly — it's set synchronously right
  // after login returns, which is typically <2s after initPlugins is called.
  // We defer our first fetch/rename until the client signals it's ready.
  function _whenReady(cb) {
    if (_client?.isReady?.()) { cb(); return; }
    if (_client) { _client.once('ready', cb); return; }
    // client not on context yet — wait for it to appear (set after login)
    const poll = setInterval(() => {
      if (!context?.client) return;
      _client = context.client;
      clearInterval(poll);
      if (_client.isReady()) cb();
      else _client.once('ready', cb);
    }, 500);
  }

  // Subscribe to the message bus. youtube.js pushes subscriber events via
  // queue.pushMessage({ platform:'youtube', type:'subscribe', username }).
  const queue = require('../../queue');

  if (!queue?.onMessage) {
    log.warn('[sub-counter] queue.onMessage not available — no subscriber events will be received.');
  } else {
    queue.onMessage(msg => {
      if (msg?.platform !== 'youtube' || msg?.type !== 'subscribe') return;

      // Optimistically increment the local count so we don't need an API
      // call per event. If the initial fetch hasn't resolved yet we leave
      // _subCount as null and let the fetch callback handle the first rename.
      if (_subCount !== null) {
        _subCount += 1;
        log.info(
          `[sub-counter] New subscriber: ${msg.username ?? '<anonymous>'} ` +
          `— count now ${_subCount.toLocaleString()}`
        );
        _scheduleRename(_subCount);
      }
    });
  }

  // Fetch the real count and do the first rename once Discord is ready.
  _whenReady(() => {
    _fetchSubCount().then(count => {
      if (count == null) return;
      _subCount = count;
      log.info(`[sub-counter] Initial subscriber count: ${count.toLocaleString()}`);
      _applyRename(count).catch(err => log.error('[sub-counter] Initial rename error:', err.message));
    });
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  id: 'sub-counter',
  init,
  async processMessage(msg) { return { message: msg }; },
};