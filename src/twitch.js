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
// ── Third-party emotes (BTTV / FFZ / 7TV) ────────────────────────────────
//
// Fetched once at startup (global + channel-specific) and refreshed every hour.
// Stored as a flat { emoteName: imageUrl } map passed into every pushMessage().

/** @type {Record<string, string>} */
let _thirdPartyEmotes = {};

async function _fetchThirdPartyEmotes(channelLogin) {
  const { default: fetch } = await import('node-fetch');
  const map = {};

  // Strip any leading '#' that tmi.js channel names may have
  const login = channelLogin ? channelLogin.replace(/^#/, '').toLowerCase() : null;

  // ── BTTV global ──────────────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.betterttv.net/3/cached/emotes/global');
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d)) {
        for (const e of d) map[e.code] = `https://cdn.betterttv.net/emote/${e.id}/2x`;
      }
    }
  } catch (err) { log.warn('[Twitch] BTTV global fetch failed:', err.message); }

  // ── BTTV channel ─────────────────────────────────────────────────────────
  if (login) {
    try {
      const userId = await _resolveUserId(login);
      if (userId) {
        const r = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${userId}`);
        if (r.ok) {
          const d = await r.json();
          const emotes = [...(d.channelEmotes ?? []), ...(d.sharedEmotes ?? [])];
          for (const e of emotes) map[e.code] = `https://cdn.betterttv.net/emote/${e.id}/2x`;
          log.info(`[Twitch] BTTV channel: loaded ${emotes.length} emotes for ${login}`);
        } else {
          log.warn(`[Twitch] BTTV channel fetch returned ${r.status} for ${login} (id: ${userId})`);
        }
      }
    } catch (err) { log.warn('[Twitch] BTTV channel fetch failed:', err.message); }
  }

  // ── FFZ global ───────────────────────────────────────────────────────────
  try {
    const r = await fetch('https://api.frankerfacez.com/v1/set/global');
    if (r.ok) {
      const d = await r.json();
      for (const set of Object.values(d.sets ?? {})) {
        for (const e of (set.emoticons ?? [])) {
          const url = e.urls?.['2'] ?? e.urls?.['1'];
          if (url) map[e.name] = url.startsWith('//') ? 'https:' + url : url;
        }
      }
    }
  } catch (err) { log.warn('[Twitch] FFZ global fetch failed:', err.message); }

  // ── FFZ channel ──────────────────────────────────────────────────────────
  if (login) {
    try {
      const r = await fetch(`https://api.frankerfacez.com/v1/room/${login}`);
      if (r.ok) {
        const d = await r.json();
        let count = 0;
        for (const set of Object.values(d.sets ?? {})) {
          for (const e of (set.emoticons ?? [])) {
            const url = e.urls?.['2'] ?? e.urls?.['1'];
            if (url) { map[e.name] = url.startsWith('//') ? 'https:' + url : url; count++; }
          }
        }
        log.info(`[Twitch] FFZ channel: loaded ${count} emotes for ${login}`);
      }
    } catch (err) { log.warn('[Twitch] FFZ channel fetch failed:', err.message); }
  }

  // ── 7TV global ───────────────────────────────────────────────────────────
  try {
    const r = await fetch('https://7tv.io/v3/emote-sets/global');
    if (r.ok) {
      const d = await r.json();
      for (const e of (d.emotes ?? [])) {
        const host = e.data?.host;
        if (!host) continue;
        const file = host.files?.find(f => f.name === '2x.webp') ?? host.files?.find(f => f.name === '2x.avif') ?? host.files?.[0];
        if (file) map[e.name] = `https:${host.url}/${file.name}`;
      }
    }
  } catch (err) { log.warn('[Twitch] 7TV global fetch failed:', err.message); }

  // ── 7TV channel ──────────────────────────────────────────────────────────
  // The v3 endpoint is GET /v3/users/twitch/:twitch_user_id
  // Response: { emote_set: { emotes: [{ name, data: { host: { url, files } } }] } }
  if (login) {
    try {
      const userId = await _resolveUserId(login);
      if (userId) {
        const r = await fetch(`https://7tv.io/v3/users/twitch/${userId}`);
        if (r.ok) {
          const d = await r.json();
          const emotes = d.emote_set?.emotes ?? [];
          let count = 0;
          for (const e of emotes) {
            const host = e.data?.host;
            if (!host) continue;
            const file = host.files?.find(f => f.name === '2x.webp') ?? host.files?.find(f => f.name === '2x.avif') ?? host.files?.[0];
            if (file) { map[e.name] = `https:${host.url}/${file.name}`; count++; }
          }
          log.info(`[Twitch] 7TV channel: loaded ${count} emotes for ${login}`);
        } else {
          log.warn(`[Twitch] 7TV channel fetch returned ${r.status} for ${login}`);
        }
      }
    } catch (err) { log.warn('[Twitch] 7TV channel fetch failed:', err.message); }
  }

  const count = Object.keys(map).length;
  log.info(`[Twitch] Third-party emotes loaded: ${count} total (BTTV + FFZ + 7TV)`);
  _thirdPartyEmotes = map;
}

