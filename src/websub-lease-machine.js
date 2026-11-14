'use strict';

/**
 * websub-lease-machine.js
 * ────────────────────────
 * The WebSub subscription lifecycle, expressed as an explicit finite-state
 * machine instead of websub.js's `while (true) { sleep(lease-1h); renew(); }`
 * loop. The legacy loop hides a real state machine:
 *
 *   unsubscribed ──SUBSCRIBE──▶ subscribing ──ACCEPTED──▶ subscribed
 *        ▲                          │                         │
 *        │                          └──REJECTED──▶ failed     │ (lease-3600s)
 *        │                                                    ▼
 *        └──────────────── RENEW ◀────────────── renewing ◀──TIMER
 *                                    │
 *                                    ├──ACCEPTED──▶ subscribed (lease extended)
 *                                    └──REJECTED──▶ failed (retry with backoff)
 *
 * `failed` auto-retries SUBSCRIBE with exponential backoff (the legacy code
 * never retried a failed renewal: a single failed POST meant YouTube push
 * notifications silently stopped until the next process restart).
 *
 * Usage (see src/websub.js wiring):
 *   const { createLeaseMachine } = require('./websub-lease-machine');
 *   const lease = createLeaseMachine({ clock: realClock, subscribe: ytSubscribeFn, ... });
 *   lease.start(channelId);   // fires SUBSCRIBE
 *
 * The machine emits 'lease-state' frames via the sink so a future dashboard
 * connections-widget can render YouTube push status (green/amber/red).
 */

const { Machine } = require('./fsm');

const LEASE_SECONDS = 86400;          // 24 h, matches websub.js
const RENEW_MARGIN_S = 3600;          // renew 1 h before expiry, matches websub.js
const BACKOFF_BASE_MS = 30 * 1000;    // first retry after 30 s
const BACKOFF_MAX_MS = 30 * 60 * 1000;// cap at 30 min

/**
 * @param {object} cfg
 *   clock:     fsm clock (real or ManualClock)
 *   subscribe(channelId): async fn — performs the hub POST (ytSubscribe)
 *   onLog(fn): log sink, default no-op
 *   onState(state, meta): optional observer for dashboard surfacing
 *   leaseSeconds / renewMarginS / backoff: overrides for tests
 */
function createLeaseMachine(cfg) {
  const clock     = cfg.clock; // required — real clock from ../fsm REAL_CLOCK
  const subscribe = cfg.subscribe;
  const doLog     = cfg.onLog || (() => {});
  const leaseS    = cfg.leaseSeconds ?? LEASE_SECONDS;
  const marginS   = cfg.renewMarginS ?? RENEW_MARGIN_S;
  const backoff   = cfg.backoff ?? { baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS };

  if (typeof subscribe !== 'function') throw new Error('lease machine: subscribe fn is required');
  if (!clock) throw new Error('lease machine: clock is required');

  let channelId = null;
  let failures  = 0;

  function attempt(kind) {
    // Fire the actual hub POST asynchronously; the result comes back to the
    // machine as ACCEPTED / REJECTED events. Errors are logged, never thrown.
    Promise.resolve()
      .then(() => subscribe(channelId))
      .then(() => { m.send('ACCEPTED', { kind }); })
      .catch(err => {
        doLog(`[WebSub] ${kind} error: ${err && err.message}`);
        m.send('REJECTED', { kind, error: err && err.message });
      });
  }

  const m = new Machine('websub-lease', {
    initial: 'unsubscribed',
    states: {

      unsubscribed: {
        on: {
          SUBSCRIBE: {
            target: 'subscribing',
            effect: () => attempt('subscribe'),
          },
        },
      },

      subscribing: {
        on: {
          ACCEPTED: { target: 'subscribed', effect: () => { failures = 0; } },
          REJECTED: { target: 'failed' },
        },
      },

      subscribed: {
        // Renew RENEW_MARGIN_S before the lease expires (legacy timing).
        after: { ms: (leaseS - marginS) * 1000, event: 'TIMER' },
        on: {
          TIMER:   {
            target: 'renewing',
            effect: () => attempt('renew'),
          },
          REVOKED: { target: 'unsubscribed' }, // hub revoked us — resubscribe
          // A manual renewal request (e.g. dashboard "renew now" button).
          RENEW:   {
            target: 'renewing',
            effect: () => attempt('renew'),
          },
        },
      },

      renewing: {
        on: {
          ACCEPTED: { target: 'subscribed', effect: () => { failures = 0; } },
          REJECTED: { target: 'failed' },
        },
      },

      failed: {
        // Retry with exponential backoff. The legacy code had NO retry: a
        // single failed renewal silently killed push notifications until
        // the next process restart.
        after: {
          ms: () => Math.min(backoff.baseMs * Math.pow(2, failures), backoff.maxMs),
          event: 'RETRY',
        },
        on: {
          RETRY: {
            target: 'subscribing',
            effect: () => { failures += 1; attempt('retry'); },
          },
        },
      },
    },
  }, {
    clock,
    onTransition: (machine, event, payload, from, to) => {
      if (cfg.onState) {
        try { cfg.onState(to, { from, event, failures, channelId }); }
        catch (e) { doLog(`[WebSub] onState observer threw: ${e.message}`); }
      }
    },
  });

  return {
    machine: m,
    /** Start the subscription flow for a channel. */
    start(id) { channelId = id; m.send('SUBSCRIBE', { channelId: id }); },
    /** Force a renewal now (dashboard action). */
    renewNow() { m.send('RENEW'); },
    get state() { return m.state; },
  };
}

module.exports = {
  createLeaseMachine,
  LEASE_SECONDS,
  RENEW_MARGIN_S,
};
