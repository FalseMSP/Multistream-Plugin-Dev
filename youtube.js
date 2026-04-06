'use strict';

/**
 * YouTube module
 * ──────────────
 * Chat polling strategy (in priority order):
 *
 *  1. YouTube Data API v3  — liveChatMessages.list (5 units/call)
 *     Respects pollingIntervalMillis from each response for minimum delay.
 *     Tracks a rolling quota counter; on 403 quotaExceeded automatically
 *     falls through to masterchat for the rest of the day.
 *
 *  2. masterchat scraper fallback
 *     Used when: quota is exhausted, YT_API_KEY is unset, or the API
 *     returns an unrecoverable error.
 *
 * Other behaviour is unchanged from the original:
 *  • WebSub triggers _startSession() per video
 *  • Watchdog always runs as a safety net
 *  • Exponential back-off on init failures
 *  • Static YT_VIDEO_ID override retries on stream end
 */

const log = require('./logger');

const YT_API_KEY    = process.env.YT_API_KEY       ?? '';
const YT_VIDEO_ID   = process.env.YT_VIDEO_ID      ?? '';
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID    ?? '';
const POLL_INTERVAL = parseInt(process.env.YT_POLL_INTERVAL ?? '30', 10) * 1000;

// ── Quota tracker ─────────────────────────────────────────────────────────
// YouTube quota resets at midnight Pacific. We track usage in-process so we
// can bail out to masterchat before hitting a hard 403 from the API.

const QUOTA_PER_CHAT_CALL = 5;
const QUOTA_DAILY_LIMIT   = parseInt(process.env.YT_QUOTA_LIMIT ?? '100000', 10);

// The full daily limit is available for chat polling — the watchdog uses the
// page scraper exclusively and never touches the Data API.
const QUOTA_CHAT_BUDGET = QUOTA_DAILY_LIMIT;

// Midnight Pacific in ms since epoch — quota resets then.
function _nextMidnightPacific() {
  const now      = new Date();
  // Use a fixed UTC-8 offset so the reset is slightly conservative
  // (we never under-count the reset window, even during daylight saving).
  const offsetMs = 8 * 60 * 60 * 1000;
  const ptNow    = new Date(now.getTime() - offsetMs);
  const midnight = new Date(ptNow);
  midnight.setUTCHours(24, 0, 0, 0);       // next midnight in PT
  return midnight.getTime() + offsetMs;    // convert back to UTC ms
}

let _quotaUsed    = 0;
let _quotaResetAt = _nextMidnightPacific();
let _apiExhausted = false;  // latched true when quota is gone for today

function _consumeQuota(units) {
  const now = Date.now();
  if (now >= _quotaResetAt) {
    _quotaUsed    = 0;
    _apiExhausted = false;
    _quotaResetAt = _nextMidnightPacific();
    log.info('[YouTube] Quota reset (new day). API polling re-enabled.');
  }
  _quotaUsed += units;
  if (_quotaUsed >= QUOTA_CHAT_BUDGET && !_apiExhausted) {
    _apiExhausted = true;
    log.warn(`[YouTube] Quota budget reached (${_quotaUsed}/${QUOTA_CHAT_BUDGET} units used). Switching to masterchat scraper.`);
  }
}

function _hasQuota() {
  // Re-check the reset boundary in case the process crosses midnight
  if (Date.now() >= _quotaResetAt) _consumeQuota(0);
  return !_apiExhausted;
}

// ── Active sessions ───────────────────────────────────────────────────────
// Each entry: { type: 'api'|'masterchat', handle: <stopper|mc instance> }

const _activeSessions = new Map();
const MAX_RETRY_DELAY = 5 * 60 * 1000;

// ── Live Chat ID lookup (costs 1 unit from videos.list) ───────────────────

