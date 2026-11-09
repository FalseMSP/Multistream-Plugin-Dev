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
 *   registry.registerCommand('!game',   'Shows the current game', { dynamic: true });
 *   registry.registerCommand(null,      'We are playing X!', { type: 'regex', pattern: 'level name' });
 *   registry.removeCommand('!tnt');
 *   registry.getCommands();
 *
 * Entry types:
 *   prefix  — the classic behaviour: chat must type exactly `!trigger`.
 *             If the entry is NOT `dynamic`, the add-commands plugin replies
 *             with the saved response text on the bot's behalf.
 *   regex   — matches the raw chat message against a regular expression
 *             (case-insensitive, no `!` prefix required). Always handled by
 *             the add-commands plugin, with a per-command cooldown.
 *
 * Entry flags:
 *   dynamic — the OWNING plugin implements the command itself (dynamic reply
 *             or side effect). add-commands must NOT auto-reply to it; it is
 *             still listed in !commands so viewers can discover it.
 *   platform — restrict a command to one platform ('twitch' | 'youtube').
 *             add-commands skips the entry when the message came from
 *             another platform.
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

const STATE_FILE   = path.join(__dirname, 'state.json');
const STATE_VERSION = 2;

/** Longest regex pattern accepted (guards against pathological input). */
const MAX_PATTERN_LENGTH = 200;

function loadState() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { version: STATE_VERSION, commands: {} };
  }
  const state = _migrate(raw);
  // Upgrade the on-disk file once, so a rollback to an older bot build
  // never sees a half-written legacy/new mix.
  if (raw?.version !== STATE_VERSION) saveState(state);
  return state;
}

/**
 * Bring any on-disk state up to the current schema.
 * v1 (and the original unversioned format) stored plain string responses:
 *   { commands: { points: "Check your points" } }
 * v2 stores typed entry objects:
 *   { version: 2, commands: { points: { response, type, pattern, platform, dynamic } } }
 */
function _migrate(raw) {
  const state = { version: STATE_VERSION, commands: {} };
  const src   = raw?.commands && typeof raw.commands === 'object' ? raw.commands : {};
  for (const [key, value] of Object.entries(src)) {
    state.commands[key] = _normalizeEntry(value, key);
  }
  return state;
}

/** Coerce any stored/on-disk value into a valid v2 entry object. */
function _normalizeEntry(value, key) {
  // Legacy v1: plain response string
  if (typeof value === 'string') return { response: value, type: 'prefix' };

  const type = value?.type === 'regex' ? 'regex' : 'prefix';
  return {
    response:  typeof value?.response === 'string' ? value.response : '',
    type,
    pattern:   type === 'regex'
      ? (typeof value?.pattern === 'string' && value.pattern ? value.pattern : key.replace(/^re:/, ''))
      : undefined,
    platform:  typeof value?.platform === 'string' ? value.platform : null,
    dynamic:   !!value?.dynamic,
    addedBy:   typeof value?.addedBy === 'string' ? value.addedBy : null,
    addedAt:   Number.isFinite(value?.addedAt) ? value.addedAt : null,
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log.error('[commands-list] Failed to save state:', e.message);
  }
}

let _state = loadState();

// ── Regex validation ──────────────────────────────────────────────────────────

/**
 * Validate a chat-trigger regex pattern.
 * @returns {{ ok: boolean, error?: string, regex?: RegExp }}
 *   Rejected when: empty / too long / does not compile / matches the empty
 *   string (such a pattern would fire on literally every chat message).
 */
