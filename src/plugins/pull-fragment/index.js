'use strict';

// ─── pull-fragment plugin ─────────────────────────────────────────────────────
//
// Tracks "Pull Fragment" gacha results per viewer.
// When a viewer accumulates FRAGMENTS_NEEDED fragments, they are consumed and a
// premium gacha pull is automatically triggered for them.
//
// Fragments are persisted to disk (fragments.json next to this file) so they
// survive bot restarts.
//
// Chat commands:
//   !fragments  — shows your own fragment count (registered in commands-list)
//
// Discord slash commands (mods only):
//   /fragments check <user>  — look up a viewer's count
//   /fragments reset <user>  — reset a viewer to 0
//   /fragments give  <user>  — manually award 1 fragment (triggers pull if threshold met)

const log          = require('../../logger');
const commandsList = require('../commands-list');
const gacha        = require('../gacha');
const fs           = require('fs');
const path         = require('path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// ─── Config ───────────────────────────────────────────────────────────────────

const FRAGMENTS_NEEDED = 3;

// Matches the `redeem` field in LOOT_TABLE + the _fromGacha flag
const FRAGMENT_REDEEM_TITLE = 'pull fragment';

const DATA_FILE = path.resolve(__dirname, 'fragments.json');

// ─── Persistence ─────────────────────────────────────────────────────────────

/** @type {Record<string, number>} username (lowercase) → fragment count */
let _fragments = {};

function _load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      _fragments = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      log.info(`[pull-fragment] Loaded fragment counts for ${Object.keys(_fragments).length} viewer(s).`);
    }
  } catch (e) {
    log.error('[pull-fragment] Failed to load fragments.json — starting fresh:', e.message);
    _fragments = {};
  }
}

function _save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(_fragments, null, 2), 'utf8');
  } catch (e) {
    log.error('[pull-fragment] Failed to save fragments.json:', e.message);
  }
}

// ─── Fragment logic ───────────────────────────────────────────────────────────

/**
 * Award one fragment to `user`. If the total reaches FRAGMENTS_NEEDED, consume
 * them all and return triggered: true (caller should fire a premium pull).
 * @param {string} user
 * @returns {{ newCount: number, triggered: boolean }}
 */
function _awardFragment(user) {
  const key = user.toLowerCase();
  _fragments[key] = (_fragments[key] ?? 0) + 1;
  const newCount = _fragments[key];

  if (newCount >= FRAGMENTS_NEEDED) {
    _fragments[key] = 0;
    _save();
    return { newCount: 0, triggered: true };
  }

  _save();
  return { newCount, triggered: false };
}

function _getCount(user) {
  return _fragments[user.toLowerCase()] ?? 0;
}

function _resetCount(user) {
  _fragments[user.toLowerCase()] = 0;
  _save();
}

// ─── Chat reply ───────────────────────────────────────────────────────────────

let _chatReply = { twitch: null, youtube: null };

function _send(platform, text) {
  const fn = _chatReply[platform];
  if (!fn) return;
  try {
    const result = fn(text);
    if (result && typeof result.catch === 'function') {
      result.catch(e => log.error('[pull-fragment] chat reply error:', e.message));
    }
  } catch (e) {
    log.error('[pull-fragment] chat reply error:', e.message);
  }
}

function onChatReady(chatReply) {
  _chatReply = chatReply;
  commandsList.registerCommand('!fragments', `Check how many Pull Fragments you have (${FRAGMENTS_NEEDED} = 1 free premium pull)`);
  log.info('[pull-fragment] Chat ready.');
}

// ─── Internal: fire a premium pull with chat announcement ────────────────────

function _triggerPremiumPull(user) {
  log.info(`[pull-fragment] ${user} collected ${FRAGMENTS_NEEDED} fragments — triggering premium pull!`);
  _send('twitch',  `@${user} ✨ You collected all ${FRAGMENTS_NEEDED} Pull Fragments! Triggering a premium gacha pull…`);
  _send('youtube', `@${user} ✨ You collected all ${FRAGMENTS_NEEDED} Pull Fragments! Triggering a premium gacha pull…`);
  // Small delay so the fragment reveal animation finishes before the next pull starts
  setTimeout(() => gacha.triggerPull({ user, isPremium: true }), 2000);
}

