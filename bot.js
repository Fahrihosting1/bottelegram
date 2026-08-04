const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const { getAllActiveRentals, updateRentalStatus, subscribeToRentalChanges, subscribeToRentalLifecycle } = require("./lib/rental");
const { trackTelegramUser, getUserStats, getTotalUsers } = require("./lib/pakasir");
const { initRestockListener } = require("./lib/restock_listener");
const { normalizeFeatures } = require("./lib/features");
const { normalizeProvider } = require("./lib/payment-provider");
const { initMarketplaceNotif, stopMarketplaceNotif } = require("./lib/marketplace_notif");

/**
 * 1 source code -> N bot, jalan dalam 1 proses yang sama.
 * TIDAK PERLU set env var apapun untuk daftar bot — langsung ambil
 * semua row dari tabel telegram_bot_rentals di Supabase saat start.
 * Tambah row baru di Supabase + restart proses = bot baru otomatis ikut jalan.
 */
// Track rental id mana aja yang bot-nya udah jalan di proses ini —
// supaya event realtime (INSERT/UPDATE) gak nge-start dobel bot yang
// sama, dan supaya bisa retry kalau start-nya gagal.
const runningRentals = new Set();

// Simpan instance bot + fungsi unsubscribe-nya per rental id, supaya
// begitu rental-nya dihapus/dinonaktifkan dari dashboard, kita bisa
// benar-benar matiin polling-nya (bukan cuma update status di database
// doang) — ini yang sebelumnya kelewat, jadi bot yang udah "dihapus" di
// Supabase tetep jalan terus di proses Node yang lagi nyala.
const botInstances = new Map(); // rentalId -> { bot, unsubscribeChanges, unsubscribeRestock }

async function main() {
  const rentals = await getAllActiveRentals();
  console.log(`🔎 Ditemukan ${rentals.length} bot di Supabase, menjalankan semua...`);

  rentals.forEach(r => runningRentals.add(r.id));
  await Promise.all(rentals.map(r => startBotInstance(r)));

  // Realtime: begitu ada row BARU ditambah di telegram_bot_rentals (atau
  // rental lama yang statusnya di-reaktivasi dari 'inactive'), bot-nya
  // langsung auto-start di proses yang sama tanpa perlu restart manual.
  // Sebaliknya, begitu row-nya DIHAPUS atau di-nonaktifkan, bot yang lagi
  // jalan langsung di-stop juga — tanpa perlu restart proses.
  subscribeToRentalLifecycle(
    async (rental) => {
      if (runningRentals.has(rental.id)) return; // udah jalan, skip
      if (!rental.bot_token) {
        console.warn(`⚠️ Rental baru "${rental.label || rental.id}" belum punya bot_token, dilewati.`);
        return;
      }
      if (rental.status === "inactive") return;

      runningRentals.add(rental.id);
      console.log(`🆕 Rental baru terdeteksi via realtime: "${rental.label || rental.bot_username || rental.id}" — starting...`);
      await startBotInstance(rental);
    },
    (rentalId, type) => stopBotInstance(rentalId, type),
  );
}

// Teks notif yang dikirim ke chat owner (via bot itu sendiri) tepat
// sebelum bot dimatikan, biar owner gak kaget bot-nya tiba-tiba diem aja
// tanpa penjelasan.
const STOP_REASON_LABEL = {
  deleted: "🗑️ *Bot Anda telah dihapus*",
  suspended: "⏸️ *Bot Anda telah dinonaktifkan*",
  fatal: "⚠️ *Bot Anda dihentikan* (token tidak valid / bot dihapus dari BotFather)",
};

