'use strict';
/**
 * Twitch module
 * ─────────────
 * • Connects via tmi.js IRC WebSocket
 * • Mirrors chat messages → queue.pushMessage()
 * • Registers EventSub webhook for channel point redeems (works offline too)
 * • Registers ban/vip/unvip mod action handlers
 * • Logs bits (cheers) and subscription events
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
// ── User token (broadcaster OAuth) ───────────────────────────────────────
// Required for EventSub subscriptions that need broadcaster-level scopes:
//   bits:read, channel:read:subscriptions
// Loaded from .twitch-tokens.json written by twitch-auth.js.
// The token is refreshed automatically when it expires.

const fs        = require('fs');
const TOKEN_FILE = require('path').resolve('.twitch-tokens.json');

let _userTokenCache = null;

async function getUserToken() {
  // Load from disk if not in memory
  if (!_userTokenCache) {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    try {
      _userTokenCache = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    } catch {
      log.warn('[Twitch] Could not read .twitch-tokens.json');
      return null;
    }
  }

  // Refresh if expired (or within 60 s of expiry)
  if (Date.now() >= (_userTokenCache.expires_at ?? 0)) {
    log.info('[Twitch] User token expired — refreshing…');
    try {
      const { default: fetch } = await import('node-fetch');
      const res  = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: _userTokenCache.refresh_token,
          client_id:     CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET,
        }),
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(JSON.stringify(data));

      _userTokenCache = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token ?? _userTokenCache.refresh_token,
        expires_at:    Date.now() + (data.expires_in - 60) * 1000,
        scopes:        data.scope ?? _userTokenCache.scopes,
      };
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(_userTokenCache, null, 2));
      log.info('[Twitch] User token refreshed and saved.');
    } catch (err) {
      log.error('[Twitch] User token refresh failed:', err.message);
      _userTokenCache = null;
      return null;
    }
  }

  return _userTokenCache.access_token;
}


// ── EventSub — channel point redeems + bits + subs ───────────────────────
//
// Webhook EventSub subscriptions ALWAYS use the app access token to create
// them — using a user token here is a 400 error. However, subscription types
// like channel.cheer and channel.subscribe require the broadcaster to have
// previously granted the relevant scopes (bits:read, channel:read:subscriptions)
// to your client ID via OAuth. Run twitch-auth.js once to perform that grant;
// after that the app token carries the necessary permissions automatically.

async function subscribeEventSub(broadcasterId, callbackUrl, secret, type, version, condition) {
  const existing = await helixRequest('GET', `/eventsub/subscriptions?type=${type}`);
  const alreadySubscribed = existing?.data?.some(
    s => s.condition?.broadcaster_user_id === broadcasterId && s.status === 'enabled'
  );
  if (alreadySubscribed) {
    log.info(`[Twitch] EventSub subscription already active: ${type}`);
    return;
  }
  await helixRequest('POST', '/eventsub/subscriptions', {
    type,
    version,
    condition: condition ?? { broadcaster_user_id: broadcasterId },
    transport: { method: 'webhook', callback: callbackUrl, secret },
  });
  log.info(`[Twitch] EventSub subscription created: ${type}`);
}

async function setupEventSub(callbackUrl, secret) {
  if (!callbackUrl) {
    log.warn('[Twitch] No PUBLIC_URL set — EventSub disabled. Redeems only work while live via IRC tags.');
    return;
  }
  if (!CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    log.warn('[Twitch] CLIENT_ID or CLIENT_SECRET missing — EventSub disabled.');
    return;
  }

  const hasUserToken = await getUserToken().then(t => !!t).catch(() => false);
  if (!hasUserToken) {
    log.warn('[Twitch] No broadcaster OAuth token found (.twitch-tokens.json missing or invalid).');
    log.warn('[Twitch] Run: node twitch-auth.js — this grants bits:read and channel:read:subscriptions');
    log.warn('[Twitch] to your client ID. Without it, cheer/sub EventSub subscriptions will 403.');
  }
  try {
    const broadcasterId = await getBroadcasterId();
    if (!broadcasterId) { log.warn('[Twitch] Could not resolve broadcaster ID'); return; }

    await subscribeEventSub(broadcasterId, callbackUrl, secret,
      'channel.channel_points_custom_reward_redemption.add', '1');

    await subscribeEventSub(broadcasterId, callbackUrl, secret,
      'channel.cheer', '1');

    await subscribeEventSub(broadcasterId, callbackUrl, secret,
      'channel.subscribe', '1');

    await subscribeEventSub(broadcasterId, callbackUrl, secret,
      'channel.subscription.gift', '1');

    await subscribeEventSub(broadcasterId, callbackUrl, secret,
      'channel.subscription.message', '1');

  } catch (err) {
    log.warn('[Twitch] EventSub setup failed:', err.message);
  }
}
// ── EventSub event handlers (called from your webhook router) ─────────────
function handleEventSubNotification(type, event, queue) {
  switch (type) {
    case 'channel.channel_points_custom_reward_redemption.add':
      queue.pushRedeem({
        username:  event.user_name,
        title:     event.reward.title,
        cost:      event.reward.cost,
        input:     event.user_input || null,
        timestamp: new Date(event.redeemed_at),
      });
      log.info(`[Twitch] Redeem: ${event.user_name} → "${event.reward.title}" (${event.reward.cost} pts)`);
      break;

    case 'channel.cheer':
      queue.pushDonation({
        platform:  'twitch',
        type:      'bits',
        username:  event.is_anonymous ? 'anonymous' : event.user_name,
        amount:    event.bits,
        message:   event.message || null,
        timestamp: new Date(),
      });
      log.info(`[Twitch] Cheer: ${event.is_anonymous ? 'anonymous' : event.user_name} cheered ${event.bits} bits`);
      break;

    case 'channel.subscribe':
      // New or returning sub (no attached message)
      queue.pushDonation({
        platform:  'twitch',
        type:      'sub',
        username:  event.is_gift ? 'gifted' : event.user_name,
        tier:      event.tier,           // '1000' | '2000' | '3000'
        gifted:    event.is_gift,
        message:   null,
        timestamp: new Date(),
      });
      log.info(`[Twitch] Sub: ${event.user_name} (tier ${event.tier})${event.is_gift ? ' [gifted]' : ''}`);
      break;

    case 'channel.subscription.message':
      // Resub with a message
      queue.pushDonation({
        platform:  'twitch',
        type:      'resub',
        username:  event.user_name,
        tier:      event.tier,
        months:    event.cumulative_months,
        streak:    event.streak_months ?? null,
        message:   event.message?.text || null,
        timestamp: new Date(),
      });
      log.info(`[Twitch] Resub: ${event.user_name} (tier ${event.tier}, ${event.cumulative_months} months)`);
      break;

    case 'channel.subscription.gift':
      // Gifted sub batch
      queue.pushDonation({
        platform:   'twitch',
        type:       'subgift',
        username:   event.is_anonymous ? 'anonymous' : event.user_name,
        tier:       event.tier,
        quantity:   event.total,
        cumulative: event.cumulative_total ?? null,
        timestamp:  new Date(),
      });
      log.info(`[Twitch] Gift subs: ${event.is_anonymous ? 'anonymous' : event.user_name} gifted ${event.total}x tier ${event.tier}`);
      break;

    default:
      log.debug('[Twitch] Unhandled EventSub type:', type);
  }
}
// ── Mod actions ───────────────────────────────────────────────────────────
async function twitchVip(_, username) {
  const broadcasterId = await getBroadcasterId();
  const userRes = await helixRequest('GET', `/users?login=${username}`);
  const userId  = userRes?.data?.[0]?.id;
  if (!userId) throw new Error(`User "${username}" not found on Twitch`);
  
  // Must use user token — app token returns 401 for this endpoint
  const { default: fetch } = await import('node-fetch');
  const userToken = await getUserToken();
  if (!userToken) throw new Error('No Twitch user token — run twitch-auth.js');
  const res = await fetch(
    `https://api.twitch.tv/helix/channels/vips?broadcaster_id=${broadcasterId}&user_id=${userId}`,
    { method: 'POST', headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${userToken}` } }
  );
  if (!res.ok) throw new Error(`Twitch VIP API ${res.status}: ${await res.text()}`);
  log.info(`[Twitch] VIP granted to ${username}`);
}

async function twitchUnvip(_, username) {
  const broadcasterId = await getBroadcasterId();
  const userRes = await helixRequest('GET', `/users?login=${username}`);
  const userId  = userRes?.data?.[0]?.id;
  if (!userId) throw new Error(`User "${username}" not found on Twitch`);

  const { default: fetch } = await import('node-fetch');
  const userToken = await getUserToken();
  if (!userToken) throw new Error('No Twitch user token — run twitch-auth.js');
  const res = await fetch(
    `https://api.twitch.tv/helix/channels/vips?broadcaster_id=${broadcasterId}&user_id=${userId}`,
    { method: 'DELETE', headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${userToken}` } }
  );
  if (!res.ok) throw new Error(`Twitch unVIP API ${res.status}: ${await res.text()}`);
  log.info(`[Twitch] VIP removed from ${username}`);
}

async function twitchBan(_, username, reason) {
  const broadcasterId = await getBroadcasterId();
  const userRes = await helixRequest('GET', `/users?login=${username}`);
  const userId  = userRes?.data?.[0]?.id;
  if (!userId) throw new Error(`User "${username}" not found on Twitch`);

  const { default: fetch } = await import('node-fetch');
  const userToken = await getUserToken();
  if (!userToken) throw new Error('No Twitch user token — run twitch-auth.js');
  const res = await fetch(
    // moderator_id must be the account that owns the user token (the broadcaster in this case)
    `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`,
    {
      method: 'POST',
      headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { user_id: userId, reason } }),
    }
  );
  if (!res.ok) throw new Error(`Twitch ban API ${res.status}: ${await res.text()}`);
  log.info(`[Twitch] Banned ${username}`);
}

let _tmiClient = null;

/**
 * Send a message to all monitored Twitch channels.
 */
