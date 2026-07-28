'use strict';

/**
 * Named dashboard action registry.
 * ────────────────────────────────────────────────────────────────────────────
 * Plugins that want their own dashboard buttons (e.g. the stream-title
 * plugin's "Apply" button) register an action handler here via
 * registerAction(name, handler). The dashboard's POST /dashboard/action
 * route dispatches the action by name.
 *
 * Handler signature: async (body) => object
 * The returned object is JSON-serialised and sent back to the browser.
 */

const log = require('../logger');

/** Handlers registered by plugins for named dashboard actions */
const _actionHandlers = new Map();

/**
 * Register a handler for a named action dispatched from a dashboard widget.
 *
 * The handler receives the full parsed request body and should return
 * a plain object; that object is JSON-serialised and sent back to the
 * browser as the response.
 *
 * @param {string}   name     Action name (e.g. 'set-stream-info')
 * @param {Function} handler  async (body) => object
 */
function registerAction(name, handler) {
  _actionHandlers.set(name, handler);
  log.info(`[dashboard] Action registered: ${name}`);
}

/**
 * HTTP route handler for POST /dashboard/action.
 * Expects JSON body: { action: string, ...payload }
 * Looks up the registered handler by `action` name and invokes it with
 * the full body. Returns the handler's result object as JSON.
 */
async function handleAction(req, res) {
  const { _readJsonBody } = require('./http-helpers');
  const body = await _readJsonBody(req);

  const { action } = body;
  let result;

  if (!action) {
    result = { ok: false, error: 'Missing required field: action' };
  } else {
    const handler = _actionHandlers.get(action);
    if (!handler) {
      result = { ok: false, error: `No handler registered for action: ${action}` };
      log.warn(`[dashboard] /action — unknown action: ${action}`);
    } else {
      try {
        result = await handler(body);
        log.info(`[dashboard] /action "${action}" → ok`);
      } catch (err) {
        result = { ok: false, error: err.message };
        log.error(`[dashboard] /action "${action}" threw:`, err.message);
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result ?? { ok: true }));
}

module.exports = {
  registerAction,
  handleAction,
};
