'use strict';

/**
 * gacha-machine.test.js — no-regression harness for the shared pull machine.
 * ───────────────────────────────────────────────────────────────────────────
 * Strategy: assert that the SSE frames the machine emits, their ORDER, and
 * their TIMING are exactly what the LEGACY plugins emitted, per variant.
 * The two variants must remain behaviorally distinct (separate URLs,
 * section ids, videos, grid mode) — these tests pin that separation.
 *
 * Run: node test/gacha-machine.test.js   (exit 0 = all pass)
 */

const assert = require('assert');
const { ManualClock } = require('../src/fsm');
const { createGachaMachine, REVEAL_MS, IDLE_MS, BETWEEN_MS } = require('../src/plugins/gacha-shared/pull-machine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n      ${e.message}`); }
}

// ── Fixtures: the two variants' descriptors, mirroring each plugin's config ─

// Deterministic RNG: always 0.0 → rolls pick the FIRST entry with weight > 0.
const FIRST = () => 0.0;
// RNG that walks the weight axis → second pool entry.
function makeRng(fraction) {
  let used = false;
  return () => { if (!used) { used = true; return fraction; } return 0.0; };
}

const GACHA_TABLE = [
  { id: 'play-gd-level', label: 'Play your GD Level', rarity: 'common', icon: 'play-gd-level', odds: 10, premiumOdds: 2, redeem: 'Play your GD Level' },
  { id: 'read-your-name', label: 'Read your name', rarity: 'common', icon: 'read-your-name', odds: 10, premiumOdds: 0, redeem: 'Read your name' },
  { id: 'dud', label: 'Dud', rarity: 'dud', icon: null, odds: 15.88, premiumOdds: 1.99, redeem: 'Dud' },
];

const BUDGET_TABLE = [
  { id: 'read-your-name', label: 'Read your name', rarity: 'common', icon: 'read-your-name', odds: 10, premiumOdds: 0, redeem: 'Read your name' },
  { id: 'vine-boom', label: 'Vine Boom', rarity: 'common', icon: 'vine-boom', odds: 5, premiumOdds: 4, redeem: 'Vine Boom' },
  { id: 'dud', label: 'Dud', rarity: 'dud', icon: null, odds: 0, premiumOdds: 0, redeem: 'Dud' },
];

function makeHarness(variant, opts = {}) {
  const clock = new ManualClock();
  const frames = [];     // SSE frames in emit order
  const redeems = [];    // synthetic redeems dispatched to the queue
  const results = [];    // emitted pull results
  let resultId = 0;

  const cfg = {
    sectionId: variant === 'gacha' ? 'gacha' : 'budgetgacha',
    lootTable: variant === 'gacha' ? GACHA_TABLE : BUDGET_TABLE,
    rng: opts.rng ?? FIRST,
    clock,
    emit: frame => frames.push({ ...frame, at: clock.now() }),
    dispatchRedeem: r => redeems.push({ ...r, at: clock.now() }),
    results: { emit: r => results.push({ ...r, at: clock.now() }), nextId: () => ++resultId },
    onLog: () => {},
    // VARIANT ANIMATION POLICY — the core of the separation:
    videoFor: variant === 'gacha'
      ? (item, rng) => item.rarity === 'dud'
        ? `/gachavids/dud${Math.floor(rng() * 2) + 1}.mp4`
        : `/gachavids/${item.rarity}.mp4`
      : () => '/gachavids/gacha-at-home.mp4',
    dudCount: variant === 'gacha' ? 2 : 0,
    grid: variant === 'gacha' ? { enabled: true, maxGridSize: 25 } : { enabled: false },
  };

  const m = createGachaMachine(cfg);
  return { clock, frames, redeems, results, m, cfg };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── gacha variant (route /gacha, section "gacha", per-rarity videos) ──');
// ═══════════════════════════════════════════════════════════════════════════

test('single pull: exact legacy frame sequence pulling→result→idle', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  h.clock.advance(IDLE_MS); // play the whole choreography to the clock's end
  assert.deepStrictEqual(h.frames.map(f => f.state), ['pulling', 'result', 'idle']);
  assert.strictEqual(h.frames[0].user, 'alice');
  assert.strictEqual(h.frames[1].result.user, 'alice');
});

