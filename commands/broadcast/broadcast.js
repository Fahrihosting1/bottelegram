/**
 * broadcast.js
 * ─────────────────────────────────────────────────────────────────
 * Fitur broadcast ke semua user yang pernah /start atau berinteraksi
 * dengan BOT INI SAJA. Di-scope pakai bot.id (rental.id), jadi bot A
 * gak akan pernah bisa akses / broadcast ke user bot B — sumber datanya
 * (tabel telegram_users) sekarang di-filter `.eq("bot_id", bot.id)` di
 * lib/pakasir.js.
 *
 * CARA PAKAI:
 *   1. Kirim / forward pesan apa aja ke bot ini (teks, foto, video,
 *      dokumen, voice note, dst).
 *   2. REPLY pesan itu dengan perintah /broadcast (atau /bc).
 *   3. Bot bakal FORWARD pesan itu apa adanya ke semua user bot ini —
 *      otomatis muncul label "Forwarded from ..." di HP tiap penerima.
 *      Ini bawaan API Telegram (forwardMessage), bukan hasil ngetik
 *      manual, jadi kelihatan asli & konsisten.
 *   4. Tiap pesan yang berhasil terkirim langsung DI-SEMATKAN (pin)
 *      otomatis di chat masing-masing user, biar gak ketimbun histori
 *      chat & user pasti kelihatan info-nya duluan pas buka bot.
 *
 *   Alternatif tanpa reply:
 *      /broadcast <teks pesan>  → kirim teks biasa (TANPA label
 *      forwarded, karena memang tidak ada pesan asli yang di-forward).
 *      Tetap otomatis disematkan juga.
 *
 * ANTI-SPAM DI SISI OWNER: semua tahapan (instruksi, konfirmasi,
 * progress, laporan akhir) DI-EDIT di 1 pesan yang sama (message_id
 * dari pesan konfirmasi), BUKAN kirim pesan baru tiap update. Jadi
 * chat owner sama bot gak kebanjiran notifikasi tiap broadcast jalan.
 *
 * AKSES: hanya owner BOT INI (rental.owner_id, di-attach ke bot.ownerId
 * di bot.js) yang boleh broadcast. Ini SENGAJA beda dari OWNER_ID
 * superadmin global di config.js (dipakai owner_commands.js) — supaya
 * owner bot A gak bisa nyuruh bot A nge-spam user bot B, dan sebaliknya.
 */

const { getAllTelegramUsers } = require("../../lib/pakasir");

const sep = "─".repeat(28);

// Simpan draft broadcast yang lagi nunggu konfirmasi.
// Key: `${botId}:${userId}` — supaya draft owner bot A gak ketiban / ketuker
// sama draft owner bot B kalau kebetulan orangnya sama & jalanin bareng.
const pendingBroadcast = new Map();

function draftKey(botId, userId) {
  return `${botId}:${userId}`;
}

