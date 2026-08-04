const { getSaldo, getTotalUsers, getTelegramUser } = require("../../lib/pakasir");
const supabase = require("../../lib/supabase");
const { blockCallbackIfDisabled } = require("../../lib/features");
const fs   = require("fs");
const path = require("path");

// ── Hitung uptime bot sejak proses dimulai ──────────────────────────
const BOT_START_TIME = Date.now();

function getUptime() {
  const ms      = Date.now() - BOT_START_TIME;
  const days    = Math.floor(ms / 86400000);
  const hours   = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000)  / 60000);
  return `${days}d ${hours}h ${minutes}m`;
}

function formatRupiah(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

// ── Keyboard utama (dipakai di /menu_panel dan start_kembali) ────────
function getMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Buy Vps Linode",  callback_data: "ln_buyvpslinode"  },
        { text: "Buy Vps Digital Ocean",  callback_data: "do_buyvpsdo"  }
      ]
    ]
  };
}

// ── Keyboard dengan tombol 🔙 Kembali ────────────────────────────────
function getBackKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔙 Kembali", callback_data: "open_menupanel" }]
    ]
  };
}

// ── Build caption halaman utama ──────────────────────────────────────
async function buildMainCaption(from, botId) {
  const userId = String(from.id);
  const sep    = "────────────────────";

  const [saldo, totalUser, trxResult] = await Promise.all([
    getSaldo(userId).catch(() => 0),
    getTotalUsers(botId).catch(() => 0),
    supabase
      .from("transactions")
      .select("amount, status, type")
      .then(({ data }) => {
        if (!data) return { total: 0, pemasukan: 0 };
        const completed = data.filter(t => t.status === "completed" && t.type !== "deposit");
        return {
          total:     data.length,
          pemasukan: completed.reduce((s, t) => s + Number(t.amount || 0), 0)
        };
      })
      .catch(() => ({ total: 0, pemasukan: 0 }))
  ]);

  const namaDepan    = from.first_name || "-";
  const namaBelakang = from.last_name  || "\\-";
  const saldoStr     = formatRupiah(saldo);

  const caption =
    `<blockquote>` +
    `Hallo, <b>${namaDepan} ${namaBelakang}</b> 👋\n` +
    `Selamat Datang Di <b>Biyuu Official - Auto Order</b>\n` +
    `${sep}\n\n` +

    `🤖 <b>Informasi Profile Bot</b>\n` +
    `⌯⌲ Runtime: ${getUptime()}\n` +
    `⌯⌲ Total User: ${totalUser}\n` +
    `⌯⌲ Version: AutoOrder Vps Otomatis\n` +
    `⌯⌲ Total Pemasukan: ${formatRupiah(trxResult.pemasukan)}\n` +
    `⌯⌲ Total Transaksi: ${trxResult.total} transaksi\n` +
    `${sep}\n\n` +

    `🪪 <b>Informasi Profil Anda</b>\n` +
    `⌯⌲ ID: <code>${userId}</code>\n` +
    `⌯⌲ Nama Depan: ${namaDepan}\n` +
    `⌯⌲ Nama Belakang: ${namaBelakang}\n` +
    `⌯⌲ Saldo Anda: ${saldoStr}\n` +
    `${sep}\n\n` +

    `Silahkan Pilih Produk Yang Tersedia\nDibawah Ini` +
    `</blockquote>`;

  return caption;
}

