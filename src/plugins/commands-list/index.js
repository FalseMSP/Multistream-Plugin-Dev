'use strict';
/**
 * Plugin: commands-list
 * ─────────────────────
 * Single source of truth for all chat commands.
 * Owns state.json and exposes a registry API for other plugins to use.
 *
 * Registry API (for other plugins):
 *   const registry = require('./commands-list');
 *   registry.registerCommand('!tnt',    'Spawns TNT at the streamer');
 *   registry.registerCommand('!points', 'Check your points');
 *   registry.removeCommand('!tnt');
 *   registry.getCommands();
 *
 * Chat commands (Twitch + YouTube):
 *   !commands / !help — bot replies with the full command list
 *
 * Discord slash commands (mods only):
 *   /commands list — show all registered commands
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
    return { commands: {} };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log.error('[commands-list] Failed to save state:', e.message);
  }
}

let _state = loadState();

// ── Registry API ──────────────────────────────────────────────────────────────

/**
 * Register a chat command. Normalises the trigger (strips leading ! and lowercases).
 * Calling again with the same trigger overwrites the response (safe for hot-reloads).
 *
 * @param {string} trigger   e.g. '!tnt' or 'tnt'
 * @param {string} response  What the bot says when the command is used
 */
function registerCommand(trigger, response) {
  if (!trigger || !response) {
    log.warn('[commands-list] registerCommand called with missing trigger or response');
    return;
  }
  const key = trigger.toLowerCase().trim().replace(/^!/, '');
  _state.commands[key] = response;
  saveState(_state);
  log.info(`[commands-list] Registered command: !${key}`);
}

/**
 * Remove a previously registered command.
 *
 * @param {string} trigger  e.g. '!tnt' or 'tnt'
 */
function removeCommand(trigger) {
  const key = trigger.toLowerCase().trim().replace(/^!/, '');
  if (!_state.commands[key]) {
    log.warn(`[commands-list] removeCommand: !${key} not found`);
    return;
  }
  delete _state.commands[key];
  saveState(_state);
  log.info(`[commands-list] Removed command: !${key}`);
}

/**
 * Returns all registered commands as a sorted array of { trigger, response } objects.
 *
 * @returns {{ trigger: string, response: string }[]}
 */
function getCommands() {
  return Object.entries(_state.commands)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([trigger, response]) => ({ trigger, response }));
}

// ── Chat ──────────────────────────────────────────────────────────────────────

const CMD_COMMANDS = /^!(commands|help)\s*$/i;

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[commands-list] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!msg.message || !CMD_COMMANDS.test(msg.message.trim())) return { message: msg };

  const cmds  = getCommands();
  const reply = cmds.length
    ? 'Commands: ' + cmds.map(c => `!${c.trigger}`).join(' | ')
    : 'No commands registered yet.';

  let send;
  if (msg.platform === 'youtube' && msg.videoId && _chatReply._youtubeSession) {
    // Reply only to the stream this command came from
    const videoId = msg.videoId;
    send = (text) => _chatReply._youtubeSession(videoId, text);
  } else {
    send = _chatReply[msg.platform];
  }

  if (send) {
    send(reply).catch(e => log.error('[commands-list] chat reply error:', e.message));
  }

  return { message: null };
}

// ── Discord slash command ─────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('commands')
  .setDescription('Show all registered chat commands')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('Show all registered !commands'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const cmds = getCommands();
    if (!cmds.length) {
      return interaction.editReply('ℹ️ No commands registered yet. Use `/command add` to create one.');
    }
    const lines = cmds.map(c => `• \`!${c.trigger}\` — ${c.response}`);
    return interaction.editReply(`**Registered commands (${cmds.length}):**\n${lines.join('\n')}`);
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * When wiring up chat replies, pass `_youtubeSession: youtube.sayTo` so that
 * YouTube commands reply only to the stream they came from:
 *
 *   plugin.onChatReady({
 *     twitch:          (text) => twitch.say(text),
 *     youtube:         (text) => youtube.say(text),   // broadcast fallback (unused by this plugin)
 *     _youtubeSession: (videoId, text) => youtube.sayTo(videoId, text),
 *   });
 */

module.exports = {
  id: 'commands-list',
  command,
  handleInteraction,
  onChatReady,
  processMessage,
  // Registry API for other plugins
  registerCommand,
  removeCommand,
  getCommands,
};