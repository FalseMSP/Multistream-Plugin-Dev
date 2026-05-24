'use strict';
/**
 * Plugin: add-commands
 * ────────────────────
 * Handles !<trigger> chat responses and the /command Discord slash command.
 * Delegates all storage and registry management to commands-list.
 *
 * Discord slash commands (mods only):
 *   /command add <trigger> <response>  — add or overwrite a command
 *   /command remove <trigger>          — delete a command
 *   /command list                      — show all registered commands
 *
 * Chat usage (Twitch + YouTube):
 *   !<trigger>  — bot replies with the saved response text
 */

const log      = require('../../logger');
const registry = require('../commands-list');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// ── Chat ──────────────────────────────────────────────────────────────────────

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
  const cmds    = registry.getCommands();
  const entry   = cmds.find(c => c.trigger === trigger);
  if (!entry) return { message: msg };

  const send = _chatReply[msg.platform];
  if (send) {
    send(entry.response)
      .catch(e => log.error(`[commands] chat reply error for !${trigger}:`, e.message));
  }

  return { message: null };
}

// ── Discord slash command ─────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('command')
  .setDescription('Manage custom chat commands (!trigger → response)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)

  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add or overwrite a chat command')
      .addStringOption(o =>
        o.setName('trigger')
          .setDescription('Trigger word — users type !trigger (no ! needed here)')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('response')
          .setDescription('What the bot will say when the command is used')
          .setRequired(true)))

  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a chat command')
      .addStringOption(o =>
        o.setName('trigger')
          .setDescription('Trigger word to remove (no ! needed)')
          .setRequired(true)))

  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('List all registered chat commands'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── /command add ──────────────────────────────────────────────────────────
  if (sub === 'add') {
    const trigger  = interaction.options.getString('trigger').trim().toLowerCase().replace(/^!/, '');
    const response = interaction.options.getString('response').trim();

    if (!/^[A-Za-z0-9_]+$/.test(trigger)) {
      return interaction.editReply('⚠️ Trigger can only contain letters, numbers, and underscores.');
    }

    const isUpdate = registry.getCommands().some(c => c.trigger === trigger);
    registry.registerCommand(trigger, response);

    log.info(`[commands] !${trigger} ${isUpdate ? 'updated' : 'added'} by ${interaction.user.tag}`);
    return interaction.editReply(
      `${isUpdate ? '✏️ Updated' : '✅ Added'} **!${trigger}** → ${response}`
    );
  }

  // ── /command remove ───────────────────────────────────────────────────────
  if (sub === 'remove') {
    const trigger = interaction.options.getString('trigger').trim().toLowerCase().replace(/^!/, '');
    const exists  = registry.getCommands().some(c => c.trigger === trigger);

    if (!exists) {
      return interaction.editReply(`⚠️ No command **!${trigger}** found.`);
    }

    registry.removeCommand(trigger);
    log.info(`[commands] !${trigger} removed by ${interaction.user.tag}`);
    return interaction.editReply(`🗑️ Removed **!${trigger}**.`);
  }

  // ── /command list ─────────────────────────────────────────────────────────
  if (sub === 'list') {
    const cmds = registry.getCommands();
    if (!cmds.length) {
      return interaction.editReply('No commands registered yet. Use `/command add` to create one.');
    }
    const lines = cmds.map(c => `**!${c.trigger}** → ${c.response}`);
    return interaction.editReply(`**Registered commands (${cmds.length}):**\n${lines.join('\n')}`);
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