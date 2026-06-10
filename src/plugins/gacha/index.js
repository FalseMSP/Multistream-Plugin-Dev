'use strict';

const log = require('../../logger');
const commandsList = require('../commands-list');
const { registerSection, updateSection, addRoute } = require('../../overlay-server');
const queue = require('../../queue');
const fs   = require('fs');
const path = require('path');

const GACHA_HTML = path.resolve(__dirname, 'overlay.html');

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
  { id: 'custom-sfx',       label: 'Add Custom SFX',                rarity: 'epic',      icon: 'custom-sfx',       odds:  2.00, premiumOdds: 9.00, redeem: 'Add Custom SFX'        },
  { id: '1v1',              label: '1v1',                           rarity: 'epic',      icon: '1v1',              odds:  2.00, premiumOdds: 9.00, redeem: '1v1'                   },
  // Legendary
  { id: 'choose-game',      label: 'Choose Game to Stream Tomorrow',rarity: 'legendary', icon: 'choose-game',      odds:  1.00, premiumOdds: 5.00, redeem: 'Choose Game to Stream Tomorrow' },
  { id: 'free-art',         label: 'Free Art',                      rarity: 'legendary', icon: 'free-art',         odds:  1.00, premiumOdds: 5.00, redeem: 'Free Art'              },
  { id: 'free-art-3d',      label: 'Free Art (3D)',                 rarity: 'legendary', icon: 'free-art-3d',      odds:  1.00, premiumOdds: 5.00, redeem: 'Free Art (3D)'         },
  { id: 'mod',              label: 'Mod',                           rarity: 'legendary', icon: 'mod',              odds:  1.00, premiumOdds: 5.00, redeem: 'Mod'                   },
  // Mythic
  { id: 'custom-mc-mod',    label: 'Custom Minecraft Mod',          rarity: 'mythic',    icon: 'custom-mc-mod',    odds:  0.10, premiumOdds: 1.00, redeem: 'Custom Minecraft Mod'  },
  { id: 'shower-stream',    label: 'Shower Stream',                 rarity: 'mythic',    icon: 'shower-stream',    odds:  0.01, premiumOdds: 1.00, redeem: 'Shower Stream'         },
  // One of One
  { id: 'one-of-one',       label: 'Literally Nothing (Rare)',      rarity: 'oneofone',  icon: 'one-of-one',       odds:  0.01, premiumOdds: 0.01, redeem: 'Literally Nothing (Rare)'},
  // Dud (virtual — handled separately)
  { id: 'dud',              label: 'Dud',                           rarity: 'dud',       icon: null,               odds: 15.88, premiumOdds: 1.99, redeem: 'Dud'                   },
];

const DUD_COUNT = 2; // dud1.mp4, dud2.mp4

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
const _pullQueue = []; // { user, isPremium }

function pushState(state, extra = {}) {
  updateSection('gacha', { state, ...extra });
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

    // Fire the item's associated redeem as soon as the icon is revealed,
    // so plugins like sfx pick it up at the right moment.
    if (!isDud && item.redeem) {
      log.info(`[gacha] Dispatching redeem "${item.redeem}" for ${user}`);
      queue.pushRedeem({
        username:  user,
        title:     item.redeem,
        cost:      0,
        input:     null,
        timestamp: new Date(),
        _fromGacha: true, // flag so other plugins can tell it's synthetic
      });
    }
  }, 8000);

  setTimeout(() => {
    pushState('idle');
    _pullActive = false;
    // Start the next queued pull after a short breath between animations
    if (_pullQueue.length > 0) {
      const next = _pullQueue.shift();
      log.info(`[gacha] Starting next queued pull for ${next.user} | ${_pullQueue.length} remaining`);
      setTimeout(() => _executePull(next), 1500);
    }
  }, 14000);
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

// Bits threshold for one pull (100 bits = 1 standard pull, NOT premium)
const BITS_PER_PULL = 100;

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
  const q = context.queue ?? context;

  // ── Channel Point redeems ────────────────────────────────────────────────
  if (typeof q.onRedeem === 'function') {
    q.onRedeem(redeem => {
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

  // ── Bits & Subs via onDonation ───────────────────────────────────────────
  // queue.js routes bits, subs, resubs, and subgifts through onDonation.
  // type: 'bits'                → standard pull (100 bits = 1 pull)
  // type: 'sub' | 'resub'      → 1 premium pull for the subscriber
  // type: 'subgift'            → 1 premium pull per sub gifted (credit gifter)
  if (typeof q.onDonation === 'function') {
    q.onDonation(event => {
      const type = event.type;

      if (type === 'bits') {
        const bits  = event.amount ?? 0;
        const user  = event.username ?? 'someone';
        const pulls = Math.floor(bits / BITS_PER_PULL);
        if (pulls < 1) return;
        log.info(`[gacha] ${user} cheered ${bits} bits → ${pulls} standard pull(s)`);
        for (let i = 0; i < pulls; i++) triggerPull({ user, isPremium: true });

      } else if (type === 'sub' || type === 'resub') {
        const user = event.username ?? 'someone';
        log.info(`[gacha] ${type} from ${user} → 1 premium pull`);
        triggerPull({ user, isPremium: true });

      } else if (type === 'subgift') {
        const user  = event.username ?? 'someone'; // gifter
        const count = event.quantity ?? 1;
        log.info(`[gacha] ${user} gifted ${count} sub(s) → ${count} premium pull(s)`);
        for (let i = 0; i < count; i++) triggerPull({ user, isPremium: true });
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
  log.info(`[gacha] Bits per pull: ${BITS_PER_PULL} | Subs → premium pull`);
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
};