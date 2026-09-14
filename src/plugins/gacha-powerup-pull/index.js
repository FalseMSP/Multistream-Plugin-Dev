'use strict';

/**
 * gacha-powerup-pull plugin
 * ─────────────────────────
 * Hooks into Twitch custom Power-ups. When a viewer triggers a "Gacha Pull"
 * Power-up (a bits-funded custom Power-up redemption — see src/twitch.js's
 * `channel.custom_power_up_redemption.add` subscription), this fires a
 * PREMIUM gacha pull by activating the `premium-roll` plugin — exactly the
 * same code path used by the manual `/pull` Discord slash command.
 *
 * COUNT SUPPORT: titles can carry a count suffix to trigger multiple pulls
 * at once (revealed as a grid). Examples:
 *   "Gacha Pull"         → 1 premium pull
 *   "Gacha Pull (x16)"   → 16 premium pulls (one 4×4 grid reveal)
 *   "Gacha Pull x8"      → 8 premium pulls
 *   "gachapull x25"      → 25 premium pulls (one 5×5 grid reveal)
 * After normalisation, "Gacha Pull (x16)" becomes "gacha pull x16", which
 * the regex below matches with count=16. Counts >25 auto-split into
 * batches of 25 (handled by gacha.triggerGridPull).
 *
 * Routing through `premium-roll.triggerPremiumPull(user, { count })` means:
 *   • The power-up "activates the gacha pull premium plugin" (premium-roll),
 *     not the bare gacha engine.
 *   • If `/pull` ever grows new behaviour (logging, sound effect, etc.),
 *     the power-up automatically gets the same behaviour for free.
 *
 * This is deliberately separate from the plain channel-points "Gacha Pull"
 * reward already handled by the `gacha` plugin (which gives a STANDARD pull
 * for channel points). Power-ups cost real bits, so redeeming one should
 * feel like the premium tier.
 *
 * Requires: src/twitch.js subscribes to
 * `channel.custom_power_up_redemption.add` and pushes those events through
 * `queue.pushRedeem(...)` with `source: 'power_up'` and
 * `rewardType: 'custom_power_up'`. (channel.bits.use is NO LONGER
 * subscribed — see twitch.js for the double-counting audit.)
 */

const log          = require('../../logger');
const premiumRoll  = require('../premium-roll');

// ─── Title matching ──────────────────────────────────────────────────────────
//
// Matching is done after aggressively normalising (lowercase, collapse all
// non-alphanumeric runs to a single space), so "Gacha_Pull", "gacha-pull",
// "GachaPull", "Gacha Pull (x16)", etc. all resolve cleanly:
//   "Gacha Pull"         → "gacha pull"
//   "Gacha Pull (x16)"   → "gacha pull x16"   (parens → spaces, collapsed)
//   "gachapull"          → "gachapull"
//   "Gacha Pull x8"      → "gacha pull x8"
//
// The regex below matches the "Gacha Pull" family with an OPTIONAL count
// suffix:
//   • \s* between "gacha" and "pull" allows "gachapull" (no separator).
//   • (?:\s+x(\d+))? captures the count when present (e.g. "x16" → 16).
//
// Examples:
//   "gacha pull"         → match, count=1
//   "gacha pull x16"     → match, count=16
//   "gachapull"          → match, count=1
//   "gachapull x25"      → match, count=25
//   "gacha pull powerup" → NO match (falls through to static list below)
//   "custom power up"    → NO match (the fallback title is NOT accepted —
//                          we require the real power-up title now that
//                          twitch.js reads event.custom_power_up.title)
const GACHA_PULL_RE = /^gacha\s*pull(?:\s+x(\d+))?$/;

// Static fallback aliases for titles that don't fit the regex above.
// count=1 for all of these (no count suffix supported on the short forms).
const GACHA_POWERUP_TITLES = [
  'gacha',                // short form
  'gacha pull powerup',   // explicit suffix
];

// Hard cap on the count extracted from titles like "Gacha Pull (x200)".
// Matches premium-roll's MAX_PULL_COUNT. Larger values get clamped.
const MAX_PULL_COUNT = 100;

/**
 * Test a redeem title against the gacha-pull patterns.
 * @param {string} rawTitle
 * @returns {{ matched: boolean, count: number, matchedAs: string|null }}
 *   matchedAs is a short human-readable hint for logging, e.g.
 *   'regex count=16', 'regex single', 'static'.
 */
function _matchPullTitle(rawTitle) {
  const t = _normaliseTitle(rawTitle);

  // Try the regex first: "gacha pull", "gachapull", "gacha pull x16", etc.
  const m = t.match(GACHA_PULL_RE);
  if (m) {
    const raw = m[1] ? parseInt(m[1], 10) : 1;
    const count = Math.max(1, Math.min(MAX_PULL_COUNT, raw));
    return { matched: true, count, matchedAs: m[1] ? `regex count=${count}` : 'regex single' };
  }

  // Fall back to the static title list.
  if (GACHA_POWERUP_TITLES.includes(t)) {
    return { matched: true, count: 1, matchedAs: 'static' };
  }

  return { matched: false, count: 0, matchedAs: null };
}

// ─── Chat reply (kept for future use, currently unused) ──────────────────────

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

// ─── Init ────────────────────────────────────────────────────────────────────

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

    const { matched, count, matchedAs } = _matchPullTitle(raw);

    if (!matched) {
      log.debug(
        `[gacha-powerup-pull] Ignoring power-up redeem with unmatched title: "${raw}" (rewardType: "${redeem.rewardType ?? null}")`
      );
      return;
    }

    const user = redeem.user ?? redeem.username ?? 'someone';
    log.info(
      `[gacha-powerup-pull] Gacha Pull power-up used by ${user} → premium-roll ` +
      `(count=${count}, matched via ${matchedAs}).`
    );

    // NOTE: We intentionally do NOT send a chat announcement here.
    // The overlay animation IS the announcement — sending chat text on
    // every power-up redemption spammed chat. Just log + hand off to
    // premium-roll silently.
    //
    // Hand off to the premium-roll plugin. Same code path as the /pull
    // Discord slash command. count=1 → single pull; count>1 → grid
    // reveal (auto-split into batches of 25 by gacha.triggerGridPull).
    // delayMs=1500 keeps the historical pacing.
    premiumRoll.triggerPremiumPull(user, { count, delayMs: 1500 });
  });

  log.info('[gacha-powerup-pull] Loaded — listening for "Gacha Pull" Power-ups (incl. counted variants like "Gacha Pull (x16)") → routes through premium-roll.');
}

module.exports = {
  id: 'gacha-powerup-pull',
  init,
  onChatReady,
  // Exported for testing / external use:
  _matchPullTitle,
};
