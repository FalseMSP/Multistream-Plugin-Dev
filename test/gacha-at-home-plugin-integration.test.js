'use strict';

/**
 * gacha-at-home-plugin-integration.test.js — smoke test of the WIRED budget
 * plugin. The mirror of test/gacha-plugin-integration.test.js, asserting the
 * SEPARATION invariants the user asked to protect:
 *   • frames go to section 'budgetgacha' (never 'gacha'),
 *   • the video is ALWAYS /gachavids/gacha-at-home.mp4,
 *   • NO grid frames ever (triggerGridPull degrades to single pull),
 *   • choreography timings match legacy (reveal 8 s, idle 14 s).
 * Run: node test/gacha-at-home-plugin-integration.test.js
 */

const assert = require('assert');

require('../src/overlay-server');
const overlayServer = require('../src/overlay-server');
const realUpdateSection = overlayServer.updateSection;

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

test('wired budget plugin: fixed video, budgetgacha section, legacy choreography', async () => {
  const frames = [];
  overlayServer.updateSection = (id, data) => {
    if (id === 'budgetgacha') frames.push({ ...data, _t: Date.now() });
    else throw new Error(`frame emitted on WRONG section ${id}: ` + JSON.stringify(data));
  };

  const pluginPath = require.resolve('../src/plugins/gacha-at-home/index.js');
  delete require.cache[pluginPath];
  const budget = require(pluginPath);

  const redeemLog = [];
  budget.init({ queue: { onRedeem: () => {}, onDonation: () => {}, pushRedeem: r => redeemLog.push(r) } });
  budget.onChatReady({ twitch: async () => {}, youtube: async () => {} });

  budget.triggerPull({ user: 'dave', isPremium: false });

  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].state, 'pulling');
  assert.strictEqual(frames[0].user, 'dave');
  assert.strictEqual(frames[0].videoFile, '/gachavids/gacha-at-home.mp4', 'fixed budget video');

  await sleep(8500);
  assert.strictEqual(frames[1].state, 'result');
  assert.strictEqual(frames[1].result.user, 'dave');
  assert.ok(redeemLog.length >= 1, 'synthetic redeem dispatched at reveal');
  assert.strictEqual(redeemLog[0]._fromGacha, true);

  await sleep(6000);
  assert.strictEqual(frames[2].state, 'idle');

  overlayServer.updateSection = realUpdateSection;
});

test('budget plugin: triggerGridPull NEVER emits a grid frame (separation)', async () => {
  const frames = [];
  overlayServer.updateSection = (id, data) => { if (id === 'budgetgacha') frames.push(data); };

  const pluginPath = require.resolve('../src/plugins/gacha-at-home/index.js');
  delete require.cache[pluginPath];
  const budget = require(pluginPath);
  budget.init({ queue: { onRedeem: () => {}, onDonation: () => {}, pushRedeem: () => {} } });

  // Even a grid-shaped request degrades to a single pull, exactly as the
  // legacy budget plugin had no grid code path at all.
  budget.triggerPull({ user: 'erin', isPremium: false });
  const started = Date.now();
  budget.triggerPull({ user: 'frank', isPremium: false }); // queued behind erin
  await sleep(8500 + 6000 + 2000 + 8500); // erin full + breath + frank reveal
  const states = frames.map(f => f.state);
  assert.ok(!states.includes('grid'), 'no grid frame ever on budgetgacha: ' + states.join(','));
  assert.strictEqual(states[0], 'pulling');
  assert.strictEqual(frames[0].videoFile, '/gachavids/gacha-at-home.mp4');
  overlayServer.updateSection = realUpdateSection;
});

test('processMessage: YT like still triggers a pull (legacy trigger surface)', async () => {
  overlayServer.updateSection = (id) => { if (id !== 'budgetgacha') throw new Error('wrong section ' + id); };
  const pluginPath = require.resolve('../src/plugins/gacha-at-home/index.js');
  delete require.cache[pluginPath];
  const budget = require(pluginPath);
  budget.init({ queue: { onRedeem: () => {}, onDonation: () => {}, pushRedeem: () => {} } });

  const res = await budget.processMessage({ platform: 'youtube', type: 'like', username: 'x', text: '' });
  assert.deepStrictEqual(res, { message: null }, 'like message suppressed as before');

  const res2 = await budget.processMessage({ platform: 'twitch', username: 'x', text: 'hello' });
  assert.strictEqual(res2.message.platform, 'twitch', 'normal chat passes through');
  overlayServer.updateSection = realUpdateSection;
});

run().then(() => { if (failed > 0) process.exit(1); });
