'use strict';

/**
 * YouTube module
 * ──────────────
 * Chat reading strategy (in priority order):
 *
 * 1. masterchat fetchChatPage loop  ← PRIMARY (lowest latency, ~1-3 s)
 * Mimics YouTube's own browser player by calling the internal
 * /youtubei/v1/live_chat/get_live_chat endpoint directly.
 * Runs a pipelined dual-lane fetch: while one response is being
 * dispatched the next fetch is already in-flight, so processing
 * time adds zero latency to the cycle.
 * Two lanes run with a half-interval phase offset and deduplicate
 * by message ID, halving average message wait time.
 *
 * 2. YouTube Data API v3  ← MOD ACTIONS ONLY (ban/timeout/vip/unvip)
 * liveChatMessages.list is never used for reading chat any more.
 * It is only used as a slow-path fallback for _resolveChannelId
 * when a user has not yet spoken (participant cache miss).
 * Quota tracker retained; if quota is exhausted the channel-ID
 * scan falls back gracefully with a clear error.
 *
 * Env vars:
 *   YT_POLL_INTERVAL      — watchdog scrape interval in seconds (default: 30; no quota cost)
 *   YT_LIKE_POLL_INTERVAL — like count Data API poll in seconds (default: 60; min clamped to 30)
 *   YT_SUB_POLL_INTERVAL  — subscriber count Data API poll in seconds (default: 60; min clamped to 30)
 *   YT_QUOTA_LIMIT        — daily Data API quota budget (default: 100000)
 */

const log = require('./logger');

const YT_API_KEY    = process.env.YT_API_KEY       ?? '';
const YT_VIDEO_ID   = process.env.YT_VIDEO_ID      ?? '';
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID    ?? '';
const POLL_INTERVAL      = parseInt(process.env.YT_POLL_INTERVAL      ?? '30', 10) * 1000;
const LIKE_POLL_INTERVAL = parseInt(process.env.YT_LIKE_POLL_INTERVAL ?? '60', 10) * 1000;
const SUB_POLL_INTERVAL  = parseInt(process.env.YT_SUB_POLL_INTERVAL  ?? '60', 10) * 1000;

// Sanity-clamp pollers that hit the Data API to avoid quota blowout
// (watchdog uses a scrape, not the API, so POLL_INTERVAL can be lower)
const _LIKE_POLL_MS = Math.max(LIKE_POLL_INTERVAL, 30_000);  // floor 30 s
const _SUB_POLL_MS  = Math.max(SUB_POLL_INTERVAL,  30_000);  // floor 30 s

// ── Hoisted fetch ─────────────────────────────────────────────────────────

let _fetch = null;
async function _getFetch() {
  if (!_fetch) ({ default: _fetch } = await import('node-fetch'));
  return _fetch;
}
_getFetch().catch(() => {});

// ── Quota tracker (Data API only — not used for chat reading) ─────────────

const QUOTA_PER_SCAN_CALL = 5;   
const QUOTA_DAILY_LIMIT   = parseInt(process.env.YT_QUOTA_LIMIT ?? '100000', 10);

function _nextMidnightPacific() {
  // Use Intl to get the current wall-clock time in America/Los_Angeles so that
  // DST is handled correctly (UTC-8 in PST, UTC-7 in PDT).
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value, 10);
  const m = parseInt(parts.find(p => p.type === 'month').value, 10) - 1;
  const d = parseInt(parts.find(p => p.type === 'day').value, 10);
  // Midnight of the *next* day in Pacific time, expressed as a UTC timestamp
  const nextMidnightPT = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(Date.UTC(y, m, d + 1, 8, 0, 0))) // noon UTC as a safe seed
  );
  // Build midnight Pacific as a real UTC ms value via a known offset-aware string
  const seed = new Date(Date.UTC(y, m, d + 1, 12, 0, 0)); // noon UTC next day (always unambiguous)
  const ptString = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(seed); // "YYYY-MM-DD HH:MM:SS" in Pacific
  const ptMidnight = ptString.slice(0, 10) + ' 00:00:00';
  // Convert that Pacific midnight string back to UTC by finding the offset
  const utcGuess = new Date(ptMidnight + 'Z'); // wrong — treats as UTC, gives us the number to correct
  const actualPtOffset = (seed.getTime() - new Date(
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(seed) + 'Z'
  ).getTime());
  return utcGuess.getTime() + actualPtOffset;
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
// Holds per-session state for participant caches, dedup, and timers

