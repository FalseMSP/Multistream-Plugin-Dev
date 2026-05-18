'use strict';

/**
 * Plugin: create-reward
 * ─────────────────────
 * On startup, reads src/plugins/create-reward/rewards.json and ensures every
 * reward defined there exists on the channel under the bot's client ID.
 * Rewards already present (matched by title) are skipped. Missing ones are
 * created via the Twitch API using the broadcaster's user OAuth token.
 *
 * Slash command: /reward
 *   list                          — show all rewards in rewards.json and their
 *                                   live status (exists on Twitch / missing)
 *   add                           — create a new reward interactively and save
 *                                   it to rewards.json
 *   remove <title>                — delete a reward from Twitch and rewards.json
 *   sync                          — re-run startup sync (create any missing)
 *
 * rewards.json schema (array of reward objects):
 *   Each entry is a Twitch custom reward creation payload. Required fields:
 *     title   {string}   — display name (must be unique on the channel)
 *     cost    {number}   — channel point cost
 *   Optional fields (all Twitch API defaults apply when omitted):
 *     prompt                              {string}
 *     is_enabled                          {boolean}  default: true
 *     background_color                    {string}   hex e.g. "#9147FF"
 *     is_user_input_required              {boolean}
 *     is_max_per_stream_enabled           {boolean}
 *     max_per_stream                      {number}
 *     is_max_per_user_per_stream_enabled  {boolean}
 *     max_per_user_per_stream             {number}
 *     is_global_cooldown_enabled          {boolean}
 *     global_cooldown_seconds             {number}
 *     should_redemptions_skip_request_queue {boolean}
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const log  = require('../../logger');
const { helixUserRequest, getBroadcasterId } = require('../../twitch');

// ── Config ────────────────────────────────────────────────────────────────

const REWARDS_FILE = path.resolve('src/plugins/create-reward/rewards.json');

// ── Helpers ───────────────────────────────────────────────────────────────

/** Load rewards.json, returning [] if missing or unparseable. */
function loadRewardsFile() {
  try {
    if (!fs.existsSync(REWARDS_FILE)) return [];
    return JSON.parse(fs.readFileSync(REWARDS_FILE, 'utf8'));
  } catch (err) {
    log.error('[create-reward] Failed to read rewards.json:', err.message);
    return [];
  }
}

