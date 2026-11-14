'use strict';

/**
 * websub-lease-machine.test.js — no-regression harness for the lease machine.
 * Asserts the legacy renewal timing (lease - 1h margin) AND the new
 * behaviours the legacy while-loop lacked: retry-on-failure with backoff,
 * and state surfacing for a dashboard connections widget.
 * Run: node test/websub-lease-machine.test.js
 */

const assert = require('assert');
const { ManualClock } = require('../src/fsm');
const { createLeaseMachine, LEASE_SECONDS, RENEW_MARGIN_S } = require('../src/websub-lease-machine');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Async-capable runner: the lease machine delivers ACCEPTED/REJECTED via the
// microtask queue (production ytSubscribe is an async fetch), so tests flush
// microtasks between actions.
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++; console.log(`  ok  ${name}`);
    } catch (e) {
      failed++; console.error(`  FAIL ${name}\n      ${e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 4) { for (let i = 0; i < n; i++) await tick(); }

const RENEW_AT_MS = (LEASE_SECONDS - RENEW_MARGIN_S) * 1000; // 23 h, legacy timing

function harness(overrides = {}) {
  const clock = new ManualClock();
  const calls = [];       // subscribe attempts
  const states = [];      // observed state changes
  const fail = overrides.fail ?? false;
  const lease = createLeaseMachine({
    clock,
    subscribe: async (channelId) => {
      calls.push({ at: clock.now(), channelId });
      if (fail) throw new Error('hub down');
    },
    onState: (state, meta) => states.push({ state, at: clock.now(), meta: { ...meta } }),
    onLog: () => {},
    ...overrides,
  });
  return { clock, calls, states, lease };
}

test('initial state is unsubscribed', async () => {
  const h = harness();
  assert.strictEqual(h.lease.state, 'unsubscribed');
});

test('start() subscribes and reaches subscribed on acceptance', async () => {
  const h = harness();
  h.lease.start('UCabc'); await settle(); await settle();
  assert.strictEqual(h.lease.state, 'subscribed');
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].channelId, 'UCabc');
});

test('legacy renewal timing: first renew fires at lease-3600s (23 h)', async () => {
  const h = harness();
  h.lease.start('UCabc'); await settle(); await settle();
  h.clock.advance(RENEW_AT_MS - 1); await settle();
  assert.strictEqual(h.calls.length, 1, 'no premature renewal');
  h.clock.advance(1); await settle();
  assert.strictEqual(h.calls.length, 2, 'renewal at exactly 23 h');
  assert.strictEqual(h.lease.state, 'subscribed', 'still subscribed after renew');
});

test('renewal repeats every lease window while healthy', async () => {
  const h = harness();
  h.lease.start('UCabc'); await settle(); await settle();
  h.clock.advance(RENEW_AT_MS); await settle();       // first renew
  h.clock.advance(RENEW_AT_MS); await settle();       // second renew
  assert.strictEqual(h.calls.length, 3);
});

test('failed renewal retries with backoff (legacy never retried)', async () => {
  // First subscribe succeeds; renewal fails; backoff retries eventually land.
  const clock = new ManualClock();
  let failRenew = false;
  const calls = [];
  const lease = createLeaseMachine({
    clock,
    subscribe: async () => { calls.push(clock.now()); if (failRenew) throw new Error('hub down'); },
    onLog: () => {},
    backoff: { baseMs: 1000, maxMs: 8000 },
  });
  lease.start('UCabc'); await settle();
  assert.strictEqual(lease.state, 'subscribed');
  failRenew = true;                    // the renewal attempt now fails
  clock.advance(RENEW_AT_MS); await settle();          // renew attempt → failed
  assert.strictEqual(lease.state, 'failed');
  failRenew = false;                   // hub recovers
  clock.advance(1000); await settle();                 // backoff #1 (baseMs)
  assert.strictEqual(lease.state, 'subscribed', 'recovered after backoff');
  assert.strictEqual(calls.length, 3);
});

test('failed FIRST subscribe retries (legacy: one shot, then silence)', async () => {
  const clock = new ManualClock();
  let attempts = 0;
  const lease = createLeaseMachine({
    clock,
    subscribe: async () => { attempts++; if (attempts < 3) throw new Error('hub down'); },
    onLog: () => {},
    backoff: { baseMs: 500, maxMs: 4000 },
  });
  lease.start('UCabc'); await settle();
  assert.strictEqual(lease.state, 'failed');
  clock.advance(500); await settle();   // retry 1 → fails again
  assert.strictEqual(lease.state, 'failed');
  clock.advance(1000); await settle();  // retry 2 (backoff doubles) → succeeds
  assert.strictEqual(lease.state, 'subscribed');
  assert.strictEqual(attempts, 3);
});

test('state changes are surfaced for a dashboard connections widget', async () => {
  const h = harness();
  h.lease.start('UCabc'); await settle(); await settle();
  const observed = h.states.map(s => s.state);
  assert.deepStrictEqual(observed, ['subscribing', 'subscribed']);
  // The meta carries the channel for display.
  assert.strictEqual(h.states[1].meta.channelId, 'UCabc');
});

test('REVOKED drops back to unsubscribed (hub revoked us)', async () => {
  const h = harness();
  h.lease.start('UCabc'); await settle(); await settle();
  h.lease.machine.send('REVOKED'); await settle();
  assert.strictEqual(h.lease.state, 'unsubscribed');
});

test('renewNow() forces an immediate renewal attempt (dashboard action)', async () => {
  const h = harness();
  h.lease.start('UCabc'); await settle(); await settle();
  assert.strictEqual(h.calls.length, 1);
  h.lease.renewNow(); await settle();
  assert.strictEqual(h.calls.length, 2);
  assert.strictEqual(h.lease.state, 'subscribed');
});

run().then(() => { if (failed > 0) process.exit(1); });