async function notifyOwnerBeforeStop(bot, type) {
  if (!bot.ownerId) return;
  const label = STOP_REASON_LABEL[type] || "🛑 *Bot Anda telah dihentikan*";
  const waktu = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    dateStyle: "long",
    timeStyle: "short",
  });
  const text =
    `${label}\n\n` +
    `🕐 Tanggal/Waktu : ${waktu} WIB\n` +
    `🔑 Token : \`${bot.token}\`\n` +
    `🆔 ID Owner : ${bot.ownerId}`;

  try {
    // Dikirim SEBELUM stopPolling — begitu polling di-stop, bot ini gak
    // bisa ngirim apa-apa lagi lewat token-nya sendiri.
    await bot.sendMessage(bot.ownerId, text, { parse_mode: "Markdown" });
  } catch (err) {
    // Kalau tipe-nya "fatal" (token udah dicabut/bot dihapus dari
    // BotFather), ini WAJAR gagal — token-nya emang udah gak valid lagi,
    // gak ada cara kirim notif lewat bot yang sama.
    console.error(`⚠️ [${bot.label || bot.id}] Gagal kirim notif "bot dihentikan" ke owner:`, err.message);
  }
}

function stopBotInstance(rentalId, type) {
  const entry = botInstances.get(rentalId);
  if (!entry) {
    // Bot ini emang gak lagi jalan di proses ini (mis. udah di-stop
    // sebelumnya, atau proses ini gak pernah nge-start-nya) — gak ada
    // yang perlu dimatiin, tapi tetap bersihin dari runningRentals biar
    // konsisten kalau row-nya nanti dihidupin lagi.
    runningRentals.delete(rentalId);
    return;
  }

  const { bot, unsubscribeChanges, unsubscribeRestock } = entry;
  console.log(`🛑 [${bot.label || rentalId}] Bot dihentikan (${type}).`);

  // Hentikan scheduler notif marketplace supaya tidak leak memory/interval
  stopMarketplaceNotif(rentalId);

  // Kirim dulu notifnya, BARU stop polling — kalau dibalik, bot udah gak
  // bisa ngirim pesan apa-apa lagi.
  notifyOwnerBeforeStop(bot, type).finally(() => {
    bot.stopPolling().catch(() => {});
  });

  try {
    unsubscribeChanges?.();
  } catch {}
  try {
    unsubscribeRestock?.();
  } catch {}

  botInstances.delete(rentalId);
  runningRentals.delete(rentalId);
}

