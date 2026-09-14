'use strict';

/**
 * redeem-discount plugin
 * ───────────────────────
 * Applies a flat channel-point discount to every custom reward at once.
 *
 * Usage (Discord, mods only):
 *   /discount set amount:200   → knock 200 points off every reward's cost
 *   /discount status           → show current discount + affected rewards
 *   /discount clear            → restore every reward to its original cost
 *
 * How it works:
 *   - The first time a discount is applied, each reward's *current* cost is
 *     saved to disk as its "original" cost before being lowered. Re-running
 *     `set` with a new amount always discounts from the saved original, not
 *     from whatever the (already-discounted) live cost currently is — so
 *     stacking `/discount set` calls never compounds.
 *   - A reward's cost never drops below MIN_COST (500 points) — rewards
 *     already at or under 500 are left alone.
 *   - "Gacha Pull" is exempt from the discount entirely. It's pinned to a
 *     fixed cost (5000 points) every time /discount set or /discount clear
 *     runs, regardless of what happens to any other reward.
 *   - `/discount clear` restores every tracked reward to its saved original
 *     cost and forgets the saved originals, so the next `set` re-captures
 *     fresh baselines.
 *
 * Caveats:
 *   - Twitch only allows a reward's cost to be patched by the same Client ID
 *     that created it. If some of your rewards were created by hand in the
 *     Twitch dashboard (rather than via this bot / create-reward plugin),
 *     updateReward() will fail for those specific rewards — they'll show up
 *     in the "failed" list on /discount set and /discount clear.
 *   - This is a one-shot snapshot action, not a live rule — rewards you
 *     create *after* running /discount set won't automatically get the
 *     discount. Re-run /discount set to sweep in any new rewards.
 */

const fs   = require('fs');
const path = require('path');
const log  = require('../../logger');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const DATA_PATH = path.join(__dirname, 'discount-state.json');
const MIN_COST  = 500;

// "Gacha Pull" is exempt from the discount entirely and is pinned to a
// fixed cost at all times, regardless of what /discount set or /discount
// clear are doing to everything else.
const EXEMPT_TITLE = 'gacha pull';
const EXEMPT_FIXED_COST = 5000;

function _isExempt(title) {
  return String(title).trim().toLowerCase() === EXEMPT_TITLE;
}

let _twitch = null;

// ── Persistence ──────────────────────────────────────────────────────────

// Shape: { discountAmount: number, originals: { [rewardId]: number } }
let _state = { discountAmount: 0, originals: {} };

function _load() {
  try {
    _state = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!_state.originals) _state.originals = {};
    if (typeof _state.discountAmount !== 'number') _state.discountAmount = 0;
  } catch {
    _state = { discountAmount: 0, originals: {} };
  }
}

function _save() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(_state, null, 2), 'utf8');
  } catch (e) {
    log.error('[redeem-discount] Failed to save state:', e.message);
  }
}

// ── Core logic ───────────────────────────────────────────────────────────

/**
 * Apply a flat-point discount to every custom reward.
 * @param {number} amount — points to knock off each reward
 * @returns {Promise<{ applied: Array, unchanged: Array, failed: Array }>}
 */
async function applyDiscount(amount) {
  const rewards  = await _twitch.listRewards({ force: true });
  const applied  = [];
  const unchanged = [];
  const failed   = [];

  for (const reward of rewards) {
    // "Gacha Pull" is exempt — pin it to its fixed cost and never touch it
    // as part of the discount logic (no baseline capture, no discounting).
    if (_isExempt(reward.title)) {
      if (reward.cost === EXEMPT_FIXED_COST) {
        unchanged.push({ title: reward.title, cost: reward.cost });
      } else {
        try {
          await _twitch.updateReward(reward.id, { cost: EXEMPT_FIXED_COST });
          applied.push({ title: reward.title, from: reward.cost, to: EXEMPT_FIXED_COST });
        } catch (e) {
          failed.push({ title: reward.title, reason: e.message });
        }
      }
      continue;
    }

    // Capture the original cost the first time we ever touch this reward,
    // so repeated /discount set calls always discount from the true
    // baseline rather than compounding on the last discount.
    if (!(reward.id in _state.originals)) {
      _state.originals[reward.id] = reward.cost;
    }
    const original = _state.originals[reward.id];
    const newCost  = Math.max(MIN_COST, original - amount);

    if (newCost === reward.cost) {
      unchanged.push({ title: reward.title, cost: reward.cost });
      continue;
    }
    try {
      await _twitch.updateReward(reward.id, { cost: newCost });
      applied.push({ title: reward.title, from: reward.cost, to: newCost });
    } catch (e) {
      failed.push({ title: reward.title, reason: e.message });
    }
  }

  _state.discountAmount = amount;
  _save();
  return { applied, unchanged, failed };
}

