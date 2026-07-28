'use strict';

/**
 * Backward-compat shim.
 * ────────────────────────────────────────────────────────────────────────────
 * The dashboard implementation now lives under src/dashboard/ as a set of
 * focused modules. This file remains so existing `require('./dashboard')`
 * call sites across the codebase (and across plugins) keep working without
 * any path changes.
 *
 * New code should still `require('./dashboard')` — the public API is
 * unchanged. If you're looking for the implementation, it's in
 * src/dashboard/index.js (and its sibling modules).
 */

module.exports = require('./dashboard/index');
