'use strict';

/**
 * WebSub (PubSubHubbub) server
 * ─────────────────────────────
 * Receives push notifications from YouTube when a channel goes live.
 * Verifies HMAC-SHA1 signature, parses the Atom feed, and triggers masterchat.
 */

const express   = require('express');
const crypto    = require('crypto');
const { parseStringPromise } = require('xml2js');
const log       = require('./logger');

const PUBLIC_URL     = (process.env.WEBSUB_PUBLIC_URL ?? '').replace(/\/$/, '');
const SECRET         = process.env.WEBSUB_SECRET       ?? 'change-me-please';
const PORT           = parseInt(process.env.WEBSUB_PORT ?? '8081', 10);
const HUB            = 'https://pubsubhubbub.appspot.com/';
const LEASE_SECONDS  = 86400;
const YT_CHANNEL_ID  = process.env.YT_CHANNEL_ID ?? '';

let _queue = null;  // set on startWebSub()

// ── HMAC verification ─────────────────────────────────────────────────────

function verifySignature(body, header) {
  if (!header?.startsWith('sha1=')) return false;
  const expected = crypto.createHmac('sha1', SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(header.slice(5))
  );
}

// ── Subscription ──────────────────────────────────────────────────────────

async function subscribe(channelId) {
  const { default: fetch } = await import('node-fetch');
  const topic    = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
  const callback = `${PUBLIC_URL}/websub`;

  const body = new URLSearchParams({
    'hub.mode':          'subscribe',
    'hub.topic':         topic,
    'hub.callback':      callback,
    'hub.lease_seconds': String(LEASE_SECONDS),
    'hub.secret':        SECRET,
  });

  const res = await fetch(HUB, { method: 'POST', body });
  if (res.status === 202 || res.status === 204) {
    log.info('[WebSub] Subscription accepted for channel', channelId);
  } else {
    log.error('[WebSub] Subscription failed', res.status, await res.text());
  }
}

async function renewLoop(channelId) {
  while (true) {
    await new Promise(r => setTimeout(r, (LEASE_SECONDS - 3600) * 1000));
    log.info('[WebSub] Renewing subscription…');
    await subscribe(channelId).catch(e => log.error('[WebSub] Renew error:', e));
  }
}

// ── Express routes ────────────────────────────────────────────────────────

function buildApp() {
  const app = express();

  // GET — hub verification challenge
  app.get('/websub', (req, res) => {
    const { 'hub.challenge': challenge, 'hub.mode': mode } = req.query;
    log.info('[WebSub] Hub verification:', mode);
    res.send(challenge ?? '');
  });

  // POST — feed notification
  app.post('/websub', express.raw({ type: '*/*' }), async (req, res) => {
    const sig = req.headers['x-hub-signature'] ?? '';

    if (SECRET && !verifySignature(req.body, sig)) {
      log.warn('[WebSub] Signature mismatch — ignoring');
      return res.sendStatus(403);
    }

    res.sendStatus(204); // respond fast before processing

    try {
      const xml = req.body.toString('utf8');
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      const entries = parsed?.feed?.entry;
      const list = Array.isArray(entries) ? entries : entries ? [entries] : [];

      for (const entry of list) {
        const videoId = entry?.['yt:videoId'];
        if (videoId) {
          log.info('[WebSub] New video notification:', videoId);
          // Dynamically require to avoid circular dep at module load
          const yt = require('./youtube');
          yt.triggerVideo(videoId, _queue);
        }
      }
    } catch (err) {
      log.error('[WebSub] Parse error:', err.message);
    }
  });

  return app;
}

// ── Entry point ───────────────────────────────────────────────────────────

async function startWebSub(queue) {
  if (!PUBLIC_URL || !YT_CHANNEL_ID) {
    log.info('[WebSub] Not configured — YouTube will use polling fallback.');
    return false;
  }

  _queue = queue;

  const app = buildApp();
  await new Promise((resolve, reject) =>
    app.listen(PORT, '0.0.0.0', (err) => err ? reject(err) : resolve())
  );
  log.info(`[WebSub] Server listening on port ${PORT}`);

  await subscribe(YT_CHANNEL_ID);
  renewLoop(YT_CHANNEL_ID); // not awaited

  return true;
}

module.exports = { startWebSub };