test('single pull: legacy timing — reveal at 8000ms, idle at 14000ms', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  assert.strictEqual(h.frames[0].at, 0, 'pulling frame is immediate');
  h.clock.advance(REVEAL_MS);
  assert.strictEqual(h.frames[1].at, REVEAL_MS, 'result frame at reveal');
  h.clock.advance(IDLE_MS - REVEAL_MS);
  assert.strictEqual(h.frames[2].at, IDLE_MS, 'idle frame at 14s');
});

test('gacha video policy: per-rarity video path, not the budget fixed video', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  assert.strictEqual(h.frames[0].videoFile, '/gachavids/common.mp4');
  assert.notStrictEqual(h.frames[0].videoFile, '/gachavids/gacha-at-home.mp4');
});

test('gacha icon path: /gachaicons/<icon>/icon.png, null for duds', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  assert.strictEqual(h.frames[0].iconPath, '/gachaicons/play-gd-level/icon.png');
});

test('pulling frame carries the legacy field set verbatim', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  const f = h.frames[0];
  const expected = { state: 'pulling', user: 'alice', videoFile: '/gachavids/common.mp4',
    iconPath: '/gachaicons/play-gd-level/icon.png', rarity: 'common',
    label: 'Play your GD Level', isDud: false };
  assert.deepStrictEqual(
    { state: f.state, user: f.user, videoFile: f.videoFile, iconPath: f.iconPath,
      rarity: f.rarity, label: f.label, isDud: f.isDud },
    expected);
});

test('synthetic redeem fires at reveal time with legacy shape', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  h.clock.advance(REVEAL_MS);
  assert.strictEqual(h.redeems.length, 1);
  const r = h.redeems[0];
  assert.strictEqual(r.username, 'alice');
  assert.strictEqual(r.title, 'Play your GD Level');
  assert.strictEqual(r.cost, 0);
  assert.strictEqual(r.input, null);
  assert.strictEqual(r._fromGacha, true);
  assert.ok(r.timestamp instanceof Date);
  assert.strictEqual(r.at, REVEAL_MS, 'redeem dispatched exactly at reveal');
});

test('result event fires at reveal time with legacy shape', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  h.clock.advance(REVEAL_MS);
  assert.strictEqual(h.results.length, 1);
  const r = h.results[0];
  assert.strictEqual(r.user, 'alice');
  assert.strictEqual(r.label, 'Play your GD Level');
  assert.strictEqual(r.rarity, 'common');
  assert.strictEqual(r.isDud, false);
  assert.strictEqual(r.redeem, 'Play your GD Level');
  assert.strictEqual(r.id, 1);
  assert.ok(r.timestamp instanceof Date);
});

test('queued pull starts after the 1500ms breath (legacy gap)', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  h.m.triggerPull({ user: 'bob', isPremium: false });   // queued
  assert.strictEqual(h.m.queueLength(), 1);
  h.clock.advance(IDLE_MS);                              // first pull completes
  h.clock.advance(BETWEEN_MS);                           // breath → bob starts
  // bob's pulling frame is out; advance through his full choreography.
  h.clock.advance(IDLE_MS);
  assert.deepStrictEqual(h.frames.map(f => f.state),
    ['pulling', 'result', 'idle', 'pulling', 'result', 'idle']);
  assert.strictEqual(h.frames[3].user, 'bob');
  assert.strictEqual(h.frames[3].at, IDLE_MS + BETWEEN_MS, 'bob starts exactly at 15.5s');
});

test('queue depth preserved while a pull is active (legacy queueing)', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  h.m.triggerPull({ user: 'bob', isPremium: false });
  h.m.triggerPull({ user: 'carol', isPremium: false });
  assert.strictEqual(h.m.queueLength(), 2);
});

test('grid pull: grid frame with per-item fields, then idle (gacha only)', () => {
  const h = makeHarness('gacha');
  h.m.triggerGridPull({ user: 'alice', count: 3, isPremium: true });
  h.clock.advance(IDLE_MS);
  assert.deepStrictEqual(h.frames.map(f => f.state), ['grid', 'idle']);
  assert.strictEqual(h.frames[0].user, 'alice');
  assert.strictEqual(h.frames[0].items.length, 3);
  for (const item of h.frames[0].items) {
    assert.ok('videoFile' in item && 'iconPath' in item && 'rarity' in item &&
      'label' in item && 'isDud' in item && 'redeem' in item && 'user' in item);
  }
});

