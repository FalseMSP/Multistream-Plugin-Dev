'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function fmt(level, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  console[level === 'error' ? 'error' : 'log'](
    `${ts} [${level.toUpperCase().padEnd(5)}]`, ...args
  );
}

module.exports = {
  debug: (...a) => current <= LEVELS.debug && fmt('debug', ...a),
  info:  (...a) => current <= LEVELS.info  && fmt('info',  ...a),
  warn:  (...a) => current <= LEVELS.warn  && fmt('warn',  ...a),
  error: (...a) => current <= LEVELS.error && fmt('error', ...a),
};
