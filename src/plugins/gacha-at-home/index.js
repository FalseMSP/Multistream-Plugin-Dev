'use strict';

const log = require('../../logger');
const { normaliseRedeemTitle } = require('../../queue'); // shared [YT]-strip helper (review W3)
const commandsList = require('../commands-list');
const { registerSection, updateSection, addRoute } = require('../../overlay-server');
const { createGachaMachine } = require('../gacha-shared/pull-machine');
const fs   = require('fs');
const path = require('path');

const GACHA_HTML = path.resolve(__dirname, 'overlay.html');

// Single source of truth for the budget pull price (review W3: help text
// said 1000, the real pinned Twitch reward is 500). Help text derives from
// here so !commands never disagrees with the actual price.
const PULL_COST = 500; // matches the pinned budget Twitch reward

// queue is injected via init(context) — see init() below.
let _queue = null;

// ─── Loot Table ─────────────────────────────────────────────────────────────
// Each entry: { id, label, rarity, icon (folder name under gachaicons/) }
// odds: standard pull weight  premiumOdds: premium pull weight

const LOOT_TABLE = [
  // Common
  // redeem: exact Twitch reward title to fire when this item is revealed.
  // null = no automatic redeem (handled manually, or not applicable).
  { id: 'play-gd-level',    label: 'Play your GD Level',            rarity: 'common',    icon: 'play-gd-level',    odds: 0.00, premiumOdds: 0.00, redeem: 'Play your GD Level'    },
  { id: 'read-your-name',   label: 'Read your name',                rarity: 'common',    icon: 'read-your-name',   odds: 10.00, premiumOdds: 0.00, redeem: 'Read your name'        },
  { id: 'vine-boom',        label: 'Vine Boom',                     rarity: 'common',    icon: 'vine-boom',        odds: 5.00, premiumOdds: 4.00, redeem: 'Vine Boom'             },
  { id: 'metal-pipe',       label: 'Metal Pipe',                    rarity: 'common',    icon: 'metal-pipe',       odds: 5.00, premiumOdds: 4.00, redeem: 'Metal Pipe'            },
  // Uncommon
  { id: 'fah',              label: 'Fahhhhh',                       rarity: 'epic',  icon: 'fah',              odds:  1.00, premiumOdds: 5.00, redeem: 'Fah'                   },
  { id: 'screaming-chicken',label: 'Screaming Chicken',             rarity: 'epic',  icon: 'screaming-chicken',odds:  1.00, premiumOdds: 5.00, redeem: 'Chicken Scream'        },
  { id: 'vip',              label: 'VIP',                           rarity: 'uncommon',  icon: 'vip',              odds:  0.00, premiumOdds: 0.00, redeem: 'Vip'                   },
  { id: 'pull-fragment',    label: 'Pull Fragment',                 rarity: 'uncommon',  icon: 'pull-fragment',    odds:  1.00, premiumOdds: 2.00, redeem: 'Pull Fragment'         },
  { id: '1000-points',      label: '1000 Channel Points',           rarity: 'uncommon',  icon: '1000-points',      odds:  0.00, premiumOdds: 0.00, redeem: '1000 Channel Points'   },
  // Rare (disabled)
  { id: 'premium-roll',     label: '1x Premium Roll',               rarity: 'rare',      icon: 'premium-roll',     odds:  0.00, premiumOdds: 0.00, redeem: '1x Premium Roll'       },
  { id: '50pt-discount',    label: '50 Point Discount',             rarity: 'rare',      icon: '50pt-discount',    odds:  0.00, premiumOdds: 0.00, redeem: '50 Point Discount'     },
  // Epic (disabled)
  { id: 'say-phrase',       label: 'Say a Phrase',                  rarity: 'epic',      icon: 'say-phrase',       odds:  0.00, premiumOdds: 0.00, redeem: 'Say a Phrase'          },
  { id: 'turn-model-180',   label: 'Turn Model 180°',               rarity: 'epic',      icon: 'turn-model-180',   odds:  0.00, premiumOdds: 0.00, redeem: 'Turn Model 180'        },
  { id: 'custom-sfx',       label: 'Add Custom SFX',                rarity: 'epic',      icon: 'custom-sfx',       odds:  0.00, premiumOdds: 0.00, redeem: 'Add Custom SFX'        },
  { id: '1v1',              label: '1v1',                           rarity: 'epic',      icon: '1v1',              odds:  0.00, premiumOdds: 0.00, redeem: '1v1'                   },
  // Legendary (disabled)
  { id: 'choose-game',      label: 'Choose Game to Stream Tomorrow',rarity: 'legendary', icon: 'choose-game',      odds:  0.00, premiumOdds: 0.00, redeem: 'Choose Game to Stream Tomorrow' },
  { id: 'free-art',         label: 'Free Art',                      rarity: 'legendary', icon: 'free-art',         odds:  0.00, premiumOdds: 0.00, redeem: 'Free Art'              },
  { id: 'free-art-3d',      label: 'Free Art (3D)',                 rarity: 'legendary', icon: 'free-art-3d',      odds:  0.00, premiumOdds: 0.00, redeem: 'Free Art (3D)'         },
  { id: 'mod',              label: 'Mod',                           rarity: 'legendary', icon: 'mod',              odds:  0.00, premiumOdds: 0.00, redeem: 'Mod'                   },
  // Mythic (disabled)
  { id: 'custom-mc-mod',    label: 'Custom Minecraft Mod',          rarity: 'mythic',    icon: 'custom-mc-mod',    odds:  0.00, premiumOdds: 0.00, redeem: 'Custom Minecraft Mod'  },
  { id: 'shower-stream',    label: 'Shower Stream',                 rarity: 'mythic',    icon: 'shower-stream',    odds:  0.00, premiumOdds: 0.00, redeem: 'Shower Stream'         },
  // One of One (disabled)
  { id: 'one-of-one',       label: 'Literally Nothing (Rare)',      rarity: 'oneofone',  icon: 'one-of-one',       odds:  0.00, premiumOdds: 0.00, redeem: 'Literally Nothing (Rare)'},
  // Dud (virtual — handled separately)
  { id: 'dud',              label: 'Dud',                           rarity: 'dud',       icon: null,               odds: 0.00, premiumOdds: 0.00, redeem: 'Dud'                   },
];

