'use strict';

/**
 * Plugin: add-commands
 * ────────────────────
 * The generic chat-command responder. Delegates all storage and registry
 * management to commands-list.
 *
 * Matching rules:
 *   • Prefix commands (default): chat must type exactly `!trigger`.
 *     Entries flagged `dynamic` are owned by other plugins (they implement
 *     their own reply / side effect) and are left alone here — only their
 *     `!commands` listing is shared.
 *     Entries with a `platform` only respond on that platform.
 *   • Regex commands (`/command add <trigger> <response> regex: true`):
 *     the raw chat message is tested against the pattern (case-insensitive,
 *     no `!` prefix required) and the bot replies with the saved response.
 *     A per-command cooldown stops a chatty pattern from flooding chat, and
 *     the message itself is only suppressed from the Discord mirror when it
 *     starts with `!` (i.e. it really was meant as a command).
 *
 * Discord slash commands (mods only):
 *   /command add <trigger> <response> [regex] — add or overwrite a command
 *   /command remove <trigger>                 — delete a command
 *   /command list                             — show all registered commands
 *
 * Chat usage (Twitch + YouTube):
 *   !<trigger>     — bot replies with the saved response text
 *   /<pattern>/    — regex commands fire on any matching message
 */

const log      = require('../../logger');
const registry = require('../commands-list');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

// ── Chat matching ─────────────────────────────────────────────────────────────

/** Classic prefix command: exactly `!word` (letters/digits/underscore only). */
const CMD_RE = /^!([A-Za-z0-9_]+)\s*$/;

/** Triggers owned by the commands-list plugin itself. */
const RESERVED_TRIGGERS = new Set(['commands', 'help']);

/**
 * Per-command cooldown for regex-triggered replies. Chat patterns can match
 * ordinary conversation, so without this a popular pattern would let the bot
 * reply to message after message. Also stops the bot from echoing its own
 * replies on YouTube (the bot's sent messages re-enter the read loop there).
 */
const REGEX_COOLDOWN_MS = (() => {
  const v = parseInt(process.env.REGEX_CMD_COOLDOWN_MS ?? '', 10);
  if (!Number.isFinite(v)) return 5_000;
  return Math.min(600_000, Math.max(0, v));
})();

/** Per-regex-command timestamp of the last reply sent (pattern → ms). */
const _regexCooldowns = new Map();

/** Recent regex replies sent by this plugin (text → timestamp). */
const _recentRegexReplies = new Map();
const SELF_ECHO_WINDOW_MS = 60_000;

/** Compiled pattern cache (pattern string → RegExp | null). */
const _regexCache = new Map();

let _chatReply = { twitch: null, youtube: null, youtubeSession: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[commands] Chat reply handlers registered.');
}

/** Build the platform-appropriate reply sender for a chat message. */
function _replySender(msg) {
  if (msg.platform === 'youtube' && msg.videoId && _chatReply.youtubeSession) {
    // Reply only to the stream the message came from.
    const videoId = msg.videoId;
    return (text) => _chatReply.youtubeSession(videoId, text);
  }
  return _chatReply[msg.platform] ?? null;
}

function _compiledRegex(pattern) {
  if (!_regexCache.has(pattern)) {
    const { ok, regex } = registry.validateRegexPattern(pattern);
    _regexCache.set(pattern, ok ? regex : null);
  }
  return _regexCache.get(pattern);
}

function _platformOk(entry, msg) {
  return !entry.platform || entry.platform === msg.platform;
}

/** Prune stale self-echo records and check whether text is one of our recent replies. */
function _isOwnRecentReply(text) {
  const now = Date.now();
  for (const [t, ts] of _recentRegexReplies) {
    if (now - ts > SELF_ECHO_WINDOW_MS) _recentRegexReplies.delete(t);
  }
  return _recentRegexReplies.has(text);
}

async function processMessage(msg) {
  if (!msg.message) return { message: msg };
  const text = msg.message.trim();
  if (!text) return { message: msg };

  const cmds = registry.getCommands();

  // ── Lane 1: prefix commands (default — require the ! prefix) ─────────────
  const match = text.match(CMD_RE);
  if (match) {
    const trigger = match[1].toLowerCase();
    const entry   = cmds.find(c =>
      c.type !== 'regex' &&
      c.trigger === trigger &&
      !c.dynamic &&            // owned by another plugin — let it pass through
      _platformOk(c, msg)
    );
    if (entry && !RESERVED_TRIGGERS.has(trigger)) {
      const send = _replySender(msg);
      if (send) {
        send(entry.response)
          .catch(e => log.error(`[commands] chat reply error for !${trigger}:`, e.message));
      }
      return { message: null };
    }
    // No static entry → fall through to the regex lane: a regex command may
    // still legitimately match `!something` if its pattern says so.
  }

  // ── Lane 2: regex commands (no ! prefix required) ────────────────────────
  const now = Date.now();
  for (const entry of cmds) {
    if (entry.type !== 'regex' || !_platformOk(entry, msg)) continue;

    const re = _compiledRegex(entry.pattern);
    if (!re || !re.test(text)) continue;

    // YouTube echoes the bot's own sent messages back into the chat reader.
    // Never let a regex command react to text we just posted ourselves.
    if (_isOwnRecentReply(text)) return { message: msg };

    const lastSentAt = _regexCooldowns.get(entry.pattern) ?? 0;
    if (now - lastSentAt < REGEX_COOLDOWN_MS) {
      log.debug(`[commands] regex /${entry.pattern}/ on cooldown (${Math.ceil((REGEX_COOLDOWN_MS - (now - lastSentAt)) / 1000)}s left) — skipping reply`);
      return { message: text.startsWith('!') ? null : msg };
    }

    const send = _replySender(msg);
    if (send) {
      _regexCooldowns.set(entry.pattern, now);
      _recentRegexReplies.set(entry.response, now);
      send(entry.response)
        .catch(e => log.error(`[commands] chat reply error for /${entry.pattern}/:`, e.message));
    }
    // Suppress the trigger from the Discord mirror only when it was invoked
    // like a command (leading !); ordinary conversation stays visible.
    return { message: text.startsWith('!') ? null : msg };
  }

  return { message: msg };
}

