'use strict';

/**
 * Twitch module
 * ─────────────
 * • Connects via tmi.js IRC WebSocket
 * • Mirrors chat messages → queue.pushMessage()
 * • Listens for channel point redeems via EventSub (requires app token)
 *   Falls back to tmi.js custom-reward-id tags if EventSub not configured.
 * • Registers ban/vip/unvip mod action handlers on the Discord bot
 */

const tmi    = require('tmi.js');
const log    = require('./logger');
const { startDiscordBot } = require('./discord');

// ── Config ────────────────────────────────────────────────────────────────

const TOKEN       = process.env.TWITCH_TOKEN       ?? '';  // oauth:xxxx
const CLIENT_ID   = process.env.TWITCH_CLIENT_ID   ?? '';
const BOT_NICK    = process.env.TWITCH_BOT_NICK    ?? '';
const CHANNELS    = (process.env.TWITCH_CHANNELS   ?? '').split(',').map(s => s.trim()).filter(Boolean);
const BROADCASTER = (process.env.TWITCH_BROADCASTER_LOGIN ?? CHANNELS[0] ?? '').trim();

// ── Helix API helper ──────────────────────────────────────────────────────

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

// App access token (client credentials) — cached
let _appToken = null;
let _appTokenExpiry = 0;

async function getAppToken() {
  if (_appToken && Date.now() < _appTokenExpiry) return _appToken;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await res.json();
  _appToken = data.access_token;
  _appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _appToken;
}

async function getBroadcasterId() {
  const data = await helixRequest('GET', `/users?login=${BROADCASTER}`);
  return data?.data?.[0]?.id ?? null;
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

// ── EventSub (channel point redeems) ─────────────────────────────────────

async function subscribeToRedeems(broadcasterId, callbackUrl, secret) {
  try {
    await helixRequest('POST', '/eventsub/subscriptions', {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      transport: {
        method: 'webhook',
        callback: callbackUrl,
        secret,
      },
    });
    log.info('[Twitch] EventSub redeem subscription created');
  } catch (err) {
    log.warn('[Twitch] EventSub subscription failed (redeems via tag fallback):', err.message);
  }
}

// ── tmi.js client ─────────────────────────────────────────────────────────

async function startTwitch(queue) {
  if (!TOKEN || !BOT_NICK || !CHANNELS.length) {
    log.warn('[Twitch] Credentials incomplete — Twitch mirroring disabled.');
    return;
  }

  // Register mod action handlers on Discord bot
  // We import lazily to avoid circular deps
  const discord = require('./discord');
  // discord module exposes onModAction at module level — but we get it from startDiscordBot return value
  // Instead, we use the global discord module's handler registry directly.
  // This is set up in index.js, so we export our handlers for index.js to wire.
  // (see exports at bottom)

  const client = new tmi.Client({
    options:    { debug: false },
    identity:   { username: BOT_NICK, password: TOKEN },
    channels:   CHANNELS,
  });

  client.on('connected', (addr, port) =>
    log.info(`[Twitch] Connected to ${addr}:${port} | channels: ${CHANNELS.join(', ')}`)
  );

  client.on('message', (channel, tags, message, self) => {
    if (self) return;
    const username = tags['display-name'] ?? tags.username ?? 'unknown';

    // tmi.js tag fallback for redeems (when EventSub not configured)
    if (tags['custom-reward-id']) {
      queue.pushRedeem({
        username,
        title:     tags['msg-id'] ?? 'Custom Reward',
        cost:      0,   // cost not available via IRC tags
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