async function _getLiveChatId(videoId) {
  const { default: fetch } = await import('node-fetch');
  const url  = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${YT_API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  _consumeQuota(1);

  if (!res.ok) {
    throw new Error(`videos API error: ${data?.error?.message ?? res.status}`);
  }
  return data?.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
}

// ── API chat poller ───────────────────────────────────────────────────────

const MIN_POLL_MS = 3_000;
const MAX_POLL_MS = 15_000;

/**
 * Polls liveChatMessages.list, honouring pollingIntervalMillis.
 * Calls onFallback() if quota is exhausted mid-stream.
 * Returns { stop() }.
 */
function _startApiPoller(videoId, liveChatId, queue, onFallback) {
  let pageToken = undefined;  // undefined = first fetch; skip historical messages
  let stopped   = false;
  let timer     = null;

  async function poll() {
    if (stopped) return;

    // Mid-stream quota check
    if (!_hasQuota()) {
      log.warn(`[YouTube] Quota exhausted mid-poll for ${videoId} — handing off to masterchat.`);
      stopped = true;
      onFallback();
      return;
    }

    let nextPollMs = MAX_POLL_MS;

    try {
      const { default: fetch } = await import('node-fetch');
      const params = new URLSearchParams({
        part:       'snippet,authorDetails',
        liveChatId,
        maxResults: '200',
        key:        YT_API_KEY,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });

      const res  = await fetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`);
      const data = await res.json();
      _consumeQuota(QUOTA_PER_CHAT_CALL);

      if (!res.ok) {
        const reason = data?.error?.errors?.[0]?.reason ?? '';
        const msg    = data?.error?.message ?? res.status;

        if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
          _apiExhausted = true;
          log.warn(`[YouTube] API quota/rate-limit for ${videoId} — switching to masterchat.`);
          stopped = true;
          onFallback();
          return;
        }

        if (reason === 'liveChatEnded' || reason === 'liveChatNotFound' || res.status === 404) {
          log.info(`[YouTube] Live chat ended for ${videoId} — stopping API poller.`);
          stopped = true;
          _activeSessions.delete(videoId);
          if (YT_VIDEO_ID) setTimeout(() => _startSession(videoId, queue), 15_000);
          return;
        }

        // Transient error — back off and retry
        log.warn(`[YouTube] liveChatMessages error for ${videoId}: ${msg} — backing off.`);

      } else {
        // Skip message dispatch on the very first page so we don't replay
        // historical chat that was posted before the bot connected.
        if (pageToken !== undefined) {
          for (const item of data.items ?? []) {
            if (item.snippet?.type !== 'textMessageEvent') continue;
            const username = item.authorDetails?.displayName ?? 'unknown';
            const message  = item.snippet?.textMessageDetails?.messageText ?? '';
            if (message) queue.pushMessage({ platform: 'youtube', username, message });
          }
        }

        pageToken  = data.nextPageToken ?? pageToken;
        nextPollMs = Math.max(
          MIN_POLL_MS,
          Math.min(data.pollingIntervalMillis ?? MAX_POLL_MS, MAX_POLL_MS),
        );
      }
    } catch (err) {
      log.error(`[YouTube] API poller fetch error for ${videoId}:`, err.message);
    }

    if (!stopped) timer = setTimeout(poll, nextPollMs);
  }

  poll(); // kick off immediately

  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

// ── masterchat poller ─────────────────────────────────────────────────────

async function _startMasterchat(videoId, queue, retryDelay = 5_000) {
  let Masterchat, stringify;
  try {
    ({ Masterchat, stringify } = require('@stu43005/masterchat'));
  } catch {
    log.error('[YouTube] masterchat not installed — run: npm install @stu43005/masterchat');
    _activeSessions.delete(videoId);
    return;
  }

  log.info(`[YouTube] Starting masterchat for video=${videoId} (retry delay=${retryDelay}ms)`);

  let mc;
  try {
    mc = await Masterchat.init(videoId);
  } catch (err) {
    log.error(`[YouTube] Masterchat init failed for ${videoId}:`, err.message);
    _activeSessions.delete(videoId);
    const nextDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    log.info(`[YouTube] Retrying in ${nextDelay / 1000}s…`);
    setTimeout(() => _startMasterchatSession(videoId, queue, nextDelay), nextDelay);
    return;
  }

  // Update the session slot with the real mc handle now that init succeeded
  _activeSessions.set(videoId, { type: 'masterchat', handle: mc });
  log.info(`[YouTube] masterchat connected for video=${videoId}`);

  mc.on('chat', (chat) => {
    const username = chat.authorName ?? 'unknown';
    const message  = stringify ? stringify(chat.message) : '';
    if (message) queue.pushMessage({ platform: 'youtube', username, message });
  });

  mc.on('end', () => {
    log.info(`[YouTube] masterchat ended for ${videoId}`);
    _activeSessions.delete(videoId);
    if (YT_VIDEO_ID) {
      log.info('[YouTube] Static video override — retrying in 15s…');
      setTimeout(() => _startSession(videoId, queue), 15_000);
    }
  });

  mc.on('error', (err) => {
    log.error(`[YouTube] masterchat error (${videoId}):`, err.message);
    _activeSessions.delete(videoId);
    const nextDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    log.info(`[YouTube] Retrying in ${nextDelay / 1000}s…`);
    setTimeout(() => _startMasterchatSession(videoId, queue, nextDelay), nextDelay);
  });

  mc.listen();
}

// Guards against duplicate sessions before calling _startMasterchat
async function _startMasterchatSession(videoId, queue, retryDelay = 5_000) {
  if (_activeSessions.has(videoId)) return;
  // Reserve the slot immediately so concurrent calls don't double-start
  _activeSessions.set(videoId, { type: 'masterchat', handle: null });
  await _startMasterchat(videoId, queue, retryDelay);
}

// ── Unified session starter ───────────────────────────────────────────────

async function _startSession(videoId, queue, retryDelay = 5_000) {
  if (_activeSessions.has(videoId)) {
    log.info(`[YouTube] Session already active for ${videoId}`);
    return;
  }

  // ── Path 1: YouTube Data API ──────────────────────────────────────────
  if (YT_API_KEY && _hasQuota()) {
    log.info(`[YouTube] Using API chat polling for ${videoId} (quota used: ${_quotaUsed}/${QUOTA_CHAT_BUDGET})`);

    let liveChatId;
    try {
      liveChatId = await _getLiveChatId(videoId);
    } catch (err) {
      log.error(`[YouTube] Could not get liveChatId for ${videoId}:`, err.message);
      const nextDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      log.info(`[YouTube] Retrying in ${nextDelay / 1000}s…`);
      setTimeout(() => _startSession(videoId, queue, nextDelay), nextDelay);
      return;
    }

    if (!liveChatId) {
      log.warn(`[YouTube] No active live chat for ${videoId} — watchdog will retry.`);
      return;
    }

    const poller = _startApiPoller(
      videoId,
      liveChatId,
      queue,
      () => {
        // onFallback: quota ran out mid-stream, hand off to masterchat
        _activeSessions.delete(videoId);
        _startMasterchatSession(videoId, queue);
      },
    );
    _activeSessions.set(videoId, { type: 'api', handle: poller });
    log.info(`[YouTube] API chat poller active for ${videoId}`);
    return;
  }

  // ── Path 2: masterchat scraper ────────────────────────────────────────
  if (!YT_API_KEY) {
    log.info(`[YouTube] No API key — using masterchat for ${videoId}`);
  } else {
    log.info(`[YouTube] Quota exhausted — using masterchat for ${videoId}`);
  }
  await _startMasterchatSession(videoId, queue, retryDelay);
}

// ── Live video detection ──────────────────────────────────────────────────

/**
 * Detects whether the channel is live using only the page scraper.
 * Intentionally never touches the Data API — search.list costs 100 units/call
 * and the watchdog fires every 30 s, which would burn through 100k units in
 * ~8 hours even when you're not streaming. The scraper is good enough for
 * "is stream starting?" detection; the API is reserved for chat polling only.
 */
async function _findLiveVideoId() {
  if (YT_VIDEO_ID) return YT_VIDEO_ID;

  if (YT_CHANNEL_ID) {
    try {
      const { default: fetch } = await import('node-fetch');
      const res  = await fetch(`https://www.youtube.com/channel/${YT_CHANNEL_ID}/live`, {
        headers: { 'Accept-Language': 'en-US,en;q=0.5', 'User-Agent': 'Mozilla/5.0' },
      });
      const text = await res.text();
      const m    = text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
      if (m && (text.includes('isLiveBroadcast') || text.includes('"style":"LIVE"'))) {
        return m[1];
      }
    } catch (err) {
      log.warn('[YouTube] Watchdog scrape failed:', err.message);
    }
  }

  return null;
}

