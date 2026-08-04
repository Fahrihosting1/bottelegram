const { getSaldo } = require("../../lib/pakasir");
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

  // ── Helper tampil menu pilih panel ──────────────────────────────────
  async function showPanelMenu(chatId, msgId) {
    const caption =
      `<blockquote>\n` +
      `👑 PILIH JENIS PANEL\n` +
      `────────────────\n\n` +
      `<b>🔓 PANEL PUBLIC</b>\n` +
      `⌯⌲ Untuk pengguna umum\n` +
      `⌯⌲ Harga lebih terjangkau\n` +
      `⌯⌲ Garansi 7 Hari\n\n` +
      `<b>🔓 PANEL PRIVATE</b>\n` +
      `⌯⌲ Private / eksklusif\n` +
      `⌯⌲ Hanya Untuk anda sendiri\n` +
      `⌯⌲ Performa lebih baik\n` +
      `⌯⌲ Garansi 30 Hari\n\n` +
      `Silahkan Pilih Button Di Bawah Ini\n` +
      `</blockquote>`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "PANEL PUBLIC",  callback_data: "menu_panel"        }],
        [{ text: "PANEL PRIVATE", callback_data: "menu_panelprivate" }],
        [{ text: "🔙 Kembali",   callback_data: "open_menupanel"        }]
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
      data === "menu_buypanel"   ||
      data === "op_buypublic"    ||
      data === "op_buyprivate"
    );
    if (!isOpCb) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    switch (data) {

      case "menu_buypanel": {
        await showPanelMenu(chatId, msgId);
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