const _activeSessions = new Map();
const MAX_RETRY_DELAY = 5 * 60 * 1000;

function _createSession(videoId) {
  return {
    type: 'masterchat',
    mc: null,
    liveChatId: null,
    stopSignal: { stopped: false },
    participantCache: new Map(),
    dedup: {
      seenIds: new Set(),
      seenRing: []
    },
    likePollerTimer: null,
    lastKnownLikeCount: null
  };
}

// ── Per-Session Helpers ───────────────────────────────────────────────────

function _cacheParticipant(session, displayName, channelId) {
  if (displayName && channelId) {
    session.participantCache.set(displayName.toLowerCase(), channelId);
  }
}

const DEDUP_RING_SIZE = 2000;

function _isDuplicate(session, id) {
  const { seenIds, seenRing } = session.dedup;
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  seenRing.push(id);
  if (seenRing.length > DEDUP_RING_SIZE) {
    seenIds.delete(seenRing.shift());
  }
  return false;
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

async function _getLiveChatId(videoId) {
  if (!_hasQuota()) {
    log.warn('[YouTube] _getLiveChatId skipped — quota exhausted');
    return null;
  }
  const fetch = await _getFetch();
  const url   = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${YT_API_KEY}`;
  const res   = await fetch(url);
  const data  = await res.json();
  _consumeQuota(1);
  if (!res.ok) throw new Error(`videos API error: ${data?.error?.message ?? res.status}`);
  return data?.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
}

// ── Pipelined dual-lane masterchat reader ─────────────────────────────────

const MIN_FETCH_MS     = 500;
const MAX_FETCH_MS     = 4_000;
const PHASE_OFFSET_MS  = 2_000;

async function _runFetchLane(laneId, videoId, session, queue, isFirstLane) {
  let continuation = undefined;
  if (!isFirstLane) await new Promise(r => setTimeout(r, PHASE_OFFSET_MS));

  let skipDispatch = true;
  let _fetchWarnCount = 0;

  while (!session.stopSignal.stopped) {
    let result;
    const fetchStart = Date.now();

    try {
      result = await session.mc.fetch(continuation?.token);
    } catch (err) {
      if (session.stopSignal.stopped) return;

      if (
        /chat is disabled for this live stream/i.test(err.message) ||
        /this live event has ended/i.test(err.message) ||
        /no longer live/i.test(err.message)
      ) {
        log.info(`[YouTube] Lane ${laneId}: stream ended (${err.message}) — stopping lane`);
        session.stopSignal.stopped = true;
        if (session.likePollerTimer) clearInterval(session.likePollerTimer);
        if (_activeSessions.get(videoId) === session) _activeSessions.delete(videoId);
        return;
      }

      if (++_fetchWarnCount % 12 === 1) {
        log.warn(`[YouTube] Lane ${laneId} fetch error: ${err.message} — backing off 5 s`);
      }
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    if (session.stopSignal.stopped) return;

    const nextContinuation = result?.continuation;
    const timeoutMs = Math.max(
      MIN_FETCH_MS,
      Math.min(nextContinuation?.timeoutMs ?? MAX_FETCH_MS, MAX_FETCH_MS),
    );

    continuation = nextContinuation;

    if (!skipDispatch) {
      for (const action of result?.actions ?? []) {
        if (
          action.type === 'addMembershipItemAction' ||
          action.type === 'addMembershipMilestoneItemAction' ||
          action.type === 'membershipGiftPurchaseAction'
        ) {
          const id = action.id;
          if (id && _isDuplicate(session, id)) continue;

          const displayName = action.authorName ?? null;
          const channelId   = action.authorChannelId ?? null;
          _cacheParticipant(session, displayName, channelId);

          const giftCount = action.type === 'membershipGiftPurchaseAction' ? (action.amount ?? 1) : 1;
          _namedSubThisCycle += giftCount;

          log.info(
            `[YouTube] Subscriber event: type=${action.type}` +
            (displayName ? ` user="${displayName}"` : ' user=<anonymous>') +
            (giftCount > 1 ? ` x${giftCount}` : '')
          );

          for (let i = 0; i < giftCount; i++) {
            queue.pushMessage({ platform: 'youtube', type: 'subscribe', username: displayName ?? null });
          }
          continue;
        }

        if (action.type !== 'addChatItemAction') continue;

        const id          = action.id;
        const displayName = action.authorName ?? 'unknown';
        const channelId   = action.authorChannelId ?? null;
        const message     = _stringifyRuns(action.message);

        _cacheParticipant(session, displayName, channelId);

        if (!id || _isDuplicate(session, id) || !message) continue;
        const ytEmotes = _extractYtEmotes(action.message);
        queue.pushMessage({ platform: 'youtube', videoId, username: displayName, channelId, message, ytEmotes: ytEmotes.length ? ytEmotes : undefined });
      }
    } else {
      for (const action of result?.actions ?? []) {
        if (action.type !== 'addChatItemAction') continue;
        _cacheParticipant(session, action.authorName, action.authorChannelId);
      }
      skipDispatch = false;
    }

    const elapsed = Date.now() - fetchStart;
    const wait    = Math.max(0, timeoutMs - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

function _stringifyRuns(runs) {
  if (!runs) return '';
  return runs
    .map(r => r.text ?? r.emoji?.shortcuts?.[0] ?? r.emoji?.emojiId ?? '')
    .join('');
}

/**
 * Extract structured emoji segments from masterchat runs for the overlay renderer.
 * Returns an array in the same format index.js passes as ytEmotes:
 *   { url, altText, startIndex, endIndex }
 * Only emojis with image URLs are included; plain text runs are skipped.
 */
function _extractYtEmotes(runs) {
  if (!runs) return [];
  const emotes = [];
  let charPos = 0;
  for (const r of runs) {
    if (r.text) {
      charPos += r.text.length;
    } else if (r.emoji) {
      const imgUrl = r.emoji.image?.thumbnails?.[0]?.url ?? null;
      const alt    = r.emoji.shortcuts?.[0] ?? r.emoji.emojiId ?? '';
      const len    = alt.length || 1;
      if (imgUrl) {
        emotes.push({ url: imgUrl, altText: alt, startIndex: charPos, endIndex: charPos + len });
      }
      charPos += len;
    }
  }
  return emotes;
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

  let liveChatId = mc.liveChatId ?? null;
  if (!liveChatId && YT_API_KEY) {
    try {
      liveChatId = await _getLiveChatId(videoId);
      log.info(`[YouTube] liveChatId resolved via Data API: ${liveChatId}`);
    } catch (err) {
      log.warn(`[YouTube] Could not resolve liveChatId via Data API: ${err.message}`);
    }
  }

  const session = _activeSessions.get(videoId);
  session.mc = mc;
  session.liveChatId = liveChatId;

  log.info(`[YouTube] masterchat connected for video=${videoId} liveChatId=${liveChatId}`);
  log.info(`[YouTube] Starting dual-lane pipelined chat reader`);
  _startLikePoller(videoId, session, queue);

  const laneA = _runFetchLane('A', videoId, session, queue, true);
  const laneB = _runFetchLane('B', videoId, session, queue, false);

  mc.on('end', () => {
    log.info(`[YouTube] Stream ended for ${videoId}`);
    const activeSession = _activeSessions.get(videoId);
    if (activeSession) {
      activeSession.stopSignal.stopped = true;
      if (activeSession.likePollerTimer) clearInterval(activeSession.likePollerTimer);
      _activeSessions.delete(videoId);
    }
    
    if (YT_VIDEO_ID === videoId) {
      log.info('[YouTube] Static override — retrying in 15 s…');
      setTimeout(() => _startSession(videoId, queue), 15_000);
    }
  });

  mc.on('error', (err) => {
    log.error(`[YouTube] masterchat error (${videoId}): ${err.message}`);
    const activeSession = _activeSessions.get(videoId);
    if (activeSession) {
      activeSession.stopSignal.stopped = true;
      if (activeSession.likePollerTimer) clearInterval(activeSession.likePollerTimer);
      _activeSessions.delete(videoId);
    }

    const nextDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    log.info(`[YouTube] Retrying in ${nextDelay / 1000}s…`);
    setTimeout(() => _startMasterchat(videoId, queue, nextDelay), nextDelay);
  });

  Promise.all([laneA, laneB]).catch((err) => {
    log.error(`[YouTube] Unhandled lane error for ${videoId}: ${err.message}`);
  });
}

async function _startMasterchatSession(videoId, queue, retryDelay = 5_000) {
  if (_activeSessions.has(videoId) && _activeSessions.get(videoId).mc) return;
  if (!_activeSessions.has(videoId)) {
    _activeSessions.set(videoId, _createSession(videoId));
  }
  await _startMasterchat(videoId, queue, retryDelay);
}

// ── Unified session starter ───────────────────────────────────────────────

async function _startSession(videoId, queue, retryDelay = 5_000) {
  if (_activeSessions.has(videoId) && _activeSessions.get(videoId).mc) {
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

// ── Participant resolution ────────────────────────────────────────────────

async function _resolveChannelId(youtube, session, displayName) {
  const key    = displayName.toLowerCase();
  const cached = session.participantCache.get(key);
  if (cached) {
    log.debug(`[YouTube] Participant cache hit for "${displayName}"`);
    return cached;
  }

  if (!_hasQuota() || !session.liveChatId) {
    log.debug(`[YouTube] Cannot scan for "${displayName}" — API quota exhausted or liveChatId missing.`);
    return null;
  }

  log.debug(`[YouTube] Participant cache miss for "${displayName}" — scanning live chat via Data API`);
  // Cap at 5 pages (1000 messages, 25 quota units) to prevent runaway scans on busy chats
  const MAX_SCAN_PAGES = 5;
  let pageToken;
  let pagesScanned = 0;
  do {
    if (!_hasQuota()) {
      log.warn(`[YouTube] _resolveChannelId: quota exhausted mid-scan for "${displayName}"`);
      break;
    }
    const res = await youtube.liveChatMessages.list({
      liveChatId: session.liveChatId,
      part: ['authorDetails'],
      maxResults: 200,
      ...(pageToken ? { pageToken } : {}),
    });
    _consumeQuota(QUOTA_PER_SCAN_CALL);
    pagesScanned++;
    for (const item of res.data.items ?? []) {
      const name = item.authorDetails?.displayName;
      const id   = item.authorDetails?.channelId;
      _cacheParticipant(session, name, id);
      if (name?.toLowerCase() === key) return id;
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken && pagesScanned < MAX_SCAN_PAGES);

  if (pagesScanned >= MAX_SCAN_PAGES && pageToken) {
    log.warn(`[YouTube] _resolveChannelId: page cap (${MAX_SCAN_PAGES}) reached for "${displayName}" — user not found in last ${MAX_SCAN_PAGES * 200} messages`);
  }
  return null;
}

// ── Mod actions ───────────────────────────────────────────────────────────

async function ytBan(_, username) {
  const youtube = _getYoutubeClient();
  const sessions = Array.from(_activeSessions.values());
  if (sessions.length === 0) throw new Error("No active YouTube sessions");

  let acted = false;
  for (const session of sessions) {
    if (!session.liveChatId) continue;
    const channelId = await _resolveChannelId(youtube, session, username);
    if (channelId) {
      await youtube.liveChatBans.insert({
        part: ['snippet'],
        requestBody: { snippet: { liveChatId: session.liveChatId, type: 'permanent', bannedUserDetails: { channelId } } },
      });
      log.info(`[YouTube] Banned ${username} in chat ${session.liveChatId}`);
      acted = true;
    }
  }
  if (!acted) throw new Error(`YouTube user "${username}" not found in any active live chat`);
}

async function ytTimeout(_, username, durationSeconds = 300) {
  const youtube = _getYoutubeClient();
  const sessions = Array.from(_activeSessions.values());
  if (sessions.length === 0) throw new Error("No active YouTube sessions");

  let acted = false;
  for (const session of sessions) {
    if (!session.liveChatId) continue;
    const channelId = await _resolveChannelId(youtube, session, username);
    if (channelId) {
      await youtube.liveChatBans.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            liveChatId: session.liveChatId,
            type: 'temporary',
            banDurationSeconds: durationSeconds,
            bannedUserDetails: { channelId },
          },
        },
      });
      log.info(`[YouTube] Timed out ${username} for ${durationSeconds}s in chat ${session.liveChatId}`);
      acted = true;
    }
  }
  if (!acted) throw new Error(`YouTube user "${username}" not found in any active live chat`);
}

async function ytVip(_, username) {
  const youtube = _getYoutubeClient();
  const sessions = Array.from(_activeSessions.values());
  if (sessions.length === 0) throw new Error("No active YouTube sessions");

  let acted = false;
  for (const session of sessions) {
    if (!session.liveChatId) continue;
    const channelId = await _resolveChannelId(youtube, session, username);
    if (channelId) {
      await youtube.liveChatModerators.insert({
        part: ['snippet'],
        requestBody: { snippet: { liveChatId: session.liveChatId, moderatorDetails: { channelId } } },
      });
      log.info(`[YouTube] Promoted ${username} to moderator in chat ${session.liveChatId}`);
      acted = true;
    }
  }
  if (!acted) throw new Error(`YouTube user "${username}" not found in any active live chat`);
}

async function ytUnvip(_, username) {
  const youtube = _getYoutubeClient();
  const sessions = Array.from(_activeSessions.values());
  if (sessions.length === 0) throw new Error("No active YouTube sessions");

  const normalised = username.toLowerCase();
  let acted = false;

  for (const session of sessions) {
    if (!session.liveChatId) continue;
    let pageToken;
    let moderatorId = null;
    do {
      const res = await youtube.liveChatModerators.list({
        liveChatId: session.liveChatId, part: ['snippet'], maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      });
      _consumeQuota(1); // liveChatModerators.list costs 1 unit per page
      for (const item of res.data.items ?? []) {
        if (item.snippet?.moderatorDetails?.displayName?.toLowerCase() === normalised) {
          moderatorId = item.id;
          break;
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken && !moderatorId);

    if (moderatorId) {
      await youtube.liveChatModerators.delete({ id: moderatorId });
      log.info(`[YouTube] Removed moderator ${username} from chat ${session.liveChatId}`);
      acted = true;
    }
  }
  
  if (!acted) throw new Error(`YouTube user "${username}" is not a moderator in any active live chat`);
}

// ── Chat reply ────────────────────────────────────────────────────────────

const SAY_CHUNK_SIZE = 200;

function _chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

async function say(text) {
  let youtube;
  try {
    youtube = _getYoutubeClient();
  } catch (err) {
    log.warn('[YouTube] say() — OAuth not configured:', err.message);
    return;
  }

  const sessions = Array.from(_activeSessions.values());
  if (sessions.length === 0) {
    log.warn('[YouTube] say() — no active sessions');
    return;
  }

  const chunks = _chunkText(text, SAY_CHUNK_SIZE);
  
  for (const session of sessions) {
    if (!session.liveChatId) continue;
    for (const chunk of chunks) {
      try {
        await youtube.liveChatMessages.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              liveChatId: session.liveChatId,
              type: 'textMessageEvent',
              textMessageDetails: { messageText: chunk },
            },
          },
        });
        log.debug(`[YouTube] say() in ${session.liveChatId}:`, chunk);
      } catch (err) {
        log.error(`[YouTube] say() error for chat ${session.liveChatId}:`, err.message);
      }
    }
  }
}

/**
 * Send a message to one specific YouTube live chat by videoId.
 * Used by plugins that want to reply only to the stream the command came from.
 *
 * @param {string} videoId  The video / session to target
 * @param {string} text     Text to send (auto-chunked to 200 chars)
 */
async function sayTo(videoId, text) {
  let youtube;
  try {
    youtube = _getYoutubeClient();
  } catch (err) {
    log.warn('[YouTube] sayTo() — OAuth not configured:', err.message);
    return;
  }

  const session = _activeSessions.get(videoId);
  if (!session) {
    log.warn(`[YouTube] sayTo() — no active session for videoId=${videoId}`);
    return;
  }
  if (!session.liveChatId) {
    log.warn(`[YouTube] sayTo() — session has no liveChatId (videoId=${videoId})`);
    return;
  }

  const chunks = _chunkText(text, SAY_CHUNK_SIZE);
  for (const chunk of chunks) {
    try {
      await youtube.liveChatMessages.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            liveChatId: session.liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: { messageText: chunk },
          },
        },
      });
      log.debug(`[YouTube] sayTo(${videoId}) in ${session.liveChatId}:`, chunk);
    } catch (err) {
      log.error(`[YouTube] sayTo() error for chat ${session.liveChatId}:`, err.message);
    }
  }
}

// ── Subscriber count poller ───────────────────────────────────────────────

let _lastKnownSubCount = null;
let _subPollerTimer    = null;
let _namedSubThisCycle = 0;

async function _fetchSubscriberCount() {
  if (!YT_API_KEY || !YT_CHANNEL_ID) return null;
  if (!_hasQuota()) {
    log.warn('[YouTube] Subscriber count fetch skipped — quota exhausted');
    return null;
  }
  const fetch = await _getFetch();
  const url   = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${YT_CHANNEL_ID}&key=${YT_API_KEY}`;
  const res   = await fetch(url);
  if (!res.ok) { log.warn(`[YouTube] Subscriber count fetch failed: ${res.status}`); return null; }
  const data  = await res.json();
  _consumeQuota(1);
  const raw = data?.items?.[0]?.statistics?.subscriberCount;
  return raw != null ? parseInt(raw, 10) : null;
}

async function _pollSubscriberCount(queue) {
  const count = await _fetchSubscriberCount().catch(err => {
    log.warn('[YouTube] Subscriber poll error:', err.message);
    return null;
  });
  if (count == null) return;

  if (_lastKnownSubCount == null) {
    _lastKnownSubCount = count;
    log.info(`[YouTube] Subscriber count baseline: ${count.toLocaleString()}`);
    return;
  }

  const delta = count - _lastKnownSubCount;
  if (delta <= 0) { _namedSubThisCycle = 0; return; }

  const anonymous = Math.max(0, delta - _namedSubThisCycle);
  log.info(`[YouTube] Subscriber delta +${delta} (named: ${_namedSubThisCycle}, anonymous: ${anonymous}) — total: ${count.toLocaleString()}`);

  for (let i = 0; i < anonymous; i++) {
    queue.pushMessage({ platform: 'youtube', type: 'subscribe', username: null });
  }

  _lastKnownSubCount = count;
  _namedSubThisCycle = 0;
}

function _startSubscriberPoller(queue) {
  if (_subPollerTimer) return;
  if (!YT_API_KEY || !YT_CHANNEL_ID) {
    log.warn('[YouTube] Subscriber count poller disabled — YT_API_KEY and YT_CHANNEL_ID both required.');
    return;
  }
  log.info(`[YouTube] Subscriber poller started (interval: ${_SUB_POLL_MS / 1000}s)`);
  _pollSubscriberCount(queue).catch(() => {});
  _subPollerTimer = setInterval(() => {
    _pollSubscriberCount(queue).catch(err => log.warn('[YouTube] Subscriber poll error:', err.message));
  }, _SUB_POLL_MS);
}

// ── Like count poller ─────────────────────────────────────────────────────

async function _fetchLikeCount(videoId) {
  if (!YT_API_KEY || !videoId) return null;
  if (!_hasQuota()) {
    log.warn('[YouTube] Like count fetch skipped — quota exhausted');
    return null;
  }
  const fetch = await _getFetch();
  const url   = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${YT_API_KEY}`;
  const res   = await fetch(url);
  if (!res.ok) { log.warn(`[YouTube] Like count fetch failed: ${res.status}`); return null; }
  const data  = await res.json();
  _consumeQuota(1);
  const raw = data?.items?.[0]?.statistics?.likeCount;
  return raw != null ? parseInt(raw, 10) : null;
}

async function _pollLikeCount(videoId, session, queue) {
  const count = await _fetchLikeCount(videoId).catch(err => {
    log.warn('[YouTube] Like poll error:', err.message);
    return null;
  });
  if (count == null) return;

  if (session.lastKnownLikeCount == null) {
    session.lastKnownLikeCount = count;
    log.info(`[YouTube] Like count baseline for ${videoId}: ${count.toLocaleString()}`);
    return;
  }

  const delta = count - session.lastKnownLikeCount;
  if (delta <= 0) return;

  log.info(`[YouTube] Like delta +${delta} for ${videoId} — total: ${count.toLocaleString()}`);
  for (let i = 0; i < delta; i++) {
    queue.pushMessage({ platform: 'youtube', type: 'like', username: null, message: null });
  }

  session.lastKnownLikeCount = count;
}

function _startLikePoller(videoId, session, queue) {
  if (session.likePollerTimer) return;
  if (!YT_API_KEY) {
    log.warn('[YouTube] Like count poller disabled — YT_API_KEY required.');
    return;
  }
  log.info(`[YouTube] Like poller started for video=${videoId} (interval: ${_LIKE_POLL_MS / 1000}s)`);
  _pollLikeCount(videoId, session, queue).catch(() => {});
  session.likePollerTimer = setInterval(() => {
    _pollLikeCount(videoId, session, queue).catch(err => log.warn('[YouTube] Like poll error:', err.message));
  }, _LIKE_POLL_MS);
}

async function startYouTube(queue, websubRunning) {
  if (!YT_CHANNEL_ID && !YT_VIDEO_ID) {
    log.warn('[YouTube] No channel/video ID configured — YouTube disabled.');
    return;
  }

  log.info('[YouTube] Chat reader: masterchat dual-lane pipelined fetch (primary)');
  log.info(`[YouTube] Watchdog interval: ${POLL_INTERVAL / 1000}s | Like poller: ${_LIKE_POLL_MS / 1000}s | Sub poller: ${_SUB_POLL_MS / 1000}s`);

  if (YT_API_KEY) {
    log.info(
      `[YouTube] Data API available for mod channel-ID scans. ` +
      `Daily budget: ${QUOTA_DAILY_LIMIT} units. ` +
      `Participant cache eliminates API calls for users who have chatted. ` +
      `Scan page cap: 5 pages (25 quota units max per cache-miss mod action).`
    );
  } else {
    log.warn('[YouTube] YT_API_KEY not set — mod actions require users to have chatted (participant cache only).');
  }

  if (websubRunning) {
    log.info('[YouTube] WebSub active — watchdog running as safety net alongside it.');
  }

  try { _getOAuthClient(); } catch { /* warn lazily on first use */ }

  _startSubscriberPoller(queue);
  _watchdog(queue);
}

function triggerVideo(videoId, queue) {
  if (!queue) {
    log.warn('[YouTube] triggerVideo called with null queue — skipping');
    return;
  }
  _startSession(videoId, queue);
}

/**
 * Update any combination of title, tags, and categoryId on the currently
 * active live video (or YT_VIDEO_ID if set).
 *
 * All fields are optional — only supplied fields are changed. The existing
 * snippet is fetched first so that unmentioned fields (description, etc.)
 * are preserved; YouTube's videos.update would erase them otherwise.
 *
 * Requires the channel owner's OAuth token (.youtube-tokens.json) with the
 * youtube.force-ssl scope (already required for mod actions).
 *
 * @param {{ title?: string, tags?: string[], categoryId?: string }} opts
 *   title      — Video title (max 100 chars per YouTube's limit)
 *   tags       — Array of tag strings. Pass [] to clear all tags.
 *   categoryId — YouTube category ID as a string (e.g. "20" for Gaming).
 *                See: https://gist.github.com/dgp/1b24bf2961521bd75d6c
 */
async function updateVideoInfo({ title, tags, categoryId } = {}) {
  const youtube = _getYoutubeClient();
 
  // Resolve which video ID to update
  const videoId = (() => {
    for (const [id] of _activeSessions) return id;
    return YT_VIDEO_ID || null;
  })();
 
  if (!videoId) throw new Error('No active YouTube video ID — stream may not be live');
 
  if (title === undefined && tags === undefined && categoryId === undefined) {
    log.warn('[YouTube] updateVideoInfo called with no fields to update');
    return;
  }
 
  // Fetch the existing snippet to preserve all un-edited fields
  const existing = await youtube.videos.list({
    part: ['snippet'],
    id:   [videoId],
  });
 
  const snippet = existing?.data?.items?.[0]?.snippet;
  if (!snippet) throw new Error(`Could not fetch snippet for video ${videoId}`);
 
  // Apply only the fields that were supplied
  if (title !== undefined && title !== null) {
    snippet.title = String(title).slice(0, 100);
  }
  if (tags !== undefined && tags !== null) {
    snippet.tags = tags.map(t => String(t).trim()).filter(Boolean);
  }
  if (categoryId !== undefined && categoryId !== null && categoryId !== '') {
    snippet.categoryId = String(categoryId);
  }
 
  await youtube.videos.update({
    part: ['snippet'],
    requestBody: { id: videoId, snippet },
  });
 
  const parts = [
    title      !== undefined ? `title="${snippet.title}"`   : null,
    tags       !== undefined ? `tags=[${snippet.tags?.join(', ')}]` : null,
    categoryId !== undefined ? `categoryId=${snippet.categoryId}`   : null,
  ].filter(Boolean);
  log.info(`[YouTube] Video info updated for ${videoId}: ${parts.join(', ')}`);
}

module.exports = {
  say,
  sayTo,
  startYouTube,
  triggerVideo,
  updateVideoInfo,
  stopSubscriberPoller() {
    if (_subPollerTimer) { clearInterval(_subPollerTimer); _subPollerTimer = null; }
    _lastKnownSubCount = null;
    _namedSubThisCycle = 0;
  },
  stopLikePoller() {
    for (const session of _activeSessions.values()) {
      if (session.likePollerTimer) {
        clearInterval(session.likePollerTimer);
        session.likePollerTimer = null;
      }
      session.lastKnownLikeCount = null;
    }
  },
  stopSession(videoId) {
    const session = _activeSessions.get(videoId);
    if (!session) return false;
    session.stopSignal.stopped = true;
    if (session.likePollerTimer) clearInterval(session.likePollerTimer);
    _activeSessions.delete(videoId);
    return true;
  },

  /**
   * Fetch the channel's current subscriber count from the YouTube Data API.
   * Returns null if the API key isn't configured or the fetch fails.
   * Exposed so plugins (sub-counter, etc.) stop reimplementing this inline.
   * @returns {Promise<number|null>}
   */
  async getSubscriberCount() {
    return _fetchSubscriberCount();
  },

  /**
   * Fetch the current like count for a live video. Returns null if unknown.
   * Exposed so plugins can poll like counts without reaching into internals.
   * @param {string} videoId
   * @returns {Promise<number|null>}
   */
  async getLikeCount(videoId) {
    return _fetchLikeCount(videoId);
  },

  // Moderation (top-level convenience wrappers — mirror the modHandlers
  // surface but with cleaner signatures for plugin call sites)
  async ban(username)      { return ytBan('youtube', username); },
  async timeout(username, durationSeconds = 300) {
    return ytTimeout('youtube', username, durationSeconds);
  },
  async vip(username)      { return ytVip('youtube', username); },
  async unvip(username)    { return ytUnvip('youtube', username); },

  modHandlers: {
    ban:     ytBan,
    timeout: ytTimeout,
    vip:     ytVip,
    unvip:   ytUnvip,
  },
};

// Register mod action handlers with the dashboard so that timeout/ban buttons
// dispatched from the UI are forwarded to the YouTube platform functions.
const dashboard = require('./dashboard');
dashboard.onModerate({
  ban:     ytBan,
  timeout: ytTimeout,
});