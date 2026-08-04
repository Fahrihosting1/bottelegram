const config = require("../../config");
const fs   = require("fs");
const path = require("path");

module.exports = (bot) => {

  function getBackKeyboard() {
    return {
      inline_keyboard: [
        [{ text: "🔙 Kembali", callback_data: "start_home" }]
      ]
    };
  }

  // ── Helper tampil menu owner panel ──────────────────────────────────
  async function showOwnerPanelMenu(chatId, msgId) {
    const caption =
      `<blockquote>\n` +
      `👑 OWNER PANEL\n` +
      `────────────────\n\n` +
      `<b>🔓 OWNER PUBLIC</b>\n` +
      `⌯⌲ Full Akses Admin Pterodactyl\n` +
      `⌯⌲ Bisa membuat User Sendiri\n` +
      `⌯⌲ Bisa membuat Server Sendiri\n` +
      `⌯⌲ Harga 1 Bulan ${config.hargaownerpublic}\n` +
      `⌯⌲ Harga Permanen ${config.hargaownerpublicV2}\n\n` +
      `<b>🔓 OWNER PRIVATE</b>\n` +
      `⌯⌲ Full Akses Admin Pterodactyl Private\n` +
      `⌯⌲ Bisa Membuat User Sendiri\n` +
      `⌯⌲ Bisa Membuat Server Sendiri\n` +
      `⌯⌲ Harga 1 Bulan ${config.hargaownerprivate}\n` +
      `⌯⌲ Harga Permanen ${config.hargaownerprivateV2}\n\n` +
      `${config.infostok}\n\n` +
      `Silahkan Pilih Button Di Bawah Ini\n` +
      `</blockquote>`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "OWNER PANEL PUBLIC",  callback_data: "buyownerpublic_bo"  }],
        [{ text: "OWNER PANEL PRIVATE", callback_data: "buyownerprivate_bo" }],
        [{ text: "🔙 Kembali",         callback_data: "open_menupanel"         }]
      ]
    };

    await bot.editMessageCaption(caption, {
      chat_id:      chatId,
      message_id:   msgId,
      parse_mode:   "HTML",
      reply_markup: keyboard
    }).catch(() => {});
  }

  // ── CALLBACK HANDLER ────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;

    const isOpCb = (
      data === "menu_buyowner"      ||
      data === "op_buypublic"       ||
      data === "op_buyprivate"
    );
    if (!isOpCb) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    switch (data) {

      case "menu_buyowner": {
        await showOwnerPanelMenu(chatId, msgId);
        break;
      }

      case "op_buypublic": {
        await bot.editMessageCaption(
          `🔓 <b>OWNER PANEL PUBLIC</b>\n\n` +
          `Ketik /buyowner untuk melanjutkan pembelian.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      case "op_buyprivate": {
        await bot.editMessageCaption(
          `🔓 <b>OWNER PANEL PRIVATE</b>\n\n` +
          `Ketik /buyownerprivate untuk melanjutkan pembelian.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      default:
        break;
    }
  });

};
