'use strict';

/**
 * fsm.js
 * ──────
 * A small, dependency-free, explicit finite-state-machine core.
 *
 * Why this exists
 * ───────────────
 * The codebase is full of logic that is *implicitly* a state machine but
 * written as booleans + scattered setTimeout/setInterval calls: the gacha
 * pull choreography (`_pullActive` + two timers + a queue), the WebSub
 * lease lifecycle (subscribe → renew loop → revoked, expressed as a
 * `while(true)` + sleep), the stopwatch run/pause model, the overlay
 * client's pulling→result→idle handling. That style works until it drifts:
 * you cannot look at it and enumerate the legal transitions, you cannot
 * assert on it, and every variant copy (gacha vs gacha-at-home) re-implements
 * the same hidden machine slightly differently.
 *
 * This module makes those machines explicit and testable:
 *   • states, events and transitions are declared in a table;
 *   • guards decide whether an event fires in the current state;
 *   • effects run on transition (including timers that auto-fire events);
 *   • every transition is recorded in a bounded audit log;
 *   • an unexpected event in a state is a *logged* no-op, not a crash.
 *
 * Design rules
 * ────────────
 *  • No dependencies. Plain Node.
 *  • Timer-driven machines are first-class: declare `after: { ms, event }`
 *    on a state and the core schedules/fires/clears it on transitions.
 *    All timers go through an injectable clock so tests run instantly.
 *  • The machine never throws on bad input — plugin code runs inside a
 *    live bot; a malformed event must not take chat down with it.
 *
 * Usage
 * ─────
 *   const { Machine } = require('./fsm');
 *   const m = new Machine('pull', {
 *     initial: 'idle',
 *     states: {
 *       idle: {
 *         on: { PULL: { target: 'pulling', effect: ctx => start(ctx) } },
 *       },
 *       pulling: {
 *         on: { REVEAL: 'result', CANCEL: 'idle' },
 *         after: { ms: 8000, event: 'REVEAL' },
 *       },
 *       result: {
 *         on: { DONE: 'idle' },
 *         after: { ms: 6000, event: 'DONE' },
 *       },
 *     },
 *   }, { clock: myClock });
 *   m.send('PULL', { user: 'x' });
 *
 * Transition table entry shapes (per state, per event):
 *   'stateName'                      → shorthand, no guard/effect
 *   { target, guard?, effect? }      → full form
 * `target: null` / omitted means "stay" (internal/self transition).
 */

// ── Injectable clock ────────────────────────────────────────────────────────
// Tests pass a manual clock; production uses the real setTimeout/clearTimeout.

const REAL_CLOCK = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  now: () => Date.now(),
};

/**
 * A deterministic manual clock for tests: time only advances when the test
 * calls clock.advance(ms).
 */
class ManualClock {
  constructor() { this._t = 0; this._timers = []; this._id = 1; this.now = this.now.bind(this); }
  setTimeout(fn, ms) {
    const id = this._id++;
    this._timers.push({ id, fn, at: this._t + ms });
    return id;
  }
  clearTimeout(id) {
    const i = this._timers.findIndex(t => t.id === id);
    if (i >= 0) this._timers.splice(i, 1);
  }
  now() { return this._t; }
  /** Fire every timer due at or before t+ms, in due-time order. */
  advance(ms) {
    const target = this._t + ms;
    for (;;) {
      // Find the earliest timer at or before the target.
      let next = null;
      for (const t of this._timers) {
        if (t.at <= target && (next === null || t.at < next.at)) next = t;
      }
      if (next === null) break;
      // Remove it, advance virtual time to its due time, fire it. Firing may
      // schedule new timers (possibly also due) — the loop picks them up.
      const i = this._timers.indexOf(next);
      this._timers.splice(i, 1);
      this._t = Math.max(this._t, next.at);
      try { next.fn(); } catch (e) { /* a broken callback must not stall the clock */ }
    }
    this._t = target;
  }
  get pending() { return this._timers.length; }
}

// ── Errors ──────────────────────────────────────────────────────────────────

class TransitionError extends Error {
  constructor(machineName, state, event, reason) {
    super(`[${machineName}] event ${event} invalid in state ${state}: ${reason}`);
    this.name = 'TransitionError';
    this.machine = machineName;
    this.state = state;
    this.event = event;
  }
}

// ── Machine ─────────────────────────────────────────────────────────────────

const MAX_LOG = 200;

