'use strict';

// ─── pull-fragment plugin ─────────────────────────────────────────────────────
//
// Triggers a premium gacha pull immediately when executed.
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
      result.catch(e => log.error('[pull-fragment] chat reply error:', e.message));
    }
  } catch (e) {
    log.error('[pull-fragment] chat reply error:', e.message);
  }
}

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[pull-fragment] Chat ready.');
}

// ─── Premium pull ─────────────────────────────────────────────────────────────

function _triggerPremiumPull(user) {
  log.info(`[pull-fragment] Triggering premium pull for ${user}.`);
  _send('twitch',  `@${user} ✨ Triggering a premium gacha pull…`);
  _send('youtube', `@${user} ✨ Triggering a premium gacha pull…`);
  setTimeout(() => gacha.triggerPull({ user, isPremium: true }), 2000);
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function init(context) {
  log.info('[pull-fragment] Loaded.');
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
  id: 'pull-fragment',
  init,
  onChatReady,
  command,
  handleInteraction,
};