/** Persist the rewards array to rewards.json. */
function saveRewardsFile(rewards) {
  const dir = path.dirname(REWARDS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(REWARDS_FILE, JSON.stringify(rewards, null, 2));
}

/** Fetch all live custom rewards for the channel (all, not just bot-owned). */
async function fetchLiveRewards(broadcasterId) {
  const data = await helixUserRequest('GET', `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`);
  return data?.data ?? [];
}

/** Create a single reward on Twitch. Returns the created reward object. */
async function createReward(broadcasterId, payload) {
  const clean = { ...payload };
  Object.keys(clean).forEach(k => clean[k] === undefined && delete clean[k]);
  const data = await helixUserRequest(
    'POST',
    `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`,
    clean
  );
  return data?.data?.[0] ?? null;
}

/** Delete a reward from Twitch by ID. */
async function deleteReward(broadcasterId, rewardId) {
  await helixUserRequest('DELETE', `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`);
}

// ── Startup sync ──────────────────────────────────────────────────────────

/**
 * For each entry in rewards.json, create it on Twitch if no live reward with
 * that title already exists. Returns a summary { created, skipped, failed }.
 */
async function syncRewards() {
  const defined = loadRewardsFile();
  if (!defined.length) {
    log.info('[create-reward] rewards.json is empty or missing — nothing to sync.');
    return { created: [], skipped: [], failed: [] };
  }

  let broadcasterId;
  try {
    broadcasterId = await getBroadcasterId();
    if (!broadcasterId) throw new Error('getBroadcasterId() returned null');
  } catch (err) {
    log.error('[create-reward] Could not resolve broadcaster ID:', err.message);
    return { created: [], skipped: [], failed: defined.map(r => r.title) };
  }

  let liveRewards;
  try {
    liveRewards = await fetchLiveRewards(broadcasterId);
  } catch (err) {
    log.error('[create-reward] Could not fetch live rewards:', err.message);
    return { created: [], skipped: [], failed: defined.map(r => r.title) };
  }

  const liveTitles = new Set(liveRewards.map(r => r.title));
  const created = [], skipped = [], failed = [];

  for (const reward of defined) {
    if (liveTitles.has(reward.title)) {
      log.debug(`[create-reward] Reward already exists, skipping: "${reward.title}"`);
      skipped.push(reward.title);
      continue;
    }
    try {
      await createReward(broadcasterId, reward);
      log.info(`[create-reward] Created reward: "${reward.title}"`);
      created.push(reward.title);
    } catch (err) {
      log.error(`[create-reward] Failed to create "${reward.title}":`, err.message);
      failed.push(reward.title);
    }
  }

  return { created, skipped, failed };
}

// ── init ──────────────────────────────────────────────────────────────────

async function init() {
  log.info('[create-reward] Running startup sync…');
  const { created, skipped, failed } = await syncRewards();
  if (created.length) log.info(`[create-reward] Created: ${created.join(', ')}`);
  if (skipped.length) log.info(`[create-reward] Already existed: ${skipped.join(', ')}`);
  if (failed.length)  log.warn(`[create-reward] Failed: ${failed.join(', ')}`);
}

// ── Slash command ─────────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('reward')
  .setDescription('Manage Twitch channel point rewards')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)

  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('List all rewards in rewards.json and their live status on Twitch'))

  .addSubcommand(sub =>
    sub.setName('sync')
      .setDescription('Create any rewards in rewards.json that are missing from Twitch'))

  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Create a new channel point reward and save it to rewards.json')
      .addStringOption(o =>
        o.setName('title')
          .setDescription('Reward display name (must be unique)')
          .setRequired(true))
      .addIntegerOption(o =>
        o.setName('cost')
          .setDescription('Channel point cost')
          .setRequired(true)
          .setMinValue(1))
      .addStringOption(o =>
        o.setName('prompt')
          .setDescription('Viewer-facing description shown in the reward panel'))
      .addBooleanOption(o =>
        o.setName('user_input')
          .setDescription('Require the viewer to enter text when redeeming'))
      .addBooleanOption(o =>
        o.setName('skip_queue')
          .setDescription('Auto-fulfill redemptions (skip the redemption queue)'))
      .addIntegerOption(o =>
        o.setName('cooldown')
          .setDescription('Global cooldown in seconds between redeems')
          .setMinValue(1))
      .addIntegerOption(o =>
        o.setName('max_per_stream')
          .setDescription('Maximum redemptions per stream')
          .setMinValue(1))
      .addIntegerOption(o =>
        o.setName('max_per_user')
          .setDescription('Maximum redemptions per viewer per stream')
          .setMinValue(1))
      .addStringOption(o =>
        o.setName('color')
          .setDescription('Background colour as a hex code, e.g. #9147FF')))

  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Delete a reward from Twitch and remove it from rewards.json')
      .addStringOption(o =>
        o.setName('title')
          .setDescription('Exact title of the reward to remove')
          .setRequired(true)));