function validateRegexPattern(pattern) {
  const p = String(pattern ?? '').trim();
  if (!p)                                 return { ok: false, error: 'Pattern is empty.' };
  if (p.length > MAX_PATTERN_LENGTH)      return { ok: false, error: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters.` };
  let regex;
  try {
    regex = new RegExp(p, 'i');
  } catch (err) {
    return { ok: false, error: `Invalid regex: ${err.message}` };
  }
  if (regex.test('')) {
    return { ok: false, error: 'Pattern matches the empty string — it would trigger on every message. Add something more specific.' };
  }
  return { ok: true, regex };
}

// ── Registry API ──────────────────────────────────────────────────────────────

/**
 * Register a chat command.
 *
 * Prefix commands: the trigger is normalised (leading ! stripped, lowercased).
 * Regex commands: keyed under `re:<pattern>` so patterns and plain triggers
 * can never collide.
 * Calling again with the same trigger/pattern overwrites the entry
 * (safe for hot-reloads).
 *
 * @param {string} trigger    e.g. '!tnt' or 'tnt' (ignored for regex entries —
 *                            pass the pattern via opts.pattern)
 * @param {string} response   What the bot says when the command is used
 * @param {object|string} [opts]
 *   string → shorthand for { platform: opts } (backward compatible with the
 *   old undocumented 3-argument calls, e.g. 0yt-points passing 'youtube')
 *   object → {
 *     type:    'prefix' | 'regex',       (default 'prefix')
 *     pattern: string,                   (required when type === 'regex')
 *     platform: 'twitch' | 'youtube' | null,
 *     dynamic:  boolean,                 (default false)
 *     addedBy:  string | null,
 *   }
 * @returns {object|null} the stored entry, or null when validation failed
 */
function registerCommand(trigger, response, opts) {
  const options = typeof opts === 'string' ? { platform: opts } : (opts ?? {});

  if (!response) {
    log.warn('[commands-list] registerCommand called with missing trigger or response');
    return null;
  }

  // ── Regex entry ────────────────────────────────────────────────────────────
  if (options.type === 'regex') {
    const pattern = String(options.pattern ?? trigger ?? '').trim();
    const check   = validateRegexPattern(pattern);
    if (!check.ok) {
      log.warn(`[commands-list] Rejected regex command "${pattern}": ${check.error}`);
      return null;
    }
    const key = 're:' + pattern;
    const isUpdate = !!_state.commands[key];
    _state.commands[key] = {
      response:  String(response),
      type:      'regex',
      pattern,
      platform:  options.platform ?? null,
      dynamic:   false,                       // always auto-handled by add-commands
      addedBy:   options.addedBy ?? _state.commands[key]?.addedBy ?? null,
      addedAt:   isUpdate ? (_state.commands[key]?.addedAt ?? Date.now()) : Date.now(),
    };
    saveState(_state);
    log.info(`[commands-list] ${isUpdate ? 'Updated' : 'Registered'} regex command: /${pattern}/`);
    return { ..._state.commands[key] };
  }

  // ── Prefix entry (default) ────────────────────────────────────────────────
  if (!trigger) {
    log.warn('[commands-list] registerCommand called with missing trigger or response');
    return null;
  }
  const key = trigger.toLowerCase().trim().replace(/^!/, '');
  if (!key) {
    log.warn('[commands-list] registerCommand called with an empty trigger');
    return null;
  }
  const isUpdate = !!_state.commands[key];
  _state.commands[key] = {
    response:  String(response),
    type:      'prefix',
    pattern:   undefined,
    platform:  options.platform ?? null,
    dynamic:   !!options.dynamic,
    addedBy:   options.addedBy ?? _state.commands[key]?.addedBy ?? null,
    addedAt:   isUpdate ? (_state.commands[key]?.addedAt ?? Date.now()) : Date.now(),
  };
  saveState(_state);
  log.info(`[commands-list] ${isUpdate ? 'Updated' : 'Registered'} command: !${key}${options.dynamic ? ' (dynamic)' : ''}`);
  return { ..._state.commands[key] };
}

/**
 * Remove a previously registered command. Tolerant about the input shape:
 * accepts '!trigger', 'trigger', '/pattern/', 'pattern' and mixed case.
 * @param {string} trigger
 * @returns {boolean} true when an entry was removed
 */
function removeCommand(trigger) {
  const raw = String(trigger ?? '').trim();
  if (!raw) return false;

  const unwrapped = raw.length > 1 && raw.startsWith('/') && raw.endsWith('/')
    ? raw.slice(1, -1)
    : raw;

  const candidates = [
    raw,                                   // exact key (regex entries are stored as 're:pattern')
    're:' + raw,                           // regex entry given as bare pattern
    're:' + unwrapped,                     // regex entry given as /pattern/
    raw.toLowerCase().replace(/^!/, ''),   // legacy prefix normalisation
  ];
  for (const key of candidates) {
    if (key && _state.commands[key]) {
      const entry = _state.commands[key];
      delete _state.commands[key];
      saveState(_state);
      log.info(`[commands-list] Removed ${entry.type === 'regex' ? `regex /${entry.pattern}/` : `command: !${key}`}`);
      return true;
    }
  }

  // Case-insensitive fallback scan (patterns are case-sensitive keys)
  const target = unwrapped.toLowerCase();
  for (const key of Object.keys(_state.commands)) {
    if (key.toLowerCase() === target || key.replace(/^re:/, '').toLowerCase() === target) {
      const entry = _state.commands[key];
      delete _state.commands[key];
      saveState(_state);
      log.info(`[commands-list] Removed ${entry.type === 'regex' ? `regex /${entry.pattern}/` : `command: !${key}`}`);
      return true;
    }
  }

  log.warn(`[commands-list] removeCommand: "${raw}" not found`);
  return false;
}

/**
 * Returns all registered commands as a sorted array of entry objects
 * (prefix commands first, then regex commands; each group A–Z).
 *
 * @returns {{ trigger: string, response: string, type: 'prefix'|'regex',
 *             pattern?: string, platform: string|null, dynamic: boolean }[]}
 */
function getCommands() {
  const entries = Object.entries(_state.commands).map(([key, entry]) => ({
    trigger:  entry.type === 'regex' ? entry.pattern : key,
    response: entry.response,
    type:     entry.type,
    pattern:  entry.type === 'regex' ? entry.pattern : undefined,
    platform: entry.platform ?? null,
    dynamic:  !!entry.dynamic,
  }));
  return entries.sort((a, b) =>
    (a.type === b.type)
      ? a.trigger.localeCompare(b.trigger)
      : (a.type === 'prefix' ? -1 : 1)
  );
}

/** Render a command entry the way viewers see it in chat lists. */
function formatTrigger(entry) {
  return entry.type === 'regex' ? `/${entry.pattern}/` : `!${entry.trigger}`;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

const CMD_COMMANDS = /^!(commands|help)\s*$/i;

let _chatReply = { twitch: null, youtube: null, youtubeSession: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[commands-list] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!msg.message || !CMD_COMMANDS.test(msg.message.trim())) return { message: msg };

  const cmds  = getCommands();
  const reply = cmds.length
    ? 'Commands: ' + cmds.map(c => formatTrigger(c)).join(' | ')
    : 'No commands registered yet.';

  let send;
  if (msg.platform === 'youtube' && msg.videoId && _chatReply.youtubeSession) {
    // Reply only to the stream this command came from — uses the documented
    // chatReply.youtubeSession(videoId, text) contract instead of the old
    // underscore-prefixed _youtubeSession backdoor.
    const videoId = msg.videoId;
    send = (text) => _chatReply.youtubeSession(videoId, text);
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
      .setDescription('Show all registered chat commands'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const cmds = getCommands();
    if (!cmds.length) {
      return interaction.editReply('ℹ️ No commands registered yet. Use `/command add` to create one.');
    }
    const lines = cmds.map(c =>
      `• \`${formatTrigger(c)}\`${c.type === 'regex' ? ' *(regex)*' : ''}${c.platform ? ` *(${c.platform} only)*` : ''} — ${c.response}`);
    return interaction.editReply(`**Registered commands (${cmds.length}):**\n${lines.join('\n')}`);
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * The chatReply contract (set via onChatReady) is:
 *
 *   {
 *     twitch:         (text) => void,                  // broadcast to primary Twitch channel
 *     youtube:        (text) => void,                  // broadcast to all live YT sessions
 *     youtubeSession: (videoId, text) => void,         // target one specific YT live stream
 *   }
 *
 * The youtubeSession field is set by index.js once the YouTube module is ready.
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
  validateRegexPattern,
  formatTrigger,
};
