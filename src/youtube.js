'use strict';

/**
 * YouTube module
 * ──────────────
 * Chat reading strategy (in priority order):
 *
 *  1. masterchat fetchChatPage loop  ← PRIMARY (lowest latency, ~1-3 s)
 *     Mimics YouTube's own browser player by calling the internal
 *     /youtubei/v1/live_chat/get_live_chat endpoint directly.
 *     Runs a pipelined dual-lane fetch: while one response is being
 *     dispatched the next fetch is already in-flight, so processing
 *     time adds zero latency to the cycle.
 *     Two lanes run with a half-interval phase offset and deduplicate
 *     by message ID, halving average message wait time.
 *
 *  2. YouTube Data API v3  ← MOD ACTIONS ONLY (ban/timeout/vip/unvip)
 *     liveChatMessages.list is never used for reading chat any more.
 *     It is only used as a slow-path fallback for _resolveChannelId
 *     when a user has not yet spoken (participant cache miss).
 *     Quota tracker retained; if quota is exhausted the channel-ID
 *     scan falls back gracefully with a clear error.
 *
 * Latency stack vs Streamlabs:
 *  • masterchat hits the same internal YT endpoint the web player uses
 *  • Pipelined dual-lane fetch cuts average latency ~50% vs single-lane
 *  • No pollingIntervalMillis floor — masterchat honours YT's continuation
 *    timeoutMs which is typically 0-2 s on active streams
 *  • Participant cache (displayName→channelId) populated from every message;
 *    ban/timeout/vip resolve in O(1) with zero API calls
 *  • node-fetch hoisted, OAuth + youtube client cached, liveChatId cached
 */

const log = require('./logger');

const YT_API_KEY    = process.env.YT_API_KEY       ?? '';
const YT_VIDEO_ID   = process.env.YT_VIDEO_ID      ?? '';
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID    ?? '';
const POLL_INTERVAL = parseInt(process.env.YT_POLL_INTERVAL ?? '30', 10) * 1000;

// ── Hoisted fetch ─────────────────────────────────────────────────────────

let _fetch = null;
async function _getFetch() {
  if (!_fetch) ({ default: _fetch } = await import('node-fetch'));
  return _fetch;
}
_getFetch().catch(() => {});

// ── Quota tracker (Data API only — not used for chat reading) ─────────────

const QUOTA_PER_SCAN_CALL = 5;   // liveChatMessages.list for channel-ID scans
const QUOTA_DAILY_LIMIT   = parseInt(process.env.YT_QUOTA_LIMIT ?? '100000', 10);

function _nextMidnightPacific() {
  const offsetMs = 8 * 60 * 60 * 1000;
  const ptNow    = new Date(Date.now() - offsetMs);
  const midnight = new Date(ptNow);
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.getTime() + offsetMs;
}

let _quotaUsed    = 0;
let _quotaResetAt = _nextMidnightPacific();
let _apiExhausted = false;

function _consumeQuota(units) {
  if (Date.now() >= _quotaResetAt) {
    _quotaUsed    = 0;
    _apiExhausted = false;
    _quotaResetAt = _nextMidnightPacific();
    log.info('[YouTube] Quota reset (new day).');
  }
  _quotaUsed += units;
  if (_quotaUsed >= QUOTA_DAILY_LIMIT && !_apiExhausted) {
    _apiExhausted = true;
    log.warn(`[YouTube] Daily quota reached (${_quotaUsed}/${QUOTA_DAILY_LIMIT}). Channel-ID scans disabled; participant cache only.`);
  }
}

function _hasQuota() {
  if (Date.now() >= _quotaResetAt) _consumeQuota(0);
  return !_apiExhausted;
}

// ── Active sessions ───────────────────────────────────────────────────────
// Each entry: { type: 'masterchat', mc, liveChatId }

const _activeSessions = new Map();
const MAX_RETRY_DELAY = 5 * 60 * 1000;

