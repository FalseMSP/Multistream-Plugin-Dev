'use strict';

/**
 * Twitch module
 * ─────────────
 * • Connects via tmi.js IRC WebSocket
 * • Mirrors chat messages → queue.pushMessage()
 * • Registers EventSub webhook for channel point redeems (works offline too)
 * • Registers ban/vip/unvip mod action handlers
 */

const tmi = require('tmi.js');
const log = require('./logger');

// ── Config ────────────────────────────────────────────────────────────────

const TOKEN       = process.env.TWITCH_TOKEN              ?? '';
const CLIENT_ID   = process.env.TWITCH_CLIENT_ID          ?? '';
const BOT_NICK    = process.env.TWITCH_BOT_NICK           ?? '';
const CHANNELS    = (process.env.TWITCH_CHANNELS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const BROADCASTER = (process.env.TWITCH_BROADCASTER_LOGIN ?? CHANNELS[0] ?? '').trim();

// ── Helix API helper ──────────────────────────────────────────────────────

let _appToken       = null;
let _appTokenExpiry = 0;

async function getAppToken() {
  if (_appToken && Date.now() < _appTokenExpiry) return _appToken;
  const { default: fetch } = await import('node-fetch');
  const res  = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Failed to get app token: ${JSON.stringify(data)}`);
  _appToken       = data.access_token;
  _appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  log.info('[Twitch] App access token obtained');
  return _appToken;
}

async function helixRequest(method, path, body) {
  const { default: fetch } = await import('node-fetch');
  const appToken = await getAppToken();

  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    method,
    headers: {
      'Client-ID':     CLIENT_ID,
      'Authorization': `Bearer ${appToken}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch API ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getBroadcasterId() {
  const data = await helixRequest('GET', `/users?login=${BROADCASTER}`);
  return data?.data?.[0]?.id ?? null;
}

// ── EventSub — channel point redeems ────────────────────────────────────

async function setupEventSub(callbackUrl, secret) {
  if (!callbackUrl) {
    log.warn('[Twitch] No PUBLIC_URL set — EventSub disabled. Redeems only work while live via IRC tags.');
    return;
  }
  if (!CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    log.warn('[Twitch] CLIENT_ID or CLIENT_SECRET missing — EventSub disabled.');
    return;
  }

  try {
    const broadcasterId = await getBroadcasterId();
    if (!broadcasterId) { log.warn('[Twitch] Could not resolve broadcaster ID'); return; }

    // Check for existing subscription to avoid duplicates
    const existing = await helixRequest('GET', '/eventsub/subscriptions?type=channel.channel_points_custom_reward_redemption.add');
    const alreadySubscribed = existing?.data?.some(
      s => s.condition?.broadcaster_user_id === broadcasterId && s.status === 'enabled'
    );

    if (alreadySubscribed) {
      log.info('[Twitch] EventSub redeem subscription already active');
      return;
    }

    await helixRequest('POST', '/eventsub/subscriptions', {
      type:      'channel.channel_points_custom_reward_redemption.add',
      version:   '1',
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: 'webhook', callback: callbackUrl, secret },
    });
    log.info('[Twitch] EventSub redeem subscription created → callback:', callbackUrl);
  } catch (err) {
    log.warn('[Twitch] EventSub setup failed:', err.message);
  }
}

// ── Mod actions ───────────────────────────────────────────────────────────

async function twitchBan(_, username, reason) {
  const broadcasterId = await getBroadcasterId();
  const userRes = await helixRequest('GET', `/users?login=${username}`);
  const userId  = userRes?.data?.[0]?.id;
  if (!userId) throw new Error(`User "${username}" not found on Twitch`);
  await helixRequest('POST', `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
    data: { user_id: userId, reason },
  });
  log.info(`[Twitch] Banned ${username}`);
}

async function twitchVip(_, username) {
  const broadcasterId = await getBroadcasterId();
  const userRes = await helixRequest('GET', `/users?login=${username}`);
  const userId  = userRes?.data?.[0]?.id;
  if (!userId) throw new Error(`User "${username}" not found on Twitch`);
  await helixRequest('POST', `/channels/vips?broadcaster_id=${broadcasterId}&user_id=${userId}`);
  log.info(`[Twitch] VIP granted to ${username}`);
}

async function twitchUnvip(_, username) {
  const broadcasterId = await getBroadcasterId();
  const userRes = await helixRequest('GET', `/users?login=${username}`);
  const userId  = userRes?.data?.[0]?.id;
  if (!userId) throw new Error(`User "${username}" not found on Twitch`);
  await helixRequest('DELETE', `/channels/vips?broadcaster_id=${broadcasterId}&user_id=${userId}`);
  log.info(`[Twitch] VIP removed from ${username}`);
}

// ── tmi.js client ─────────────────────────────────────────────────────────

async function startTwitch(queue) {
  if (!TOKEN || !BOT_NICK || !CHANNELS.length) {
    log.warn('[Twitch] Credentials incomplete — Twitch mirroring disabled.');
    return;
  }

  // Wire up EventSub for redeems (works offline, unlike IRC tags)
  const { getEventSubCallbackUrl, getTwitchSecret } = require('./websub');
  setupEventSub(getEventSubCallbackUrl(), getTwitchSecret()); // non-blocking

  const client = new tmi.Client({
    options:  { debug: false },
    identity: { username: BOT_NICK, password: TOKEN },
    channels: CHANNELS,
  });

  client.on('connected', (addr, port) =>
    log.info(`[Twitch] Connected to ${addr}:${port} | channels: ${CHANNELS.join(', ')}`)
  );

  client.on('message', (channel, tags, message, self) => {
    if (self) return;
    const username = tags['display-name'] ?? tags.username ?? 'unknown';

    // IRC tag fallback for redeems (only fires while live, cost not available)
    if (tags['custom-reward-id']) {
      log.debug('[Twitch] Redeem via IRC tag (no cost):', username);
      queue.pushRedeem({
        username,
        title:     tags['msg-id'] ?? 'Custom Reward',
        cost:      0,
        input:     message || null,
        timestamp: new Date(),
      });
      return;
    }

    queue.pushMessage({ platform: 'twitch', username, message });
  });

  client.on('disconnected', (reason) => {
    log.warn('[Twitch] Disconnected:', reason);
    setTimeout(() => client.connect().catch(log.error), 5000);
  });

  await client.connect();
  log.info('[Twitch] tmi.js client ready');

  return client;
}

module.exports = {
  startTwitch,
  modHandlers: {
    ban:   twitchBan,
    vip:   twitchVip,
    unvip: twitchUnvip,
  },
};