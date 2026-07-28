/**
 * twitch-adopt-rewards.js  —  run this ONCE to migrate manually-created
 * channel point rewards into your app's ownership so the bot can
 * enable/disable them via the Twitch API.
 *
 * Background: Twitch only lets a client ID modify rewards it created.
 * Rewards made in the Twitch dashboard belong to Twitch's own client ID
 * and cannot be patched by your app — even with a valid broadcaster token.
 * The fix is to delete the old rewards and recreate them under your client ID.
 *
 * What this script does:
 *  1. Reads .twitch-tokens.json for the broadcaster user token.
 *  2. Fetches ALL current custom rewards for the channel.
 *  3. Shows you the list and asks which ones to adopt.
 *  4. For each chosen reward: reads its full config, deletes the original,
 *     then recreates it identically (same title, cost, prompt, limits, etc.)
 *     under your app's client ID.
 *
 * ⚠️  Redemption history for the old rewards is lost — Twitch does not
 *     migrate queue/history across reward IDs.
 *
 * Required env vars (same as the main app):
 *   TWITCH_CLIENT_ID
 *   TWITCH_CLIENT_SECRET
 *   TWITCH_BROADCASTER_LOGIN
 */

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const CLIENT_ID      = process.env.TWITCH_CLIENT_ID      ?? '';
const CLIENT_SECRET  = process.env.TWITCH_CLIENT_SECRET  ?? '';
const BROADCASTER    = (process.env.TWITCH_BROADCASTER_LOGIN ?? '').trim();
const TOKEN_FILE     = path.resolve('.twitch-tokens.json');
const REWARDS_FILE   = path.resolve('src/plugins/create-reward/rewards.json');

// ── Rewards to auto-select (skips interactive prompt if all are found) ─────
// These match the names used in minecraft-link/index.js MANAGED_REDEEMS.
const AUTO_ADOPT = ['Summon Wither', 'Disable 60s'];

// ── Sanity checks ─────────────────────────────────────────────────────────
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in .env');
  process.exit(1);
}
if (!BROADCASTER) {
  console.error('ERROR: TWITCH_BROADCASTER_LOGIN must be set in .env');
  process.exit(1);
}
if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`ERROR: ${TOKEN_FILE} not found — run node twitch-auth.js first`);
  process.exit(1);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────
