'use strict';

/**
 * secret-store.js
 * ──────────────
 * Central secret resolution for the webhook signature secrets (review W1:
 * "WebSub/EventSub signature secrets silently fall back to shipped defaults,
 * allowing forged redemption and subscriber events").
 *
 * Resolution order per secret:
 *   1. env var (if set and NOT equal to the shipped default) → use as-is.
 *   2. persisted value in src/.secrets.json (gitignored) → use as-is.
 *   3. otherwise → generate 48 random bytes (base64), persist to
 *      src/.secrets.json, and use it. Persisting matters: YouTube's hub and
 *      Twitch's EventSub verify HMACs against the secret used at subscribe
 *      time, so a fresh random secret on every boot would invalidate the
 *      existing subscription mid-lease.
 *
 * The shipped defaults ('change-me-please' etc.) are NEVER used: if the env
 * var carries exactly the default, we treat it as unset. A clear startup
 * banner tells the operator which source each secret came from.
 *
 * File location: src/.secrets.json (next to this module), NOT the cwd —
 * same class of bug as the 0yt-points POINTS_FILE issue (review Ch.6).
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const log    = require('./logger');

const SECRETS_FILE = path.join(__dirname, '.secrets.json');

function _loadStore() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function _saveStore(store) {
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, SECRETS_FILE);
}

/**
 * @param {string} envName   env var to consult (e.g. 'WEBSUB_SECRET')
 * @param {string} key       store key (e.g. 'websub')
 * @param {string} shippedDefault  the literal default that must never be used
 * @returns {string} a non-default secret
 */
function resolveSecret(envName, key, shippedDefault) {
  const fromEnv = process.env[envName];

  // 1. Explicit, non-default env value wins.
  if (fromEnv && fromEnv !== shippedDefault) {
    log.info(`[secrets] ${envName}: using value from environment.`);
    return fromEnv;
  }

  // 2. Persisted secret from a previous boot.
  const store = _loadStore();
  if (store[key]) {
    if (fromEnv === shippedDefault) {
      log.warn(`[secrets] ${envName} is still the shipped default — ignoring it in favour of the generated ${SECRETS_FILE} secret.`);
    } else {
      log.info(`[secrets] ${envName}: unset — using generated secret from ${path.basename(SECRETS_FILE)}.`);
    }
    return store[key];
  }

  // 3. Generate + persist.
  const generated = crypto.randomBytes(48).toString('base64');
  store[key] = generated;
  _saveStore(store);
  log.info(`[secrets] ${envName}: unset — generated a new random secret and saved it to ${SECRETS_FILE} (gitignored). Signature verification is now secure.`);
  return generated;
}

/** Test/ops helper: path of the persisted store. */
function secretsFilePath() { return SECRETS_FILE; }

module.exports = { resolveSecret, secretsFilePath };
