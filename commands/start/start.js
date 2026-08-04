const { getSaldo, getTotalUsers } = require("../../lib/pakasir");
const supabase = require("../../lib/supabase");
const { isFeatureEnabled, blockCallbackIfDisabled } = require("../../lib/features");
const { getBotLogo } = require("../../lib/media");
const fs   = require("fs");
const path = require("path");

const BOT_START_TIME = Date.now();

function getUptime() {
  const ms   = Date.now() - BOT_START_TIME;
  const days = Math.floor(ms / 86400000);
  const hrs  = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000)  / 60000);
  if (days > 0) return `${days} hari ${hrs} jam ${mins} menit`;
  if (hrs  > 0) return `${hrs} jam ${mins} menit`;
  return `${mins} menit`;
}

module.exports = (bot) => {

  // ── Caption & keyboard menu utama /start ─────────────────────────

  // Default caption dinamis — nampilin info user + stats bot realtime.
  // Dipanggil async karena perlu fetch totalUsers & totalTrx dari DB.
  async function getDefaultStartCaption(from) {
    const userId   = from ? String(from.id)                          : "—";
    const username = from?.username ? `@${from.username}`            : "—";
    const nama     = from
      ? [from.first_name, from.last_name].filter(Boolean).join(" ")  : "—";

    const [totalUsers, trxResult] = await Promise.all([
      getTotalUsers(bot.id).catch(() => 0),
      supabase
        .from("ok_orders")
        .select("order_id", { count: "exact", head: true })
        .eq("bot_id", bot.id)
        .eq("status", "completed")
        .then(({ count }) => count || 0)
        .catch(() => 0),
    ]);

    const botName = bot.me?.first_name || bot.label || "Bot Auto Order";

    return (
      `🥹 Selamat Datang di Bot Auto Order!\n\n` +
      `🔥 <b>Informasi Anda:</b>\n` +
      `   └ ID: <code>${userId}</code>\n` +
      `   └ Username: ${username}\n` +
      `   └ Nama: ${nama}\n\n` +
      `🔥 <b>Stats Bot:</b>\n` +
      `   └ Name : ${botName}\n` +
      `   └ Total Pengguna: ${totalUsers}\n` +
      `   └ Total Transaksi: ${trxResult} Paid\n\n` +
      `Silakan pilih tombol di bawah untuk informasi lebih lanjut.`
    );
  }

  // Teks custom dari dashboard (kolom start_text) kalau di-set, else default
  // di atas. bot.startText dibaca LANGSUNG tiap dipanggil (bukan di-cache),
  // jadi update realtime dari bot.js langsung kepakai tanpa restart.
  // `from` = msg.from (objek user Telegram) — hanya dipakai kalau teks custom kosong.
  async function getStartCaption(from) {
    if (bot.startText && bot.startText.trim()) return bot.startText.trim();
    return getDefaultStartCaption(from);
  }

  function getStartKeyboard() {
    const rows = [];

    if (isFeatureEnabled(bot, "buy_vps")) {
      rows.push([{ text: "🛒 Buy Vps", callback_data: "open_buyvps", style: "success" }]);
    }

    const row2 = [];
    if (isFeatureEnabled(bot, "buy_pterodactyl")) {
      row2.push({ text: "🛒 Buy Pterodactyl", callback_data: "open_menupanel", style: "success" });
    }
    if (isFeatureEnabled(bot, "buy_scripts")) {
      row2.push({ text: "🛒 Buy Scripts", callback_data: "buy_script_list", style: "success" });
    }
    if (row2.length) rows.push(row2);

    const row3 = [];
    if (isFeatureEnabled(bot, "katalog_produk")) {
      row3.push({ text: "🛒 Katalog Produk", callback_data: "ok_listproduk", style: "success" });
    }
    if (isFeatureEnabled(bot, "jasa_install_panel")) {
      row3.push({ text: "🛒 Jasa Install Panel", callback_data: "start_jasainstall", style: "primary" });
    }
    if (row3.length) rows.push(row3);

    if (isFeatureEnabled(bot, "informasi_bot")) {
      rows.push([{ text: "📊 Informasi Bot", callback_data: "start_infobot", style: "primary" }]);
    }

    return { inline_keyboard: rows };
  }

  function getBackKeyboard() {
    return {
      inline_keyboard: [
        [{ text: "🔙 Kembali", callback_data: "start_home", style: "danger" }]
      ]
    };
  }

  // ── Kirim pesan /start baru ───────────────────────────────────────
  async function sendStartMenu(chatId, effectId = "5104841245755180586", from = null) {
    const caption = await getStartCaption(from);
    const opts = {
      caption,
      parse_mode:        "HTML",
      reply_markup:      getStartKeyboard(),
      message_effect_id: effectId
    };
    try {
      await bot.sendPhoto(chatId, getBotLogo(bot), opts);
    } catch (err) {
      // PENTING: kalau teks custom dari dashboard (bot.startText) punya
      // HTML yang gak valid/gak balance, Telegram nolak sendPhoto (400
      // Bad Request) dan bakal throw ke sini. JANGAN biarin ini lolos
      // gak ke-handle — sebelumnya kasus serupa (URL logo invalid) bikin
      // /start selalu gagal dan kerasa kayak "bot mati". Fallback: kirim
      // ulang pakai caption DEFAULT yang udah pasti valid, supaya /start
      // tetap jalan buat user walau teks custom-nya lagi salah format.
      console.error(`⚠️ [${bot.label || bot.id}] Gagal kirim /start pakai teks custom (kemungkinan HTML tidak valid), fallback ke default:`, err.message);
      const fallback = await getDefaultStartCaption(from).catch(() => "Selamat datang!");
      await bot.sendPhoto(chatId, getBotLogo(bot), { ...opts, caption: fallback }).catch((err2) => {
        console.error(`❌ [${bot.label || bot.id}] Fallback default caption juga gagal:`, err2.message);
      });
    }
  }

  // ===== COMMAND /start =====
  bot.onText(/\/start/, async (msg) => {
    // Kalau maintenance aktif dan bukan owner, block — jangan tampilkan menu
    if (bot.maintenanceMode) {
      const isOwner = bot.ownerId && String(msg.from?.id) === String(bot.ownerId);
      if (!isOwner) {
        const maintenanceText = (bot.maintenanceMessage && bot.maintenanceMessage.trim())
          ? bot.maintenanceMessage.trim()
          : '🔧 <b>Bot sedang dalam mode maintenance</b>\n\nKami sedang melakukan pemeliharaan sistem.\nSilakan coba lagi beberapa saat lagi.\n\n⏳ Terima kasih atas kesabarannya! 🙏';
        try {
          await bot.sendMessage(msg.chat.id, maintenanceText, { parse_mode: 'HTML' });
        } catch (_) {}
        return;
      }
    }
    await sendStartMenu(msg.chat.id, "5104841245755180586", msg.from);
  });

  // ===== CALLBACK HANDLER =====
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;

    if (!data.startsWith("start_")) return;

    if (data === "start_infobot" && (await blockCallbackIfDisabled(bot, "informasi_bot", query))) return;
    if (data === "start_jasainstall" && (await blockCallbackIfDisabled(bot, "jasa_install_panel", query))) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    switch (data) {

      // ── Kembali ke menu /start ────────────────────────────────────
      case "start_home": {
        await bot.deleteMessage(chatId, msgId).catch(() => {});
        await sendStartMenu(chatId, undefined, query.from);
        break;
      }

      // ── Cara Order ───────────────────────────────────────────────
      case "start_caraorder": {
        const sep = "─".repeat(28);
        await bot.editMessageCaption(
          `🆘 <b>CARA ORDER</b>\n` +
          `${sep}\n\n` +
          `1️⃣ Isi saldo terlebih dahulu\n` +
          `   👉 Gunakan /deposit\n\n` +
          `2️⃣ Pilih produk yang diinginkan:\n` +
          `   • /buyvpsdo — VPS DigitalOcean\n` +
          `   • /buyvpslinode — VPS Linode\n` +
          `   • /buypanel — Akun Panel\n\n` +
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
        const sep = "─".repeat(28);

        // Ambil data real-time
        const [totalUser, trxResult] = await Promise.all([
          getTotalUsers(bot.id).catch(() => 0),
          supabase
            .from("transactions")
            .select("id, status")
            .then(({ data }) => ({ total: data ? data.length : 0 }))
            .catch(() => ({ total: 0 }))
        ]);

        const botName = bot.me?.first_name || bot.label || "Bot Auto Order";

        await bot.editMessageCaption(
          `📊 <b>INFORMASI BOT</b>\n` +
          `${sep}\n\n` +
          `🤖 <b>Nama Bot</b>        : ${botName}\n` +
          `⏱ <b>Bot Aktif Selama</b> : ${getUptime()}\n` +
          `👥 <b>Total Pengguna</b>   : ${totalUser} user\n` +
          `🧾 <b>Total Transaksi</b>  : ${trxResult.total} transaksi\n\n` +
          `${sep}\n` +
          `<i>© ${botName} - All Rights Reserved</i>`,
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
        const sep    = "─".repeat(28);
        try {
          const saldo     = await getSaldo(userId);
          const formatted = "Rp " + Number(saldo || 0).toLocaleString("id-ID");
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

      default:
        break;
    }
  });

};
