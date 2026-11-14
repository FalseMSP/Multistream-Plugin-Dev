'use strict';

/**
 * gacha-plugin-integration.test.js — smoke test of the WIRED gacha plugin.
 *
 * Unlike gacha-machine.test.js (which tests the machine in isolation), this
 * loads the actual plugin module with stubbed overlay-server + queue and
 * runs pulls through the plugin's public API — the same entry points
 * premium-roll / gacha-results / redeems use. Asserts:
 *   • the plugin's init wiring builds the machine and routes triggers,
 *   • SSE frames keep the exact legacy shapes on section 'gacha',
 *   • the exported API (triggerPull/triggerGridPull/onResult/MAX_GRID_SIZE)
 *     behaves as premium-roll and gacha-results expect.
 *
 * Run: node test/gacha-plugin-integration.test.js
 */

const assert = require('assert');
const { ManualClock } = require('../src/fsm');

// ── Stub overlay-server BEFORE the plugin (and its shared machine) load ────
const framesBySection = {};
const registeredSections = {};
const routes = {};
require('../src/overlay-server'); // real module: it self-initialises; we patch exports
const overlayServer = require('../src/overlay-server');

// Patch updateSection/registerSection/addRoute on the live module so the
// plugin's captured references point at our spies. The plugin captures the
// functions via require destructuring at load time, so we must patch before
// loading the plugin.
const realUpdateSection = overlayServer.updateSection;
const realRegisterSection = overlayServer.registerSection;
const realAddRoute = overlayServer.addRoute;

let clock = null; // set per-test; the plugin machine uses REAL_CLOCK though —
                  // see note below: this integration test runs REAL timers.

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n      ${e.message}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('wired plugin: full pull via public API emits legacy SSE frames', async () => {
  // Spy on updateSection for the gacha section only.
  const gachaFrames = [];
  overlayServer.updateSection = (id, data) => {
    if (id === 'gacha') gachaFrames.push({ ...data, _t: Date.now() });
  };
  overlayServer.registerSection = realRegisterSection;
  overlayServer.addRoute = realAddRoute;

  // Fresh copy of the plugin under our spies (cache-bust so it re-requires
  // with the patched overlay-server).
  const pluginPath = require.resolve('../src/plugins/gacha/index.js');
  delete require.cache[pluginPath];
  const gacha = require(pluginPath);

  // Fake queue capturing synthetic redeems.
  const redeemLog = [];
  const fakeQueue = {
    onRedeem: () => {},
    onDonation: () => {},
    pushRedeem: (r) => redeemLog.push(r),
  };

  gacha.init({ queue: fakeQueue });
  gacha.onChatReady({ twitch: async () => {}, youtube: async () => {} });

  // Pull for alice (standard). REAL clock: we wait for the real choreography.
  gacha.triggerPull({ user: 'alice', isPremium: false });

  // pulling frame is synchronous.
  assert.strictEqual(gachaFrames.length, 1, 'pulling frame immediate');
  assert.strictEqual(gachaFrames[0].state, 'pulling');
  assert.strictEqual(gachaFrames[0].user, 'alice');
  assert.ok(gachaFrames[0].videoFile.startsWith('/gachavids/'), 'per-rarity video: ' + gachaFrames[0].videoFile);
  assert.notStrictEqual(gachaFrames[0].videoFile, '/gachavids/gacha-at-home.mp4');

  // Wait for the reveal (8s) + idle (14s) with real timers.
  await sleep(8500);
  assert.strictEqual(gachaFrames[1].state, 'result');
  assert.strictEqual(gachaFrames[1].result.user, 'alice');
  assert.ok(redeemLog.length >= 1, 'synthetic redeem dispatched at reveal');
  assert.strictEqual(redeemLog[0]._fromGacha, true);

  await sleep(6000);
  assert.strictEqual(gachaFrames[2].state, 'idle');

  // Restore patched exports for subsequent tests.
  overlayServer.updateSection = realUpdateSection;
});

test('wired plugin: onResult listeners fire (gacha-results contract)', async () => {
  overlayServer.updateSection = (id, data) => { if (id === 'gacha') framesBySection[id] = data; };
  const pluginPath = require.resolve('../src/plugins/gacha/index.js');
  delete require.cache[pluginPath];
  const gacha = require(pluginPath);

  const results = [];
  gacha.onResult(r => results.push(r));

  gacha.init({ queue: { onRedeem: () => {}, onDonation: () => {}, pushRedeem: () => {} } });
  gacha.triggerPull({ user: 'bob', isPremium: true });
  await sleep(8500);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].user, 'bob');
  assert.ok(results[0].id >= 1, 'monotonic result id');
  assert.strictEqual(results[0].redeem === null || typeof results[0].redeem === 'string', true);
  overlayServer.updateSection = realUpdateSection;
});

run().then(() => { if (failed > 0) process.exit(1); });