function isBotOwner(bot, userId) {
  return bot.ownerId && String(userId) === String(bot.ownerId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleBroadcastCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isBotOwner(bot, userId)) {
    return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk owner bot ini.");
  }

  const textArg = msg.text.replace(/^\/(broadcast|bc)(@\w+)?\s*/i, "").trim();
  const replyMsg = msg.reply_to_message;

  // Belum ada reply/teks → tampilkan instruksi. Ini WAJIB kirim pesan baru
  // (belum ada "pesan kontrol" yang bisa di-edit), tapi ini cuma sekali.
  if (!replyMsg && !textArg) {
    return bot.sendMessage(
      chatId,
      `📢 *BROADCAST*\n${sep}\n\n` +
        "*Cara 1 — Forward (disarankan):*\n" +
        "1️⃣ Kirim/forward pesan apa aja ke bot ini (teks/foto/video/dokumen)\n" +
        "2️⃣ *Reply* pesan itu dengan `/broadcast`\n" +
        '   → pesan di-forward apa adanya, otomatis muncul label "Forwarded from" di HP tiap penerima\n' +
        "3️⃣ Mau nambahin teks/caption? Tulis setelah command-nya:\n" +
        "   `/broadcast Promo spesial hari ini!` (sambil reply foto)\n" +
        "   → teksnya dikirim nyusul di bawah pesan yang di-forward (Telegram gak bisa gabung forward + ganti caption jadi 1 pesan)\n\n" +
        "*Cara 2 — Teks langsung:*\n" +
        "`/broadcast <teks pesan>`\n" +
        "   → kirim teks biasa (tanpa label forwarded)\n\n" +
        "📌 Setiap pesan yang berhasil terkirim otomatis *disematkan* di chat user.\n\n" +
        "_Broadcast ini cuma nyampe ke user yang pernah interaksi sama bot ini — gak nyampur sama bot rental lain._",
      { parse_mode: "Markdown" }
    );
  }

  let users;
  try {
    users = await getAllTelegramUsers(bot.id);
  } catch (e) {
    return bot.sendMessage(chatId, `❌ Gagal ambil daftar user: ${e.message}`);
  }

  if (!users.length) {
    return bot.sendMessage(chatId, "📭 Belum ada user yang tercatat di bot ini.");
  }

  const mode = replyMsg ? "forward" : "text";

  // Kalau reply pesan TAPI owner juga ngetik teks tambahan setelah
  // /broadcast (mis. reply foto + "/broadcast Promo hari ini!"), teks itu
  // TETAP dipakai — dikirim sebagai pesan susulan tepat di bawah pesan yang
  // di-forward. Telegram gak bisa nggabung "forward" + ganti caption dalam
  // 1 pesan (forwardMessage gak nerima parameter caption), jadi ini cara
  // paling aman biar teksnya gak ilang tanpa ngorbanin label "Forwarded from".
  const extraCaption = mode === "forward" ? (textArg || null) : null;

  const modeLabel =
    mode === "forward"
      ? '🔁 Forward pesan asli (label "Forwarded from" otomatis)' +
        (extraCaption ? "\n            + teks tambahan nyusul di bawahnya" : "")
      : "📝 Kirim teks biasa";

  // Kirim SATU pesan kontrol — message_id-nya dipakai buat semua edit
  // berikutnya (konfirmasi → progress → laporan akhir), biar chat owner
  // gak nyampah tiap broadcast jalan.
  const controlMsg = await bot.sendMessage(
    chatId,
    `⚠️ *KONFIRMASI BROADCAST*\n${sep}\n\n` +
      `Mode    : ${modeLabel}\n` +
      `Target  : *${users.length}* user (khusus bot ini)\n` +
      `📌 Auto-pin di chat user: *aktif*\n\n` +
      "Lanjutkan?",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Ya, Kirim!", callback_data: "bc_confirm" },
            { text: "❌ Batal", callback_data: "bc_cancel" },
          ],
        ],
      },
    }
  );

  pendingBroadcast.set(draftKey(bot.id, userId), {
    mode,
    fromChatId: replyMsg ? replyMsg.chat.id : null,
    messageId: replyMsg ? replyMsg.message_id : null,
    text: mode === "text" ? textArg || null : null,
    extraCaption,
    controlMsgId: controlMsg.message_id,
  });
}

