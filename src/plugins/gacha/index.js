'use strict';

const log = require('../../logger');
const commandsList = require('../commands-list');
const { registerSection, updateSection, addRoute } = require('../../overlay-server');
const fs   = require('fs');
const path = require('path');

const GACHA_HTML = path.resolve(__dirname, 'overlay.html');

// queue is injected via init(context) — see init() below.
// We keep a module-level reference so setTimeout callbacks (which fire
// long after init has run) can call pushRedeem to synthesise redeems.
let _queue = null;

// ─── Loot Table ─────────────────────────────────────────────────────────────
// Each entry: { id, label, rarity, icon (folder name under gachaicons/) }
// odds: standard pull weight  premiumOdds: premium pull weight

const LOOT_TABLE = [
  // Common
  // redeem: exact Twitch reward title to fire when this item is revealed.
  // null = no automatic redeem (handled manually, or not applicable).
  { id: 'play-gd-level',    label: 'Play your GD Level',            rarity: 'common',    icon: 'play-gd-level',    odds: 10.00, premiumOdds: 2.00, redeem: 'Play your GD Level'    },
  { id: 'read-your-name',   label: 'Read your name',                rarity: 'common',    icon: 'read-your-name',   odds: 10.00, premiumOdds: 0.00, redeem: 'Read your name'        },
  { id: 'vine-boom',        label: 'Vine Boom',                     rarity: 'common',    icon: 'vine-boom',        odds: 10.00, premiumOdds: 4.00, redeem: 'Vine Boom'             },
  { id: 'metal-pipe',       label: 'Metal Pipe',                    rarity: 'common',    icon: 'metal-pipe',       odds: 10.00, premiumOdds: 4.00, redeem: 'Metal Pipe'            },
  // Uncommon
  { id: 'fah',              label: 'Fahhhhh',                       rarity: 'uncommon',  icon: 'fah',              odds:  5.00, premiumOdds: 5.00, redeem: 'Fah'                   },
  { id: 'screaming-chicken',label: 'Screaming Chicken',             rarity: 'uncommon',  icon: 'screaming-chicken',odds:  5.00, premiumOdds: 5.00, redeem: 'Chicken Scream'        },
  { id: 'vip',              label: 'VIP',                           rarity: 'uncommon',  icon: 'vip',              odds:  5.00, premiumOdds: 9.00, redeem: 'Vip'                   },
  { id: 'pull-fragment',    label: 'Pull Fragment',                 rarity: 'uncommon',  icon: 'pull-fragment',    odds:  5.00, premiumOdds: 2.00, redeem: 'Pull Fragment'         },
  { id: '1000-points',      label: '1000 Channel Points',           rarity: 'uncommon',  icon: '1000-points',      odds:  5.00, premiumOdds: 0.00, redeem: '1000 Channel Points'   },
  // Rare
  { id: 'premium-roll',     label: '1x Premium Roll',               rarity: 'rare',      icon: 'premium-roll',     odds:  3.00, premiumOdds: 0.00, redeem: '1x Premium Roll'       },
  { id: '50pt-discount',    label: '50 Point Discount',             rarity: 'rare',      icon: '50pt-discount',    odds:  3.00, premiumOdds: 9.00, redeem: '50 Point Discount'     },
  // Epic
  { id: 'say-phrase',       label: 'Say a Phrase',                  rarity: 'epic',      icon: 'say-phrase',       odds:  3.00, premiumOdds: 9.00, redeem: 'Say a Phrase'          },
  { id: 'turn-model-180',   label: 'Turn Model 180°',               rarity: 'epic',      icon: 'turn-model-180',   odds:  2.00, premiumOdds: 9.00, redeem: 'Turn Model 180'        },
  { id: '1v1',              label: '1v1',                           rarity: 'epic',      icon: '1v1',              odds:  2.00, premiumOdds: 9.00, redeem: '1v1'                   },
  // Legendary
  { id: 'custom-sfx',       label: 'Add Custom SFX',                rarity: 'legendary',      icon: 'custom-sfx',       odds:  1.00, premiumOdds: 3.00, redeem: 'Add Custom SFX'        },
  { id: 'free-art',         label: 'Free Art',                      rarity: 'legendary', icon: 'free-art',         odds:  1.00, premiumOdds: 5.00, redeem: 'Free Art'              },
  { id: 'free-art-3d',      label: 'Free Art (3D)',                 rarity: 'legendary', icon: 'free-art-3d',      odds:  1.00, premiumOdds: 5.00, redeem: 'Free Art (3D)'         },
  { id: 'mod',              label: 'Mod',                           rarity: 'legendary', icon: 'mod',              odds:  1.00, premiumOdds: 5.00, redeem: 'Mod'                   },
  // Mythic
  { id: 'choose-game',      label: 'Choose Game to Stream Tomorrow',rarity: 'mythic', icon: 'choose-game',      odds:     0.10, premiumOdds: 1.00, redeem: 'Choose Game to Stream Tomorrow' },
  { id: 'custom-mc-mod',    label: 'Custom Minecraft Mod',          rarity: 'mythic',    icon: 'custom-mc-mod',    odds:  0.10, premiumOdds: 1.00, redeem: 'Custom Minecraft Mod'  },
  { id: 'shower-stream',    label: 'Shower Stream',                 rarity: 'mythic',    icon: 'shower-stream',    odds:  0.00001, premiumOdds: 0.0001, redeem: 'Shower Stream'         },
  // One of One
  { id: 'one-of-one',       label: 'Literally Nothing (Rare)',      rarity: 'oneofone',  icon: 'one-of-one',       odds:  0.1, premiumOdds: 0.1, redeem: 'Literally Nothing (Rare)'},
  // Dud (virtual — handled separately)
  { id: 'dud',              label: 'Dud',                           rarity: 'dud',       icon: null,               odds: 15.88, premiumOdds: 1.99, redeem: 'Dud'                   },
];

