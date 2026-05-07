'use strict';

/**
 * Plugin: minecraft-link
 * ──────────────────────
 * When a viewer's chat message contains one of the configured keywords
 * (case-insensitive, substring/fuzzy match), the message is forwarded to a
 * dedicated #plugin-chat Discord channel in a structured format that the
 * Minecraft mod reads via the Discord API.
 *
 * The message is suppressed from #stream-chat to avoid spam —
 * it is ONLY forwarded to #plugin-chat.
 *
 * Forwarded format (plain text):
 *   [PLATFORM] Username: <original message>
 *
 * The Minecraft mod matches lines with:
 *   ^\\[(twitch|youtube)\\]\\s+(.+?):\\s+(?!.*REDEEM:).*<keyword>.*$  (CASE_INSENSITIVE)
 *
 * So the JS side just needs to forward the line in that format — the mod does
 * its own keyword filtering. The JS pattern here controls what gets forwarded;
 * keep it in sync with the mod's keyword list.
 *
 * Example trigger: viewer types "can we get some tnt going" → #plugin-chat receives:
 *   [TWITCH] Steve: can we get some tnt going
 *
 * All Twitch channel point redeems are ALWAYS forwarded to #plugin-chat as:
 *   [TWITCH] username: REDEEM: <redeem name>
 * (The mod's negative lookahead (?!.*REDEEM:) excludes these from keyword routing.)
 *
 * Slash command: /minecraft_link
 *   status                        — show enabled state, keywords, webhook
 *   enable                        — start forwarding matched messages
 *   disable                       — stop forwarding (main chat unaffected)
 *   set_keywords <word,word,...>   — replace the keyword list live
 *   add_keyword  <word>            — add a single keyword
 *   remove_keyword <word>          — remove a single keyword
 *   test <message>                 — dry-run: show which keyword(s) matched
 *
 * Environment variables:
 *   DISCORD_MINECRAFT_WEBHOOK_URL     — webhook URL for #plugin-chat
 *   MINECRAFT_LINK_KEYWORDS           — comma-separated keywords at startup
 *                                       default: tnt,william,creeper,penny,suzy
 *   MINECRAFT_LINK_ENABLED            — 'false' to start disabled (default: true)
 */