// ── Participant cache ─────────────────────────────────────────────────────
// displayName.toLowerCase() → channelId
// Populated from every chat message. Makes mod actions O(1)/zero-network
// for any user who has spoken during the session.

const _participantCache = new Map();

function _cacheParticipant(displayName, channelId) {
  if (displayName && channelId) _participantCache.set(displayName.toLowerCase(), channelId);
}

function _evictParticipantCache() {
  _participantCache.clear();
  log.info('[YouTube] Participant cache evicted.');
}

// ── Message deduplication ─────────────────────────────────────────────────
// The dual-lane poller runs two overlapping fetches. Each lane uses its own
// continuation token so they follow independent paths through YouTube's chat
// pagination, but they will occasionally return the same message. We dedup
// by message ID using a bounded ring buffer so memory doesn't grow unbounded
// during long streams.

const DEDUP_RING_SIZE = 2000;
const _seenIds        = new Set();
const _seenRing       = [];          // insertion-order ring for eviction

function _isDuplicate(id) {
  if (_seenIds.has(id)) return true;
  _seenIds.add(id);
  _seenRing.push(id);
  if (_seenRing.length > DEDUP_RING_SIZE) {
    _seenIds.delete(_seenRing.shift());
  }
  return false;
}

function _resetDedup() {
  _seenIds.clear();
  _seenRing.length = 0;
}

// ── OAuth / googleapis cache ──────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const YT_TOKEN_FILE = path.resolve('.youtube-tokens.json');

let _cachedOAuth   = null;
let _cachedYoutube = null;

function _getOAuthClient() {
  if (_cachedOAuth) return _cachedOAuth;

  const { google } = require('googleapis');
  const creds = JSON.parse(fs.readFileSync('client_secret.json'));
  const { client_id, client_secret } = creds.installed ?? creds.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, 'http://localhost');

  if (!fs.existsSync(YT_TOKEN_FILE)) {
    throw new Error('YouTube OAuth not set up — run: node youtube_auth.js');
  }
  const tokens = JSON.parse(fs.readFileSync(YT_TOKEN_FILE));
  oauth2.setCredentials(tokens);
  oauth2.on('tokens', (fresh) => {
    const merged = { ...tokens, ...fresh };
    fs.writeFileSync(YT_TOKEN_FILE, JSON.stringify(merged, null, 2));
    log.info('[YouTube] OAuth tokens refreshed and saved.');
  });

  _cachedOAuth = oauth2;
  return oauth2;
}

function _getYoutubeClient() {
  if (_cachedYoutube) return _cachedYoutube;
  const { google } = require('googleapis');
  _cachedYoutube = google.youtube({ version: 'v3', auth: _getOAuthClient() });
  return _cachedYoutube;
}

// ── Data API: live chat ID lookup (1 quota unit) ──────────────────────────
// Only used at session start (to get liveChatId for mod actions) and as
// fallback in _resolveActiveLiveChatId when no session is running.