const DUD_COUNT = 2; // dud1.mp4, dud2.mp4

// Maximum number of cells in a single grid reveal. If a trigger asks for
// more than this (e.g. 500 bits = 5 pulls, fine — but 5000 bits = 50 pulls,
// too many for one grid), we split into multiple batches of MAX_GRID_SIZE
// each (last batch may be smaller) and queue them one after another via
// _pullQueue. Each batch plays out as its own ~14s grid reveal animation.
//
// 25 → 5×5 grid, fills the 1920×1080 stage nicely without cells getting
// too small to read.
const MAX_GRID_SIZE = 25;

// ─── Pull logic ──────────────────────────────────────────────────────────────

function roll(isPremium) {
  const weightKey = isPremium ? 'premiumOdds' : 'odds';
  const pool = LOOT_TABLE.filter(e => e[weightKey] > 0);
  const total = pool.reduce((s, e) => s + e[weightKey], 0);
  let r = Math.random() * total;
  for (const entry of pool) {
    r -= entry[weightKey];
    if (r <= 0) return entry;
  }
  return pool[pool.length - 1];
}

// ─── Overlay registration ─────────────────────────────────────────────────────

registerSection('gacha', {
  title: 'Gacha',
  order: 5,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <path d="M12 8v8M8 12h8"/>
  </svg>`,

  render: (function render(data, el, esc) {
    if (!data || !data.state || data.state === 'idle') {
      el.innerHTML = '';
      return;
    }
    if (data.state === 'pulling') {
      el.innerHTML = '<div style="color:var(--accent,#fff)">🎰 Pull in progress…</div>';
    } else if (data.state === 'grid') {
      el.innerHTML = '<div style="color:var(--accent,#fff)">🎰 Grid reveal: ' + esc(String((data.items || []).length)) + ' pulls for ' + esc(data.user || '') + '</div>';
    } else if (data.state === 'result') {
      const r = data.result;
      el.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:4px">' +
          '<span style="font-size:0.75em;opacity:0.6;text-transform:uppercase">' + esc(r.rarity) + '</span>' +
          '<span style="font-weight:600">' + esc(r.label) + '</span>' +
          '<span style="font-size:0.75em;opacity:0.5">for ' + esc(r.user) + '</span>' +
        '</div>';
    }
  }).toString(),
});

// ─── State helpers ────────────────────────────────────────────────────────────

let _pullActive = false;
const _pullQueue = []; // { user, isPremium, count?, users? }

function pushState(state, extra = {}) {
  updateSection('gacha', { state, ...extra });
}

// ─── Result listener registry ──────────────────────────────────────────────────
// Plugins can register a callback via gacha.onResult(cb) to be notified
// every time a pull completes (single OR grid). Each callback is called
// with one result object: { id, user, label, rarity, isDud, timestamp }.
// Used by the gacha-results dashboard widget to populate its list.
const _resultListeners = [];
function onResult(cb) {
  if (typeof cb === 'function') _resultListeners.push(cb);
}
function _emitResult(result) {
  for (const cb of _resultListeners) {
    try { cb(result); } catch (e) { log.error('[gacha] onResult listener threw:', e.message); }
  }
}

// Monotonic id for results so the dashboard widget has stable keys.
let _resultId = 0;
function _nextResultId() { return ++_resultId; }

// ─── Gifted-sub batcher ────────────────────────────────────────────────────────
// Twitch sends each gifted-sub recipient as a separate `channel.subscribe`
// event with `is_gift: true`. Without batching, a 25-sub gift would
// queue 25 sequential 14s pulls = ~6 minutes. Instead, we collect all
// gifted subs that arrive within GIFT_BATCH_MS of the first one into a
// single batch, then triggerGridPull with the collected usernames so the
// overlay shows one grid reveal (auto-split into MAX_GRID_SIZE chunks
// if the batch is bigger than 25) instead of N sequential single pulls.
const GIFT_BATCH_MS = 2000;
let _giftBatch = { timer: null, users: [] };

function _flushGiftBatch() {
  _giftBatch.timer = null;
  const users = _giftBatch.users;
  _giftBatch.users = [];
  if (users.length === 0) return;
  log.info(`[gacha] Flushing gifted-sub batch of ${users.length} recipient(s): ${users.join(', ')}`);
  triggerGridPull({ users, isPremium: true });
}

function _queueGiftedSub(user) {
  _giftBatch.users.push(user);
  if (!_giftBatch.timer) {
    _giftBatch.timer = setTimeout(_flushGiftBatch, GIFT_BATCH_MS);
  }
}

// ─── Internal: play one pull immediately ─────────────────────────────────────

function _executePull({ user, isPremium }) {
  _pullActive = true;

  const item = roll(isPremium);
  const isDud = item.rarity === 'dud';

  // Pick video path — one video per rarity, duds pick dud1 or dud2
  let videoFile;
  if (isDud) {
    const dudNum = Math.floor(Math.random() * DUD_COUNT) + 1; // 1 or 2
    videoFile = `/gachavids/dud${dudNum}.mp4`;
  } else {
    videoFile = `/gachavids/${item.rarity}.mp4`;
  }

  // Icon path (null for duds)
  const iconPath = isDud ? null : `/gachaicons/${item.icon}/icon.png`;

  log.info(`[gacha] ${user} pulled (${isPremium ? 'premium' : 'standard'}): ${item.label} [${item.rarity}] | queue remaining: ${_pullQueue.length}`);

  pushState('pulling', {
    user,
    videoFile,
    iconPath,
    rarity: item.rarity,
    label: item.label,
    isDud,
  });

  setTimeout(() => {
    pushState('result', {
      result: { rarity: item.rarity, label: item.label, user },
    });

    // Emit the result so plugins like gacha-results can record it.
    // `redeem` is included so downstream plugins can identify SFX items
    // (Vine Boom, Metal Pipe, etc.) and auto-remove them from the results
    // list if desired.
    _emitResult({
      id:        _nextResultId(),
      user:      user,
      label:     isDud ? '(Dud)' : item.label,
      rarity:    item.rarity,
      isDud:     isDud,
      redeem:    isDud ? null : (item.redeem || null),
      timestamp: new Date(),
    });

    // Fire the item's associated redeem as soon as the icon is revealed,
    // so plugins like sfx pick it up at the right moment.
    if (!isDud && item.redeem) {
      log.info(`[gacha] Dispatching redeem "${item.redeem}" for ${user}`);
      if (_queue) {
        _queue.pushRedeem({
          username:  user,
          title:     item.redeem,
          cost:      0,
          input:     null,
          timestamp: new Date(),
          _fromGacha: true, // flag so other plugins can tell it's synthetic
        });
      } else {
        log.warn('[gacha] queue not available — synthetic redeem not dispatched');
      }
    }
  }, 8000);

  setTimeout(() => {
    pushState('idle');
    _pullActive = false;
    _startNextQueued();
  }, 14000);
}

// ─── Shared queue consumer ───────────────────────────────────────────────────
// Both _executePull and _executeGridPull end by releasing _pullActive and
// pulling the next queued item. The next item may itself be a grid pull
// ({ user, count, isPremium }) or a single pull ({ user, isPremium }).
// Dispatch to the right executor — otherwise a grid pull queued behind a
// single pull would be silently demoted to a single pull (the old bug).
function _startNextQueued() {
  if (_pullQueue.length === 0) return;
  const next = _pullQueue.shift();
  log.info(`[gacha] Starting next queued pull for ${next.user} | ${_pullQueue.length} remaining`);
  setTimeout(() => {
    if (next.count && next.count > 1) {
      _executeGridPull(next);
    } else {
      _executePull(next);
    }
  }, 1500);
}

// ─── Grid pull (many pulls revealed simultaneously) ──────────────────────────
// Used when a single donation is large enough to award multiple pulls at
// once (e.g. a big bit cheer). Instead of queuing them one after another
// through _executePull, this rolls everything up front and reveals all
// items simultaneously in a grid on the overlay.

function _executeGridPull({ user, count, isPremium, users }) {
  _pullActive = true;

  // `users` is an optional array of usernames, one per pull, so each grid
  // cell can be attributed to a different recipient (used by the gifted-sub
  // batcher). If absent, all cells are attributed to the single `user`.
  const hasPerItemUsers = Array.isArray(users) && users.length >= count;

  const items = [];
  for (let i = 0; i < count; i++) {
    const item = roll(isPremium);
    const isDud = item.rarity === 'dud';
    let videoFile;
    if (isDud) {
      const dudNum = Math.floor(Math.random() * DUD_COUNT) + 1;
      videoFile = `/gachavids/dud${dudNum}.mp4`;
    } else {
      videoFile = `/gachavids/${item.rarity}.mp4`;
    }
    const iconPath = isDud ? null : `/gachaicons/${item.icon}/icon.png`;
    const itemUser = hasPerItemUsers ? users[i] : user;
    items.push({
      videoFile, iconPath,
      rarity: item.rarity, label: item.label, isDud,
      redeem: item.redeem,
      user:   itemUser,
    });
  }

  // For the header line: if all items share the same user, show that
  // user; otherwise show "N viewers".
  const headerUser = hasPerItemUsers
    ? (items.every(it => it.user === items[0].user) ? items[0].user : `${count} viewers`)
    : user;

  log.info(`[gacha] ${headerUser} grid pull (${isPremium ? 'premium' : 'standard'}) x${count}: ${items.map(i => i.label).join(', ')}`);

  pushState('grid', { user: headerUser, items });

  setTimeout(() => {
    // Emit each item as a separate result (after the icon reveal).
    for (const item of items) {
      _emitResult({
        id:        _nextResultId(),
        user:      item.user,
        label:     item.isDud ? '(Dud)' : item.label,
        rarity:    item.rarity,
        isDud:     item.isDud,
        redeem:    item.isDud ? null : (item.redeem || null),
        timestamp: new Date(),
      });
    }

    // Fire each item's associated redeem as the icons are revealed, same
    // as a normal single pull, so plugins like sfx pick them up. Each
    // redeem is attributed to that item's user (per-recipient for
    // gifted-sub batches).
    for (const item of items) {
      if (item.isDud || !item.redeem) continue;
      if (_queue) {
        _queue.pushRedeem({
          username:  item.user,
          title:     item.redeem,
          cost:      0,
          input:     null,
          timestamp: new Date(),
          _fromGacha: true,
        });
      }
    }
  }, 8000);

  setTimeout(() => {
    pushState('idle');
    _pullActive = false;
    _startNextQueued();
  }, 14000);
}

/**
 * Trigger `count` pulls that reveal all at once in a grid, instead of one
 * after another. Falls back to a normal single pull when count <= 1.
 * Queues behind any pull/grid already in progress, same as triggerPull.
 *
 * If `count` exceeds MAX_GRID_SIZE, this AUTOMATICALLY splits into
 * multiple batches of MAX_GRID_SIZE each (last batch may be smaller).
 * Each batch plays as its own ~14s grid reveal, queued back-to-back via
 * _pullQueue. So /pull count:50 = two 25-cell grids, one after another.
 */
function triggerGridPull({ user, count = 1, isPremium = false, users }) {
  // If `users` array is provided, it overrides `count` — one pull per
  // user, each attributed to a different recipient (gifted-sub batcher).
  if (Array.isArray(users) && users.length > 0) {
    count = users.length;
  }
  if (count <= 1) {
    // Single pull — but if a specific user was provided via `users[0]`,
    // use that instead of the bare `user`.
    const singleUser = Array.isArray(users) && users.length === 1 ? users[0] : user;
    return triggerPull({ user: singleUser, isPremium });
  }

  // Split into batches of MAX_GRID_SIZE. For count <= MAX_GRID_SIZE this
  // is a single batch and behaves exactly like the old code.
  const batches = [];
  let remaining = count;
  while (remaining > 0) {
    const size = Math.min(MAX_GRID_SIZE, remaining);
    batches.push(size);
    remaining -= size;
  }

  if (batches.length > 1) {
    log.info(
      `[gacha] ${user || '(multi-user)'} grid pull x${count} split into ${batches.length} batches ` +
      `(${batches.join('+')}) — queued back-to-back.`
    );
  }

  // Fire the first batch immediately (or queue it if a pull is active),
  // and queue the rest. _pullQueue dispatches them in order via
  // _startNextQueued(), which knows to route {count>1} items back through
  // _executeGridPull.
  let offset = 0;
  for (let i = 0; i < batches.length; i++) {
    const batchCount = batches[i];
    // Slice the per-item users array for this batch (if present).
    const batchUsers = Array.isArray(users) ? users.slice(offset, offset + batchCount) : undefined;
    offset += batchCount;

    if (i === 0 && !_pullActive) {
      _executeGridPull({ user, count: batchCount, isPremium, users: batchUsers });
    } else {
      _pullQueue.push({ user, count: batchCount, isPremium, users: batchUsers });
      log.info(
        `[gacha] Grid pull batch ${i + 1}/${batches.length} (${batchCount} pulls) queued for ${user || '(multi-user)'} ` +
        `| queue depth: ${_pullQueue.length}`
      );
    }
  }
}

// ─── Main pull trigger ────────────────────────────────────────────────────────
// Queues the pull if one is already in progress; plays immediately otherwise.

function triggerPull({ user, isPremium = false }) {
  if (_pullActive) {
    _pullQueue.push({ user, isPremium });
    log.info(`[gacha] Pull queued for ${user} (${isPremium ? 'premium' : 'standard'}) | queue depth: ${_pullQueue.length}`);
    return;
  }
  _executePull({ user, isPremium });
}

// ─── Redeem / bits / sub titles ───────────────────────────────────────────────

// Channel Point reward title(s) that trigger a standard pull.
// Case-insensitive. Add alternates if you name it differently on YT.
const STANDARD_REDEEM_TITLES = ['gacha pull', 'gacha'];

// Channel Point reward title(s) that trigger a premium pull.
const PREMIUM_REDEEM_TITLES  = ['gacha premium pull', 'gacha premium'];

// (BITS_PER_PULL removed — plain bits cheers no longer trigger gacha pulls.
//  Use custom Power-ups like "Gacha Pull" or "Gacha Pull (x16)" instead.)

// ─── Chat / redeem integration ────────────────────────────────────────────────

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  commandsList.registerCommand('!gacha', 'Spend 1000 channel points to pull from the gacha!');
  log.info('[gacha] ready.');
}

function _normaliseTitle(raw) {
  // Strip "[YT]" suffix appended by yt-points when mirroring YouTube redeems
  return raw.replace(/\s*\[YT\]\s*$/i, '').trim().toLowerCase();
}

function init(context) {
  const q = context.queue;
  _queue = q; // captured for setTimeout-callback access in _executePull

  // ── Channel Point redeems ────────────────────────────────────────────────
  if (typeof q?.onRedeem === 'function') {
    q.onRedeem(redeem => {
      // Power-up-sourced redeems (bits Power-ups, incl. custom ones like a
      // "Gacha Pull" power-up) are handled exclusively by the
      // gacha-powerup-pull plugin so they always give a premium pull —
      // don't also match them here as a channel-points standard pull.
      if (redeem.source === 'power_up') return;

      const raw = redeem.title ?? redeem.reward?.title;
      if (!raw) {
        log.warn('[gacha] Redeem missing title — skipping. Keys:', Object.keys(redeem).join(', '));
        return;
      }
      const title = _normaliseTitle(raw);
      const user  = redeem.user ?? redeem.username ?? 'someone';

      if (STANDARD_REDEEM_TITLES.includes(title)) {
        log.info(`[gacha] Standard pull via redeem for ${user}`);
        triggerPull({ user, isPremium: false });
      } else if (PREMIUM_REDEEM_TITLES.includes(title)) {
        log.info(`[gacha] Premium pull via redeem for ${user}`);
        triggerPull({ user, isPremium: true });
      }
    });
  } else {
    log.warn('[gacha] context.queue.onRedeem not available — redeem triggers disabled');
  }

  // ── Subs via onDonation ──────────────────────────────────────────────────────────────
  // queue.js routes subs, resubs, and subgifts through onDonation.
  //
  // NOTE: Plain bits cheers NO LONGER trigger gacha pulls. Previously
  // 100 bits = 1 pull, 200+ bits = grid reveal. That's been removed —
  // bits are just bits now. Pulls come from:
  //   • Custom Power-ups ("Gacha Pull", "Gacha Pull (x16)", etc.)
  //     → gacha-powerup-pull plugin → premium-roll
  //   • Sub / resub           → 1 premium pull for the subscriber
  //   • Subgift               → 1 premium pull for the GIFTER (each
  //                           recipient gets their own pull via the
  //                           subsequent `channel.subscribe` event)
  //
  // type: 'sub' | 'resub'      → 1 premium pull for the subscriber
  // type: 'subgift'            → 1 premium pull for the GIFTER (regardless
  //                              of how many subs they gifted). Each
  //                              recipient gets their own pull via the
  //                              subsequent `channel.subscribe` event above
  //                              — so an N-sub gift = 1 gifter pull + N
  //                              recipient pulls = N+1 total.
  if (typeof q?.onDonation === 'function') {
    q.onDonation(event => {
      const type = event.type;

      if (type === 'sub' || type === 'resub') {
        const user = event.username ?? 'someone';
        // Gifted subs go through the batcher so a multi-sub gift reveals
        // all recipient pulls in one (or a few) grid(s) instead of N
        // sequential ~14s single pulls. Non-gifted subs and resubs
        // trigger immediately — there's only ever one of them per event.
        if (type === 'sub' && event.gifted === true) {
          log.info(`[gacha] Gifted sub from ${user} → queued for batched grid reveal`);
          _queueGiftedSub(user);
        } else {
          log.info(`[gacha] ${type} from ${user} → 1 premium pull`);
          triggerPull({ user, isPremium: true });
        }

      } else if (type === 'subgift') {
        // One pull for the gifter, regardless of how many subs they gifted.
        // Each recipient will get their OWN pull when their `channel.subscribe`
        // event fires (Twitch sends those separately, with `is_gift: true`),
        // and the `sub` branch above already triggers 1 pull per subscriber.
        //
        // So for a 1-sub gift: 1 pull (gifter, here) + 1 pull (recipient,
        // via the subsequent sub event) = 2 pulls total, correctly
        // attributed to each user.
        // For an N-sub gift: 1 pull (gifter, here) + N pulls (recipients,
        // via N subsequent sub events) = N+1 pulls total.
        const user  = event.username ?? 'someone'; // gifter
        const count = event.quantity ?? 1;
        log.info(
          `[gacha] ${user} gifted ${count} sub(s) → 1 premium pull for gifter ` +
          `(recipients get their own pulls via subsequent sub events)`
        );
        triggerPull({ user, isPremium: true });
      }
    });
  } else {
    log.warn('[gacha] context.queue.onDonation not available — bits/sub triggers disabled');
  }

  // ── Gacha overlay route ──────────────────────────────────────────────────
  addRoute('/gacha', (req, res) => {
    try {
      const html = fs.readFileSync(GACHA_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      log.error('[gacha] Could not read overlay.html:', e.message);
      res.writeHead(500); res.end('Gacha overlay not found');
    }
  });

  log.info('[gacha] Plugin loaded. Standard redeems:', STANDARD_REDEEM_TITLES.join(', '));
  log.info('[gacha] Premium redeems:', PREMIUM_REDEEM_TITLES.join(', '));
  log.info('[gacha] Subs/resubs → 1 premium pull | Subgifts → 1 gifter pull + N recipient pulls');
}

async function processMessage(msg) {
  // Manual mod trigger: !gacha @user [premium]
  const manualMatch = false; // msg.text.match(/^!gacha\s+@?(\w+)?\s*(premium)?/i);
  if (manualMatch) {
    const user = manualMatch[1] || msg.username;
    const isPremium = !!manualMatch[2];
    triggerPull({ user, isPremium });
    return { message: null };
  }
  return { message: msg };
}

module.exports = {
  id: 'gacha',
  init,
  onChatReady,
  processMessage,
  triggerPull,
  triggerGridPull,
  MAX_GRID_SIZE, // exported so premium-roll can compute batch counts
  onResult,     // exported so gacha-results widget can subscribe to pulls
};