'use strict';

// ─── premium-roll plugin ──────────────────────────────────────────────────────
//
// Triggers a premium gacha pull immediately when executed.
//
// This is a sibling plugin to `pull-fragment` (which tracks fragments over
// time and auto-triggers a pull once a threshold is reached). `premium-roll`
// is the manual override — a mod can fire a premium pull on demand without
// having to award three fragments first.
//
// Exposes `triggerPremiumPull(user, opts)` so other plugins can route through
// the same code path. Currently used by `gacha-powerup-pull` so a Twitch
// "Gacha Pull" Power-up activates the premium-roll plugin (same effect as a
// 100-bit cheer: one premium pull, plus the chat announcement).
//
// Discord slash command (mods only):
//   /pull <user> [count]  — fire premium pull(s) for the given viewer
//     count = 1 (default)  → single premium pull
//     count ≥ 2            → grid reveal (all pulls shown simultaneously)

const log    = require('../../logger');
const gacha  = require('../gacha');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// Hard cap on the /pull slash command's `count` option. This is just to
// prevent a misclicked `/pull count:99999` from locking the overlay for
// hours — gacha.triggerGridPull now AUTO-SPLITS into batches of
// gacha.MAX_GRID_SIZE (25) and queues them back-to-back, so values >25
// are fine and produce multiple sequential grid reveals. 100 = 4 batches
// of 25 = ~1 minute of grid reveals, which is plenty for any manual use.
const MAX_PULL_COUNT = 100;

// ─── Chat reply ───────────────────────────────────────────────────────────────

let _chatReply = { twitch: null, youtube: null };

function _send(platform, text) {
  const fn = _chatReply[platform];
  if (!fn) return;
  try {
    const result = fn(text);
    if (result && typeof result.catch === 'function') {
      result.catch(e => log.error('[premium-roll] chat reply error:', e.message));
    }
  } catch (e) {
    log.error('[premium-roll] chat reply error:', e.message);
  }
}

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[premium-roll] Chat ready.');
}

// ─── Premium pull ─────────────────────────────────────────────────────────────
//
// Single source of truth for "fire a premium pull(s) for this user".
// Used by:
//   • this plugin's /pull slash command
//   • gacha-powerup-pull (Twitch "Gacha Pull" Power-up → 100-bit equivalent)
//
// opts.count   — number of pulls (default 1). ≥ 2 → grid reveal.
// opts.delayMs — ms to wait before triggering the gacha animation, so any
//                upstream toast lands first. Default 2000.
//                gacha-powerup-pull passes 1500.
//
// NOTE: We intentionally do NOT send a chat announcement from here.
// Previously this fired one of:
//   "@<user> ✨ Triggering a premium gacha pull…"
//   "@<user> ✨ Triggering N PREMIUM gacha pulls — grid reveal incoming!"
// and gacha-powerup-pull fired a separate
//   "@<user> ✨ Power-up activated! Routing to premium-roll…"
// which combined with the bits/sub handlers meant chat got spammed with
// 3 near-identical "✨ Triggering…" messages per pull. The overlay
// animation IS the announcement now — log lines still record what
// happened for debugging.
//
function triggerPremiumPull(user, opts = {}) {
  const count = Math.max(1, Math.min(MAX_PULL_COUNT, Math.trunc(opts.count ?? 1) || 1));
  const delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 2000;

  const isGrid = count > 1;

  log.info(
    `[premium-roll] Triggering ${isGrid ? `grid of ${count} premium pulls` : 'a premium pull'} for ${user}.`
  );

  setTimeout(() => {
    if (isGrid) {
      gacha.triggerGridPull({ user, count, isPremium: true });
    } else {
      gacha.triggerPull({ user, isPremium: true });
    }
  }, delayMs);

  return { count, isGrid };
}

// Backwards-compat: keep the old private name alive for any plugin that
// grabbed it before the rename. (None in this repo, but cheap insurance.)
const _triggerPremiumPull = (user) => triggerPremiumPull(user);

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function init() {
  log.info('[premium-roll] Loaded.');
}

// ─── Discord slash command ────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('pull')
  .setDescription('Trigger premium gacha pull(s) for a viewer')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addStringOption(o =>
    o.setName('user').setDescription('Twitch/YouTube username').setRequired(true))
  .addIntegerOption(o =>
    o.setName('count')
      .setDescription('How many pulls to trigger (≥2 = grid reveal). Default 1.')
      .setMinValue(1)
      .setMaxValue(MAX_PULL_COUNT)
      .setRequired(false));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const user  = interaction.options.getString('user');
  const count = interaction.options.getInteger('count') ?? 1;

  const { isGrid } = triggerPremiumPull(user, { count });

  // Compute batch info for the ephemeral reply so the mod knows what to
  // expect on the overlay. count > gacha.MAX_GRID_SIZE triggers multiple
  // sequential grid reveals.
  const maxGrid = gacha.MAX_GRID_SIZE ?? 25;
  if (isGrid && count > maxGrid) {
    const batches = Math.ceil(count / maxGrid);
    return interaction.editReply(
      `✨ Triggered **${count}** premium gacha pulls for **${user}** — ` +
      `split into ${batches} grid batches of up to ${maxGrid} each, queued back-to-back.`
    );
  }
  return interaction.editReply(
    isGrid
      ? `✨ Triggered **${count}** premium gacha pulls for **${user}** — grid reveal.`
      : `✨ Premium pull triggered for **${user}**.`
  );
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  id: 'premium-roll',
  init,
  onChatReady,
  command,
  handleInteraction,
  triggerPremiumPull,        // public — used by gacha-powerup-pull
  MAX_PULL_COUNT,
};
