'use strict';

/**
 * Plugin pipeline
 * ───────────────
 * Plugins live in src/plugins/<name>/index.js and export:
 *
 *   {
 *     id:       'unique-id',          // string, kebab-case
 *     command:  SlashCommandBuilder,  // optional — registers a slash command
 *     init(discord):  void,           // optional — called on startup with discord module
 *     processMessage(msg):
 *       Promise<ProcessResult | null> // null = suppress message entirely
 *   }
 *
 * ProcessResult:
 *   {
 *     message:    msg | null,   // modified (or original) message for the main feed;
 *                               //   null = don't send to main feed
 *     sideEffect: async fn,     // optional — called regardless of message routing,
 *                               //   used to send to alternate channels
 *   }
 *
 * Plugins are applied in order. The first plugin to return null (suppress)
 * wins — later plugins do not run on a suppressed message.
 */

const path = require('path');
const log  = require('../logger');
// Import overlay-server before any plugin loads so registerSection() is ready
// when plugin modules execute their top-level require-time registration calls.
require('../overlay-server');

const _plugins = [];

/**
 * Auto-discover and load all subdirectory plugins.
 * Safe to call multiple times — skips already-loaded plugin IDs.
 */
function loadPlugins() {
  const fs   = require('fs');
  const dir  = __dirname;
  const dirs = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const name of dirs) {
    const file = path.join(dir, name, 'index.js');
    if (!require('fs').existsSync(file)) continue;
    try {
      const plugin = require(file);
      if (!plugin.id) { log.warn(`[Plugins] Plugin in ${name}/ has no id — skipping`); continue; }
      if (_plugins.find(p => p.id === plugin.id)) continue; // already loaded
      _plugins.push(plugin);
      log.info(`[Plugins] Loaded plugin: ${plugin.id}`);
    } catch (err) {
      log.error(`[Plugins] Failed to load plugin ${name}:`, err.message);
    }
  }
}

/**
 * Call init(context) on every plugin that declares one.
 * @param {object} context
 *   discord:    { sendChat, sendRedeem, onModAction }
 *   chatReply:  { twitch: async fn(text), youtube: async fn(text) }
 */
function initPlugins(context) {
  for (const plugin of _plugins) {
    if (typeof plugin.init === 'function') {
      try { plugin.init(context); }
      catch (err) { log.error(`[Plugins] Init error in ${plugin.id}:`, err.message); }
    }
  }
}

/**
 * Return all SlashCommandBuilder instances from plugins.
 * Plugins may export a single `command` or an array `commands`.
 */
function getPluginCommands() {
  const out = [];
  for (const plugin of _plugins) {
    const list = plugin.commands
      ? (Array.isArray(plugin.commands) ? plugin.commands : [plugin.commands])
      : plugin.command
        ? [plugin.command]
        : [];
    for (const cmd of list) {
      out.push(cmd.toJSON ? cmd.toJSON() : cmd);
    }
  }
  return out;
}

/**
 * Route a slash command interaction to the owning plugin.
 * Returns true if a plugin handled it, false otherwise.
 */