/**
 * Restore every tracked reward to its saved original cost and forget
 * the saved baselines.
 * @returns {Promise<{ restored: Array, failed: Array }>}
 */
async function clearDiscount() {
  const rewards = await _twitch.listRewards({ force: true });
  const restored = [];
  const failed   = [];

  for (const reward of rewards) {
    // Keep "Gacha Pull" pinned even through a clear — it was never part of
    // the discounted set, so there's no original to restore it to.
    if (_isExempt(reward.title)) {
      if (reward.cost !== EXEMPT_FIXED_COST) {
        try {
          await _twitch.updateReward(reward.id, { cost: EXEMPT_FIXED_COST });
          restored.push({ title: reward.title, to: EXEMPT_FIXED_COST });
        } catch (e) {
          failed.push({ title: reward.title, reason: e.message });
        }
      }
      continue;
    }

    const original = _state.originals[reward.id];
    if (original === undefined || original === reward.cost) continue;
    try {
      await _twitch.updateReward(reward.id, { cost: original });
      restored.push({ title: reward.title, to: original });
    } catch (e) {
      failed.push({ title: reward.title, reason: e.message });
    }
  }

  _state.discountAmount = 0;
  _state.originals = {};
  _save();
  return { restored, failed };
}

// ── Plugin lifecycle ─────────────────────────────────────────────────────

function init(context) {
  _twitch = context.twitch;
  _load();
  log.info(`[redeem-discount] Loaded. Current discount: ${_state.discountAmount} pts`);
}

// ── Discord slash command ────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('discount')
  .setDescription('Discount the channel-point cost of every reward')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)

  .addSubcommand(sub =>
    sub.setName('set')
      .setDescription('Discount every reward by a flat amount of points')
      .addIntegerOption(o =>
        o.setName('amount')
          .setDescription('Points to knock off every reward')
          .setRequired(true)
          .setMinValue(0)))

  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show the current discount and affected rewards'))

  .addSubcommand(sub =>
    sub.setName('clear')
      .setDescription('Remove the discount and restore original costs'));

async function handleInteraction(interaction) {
  if (interaction.commandName !== 'discount') return;
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const amount = interaction.options.getInteger('amount');
    try {
      const { applied, unchanged, failed } = await applyDiscount(amount);
      const lines = [`💸 Discount set to **${amount}** points off every reward.`];
      if (applied.length) {
        lines.push(
          '',
          '**Updated:**',
          ...applied.map(r => `• ${r.title}: ${r.from} → ${r.to}`)
        );
      }
      if (unchanged.length) lines.push('', `_${unchanged.length} reward(s) already at that price or floor._`);
      if (failed.length) {
        lines.push(
          '',
          '⚠️ **Failed (likely not created by this app):**',
          ...failed.map(r => `• ${r.title}: ${r.reason}`)
        );
      }
      return interaction.editReply(lines.join('\n').slice(0, 1900));
    } catch (e) {
      log.error('[redeem-discount] set failed:', e.message);
      return interaction.editReply(`❌ Failed to apply discount: ${e.message}`);
    }
  }

  if (sub === 'status') {
    const count = Object.keys(_state.originals).length;
    if (!_state.discountAmount) {
      return interaction.editReply('No discount currently applied.');
    }
    return interaction.editReply(
      `💸 Current discount: **${_state.discountAmount}** points off, tracking ${count} reward(s).\n` +
      'Run `/discount clear` to restore original prices.'
    );
  }

  if (sub === 'clear') {
    try {
      const { restored, failed } = await clearDiscount();
      const lines = ['✅ Discount cleared.'];
      if (restored.length) {
        lines.push(
          '',
          '**Restored:**',
          ...restored.map(r => `• ${r.title} → ${r.to}`)
        );
      }
      if (failed.length) {
        lines.push(
          '',
          '⚠️ **Failed to restore:**',
          ...failed.map(r => `• ${r.title}: ${r.reason}`)
        );
      }
      return interaction.editReply(lines.join('\n').slice(0, 1900));
    } catch (e) {
      log.error('[redeem-discount] clear failed:', e.message);
      return interaction.editReply(`❌ Failed to clear discount: ${e.message}`);
    }
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

module.exports = {
  id: 'redeem-discount',
  init,
  command,
  handleInteraction,
  // exported for tests / other plugins that might want to trigger this programmatically
  applyDiscount,
  clearDiscount,
};
