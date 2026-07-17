'use strict';

// src/plugins/sendchat/index.js
//
// Slash command: /sendchat
//   message   — required string: the text to send
//   platform  — optional choice: 'twitch' | 'youtube' | 'both' (default: both)

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[sendchat] Chat reply handlers registered.');
}

const command = new SlashCommandBuilder()
  .setName('sendchat')
  .setDescription('Send a message to Twitch, YouTube, or both (default: both)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addStringOption(o =>
    o.setName('message')
      .setDescription('The message to send')
      .setRequired(true)
  )
  .addStringOption(o =>
    o.setName('platform')
      .setDescription('Which platform to send to (default: both)')
      .setRequired(false)
      .addChoices(
        { name: 'Twitch',  value: 'twitch'  },
        { name: 'YouTube', value: 'youtube' },
        { name: 'Both',    value: 'both'    },
      )
  );

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const text     = interaction.options.getString('message');
  const platform = interaction.options.getString('platform') ?? 'both';
  const targets  = platform === 'both' ? ['twitch', 'youtube'] : [platform];
  const results  = [];

  for (const target of targets) {
    const send = _chatReply[target];

    if (!send) {
      log.warn(`[sendchat] ${target} send handler not available`);
      results.push(`⚠️ **${target}**: not connected`);
      continue;
    }

    try {
      await send(text);
      log.info(`[sendchat] Sent to ${target}: "${text}"`);
      results.push(`✅ **${target}**: sent`);
    } catch (err) {
      log.error(`[sendchat] Failed on ${target}:`, err.message);
      results.push(`❌ **${target}**: ${err.message}`);
    }
  }

  await interaction.editReply([`📨 *${text}*`, ...results].join('\n'));
}

module.exports = {
  id: 'sendchat',
  onChatReady,
  command,
  handleInteraction,

  async processMessage(msg) {
    return { message: msg };
  },
};