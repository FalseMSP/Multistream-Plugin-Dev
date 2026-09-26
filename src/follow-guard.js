'use strict';

/**
 * follow-guard.js
 * ───────────────
 * Twitch fires `channel.follow` every time a user follows the channel —
 * including a *re*-follow after they previously unfollowed. Nothing in the
 * event payload distinguishes a brand-new follower from someone farming the
 * follow-triggered pipeline (TNT points, gacha-at-home pulls, the event
 * feed, Discord announcements, sub-counter bump, etc.) by unfollowing and
 * re-following.
 *
 * This module remembers every Twitch user_id that has already been credited
 * for a follow and lets twitch.js skip pushing the donation event for
 * repeats, so the follow reward pipeline only ever fires once per account.
 *
 * user_id (not user_name/login) is used as the key — it's stable across
 * username changes, unlike the display name.
 *
 * Persistence: src/follow-guard-known.json
 *   { "credited": ["123456789", "987654321", ...] }
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const DATA_PATH = path.join(__dirname, 'follow-guard-known.json');

/** @type {Set<string>} Twitch user IDs already credited for a follow. */
const _credited = new Set();

function _load() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      if (Array.isArray(raw.credited)) raw.credited.forEach(id => _credited.add(String(id)));
      log.info(`[follow-guard] Loaded ${_credited.size} previously-credited follower(s).`);
    }
  } catch (err) {
    log.error('[follow-guard] Failed to load follow-guard-known.json:', err.message);
  }
}

function _save() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ credited: [..._credited] }, null, 2), 'utf8');
  } catch (err) {
    log.error('[follow-guard] Failed to save follow-guard-known.json:', err.message);
  }
}

_load();

/**
 * Check whether a channel.follow event should trigger the follow reward
 * pipeline, and record it if so. Call this once per channel.follow event,
 * BEFORE calling queue.pushDonation.
 *
 * @param {string} userId     Twitch numeric user ID (event.user_id).
 * @param {string} [username] Display name, used only for logging.
 * @returns {boolean} true the FIRST time a given userId is seen — the
 *   pipeline should fire. false on any repeat (unfollow → refollow) — the
 *   pipeline should be skipped.
 */
function shouldTriggerFollowPipeline(userId, username) {
  const id = userId != null ? String(userId) : null;

  if (!id) {
    // channel.follow v2 always includes user_id, but fail open rather than
    // silently eating a legitimate follow if that ever isn't true.
    log.warn(`[follow-guard] Follow event with no user_id (username=${username ?? '?'}) — allowing through.`);
    return true;
  }

  if (_credited.has(id)) {
    log.info(
      `[follow-guard] Duplicate follow from ${username ?? id} — already credited previously, ` +
      `refollow detected, follow reward pipeline skipped.`
    );
    return false;
  }

  _credited.add(id);
  _save();
  return true;
}

module.exports = { shouldTriggerFollowPipeline };