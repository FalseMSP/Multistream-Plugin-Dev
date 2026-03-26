'use strict';

/**
 * YouTube module
 * ──────────────
 * • Primary path: WebSub triggers _startMasterchat() per video
 * • Fallback: polls for live video ID every YT_POLL_INTERVAL seconds,
 *   then hands off to masterchat
 * • Mod actions: ban (hide user) and add/remove moderator via Data API
 */

const log = require('./logger');

const YT_API_KEY      = process.env.YT_API_KEY       ?? '';
const YT_VIDEO_ID     = process.env.YT_VIDEO_ID      ?? '';  // optional static override
const YT_CHANNEL_ID   = process.env.YT_CHANNEL_ID    ?? '';
const POLL_INTERVAL   = parseInt(process.env.YT_POLL_INTERVAL ?? '30', 10) * 1000;

// Tracks active masterchat sessions keyed by videoId
const _activeSessions = new Map();

// ── masterchat ────────────────────────────────────────────────────────────

async function _startMasterchat(videoId, queue) {
  if (_activeSessions.has(videoId)) {
    log.info(`[YouTube] masterchat already active for ${videoId}`);
    return;
  }

  let Masterchat, stringify;
  try {
    ({ Masterchat, stringify } = await import('@stu43005/masterchat'));
  } catch {
    log.error('[YouTube] masterchat not installed — run: npm install @stu43005/masterchat');
    return;
  }

  log.info(`[YouTube] Starting masterchat for video=${videoId}`);
  let mc;
  try {
    mc = await Masterchat.init(videoId);
  } catch (err) {
    log.error('[YouTube] Masterchat init failed:', err.message);
    return;
  }

  _activeSessions.set(videoId, mc);
  log.info(`[YouTube] masterchat connected for video=${videoId}`);

  try {
    for await (const action of mc.iter()) {
      if (action.type !== 'addChatItemAction') continue;
      const username = action.authorName ?? 'unknown';
      const message  = stringify ? stringify(action.message) : (action.message ?? '');
      if (message) queue.pushMessage({ platform: 'youtube', username, message });
    }
  } catch (err) {
    log.error(`[YouTube] masterchat error (${videoId}):`, err.message);
  } finally {
    _activeSessions.delete(videoId);
    log.info(`[YouTube] masterchat session ended for ${videoId}`);
  }
}

// ── Live video detection ──────────────────────────────────────────────────

async function _findLiveVideoId() {
  // Static override
  if (YT_VIDEO_ID) return YT_VIDEO_ID;

  // API search
  if (YT_API_KEY && YT_CHANNEL_ID) {
    try {
      const { default: fetch } = await import('node-fetch');
      const url = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${YT_CHANNEL_ID}&eventType=live&type=video&key=${YT_API_KEY}`;
      const res  = await fetch(url);
      const data = await res.json();
      return data?.items?.[0]?.id?.videoId ?? null;
    } catch (err) {
      log.warn('[YouTube] API search failed:', err.message);
    }
  }

  // Scrape fallback (no quota cost)
  if (YT_CHANNEL_ID) {
    try {
      const { default: fetch } = await import('node-fetch');
      const res  = await fetch(`https://www.youtube.com/channel/${YT_CHANNEL_ID}/live`, {
        headers: { 'Accept-Language': 'en-US,en;q=0.5', 'User-Agent': 'Mozilla/5.0' },
      });
      const text = await res.text();
      const m = text.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})"/);
      if (m && (text.includes('isLiveBroadcast') || text.includes('"style":"LIVE"'))) {
        return m[1];
      }
    } catch (err) {
      log.warn('[YouTube] Scrape fallback failed:', err.message);
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
        _startMasterchat(videoId, queue); // don't await — runs in background
      }
    } catch (err) {
      log.error('[YouTube] Watchdog error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// ── Mod actions via YouTube Data API ────────────────────────────────────

async function _ytApiRequest(method, endpoint, params, body) {
  const { default: fetch } = await import('node-fetch');
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.searchParams.set('key', YT_API_KEY);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function _getLiveChatId() {
  const videoId = await _findLiveVideoId();
  if (!videoId) throw new Error('No live video found');
  const data = await _ytApiRequest('GET', 'videos', { part: 'liveStreamingDetails', id: videoId });
  const chatId = data?.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) throw new Error('No active live chat');
  return chatId;
}

async function ytBan(_, username) {
  // YouTube "ban" = hide user from chat (requires OAuth, not API key)
  // This requires the channel owner's OAuth token — documented limitation.
  // For now we log a clear message; full OAuth flow is a separate setup step.
  log.warn(`[YouTube] Ban for "${username}" requires OAuth token — see README.`);
  throw new Error('YouTube ban requires OAuth setup (see README)');
}

async function ytVip(_, username) {
  log.warn(`[YouTube] VIP for "${username}" — YouTube has no VIP concept; promoting to moderator instead.`);
  // YouTube's equivalent is "moderator" role via liveChatModerators.insert
  // Requires OAuth — same limitation as ban.
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

  if (!websubRunning) {
    // No WebSub — poll for live video
    _watchdog(queue); // intentionally not awaited
  } else {
    log.info('[YouTube] WebSub active — watchdog polling disabled.');
    // WebSub will call triggerVideo() when a new video goes live
  }
}

/** Called by WebSub when a new video is published */
function triggerVideo(videoId, queue) {
  _startMasterchat(videoId, queue);
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