// ─── Redeem handler (wired in init) ──────────────────────────────────────────

function _onRedeem(redeem) {
  if (!redeem._fromGacha) return;

  const rawTitle = (redeem.title ?? redeem.reward?.title ?? '').trim().toLowerCase();
  if (rawTitle !== FRAGMENT_REDEEM_TITLE) return;

  const user = redeem.user ?? redeem.username ?? 'someone';
  const { newCount, triggered } = _awardFragment(user);

  if (triggered) {
    _triggerPremiumPull(user);
  } else {
    const remaining = FRAGMENTS_NEEDED - newCount;
    log.info(`[pull-fragment] ${user} now has ${newCount}/${FRAGMENTS_NEEDED} fragment(s).`);
    _send('twitch',  `@${user} 🧩 Fragment collected! You now have ${newCount}/${FRAGMENTS_NEEDED}. ${remaining} more for a premium pull!`);
    _send('youtube', `@${user} 🧩 Fragment collected! You now have ${newCount}/${FRAGMENTS_NEEDED}. ${remaining} more for a premium pull!`);
  }
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function init(context) {
  _load();

  const q = context.queue ?? context;

  if (typeof q.onRedeem === 'function') {
    q.onRedeem(_onRedeem);
  } else {
    log.warn('[pull-fragment] context.queue.onRedeem not available — fragment detection disabled');
  }

  log.info(`[pull-fragment] Loaded. ${FRAGMENTS_NEEDED} fragments → 1 premium pull.`);
}

// ─── processMessage: !fragments self-check only ───────────────────────────────

async function processMessage(msg) {
  if (!/^!fragments$/i.test(msg.message.trim())) return { message: msg };

  const count     = _getCount(msg.username);
  const remaining = FRAGMENTS_NEEDED - count;
  _send(
    msg.platform,
    `@${msg.username} 🧩 You have ${count}/${FRAGMENTS_NEEDED} Pull Fragment(s). ` +
    (remaining > 0 ? `${remaining} more for a FREE premium pull!` : `Something's wrong — ping a mod!`),
  );
  return { message: null };
}

// ─── Discord slash commands ───────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('fragments')
  .setDescription('Manage Pull Fragment counts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('check')
      .setDescription("Look up a viewer's fragment count")
      .addStringOption(o =>
        o.setName('user').setDescription('Twitch/YouTube username').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('reset')
      .setDescription('Reset a viewer\'s fragments to 0')
      .addStringOption(o =>
        o.setName('user').setDescription('Twitch/YouTube username').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('give')
      .setDescription('Manually award 1 fragment (triggers a premium pull if threshold is met)')
      .addStringOption(o =>
        o.setName('user').setDescription('Twitch/YouTube username').setRequired(true)));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub  = interaction.options.getSubcommand();
  const user = interaction.options.getString('user');

  if (sub === 'check') {
    const count = _getCount(user);
    return interaction.editReply(`🧩 **${user}** has **${count}/${FRAGMENTS_NEEDED}** Pull Fragment(s).`);
  }

  if (sub === 'reset') {
    _resetCount(user);
    log.info(`[pull-fragment] ${interaction.user.username} (Discord) reset fragments for ${user}`);
    return interaction.editReply(`🔄 Reset fragment count for **${user}** to 0.`);
  }

  if (sub === 'give') {
    const { newCount, triggered } = _awardFragment(user);
    log.info(`[pull-fragment] ${interaction.user.username} (Discord) manually gave a fragment to ${user}`);
    if (triggered) {
      _triggerPremiumPull(user);
      return interaction.editReply(`✨ Gave a fragment to **${user}** — that's ${FRAGMENTS_NEEDED}/${FRAGMENTS_NEEDED}! Premium pull triggered.`);
    }
    const remaining = FRAGMENTS_NEEDED - newCount;
    return interaction.editReply(`🧩 Gave a fragment to **${user}**. They now have **${newCount}/${FRAGMENTS_NEEDED}** (${remaining} more needed).`);
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  id: 'pull-fragment',
  init,
  onChatReady,
  processMessage,
  command,
  handleInteraction,
};