const DUD_COUNT = 2; // dud1.mp4, dud2.mp4

// ─── YouTube subscribe dedup ──────────────────────────────────────────────
// The YT subscriber poller fires one pushMessage({ type: 'subscribe' }) per
// new sub detected each poll cycle.  If 10 people subscribe between polls,
// that's 10 events at once.  We batch them into a single pull.
const YT_SUB_BATCH_MS = 2000;
let _ytSubBatchTimer = null;
let _ytSubBatchUser  = null;

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

registerSection('budgetgacha', {
  title: 'Budget Gacha',
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

// ─── Overlay route ────────────────────────────────────────────────────────────

addRoute('/budgetgacha', (req, res) => {
  try {
    const html = fs.readFileSync(GACHA_HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    log.error('[budgetgacha] Could not read overlay.html:', e.message);
    res.writeHead(500); res.end('Gacha overlay not found');
  }
});

// ─── State helpers ────────────────────────────────────────────────────────────

// The pull choreography runs on the shared state machine
// (../gacha-shared/pull-machine.js) — the same idle → pulling → result → idle
// choreography with legacy timings (reveal 8 s, idle 14 s, 1.5 s breath).
// This variant keeps its OWN animation identity: section id 'budgetgacha',
// the ONE fixed video (/gachavids/gacha-at-home.mp4), and NO grid mode.
// The budget overlay page (/budgetgacha) filters on section 'budgetgacha'
// and only ever handles pulling/result/idle frames — never grid.
let _machine = null;

function pushState(state, extra = {}) {
  updateSection('budgetgacha', { state, ...extra });
}

function _buildMachine() {
  return createGachaMachine({
    sectionId: 'budgetgacha',
    lootTable: LOOT_TABLE,
    clock: require('../../fsm').REAL_CLOCK,

    // ── VARIANT ANIMATION POLICY (what keeps budgetgacha ≠ gacha) ──────────
    // All pulls use the same video, regardless of rarity or dud.
    videoFor: () => '/gachavids/gacha-at-home.mp4',
    dudCount: 0,
    grid: { enabled: false }, // never any grid frames on this section

    emit: (frame) => {
      const { state, ...rest } = frame;
      pushState(state, rest);
    },

    dispatchRedeem: (redeem) => {
      if (_queue) _queue.pushRedeem(redeem);
      else log.warn('[budgetgacha] queue not available — synthetic redeem not dispatched');
    },

    // No results plumbing in the budget variant (legacy had none — no
    // gacha-results widget subscription here).
    results: null,

    onLog: (m) => log.info(m),
  });
}

// ─── Pull engine: shared state machine ───────────────────────────────────────
// The legacy _executePull + inline queue-drain code was replaced by
// ../gacha-shared/pull-machine.js — identical choreography, explicit FSM,
// asserted against the legacy contract by test/gacha-machine.test.js.

function triggerPull({ user, isPremium = false }) {
  if (!_machine) {
    log.warn('[budgetgacha] triggerPull before init — pull ignored');
    return;
  }
  _machine.triggerPull({ user, isPremium });
}

// ─── Redeem / bits / sub titles ───────────────────────────────────────────────

// Channel Point reward title(s) that trigger a standard pull.
// Case-insensitive. Add alternates if you name it differently on YT.
const STANDARD_REDEEM_TITLES = ['budget gacha pull', 'budget gacha'];

// Channel Point reward title(s) that trigger a premium pull.
const PREMIUM_REDEEM_TITLES  = ['budget gacha premium pull', 'budget gacha premium'];

// Bits threshold for one pull (100 bits = 1 standard pull, NOT premium)
const BITS_PER_PULL = 100;

// ─── Chat / redeem integration ────────────────────────────────────────────────

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  commandsList.registerCommand('!budgetgacha', `Spend ${PULL_COST} channel points to pull from the budget gacha!`);
  log.info('[budgetgacha] ready.');
}

function _normaliseTitle(raw) {
  // queue.normaliseRedeemTitle centralises the [YT] suffix strip that used to
  // be re-implemented here and in five other plugins (review W3).
  return normaliseRedeemTitle(raw);
}

function init(context) {
  const q = context.queue;
  _queue = q; // captured for the machine's dispatchRedeem callback

  // Build the pull machine now (it needs the queue for synthetic redeems).
  if (!_machine) _machine = _buildMachine();

  // ── Channel Point redeems ────────────────────────────────────────────────
  if (typeof q?.onRedeem === 'function') {
    q.onRedeem(redeem => {
      const raw = redeem.title ?? redeem.reward?.title;
      if (!raw) {
        log.warn('[budgetgacha] Redeem missing title — skipping. Keys:', Object.keys(redeem).join(', '));
        return;
      }
      const title = _normaliseTitle(raw);
      const user  = redeem.user ?? redeem.username ?? 'someone';

      if (STANDARD_REDEEM_TITLES.includes(title)) {
        log.info(`[budgetgacha] Standard pull via redeem for ${user}`);
        triggerPull({ user, isPremium: false });
      } else if (PREMIUM_REDEEM_TITLES.includes(title)) {
        log.info(`[budgetgacha] Premium pull via redeem for ${user}`);
        triggerPull({ user, isPremium: true });
      }
    });
  } else {
    log.warn('[budgetgacha] context.queue.onRedeem not available — redeem triggers disabled');
  }

  // ── Twitch follows via onDonation ────────────────────────────────────────
  // type: 'follow' → 1 standard pull (Twitch only; routed here from twitch.js)
  if (typeof q?.onDonation === 'function') {
    q.onDonation(event => {
      if (event.type === 'follow' && event.platform === 'twitch') {
        const user = event.username ?? 'someone';
        log.info(`[budgetgacha] Twitch follow from ${user} → 1 standard pull`);
        triggerPull({ user, isPremium: false });
      }
    });
  } else {
    log.warn('[budgetgacha] context.queue.onDonation not available — Twitch follow triggers disabled');
  }



  log.info('[budgetgacha] Plugin loaded. Standard redeems:', STANDARD_REDEEM_TITLES.join(', '));
  log.info('[budgetgacha] Premium redeems:', PREMIUM_REDEEM_TITLES.join(', '));
  log.info('[budgetgacha] Triggers: Twitch follow → standard pull | YouTube subscribe → standard pull (batched)');
}

async function processMessage(msg) {
  // YouTube like events (type: 'like' injected by youtube.js like poller)
  if (msg.platform === 'youtube' && msg.type === 'like') {
    log.info('[budgetgacha] YT like → 1 standard pull');
    triggerPull({ user: 'a viewer', isPremium: false });
    return { message: null };
  }

  // YouTube subscriber events (type: 'subscribe' injected by youtube.js poller)
  if (msg.platform === 'youtube' && msg.type === 'subscribe') {
    const user = msg.username ?? 'someone';
    if (_ytSubBatchTimer) {
      // Absorb burst — don't queue another pull
      log.info(`[budgetgacha] YT subscribe from ${user ?? 'anonymous'} — absorbed into active batch`);
    } else {
      _ytSubBatchUser  = user;
      _ytSubBatchTimer = setTimeout(() => {
        _ytSubBatchTimer = null;
        log.info(`[budgetgacha] YT sub batch fired → 1 standard pull for ${_ytSubBatchUser ?? 'anonymous'}`);
        triggerPull({ user: _ytSubBatchUser ?? 'someone', isPremium: false });
        _ytSubBatchUser = null;
      }, YT_SUB_BATCH_MS);
      log.info(`[budgetgacha] YT subscribe from ${user ?? 'anonymous'} → batching for ${YT_SUB_BATCH_MS}ms`);
    }
    return { message: null }; // suppress from chat feed
  }

  // Manual mod trigger: !gacha @user [premium]
  const manualMatch = false; // disable manual trigger for now
  if (manualMatch) {
    const user = manualMatch[1] || msg.username;
    triggerPull({ user, isPremium: false });
    return { message: null };
  }
  return { message: msg };
}

module.exports = {
  id: 'budgetgacha',
  init,
  onChatReady,
  processMessage,
  triggerPull,
};