async function startBotInstance(rental) {
  try {
    const bot = new TelegramBot(rental.bot_token, { polling: true });
    const ownerId = String(rental.owner_id || "");
    const label = rental.label || rental.bot_username || rental.id;
    bot.label = label;

    // PENTING: bot.id dipakai buat scoping semua query produk/stok (ok_produk,
    // ok_stok) di orderkuota_db.js & owner_commands.js supaya tiap bot rental
    // cuma liat/jual/edit produk MILIKNYA SENDIRI, gak nyampur sama bot lain.
    bot.id = rental.id;

    // PENTING: dipakai command broadcast (commands/broadcast/broadcast.js)
    // buat mastiin cuma owner BOT INI yang bisa broadcast ke user BOT INI —
    // bukan OWNER_ID superadmin global di config.js.
    bot.ownerId = ownerId;

    // Fitur yang di-toggle admin dari dashboard marketplace (kolom
    // enabled_features). Di-attach ke object bot supaya semua command
    // module (yang cuma nerima `bot`) bisa cek bot.features langsung.
    bot.features = normalizeFeatures(rental.enabled_features);

    // Metode pembayaran QRIS yang lagi aktif buat bot ini ('pakasir' |
    // 'gopay'), dipilih admin lewat dashboard (kolom payment_provider).
    bot.paymentProvider = normalizeProvider(rental.payment_provider);

    // Logo/gambar bot ini (kolom logo_url), di-upload/di-set admin lewat
    // dashboard web — BUKAN hardcode di source code, supaya tiap bot rental
    // bisa punya gambar sendiri-sendiri. Kalau kosong, lib/media.js bakal
    // fallback ke media/biyu_logo.jpg lokal. Lihat lib/media.js.
    bot.logoUrl = rental.logo_url || null;

    // Teks caption pesan /start (kolom start_text), bisa di-custom admin
    // lewat dashboard web. Kalau kosong, commands/start/start.js fallback
    // ke teks default yang di-hardcode di situ.
    bot.startText = rental.start_text || null;

    // Mode maintenance per-bot — di-toggle owner dari dashboard marketplace.
    // Di-check langsung di setiap command handler (start.js, dll).
    bot.maintenanceMode = rental.maintenance_mode === true;
    bot.maintenanceMessage = rental.maintenance_message || null;

    // Realtime: begitu owner toggle maintenance / update fitur / ganti payment
    // provider / logo / start_text di dashboard, semua property langsung
    // ke-refresh tanpa restart proses bot.
    const unsubscribeChanges = subscribeToRentalChanges(rental.id, (updatedRow) => {
      bot.features = normalizeFeatures(updatedRow.enabled_features);
      bot.paymentProvider = normalizeProvider(updatedRow.payment_provider);
      bot.logoUrl = updatedRow.logo_url || null;
      bot.startText = updatedRow.start_text || null;
      const prevMaintenance = bot.maintenanceMode;
      bot.maintenanceMode = updatedRow.maintenance_mode === true;
      bot.maintenanceMessage = updatedRow.maintenance_message || null;
      if (prevMaintenance !== bot.maintenanceMode) {
        console.log(`🔧 [${label}] Maintenance mode ${bot.maintenanceMode ? 'AKTIF' : 'NONAKTIF'} via realtime.`);
      }
      console.log(`🔄 [${label}] config diperbarui via realtime:`, bot.features, bot.paymentProvider, bot.logoUrl, bot.startText, 'maintenance:', bot.maintenanceMode);
    });

    console.log(`🤖 [${label}] bot is running...`);
    await updateRentalStatus(rental.id, "active");

    const unsubscribeRestock = initRestockListener(bot, rental.id);
    attachHandlers(bot, ownerId, label);
    loadCommands(path.join(__dirname, "commands"), bot);

    // Notif sewa marketplace hampir habis — kirim dari bot ini ke owner
    initMarketplaceNotif(bot, rental.user_id, ownerId);

    botInstances.set(rental.id, { bot, unsubscribeChanges, unsubscribeRestock });

    bot.on("polling_error", async (err) => {
      console.error(`⚠️ [${label}] polling_error:`, err.message);

      // PENTING: JANGAN langsung tandai 'inactive' untuk SEMUA polling_error.
      // Error kayak 409 Conflict ("terminated by other getUpdates request")
      // itu LUMRAH kejadian pas restart proses — sesi polling punya proses
      // lama belum sempet dilepas Telegram pas proses baru mulai polling.
      // Error ini sifatnya sesaat, node-telegram-bot-api bakal auto-retry
      // sendiri dan bot balik normal dalam beberapa detik. Kalau tetep
      // ditandai 'inactive', restart berikutnya bot ini gak bakal ke-load
      // lagi sama sekali (getAllActiveRentals nge-skip status 'inactive'),
      // padahal tokennya sehat-sehat aja — ini akar masalah "abis restart
      // malah kena inactive".
      //
      // Cuma error yang BENER-BENER fatal (token dicabut/invalid, bot
      // dihapus) yang layak nandain rental ini inactive:
      //   401 Unauthorized -> bot_token salah/dicabut
      //   404 Not Found    -> bot udah gak ada / token invalid
      const telegramErrorCode = err?.response?.body?.error_code;
      const isFatal = telegramErrorCode === 401 || telegramErrorCode === 404;

      if (isFatal && !bot.__markedError) {
        bot.__markedError = true;
        console.error(`❌ [${label}] Error fatal (code ${telegramErrorCode}) — menandai rental inactive.`);
        await updateRentalStatus(rental.id, "inactive");
        stopBotInstance(rental.id, "fatal");
      }
    });
  } catch (err) {
    // Bot ini gagal start, tapi bot lain tetap lanjut jalan
    console.error(`❌ Gagal start rental "${rental.id}":`, err.message);
    runningRentals.delete(rental.id);
    await updateRentalStatus(rental.id, "inactive");
  }
}

