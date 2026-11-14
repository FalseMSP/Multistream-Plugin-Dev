'use strict';

/**
 * HTTP server
 * ───────────
 * Handles two push notification systems on the same express instance:
 *  • GET/POST /websub       — YouTube WebSub (PubSubHubbub)
 *  • POST     /eventsub     — Twitch EventSub (channel point redeems)
 */

const express   = require('express');
const crypto    = require('crypto');
const { parseStringPromise } = require('xml2js');
const log       = require('./logger');
const { createLeaseMachine } = require('./websub-lease-machine');
const connections = require('./dashboard/connections');
const { REAL_CLOCK } = require('./fsm');

const PUBLIC_URL    = (process.env.WEBSUB_PUBLIC_URL ?? '').replace(/\/$/, '');
const { resolveSecret } = require('./secret-store');
const YT_SECRET     = resolveSecret('WEBSUB_SECRET',        'websub',         'change-me-please');
const TWITCH_SECRET = resolveSecret('TWITCH_EVENTSUB_SECRET', 'eventsub',     'change-me-twitch');
const CLIENT_ID     = process.env.TWITCH_CLIENT_ID        ?? '';
const PORT          = parseInt(process.env.WEBSUB_PORT ?? '8081', 10);
const HUB           = 'https://pubsubhubbub.appspot.com/';
const LEASE_SECONDS = 86400;
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID ?? '';

let _queue = null;
let ytLease = null; // lease machine for the YouTube WebSub subscription

// ── YouTube WebSub ────────────────────────────────────────────────────────

function verifyYtSignature(body, header) {
  if (!header?.startsWith('sha1=')) return false;
  const expected = crypto.createHmac('sha1', YT_SECRET).update(body).digest('hex');
  // FIX: wrap in try/catch — timingSafeEqual throws if buffers differ in
  // length (e.g. a bad secret or truncated header), which previously caused
  // an unhandled exception that silently dropped the request.
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header.slice(5)));
  } catch (e) {
    log.error('[WebSub] YT sig verify timingSafeEqual threw:', e.message,
      '| expected.len:', expected.length, '| received.len:', header.slice(5).length);
    return false;
  }
}

async function ytSubscribe(channelId) {
  const { default: fetch } = await import('node-fetch');
  const topic    = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
  const callback = `${PUBLIC_URL}/websub`;

  const body = new URLSearchParams({
    'hub.mode':          'subscribe',
    'hub.topic':         topic,
    'hub.callback':      callback,
    'hub.lease_seconds': String(LEASE_SECONDS),
    'hub.secret':        YT_SECRET,
  });

  const res = await fetch(HUB, { method: 'POST', body });
  if (res.status === 202 || res.status === 204) {
    log.info('[WebSub] YouTube subscription accepted for channel', channelId);
  } else {
    log.error('[WebSub] YouTube subscription failed', res.status, await res.text());
  }
}

// ytRenewLoop was replaced by the lease machine (websub-lease-machine.js):
// same renewal timing (lease minus 1 h margin), plus failure backoff and
// state surfacing the old loop lacked.

// ── Twitch EventSub ───────────────────────────────────────────────────────

const TWITCH_MSG_ID        = 'twitch-eventsub-message-id';
const TWITCH_MSG_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MSG_SIGNATURE = 'twitch-eventsub-message-signature';
const TWITCH_MSG_TYPE      = 'twitch-eventsub-message-type';

function verifyTwitchSignature(body, headers) {
  const msgId        = headers[TWITCH_MSG_ID]        ?? '';
  const msgTimestamp = headers[TWITCH_MSG_TIMESTAMP] ?? '';
  const msgSig       = headers[TWITCH_MSG_SIGNATURE] ?? '';

  // body is a raw Buffer collected by the app-level middleware in buildApp().
  // Feed each HMAC component via separate .update() calls so the bytes are
  // hashed exactly as Twitch signed them.
  const hmac = crypto.createHmac('sha256', TWITCH_SECRET);
  hmac.update(msgId);
  hmac.update(msgTimestamp);
  hmac.update(body);
  const expected = 'sha256=' + hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(msgSig));
  } catch (e) {
    log.error('[EventSub] sig verify timingSafeEqual threw:', e.message, '| expected.len:', expected.length, '| received.len:', msgSig.length);
    return false;
  }
}

