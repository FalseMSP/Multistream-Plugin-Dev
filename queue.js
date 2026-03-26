'use strict';

/**
 * In-memory async queue.
 * Producers call queue.pushMessage() / queue.pushRedeem().
 * Discord module registers callbacks via queue.onMessage() / queue.onRedeem().
 */

const log = require('./logger');

const MAX = 500;

let _onMessage = null;
let _onRedeem  = null;

const msgBuffer    = [];
const redeemBuffer = [];

function _drain(buffer, handler) {
  while (buffer.length) handler(buffer.shift()).catch((e) => log.error('Queue drain error:', e));
}

module.exports = {
  onMessage(fn) {
    _onMessage = fn;
    _drain(msgBuffer, fn);
  },
  onRedeem(fn) {
    _onRedeem = fn;
    _drain(redeemBuffer, fn);
  },

  /**
   * @param {{ platform: 'twitch'|'youtube', username: string, message: string, color?: string }} msg
   */
  pushMessage(msg) {
    if (_onMessage) {
      _onMessage(msg).catch((e) => log.error('onMessage error:', e));
    } else {
      if (msgBuffer.length >= MAX) { log.warn('Message queue full — dropping'); return; }
      msgBuffer.push(msg);
    }
  },

  /**
   * @param {{ username: string, title: string, cost: number, input?: string, timestamp: Date }} redeem
   */
  pushRedeem(redeem) {
    if (_onRedeem) {
      _onRedeem(redeem).catch((e) => log.error('onRedeem error:', e));
    } else {
      if (redeemBuffer.length >= MAX) { log.warn('Redeem queue full — dropping'); return; }
      redeemBuffer.push(redeem);
    }
  },
};