module.exports = (bot) => {

  // ===== CALLBACK open_menupanel =====
  // Trigger tombol ini dari file lain dengan: callback_data: "open_menupanel"
  bot.on("callback_query", async (query) => {
    if (query.data !== "open_buyvps") return;

    if (await blockCallbackIfDisabled(bot, "buy_vps", query)) return;

    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    const caption  = await buildMainCaption(query.from, bot.id);
    const keyboard = getMainKeyboard();

    // Tambahkan tombol Kembali ke keyboard utama
    keyboard.inline_keyboard.push([
      { text: "🔙 Kembali", callback_data: "open_menupanel" }
    ]);

    await bot.editMessageCaption(caption, {
      chat_id:      chatId,
      message_id:   msgId,
      parse_mode:   "HTML",
      reply_markup: keyboard
    }).catch((e) => console.warn("[open_buyvps] editCaption gagal:", e.message));
  });

  // ===== CALLBACK HANDLER =====
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;

    if (!data.startsWith("start_")) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    switch (data) {

      // ── Panel Biasa ──────────────────────────────────────────────
      case "start_panelbiasa": {
        await bot.editMessageCaption(
          `🛒 <b>PANEL BIASA</b>\n\n` +
          `Ketik /buypanel untuk melanjutkan pembelian.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      // ── Panel Legal ──────────────────────────────────────────────
      case "start_panellegal": {
        await bot.editMessageCaption(
          `🛒 <b>PANEL LEGAL</b>\n\n` +
          `Ketik /buypanelprivate untuk melanjutkan pembelian.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      // ── Owner Panel ──────────────────────────────────────────────
      case "start_ownerpanel": {
        await bot.editMessageCaption(
          `👑 <b>OWNER PANEL</b>\n\n` +
          `Ketik /buyowner untuk Owner Public\n` +
          `atau /buyownerprivate untuk Owner Private.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      // ── Jasa Install Panel ───────────────────────────────────────
      case "start_jasainstall": {
        await bot.editMessageCaption(
          `🛠️ <b>JASA INSTALL PANEL</b>\n\n` +
          `Ketik /buyinstallpanel untuk melanjutkan.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      // ── Cek Saldo ────────────────────────────────────────────────
      case "start_ceksaldo": {
        const userId = String(query.from.id);
        try {
          const saldo     = await getSaldo(userId);
          const formatted = formatRupiah(saldo);
          const sep       = "────────────────────";

          await bot.editMessageCaption(
            `💰 <b>CEK SALDO</b>\n` +
            `${sep}\n\n` +
            `👤 User ID : <code>${userId}</code>\n` +
            `💵 Saldo   : <b>${formatted}</b>\n\n` +
            `${sep}\n` +
            `Gunakan /deposit untuk isi saldo.`,
            {
              chat_id:      chatId,
              message_id:   msgId,
              parse_mode:   "HTML",
              reply_markup: getBackKeyboard()
            }
          ).catch(() => {});
        } catch (err) {
          await bot.editMessageCaption(
            `❌ Gagal mengambil saldo: ${err.message}`,
            {
              chat_id:      chatId,
              message_id:   msgId,
              parse_mode:   "HTML",
              reply_markup: getBackKeyboard()
            }
          ).catch(() => {});
        }
        break;
      }

      // ── Cara Order ───────────────────────────────────────────────
      case "start_caraorder": {
        const sep = "────────────────────";

        await bot.editMessageCaption(
          `🆘 <b>CARA ORDER</b>\n` +
          `${sep}\n\n` +
          `1️⃣ Isi saldo terlebih dahulu\n` +
          `   👉 Gunakan /deposit\n\n` +
          `2️⃣ Pilih produk yang diinginkan:\n` +
          `   • /buyvpsdo — VPS DigitalOcean\n` +
          `   • /buyvpslinode — VPS Linode\n` +
          `   • /buypanel — Panel Biasa\n` +
          `   • /buypanelprivate — Panel Legal\n\n` +
          `3️⃣ Ikuti langkah pemesanan yang muncul\n\n` +
          `4️⃣ Bayar menggunakan <b>Saldo</b> atau <b>QRIS</b>\n\n` +
          `5️⃣ Produk dikirim otomatis setelah pembayaran berhasil ✅\n\n` +
          `${sep}\n` +
          `Butuh bantuan? Hubungi admin.`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      // ── Info Bot ─────────────────────────────────────────────────
      case "start_infobot": {
        const sep = "────────────────────";

        await bot.editMessageCaption(
          `📊 <b>INFORMASI BOT</b>\n` +
          `${sep}\n\n` +
          `🤖 <b>Nama Bot</b> : Biyuu Official - Auto Order\n` +
          `⚡ <b>Status</b>   : Online &amp; Aktif\n` +
          `🔧 <b>Fitur</b>    :\n` +
          `   • 🖥 Buy VPS DigitalOcean\n` +
          `   • 🖥 Buy VPS Linode\n` +
          `   • 📦 Buy Panel Biasa\n` +
          `   • 📦 Buy Panel Legal\n` +
          `   • 👑 Owner Panel\n` +
          `   • 💰 Top Up Saldo (QRIS)\n` +
          `   • 💳 Cek Saldo\n` +
          `   • 📋 History Transaksi\n\n` +
          `💳 <b>Payment</b>  : QRIS &amp; Saldo Internal\n` +
          `🚀 <b>Proses</b>   : Otomatis, Tanpa Admin\n\n` +
          `${sep}\n` +
          `<i>© Biyuu Official - All Rights Reserved</i>`,
          {
            chat_id:      chatId,
            message_id:   msgId,
            parse_mode:   "HTML",
            reply_markup: getBackKeyboard()
          }
        ).catch(() => {});
        break;
      }

      // ── Kembali → edit caption kembali ke menu utama ─────────────
      case "start_kembali": {
        const caption  = await buildMainCaption(query.from, bot.id);
        const keyboard = getMainKeyboard();

        // Tambahkan tombol Kembali ke keyboard utama
        keyboard.inline_keyboard.push([
          { text: "🔙 Kembali", callback_data: "open_menupanel" }
        ]);

        await bot.editMessageCaption(caption, {
          chat_id:      chatId,
          message_id:   msgId,
          parse_mode:   "HTML",
          reply_markup: keyboard
        }).catch(() => {});
        break;
      }

      default:
        break;
    }
  });

};