const { SlashCommandBuilder, WebhookClient, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');
const commandsList = require('../commands-list');

// ── Config ────────────────────────────────────────────────────────────────

const WEBHOOK_URL = process.env.DISCORD_MINECRAFT_WEBHOOK_URL ?? '';

const DEFAULT_KEYWORDS = (
  process.env.MINECRAFT_LINK_KEYWORDS ?? 'tnt,william,creeper,penny,suzy'
)
  .split(',')
  .map(k => k.trim().toLowerCase())
  .filter(Boolean);

// ── State ─────────────────────────────────────────────────────────────────

let _enabled     = (process.env.MINECRAFT_LINK_ENABLED ?? 'true').toLowerCase() !== 'false';
/** @type {Set<string>} lowercase keyword strings */
let _keywords    = new Set(DEFAULT_KEYWORDS);
/** Fuzzy: matches keyword anywhere in message */
let _regex       = buildRegex(_keywords);
/** Exact: matches only when the entire message is a single keyword */
let _exactRegex  = buildExactRegex(_keywords);
let _webhook     = null;

/**
 * Build a case-insensitive regex that fuzzy-matches any keyword
 * anywhere in the message text.
 * @param {Set<string>} keywords
 * @returns {RegExp|null}
 */
function buildRegex(keywords) {
  if (!keywords.size) return null;
  const alts = [...keywords].map(escapeRegex).join('|');
  return new RegExp(alts, 'i');
}

/**
 * Build a regex that matches ONLY when the entire trimmed message is exactly
 * one of the keywords (case-insensitive, optional surrounding whitespace).
 * e.g. "tnt" or "TNT" → exact. "I summon tnt" → not exact.
 * @param {Set<string>} keywords
 * @returns {RegExp|null}
 */
function buildExactRegex(keywords) {
  if (!keywords.size) return null;
  const alts = [...keywords].map(escapeRegex).join('|');
  return new RegExp(`^\\s*(${alts})\\s*$`, 'i');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns which keywords matched a given message (for diagnostics / test cmd).
 * @param {string} text
 * @returns {string[]}
 */
function matchedKeywords(text) {
  return [..._keywords].filter(kw =>
    new RegExp(escapeRegex(kw), 'i').test(text)
  );
}

function getWebhook() {
  if (!_webhook && WEBHOOK_URL) _webhook = new WebhookClient({ url: WEBHOOK_URL });
  return _webhook;
}

// ── init — hook into sendRedeem / sendDonation ────────────────────────────

function init(context) {
  log.info('[minecraft-link] init called, context keys:', Object.keys(context ?? {}));

  if (typeof context?.sendRedeem !== 'function') {
    log.warn('[minecraft-link] No sendRedeem found in context — redeem forwarding disabled.');
  } else {
    const _originalSendRedeem = context.sendRedeem;
    context.sendRedeem = async function (redeem) {
      const wh = getWebhook();
      if (wh && WEBHOOK_URL) {
        const redeemName = redeem?.title
          ?? redeem?.redeemName
          ?? redeem?.reward?.title
          ?? 'UNKNOWN';
        const username = redeem?.username
          ?? redeem?.user?.login
          ?? redeem?.user?.display_name
          ?? 'UNKNOWN';
        // NOTE: The Minecraft mod's negative lookahead (?!.*REDEEM:) ensures
        // these lines are never matched by keyword routes — they go to a
        // dedicated redeem handler on the mod side.
        const formatted = `[TWITCH] ${username}: REDEEM: ${redeemName}`;
        try {
          await wh.send({ content: formatted });
          log.debug(`[minecraft-link] Redeem forwarded → "${formatted}"`);
        } catch (err) {
          log.error('[minecraft-link] Webhook send error (redeem):', err.message);
        }
      }
      return _originalSendRedeem(redeem);
    };
    log.info('[minecraft-link] Redeem forwarding hooked ✅');
  }

  if (typeof context?.sendDonation !== 'function') {
    log.warn('[minecraft-link] No sendDonation found in context — donation forwarding disabled.');
  } else {
    const _originalSendDonation = context.sendDonation;
    context.sendDonation = async function (donation) {
      const wh = getWebhook();
      if (wh && WEBHOOK_URL) {
        const username = donation?.username ?? 'UNKNOWN';
        const type     = (donation?.type ?? 'donation').toUpperCase();
        let detail;
        switch (donation?.type) {
          case 'bits':    detail = `CHEER: ${donation.amount} bits`; break;
          case 'sub':     detail = `SUB (Tier ${donation.tier ?? '1000'})`; break;
          case 'resub':   detail = `RESUB (${donation.months} months, Tier ${donation.tier ?? '1000'})`; break;
          case 'subgift': detail = donation.recipient
            ? `SUBGIFT → ${donation.recipient}`
            : `SUBGIFT x${donation.quantity ?? 1}`; break;
          default:        detail = type;
        }
        const formatted = `[TWITCH] ${username}: ${detail}`;
        try {
          await wh.send({ content: formatted });
          log.debug(`[minecraft-link] Donation forwarded → "${formatted}"`);
        } catch (err) {
          log.error('[minecraft-link] Webhook send error (donation):', err.message);
        }
      }
      return _originalSendDonation(donation);
    };
    log.info('[minecraft-link] Donation forwarding hooked ✅');
  }
}

// ── onChatReady ───────────────────────────────────────────────────────────

function onChatReady(_chatReply) {
  // Register each keyword as its own !<keyword> command so they appear in !commands
  for (const kw of _keywords) {
    commandsList.registerCommand(`!${kw}`, `Minecraft trigger: spawns ${kw}`);
  }
}

// ── processMessage ────────────────────────────────────────────────────────

async function processMessage(msg) {
  if (!_enabled || !_regex || !WEBHOOK_URL) {
    return { message: msg };
  }

  if (!_regex.test(msg.message)) {
    return { message: msg };
  }

  // Exact match ("tnt", "TNT") → suppress from stream chat, it's just a bare command.
  // Fuzzy match ("I summon tnt") → forward AND keep visible in stream chat.
  const isExact   = _exactRegex.test(msg.message);
  const platform  = (msg.platform ?? 'UNKNOWN').toUpperCase();
  const formatted = `[${platform}] ${msg.username}: ${msg.message}`;
  const wh        = getWebhook();

  return {
    message: isExact ? null : msg,
    sideEffect: wh
      ? async () => {
          try {
            await wh.send({ content: formatted });
            log.debug(`[minecraft-link] Forwarded (${isExact ? 'exact' : 'fuzzy'}) → "${formatted}"`);
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
  .setDescription('Manage Minecraft chat trigger forwarding')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show current configuration and keyword list'))
  .addSubcommand(sub =>
    sub.setName('enable')
      .setDescription('Start forwarding matched messages to #plugin-chat'))
  .addSubcommand(sub =>
    sub.setName('disable')
      .setDescription('Stop forwarding (main stream chat is unaffected)'))
  .addSubcommand(sub =>
    sub.setName('set_keywords')
      .setDescription('Replace the entire keyword list')
      .addStringOption(o =>
        o.setName('keywords')
          .setDescription('Comma-separated keywords — e.g.  tnt, creeper, william')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('add_keyword')
      .setDescription('Add a single keyword to the trigger list')
      .addStringOption(o =>
        o.setName('keyword')
          .setDescription('The keyword to add — e.g.  skeleton')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('remove_keyword')
      .setDescription('Remove a single keyword from the trigger list')
      .addStringOption(o =>
        o.setName('keyword')
          .setDescription('The keyword to remove')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('test')
      .setDescription('Check whether a message would be forwarded and which keyword(s) matched')
      .addStringOption(o =>
        o.setName('message')
          .setDescription('The chat message text to test')
          .setRequired(true)));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  // ── status ──────────────────────────────────────────────────────────────
  if (sub === 'status') {
    const kwList = _keywords.size
      ? [..._keywords].sort().map(k => `\`${k}\``).join(', ')
      : '_none — all messages pass through_';
    const lines = [
      `**Status:**   ${_enabled ? '✅ Enabled' : '❌ Disabled'}`,
      `**Webhook:**  ${WEBHOOK_URL ? '✅ Configured' : '⚠️ Missing `DISCORD_MINECRAFT_WEBHOOK_URL`'}`,
      `**Keywords (${_keywords.size}):** ${kwList}`,
      '',
      `Matched messages are **removed** from #stream-chat and forwarded to #plugin-chat as:`,
      `\`\`\`[PLATFORM] Username: <message>\`\`\``,
      `Matching is **case-insensitive** and **fuzzy** (substring) — "omg TNT!!" matches \`tnt\`.`,
      '',
      `All Twitch redeems are **always** forwarded as:`,
      `\`\`\`[TWITCH] username: REDEEM: <redeem name>\`\`\``,
    ];
    return interaction.editReply(lines.join('\n'));
  }

  // ── enable / disable ─────────────────────────────────────────────────────
  if (sub === 'enable') {
    _enabled = true;
    return interaction.editReply('✅ minecraft-link **enabled**.');
  }
  if (sub === 'disable') {
    _enabled = false;
    return interaction.editReply('⏸ minecraft-link **disabled**. All messages flow to main chat only.');
  }

  // ── set_keywords ─────────────────────────────────────────────────────────
  if (sub === 'set_keywords') {
    const raw  = interaction.options.getString('keywords');
    const list = raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (!list.length) {
      return interaction.editReply('❌ No valid keywords found. Provide a comma-separated list, e.g. `tnt, creeper, william`.');
    }

    // Sync commandsList: remove old keyword commands, add new ones
    for (const kw of _keywords) commandsList.removeCommand(`!${kw}`);
    _keywords   = new Set(list);
    _regex      = buildRegex(_keywords);
    _exactRegex = buildExactRegex(_keywords);
    for (const kw of _keywords) commandsList.registerCommand(`!${kw}`, `Minecraft trigger: spawns ${kw}`);

    const display = list.map(k => `\`${k}\``).join(', ');
    return interaction.editReply(`✅ Keywords replaced with: ${display}`);
  }

  // ── add_keyword ───────────────────────────────────────────────────────────
  if (sub === 'add_keyword') {
    const kw = interaction.options.getString('keyword').trim().toLowerCase();
    if (!kw) return interaction.editReply('❌ Keyword cannot be empty.');
    if (_keywords.has(kw)) return interaction.editReply(`ℹ️ \`${kw}\` is already in the list.`);

    _keywords.add(kw);
    _regex      = buildRegex(_keywords);
    _exactRegex = buildExactRegex(_keywords);
    commandsList.registerCommand(`!${kw}`, `Minecraft trigger: spawns ${kw}`);
    return interaction.editReply(`✅ Added \`${kw}\`. Current keywords: ${[..._keywords].sort().map(k => `\`${k}\``).join(', ')}`);
  }

  // ── remove_keyword ────────────────────────────────────────────────────────
  if (sub === 'remove_keyword') {
    const kw = interaction.options.getString('keyword').trim().toLowerCase();
    if (!_keywords.has(kw)) return interaction.editReply(`ℹ️ \`${kw}\` is not in the list.`);

    _keywords.delete(kw);
    _regex      = buildRegex(_keywords);
    _exactRegex = buildExactRegex(_keywords);
    commandsList.removeCommand(`!${kw}`);
    const remaining = _keywords.size
      ? [..._keywords].sort().map(k => `\`${k}\``).join(', ')
      : '_none_';
    return interaction.editReply(`✅ Removed \`${kw}\`. Remaining: ${remaining}`);
  }

  // ── test ──────────────────────────────────────────────────────────────────
  if (sub === 'test') {
    const text    = interaction.options.getString('message');
    const matched = matchedKeywords(text);
    if (!_keywords.size) {
      return interaction.editReply('⚠️ No keywords configured — nothing would ever be forwarded.');
    }
    const isExact = matched.length > 0 && _exactRegex.test(text);
    const lines = [
      `**Message:** \`${text}\``,
      `**Keywords:** ${[..._keywords].sort().map(k => `\`${k}\``).join(', ')}`,
      matched.length
        ? [
            `**Result:** ✅ MATCH on ${matched.map(k => `\`${k}\``).join(', ')}`,
            `**Type:** ${isExact ? '🔇 Exact — suppressed from stream chat' : '💬 Fuzzy — visible in stream chat + forwarded'}`,
            `**Forwarded as:** \`[PLATFORM] SomeUser: ${text}\``,
          ].join('\n')
        : `**Result:** ❌ No match — would not forward`,
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
  init,
  onChatReady,

  // Exposed for testing / other plugins
  matchedKeywords,
  getKeywords: () => new Set(_keywords),
};