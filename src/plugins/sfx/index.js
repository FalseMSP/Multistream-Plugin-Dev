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
//
// 2. Map each Channel Point reward title → file path in SFX_MAP below.
//    Paths are relative to the overlay origin (e.g. "/sfx/airhorn.mp3").
//
// 3. The overlay section must be loaded as a browser source in OBS.
//
// 4. Optional env vars:
//    SFX_VOLUME=0.8          master volume 0.0–1.0 (default 1.0)
//    SFX_COOLDOWN_MS=3000    minimum ms between plays for NON-gacha redeems
//                            (default 2000). Gacha-sourced redeems
//                            (_fromGacha=true) are exempt from cooldown
//                            so a grid pull revealing 5 SFX items plays
//                            all 5 — they queue on the client side.

const { registerSection, updateSection } = require('../../overlay-server');
const log = require('../../logger');

// ─── Configuration ────────────────────────────────────────────────────────────

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
  "MI BOMBO":             '/sfx/mi-bombo.mp3',
  "Ash Baby":            '/sfx/ash-baby.mp3',
  "This is actually crazy": '/sfx/this-is-actually-crazy.mp3',
  "meow":                   '/sfx/meow.mp3',
  "untitledscream":         '/sfx/untitledscream.mp3',
  "yaoi":                  '/sfx/yaoi.mp3',
};

const MASTER_VOLUME  = parseFloat(process.env.SFX_VOLUME       ?? '1.0');
const COOLDOWN_MS    = parseInt(process.env.SFX_COOLDOWN_MS     ?? '2000', 10);

// ─── State ────────────────────────────────────────────────────────────────────

let _lastPlayedAt = 0;  // epoch ms — simple global cooldown (non-gacha only)
let _seqCounter   = 0;  // monotonic counter for unique seq values

// ─── Overlay section ──────────────────────────────────────────────────────────
//
// The render function is serialized via .toString() and eval'd in the
// browser via `new Function(...)`. It CANNOT see module-level variables
// or functions — everything must be self-contained inside the function body.
//
// QUEUE LOGIC: When multiple SFX arrive in rapid succession (e.g. a gacha
// grid pull reveals Vine Boom + Metal Pipe + Fah at the same time), they
// are QUEUED and played one after another instead of simultaneously.
// This prevents:
//   • Audio overlap making everything inaudible
//   • Browser throttling dropping playback of some files
//
// The queue lives on the element itself (el.__sfxQueue) so it survives
// across render() calls. Each call pushes a new item; if nothing is
// currently playing, playback starts immediately.

registerSection('sfx', {
  title: 'Sound Effects',
  order: 99,
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round">
           <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
           <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
           <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
         </svg>`,

  render: (function render(data, el, esc) {
    if (!data || !data.url) return;

    // Dedup: skip if we've already seen this exact seq (same broadcast
    // received twice, e.g. on SSE reconnect).
    if (!el.__sfxSeenSeqs) el.__sfxSeenSeqs = {};
    if (el.__sfxSeenSeqs[data.seq]) return;
    el.__sfxSeenSeqs[data.seq] = true;

    // Initialize the queue if needed.
    if (!el.__sfxQueue) el.__sfxQueue = [];
    if (el.__sfxPlaying === undefined) el.__sfxPlaying = false;

    // Push this SFX onto the queue.
    el.__sfxQueue.push({ url: data.url, volume: data.volume ?? 1 });

    // If nothing is currently playing, start the queue pump.
    // _playNext is defined below — but since this render fn is serialized,
    // we define it INSIDE the render fn's scope.
    if (!el.__sfxPlaying) {
      (function _playNext() {
        if (el.__sfxQueue.length === 0) {
          el.__sfxPlaying = false;
          return;
        }
        el.__sfxPlaying = true;
        var item = el.__sfxQueue.shift();

        var audio = document.createElement('audio');
        audio.style.display = 'none';
        audio.src = item.url;
        audio.volume = Math.min(1, Math.max(0, item.volume ?? 1));
        el.appendChild(audio);

        function _onDone() {
          // Clean up this audio element.
          if (audio.parentNode) audio.parentNode.removeChild(audio);
          // Play the next item in the queue.
          _playNext();
        }

        audio.addEventListener('ended', _onDone);
        audio.addEventListener('error', _onDone);

        audio.play().catch(function(err) {
          console.warn('[sfx] audio play failed:', err.message);
          _onDone(); // skip to next even on error
        });
      })();
    }
  }).toString(),
});

// ─── Redeem handler ───────────────────────────────────────────────────────────

/**
 * Looks up the reward title in SFX_MAP and, if found, pushes a play event
 * to the overlay.
 *
 * @param {string} rewardTitle  The exact Channel Point reward title from Twitch.
 * @param {object} [opts]       Optional flags.
 * @param {boolean} [opts.fromGacha]  If true, exempt from cooldown (gacha
 *        grid reveals fire multiple SFX simultaneously — they should all
 *        play, queueing on the client side).
 * @returns {boolean}           true if a sound was dispatched.
 */
function handleRedeem(rewardTitle, opts) {
  opts = opts || {};
  // Strip the "[YT]" suffix that yt-points appends when mirroring YouTube
  // redeems into the pipeline, so the SFX_MAP lookup still matches.
  var normalised = rewardTitle.replace(/\s*\[YT\]\s*$/i, '').trim();
  var key = Object.keys(SFX_MAP).find(
    function(k) { return k.toLowerCase() === normalised.toLowerCase(); }
  );

  if (!key) {
    log.debug('[sfx] No sound mapped for reward: "' + normalised + '"' +
      (normalised !== rewardTitle ? ' (original: "' + rewardTitle + '")' : ''));
    return false;
  }

  // Cooldown check — ONLY for non-gacha redeems. Gacha-sourced redeems
  // (from a grid pull revealing multiple SFX items) are exempt so they
  // all get dispatched and queue on the client side.
  if (!opts.fromGacha) {
    var now = Date.now();
    if (now - _lastPlayedAt < COOLDOWN_MS) {
      log.info('[sfx] Cooldown active — skipping "' + rewardTitle + '"');
      return false;
    }
    _lastPlayedAt = now;
  }

  var url = SFX_MAP[key];
  _seqCounter++;
  log.info('[sfx] Playing "' + url + '" for reward "' + rewardTitle + '"' +
    (opts.fromGacha ? ' (from gacha)' : ''));

  updateSection('sfx', {
    url: url,
    volume: MASTER_VOLUME,
    seq: _seqCounter,
  });

  return true;
}

// ─── Plugin export ────────────────────────────────────────────────────────────

module.exports = {
  id: 'sfx',

  init(context) {
    var q = context.queue;
    if (typeof q?.onRedeem !== 'function') {
      log.warn('[sfx] context.queue not available — plugin will not fire');
      return;
    }
    q.onRedeem(function(redeem) {
      var title = redeem.title ?? redeem.reward?.title;
      if (!title) {
        log.warn('[sfx] Redeem event missing title — skipping. Keys:', Object.keys(redeem).join(', '));
        return;
      }
      // Pass _fromGacha flag so gacha-sourced redeems bypass the cooldown.
      // This is the fix for "when pulling multiple sfx, some don't play" —
      // a grid pull fires all SFX redeems at the 8000ms mark simultaneously,
      // and the 2000ms cooldown was blocking all but the first.
      handleRedeem(title, { fromGacha: !!redeem._fromGacha });
    });

    log.info('[sfx] Plugin loaded. Mapped rewards:', Object.keys(SFX_MAP).join(', '));
  },

  async processMessage(msg) {
    return { message: msg };
  },
};