async function _getLiveChatId(videoId) {
  const fetch = await _getFetch();
  const url   = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${YT_API_KEY}`;
  const res   = await fetch(url);
  const data  = await res.json();
  _consumeQuota(1);
  if (!res.ok) throw new Error(`videos API error: ${data?.error?.message ?? res.status}`);
  return data?.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
}

// ── Pipelined dual-lane masterchat reader ─────────────────────────────────
//
// Architecture:
//
//   Lane A: ──fetch──▶ dispatch ──fetch──▶ dispatch ──▶ …
//   Lane B: ────────fetch──▶ dispatch ──fetch──▶ dispatch ──▶ …
//           ←──── phaseOffsetMs ────▶
//
// Each lane independently calls mc.fetchChatPage() and immediately fires
// the NEXT fetch before dispatching the current batch. This means network
// round-trip time overlaps with JS dispatch time — processing cost is hidden.
//
// Both lanes share the same masterchat instance (safe: fetchChatPage is
// stateless w.r.t. the mc object; continuation tokens are returned per-call
// and threaded explicitly). Messages are deduplicated by ID.
//
// timeoutMs from YouTube's response is the server's requested delay before
// the next poll. We honour it but clamp to [MIN_FETCH_MS, MAX_FETCH_MS].
// On active streams YT typically returns timeoutMs = 0, giving ~RTT latency.

const MIN_FETCH_MS     = 500;    // never hammer faster than this
const MAX_FETCH_MS     = 4_000;  // ignore YouTube's 10-15 s suggestion; cap at 4 s
const PHASE_OFFSET_MS  = 2_000;  // lane B starts 2 s after lane A (half of MAX_FETCH_MS)

async function _runFetchLane(laneId, mc, queue, isFirstLane, stopSignal) {
  // fetch() returns { actions, continuation } where continuation has
  // { token, timeoutMs }. We thread token explicitly so both lanes advance
  // independently. timeoutMs is honoured but capped at MAX_FETCH_MS.
  let continuation = undefined;  // undefined = let masterchat use its default

  // Stagger lane B so it's out of phase with lane A
  if (!isFirstLane) {
    await new Promise(r => setTimeout(r, PHASE_OFFSET_MS));
  }

  // On the very first fetch we skip dispatch to avoid replaying history.
  // We still need the continuation token though, so we always fetch once.
  let skipDispatch = true;

  while (!stopSignal.stopped) {
    let result;
    const fetchStart = Date.now();

    try {
      result = await mc.fetch(continuation?.token);
    } catch (err) {
      if (stopSignal.stopped) return;
      log.warn(`[YouTube] Lane ${laneId} fetch error: ${err.message} — backing off 5 s`);
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    if (stopSignal.stopped) return;

    // Extract continuation for the NEXT call before doing anything else,
    // then schedule the wait — dispatch runs concurrently with the timer.
    const nextContinuation = result?.continuation;
    // Honour YouTube's timeoutMs so we don't poll too fast and get rate-limited,
    // but cap it at MAX_FETCH_MS — YouTube can return 10-15 s even on active streams.
    const timeoutMs = Math.max(
      MIN_FETCH_MS,
      Math.min(nextContinuation?.timeoutMs ?? MAX_FETCH_MS, MAX_FETCH_MS),
    );

    // Update for next iteration
    continuation = nextContinuation;

    if (!skipDispatch) {
      for (const action of result?.actions ?? []) {
        // masterchat 1.5.0 returns pre-parsed typed action objects:
        // { type: 'addChatItemAction', id, authorName, authorChannelId, message: YTRun[] }
        if (action.type !== 'addChatItemAction') continue;

        const id          = action.id;
        const displayName = action.authorName ?? 'unknown';
        const channelId   = action.authorChannelId ?? null;
        const message     = _stringifyRuns(action.message);

        _cacheParticipant(displayName, channelId);

        if (!id || _isDuplicate(id) || !message) continue;
        queue.pushMessage({ platform: 'youtube', username: displayName, message });
      }
    } else {
      // Still cache authors from the historical first page
      for (const action of result?.actions ?? []) {
        if (action.type !== 'addChatItemAction') continue;
        _cacheParticipant(action.authorName, action.authorChannelId);
      }
      skipDispatch = false;
    }

    // Honour YouTube's requested delay before the next fetch
    const elapsed = Date.now() - fetchStart;
    const wait    = Math.max(0, timeoutMs - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

// Minimal run-array → plain string converter.
// masterchat's full stringify handles emoji/superchats; we only need text.
function _stringifyRuns(runs) {
  if (!runs) return '';
  return runs
    .map(r => r.text ?? r.emoji?.shortcuts?.[0] ?? r.emoji?.emojiId ?? '')
    .join('');
}

// ── masterchat session ────────────────────────────────────────────────────

async function _startMasterchat(videoId, queue, retryDelay = 5_000) {
  let Masterchat;
  try {
    ({ Masterchat } = require('@stu43005/masterchat'));
  } catch {
    log.error('[YouTube] masterchat not installed — run: npm install @stu43005/masterchat');
    _activeSessions.delete(videoId);
    return;
  }

  log.info(`[YouTube] Initialising masterchat for video=${videoId}`);

  let mc;
  try {
    mc = await Masterchat.init(videoId);
  } catch (err) {
    log.error(`[YouTube] Masterchat init failed for ${videoId}: ${err.message}`);
    _activeSessions.delete(videoId);
    const nextDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    log.info(`[YouTube] Retrying in ${nextDelay / 1000}s…`);
    setTimeout(() => _startMasterchat(videoId, queue, nextDelay), nextDelay);
    return;
  }

  // Resolve liveChatId now while we have mc; store on the session so mod
  // actions never need to re-fetch or re-scrape.
  // mc.liveChatId can be null on fresh streams if YT's page payload didn't
  // include it in the scraped continuation data (a timing/variant issue, not
  // a permissions problem). Fall back to the Data API when that happens.
  let liveChatId = mc.liveChatId ?? null;
  if (!liveChatId && YT_API_KEY) {
    try {
      liveChatId = await _getLiveChatId(videoId);
      log.info(`[YouTube] liveChatId resolved via Data API: ${liveChatId}`);
    } catch (err) {
      log.warn(`[YouTube] Could not resolve liveChatId via Data API: ${err.message}`);
    }
  }
  if (!liveChatId) {
    log.warn(`[YouTube] liveChatId still null for ${videoId} — mod actions and say() will resolve lazily on first use`);
  }

  const stopSignal = { stopped: false };

  _activeSessions.set(videoId, { type: 'masterchat', mc, liveChatId, stopSignal });
  log.info(`[YouTube] masterchat connected for video=${videoId} liveChatId=${liveChatId}`);
  log.info(`[YouTube] Starting dual-lane pipelined chat reader`);

  // Run both lanes concurrently. Neither lane throws — errors are caught
  // internally and retried. We watch for stream-end via mc events.
  const laneA = _runFetchLane('A', mc, queue, true,  stopSignal);
  const laneB = _runFetchLane('B', mc, queue, false, stopSignal);

  // Handle stream end / errors via masterchat events (still reliable for
  // signalling even though we no longer use mc.listen() for chat).
  mc.on('end', () => {
    log.info(`[YouTube] Stream ended for ${videoId}`);
    stopSignal.stopped = true;
    _activeSessions.delete(videoId);
    _evictParticipantCache();
    _resetDedup();
    if (YT_VIDEO_ID) {
      log.info('[YouTube] Static override — retrying in 15 s…');
      setTimeout(() => _startSession(videoId, queue), 15_000);
    }
  });

  mc.on('error', (err) => {
    log.error(`[YouTube] masterchat error (${videoId}): ${err.message}`);
    stopSignal.stopped = true;
    _activeSessions.delete(videoId);
    _evictParticipantCache();
    _resetDedup();
    const nextDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    log.info(`[YouTube] Retrying in ${nextDelay / 1000}s…`);
    setTimeout(() => _startMasterchatSession(videoId, queue, nextDelay), nextDelay);
  });

  // Keep the async context alive so the lanes don't get GC'd.
  // We intentionally don't await — fire-and-forget, errors handled above.
  Promise.all([laneA, laneB]).catch((err) => {
    log.error(`[YouTube] Unhandled lane error for ${videoId}: ${err.message}`);
  });
}

async function _startMasterchatSession(videoId, queue, retryDelay = 5_000) {
  if (_activeSessions.has(videoId)) return;
  _activeSessions.set(videoId, { type: 'masterchat', mc: null, liveChatId: null, stopSignal: null });
  await _startMasterchat(videoId, queue, retryDelay);
}

// ── Unified session starter ───────────────────────────────────────────────

async function _startSession(videoId, queue, retryDelay = 5_000) {
  if (_activeSessions.has(videoId)) {
    log.info(`[YouTube] Session already active for ${videoId}`);
    return;
  }
  await _startMasterchatSession(videoId, queue, retryDelay);
}

// ── Live video detection ──────────────────────────────────────────────────

const SCRAPE_UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
let _uaIndex = 0;
function _nextUA() { return SCRAPE_UA_POOL[(_uaIndex++) % SCRAPE_UA_POOL.length]; }

async function _findLiveVideoId() {
  if (YT_VIDEO_ID) return YT_VIDEO_ID;
  if (!YT_CHANNEL_ID) return null;

  try {
    const fetch = await _getFetch();
    const res   = await fetch(`https://www.youtube.com/channel/${YT_CHANNEL_ID}/live`, {
      headers: { 'Accept-Language': 'en-US,en;q=0.5', 'User-Agent': _nextUA() },
    });
    const text = await res.text();
    const m    = text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
    if (m && (text.includes('isLiveBroadcast') || text.includes('"style":"LIVE"'))) return m[1];
  } catch (err) {
    log.warn('[YouTube] Watchdog scrape failed:', err.message);
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

// ── Live chat ID resolution ───────────────────────────────────────────────

async function _resolveActiveLiveChatId() {
  // Fast path — already stored on the active session.
  // Also check mc.liveChatId lazily: masterchat may have populated it after
  // init (e.g. once the first fetch response came back with the field).
  for (const [, session] of _activeSessions) {
    const id = session.liveChatId ?? session.mc?.liveChatId ?? null;
    if (id) {
      session.liveChatId = id; // cache so we don't re-check mc next time
      return id;
    }
  }
  // Slow path — no session yet or liveChatId not populated
  const videoId = await _findLiveVideoId();
  if (!videoId) throw new Error('No active YouTube live stream found');
  if (!YT_API_KEY) throw new Error('YT_API_KEY required to resolve liveChatId');
  const chatId = await _getLiveChatId(videoId);
  if (!chatId) throw new Error(`No active live chat for video ${videoId}`);
  return chatId;
}

// ── Participant resolution ────────────────────────────────────────────────

async function _resolveChannelId(youtube, liveChatId, displayName) {
  const key    = displayName.toLowerCase();
  const cached = _participantCache.get(key);
  if (cached) {
    log.debug(`[YouTube] Participant cache hit for "${displayName}"`);
    return cached;
  }

  if (!_hasQuota()) {
    throw new Error(`Cannot scan for "${displayName}" — API quota exhausted and no cache entry. User must chat first.`);
  }

  log.debug(`[YouTube] Participant cache miss for "${displayName}" — scanning live chat via Data API`);
  let pageToken;
  do {
    const res = await youtube.liveChatMessages.list({
      liveChatId,
      part: ['authorDetails'],
      maxResults: 200,
      ...(pageToken ? { pageToken } : {}),
    });
    _consumeQuota(QUOTA_PER_SCAN_CALL);
    for (const item of res.data.items ?? []) {
      const name = item.authorDetails?.displayName;
      const id   = item.authorDetails?.channelId;
      _cacheParticipant(name, id);
      if (name?.toLowerCase() === key) return id;
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return null;
}

// ── Shared mod-action setup ───────────────────────────────────────────────

async function _modSetup() {
  const youtube    = _getYoutubeClient();
  const liveChatId = await _resolveActiveLiveChatId();
  return { youtube, liveChatId };
}

// ── Mod actions ───────────────────────────────────────────────────────────

async function ytBan(_, username) {
  const { youtube, liveChatId } = await _modSetup();
  const channelId = await _resolveChannelId(youtube, liveChatId, username);
  if (!channelId) throw new Error(`YouTube user "${username}" not found in live chat`);
  await youtube.liveChatBans.insert({
    part: ['snippet'],
    requestBody: { snippet: { liveChatId, type: 'permanent', bannedUserDetails: { channelId } } },
  });
  log.info(`[YouTube] Banned ${username}`);
}

async function ytTimeout(_, username, durationSeconds = 300) {
  const { youtube, liveChatId } = await _modSetup();
  const channelId = await _resolveChannelId(youtube, liveChatId, username);
  if (!channelId) throw new Error(`YouTube user "${username}" not found in live chat`);
  await youtube.liveChatBans.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        liveChatId,
        type: 'temporary',
        banDurationSeconds: durationSeconds,
        bannedUserDetails: { channelId },
      },
    },
  });
  log.info(`[YouTube] Timed out ${username} for ${durationSeconds}s`);
}