// ── Polling watchdog ──────────────────────────────────────────────────────

async function _watchdog(queue) {
  log.info('[YouTube] Watchdog polling every', POLL_INTERVAL / 1000, 's');
  while (true) {
    try {
      const videoId = await _findLiveVideoId();
      if (videoId && !_activeSessions.has(videoId)) {
        log.info('[YouTube] Live video detected:', videoId);
        _startSession(videoId, queue);
      }
    } catch (err) {
      log.error('[YouTube] Watchdog error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// ── Mod actions ───────────────────────────────────────────────────────────

async function ytBan(_, username) {
  log.warn(`[YouTube] Ban for "${username}" requires OAuth token — see README.`);
  throw new Error('YouTube ban requires OAuth setup (see README)');
}

async function ytVip(_, username) {
  throw new Error('YouTube mod promotion requires OAuth setup (see README)');
}

async function ytUnvip(_, username) {
  throw new Error('YouTube mod removal requires OAuth setup (see README)');
}

// ── Entry point ───────────────────────────────────────────────────────────

async function startYouTube(queue, websubRunning) {
  if (!YT_CHANNEL_ID && !YT_VIDEO_ID) {
    log.warn('[YouTube] No channel/video ID configured — YouTube disabled.');
    return;
  }

  if (YT_API_KEY) {
    // Rough call budget: 4 h stream at ~5 s/call = 2,880 calls = 14,400 units
    log.info(
      `[YouTube] API chat polling enabled. ` +
      `Daily budget: ${QUOTA_CHAT_BUDGET} units ` +
      `(~${Math.floor(QUOTA_CHAT_BUDGET / QUOTA_PER_CHAT_CALL)} calls). ` +
      `masterchat is fallback on exhaustion.`
    );
  } else {
    log.warn('[YouTube] YT_API_KEY not set — masterchat scraper only.');
  }

  if (websubRunning) {
    log.info('[YouTube] WebSub active — watchdog running as safety net alongside it.');
  }

  _watchdog(queue);
}

function triggerVideo(videoId, queue) {
  if (!queue) {
    log.warn('[YouTube] triggerVideo called with null queue — skipping');
    return;
  }
  _startSession(videoId, queue);
}

module.exports = {
  startYouTube,
  triggerVideo,
  modHandlers: {
    ban:   ytBan,
    vip:   ytVip,
    unvip: ytUnvip,
  },
};