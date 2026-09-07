'use strict';

/**
 * go-live-notifier
 * ─────────────────
 * Pings a Discord role whenever the Twitch channel goes live.
 *
 * How it works (fully self-contained — no core files touched):
 *   1. On init, registers a `stream.online` EventSub subscription that
 *      points at the SAME `/eventsub` callback the app already uses for
 *      redeems/cheers/subs (so no new public port or URL is needed).
 *   2. `handleEventSubNotification` in src/twitch.js doesn't have a case
 *      for `stream.online`, so this plugin wraps that exported function
 *      at startup and adds its own handling for that one type, then
 *      falls through to the original so nothing else changes.
 *   3. When a `stream.online` (type: "live") notification comes in, it
 *      posts a message to a dedicated Discord webhook, pinging the
 *      configured role.
 *
 * Env vars required:
 *   DISCORD_GOLIVE_WEBHOOK_URL   — Discord webhook to post the announcement to
 *   DISCORD_STREAM_PING_ROLE_ID  — role ID to @ping (the "stream ping" role)
 *
 * Optional:
 *   GOLIVE_MESSAGE               — override the message template. `{url}` is
 *                                   replaced with the channel URL.
 *   GOLIVE_COOLDOWN_MINUTES       — minimum minutes between pings (default 10),
 *                                   guards against duplicate notifications if
 *                                   Twitch fires more than one stream.online
 *                                   event in quick succession.
 */

const log = require('../../logger');

const WEBHOOK_URL       = process.env.DISCORD_GOLIVE_WEBHOOK_URL  ?? '';
const ROLE_ID            = process.env.DISCORD_STREAM_PING_ROLE_ID ?? '';
const COOLDOWN_MS        = (parseFloat(process.env.GOLIVE_COOLDOWN_MINUTES ?? '10') || 10) * 60 * 1000;
const MESSAGE_TEMPLATE   = process.env.GOLIVE_MESSAGE
  ?? "<@&{role}> we're live on Twitch! {url}";

let _twitchChannelUrl = null;
let _lastPingAt       = 0;
let _webhookClient     = null;

function _getWebhookClient() {
  if (_webhookClient) return _webhookClient;
  if (!WEBHOOK_URL) return null;
  try {
    const { WebhookClient } = require('discord.js');
    _webhookClient = new WebhookClient({ url: WEBHOOK_URL });
    return _webhookClient;
  } catch (e) {
    log.error('[go-live-notifier] Invalid DISCORD_GOLIVE_WEBHOOK_URL:', e.message);
    return null;
  }
}

async function _announceGoLive() {
  if (!WEBHOOK_URL || !ROLE_ID) {
    log.warn('[go-live-notifier] Missing DISCORD_GOLIVE_WEBHOOK_URL or DISCORD_STREAM_PING_ROLE_ID — skipping ping.');
    return;
  }

  const now = Date.now();
  if (now - _lastPingAt < COOLDOWN_MS) {
    log.info('[go-live-notifier] Suppressing duplicate go-live ping (cooldown active).');
    return;
  }
  _lastPingAt = now;

  const webhook = _getWebhookClient();
  if (!webhook) return;

  const content = MESSAGE_TEMPLATE
    .replace('{role}', ROLE_ID)
    .replace('{url}', _twitchChannelUrl ?? '');

  try {
    await webhook.send({
      content,
      allowedMentions: { roles: [ROLE_ID] },
    });
    log.info('[go-live-notifier] Go-live ping sent.');
  } catch (e) {
    log.error('[go-live-notifier] Failed to send go-live ping:', e.message);
  }
}

module.exports = {
  id: 'go-live-notifier',

  async init(context) {
    const { twitch } = context;

    try {
      const broadcasterId = await twitch.getBroadcasterId();
      if (!broadcasterId) {
        log.warn('[go-live-notifier] Could not resolve broadcaster ID — stream.online subscription skipped.');
        return;
      }

      // Reuse the exact same callback + secret as the app's main EventSub
      // setup, so Twitch delivers this to the endpoint that's already
      // publicly reachable — no extra infra required.
      const { getEventSubCallbackUrl, getTwitchSecret } = require('../../websub');
      const callbackUrl = getEventSubCallbackUrl();
      const secret       = getTwitchSecret();

      if (!callbackUrl) {
        log.warn('[go-live-notifier] No PUBLIC_URL set — stream.online subscription skipped.');
        return;
      }

      const channelLogin = process.env.TWITCH_BROADCASTER_LOGIN
        ?? (process.env.TWITCH_CHANNELS ?? '').split(',')[0]?.trim();
      _twitchChannelUrl = channelLogin ? `https://twitch.tv/${channelLogin}` : '';

      // Check for / create the subscription (mirrors the pattern the core
      // module uses for its own subscriptions).
      const existing = await twitch.helixRequest('GET', '/eventsub/subscriptions?type=stream.online');
      const active = existing?.data?.find(
        s => s.condition?.broadcaster_user_id === broadcasterId
          && s.status === 'enabled'
          && s.transport?.callback === callbackUrl
      );

      if (active) {
        log.info('[go-live-notifier] stream.online subscription already active.');
      } else {
        const stale = existing?.data?.filter(
          s => s.condition?.broadcaster_user_id === broadcasterId
            && s.status === 'enabled'
            && s.transport?.callback !== callbackUrl
        ) ?? [];
        for (const sub of stale) {
          try { await twitch.helixRequest('DELETE', `/eventsub/subscriptions?id=${sub.id}`); }
          catch (e) { log.warn('[go-live-notifier] Could not delete stale sub:', e.message); }
        }

        await twitch.helixRequest('POST', '/eventsub/subscriptions', {
          type: 'stream.online',
          version: '1',
          condition: { broadcaster_user_id: broadcasterId },
          transport: { method: 'webhook', callback: callbackUrl, secret },
        });
        log.info('[go-live-notifier] stream.online subscription created.');
      }
    } catch (e) {
      log.warn('[go-live-notifier] EventSub setup failed:', e.message);
    }

    // Hook into the shared /eventsub dispatcher. handleEventSubNotification
    // has no case for 'stream.online', so we wrap the exported function —
    // this touches nothing in src/twitch.js itself, just the live object
    // reference other modules already call through.
    const twitchCore = require('../../twitch');
    const _originalHandler = twitchCore.handleEventSubNotification;
    twitchCore.handleEventSubNotification = function (type, event, queue) {
      if (type === 'stream.online' && event?.type === 'live') {
        _announceGoLive().catch(e => log.error('[go-live-notifier] announce error:', e.message));
      }
      return _originalHandler(type, event, queue);
    };
  },
};