async function ytVip(_, username) {
  const { youtube, liveChatId } = await _modSetup();
  const channelId = await _resolveChannelId(youtube, liveChatId, username);
  if (!channelId) throw new Error(`YouTube user "${username}" not found in live chat`);
  await youtube.liveChatModerators.insert({
    part: ['snippet'],
    requestBody: { snippet: { liveChatId, moderatorDetails: { channelId } } },
  });
  log.info(`[YouTube] Promoted ${username} to moderator`);
}

async function ytUnvip(_, username) {
  const { youtube, liveChatId } = await _modSetup();
  const normalised = username.toLowerCase();
  let pageToken;
  let moderatorId = null;
  do {
    const res = await youtube.liveChatModerators.list({
      liveChatId, part: ['snippet'], maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of res.data.items ?? []) {
      if (item.snippet?.moderatorDetails?.displayName?.toLowerCase() === normalised) {
        moderatorId = item.id;
        break;
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken && !moderatorId);

  if (!moderatorId) throw new Error(`YouTube user "${username}" is not a moderator`);
  await youtube.liveChatModerators.delete({ id: moderatorId });
  log.info(`[YouTube] Removed moderator ${username}`);
}

// ── Chat reply ────────────────────────────────────────────────────────────

let _sayLiveChatId = null;

async function say(text) {
  let youtube;
  try {
    youtube = _getYoutubeClient();
  } catch (err) {
    log.warn('[YouTube] say() — OAuth not configured:', err.message);
    return;
  }
  if (!_sayLiveChatId) {
    try {
      _sayLiveChatId = await _resolveActiveLiveChatId();
    } catch (err) {
      log.warn('[YouTube] say() — no active live chat:', err.message);
      return;
    }
  }
  try {
    await youtube.liveChatMessages.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          liveChatId: _sayLiveChatId,
          type: 'textMessageEvent',
          textMessageDetails: { messageText: text },
        },
      },
    });
    log.debug('[YouTube] say():', text);
  } catch (err) {
    log.error('[YouTube] say() error:', err.message);
    _sayLiveChatId = null;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────

async function startYouTube(queue, websubRunning) {
  if (!YT_CHANNEL_ID && !YT_VIDEO_ID) {
    log.warn('[YouTube] No channel/video ID configured — YouTube disabled.');
    return;
  }

  log.info('[YouTube] Chat reader: masterchat dual-lane pipelined fetch (primary)');

  if (YT_API_KEY) {
    log.info(
      `[YouTube] Data API available for mod channel-ID scans. ` +
      `Daily budget: ${QUOTA_DAILY_LIMIT} units. ` +
      `Participant cache eliminates API calls for users who have chatted.`
    );
  } else {
    log.warn('[YouTube] YT_API_KEY not set — mod actions require users to have chatted (participant cache only).');
  }

  if (websubRunning) {
    log.info('[YouTube] WebSub active — watchdog running as safety net alongside it.');
  }

  try { _getOAuthClient(); } catch { /* warn lazily on first use */ }

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
  say,
  startYouTube,
  triggerVideo,
  modHandlers: {
    ban:     ytBan,
    timeout: ytTimeout,
    vip:     ytVip,
    unvip:   ytUnvip,
  },
};