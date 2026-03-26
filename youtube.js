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
    ({ Masterchat, stringify } = require('@stu43005/masterchat'));
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

  mc.on('chat', (chat) => {
    const username = chat.authorName ?? 'unknown';
    const message  = stringify ? stringify(chat.message) : '';
    if (message) queue.pushMessage({ platform: 'youtube', username, message });
  });

  mc.on('end', () => {
    log.info(`[YouTube] masterchat ended for ${videoId}`);
    _activeSessions.delete(videoId);
  });

  mc.on('error', (err) => {
    log.error(`[YouTube] masterchat error (${videoId}):`, err.message);
    _activeSessions.delete(videoId);
  });

  // Non-blocking — listen() runs the polling loop in the background
  mc.listen();
}

// ── Live video detection ──────────────────────────────────────────────────

async function _findLiveVideoId() {
  if (YT_VIDEO_ID) return YT_VIDEO_ID;

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
        _startMasterchat(videoId, queue);
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

  if (!websubRunning) {
    _watchdog(queue);
  } else {
    log.info('[YouTube] WebSub active — watchdog polling disabled.');
  }
}

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