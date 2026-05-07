'use strict';
/**
 * Plugin: commands-list
 * ─────────────────────
 * Responds to !commands in chat with a list of all registered chat commands.
 *
 * Chat commands (Twitch + YouTube):
 *   !commands — bot replies with all known chat commands
 *
 * Registry API (for other plugins):
 *   const registry = require('./commands-list');
 *   registry.registerCommand('!tnt',     'Spawns TNT at the streamer');
 *   registry.registerCommand('!discord', 'Get the Discord invite link');
 *   registry.removeCommand('!tnt');
 *   registry.getCommands(); // → [{ name, description }, ...]
 */

const log = require('../../logger');

const CMD_COMMANDS = /^!commands\s*$/i;

/** @type {{ name: string, description: string }[]} */
const _registry = [];

let _chatReply = { twitch: null, youtube: null };

// ─── Registry API ────────────────────────────────────────────────────────────

/**
 * Register a chat command so it appears in !commands output.
 * Calling registerCommand with an already-registered name overwrites
 * the existing description (idempotent-friendly for hot-reloads).
 *
 * @param {string} name        The command trigger, e.g. "!discord"
 * @param {string} description Short human-readable explanation
 */
function registerCommand(name, description) {
  if (!name || !description) {
    log.warn('[commands-list] registerCommand called with missing name or description');
    return;
  }
  const normalised = name.toLowerCase().trim();
  const existing = _registry.findIndex(c => c.name === normalised);
  if (existing !== -1) {
    _registry[existing].description = description;
    log.info(`[commands-list] Updated command: ${normalised}`);
  } else {
    _registry.push({ name: normalised, description });
    log.info(`[commands-list] Registered command: ${normalised}`);
  }
}

/**
 * Remove a previously registered command.
 * @param {string} name  The command trigger, e.g. "!tnt"
 */
function removeCommand(name) {
  const normalised = name.toLowerCase().trim();
  const idx = _registry.findIndex(c => c.name === normalised);
  if (idx !== -1) {
    _registry.splice(idx, 1);
    log.info(`[commands-list] Removed command: ${normalised}`);
  }
}

/**
 * Returns a shallow copy of all registered commands, sorted alphabetically.
 * @returns {{ name: string, description: string }[]}
 */
function getCommands() {
  return [..._registry].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[commands-list] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!CMD_COMMANDS.test(msg.message.trim())) return { message: msg };

  const cmds = getCommands();
  const reply = cmds.length
    ? 'Commands: ' + cmds.map(c => `${c.name} (${c.description})`).join(' | ')
    : 'No commands registered yet.';

  const send = _chatReply[msg.platform];
  if (send) {
    send(reply).catch(e => log.error('[commands-list] chat reply error:', e.message));
  }

  return { message: null }; // suppress from #stream-chat
}

// ─── Pre-register built-in commands ──────────────────────────────────────────
// Add your static commands here so they always appear in !commands output.
// Each plugin can also call registerCommand() from its own init/onChatReady.

registerCommand('!commands', 'Lists all chat commands');
registerCommand('!discord',  'Get the Discord invite link');

// Minecraft / viewer interaction commands
registerCommand('!tnt',      'Spawns TNT near the streamer');
registerCommand('!william',  'Spawns a dog');
registerCommand('!creeper',  'Spawns a charged creeper');
registerCommand('!penny',    'Spawns a cat');
registerCommand('!suzy',     'Spawns a bunny');

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Plugin identity
  id: 'commands-list',

  // Plugin lifecycle hooks
  processMessage,
  onChatReady,

  // Public registry API — import this module from other plugins to use
  registerCommand,
  removeCommand,
  getCommands,
};