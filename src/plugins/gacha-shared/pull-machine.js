'use strict';

/**
 * gacha-pull-machine.js
 * ─────────────────────
 * The pull choreography of the gacha overlay, expressed ONCE as an explicit
 * finite-state machine and shared by both gacha variants.
 *
 * Why share when the variants must stay separate
 * ──────────────────────────────────────────────
 * The two variants (gacha / "premium" and gacha-at-home / "budget") are
 * deliberately different products on stream:
 *
 *   gacha        route /gacha        section 'gacha'
 *                per-rarity videos   (/gachavids/<rarity>.mp4, dud1/dud2)
 *                grid reveal mode    (25-cell batches, gifted-sub batching)
 *                triggers: channel-point redeems, subs/resubs/subgifts
 *
 *   budgetgacha  route /budgetgacha  section 'budgetgacha'
 *                ONE fixed video     (/gachavids/gacha-at-home.mp4)
 *                NO grid mode        (single pulls only, YT-sub batching)
 *                triggers: budget redeems, Twitch follows, YT likes/subs
 *
 * Those differences are all *configuration and wiring*, and they stay
 * configuration: each variant passes its own { sectionId, videoPolicy,
 * grid, lootTable, triggers, results } descriptor into
 * createGachaMachine(). What was duplicated was never the animation —
 * it was the hidden state machine underneath (idle → pulling → result →
 * idle, with a 14 s timer, a queue, and a 1.5 s breath between pulls).
 * That machine is identical by design; making it explicit and shared is
 * exactly what lets the variants fork *safely* — a fix to the choreography
 * (e.g. the restart-collision of section ids) applies to both, while the
 * animation itself remains 100% per-variant.
 *
 * State diagram (config-driven, same for both variants):
 *
 *   idle ──TRIGGER──▶ pulling ──(revealMs=8s)──▶ result ──(holdMs→idle)
 *     ▲                  │                            │
 *     └── queue: full while pulling/result ────────────┘
 *   result ──(holdMs - revealMs = 6s)──▶ idle ──GAP(1.5s)──▶ next pull
 *
 * The overlay contract (SSE frames emitted) is byte-for-byte the legacy
 * contract, asserted by test/gacha-machine.test.js:
 *   pulling: { state:'pulling', user, videoFile, iconPath, rarity, label, isDud }
 *   grid:    { state:'grid', user, items:[{videoFile,iconPath,rarity,label,isDud,redeem,user}] }
 *   result:  { state:'result', result:{ rarity, label, user } }
 *   idle:    { state:'idle' }
 */

const { Machine } = require('../../fsm');

// Legacy timing constants (verified against both plugins):
//   reveal at 8000ms, idle at 14000ms, 1500ms breath before a queued pull.
const REVEAL_MS   = 8000;
const IDLE_MS     = 14000;
const BETWEEN_MS  = 1500;
const MAX_GRID_SIZE = 25;

/**
 * @param {object} cfg — per-variant descriptor:
 *   sectionId:   'gacha' | 'budgetgacha'           — SSE section id + log prefix
 *   lootTable:   array (shared shape with odds/premiumOdds/redeem/icon)
 *   videoFor(item, rng): -> video path.           — VARIANT ANIMATION POLICY
 *                 gacha:        per-rarity mp4 or dud1/dud2
 *                 gacha-at-home: always /gachavids/gacha-at-home.mp4
 *   dudCount:    number of dud videos (gacha: 2, budget: 0 → duds disabled)
 *   grid:        { enabled, maxGridSize }         — budget: { enabled:false }
 *   rng:         () => [0,1)                      — injectable for tests
 *   clock:       fsm clock (ManualClock in tests, real by default)
 *   emit:        (frame) => void                  — SSE frame sink (updateSection)
 *   results:     { emit(result), nextId() } | null — result listener plumbing
 *   dispatchRedeem(redeem): queue.pushRedeem or test spy
 *   onLog:       optional log fn (defaults to no-op in tests)
 */
