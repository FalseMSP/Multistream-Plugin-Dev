'use strict';

/**
 * Plugin: rank
 * ────────────────────
 * Responds to !rank in chat with the current rank.
 *
 * Chat commands (Twitch + YouTube):
 *   !rank — bot replies with the current rank
 *
 * Discord slash commands:
 *   /rank set <value> — update the rank text (mods only)
 *   /rank show        — display the current rank text
 */

const fs  = require('fs');
const path = require('path');
const log  = require('../../logger');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// ── Persistence ──────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { rank: 'Unranked' };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log.error('[rank] Failed to save state:', e.message);
  }
}

let _state = loadState();

// ── Chat ─────────────────────────────────────────────────────────────────────

const CMD_RANK = /^!rank\s*$/i;
let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[rank] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!msg.message || !CMD_RANK.test(msg.message.trim())) return { message: msg };

  const send = _chatReply[msg.platform];
  if (send) {
    send(`Rank: ${_state.rank}`)
      .catch(e => log.error('[rank] chat reply error:', e.message));
  }

  return { message: null }; // suppress from #stream-chat
}

// ── Discord slash command ─────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Manage the !rank chat command response')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub
      .setName('set')
      .setDescription('Update the rank text shown in chat')
      .addStringOption(o =>
        o.setName('value')
          .setDescription('The new rank text (e.g. "Diamond 2")')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub
      .setName('show')
      .setDescription('Show the current rank text'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const value = interaction.options.getString('value').trim();
    _state.rank = value;
    saveState(_state);
    log.info(`[rank] Rank updated to "${value}" by ${interaction.user.tag}`);
    return interaction.editReply(`✅ Rank updated to **${value}**. Chat will now see: "Rank: ${value}"`);
  }

  if (sub === 'show') {
    return interaction.editReply(`Current rank: **${_state.rank}**`);
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  id: 'rank',
  command,
  handleInteraction,
  onChatReady,
  processMessage,
};