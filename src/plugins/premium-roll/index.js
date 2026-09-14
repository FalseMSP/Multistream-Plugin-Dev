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

// Hard cap so a misclicked /pull count 9999 doesn't lock the overlay for
// 20 minutes. 25 cells is already a 5×5 grid — plenty.
const MAX_PULL_COUNT = 25;

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
// opts.delayMs — ms to wait before triggering the gacha animation, so the
//                chat announcement lands first. Default 2000 (matches the
//                historical behaviour). gacha-powerup-pull passes 1500.
//
function triggerPremiumPull(user, opts = {}) {
  const count = Math.max(1, Math.min(MAX_PULL_COUNT, Math.trunc(opts.count ?? 1) || 1));
  const delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 2000;

  const isGrid = count > 1;

  log.info(
    `[premium-roll] Triggering ${isGrid ? `grid of ${count} premium pulls` : 'a premium pull'} for ${user}.`
  );

  const announcement = isGrid
    ? `@${user} ✨ Triggering ${count} PREMIUM gacha pulls — grid reveal incoming!`
    : `@${user} ✨ Triggering a premium gacha pull…`;
  _send('twitch',  announcement);
  _send('youtube', announcement);

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