async function handlePluginInteraction(interaction) {
  for (const plugin of _plugins) {
    // Collect all command names this plugin owns
    const list = plugin.commands
      ? (Array.isArray(plugin.commands) ? plugin.commands : [plugin.commands])
      : plugin.command
        ? [plugin.command]
        : [];

    const names = list.map(c => (typeof c.toJSON === 'function' ? c.toJSON().name : c.name));
    if (!names.includes(interaction.commandName)) continue;

    if (typeof plugin.handleInteraction !== 'function') {
      await interaction.reply({ content: `⚠️ Plugin \`${plugin.id}\` has no interaction handler.`, ephemeral: true });
      return true;
    }
    try {
      await plugin.handleInteraction(interaction);
    } catch (err) {
      log.error(`[Plugins] Interaction error in ${plugin.id}:`, err.message);
      const reply = { content: `❌ Error in plugin \`${plugin.id}\`: ${err.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(reply);
      else await interaction.reply(reply);
    }
    return true;
  }
  return false;
}

/**
 * Run a chat message through the full plugin pipeline.
 *
 * @param {object} msg  - { platform, username, message }
 * @returns {Promise<{ finalMsg: object|null, sideEffects: Function[] }>}
 *   finalMsg:    the (possibly modified) message to send to main feed, or null to suppress
 *   sideEffects: array of async fns to call (alternate-channel sends, etc.)
 */
async function runPipeline(msg) {
  let current      = { ...msg };
  const sideEffects = [];

  for (const plugin of _plugins) {
    if (typeof plugin.processMessage !== 'function') continue;

    let result;
    try {
      result = await plugin.processMessage(current);
    } catch (err) {
      log.error(`[Plugins] processMessage error in ${plugin.id}:`, err.message);
      continue;
    }

    if (result === null || result === undefined) {
      // Plugin suppressed the message
      return { finalMsg: null, sideEffects };
    }

    if (typeof result.sideEffect === 'function') {
      sideEffects.push(result.sideEffect);
    }

    if (result.message === null) {
      // Suppress from main feed but still collect any further side effects
      // by passing null sentinel; no further plugins process this message
      return { finalMsg: null, sideEffects };
    }

    if (result.message) {
      current = result.message;
    }
  }

  return { finalMsg: current, sideEffects };
}

// chatReply is set after platforms start; plugins access it via their init() context
let _chatReply = { twitch: null, youtube: null };

/**
 * Called from index.js after Twitch + YouTube clients are ready.
 * Re-inits any plugins that declared an init() so they get the chatReply object.
 */
function setChatReply(chatReply) {
  _chatReply = chatReply;
  for (const plugin of _plugins) {
    if (typeof plugin.onChatReady === 'function') {
      try { plugin.onChatReady(chatReply); }
      catch (err) { log.error(`[Plugins] onChatReady error in ${plugin.id}:`, err.message); }
    }
  }
}

function getChatReply() { return _chatReply; }

/**
 * Return metadata for all plugin slash commands in the same shape as
 * discord.coreCommandsMeta, suitable for building dashboard UI.
 * Each entry: { name, description, options: [{ name, description, required, choices? }] }
 */
function getPluginCommandsMeta() {
  const out = [];
  for (const plugin of _plugins) {
    const list = plugin.commands
      ? (Array.isArray(plugin.commands) ? plugin.commands : [plugin.commands])
      : plugin.command
        ? [plugin.command]
        : [];
    for (const cmd of list) {
      const json = cmd.toJSON ? cmd.toJSON() : cmd;
      out.push({
        name:        json.name,
        description: json.description ?? '',
        pluginId:    plugin.id,
        options:     (json.options ?? []).map(o => ({
          name:        o.name,
          description: o.description ?? '',
          required:    o.required ?? false,
          choices:     o.choices  ?? null,
          type:        o.type     ?? null,   // discord option type int, useful for selects
        })),
      });
    }
  }
  return out;
}

/**
 * Dispatch a plugin slash command from a non-Discord caller (e.g. the dashboard).
 * Builds a minimal synthetic interaction object and routes it through handlePluginInteraction.
 *
 * @param {string} name     Command name owned by a plugin
 * @param {Record<string, string>} optionValues  Map of option name → value string
 * @returns {Promise<string[]>}  Result lines (same contract as discord.dispatchCommand)
 */
async function dispatchPluginCommand(name, optionValues = {}) {
  const results = [];
  let replied = false;

  // Synthetic interaction that satisfies the read paths plugins typically use
  const interaction = {
    commandName: name,
    isChatInputCommand: () => true,
    deferred:  false,
    replied:   false,
    options: {
      getString:  (key) => optionValues[key] ?? null,
      getInteger: (key) => {
        const v = optionValues[key];
        return v !== undefined && v !== null ? parseInt(v, 10) : null;
      },
      getNumber:  (key) => {
        const v = optionValues[key];
        return v !== undefined && v !== null ? parseFloat(v) : null;
      },
      getBoolean: (key) => {
        const v = optionValues[key];
        if (v === null || v === undefined) return null;
        return v === 'true' || v === true;
      },
      getUser:    (key) => optionValues[key] ? { username: optionValues[key], id: null } : null,
    },
    async deferReply()  { interaction.deferred = true; },
    async reply(payload)  {
      replied = true;
      interaction.replied = true;
      const text = typeof payload === 'string' ? payload : (payload.content ?? '');
      if (text) results.push(text);
    },
    async editReply(payload) {
      const text = typeof payload === 'string' ? payload : (payload.content ?? '');
      if (text) results.push(text);
    },
    async followUp(payload) {
      const text = typeof payload === 'string' ? payload : (payload.content ?? '');
      if (text) results.push(text);
    },
  };

  const handled = await handlePluginInteraction(interaction);
  if (!handled) results.push(`⚠️ No plugin owns command /${name}`);
  return results;
}

module.exports = {
  loadPlugins, initPlugins, getPluginCommands, getPluginCommandsMeta,
  handlePluginInteraction, dispatchPluginCommand,
  runPipeline, setChatReply, getChatReply,
};