async function apiFetch(method, path, userToken, body) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    method,
    headers: {
      'Client-ID':     CLIENT_ID,
      'Authorization': `Bearer ${userToken}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch API ${res.status} ${method} ${path}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getAppToken() {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`App token failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  // Load user token
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    console.error(`ERROR: Could not parse ${TOKEN_FILE}`);
    process.exit(1);
  }
  const userToken = tokens.access_token;

  // Get broadcaster ID
  const appToken = await getAppToken();
  const { default: fetch } = await import('node-fetch');
  const usersRes  = await fetch(`https://api.twitch.tv/helix/users?login=${BROADCASTER}`, {
    headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${appToken}` },
  });
  const usersData    = await usersRes.json();
  const broadcasterId = usersData?.data?.[0]?.id;
  if (!broadcasterId) {
    console.error(`ERROR: Could not resolve broadcaster ID for "${BROADCASTER}"`);
    process.exit(1);
  }

  // Fetch all rewards
  console.log(`\nFetching rewards for ${BROADCASTER} (id: ${broadcasterId})…`);
  const rewardsData = await apiFetch('GET', `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, userToken);
  const rewards = rewardsData?.data ?? [];

  if (!rewards.length) {
    console.log('No custom rewards found on this channel.');
    process.exit(0);
  }

  // Save all rewards to rewards.json
  const rewardsDir = path.dirname(REWARDS_FILE);
  if (!fs.existsSync(rewardsDir)) fs.mkdirSync(rewardsDir, { recursive: true });
  fs.writeFileSync(REWARDS_FILE, JSON.stringify(rewards, null, 2));
  console.log(`\nSaved ${rewards.length} reward(s) to ${REWARDS_FILE}`);

  console.log('\nAll current channel point rewards:');
  rewards.forEach((r, i) => {
    console.log(`  [${i + 1}] ${r.title}  (${r.cost} pts)${r.is_enabled ? '' : '  [disabled]'}`);
  });

  // Determine which to adopt
  let toAdopt = rewards.filter(r => AUTO_ADOPT.includes(r.title));
  const autoFound = toAdopt.map(r => r.title);
  const autoMissing = AUTO_ADOPT.filter(n => !autoFound.includes(n));

  if (autoMissing.length) {
    console.log(`\n⚠️  Could not auto-find: ${autoMissing.join(', ')}`);
    console.log('   Check for typos in AUTO_ADOPT or the reward name on Twitch.\n');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (toAdopt.length && !autoMissing.length) {
    console.log(`\nAuto-selected: ${autoFound.join(', ')}`);
    const answer = await prompt(rl, 'Adopt these rewards? This will DELETE and recreate them. [y/N] ');
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      rl.close();
      process.exit(0);
    }
  } else {
    const answer = await prompt(rl, '\nEnter numbers to adopt (comma-separated), or "all", or press Enter to abort: ');
    if (!answer.trim()) {
      console.log('Aborted.');
      rl.close();
      process.exit(0);
    }
    if (answer.trim().toLowerCase() === 'all') {
      toAdopt = rewards;
    } else {
      const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < rewards.length);
      toAdopt = indices.map(i => rewards[i]);
    }
  }

  rl.close();

  if (!toAdopt.length) {
    console.log('Nothing selected. Aborted.');
    process.exit(0);
  }

  console.log(`\nAdopting ${toAdopt.length} reward(s)…`);

  for (const r of toAdopt) {
    console.log(`\n  → "${r.title}"`);

    // Build the recreate payload — copy all supported fields
    const payload = {
      title:                                r.title,
      cost:                                 r.cost,
      prompt:                               r.prompt || undefined,
      is_enabled:                           r.is_enabled,
      background_color:                     r.background_color || undefined,
      is_user_input_required:               r.is_user_input_required,
      is_max_per_stream_enabled:            r.max_per_stream_setting?.is_enabled ?? false,
      max_per_stream:                       r.max_per_stream_setting?.is_enabled
                                              ? r.max_per_stream_setting.max_per_stream : undefined,
      is_max_per_user_per_stream_enabled:   r.max_per_user_per_stream_setting?.is_enabled ?? false,
      max_per_user_per_stream:              r.max_per_user_per_stream_setting?.is_enabled
                                              ? r.max_per_user_per_stream_setting.max_per_user_per_stream : undefined,
      is_global_cooldown_enabled:           r.global_cooldown_setting?.is_enabled ?? false,
      global_cooldown_seconds:              r.global_cooldown_setting?.is_enabled
                                              ? r.global_cooldown_setting.global_cooldown_seconds : undefined,
      should_redemptions_skip_request_queue: r.should_redemptions_skip_request_queue,
    };

    // Strip undefined fields
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    try {
      // Delete old reward (requires user token, reward must be unqueued)
      await apiFetch('DELETE', `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${r.id}`, userToken);
      console.log(`     Deleted old reward (id: ${r.id})`);
    } catch (err) {
      console.error(`     ERROR deleting "${r.title}": ${err.message}`);
      console.error(`     Skipping recreate to avoid duplicates.`);
      continue;
    }

    try {
      const created = await apiFetch('POST', `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, userToken, payload);
      const newId = created?.data?.[0]?.id;
      console.log(`     Recreated ✅  (new id: ${newId})`);
    } catch (err) {
      console.error(`     ERROR recreating "${r.title}": ${err.message}`);
      console.error(`     ⚠️  The old reward was deleted but the new one was NOT created.`);
      console.error(`     Recreate it manually on Twitch with these settings:`);
      console.error('    ', JSON.stringify(payload, null, 2));
    }
  }

  console.log('\nDone. Restart the bot if it is running.\n');
})();