async function executeBroadcast(bot, chatId, controlMsgId, userId) {
  const key = draftKey(bot.id, userId);
  const job = pendingBroadcast.get(key);
  pendingBroadcast.delete(key);
  if (!job) return;

  let users;
  try {
    users = await getAllTelegramUsers(bot.id);
  } catch (e) {
    return bot
      .editMessageText(`❌ Gagal ambil daftar user: ${e.message}`, {
        chat_id: chatId,
        message_id: controlMsgId,
      })
      .catch(() => {});
  }

  if (!users.length) {
    return bot
      .editMessageText("📭 Belum ada user yang tercatat di bot ini.", {
        chat_id: chatId,
        message_id: controlMsgId,
      })
      .catch(() => {});
  }

  let success = 0;
  let failed = 0;
  let pinned = 0;

  const progressText = (i) =>
    `🚀 Broadcast berjalan... (${i}/${users.length})\n\n` +
    `📤 Terkirim  : ${success}\n` +
    `📌 Disematkan: ${pinned}\n` +
    `❌ Gagal     : ${failed}`;

  await bot
    .editMessageText(progressText(0), { chat_id: chatId, message_id: controlMsgId })
    .catch(() => {});

  for (let i = 0; i < users.length; i++) {
    const target = users[i];
    const targetChatId = target.chat_id || target.user_id;
    if (!targetChatId) {
      failed++;
      continue;
    }

    try {
      let lastSentMsg;
      if (job.mode === "forward") {
        lastSentMsg = await bot.forwardMessage(targetChatId, job.fromChatId, job.messageId);

        // Teks tambahan (kalau ada) dikirim NYUSUL sebagai pesan terpisah,
        // biar gak ilang kayak sebelumnya — sekaligus tetap pertahanin label
        // "Forwarded from" di pesan media/dokumen aslinya.
        if (job.extraCaption) {
          lastSentMsg = await bot.sendMessage(targetChatId, job.extraCaption);
        }
      } else {
        lastSentMsg = await bot.sendMessage(targetChatId, job.text);
      }
      success++;

      // ── Auto-sematkan (pin) pesan TERAKHIR yang dikirim ke user ───────────
      // disable_notification supaya gak nambah notifikasi ganda ke user
      // (mereka udah dapet notif dari pesan masuknya sendiri).
      // Gagal pin TIDAK dihitung sebagai gagal kirim — pesannya tetap nyampe,
      // cuma kebetulan gak bisa/gagal disematkan (mis. dibatasi Telegram).
      try {
        await bot.pinChatMessage(targetChatId, lastSentMsg.message_id, {
          disable_notification: true,
        });
        pinned++;
      } catch (_) {
        // skip diam-diam, bukan kegagalan fatal
      }
    } catch (err) {
      // Gagal biasanya karena user udah block/hapus bot, atau chat_id invalid.
      failed++;
    }

    // Update progress tiap 25 pesan biar gak kena rate limit edit message.
    if ((i + 1) % 25 === 0 || i === users.length - 1) {
      await bot
        .editMessageText(progressText(i + 1), { chat_id: chatId, message_id: controlMsgId })
        .catch(() => {});
    }

    // Throttle biar gak kena flood limit Telegram (bot API: ~30 pesan/detik
    // ke chat yang berbeda-beda). 40ms delay ≈ 25 pesan/detik, cukup aman.
    await sleep(40);
  }

  await bot
    .editMessageText(
      `✅ *BROADCAST SELESAI*\n${sep}\n\n` +
        `👥 Total target : ${users.length}\n` +
        `📤 Berhasil     : ${success}\n` +
        `📌 Disematkan   : ${pinned}\n` +
        `❌ Gagal        : ${failed}\n\n` +
        (failed > 0 ? "_Gagal biasanya karena user udah block/hapus bot._" : ""),
      { chat_id: chatId, message_id: controlMsgId, parse_mode: "Markdown" }
    )
    .catch(() => {});
}

module.exports = function (bot) {
  bot.onText(/^\/broadcast\b/i, (msg) => handleBroadcastCommand(bot, msg));
  bot.onText(/^\/bc\b/i, (msg) => handleBroadcastCommand(bot, msg));

  bot.on("callback_query", async (query) => {
    const data = query.data;
    if (data !== "bc_confirm" && data !== "bc_cancel") return;

    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = String(query.from.id);

    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (!isBotOwner(bot, userId)) {
      return bot.answerCallbackQuery(query.id, { text: "⛔ Bukan owner.", show_alert: true });
    }

    if (data === "bc_cancel") {
      pendingBroadcast.delete(draftKey(bot.id, userId));
      return bot
        .editMessageText("❌ Broadcast dibatalkan.", { chat_id: chatId, message_id: msgId })
        .catch(() => {});
    }

    if (data === "bc_confirm") {
      await bot
        .editMessageText("⏳ Memulai broadcast...", { chat_id: chatId, message_id: msgId })
        .catch(() => {});
      await executeBroadcast(bot, chatId, msgId, userId);
    }
  });
};