function attachHandlers(bot, ownerId, label) {
  // ===== TRACK SEMUA USER YANG BERINTERAKSI =====
  // PENTING: `msg.from.is_bot` WAJIB dicek. Telegram kadang ngirim balik
  // "echo" pesan yang DIKIRIM BOT ITU SENDIRI (mis. broadcast, laporan ke
  // channel/grup) sebagai update masuk yang msg.from-nya = bot itu sendiri
  // (is_bot: true). Tanpa filter ini, bot bakal ke-track sebagai "user"-nya
  // sendiri di tabel telegram_users — ikut ke-broadcast ke dirinya sendiri
  // di broadcast berikutnya, dan bikin angka /stats kotor.
  bot.on("message", async (msg) => {
    if (msg.from && !msg.from.is_bot) {
      try {
        await trackTelegramUser(msg.from, msg.chat.id, bot.id);
      } catch (err) {
        console.error(`[${label}] Error tracking user:`, err.message);
      }
    }
  });

  bot.on("callback_query", async (query) => {
    if (query.from && !query.from.is_bot) {
      try {
        await trackTelegramUser(query.from, query.message?.chat?.id, bot.id);
      } catch (err) {
        console.error(`[${label}] Error tracking user:`, err.message);
      }
    }
  });

  // ===== COMMAND /stats - HANYA UNTUK OWNER BOT INI =====
  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);

    if (userId !== ownerId) {
      return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk admin.");
    }

    const waitMsg = await bot.sendMessage(chatId, "⏳ Mengambil statistik...");

    try {
      const stats = await getUserStats(bot.id);
      const sep = "─".repeat(28);

      let text =
        `📊 *STATISTIK PENGGUNA BOT*\n` +
        `${sep}\n\n` +
        `👥 *Total Pengguna:* ${stats.total}\n` +
        `🟢 *Aktif Hari Ini:* ${stats.activeToday}\n` +
        `📅 *Aktif Minggu Ini:* ${stats.activeWeek}\n` +
        `⭐ *Premium Users:* ${stats.premiumUsers}\n` +
        `📈 *Total Interaksi:* ${stats.totalInteractions}\n` +
        `${sep}\n\n`;

      if (stats.users && stats.users.length > 0) {
        text += `*🕐 User Terbaru (Top 10):*\n`;
        const topUsers = stats.users.slice(0, 10);
        for (let i = 0; i < topUsers.length; i++) {
          const user = topUsers[i];
          const name = user.first_name || user.username || `User ${user.user_id}`;
          const username = user.username ? `@${user.username}` : "-";
          const lastActive = new Date(user.last_active_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
          text += `${i + 1}. ${name} (${username})\n   └ Last: ${lastActive}\n`;
        }
      }

      await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch (err) {
      await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // ===== COMMAND /users - TOTAL USER COUNT =====
  bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);

    if (userId !== ownerId) {
      return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk admin.");
    }

    const total = await getTotalUsers(bot.id);
    bot.sendMessage(chatId,
      `👥 *Total Pengguna Bot*\n\n` +
      `📊 Jumlah user unik: *${total}*\n\n` +
      `_Gunakan /stats untuk detail lengkap_`,
      { parse_mode: "Markdown" }
    );
  });
}

function loadCommands(dir, bot) {
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      loadCommands(fullPath, bot);
    } else if (file.endsWith(".js")) {
      try {
        const command = require(fullPath);
        if (typeof command === "function") {
          command(bot);
        }
      } catch (err) {
        console.error(`❌ Error loading ${file}:`, err);
      }
    }
  });
}

main().catch((err) => {
  console.error("❌ FATAL:", err.message);
  process.exit(1);
});