function createGachaMachine(cfg) {
  const sectionId = cfg.sectionId;
  const rng       = cfg.rng ?? Math.random;
  const gridOn    = !!(cfg.grid && cfg.grid.enabled);
  const maxGrid   = (cfg.grid && cfg.grid.maxGridSize) || MAX_GRID_SIZE;
  const dudCount  = cfg.dudCount ?? 0;
  const doLog     = cfg.onLog || (() => {});

  if (!sectionId) throw new Error('gacha machine: sectionId is required');
  if (typeof cfg.videoFor !== 'function') throw new Error('gacha machine: videoFor(item, rng) is required');

  // ── Per-machine pull queue (exact legacy semantics) ──────────────────────
  // Entries: { user, isPremium, count?, users? }. count>1 → grid (if enabled).
  const queue = [];
  let inflight = null; // the pull currently being choreographed

  function roll(isPremium) {
    const weightKey = isPremium ? 'premiumOdds' : 'odds';
    const pool = cfg.lootTable.filter(e => e[weightKey] > 0);
    const total = pool.reduce((s, e) => s + e[weightKey], 0);
    let r = rng() * total;
    for (const entry of pool) {
      r -= entry[weightKey];
      if (r <= 0) return entry;
    }
    return pool[pool.length - 1];
  }

  // Build the per-item video/icon paths using THIS variant's animation policy.
  function materialise(item, user) {
    const isDud = item.rarity === 'dud';
    const videoFile = cfg.videoFor(item, rng);
    const iconPath = isDud ? null : `/gachaicons/${item.icon}/icon.png`;
    return { videoFile, iconPath, rarity: item.rarity, label: item.label, isDud, redeem: item.redeem, user };
  }

  function fireRedeems(items) {
    // Fire each item's associated redeem at reveal time (legacy behaviour:
    // exactly at the reveal timeout, attributed to that item's user).
    for (const item of items) {
      if (item.isDud || !item.redeem) continue;
      doLog(`[${sectionId}] Dispatching redeem "${item.redeem}" for ${item.user}`);
      cfg.dispatchRedeem({
        username:  item.user,
        title:     item.redeem,
        cost:      0,
        input:     null,
        timestamp: new Date(),
        _fromGacha: true,
      });
    }
  }

  function emitResults(items) {
    if (!cfg.results) return;
    for (const item of items) {
      cfg.results.emit({
        id:        cfg.results.nextId(),
        user:      item.user,
        label:     item.isDud ? '(Dud)' : item.label,
        rarity:    item.rarity,
        isDud:     item.isDud,
        redeem:    item.isDud ? null : (item.redeem || null),
        timestamp: new Date(),
      });
    }
  }

  // ── The machine ───────────────────────────────────────────────────────────
  const m = new Machine(sectionId, {
    initial: 'idle',
    states: {

      idle: {
        on: {
          // Entering a pull. `ctx.pull` is a queue entry:
          //   { user, isPremium }                        — single pull
          //   { user, count, isPremium, users? }         — grid pull
          // The effect rolls the loot, materialises video/icon paths with
          // THIS variant's policy, and emits the pulling/grid frame — exactly
          // what legacy _executePull/_executeGridPull did at entry time.
          PULL: {
            target: 'pulling',
            effect: (ctx) => {
              const p = ctx.pull;
              if (p.count && p.count > 1 && gridOn) {
                beginGridInto(p);
              } else {
                beginPullInto(p);
              }
            },
          },
        },
      },

      pulling: {
        // Reveal at REVEAL_MS (legacy 8000ms timeout inside _executePull).
        after: { ms: REVEAL_MS, event: 'REVEAL' },
        on: {
          REVEAL: {
            target: 'result',
            effect: (ctx) => {
              const p = inflight;
              if (!p) return;
              if (p.items) {
                // Grid reveal: legacy fires per-item results and redeems at
                // the reveal timeout. The grid FRAME itself was already
                // emitted at entry time — never re-emit it (a duplicate frame
                // would restart the overlay's cell animations).
                emitResults(p.items);
                fireRedeems(p.items);
              } else {
                cfg.emit({ state: 'result', result: { rarity: p.item.rarity, label: p.item.label, user: p.user } });
                emitResults([p.materialised]);
                fireRedeems([p.materialised]);
              }
            },
          },
          // Cancel mid-animation (used by tests; also a clean hook for a
          // future "skip animation" mod action).
          CANCEL: {
            target: 'idle',
            effect: () => { inflight = null; },
          },
        },
      },

      result: {
        // Return to idle at IDLE_MS - REVEAL_MS = 6000ms after reveal
        // (legacy: idle timeout fired at 14000ms from pull start).
        after: { ms: IDLE_MS - REVEAL_MS, event: 'DONE' },
        on: {
          DONE: {
            target: 'idle',
            effect: () => {
              // Legacy: the 14000ms timeout pushed { state:'idle' } BEFORE
              // releasing _pullActive and starting the next queued pull.
              cfg.emit({ state: 'idle' });
              inflight = null;
              scheduleNext();
            },
          },
        },
      },
    },
  }, { clock: cfg.clock, log: cfg.log });

  // ── Queue drain (legacy _startNextQueued, incl. the 1.5s breath) ─────────
  function scheduleNext() {
    if (queue.length === 0) return;
    const next = queue.shift();
    doLog(`[${sectionId}] Starting next queued pull for ${next.user} | ${queue.length} remaining`);
    cfg.clock.setTimeout(() => {
      m.send('PULL', { pull: next });
    }, BETWEEN_MS);
  }

  // ── Public trigger API (legacy-compatible) ───────────────────────────────

  /**
   * Queue or start a single pull. Mirrors legacy triggerPull: if a pull is
   * in progress (state != idle), the request is queued, else it starts now.
   */
  function triggerPull({ user, isPremium = false }) {
    if (m.state !== 'idle') {
      queue.push({ user, isPremium });
      doLog(`[${sectionId}] Pull queued for ${user} (${isPremium ? 'premium' : 'standard'}) | queue depth: ${queue.length}`);
      return;
    }
    m.send('PULL', { pull: { user, isPremium } });
  }

  /**
   * Trigger `count` pulls revealed as one grid. Mirrors legacy
   * triggerGridPull: batch splitting, per-item users, fallback to a single
   * pull when count <= 1, queue-behind-active. NO-OP when the variant has
   * grid mode disabled (budgetgacha never enters grid state).
   */
  function triggerGridPull({ user, count = 1, isPremium = false, users }) {
    if (!gridOn) {
      // Grid disabled in this variant → single pull, exactly like the
      // budget overlay has always done (it has no grid code path at all).
      const singleUser = Array.isArray(users) && users.length === 1 ? users[0] : user;
      return triggerPull({ user: singleUser, isPremium });
    }
    if (Array.isArray(users) && users.length > 0) count = users.length;
    if (count <= 1) {
      const singleUser = Array.isArray(users) && users.length === 1 ? users[0] : user;
      return triggerPull({ user: singleUser, isPremium });
    }

    const batches = [];
    let remaining = count;
    while (remaining > 0) {
      const size = Math.min(maxGrid, remaining);
      batches.push(size);
      remaining -= size;
    }
    if (batches.length > 1) {
      doLog(`[${sectionId}] ${user || '(multi-user)'} grid pull x${count} split into ${batches.length} batches (${batches.join('+')}) — queued back-to-back.`);
    }

    let offset = 0;
    for (let i = 0; i < batches.length; i++) {
      const batchCount = batches[i];
      const batchUsers = Array.isArray(users) ? users.slice(offset, offset + batchCount) : undefined;
      offset += batchCount;
      const entry = { user, count: batchCount, isPremium, users: batchUsers };
      if (i === 0 && m.state === 'idle') {
        m.send('PULL', { pull: entry });
      } else {
        queue.push(entry);
        doLog(`[${sectionId}] Grid pull batch ${i + 1}/${batches.length} (${batchCount} pulls) queued for ${user || '(multi-user)'} | queue depth: ${queue.length}`);
      }
    }
  }

  // ── Pull starters ──────────────────────────────────────────────────────────
  // Called ONLY from the idle→pulling PULL effect, so every entry path
  // (fresh trigger, queued drain, grid batch) shares one code path: roll at
  // execution time (legacy _executePull/_executeGridPull behaviour), emit the
  // frame, and stash the enriched entry on `inflight` for the REVEAL effect.

  function beginPullInto(p) {
    const item = roll(p.isPremium);
    const materialised = materialise(item, p.user);
    doLog(`[${sectionId}] ${p.user} pulled (${p.isPremium ? 'premium' : 'standard'}): ${item.label} [${item.rarity}] | queue remaining: ${queue.length}`);
    cfg.emit({
      state: 'pulling',
      user: p.user,
      videoFile: materialised.videoFile,
      iconPath: materialised.iconPath,
      rarity: materialised.rarity,
      label: materialised.label,
      isDud: materialised.isDud,
    });
    inflight = { user: p.user, isPremium: p.isPremium, item, materialised };
  }

  function beginGridInto(p) {
    const { user, count, isPremium, users } = p;
    const hasPerItemUsers = Array.isArray(users) && users.length >= count;
    const items = [];
    for (let i = 0; i < count; i++) {
      const item = roll(isPremium);
      const itemUser = hasPerItemUsers ? users[i] : user;
      items.push(materialise(item, itemUser));
    }
    const headerUser = hasPerItemUsers
      ? (items.every(it => it.user === items[0].user) ? items[0].user : `${count} viewers`)
      : user;
    doLog(`[${sectionId}] ${headerUser} grid pull (${isPremium ? 'premium' : 'standard'}) x${count}: ${items.map(i => i.label).join(', ')}`);
    cfg.emit({ state: 'grid', user: headerUser, items });
    inflight = { user: headerUser, isPremium, items, headerUser };
  }

  return { machine: m, triggerPull, triggerGridPull, roll, queueLength: () => queue.length };
}

module.exports = {
  createGachaMachine,
  REVEAL_MS,
  IDLE_MS,
  BETWEEN_MS,
  MAX_GRID_SIZE,
};