test('grid pull: reveals at 8s, per-item redeems+results fire at reveal', () => {
  const h = makeHarness('gacha');
  h.m.triggerGridPull({ user: 'alice', count: 3, isPremium: true });
  h.clock.advance(REVEAL_MS);
  assert.strictEqual(h.results.length, 3, 'one result per grid item');
  assert.strictEqual(h.redeems.length, 3, 'one redeem per grid item');
  // Grid frames are also emitted on the gacha SSE contract at 0ms.
  assert.strictEqual(h.frames[0].at, 0);
});

test('grid pull: count>25 splits into batches of 25 (legacy MAX_GRID_SIZE)', () => {
  const h = makeHarness('gacha');
  h.m.triggerGridPull({ user: 'alice', count: 50, isPremium: false });
  // First batch plays immediately; second is queued.
  assert.strictEqual(h.frames.filter(f => f.state === 'grid').length, 1);
  assert.strictEqual(h.m.queueLength(), 1, 'second 25-cell batch queued');
});

test('grid pull with per-item users attributes each cell (gifted-sub batching)', () => {
  const h = makeHarness('gacha');
  h.m.triggerGridPull({ user: 'gifter', users: ['u1', 'u2', 'u3'], isPremium: true });
  assert.strictEqual(h.frames[0].user, '3 viewers', 'multi-user header');
  const users = h.frames[0].items.map(i => i.user);
  assert.deepStrictEqual(users, ['u1', 'u2', 'u3']);
});