/**
 * Purge any EventSub subscriptions for channel point redeems that are not
 * in 'enabled' state (e.g. webhook_callback_verification_failed from a
 * previous run where the server wasn't ready in time).
 */
async function purgeStaleTwitchSubs(appToken) {
  if (!appToken || !CLIENT_ID) return;
  try {
    const { default: fetch } = await import('node-fetch');
    const res  = await fetch(
      'https://api.twitch.tv/helix/eventsub/subscriptions?type=channel.channel_points_custom_reward_redemption.add',
      { headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${appToken}` } }
    );
    if (!res.ok) {
      log.warn('[EventSub] Could not list subs for purge:', res.status);
      return;
    }
    const data  = await res.json();
    const stale = (data?.data ?? []).filter(s => s.status !== 'enabled');
    for (const sub of stale) {
      const del = await fetch(
        `https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`,
        {
          method:  'DELETE',
          headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${appToken}` },
        }
      );
      if (del.status === 204) {
        log.info(`[EventSub] Purged stale sub ${sub.id} (${sub.status})`);
      } else {
        log.warn(`[EventSub] Failed to delete sub ${sub.id}:`, del.status);
      }
    }
  } catch (err) {
    log.warn('[EventSub] Purge error:', err.message);
  }
}

// ── Express app ───────────────────────────────────────────────────────────

function buildApp() {
  const app = express();

  // ── Raw body collector ─────────────────────────────────────────────────
  // Must be the FIRST middleware. Collects req.body as a Buffer before any
  // other parser can touch it. This is intentionally on the isolated app
  // instance created here, so nothing outside can interfere.
  app.use((req, res, next) => {
    // Body cap (review W1): this collector runs on a publicly reachable
    // port BEFORE signature verification — unbounded concatenation was a
    // memory-exhaustion vector. 256 KB is ~1000x the largest legitimate
    // WebSub/EventSub notification body (~1-2 KB).
    const MAX_BODY_BYTES = 256 * 1024;
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data',  chunk => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        log.warn(`[WebSub] Oversized body (${total} bytes > ${MAX_BODY_BYTES}) on ${req.path} — rejecting.`);
        res.status(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',   ()    => { if (aborted) return; req.body = Buffer.concat(chunks); next(); });
    req.on('error', err   => { if (aborted) return; log.error('[WebSub] Body read error:', err.message); res.status(400).end(); });
  });

  // ── YouTube WebSub routes ──────────────────────────────────────────────

  app.get('/websub', (req, res) => {
    const { 'hub.challenge': challenge, 'hub.mode': mode } = req.query;
    log.info('[WebSub] YouTube hub verification:', mode);
    res.send(challenge ?? '');
  });

  app.post('/websub', async (req, res) => {
    const sig = req.headers['x-hub-signature'] ?? '';
    if (YT_SECRET && !verifyYtSignature(req.body, sig)) {
      log.warn('[WebSub] YouTube signature mismatch — ignoring');
      return res.sendStatus(403);
    }
    res.sendStatus(204);

    try {
      const xml     = req.body.toString('utf8');
      const parsed  = await parseStringPromise(xml, { explicitArray: false });
      const entries = parsed?.feed?.entry;
      const list    = Array.isArray(entries) ? entries : entries ? [entries] : [];
      for (const entry of list) {
        const videoId = entry?.['yt:videoId'];
        if (videoId) {
          log.info('[WebSub] YouTube video notification:', videoId);
          const yt = require('./youtube');
          yt.triggerVideo(videoId, _queue);
        }
      }
    } catch (err) {
      log.error('[WebSub] YouTube parse error:', err.message);
    }
  });

  // ── Twitch EventSub route ──────────────────────────────────────────────

  app.post('/eventsub', (req, res) => {
    if (!verifyTwitchSignature(req.body, req.headers)) {
      log.warn('[EventSub] Twitch signature mismatch — ignoring');
      return res.sendStatus(403);
    }

    const msgType = req.headers[TWITCH_MSG_TYPE];

    // FIX: wrap JSON.parse in try/catch — an unhandled throw here meant the
    // challenge response was never sent, leaving the subscription permanently
    // in webhook_callback_verification_failed and killing all Twitch events.
    let body;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
      log.error('[EventSub] Failed to parse request body as JSON:', err.message);
      return res.sendStatus(400);
    }

    // Twitch sends a webhook_callback_verification challenge on first subscribe
    if (msgType === 'webhook_callback_verification') {
      log.info('[EventSub] Twitch challenge verified ✓');
      return res.status(200).send(body.challenge);
    }

    if (msgType === 'notification') {
      const type  = body.subscription?.type;
      const event = body.event;
      if (type && event && _queue) {
        log.info(`[EventSub] Notification: ${type}`);
        const twitch = require('./twitch');
        twitch.handleEventSubNotification(type, event, _queue);
      }
      return res.sendStatus(204);
    }

    if (msgType === 'revocation') {
      log.warn('[EventSub] Twitch subscription revoked:', body.subscription?.status);
      return res.sendStatus(204);
    }

    res.sendStatus(204);
  });

  return app;
}

