'use strict';

module.exports = {
  id: 'discord-link',

  async processMessage(msg) {
    if (msg.message.trim().toLowerCase() === '!discord') {
      return {
        message: msg,
        sideEffect: async () => {
          await msg.reply?.(`Join the Discord: https://discord.gg/jBSNayWUrX`);
        },
      };
    }
    return { message: msg };
  },
};
