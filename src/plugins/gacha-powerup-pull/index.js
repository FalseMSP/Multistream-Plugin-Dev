'use strict';

/**
 * gacha-powerup-pull plugin
 * ─────────────────────────
 * Hooks into Twitch Power-ups. Specifically, when a viewer triggers a
 * "Gacha Pull" Power-up (a bits-funded automatic reward redemption — see
 * src/twitch.js's `channel.channel_points_automatic_reward_redemption.add`
 * subscription), this fires a PREMIUM gacha pull, same as the manual
 * `/pull` command in premium-roll.
 *
 * This is deliberately separate from the plain channel-points "Gacha Pull"
 * reward already handled by the `gacha` plugin (which gives a STANDARD
 * pull for channel points). Power-ups cost real bits, so redeeming one
 * should feel like the premium tier.
 *
 * Requires: src/twitch.js subscribes to
 * `channel.channel_points_automatic_reward_redemption.add` and pushes those
 * events through `queue.pushRedeem(...)` with `source: 'power_up'`.
 */

const log   = require('../../logger');
const gacha = require('../gacha');

// Title(s) that should count as the "Gacha Pull" power-up. Twitch's reward
// payload for automatic redemptions doesn't always carry a friendly title —
// it may only carry a `type` enum, which src/twitch.js falls back to with
// underscores turned into spaces (e.g. "gacha_pull" → "gacha pull").
const GACHA_POWERUP_TITLES = ['gacha pull', 'gacha pull powerup', 'gacha'];

let _chatReply = { twitch: null, youtube: null };

function _send(platform, text) {
  const fn = _chatReply[platform];
  if (!fn) return;
  try {
    const result = fn(text);
    if (result && typeof result.catch === 'function') {
      result.catch(e => log.error('[gacha-powerup-pull] chat reply error:', e.message));
    }
  } catch (e) {
    log.error('[gacha-powerup-pull] chat reply error:', e.message);
  }
}

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[gacha-powerup-pull] Chat ready.');
}

function _normaliseTitle(raw) {
  return String(raw).replace(/_/g, ' ').replace(/\s*\[YT\]\s*$/i, '').trim().toLowerCase();
}

function init(context) {
  const q = context.queue;
  if (typeof q?.onRedeem !== 'function') {
    log.warn('[gacha-powerup-pull] context.queue.onRedeem not available — disabled.');
    return;
  }

  q.onRedeem(redeem => {
    // Only react to Power-up-sourced redemptions, not regular channel-point
    // redeems — those are already handled (as a STANDARD pull) by the
    // `gacha` plugin.
    if (redeem.source !== 'power_up') return;

    const raw = redeem.title ?? redeem.rewardType;
    if (!raw) return;

    const title = _normaliseTitle(raw);
    if (!GACHA_POWERUP_TITLES.includes(title)) return;

    const user = redeem.user ?? redeem.username ?? 'someone';
    log.info(`[gacha-powerup-pull] Gacha Pull power-up used by ${user} → premium pull.`);

    _send('twitch',  `@${user} ✨ Power-up activated! Rolling a PREMIUM gacha pull…`);
    _send('youtube', `@${user} ✨ Power-up activated! Rolling a PREMIUM gacha pull…`);

    setTimeout(() => gacha.triggerPull({ user, isPremium: true }), 1500);
  });

  log.info('[gacha-powerup-pull] Loaded — listening for the "Gacha Pull" Power-up.');
}

module.exports = {
  id: 'gacha-powerup-pull',
  init,
  onChatReady,
};