// ── Discord slash command ─────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('command')
  .setDescription('Manage custom chat commands (!trigger → response, or regex patterns)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)

  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add or overwrite a chat command')
      .addStringOption(o =>
        o.setName('trigger')
          .setDescription('Trigger word (users type !trigger) — or a regex pattern when the regex flag is set')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('response')
          .setDescription('What the bot will say when the command is used')
          .setRequired(true))
      .addBooleanOption(o =>
        o.setName('regex')
          .setDescription('Treat the trigger as a regex matched against any chat message (no ! prefix needed)')))

  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a chat command')
      .addStringOption(o =>
        o.setName('trigger')
          .setDescription('Trigger word or regex pattern to remove (no ! needed)')
          .setRequired(true)))

  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('List all registered chat commands'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();

  // ── /command add ──────────────────────────────────────────────────────────
  if (sub === 'add') {
    const rawTrigger = interaction.options.getString('trigger').trim();
    const response   = interaction.options.getString('response').trim();
    const asRegex    = interaction.options.getBoolean('regex') === true;

    // Also accept /pattern/ wrapped triggers as regex shorthand
    const slashWrapped = rawTrigger.length > 1 && rawTrigger.startsWith('/') && rawTrigger.endsWith('/');
    const isRegex      = asRegex || slashWrapped;
    const pattern      = slashWrapped ? rawTrigger.slice(1, -1) : rawTrigger;

    if (isRegex) {
      const check = registry.validateRegexPattern(pattern);
      if (!check.ok) {
        return interaction.editReply(`⚠️ ${check.error}\nExample: \`^what.?s the level\` or \`level name\``);
      }
      const isUpdate = registry.getCommands().some(c => c.type === 'regex' && c.pattern === pattern);
      const entry = registry.registerCommand(null, response, { type: 'regex', pattern, addedBy: interaction.user.tag });
      if (!entry) {
        return interaction.editReply('⚠️ Could not register the regex command — check the bot logs.');
      }
      log.info(`[commands] regex /${pattern}/ ${isUpdate ? 'updated' : 'added'} by ${interaction.user.tag}`);
      return interaction.editReply(
        `${isUpdate ? '✏️ Updated' : '✅ Added'} regex command **/${pattern}/** → ${response}\n` +
        `Matches any chat message against \`/${pattern}/i\` — no ! prefix needed. ` +
        `Replies at most once every ${Math.round(REGEX_COOLDOWN_MS / 1000)}s per command.`
      );
    }

    // Prefix command path
    const trigger = rawTrigger.toLowerCase().replace(/^!/, '');
    if (!/^[A-Za-z0-9_]+$/.test(trigger)) {
      return interaction.editReply('⚠️ Trigger can only contain letters, numbers, and underscores (or set the regex flag for pattern matching).');
    }
    if (RESERVED_TRIGGERS.has(trigger)) {
      return interaction.editReply('⚠️ `!' + trigger + '` is reserved for the built-in command list.');
    }

    const isUpdate = registry.getCommands().some(c => c.type !== 'regex' && c.trigger === trigger);
    registry.registerCommand(trigger, response, { addedBy: interaction.user.tag });

    log.info(`[commands] !${trigger} ${isUpdate ? 'updated' : 'added'} by ${interaction.user.tag}`);
    return interaction.editReply(
      `${isUpdate ? '✏️ Updated' : '✅ Added'} **!${trigger}** → ${response}`
    );
  }

  // ── /command remove ───────────────────────────────────────────────────────
  if (sub === 'remove') {
    const raw = interaction.options.getString('trigger').trim();
    const cmds = registry.getCommands();

    // Find the entry first so the confirmation can show its real shape
    const slashWrapped = raw.length > 1 && raw.startsWith('/') && raw.endsWith('/');
    const bare = slashWrapped ? raw.slice(1, -1) : raw.replace(/^!/, '').toLowerCase();
    const entry = cmds.find(c =>
      (c.type === 'regex' && c.pattern === bare) ||
      (c.type !== 'regex' && c.trigger === bare)
    );

    if (!entry) {
      return interaction.editReply(`⚠️ No command matching **${raw}** found. Try \`/command list\` first.`);
    }

    registry.removeCommand(entry.type === 'regex' ? entry.pattern : entry.trigger);
    log.info(`[commands] ${entry.type === 'regex' ? `/${entry.pattern}/` : `!${entry.trigger}`} removed by ${interaction.user.tag}`);
    return interaction.editReply(`🗑️ Removed ${entry.type === 'regex' ? `regex **/${entry.pattern}/**` : `**!${entry.trigger}**`}.`);
  }

  // ── /command list ─────────────────────────────────────────────────────────
  if (sub === 'list') {
    const cmds = registry.getCommands();
    if (!cmds.length) {
      return interaction.editReply('No commands registered yet. Use `/command add` to create one.');
    }
    const lines = cmds.map(c => {
      if (c.type === 'regex') {
        return `**/${c.pattern}/** → ${c.response} *(regex${c.platform ? `, ${c.platform} only` : ''})*`;
      }
      const flags = [c.dynamic ? 'dynamic' : null, c.platform ? `${c.platform} only` : null].filter(Boolean).join(', ');
      return `**!${c.trigger}** → ${c.response}${flags ? ` *(${flags})*` : ''}`;
    });
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
