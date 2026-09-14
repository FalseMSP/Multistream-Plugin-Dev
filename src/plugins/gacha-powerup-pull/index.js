'use strict';

/**
 * gacha-powerup-pull plugin
 * ─────────────────────────
 * Hooks into Twitch Power-ups. Specifically, when a viewer triggers a
 * "Gacha Pull" custom Power-up (bits, not channel points), this fires a
 * PREMIUM gacha pull, same as the manual `/pull` command in premium-roll.
 *
 * This is deliberately separate from the plain channel-points "Gacha Pull"
 * reward already handled by the `gacha` plugin (which gives a STANDARD
 * pull for channel points). The Power-up costs real bits, so redeeming it
 * should feel like the premium tier.
 *
 * Requires: src/twitch.js subscribes to
 * `channel.custom_power_up_redemption.add` (the dedicated custom-Power-up
 * event) and `channel.bits.use` (covers Twitch's built-in Power-ups), and
 * pushes those through `queue.pushRedeem(...)` with `source: 'power_up'`.
 */

const log   = require('../../logger');
const gacha = require('../gacha');

// Title(s) that should count as the "Gacha Pull" power-up. Twitch's payload
// naming isn't fully predictable here — a custom Power-up may report a
// friendly title ("Gacha Pull"), while built-in ones only report a type
// enum. Matching is done after aggressively normalising (lowercase,
// collapse all non-alphanumeric runs to a single space), so "Gacha_Pull",
// "gacha-pull", "GachaPull", etc. all resolve to the same string.
const GACHA_POWERUP_TITLES = ['gacha pull', 'gachapull', 'gacha pull powerup', 'gacha'];

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
  return String(raw)
    .replace(/\s*\[YT\]\s*$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
    if (!GACHA_POWERUP_TITLES.includes(title)) {
      log.debug(`[gacha-powerup-pull] Ignoring power-up redeem with unmatched title: "${raw}" (normalised: "${title}")`);
      return;
    }

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