async function say(text) {
  if (!_tmiClient) { log.warn("[Twitch] say() called before client ready"); return; }
  for (const ch of CHANNELS) {
    try { await _tmiClient.say(ch, text); }
    catch (err) { log.error("[Twitch] say() error on " + ch + ":", err.message); }
  }
}

// ── tmi.js client ─────────────────────────────────────────────────────────
async function startTwitch(queue) {
  if (!TOKEN || !BOT_NICK || !CHANNELS.length) {
    log.warn('[Twitch] Credentials incomplete — Twitch mirroring disabled.');
    return;
  }
  // Wire up EventSub for redeems, bits, and subs (works offline, unlike IRC tags)
  const { getEventSubCallbackUrl, getTwitchSecret } = require('./websub');
  
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
    log.debug(`[Twitch] Chat [${channel}] ${username}: ${message}`);
    queue.pushMessage({ platform: 'twitch', username, message });
  });

  // ── IRC fallback for bits (fires while live even without EventSub) ──────
  client.on('cheer', (channel, tags, message) => {
    const username = tags['display-name'] ?? tags.username ?? 'anonymous';
    const bits     = Number(tags.bits ?? 0);
    queue.pushDonation({
      platform:  'twitch',
      type:      'bits',
      username,
      amount:    bits,
      message:   message || null,
      timestamp: new Date(),
    });
    log.info(`[Twitch] Cheer (IRC): ${username} cheered ${bits} bits`);
  });

  // ── IRC fallback for subs ─────────────────────────────────────────────
  client.on('subscription', (channel, username, method, message, tags) => {
    queue.pushDonation({
      platform:  'twitch',
      type:      'sub',
      username:  tags['display-name'] ?? username,
      tier:      method?.prime ? 'prime' : (method?.plan ?? '1000'),
      gifted:    false,
      message:   message || null,
      timestamp: new Date(),
    });
    log.info(`[Twitch] Sub (IRC): ${username} (${method?.prime ? 'Prime' : method?.plan})`);
  });

  client.on('resub', (channel, username, months, message, tags, methods) => {
    queue.pushDonation({
      platform:  'twitch',
      type:      'resub',
      username:  tags['display-name'] ?? username,
      tier:      methods?.prime ? 'prime' : (methods?.plan ?? '1000'),
      months,
      streak:    tags['msg-param-streak-months'] ? Number(tags['msg-param-streak-months']) : null,
      message:   message || null,
      timestamp: new Date(),
    });
    log.info(`[Twitch] Resub (IRC): ${username} (${months} months)`);
  });

  client.on('subgift', (channel, gifter, streakMonths, recipient, methods, tags) => {
    queue.pushDonation({
      platform:   'twitch',
      type:       'subgift',
      username:   tags['display-name'] ?? gifter,
      recipient,
      tier:       methods?.plan ?? '1000',
      quantity:   1,
      cumulative: tags['msg-param-sender-count'] ? Number(tags['msg-param-sender-count']) : null,
      timestamp:  new Date(),
    });
    log.info(`[Twitch] Sub gift (IRC): ${gifter} → ${recipient}`);
  });

  client.on('submysterygift', (channel, gifter, numbOfSubs, methods, tags) => {
    queue.pushDonation({
      platform:   'twitch',
      type:       'subgift',
      username:   tags['display-name'] ?? gifter,
      recipient:  null,
      tier:       methods?.plan ?? '1000',
      quantity:   numbOfSubs,
      cumulative: tags['msg-param-sender-count'] ? Number(tags['msg-param-sender-count']) : null,
      timestamp:  new Date(),
    });
    log.info(`[Twitch] Mystery gift (IRC): ${gifter} gifted ${numbOfSubs} subs`);
  });

  // ── Raids ─────────────────────────────────────────────────────────────
  client.on('raided', (channel, username, viewers) => {
    log.info(`[Twitch] Raid: ${username} raided ${channel} with ${viewers} viewers`);
  });

  // ── Mod / channel actions ─────────────────────────────────────────────
  client.on('ban', (channel, username, reason, tags) => {
    log.info(`[Twitch] Ban: ${username} banned in ${channel}${reason ? ` (reason: ${reason})` : ''}`);
  });

  client.on('timeout', (channel, username, reason, duration, tags) => {
    log.info(`[Twitch] Timeout: ${username} timed out for ${duration}s in ${channel}${reason ? ` (reason: ${reason})` : ''}`);
  });

  client.on('messagedeleted', (channel, username, deletedMessage, tags) => {
    log.info(`[Twitch] Message deleted: [${channel}] ${username}: "${deletedMessage}"`);
  });

  client.on('clearchat', (channel) => {
    log.info(`[Twitch] Chat cleared in ${channel}`);
  });

  // ── Mod list changes ──────────────────────────────────────────────────
  client.on('mod', (channel, username) => {
    log.info(`[Twitch] Modded: ${username} in ${channel}`);
  });

  client.on('unmod', (channel, username) => {
    log.info(`[Twitch] Unmodded: ${username} in ${channel}`);
  });

  // ── Channel state changes ─────────────────────────────────────────────
  client.on('slowmode', (channel, enabled, length) => {
    log.info(`[Twitch] Slow mode ${enabled ? `enabled (${length}s)` : 'disabled'} in ${channel}`);
  });

  client.on('subscribers', (channel, enabled) => {
    log.info(`[Twitch] Subscribers-only mode ${enabled ? 'enabled' : 'disabled'} in ${channel}`);
  });

  client.on('emoteonly', (channel, enabled) => {
    log.info(`[Twitch] Emote-only mode ${enabled ? 'enabled' : 'disabled'} in ${channel}`);
  });

  client.on('followersonly', (channel, enabled, length) => {
    log.info(`[Twitch] Followers-only mode ${enabled ? `enabled (${length}m)` : 'disabled'} in ${channel}`);
  });

  client.on('r9kbeta', (channel, enabled) => {
    log.info(`[Twitch] Unique-chat (r9k) mode ${enabled ? 'enabled' : 'disabled'} in ${channel}`);
  });

  // ── Hosting (legacy, still fires on some accounts) ────────────────────
  client.on('hosting', (channel, target, viewers) => {
    log.info(`[Twitch] Hosting: ${channel} is hosting ${target} (${viewers} viewers)`);
  });

  client.on('unhost', (channel, viewers) => {
    log.info(`[Twitch] Unhost: ${channel} stopped hosting`);
  });

  // ── Connection lifecycle ──────────────────────────────────────────────
  client.on('join', (channel, username, self) => {
    if (self) log.info(`[Twitch] Joined channel: ${channel}`);
  });

  client.on('part', (channel, username, self) => {
    if (self) log.info(`[Twitch] Left channel: ${channel}`);
  });

  client.on('reconnect', () => {
    log.info('[Twitch] Reconnecting…');
  });

  client.on('disconnected', (reason) => {
    log.warn('[Twitch] Disconnected:', reason);
    setTimeout(() => client.connect().catch(log.error), 5000);
  });
  await client.connect();
  log.info('[Twitch] tmi.js client ready');
  _tmiClient = client;
  return client;
}
module.exports = {
  say,
  startTwitch,
  setupEventSub,
  getAppToken,
  handleEventSubNotification,
  modHandlers: {
    ban:   twitchBan,
    vip:   twitchVip,
    unvip: twitchUnvip,
  },
};