'use strict';
/**
 * Plugin: commands
 * ────────────────────
 * Lets mods add/remove/list custom chat commands via Discord slash commands.
 * Any registered command is then usable in Twitch and YouTube chat.
 *
 * Discord slash commands (mods only):
 *   /command add <trigger> <response>  — add or overwrite a command
 *   /command remove <trigger>          — delete a command
 *   /command list                      — show all registered commands
 *
 * Chat usage (Twitch + YouTube):
 *   !<trigger>  — bot replies with the saved response text
 *
 * Example:
 *   /command add ip  theiptojoin.net
 *   → user types !ip → bot says "theiptojoin.net"
 */

const fs   = require('fs');
const path = require('path');
const log  = require('../../logger');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// ── Persistence ───────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // Default: ship with the classic !rank command so nothing breaks
    return { commands: { rank: 'Unranked' } };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log.error('[commands] Failed to save state:', e.message);
  }
}

let _state = loadState();

// ── Chat ──────────────────────────────────────────────────────────────────────

// Matches !<word>  (optionally followed by whitespace, nothing else)
const CMD_RE = /^!([A-Za-z0-9_]+)\s*$/;

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[commands] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!msg.message) return { message: msg };

  const match = msg.message.trim().match(CMD_RE);
  if (!match) return { message: msg };

  const trigger = match[1].toLowerCase();
  const response = _state.commands[trigger];
  if (!response) return { message: msg }; // unknown command — pass through

  const send = _chatReply[msg.platform];
  if (send) {
    send(response)
      .catch(e => log.error(`[commands] chat reply error for !${trigger}:`, e.message));
  }

  return { message: null }; // suppress from #stream-chat
}

// ── Discord slash command ─────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('command')
  .setDescription('Manage custom chat commands (!trigger → response)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)

  .addSubcommand(sub =>
    sub
      .setName('add')
      .setDescription('Add or overwrite a chat command')
      .addStringOption(o =>
        o.setName('trigger')
          .setDescription('The trigger word — users type !trigger (no ! needed here)')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('response')
          .setDescription('What the bot will say when the command is used')
          .setRequired(true)))

  .addSubcommand(sub =>
    sub
      .setName('remove')
      .setDescription('Remove a chat command')
      .addStringOption(o =>
        o.setName('trigger')
          .setDescription('The trigger word to remove (no ! needed)')
          .setRequired(true)))

  .addSubcommand(sub =>
    sub
      .setName('list')
      .setDescription('List all registered chat commands'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── /command add ──────────────────────────────────────────────────────────
  if (sub === 'add') {
    const trigger   = interaction.options.getString('trigger').trim().toLowerCase().replace(/^!/, '');
    const response  = interaction.options.getString('response').trim();

    if (!/^[A-Za-z0-9_]+$/.test(trigger)) {
      return interaction.editReply('⚠️ Trigger can only contain letters, numbers, and underscores.');
    }

    const isUpdate = Boolean(_state.commands[trigger]);
    _state.commands[trigger] = response;
    saveState(_state);

    log.info(`[commands] !${trigger} ${isUpdate ? 'updated' : 'added'} by ${interaction.user.tag}: "${response}"`);
    return interaction.editReply(
      `${isUpdate ? '✏️ Updated' : '✅ Added'} **!${trigger}** → ${response}`
    );
  }

  // ── /command remove ───────────────────────────────────────────────────────
  if (sub === 'remove') {
    const trigger = interaction.options.getString('trigger').trim().toLowerCase().replace(/^!/, '');

    if (!_state.commands[trigger]) {
      return interaction.editReply(`⚠️ No command **!${trigger}** found.`);
    }

    delete _state.commands[trigger];
    saveState(_state);

    log.info(`[commands] !${trigger} removed by ${interaction.user.tag}`);
    return interaction.editReply(`🗑️ Removed **!${trigger}**.`);
  }

  // ── /command list ─────────────────────────────────────────────────────────
  if (sub === 'list') {
    const entries = Object.entries(_state.commands);

    if (entries.length === 0) {
      return interaction.editReply('No commands registered yet. Use `/command add` to create one.');
    }

    const lines = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([trigger, response]) => `**!${trigger}** → ${response}`);

    return interaction.editReply(`**Registered commands (${entries.length}):**\n${lines.join('\n')}`);
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  id: 'commands',
  command,
  handleInteraction,
  onChatReady,
  processMessage,
};