// ── handleInteraction ─────────────────────────────────────────────────────

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  // ── list ────────────────────────────────────────────────────────────────
  if (sub === 'list') {
    const defined = loadRewardsFile();
    if (!defined.length) {
      return interaction.editReply('⚠️ `rewards.json` is empty or not found. Run `/reward add` or `node twitch_adopt_rewards.js` first.');
    }

    let liveRewards = [];
    try {
      const broadcasterId = await getBroadcasterId();
      if (broadcasterId) liveRewards = await fetchLiveRewards(broadcasterId);
    } catch {
      // Best-effort — show defined list without live status
    }
    const liveTitles = new Set(liveRewards.map(r => r.title));

    const lines = [
      `**Rewards in \`rewards.json\` (${defined.length}):**`,
      ...defined.map(r => {
        const live = liveTitles.has(r.title) ? '✅ live' : '❌ missing from Twitch';
        const enabled = r.is_enabled === false ? ' *(disabled)*' : '';
        return `• **${r.title}** — ${r.cost} pts${enabled} — ${live}`;
      }),
    ];
    return interaction.editReply(lines.join('\n'));
  }

  // ── sync ─────────────────────────────────────────────────────────────────
  if (sub === 'sync') {
    const { created, skipped, failed } = await syncRewards();
    const lines = ['**Sync complete:**'];
    if (created.length) lines.push(`✅ Created: ${created.map(t => `\`${t}\``).join(', ')}`);
    if (skipped.length) lines.push(`⏭ Already existed: ${skipped.map(t => `\`${t}\``).join(', ')}`);
    if (failed.length)  lines.push(`❌ Failed: ${failed.map(t => `\`${t}\``).join(', ')}`);
    if (!created.length && !failed.length) lines.push('Nothing to do — all rewards already exist.');
    return interaction.editReply(lines.join('\n'));
  }

  // ── add ──────────────────────────────────────────────────────────────────
  if (sub === 'add') {
    const title    = interaction.options.getString('title').trim();
    const cost     = interaction.options.getInteger('cost');
    const prompt   = interaction.options.getString('prompt') ?? undefined;
    const input    = interaction.options.getBoolean('user_input') ?? undefined;
    const skip     = interaction.options.getBoolean('skip_queue') ?? undefined;
    const cooldown = interaction.options.getInteger('cooldown') ?? undefined;
    const maxStream = interaction.options.getInteger('max_per_stream') ?? undefined;
    const maxUser  = interaction.options.getInteger('max_per_user') ?? undefined;
    const color    = interaction.options.getString('color') ?? undefined;

    if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return interaction.editReply('❌ Invalid colour format. Use a 6-digit hex code like `#9147FF`.');
    }

    const payload = {
      title,
      cost,
      ...(prompt    !== undefined && { prompt }),
      ...(input     !== undefined && { is_user_input_required: input }),
      ...(skip      !== undefined && { should_redemptions_skip_request_queue: skip }),
      ...(color     !== undefined && { background_color: color }),
      ...(cooldown  !== undefined && { is_global_cooldown_enabled: true, global_cooldown_seconds: cooldown }),
      ...(maxStream !== undefined && { is_max_per_stream_enabled: true, max_per_stream: maxStream }),
      ...(maxUser   !== undefined && { is_max_per_user_per_stream_enabled: true, max_per_user_per_stream: maxUser }),
    };

    // Check for duplicate title in rewards.json
    const defined = loadRewardsFile();
    if (defined.some(r => r.title === title)) {
      return interaction.editReply(`❌ A reward named \`${title}\` already exists in \`rewards.json\`. Remove it first if you want to recreate it.`);
    }

    let created;
    try {
      const broadcasterId = await getBroadcasterId();
      if (!broadcasterId) throw new Error('Could not resolve broadcaster ID');
      created = await createReward(broadcasterId, payload);
    } catch (err) {
      log.error('[create-reward] /reward add failed:', err.message);
      return interaction.editReply(`❌ Twitch API error: ${err.message}`);
    }

    // Save to rewards.json
    defined.push(payload);
    saveRewardsFile(defined);
    log.info(`[create-reward] Added reward via slash command: "${title}"`);

    const details = [
      `✅ Reward **${title}** created (id: \`${created?.id ?? 'unknown'}\`)`,
      `**Cost:** ${cost} pts`,
      prompt   ? `**Prompt:** ${prompt}` : null,
      cooldown ? `**Cooldown:** ${cooldown}s` : null,
      maxStream ? `**Max/stream:** ${maxStream}` : null,
      maxUser   ? `**Max/user/stream:** ${maxUser}` : null,
      `Saved to \`rewards.json\`.`,
    ].filter(Boolean);
    return interaction.editReply(details.join('\n'));
  }

  // ── remove ────────────────────────────────────────────────────────────────
  if (sub === 'remove') {
    const title = interaction.options.getString('title').trim();

    let broadcasterId, liveRewards;
    try {
      broadcasterId = await getBroadcasterId();
      if (!broadcasterId) throw new Error('Could not resolve broadcaster ID');
      liveRewards = await fetchLiveRewards(broadcasterId);
    } catch (err) {
      return interaction.editReply(`❌ Could not fetch live rewards: ${err.message}`);
    }

    const live = liveRewards.find(r => r.title === title);
    const defined = loadRewardsFile();
    const inFile  = defined.some(r => r.title === title);

    if (!live && !inFile) {
      return interaction.editReply(`⚠️ No reward named \`${title}\` found on Twitch or in \`rewards.json\`.`);
    }

    const results = [];

    if (live) {
      try {
        await deleteReward(broadcasterId, live.id);
        results.push(`✅ Deleted from Twitch (id: \`${live.id}\`)`);
        log.info(`[create-reward] Deleted reward from Twitch: "${title}"`);
      } catch (err) {
        results.push(`❌ Could not delete from Twitch: ${err.message}`);
        log.error(`[create-reward] Failed to delete "${title}" from Twitch:`, err.message);
      }
    } else {
      results.push('⚠️ Not found on Twitch (may have been deleted manually)');
    }

    if (inFile) {
      const updated = defined.filter(r => r.title !== title);
      saveRewardsFile(updated);
      results.push('✅ Removed from `rewards.json`');
    } else {
      results.push('⚠️ Was not in `rewards.json`');
    }

    return interaction.editReply(results.join('\n'));
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'create-reward',
  command,
  handleInteraction,
  init,
};