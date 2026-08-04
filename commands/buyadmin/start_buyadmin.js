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

  // ── Helper tampil menu admin panel ──────────────────────────────────
  async function showAdminPanelMenu(chatId, msgId) {
    const caption =
      `<blockquote>\n` +
      `👑 ADMIN PANEL\n` +
      `────────────────\n\n` +
      `<b>🔓 ADMIN PUBLIC</b>\n` +
      `⌯⌲ Full Akses Admin Pterodactyl\n` +
      `⌯⌲ Bisa membuat User Sendiri\n` +
      `⌯⌲ Bisa membuat Server Sendiri\n` +
      `⌯⌲ Harga 1 Bulan ${config.hargaownerpublic}\n` +
      `⌯⌲ Harga Permanen ${config.hargaownerpublicV2}\n\n` +
      `<b>🔓 ADMIN PRIVATE</b>\n` +
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
        [{ text: "ADMIN PANEL PUBLIC",  callback_data: "menu_adminpanelpublic" }],
        [{ text: "ADMIN PANEL PRIVATE", callback_data: "menu_adminprivate"     }],
        [{ text: "🔙 Kembali",         callback_data: "open_menupanel"            }]
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
      data === "start_admin"         ||
      data === "start_adminprivate"  ||
      data === "menu_adminpanelpublic" ||
      data === "menu_adminprivate"
    );
    if (!isOpCb) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    switch (data) {

      case "start_admin": {
        await showAdminPanelMenu(chatId, msgId);
        break;
      }

      // start_adminprivate langsung tampil info (dari menu_panel.js)
      case "start_adminprivate": {
        await bot.editMessageCaption(
          `🔒 <b>ADMIN PANEL PRIVATE</b>\n\n` +
          `Ketik /buyownerprivate untuk melanjutkan pembelian Admin Panel Private.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      case "menu_adminpanelpublic": {
        await bot.editMessageCaption(
          `🔓 <b>ADMIN PANEL PUBLIC</b>\n\n` +
          `Ketik /buyadmin untuk melanjutkan pembelian Admin Panel Public.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      case "menu_adminprivate": {
        await bot.editMessageCaption(
          `🔒 <b>ADMIN PANEL PRIVATE</b>\n\n` +
          `Ketik /buyownerprivate untuk melanjutkan pembelian Admin Panel Private.`,
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
