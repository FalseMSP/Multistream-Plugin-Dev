'use strict';

/**
 * Plugin: minecraft-link
 * ──────────────────────
 * When a viewer's chat message matches a configurable regex, the message is
 * forwarded to a dedicated #plugin-chat Discord channel in a structured format
 * that a Minecraft mod (or any external consumer) can read via the Discord API.
 *
 * The message is suppressed from #stream-chat to avoid spam —
 * it is ONLY forwarded to #plugin-chat.
 *
 * Forwarded format (plain text, easy to parse):
 *   {Username}: <original message>
 *
 * Example trigger: viewer types "tnt" → #plugin-chat receives:
 *   {Steve}: tnt
 *
 * Slash command: /minecraft_link
 *   status                — show enabled state, pattern, webhook
 *   enable                — start forwarding matched messages
 *   disable               — stop forwarding (main chat unaffected)
 *   set_pattern <regex>   — update the match regex live
 *   test <message>        — dry-run: check if a message would be forwarded
 *
 * Environment variables:
 *   DISCORD_MINECRAFT_WEBHOOK_URL     — webhook URL for #plugin-chat
 *   MINECRAFT_LINK_DEFAULT_REGEX      — override the default pattern at startup
 *   MINECRAFT_LINK_ENABLED            — 'false' to start disabled (default: true)
 */

const { SlashCommandBuilder, EmbedBuilder, WebhookClient, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');

// ── Config ────────────────────────────────────────────────────────────────

const WEBHOOK_URL = process.env.DISCORD_MINECRAFT_WEBHOOK_URL ?? '';

// Default: match the word "tnt" anywhere in the message.
// Override via MINECRAFT_LINK_DEFAULT_REGEX or /minecraft_link set_pattern.
const DEFAULT_PATTERN = process.env.MINECRAFT_LINK_DEFAULT_REGEX ?? String.raw`\btnt\b`;

// ── State ─────────────────────────────────────────────────────────────────

let _enabled = (process.env.MINECRAFT_LINK_ENABLED ?? 'true').toLowerCase() !== 'false';
let _pattern = DEFAULT_PATTERN;
let _regex   = safeCompile(DEFAULT_PATTERN);
let _webhook = null;

function safeCompile(pattern) {
  try   { return new RegExp(pattern, 'i'); }
  catch { return null; }
}

function getWebhook() {
  if (!_webhook && WEBHOOK_URL) _webhook = new WebhookClient({ url: WEBHOOK_URL });
  return _webhook;
}

// ── processMessage ────────────────────────────────────────────────────────

async function processMessage(msg) {
  // Always pass the message through to the main feed unchanged.
  // We only ever add a side effect — never suppress.

  if (!_enabled || !_regex || !WEBHOOK_URL) {
    return { message: msg };
  }

  if (!_regex.test(msg.message)) {
    return { message: msg };
  }

  // Matched — forward to #plugin-chat as a structured plain-text message.
  const formatted = `{${msg.username}}: ${msg.message}`;
  const wh = getWebhook();

  return {
    message: null, // suppress from #stream-chat — only goes to #plugin-chat
    sideEffect: wh
      ? async () => {
          try {
            await wh.send({ content: formatted });
            log.debug(`[minecraft-link] Forwarded → "${formatted}"`);
          } catch (err) {
            log.error('[minecraft-link] Webhook send error:', err.message);
          }
        }
      : null,
  };
}

// ── Slash command ─────────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('minecraft_link')
  .setDescription('Manage Minecraft plugin chat trigger forwarding')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show current configuration'))
  .addSubcommand(sub =>
    sub.setName('enable')
      .setDescription('Start forwarding matched messages to #plugin-chat'))
  .addSubcommand(sub =>
    sub.setName('disable')
      .setDescription('Stop forwarding (main stream chat is unaffected)'))
  .addSubcommand(sub =>
    sub.setName('set_pattern')
      .setDescription('Update the regex that triggers a forward')
      .addStringOption(o =>
        o.setName('regex')
          .setDescription('JavaScript regex (no slashes) — e.g.  \\btnt\\b|\\bbomb\\b')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('test')
      .setDescription('Check whether a message would be forwarded without sending anything')
      .addStringOption(o =>
        o.setName('message')
          .setDescription('The chat message text to test')
          .setRequired(true)));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const lines = [
      `**Status:**   ${_enabled ? '✅ Enabled' : '❌ Disabled'}`,
      `**Webhook:**  ${WEBHOOK_URL ? '✅ Configured' : '⚠️ Missing `DISCORD_MINECRAFT_WEBHOOK_URL`'}`,
      `**Pattern:**  \`${_pattern}\``,
      `**Regex OK:** ${_regex ? '✅' : '❌ Invalid — update with /minecraft_link set_pattern'}`,
      '',
      `Matched messages are **removed** from #stream-chat and forwarded to #plugin-chat as:`,
      `\`\`\`{Username}: <message>\`\`\``,
      `Main stream chat is **never** affected.`,
    ];
    return interaction.editReply(lines.join('\n'));
  }

  if (sub === 'enable') {
    _enabled = true;
    return interaction.editReply('✅ minecraft-link **enabled**. Matched messages will be forwarded to #plugin-chat and hidden from #stream-chat.');
  }

  if (sub === 'disable') {
    _enabled = false;
    return interaction.editReply('⏸ minecraft-link **disabled**. All messages flow to main chat only.');
  }

  if (sub === 'set_pattern') {
    const raw      = interaction.options.getString('regex');
    const compiled = safeCompile(raw);
    if (!compiled) {
      return interaction.editReply(`❌ Invalid regex: \`${raw}\`\nPattern **not** updated — fix the syntax and try again.`);
    }
    _pattern = raw;
    _regex   = compiled;
    return interaction.editReply([
      `✅ Pattern updated to:`,
      `\`\`\`${raw}\`\`\``,
      `Messages matching this regex will be forwarded as \`{Username}: <message>\`.`,
    ].join('\n'));
  }

  if (sub === 'test') {
    const text    = interaction.options.getString('message');
    const matches = _regex ? _regex.test(text) : false;
    if (!_regex) {
      return interaction.editReply('❌ Current pattern is invalid — update it first with `/minecraft_link set_pattern`.');
    }
    const lines = [
      `**Message:** \`${text}\``,
      `**Pattern:** \`${_pattern}\``,
      `**Result:**  ${matches ? `✅ MATCH — would forward as \`{SomeUser}: ${text}\`` : '❌ No match — would not forward'}`,
    ];
    return interaction.editReply(lines.join('\n'));
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'minecraft-link',
  command,
  handleInteraction,
  processMessage,
};