class Machine {
  /**
   * @param {string} name         — for logs; also used as machine key
   * @param {object} definition   — { initial, states, auto?: (m) => void }
   * @param {object} [opts]       — { clock?, log?, onTransition? }
   */
  constructor(name, definition, opts = {}) {
    this.name       = name;
    this.definition = definition;
    this.clock      = opts.clock ?? REAL_CLOCK;
    this._log       = opts.log ?? require('./logger');
    this._onTransition = opts.onTransition ?? null;

    const states = definition.states || {};
    if (!states[definition.initial]) {
      throw new Error(`[${name}] initial state "${definition.initial}" is not defined`);
    }
    for (const [sname, sdef] of Object.entries(states)) {
      if (sdef && typeof sdef.after === 'object' && sdef.after !== null) {
        const ms = typeof sdef.after.ms === 'function' ? sdef.after.ms() : sdef.after.ms;
        if (!Number.isFinite(ms)) {
          throw new Error(`[${name}] state "${sname}": after.ms must be a number or a function returning one`);
        }
        if (!sdef.after.event) {
          throw new Error(`[${name}] state "${sname}": after.event is required`);
        }
      }
    }

    this.state      = definition.initial;
    this.context    = {};              // scratch data for effects/guards
    this._timerId   = null;            // active `after` timer, if any
    this._timerFor  = null;            // state the timer was armed in
    this._history   = [];              // bounded audit log
    this._listeners = new Map();       // external observers: event -> [fn]

    this._armStateTimer(this.state);
    if (typeof definition.auto === 'function') definition.auto(this);
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  get timerArmed() { return this._timerId !== null; }
  is(state) { return this.state === state; }
  can(event) { return this._resolve(event).ok; }

  /** Bounded transition audit log, newest last. */
  history() { return this._history.slice(); }
  lastTransition() { return this._history[this._history.length - 1] || null; }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Fire an event. Returns true if a transition (including a self-transition
   * with effect) occurred, false if the event was ignored (undeclared in the
   * current state, or blocked by a guard). Never throws for machine-level
   * problems; effect errors are logged and swallowed so one bad effect
   * cannot kill the bot's chat pipeline.
   *
   * @param {string} event
   * @param {object} [payload] — merged into context for guards/effects
   * @returns {boolean}
   */
  send(event, payload) {
    const resolved = this._resolve(event);
    if (!resolved.ok) {
      this._record(event, payload, this.state, this.state, 'ignored');
      this._log.warn(`[${this.name}] ignored event ${event} in state ${this.state}`);
      return false;
    }
    if (resolved.guarded) {
      this._record(event, payload, this.state, this.state, 'blocked-by-guard');
      return false;
    }

    const from  = this.state;
    const entry = resolved.entry;
    const target = (entry && typeof entry === 'object' && entry.target !== undefined)
      ? entry.target
      : (typeof entry === 'string' ? entry : from);

    if (target !== null && target !== undefined && !(target in this.definition.states)) {
      // A transition table bug (not runtime input). Log loudly, refuse to move.
      this._log.error(`[${this.name}] transition ${event}: undefined target state "${target}" — staying in ${from}`);
      this._record(event, payload, from, from, 'bad-target');
      return false;
    }

    // Leaving `from`: clear its timer.
    if (from !== target || true) this._disarmStateTimer();

    this.context = { ...this.context, ...(payload || {}) };

    // Self-transitions re-run the state's `after` timer by design: entering
    // a state always arms its timer.
    this.state = target === null || target === undefined ? from : target;

    this._record(event, payload, from, this.state, 'ok');

    if (typeof this._onTransition === 'function') {
      try { this._onTransition(this, event, payload, from, this.state); } catch (e) {
        this._log.error(`[${this.name}] onTransition hook threw: ${e.message}`);
      }
    }

    const effect = (entry && typeof entry === 'object') ? entry.effect : null;
    if (typeof effect === 'function') {
      try { effect(this.context, this); } catch (e) {
        this._log.error(`[${this.name}] effect for ${event} threw: ${e.message}`);
      }
    }

    // Entering the (possibly same) target state: arm its timer.
    if (this.definition.states[this.state] && this.definition.states[this.state].after) {
      this._armStateTimer(this.state);
    }

    this._emit(event, payload, from, this.state);
    return true;
  }

  /** External observer: fn(machine, event, payload, from, to). */
  on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    const arr = this._listeners.get(event);
    arr.push(fn);
    return () => { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); };
  }

  /** Force the machine into a state without running effects (tests/recovery). */
  _force(state) {
    if (!(state in this.definition.states)) return;
    this._disarmStateTimer();
    this.state = state;
    this._record('__force__', null, null, state, 'forced');
    this._armStateTimer(state);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _resolve(event) {
    const sdef = this.definition.states[this.state] || {};
    const on = sdef.on || {};
    if (!(event in on)) return { ok: false };
    const entry = on[event];
    const guard = (entry && typeof entry === 'object' && typeof entry.guard === 'function')
      ? entry.guard : null;
    let guarded = false;
    if (guard) {
      try { guarded = !guard(this.context, this); }
      catch (e) { this._log.error(`[${this.name}] guard for ${event} threw: ${e.message}`); guarded = true; }
    }
    return { ok: true, entry, guarded };
  }

  _armStateTimer(state) {
    const after = this.definition.states[state] && this.definition.states[state].after;
    if (!after) return;
    this._disarmStateTimer();
    // `ms` may be a number or a function(ctx-less) returning one — dynamic
    // delays (e.g. exponential backoff) are evaluated at arm time, so a
    // re-entered state picks up a fresh delay.
    const ms = typeof after.ms === 'function' ? after.ms() : after.ms;
    if (!Number.isFinite(ms)) return;
    this._timerFor = state;
    this._timerId = this.clock.setTimeout(() => {
      this._timerId = null;
      this._timerFor = null;
      this.send(after.event, { __timed: true });
    }, ms);
  }

  _disarmStateTimer() {
    if (this._timerId !== null) {
      this.clock.clearTimeout(this._timerId);
      this._timerId = null;
      this._timerFor = null;
    }
  }

  _record(event, payload, from, to, outcome) {
    this._history.push({
      t: this.clock.now(), event, from, to, outcome,
      payload: payload === undefined ? null : '(payload)',
    });
    if (this._history.length > MAX_LOG) this._history.shift();
  }

  _emit(event, payload, from, to) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    for (const fn of arr.slice()) {
      try { fn(this, event, payload, from, to); } catch (e) {
        this._log.error(`[${this.name}] listener for ${event} threw: ${e.message}`);
      }
    }
  }
}

/**
 * Build several machines that share an injectable clock — handy when
 * machines must interleave deterministically in tests.
 */
function buildMachines(defs, opts = {}) {
  const clock = opts.clock ?? new ManualClock();
  const machines = {};
  for (const [name, definition] of Object.entries(defs)) {
    machines[name] = new Machine(name, definition, { ...opts, clock });
  }
  return { machines, clock };
}

module.exports = {
  Machine,
  ManualClock,
  REAL_CLOCK,
  TransitionError,
  buildMachines,
};