test('grid pull: single-user header shows that user (legacy headerUser)', () => {
  const h = makeHarness('gacha');
  h.m.triggerGridPull({ user: 'alice', users: ['alice', 'alice'], isPremium: false });
  assert.strictEqual(h.frames[0].user, 'alice');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── budgetgacha variant (route /budgetgacha, fixed video, no grid) ──');
// ═══════════════════════════════════════════════════════════════════════════

test('single pull: legacy frame sequence pulling→result→idle (same choreography)', () => {
  const h = makeHarness('budget');
  h.m.triggerPull({ user: 'dave', isPremium: false });
  h.clock.advance(IDLE_MS);
  assert.deepStrictEqual(h.frames.map(f => f.state), ['pulling', 'result', 'idle']);
});

test('budget video policy: ALWAYS the fixed gacha-at-home.mp4 regardless of rarity', () => {
  const h = makeHarness('budget');
  h.m.triggerPull({ user: 'dave', isPremium: false });
  assert.strictEqual(h.frames[0].videoFile, '/gachavids/gacha-at-home.mp4');
  // Even for a different rolled item, still the same video.
  const h2 = makeHarness('budget', { rng: makeRng(0.99) });
  h2.m.triggerPull({ user: 'dave', isPremium: false });
  assert.strictEqual(h2.frames[0].videoFile, '/gachavids/gacha-at-home.mp4');
});

test('budget timing: identical reveal/idle choreography (8s/14s/1.5s)', () => {
  const h = makeHarness('budget');
  h.m.triggerPull({ user: 'dave', isPremium: false });
  h.clock.advance(REVEAL_MS);
  assert.strictEqual(h.frames[1].at, REVEAL_MS);
  h.clock.advance(IDLE_MS - REVEAL_MS);
  assert.strictEqual(h.frames[2].at, IDLE_MS);
});

test('budget synthetic redeem + result still fire at reveal (legacy parity)', () => {
  const h = makeHarness('budget');
  h.m.triggerPull({ user: 'dave', isPremium: false });
  h.clock.advance(REVEAL_MS);
  assert.strictEqual(h.redeems.length, 1);
  assert.strictEqual(h.redeems[0].username, 'dave');
  assert.strictEqual(h.results.length, 1);
});

test('budget grid pull is a NO-OP by design: degrades to single pull', () => {
  const h = makeHarness('budget');
  // Even if something calls triggerGridPull (e.g. a future wiring bug), the
  // budget overlay never receives a grid frame — pins the separation.
  h.m.triggerGridPull({ user: 'dave', count: 5, isPremium: false });
  h.clock.advance(IDLE_MS);
  assert.deepStrictEqual(h.frames.map(f => f.state), ['pulling', 'result', 'idle'],
    'no grid frame ever emitted on the budgetgacha section');
});

test('budget queued pulls drain with the 1.5s breath', () => {
  const h = makeHarness('budget');
  h.m.triggerPull({ user: 'dave', isPremium: false });
  h.m.triggerPull({ user: 'erin', isPremium: false });
  h.clock.advance(IDLE_MS + BETWEEN_MS); // dave done + breath → erin starts
  h.clock.advance(IDLE_MS);              // erin completes
  assert.deepStrictEqual(h.frames.map(f => f.state),
    ['pulling', 'result', 'idle', 'pulling', 'result', 'idle']);
  assert.strictEqual(h.frames[3].user, 'erin');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── separation invariants (the user\'s regression concern) ──');
// ═══════════════════════════════════════════════════════════════════════════

test('the two variants emit on DIFFERENT section ids (gacha vs budgetgacha)', () => {
  // Enforced by construction: the section id is the machine name and the
  // emit sink key. Here we verify a mixed setup keeps frames distinct.
  const clock = new ManualClock();
  const gFrames = [], bFrames = [];
  const g = createGachaMachine({
    sectionId: 'gacha', lootTable: GACHA_TABLE, rng: FIRST, clock,
    emit: f => gFrames.push(f),
    dispatchRedeem: () => {},
    videoFor: (item) => item.rarity === 'dud' ? '/gachavids/dud1.mp4' : `/gachavids/${item.rarity}.mp4`,
    grid: { enabled: true },
  });
  const b = createGachaMachine({
    sectionId: 'budgetgacha', lootTable: BUDGET_TABLE, rng: FIRST, clock,
    emit: f => bFrames.push(f),
    dispatchRedeem: () => {},
    videoFor: () => '/gachavids/gacha-at-home.mp4',
    grid: { enabled: false },
  });
  g.triggerPull({ user: 'alice', isPremium: false });
  b.triggerPull({ user: 'dave', isPremium: false });
  clock.advance(IDLE_MS);
  assert.strictEqual(gFrames.length, 3);
  assert.strictEqual(bFrames.length, 3);
  // Animation separation: gacha pulling frames play per-rarity videos,
  // budget pulling frames ALWAYS the one fixed video.
  const gPullFrame = gFrames.find(f => f.state === 'pulling');
  const bPullFrame = bFrames.find(f => f.state === 'pulling');
  assert.ok(gPullFrame.videoFile.startsWith('/gachavids/') && gPullFrame.videoFile !== '/gachavids/gacha-at-home.mp4');
  assert.strictEqual(bPullFrame.videoFile, '/gachavids/gacha-at-home.mp4');
  // And the section ids themselves (what the overlay pages filter on):
  assert.strictEqual(g.machine.name, 'gacha');
  assert.strictEqual(b.machine.name, 'budgetgacha');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── machine-core edge cases (robustness the legacy code lacked) ──');
// ═══════════════════════════════════════════════════════════════════════════

test('duplicate REVEAL event is ignored, not re-fired (no double reveal)', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  h.clock.advance(REVEAL_MS);
  const before = h.frames.length;
  assert.strictEqual(h.m.machine.send('REVEAL'), false, 'REVEAL invalid in result state');
  assert.strictEqual(h.frames.length, before);
});

test('PULL event mid-animation is ignored by the machine (queue path handles it)', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  const before = h.frames.length;
  assert.strictEqual(h.m.machine.send('PULL', { pull: { user: 'evil', isPremium: false } }), false);
  assert.strictEqual(h.frames.length, before, 'no second pulling frame');
});

test('dud roll: no icon, no redeem, result label is "(Dud)"', () => {
  // RNG 0.999 on GACHA_TABLE lands past common+common (20) into dud weight.
  const h = makeHarness('gacha', { rng: makeRng(0.999) });
  h.m.triggerPull({ user: 'alice', isPremium: false });
  assert.strictEqual(h.frames[0].isDud, true);
  assert.strictEqual(h.frames[0].iconPath, null);
  assert.strictEqual(h.frames[0].videoFile, '/gachavids/dud1.mp4');
  h.clock.advance(REVEAL_MS);
  assert.strictEqual(h.redeems.length, 0, 'duds dispatch no redeem');
  assert.strictEqual(h.results[0].label, '(Dud)');
});

test('audit log records every transition (legacy had no introspection)', () => {
  const h = makeHarness('gacha');
  h.m.triggerPull({ user: 'alice', isPremium: false });
  h.clock.advance(IDLE_MS);
  const hist = h.m.machine.history().map(t => `${t.event}:${t.from}→${t.to}`);
  assert.deepStrictEqual(hist, ['PULL:idle→pulling', 'REVEAL:pulling→result', 'DONE:result→idle']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
