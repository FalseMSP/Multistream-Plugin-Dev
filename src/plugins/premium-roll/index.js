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
// Discord slash command (mods only):
//   /pull <user>  — fire a premium pull for the given viewer

const log    = require('../../logger');
const gacha  = require('../gacha');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

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

function _triggerPremiumPull(user) {
  log.info(`[premium-roll] Triggering premium pull for ${user}.`);
  _send('twitch',  `@${user} ✨ Triggering a premium gacha pull…`);
  _send('youtube', `@${user} ✨ Triggering a premium gacha pull…`);
  setTimeout(() => gacha.triggerPull({ user, isPremium: true }), 2000);
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function init() {
  log.info('[premium-roll] Loaded.');
}

// ─── Discord slash command ────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('pull')
  .setDescription('Trigger a premium gacha pull for a viewer')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addStringOption(o =>
    o.setName('user').setDescription('Twitch/YouTube username').setRequired(true));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getString('user');
  _triggerPremiumPull(user);

  return interaction.editReply(`✨ Premium pull triggered for **${user}**.`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  id: 'premium-roll',
  init,
  onChatReady,
  command,
  handleInteraction,
};
