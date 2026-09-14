'use strict';

/**
 * gacha-powerup-pull plugin
 * ─────────────────────────
 * Hooks into Twitch Power-ups. Specifically, when a viewer triggers a
 * "Gacha Pull" Power-up (a bits-funded automatic reward redemption — see
 * src/twitch.js's `channel.channel_points_automatic_reward_redemption.add`
 * and `channel.bits.use` subscriptions), this fires a PREMIUM gacha pull by
 * activating the `premium-roll` plugin — exactly the same code path used by
 * the manual `/pull` Discord slash command, and the same effect as cheering
 * 100 bits (one premium pull, plus the chat announcement).
 *
 * Routing through `premium-roll.triggerPremiumPull(user)` means:
 *   • The power-up "activates the gacha pull premium plugin" (premium-roll),
 *     not the bare gacha engine.
 *   • The chat announcement is sent from one place, with the same wording
 *     whether the trigger was a Discord slash command or a Twitch power-up.
 *   • If `/pull` ever grows new behaviour (logging, sound effect, etc.),
 *     the power-up automatically gets the same behaviour for free.
 *
 * This is deliberately separate from the plain channel-points "Gacha Pull"
 * reward already handled by the `gacha` plugin (which gives a STANDARD pull
 * for channel points). Power-ups cost real bits, so redeeming one should
 * feel like the premium tier — matching the 100-bits-cheer behaviour.
 *
 * Requires: src/twitch.js subscribes to
 * `channel.channel_points_automatic_reward_redemption.add`,
 * `channel.bits.use`, AND `channel.custom_power_up_redemption.add`
 * (the dedicated custom-Power-up event), then pushes those events through
 * `queue.pushRedeem(...)` with `source: 'power_up'` (and, for custom
 * power-ups, `rewardType: 'custom_power_up'`).
 */

const log          = require('../../logger');
const premiumRoll  = require('../premium-roll');

// Title(s) that should count as the "Gacha Pull" power-up. Twitch's payload
// naming isn't fully predictable here — a custom Power-up may report a
// friendly title ("Gacha Pull"), while built-in ones only report a type
// enum. Matching is done after aggressively normalising (lowercase,
// collapse all non-alphanumeric runs to a single space), so "Gacha_Pull",
// "gacha-pull", "GachaPull", etc. all resolve to the same string.
//
// 'custom power up' is included as a TEMPORARY catch-all: when a custom
// Power-up redemption arrives via the dedicated
// `channel.custom_power_up_redemption.add` EventSub (added in twitch.js),
// Twitch doesn't always populate `event.reward.title`, so twitch.js falls
// back to the literal string "Custom Power-Up" as the redeem title. That
// normalises to "custom power up" — so any custom Power-up that doesn't
// carry an explicit title gets treated as a gacha pull for now.
//
// TODO: once Twitch's payload reliably gives each custom Power-up a
// distinct title, drop 'custom power up' from this list and match on the
// real per-Power-up titles instead.
const GACHA_POWERUP_TITLES = [
  'gacha pull',           // friendly title (e.g. "Gacha Pull")
  'gachapull',            // no-separator variant
  'gacha pull powerup',   // explicit suffix
  'gacha',                // short form
  'custom power up',      // ← TEMPORARY: fallback title for any custom Power-up
];

// Twitch-side `rewardType` values that should also trigger a premium pull,
// independent of the (often missing) title. `custom_power_up` is set by
// twitch.js's `channel.custom_power_up_redemption.add` handler. This is a
// second matching path so we still trigger even if the title field is empty
// or unparseable.
const GACHA_POWERUP_REWARD_TYPES = ['custom_power_up'];

// Keep a chat-reply reference so we can still send a power-up-specific
// acknowledgement just before handing off to premium-roll. (premium-roll
// also sends its own announcement — that's fine; one is the immediate
// "Power-up detected" toast, the other is the "rolling now" message.)
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
    const rewardType = redeem.rewardType ?? null;
    const matchedByTitle = GACHA_POWERUP_TITLES.includes(title);
    const matchedByType  = rewardType && GACHA_POWERUP_REWARD_TYPES.includes(rewardType);

    if (!matchedByTitle && !matchedByType) {
      log.debug(
        `[gacha-powerup-pull] Ignoring power-up redeem with unmatched title: "${raw}" (normalised: "${title}", rewardType: "${rewardType}")`
      );
      return;
    }

    const user = redeem.user ?? redeem.username ?? 'someone';
    log.info(
      `[gacha-powerup-pull] Gacha Pull power-up used by ${user} → premium-roll (same as 100 bits). ` +
      `Matched via ${matchedByTitle ? `title "${title}"` : ''}${(matchedByTitle && matchedByType) ? ' + ' : ''}${matchedByType ? `rewardType "${rewardType}"` : ''}`
    );

    // NOTE: We intentionally do NOT send a chat announcement here.
    // The overlay animation IS the announcement — sending chat text on
    // every power-up redemption (and again from premium-roll, and again
    // from the bits handler) spammed chat with three near-identical
    // "✨ Triggering…" messages per pull. Just log it + hand off to
    // premium-roll silently.
    //
    // Hand off to the premium-roll plugin. Same code path as the /pull
    // Discord slash command, and identical in effect to a 100-bit cheer:
    // one premium pull after a short delay. delayMs=1500 keeps the
    // historical pacing.
    premiumRoll.triggerPremiumPull(user, { delayMs: 1500 });
  });

  log.info('[gacha-powerup-pull] Loaded — listening for the "Gacha Pull" Power-up → routes through premium-roll.');
}

module.exports = {
  id: 'gacha-powerup-pull',
  init,
  onChatReady,
};
