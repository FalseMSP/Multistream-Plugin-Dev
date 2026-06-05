'use strict';

// src/plugins/sfx/index.js
//
// Plays sound effects in the stream overlay (OBS browser source) when
// viewers redeem Channel Points.
//
// SETUP
// -----
// 1. Drop your audio files somewhere the overlay HTTP server can serve them.
//    By convention, put them in:  src/overlay/public/sfx/
//    (e.g. airhorn.mp3, sadtrombone.mp3, etc.)
//
// 2. Map each Channel Point reward title → file path in SFX_MAP below.
//    Paths are relative to the overlay origin (e.g. "/sfx/airhorn.mp3").
//
// 3. The overlay section must be loaded as a browser source in OBS.
//    The section renders an invisible <audio> element that fires on demand.
//
// 4. Optional env vars:
//    SFX_VOLUME=0.8          master volume 0.0–1.0 (default 1.0)
//    SFX_COOLDOWN_MS=3000    minimum ms between plays (default 2000)

const { registerSection, updateSection } = require('../../overlay-server');
const log = require('../../logger');

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Map Channel Point reward titles (case-insensitive) to overlay-relative audio URLs.
 * Add / remove entries to match your actual reward names.
 */
const SFX_MAP = {
  'Vine Boom':       '/sfx/vine-boom.mp3',
  'Metal Pipe':      '/sfx/metal-pipe.mp3',
  'Chicken Scream':   '/sfx/chicken-scream.mp3',
  'Fah':              '/sfx/fah.mp3',
  'Quack':           '/sfx/quack.mp3',
  'Alex':             '/sfx/alex.mp3',
  "Air Horn":          '/sfx/airhorn.mp3',
  "Mosquito":           '/sfx/mosquitos.mp3',
  "Sisyphus":           '/sfx/sisyphus.mp3',
};

const MASTER_VOLUME  = parseFloat(process.env.SFX_VOLUME       ?? '1.0');
const COOLDOWN_MS    = parseInt(process.env.SFX_COOLDOWN_MS     ?? '2000', 10);

// ─── State ────────────────────────────────────────────────────────────────────

let _lastPlayedAt = 0;  // epoch ms — simple global cooldown

// ─── Overlay section ──────────────────────────────────────────────────────────

registerSection('sfx', {
  title: 'Sound Effects',
  order: 99,           // render last — this section is invisible to viewers
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round">
           <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
           <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
           <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
         </svg>`,

  // Render runs inside the browser source — must be fully self-contained.
  // data: { url: string, volume: number, seq: number } | null
  render: (function render(data, el, esc) {
    if (!data || !data.url) return;

    const prev = el.dataset.seq;
    if (prev === String(data.seq)) return;
    el.dataset.seq = data.seq;

    const audio = document.createElement('audio');
    audio.style.display = 'none';
    audio.src    = data.url;
    audio.volume = Math.min(1, Math.max(0, data.volume ?? 1));
    el.appendChild(audio);

    audio.play().catch(function(err) {
      console.warn('[sfx] audio play failed:', err.message);
    });

    audio.addEventListener('ended', function() {
      el.removeChild(audio);
    });
  }).toString(),
});

// ─── Redeem handler ───────────────────────────────────────────────────────────

/**
 * Looks up the reward title in SFX_MAP and, if found, pushes a play event
 * to the overlay.
 *
 * @param {string} rewardTitle  The exact Channel Point reward title from Twitch.
 * @returns {boolean}           true if a sound was dispatched.
 */
function handleRedeem(rewardTitle) {
  // Strip the "[YT]" suffix that yt-points appends when mirroring YouTube
  // redeems into the pipeline, so the SFX_MAP lookup still matches.
  const normalised = rewardTitle.replace(/\s*\[YT\]\s*$/i, '').trim();
  const key = Object.keys(SFX_MAP).find(
    k => k.toLowerCase() === normalised.toLowerCase()
  );

  if (!key) {
    log.debug(`[sfx] No sound mapped for reward: "${normalised}"${normalised !== rewardTitle ? ` (original: "${rewardTitle}")` : ''}`);
    return false;
  }

  const now = Date.now();
  if (now - _lastPlayedAt < COOLDOWN_MS) {
    log.info(`[sfx] Cooldown active — skipping "${rewardTitle}"`);
    return false;
  }
  _lastPlayedAt = now;

  const url = SFX_MAP[key];
  log.info(`[sfx] Playing "${url}" for reward "${rewardTitle}"`);

  updateSection('sfx', {
    url,
    volume: MASTER_VOLUME,
    seq: now,   // unique per event so same sound can replay consecutively
  });

  return true;
}

// ─── Plugin export ────────────────────────────────────────────────────────────

module.exports = {
  id: 'sfx',

  init(context) {
    // context is the merged object: { ...discord, queue }
    // Use context.queue.onRedeem so we hear every channel point redemption
    // regardless of whether it arrived via EventSub or IRC fallback.
    const q = context.queue ?? context;
    if (typeof q.onRedeem !== 'function') {
      log.warn('[sfx] context.queue.onRedeem not available — plugin will not fire');
      return;
    }
    q.onRedeem(redeem => {
      // Twitch EventSub payload nests the title under reward.title;
      // some queue implementations hoist it to a top-level title field.
      // Support both so this works regardless of how twitch.js normalises it.
      const title = redeem.title ?? redeem.reward?.title;
      if (!title) {
        log.warn('[sfx] Redeem event missing title — skipping. Keys:', Object.keys(redeem).join(', '));
        return;
      }
      handleRedeem(title);
    });

    log.info('[sfx] Plugin loaded. Mapped rewards:', Object.keys(SFX_MAP).join(', '));
  },

  // SFX plugin doesn't process chat messages — pass everything through.
  async processMessage(msg) {
    return { message: msg };
  },
};