/** Resolve Twitch login → numeric user ID.
 *  Tries Helix first; falls back to ivr.fi (no auth required) if Helix fails. */
let _broadcasterUserId = null;
async function _resolveUserId(login) {
  if (_broadcasterUserId) return _broadcasterUserId;
  const { default: fetch } = await import('node-fetch');

  // Primary: Helix API (needs CLIENT_ID + app token)
  try {
    const data = await helixRequest('GET', `/users?login=${login}`);
    _broadcasterUserId = data?.data?.[0]?.id ?? null;
  } catch (err) {
    log.warn(`[Twitch] _resolveUserId Helix failed for ${login}:`, err.message);
  }

  // Fallback: ivr.fi — public proxy, no auth needed
  if (!_broadcasterUserId) {
    try {
      const r = await fetch(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(login)}`);
      if (r.ok) {
        const d = await r.json();
        _broadcasterUserId = d?.[0]?.id ?? null;
      }
    } catch (err) {
      log.warn(`[Twitch] _resolveUserId ivr.fi fallback failed for ${login}:`, err.message);
    }
  }

  if (_broadcasterUserId) log.info(`[Twitch] Resolved user ID for ${login}: ${_broadcasterUserId}`);
  else log.warn(`[Twitch] Could not resolve user ID for ${login} — channel emotes (BTTV/7TV) will be skipped`);
  return _broadcasterUserId;
}

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
//   bits:read, channel:read:subscriptions, channel:manage:redemptions
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

/**
 * Like helixRequest but authenticates with the broadcaster's user OAuth token
 * instead of the app token. Required for endpoints that need user-level scopes
 * (e.g. channel:manage:redemptions for PATCH custom_rewards).
 */
async function helixUserRequest(method, path, body) {
  const { default: fetch } = await import('node-fetch');
  const userToken = await getUserToken();
  if (!userToken) throw new Error('Missing User OAUTH Token — run twitch-auth.js');
  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    method,
    headers: {
      'Client-ID':     CLIENT_ID,
      'Authorization': `Bearer ${userToken}`,
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

  // Bug 2 fix: also check that the callback URL matches the current public URL.
  // A sub can be 'enabled' but pointing at a stale tunnel URL from a previous
  // run — in that case Twitch is sending events to a dead endpoint. We must
  // delete it and create a fresh one with the correct callback URL.
  const activeMatch = existing?.data?.find(
    s => s.condition?.broadcaster_user_id === broadcasterId
      && s.status === 'enabled'
      && s.transport?.callback === callbackUrl
  );
  if (activeMatch) {
    log.info(`[Twitch] EventSub subscription already active: ${type}`);
    return;
  }

  // Delete any enabled subs for this type that point at the wrong URL so
  // we don't accumulate orphaned subscriptions.
  const staleEnabled = existing?.data?.filter(
    s => s.condition?.broadcaster_user_id === broadcasterId
      && s.status === 'enabled'
      && s.transport?.callback !== callbackUrl
  ) ?? [];
  for (const sub of staleEnabled) {
    try {
      await helixRequest('DELETE', `/eventsub/subscriptions?id=${sub.id}`);
      log.info(`[Twitch] Deleted stale enabled sub ${sub.id} (old callback: ${sub.transport?.callback})`);
    } catch (err) {
      log.warn(`[Twitch] Could not delete stale sub ${sub.id}:`, err.message);
    }
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

    // channel.follow v2 requires moderator_user_id in addition to broadcaster_user_id.
    // Using the broadcaster as their own moderator is always valid.
    await subscribeEventSub(broadcasterId, callbackUrl, secret,
      'channel.follow', '2',
      { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId });

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
        username:  event.user_name ?? 'anonymous',
        amount:    event.bits,
        message:   event.message || null,
        timestamp: new Date(event.broadcasted_at ?? Date.now()),
      });
      log.info(`[Twitch] Cheer: ${event.user_name} cheered ${event.bits} bits`);
      break;

    case 'channel.subscribe':
      queue.pushDonation({
        platform:  'twitch',
        type:      'sub',
        username:  event.user_name,
        tier:      event.tier,
        gifted:    event.is_gift,
        timestamp: new Date(),
      });
      log.info(`[Twitch] Sub: ${event.user_name} (Tier ${event.tier})`);
      break;

    case 'channel.subscription.gift':
      queue.pushDonation({
        platform:  'twitch',
        type:      'subgift',
        username:  event.user_name ?? 'anonymous',
        recipient: null,
        tier:      event.tier,
        quantity:  event.total,
        cumulative: event.cumulative_total ?? null,
        timestamp: new Date(),
      });
      log.info(`[Twitch] Sub gift: ${event.user_name} gifted ${event.total} subs`);
      break;

    case 'channel.subscription.message':
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
      log.info(`[Twitch] Resub: ${event.user_name} (${event.cumulative_months} months)`);
      break;

    case 'channel.follow':
      log.info(`[Twitch] Follow: ${event.user_name}`);
      break;

    default:
      log.warn('[Twitch] Unhandled EventSub type:', type);
  }
}

// ── Mod actions ───────────────────────────────────────────────────────────

async function twitchBan(platform, username, reason) {
  const broadcasterId = await getBroadcasterId();
  const userData = await helixRequest('GET', `/users?login=${username}`);
  const userId   = userData?.data?.[0]?.id;
  if (!userId) throw new Error(`User not found: ${username}`);
  await helixRequest('POST', `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, {
    data: { user_id: userId, reason: reason ?? '' },
  });
}

async function twitchVip(platform, username) {
  const broadcasterId = await getBroadcasterId();
  const userData = await helixRequest('GET', `/users?login=${username}`);
  const userId   = userData?.data?.[0]?.id;
  if (!userId) throw new Error(`User not found: ${username}`);
  await helixRequest('POST', `/channels/vips?broadcaster_id=${broadcasterId}&user_id=${userId}`);
}

async function twitchUnvip(platform, username) {
  const broadcasterId = await getBroadcasterId();
  const userData = await helixRequest('GET', `/users?login=${username}`);
  const userId   = userData?.data?.[0]?.id;
  if (!userId) throw new Error(`User not found: ${username}`);
  await helixRequest('DELETE', `/channels/vips?broadcaster_id=${broadcasterId}&user_id=${userId}`);
}

// ── IRC client ────────────────────────────────────────────────────────────

let _tmiClient = null;

function say(text) {
  if (!_tmiClient || !CHANNELS.length) return;
  _tmiClient.say(CHANNELS[0], text).catch(err => log.error('[Twitch] say() error:', err.message));
}

async function startTwitch(queue) {
  if (!TOKEN || !BOT_NICK || !CHANNELS.length) {
    log.warn('[Twitch] IRC credentials incomplete — chat mirroring disabled.');
    return null;
  }

  const client = new tmi.Client({
    options:    { debug: false },
    identity:   { username: BOT_NICK, password: TOKEN },
    channels:   CHANNELS,
    connection: { reconnect: true, secure: true },
  });

  // Fetch BTTV/FFZ/7TV emotes now, then refresh every hour
  _fetchThirdPartyEmotes(BROADCASTER).catch(err => log.warn('[Twitch] Third-party emote fetch error:', err.message));
  setInterval(() => {
    _fetchThirdPartyEmotes(BROADCASTER).catch(err => log.warn('[Twitch] Third-party emote refresh error:', err.message));
  }, 60 * 60 * 1000);

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
    queue.pushMessage({
      platform: 'twitch',
      username,
      message,
      color:           tags['color'] ?? '',
      emotes:          tags['emotes'] ?? '',   // e.g. "302856228:0-6,8-14/emotesv2_abc:16-22"
      thirdPartyEmotes: _thirdPartyEmotes,
    });
  });

  // ── Twitch watch-streak share (USERNOTICE msg-id=viewermilestone) ────────
  // Fires when a viewer clicks "Share Watch Streak" in the Twitch UI.
  // Tags of interest:
  //   msg-id            = 'viewermilestone'
  //   msg-param-value   = streak length in consecutive streams (string)
  //   display-name      = viewer's display name
  client.on('raw_message', (messageData) => {
    if (messageData?.command !== 'USERNOTICE') return;
    const tags = messageData.tags ?? {};
    if (tags['msg-id'] !== 'viewermilestone') return;

    const username    = tags['display-name'] ?? tags.login ?? 'unknown';
    const streakCount = parseInt(tags['msg-param-value'] ?? '0', 10);
    if (!streakCount || streakCount < 1) return;

    log.info(`[Twitch] Watch streak share: ${username} — ${streakCount} stream(s)`);
    queue.pushMessage({
      platform: 'twitch',
      username,
      message:  tags['system-msg'] ?? `${username} has watched ${streakCount} streams in a row!`,
      type:     'watch-streak',
      streak:   streakCount,
    });
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
// ── Channel point reward management ──────────────────────────────────────

/**
 * Enable or disable a custom channel point reward by name.
 * Uses the broadcaster's user OAuth token (helixUserRequest) so it works on
 * manually-created rewards too, not just ones created by this app's client ID.
 *
 * @param {string}  rewardName  Exact display name of the reward
 * @param {boolean} enabled
 * @returns {Promise<boolean>}  true if the reward was found and updated
 */
async function setRewardEnabled(rewardName, enabled) {
  try {
    const broadcasterId = await getBroadcasterId();
    if (!broadcasterId) {
      log.warn('[Twitch] setRewardEnabled: could not resolve broadcaster ID');
      return false;
    }

    const data = await helixUserRequest(
      'GET',
      `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`
    );
    const rewards = data?.data ?? [];
    const reward  = rewards.find(r => r.title === rewardName);

    if (!reward) {
      log.warn(`[Twitch] setRewardEnabled: reward not found — "${rewardName}"`);
      return false;
    }

    await helixUserRequest(
      'PATCH',
      `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${reward.id}`,
      { is_enabled: enabled }
    );
    log.info(`[Twitch] Reward "${rewardName}" ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  } catch (err) {
    log.error(`[Twitch] setRewardEnabled("${rewardName}", ${enabled}) failed:`, err.message);
    return false;
  }
}

module.exports = {
  say,
  startTwitch,
  setupEventSub,
  getAppToken,
  handleEventSubNotification,
  setRewardEnabled,
  helixUserRequest,
  getBroadcasterId,
  modHandlers: {
    ban:   twitchBan,
    vip:   twitchVip,
    unvip: twitchUnvip,
  },
};