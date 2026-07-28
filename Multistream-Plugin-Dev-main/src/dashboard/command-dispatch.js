'use strict';

/**
 * Slash-command dispatcher.
 * ────────────────────────────────────────────────────────────────────────────
 * The dashboard's command panel lets the operator run any registered slash
 * command (core /ban /vip /unvip OR any plugin command) from the browser.
 *
 * We build a minimal synthetic discord.js interaction object that mimics
 * the surface area plugins actually touch — getString, getInteger,
 * getSubcommand, deferReply, reply, editReply, followUp — then route it
 * through discord.dispatchCommand(), which forwards to the right plugin.
 *
 * All replies emitted by the plugin are collected into an array and
 * returned to the browser as JSON.
 *
 * Lazy-requires discord.js to avoid a circular-import crash at boot
 * (discord.js → plugins → dashboard → discord.js).
 */

const log = require('../logger');
const { _readJsonBody, _resolveContent } = require('./http-helpers');

/**
 * Build a fake discord.js ChatInputCommandInteraction that captures every
 * reply the plugin emits into the `replies` array.
 *
 * @param {string} name                Command name
 * @param {Record<string, *>} optionValues  Map of option name → value
 * @param {string[]} replies           Out-param: collected reply strings
 */
function _buildFakeInteraction(name, optionValues, replies) {
  return {
    // Identity — plugins log interaction.user.tag
    user: {
      tag:      'dashboard#0000',
      id:       '0',
      username: 'dashboard',
      bot:      false,
    },
    member: null,
    guild:  null,

    // Options — covers getString / getInteger / getBoolean / getUser /
    //           getRole / getChannel / getNumber / getMentionable
    options: {
      _values: optionValues,
      getString(name, _required)      { return optionValues[name] ?? null; },
      getInteger(name, _required)     { const v = optionValues[name]; return v != null ? parseInt(v, 10)   : null; },
      getNumber(name, _required)      { const v = optionValues[name]; return v != null ? parseFloat(v)     : null; },
      getBoolean(name, _required)     { const v = optionValues[name]; return v != null ? v === true || v === 'true' : null; },
      getUser(name, _required)        { return optionValues[name] ?? null; },
      getRole(name, _required)        { return optionValues[name] ?? null; },
      getChannel(name, _required)     { return optionValues[name] ?? null; },
      getMentionable(name, _required) { return optionValues[name] ?? null; },
      get(name, _required)            { return optionValues[name] ?? null; },
      // Subcommand support
      getSubcommand(_required)        { return optionValues._subcommand ?? null; },
      getSubcommandGroup(_required)   { return optionValues._subcommandGroup ?? null; },
    },

    // Reply lifecycle — collect everything into `replies`
    deferred: false,
    replied:  false,
    async deferReply(_opts)    { this.deferred = true; },
    async deferUpdate(_opts)   { this.deferred = true; },
    async reply(payload)       { this.replied = true; replies.push(_resolveContent(payload)); },
    async editReply(payload)   { replies.push(_resolveContent(payload)); },
    async followUp(payload)    { replies.push(_resolveContent(payload)); },
    async deleteReply()        { /* no-op */ },

    // Misc surface that plugins sometimes touch
    channelId:   null,
    guildId:     null,
    commandName: name,
    isCommand()    { return true; },
    isRepliable()  { return true; },
    inGuild()      { return false; },
  };
}

/**
 * HTTP route handler for POST /dashboard/command.
 * Expects JSON body in either shape:
 *   { name, options: { optionName: value, … } }            — new shape
 *   { name, user, reason, platform }                       — legacy flat shape
 *
 * Returns JSON: { ok: true, results: string[] }
 */
async function handleCommand(req, res) {
  const body = await _readJsonBody(req);

  // Support both legacy flat shape { name, user, reason, platform }
  // and new shape { name, options: { optionName: value, … } }
  const { name } = body;
  const optionValues = body.options
    ? { ...body.options }
    : { user: body.user, reason: body.reason, platform: body.platform };

  let results;
  if (!name) {
    results = ['⚠️ Missing required field: name'];
  } else {
    try {
      const discord = require('../discord'); // lazy require to avoid circular

      const replies = [];
      const interaction = _buildFakeInteraction(name, optionValues, replies);

      await discord.dispatchCommand(name, interaction);
      results = replies.length ? replies : ['✅ Command completed (no reply)'];
      log.info(`[dashboard] /command /${name}: ${results.join(' | ')}`);
    } catch (err) {
      results = ['❌ Command dispatch error: ' + err.message];
      log.error('[dashboard] /command error:', err.message);
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, results }));
}

module.exports = {
  handleCommand,
  _buildFakeInteraction, // exported for tests
};