// ── Entry point ───────────────────────────────────────────────────────────

async function startWebSub(queue) {
  // The EventSub server must start even if YouTube is not configured,
  // because Twitch needs the /eventsub endpoint to be up before it
  // creates the subscription (otherwise the challenge fails).
  if (!PUBLIC_URL) {
    log.info('[WebSub] WEBSUB_PUBLIC_URL not set — WebSub/EventSub server disabled.');
    return false;
  }

  _queue = queue;

  const app = buildApp();
  await new Promise((resolve, reject) =>
    app.listen(PORT, '0.0.0.0', (err) => err ? reject(err) : resolve())
  );
  log.info(`[WebSub/EventSub] Server listening on port ${PORT}`);

  // NOTE: purgeStaleTwitchSubs is intentionally NOT called here.
  // index.js calls it once in the correct order: purge → setupEventSub.
  // Calling it here too risks deleting a freshly-created subscription whose
  // challenge handshake is still in-flight (status not yet 'enabled').

  if (YT_CHANNEL_ID) {
    // Lease lifecycle via the explicit lease machine (replaces the old
    // `while (true) { sleep(lease-1h); renew(); }` loop): same renewal
    // timing, but a failed renewal now retries with exponential backoff
    // instead of silently dying until the next process restart, and state
    // changes are surfaced to onState for a future dashboard connections
    // widget (the "no platform connection status" finding).
    ytLease = createLeaseMachine({
      clock: REAL_CLOCK,
      subscribe: ytSubscribe,
      onLog: (m) => log.info(m),
      onState: (state) => {
        log.info(`[WebSub] YouTube push lease: ${state}`);
        // Surface the lease lifecycle in the connections widget (review W2):
        // subscribed = green, renewing/failed = amber/red.
        const map = { subscribed: ['ok', ''], subscribing: ['degraded', 'Subscribing…'],
                      renewing: ['degraded', 'Renewing lease…'], failed: ['down', 'Renewal failed — retrying with backoff'],
                      unsubscribed: ['off', 'Not subscribed'] };
        const [st, detail] = map[state] || ['off', state];
        connections.setStatus('websub', st, detail);
      },
    });
    ytLease.start(YT_CHANNEL_ID);
  } else {
    log.info('[WebSub] YT_CHANNEL_ID not set — YouTube WebSub skipped.');
  }

  return true;
}

// Called by twitch.js after connecting, to register the EventSub subscription
function getEventSubCallbackUrl() {
  return PUBLIC_URL ? `${PUBLIC_URL}/eventsub` : null;
}

function getTwitchSecret() {
  return TWITCH_SECRET;
}

module.exports = { startWebSub, getEventSubCallbackUrl, getTwitchSecret, purgeStaleTwitchSubs, getYtLease: () => ytLease };