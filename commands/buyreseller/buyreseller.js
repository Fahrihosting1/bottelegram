const QRCode = require("qrcode");
const {
  getSaldo, topupSaldo,
  savePending, getPending, removePending,
  createTransaction, checkTransaction, cancelTransaction,
  saveTransaction, updateTransactionStatus
} = require("../../lib/pakasir");
const supabase = require("../../lib/supabase");
const {
  PAKASIR_API_KEY, PAKASIR_PROJECT,
  OWNER_ID, LOG_CHANNEL_ID, RESELLER_PRICE, RESELLER_GROUP_LINK
} = require("../../config");
const { generateReceipt } = require("../../lib/receipt");

// =====================================================================
// CONFIG
// Tambahkan di config.js kamu:
//   RESELLER_PRICE: process.env.RESELLER_PRICE || "50000"
//   RESELLER_GROUP_LINK: process.env.RESELLER_GROUP_LINK || "https://t.me/+XXXXXXXXXXXXXXXXXX"
// =====================================================================

const PRICE       = parseInt(RESELLER_PRICE) || 50000;
const GROUP_LINK  = RESELLER_GROUP_LINK || null; // Link grup telegram reseller
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS  = 10 * 60 * 1000;

const activePolls = new Map();
const userState   = new Map();

// =====================================================================
// HELPER
// =====================================================================

function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function generateOrderId(userId) {
  return `RSL${userId}${Date.now()}`;
}

async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

// =====================================================================
// SUPABASE — tabel: premium_users
// SQL untuk buat tabel (jalankan di Supabase SQL editor):
//
// CREATE TABLE IF NOT EXISTS premium_users (
//   id            bigserial PRIMARY KEY,
//   user_id       text UNIQUE NOT NULL,
//   telegram_name text,
//   username      text,
//   order_id      text,
//   payment_method text,
//   joined_group  boolean DEFAULT false,
//   bought_at     timestamptz DEFAULT now(),
//   updated_at    timestamptz DEFAULT now()
// );
// =====================================================================

async function addPremiumUser(userId, { telegramName, username, orderId, paymentMethod }) {
  await supabase.from("premium_users").upsert({
    user_id:        String(userId),
    telegram_name:  telegramName || null,
    username:       username || null,
    order_id:       orderId || null,
    payment_method: paymentMethod || null,
    joined_group:   false,
    bought_at:      new Date().toISOString(),
    updated_at:     new Date().toISOString()
  }, { onConflict: "user_id" });
}

async function isPremiumUser(userId) {
  const { data, error } = await supabase
    .from("premium_users")
    .select("user_id")
    .eq("user_id", String(userId))
    .single();
  return !error && !!data;
}

async function markGroupJoined(userId) {
  await supabase.from("premium_users")
    .update({ joined_group: true, updated_at: new Date().toISOString() })
    .eq("user_id", String(userId));
}

// =====================================================================
// DELIVER RESELLER — dipanggil setelah bayar sukses
// =====================================================================

async function deliverReseller(bot, chatId, userId, from, paymentMethod, orderId) {
  const sep = "─".repeat(28);
  const ADMIN_IDS = LOG_CHANNEL_ID ? [String(LOG_CHANNEL_ID).trim()] : [];

  const telegramName = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const username     = from.username || null;

  // 1. Simpan ke tabel premium_users
  await addPremiumUser(userId, { telegramName, username, orderId, paymentMethod });

  // 2. Kirim ke pembeli — link grup statis dari config
  const groupText = GROUP_LINK
    ? `\n🔗 <b>Link Grup Reseller:</b>\n${GROUP_LINK}`
    : `\n⚠️ <i>Grup belum dikonfigurasi. Hubungi owner.</i>`;

  await bot.sendMessage(chatId,
    `🎉 <b>SELAMAT! KAMU RESMI JADI RESELLER!</b>\n${sep}\n\n` +
    `✅ Akun kamu sudah terdaftar sebagai <b>Reseller Premium</b>\n\n` +
    `👤 Nama     : ${telegramName}\n` +
    `🆔 User ID  : <code>${userId}</code>\n` +
    `💳 Bayar via: ${paymentMethod === "saldo" ? "Saldo" : "QRIS"}\n` +
    `🔖 Order ID : <code>${orderId}</code>\n` +
    groupText +
    `\n${sep}\n` +
    `📌 <b>Keuntungan Reseller:</b>\n` +
    `• Akses grup reseller eksklusif\n` +
    `• Harga spesial reseller\n` +
    `• Dukungan prioritas dari owner\n\n` +
    `<i>Terima kasih sudah bergabung!</i>`,
    { parse_mode: "HTML" }
  );

  // 3. Notif ke owner — struk image
  try {
    const { buffer, filename } = await generateReceipt(bot, {
      buyerUserId:   userId,
      buyerName:     telegramName,
      buyerUsername: username,
      orderId,
      productLabel:  "Reseller Premium",
      productType:   "Reseller",
      price:         PRICE,
      paymentMethod,
      extraRows: [
        { label: "Grup Link", value: GROUP_LINK || "-" }
      ],
      storeName:    "BiYu Store",
      storeContact: "@BiYuStore"
    });

    for (const adminId of ADMIN_IDS) {
      const notifText =
        `🧾 *STRUK PEMBELIAN PRODUK*\n` +
        `━━━━━━━━━━━\n` +
        `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
        `𝗨𝗦𝗘𝗥 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : @${username || "-"}\n` +
        `𝗣𝗥𝗢𝗗𝗨𝗞 : Reseller Premium\n` +
        `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : ${paymentMethod === "saldo" ? "Saldo" : "QRIS"}\n` +
        `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
        `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRupiah(PRICE)}\n\n` +
        `━━━━━━━━━━━\n` +
        `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
        `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
        `━━━━━━━━━━━`;
      bot.sendPhoto(adminId, buffer, {
        caption: notifText,
        parse_mode: "Markdown",
        reply_markup: username ? { inline_keyboard: [[{ text: "👤 Cek Pembeli", url: `https://t.me/${username}` }]] } : {}
      }).catch(() => {});
    }
  } catch (e) {
    for (const adminId of ADMIN_IDS) {
      const notifText =
        `🧾 *STRUK PEMBELIAN PRODUK*\n` +
        `━━━━━━━━━━━\n` +
        `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
        `𝗨𝗦𝗘𝗥 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : @${username || "-"}\n` +
        `𝗣𝗥𝗢𝗗𝗨𝗞 : Reseller Premium\n` +
        `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : ${paymentMethod === "saldo" ? "Saldo" : "QRIS"}\n` +
        `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
        `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRupiah(PRICE)}\n\n` +
        `━━━━━━━━━━━\n` +
        `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
        `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
        `━━━━━━━━━━━`;
      bot.sendMessage(adminId, notifText, {
// caption moved to sendMessage above
        parse_mode: "Markdown",
        reply_markup: username ? { inline_keyboard: [[{ text: "👤 Cek Pembeli", url: `https://t.me/${username}` }]] } : {}
      }).catch(() => {});
    }
  }
}

// =====================================================================
// KEYBOARD
// =====================================================================

function payMethodKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "💳 QRIS", callback_data: `rsl_pay_qris:${orderId}` },
      ],
      [{ text: "❌ Batalkan", callback_data: `rsl_cancel:${orderId}` }]
    ]
  };
}

function qrisCancelKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "❌ Batalkan Order", callback_data: `rsl_cancel_qris:${orderId}` }]
    ]
  };
}

// =====================================================================
// CAPTION QRIS
// =====================================================================

function buildQrisCaption(orderId, amount, fee, total, expStr, status, elapsed, userId, fromUser) {
  const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  let statusLine = "";
  if (status === "pending") {
    const minLeft = Math.max(0, Math.ceil((POLL_TIMEOUT_MS - elapsed) / 60000));
    statusLine = `⏳ *Menunggu pembayaran...*
Sisa waktu: ±${minLeft} menit
_Bot cek otomatis tiap 5 detik_`;
  } else if (status === "completed") {
    statusLine = `✅ *PEMBAYARAN BERHASIL!*`;
  } else if (status === "expired") {
    statusLine = `⌛ *KEDALUWARSA*
Gunakan /buyreseller untuk mencoba lagi.`;
  } else if (status === "cancelled") {
    statusLine = `🚫 *DIBATALKAN*`;
  }
  return (
    `🧾 *QRIS PEMBAYARAN PRODUK*
` +
    `━━━━━━━━━━━━━━━━━━━━

` +
    `⌯⌲ ID Transaksi : \`${orderId}\`
` +
    `⌯⌲ Produk : Reseller Panel
` +
    `⌯⌲ Harga Produk : ${formatRupiah(amount)}
` +
    `⌯⌲ Fee Admin : ${formatRupiah(fee)}
` +
    `⌯⌲ Total Harga : *${formatRupiah(total)}*
` +
    `━━━━━━━━━━━
` +
    `⌯⌲ ID Telegram : \`${userId}\`
` +
    `⌯⌲ Username Telegram : ${fromUser?.username ? `@${fromUser.username}` : "-"}
` +
    `⌯⌲ Tanggal : ${tanggalStr}
` +
    `⌯⌲ Expired : ${expStr}

` +
    statusLine
  );
}


// =====================================================================
// POLLING QRIS
// =====================================================================

function startResellerPolling(bot, orderId, chatId, msgId, from) {
  if (activePolls.has(orderId)) return;
  const startTime = Date.now();

  let lastCaption = null;
  function editCap(text, keyboard) {
    if (text === lastCaption) return;
    lastCaption = text;
    bot.editMessageCaption(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown", reply_markup: keyboard
    }).catch(err => {
      if (err?.response?.body?.description?.includes("message is not modified")) return;
      console.warn("[RSL EDITCAP]", err?.message);
    });
  }

  const intervalId = setInterval(async () => {
    try {
      const pending = await getPending(orderId);
      if (!pending || pending.status !== "pending") {
        clearInterval(intervalId);
        activePolls.delete(orderId);
        return;
      }

      const elapsed = Date.now() - startTime;

      if (elapsed > POLL_TIMEOUT_MS) {
        clearInterval(intervalId);
        activePolls.delete(orderId);
        await removePending(orderId);
        await updateTransactionStatus(orderId, "expired");
        editCap(
          buildQrisCaption(orderId, pending.amount, pending.fee, pending.total_payment,
            pending.expired_at ? new Date(pending.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "-",
            "expired", elapsed),
          { inline_keyboard: [] }
        );
        return;
      }

      const result = await checkTransaction({
        orderId, amount: pending.amount,
        apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
      });

      const status = result?.transaction?.status;

      if (!status || status === "pending") {
        editCap(
          buildQrisCaption(orderId, pending.amount, pending.fee, pending.total_payment,
            pending.expired_at ? new Date(pending.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "-",
            "pending", elapsed),
          qrisCancelKeyboard(orderId)
        );
        return;
      }

      // Status terminal
      clearInterval(intervalId);
      activePolls.delete(orderId);
      await removePending(orderId);
      await updateTransactionStatus(orderId, status);

      if (status === "completed") {
        await bot.deleteMessage(chatId, msgId).catch(() => {});
        const userId = String(pending.userId);
        userState.delete(userId);
        await deliverReseller(bot, chatId, userId, from, "qris", orderId);
      } else {
        editCap(
          buildQrisCaption(orderId, pending.amount, pending.fee, pending.total_payment,
            pending.expired_at ? new Date(pending.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "-",
            status, 0),
          { inline_keyboard: [] }
        );
      }
    } catch (err) {
      console.warn(`[RSL POLL] ${orderId}:`, err?.message);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
}

// =====================================================================
// MODULE EXPORT
// =====================================================================

module.exports = function (bot) {

  // ── /buyreseller ────────────────────────────────────────────────────
  bot.onText(/\/buyreseller/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const sep    = "─".repeat(28);

    // Cek sudah reseller
    const sudahReseller = await isPremiumUser(userId);
    if (sudahReseller) {
      return bot.sendMessage(chatId,
        `✅ *Kamu sudah terdaftar sebagai Reseller!*\n\n` +
        `Jika belum join grup, hubungi owner untuk mendapatkan link grup.`,
        { parse_mode: "Markdown" }
      );
    }

    const saldo   = await getSaldo(userId);
    const orderId = generateOrderId(userId);

    userState.set(userId, { step: "choose_payment", orderId });

    const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    await bot.sendMessage(chatId,
      `<i>🛍️ BELI RESELLER PANEL</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⌯⌲ Produk : Reseller Panel\n` +
      `⌯⌲ Harga : ${formatRupiah(PRICE)}\n` +
      `⌯⌲ ID Telegram : <code>${userId}</code>\n` +
      `⌯⌲ Username Telegram : ${query.from?.username ? `@${query.from.username}` : "-"}\n` +
      `⌯⌲ Tanggal : ${tanggalStr}\n\n` +
      `<i>Pilih Metode Pembayaran anda</i>`,
      { parse_mode: "HTML", reply_markup: payMethodKeyboard(orderId) }
    );
  });

  // ── CALLBACK HANDLER ────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const userId = String(query.from.id);
    const data   = query.data;
    const from   = query.from;

    if (!data.startsWith("rsl_")) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── Bayar via Saldo ─────────────────────────────────────────────
    if (data.startsWith("rsl_pay_saldo:")) {
      const orderId = data.split(":")[1];

      // Cek sudah reseller
      if (await isPremiumUser(userId)) {
        return bot.editMessageText(
          "✅ Kamu sudah terdaftar sebagai Reseller!",
          { chat_id: chatId, message_id: msgId }
        ).catch(() => {});
      }

      const saldo = await getSaldo(userId);

      if (saldo < PRICE) {
        return bot.answerCallbackQuery(query.id, {
          text: `Saldo tidak cukup! Saldo kamu: ${formatRupiah(saldo)}`,
          show_alert: true
        });
      }

      // Potong saldo
      await topupSaldo(userId, -PRICE);
      await saveTransaction({
        orderId, userId, chatId,
        type: "buyreseller",
        amount: PRICE,
        paymentMethod: "saldo",
        status: "completed",
        productName: "Reseller Panel"
      });

      await bot.editMessageText(
        `✅ *Saldo berhasil dipotong!*\n\n` +
        `💵 Terpotong : ${formatRupiah(PRICE)}\n` +
        `💰 Sisa Saldo: ${formatRupiah(saldo - PRICE)}\n\n` +
        `⏳ Sedang memproses...`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      ).catch(() => {});

      userState.delete(userId);
      await deliverReseller(bot, chatId, userId, from, "saldo", orderId);
    }

    // ── Bayar via QRIS ──────────────────────────────────────────────
    if (data.startsWith("rsl_pay_qris:")) {
      const orderId = data.split(":")[1];

      if (await isPremiumUser(userId)) {
        return bot.editMessageText(
          "✅ Kamu sudah terdaftar sebagai Reseller!",
          { chat_id: chatId, message_id: msgId }
        ).catch(() => {});
      }

      let result;
      try {
        await bot.editMessageText("⏳ Membuat transaksi QRIS...", {
          chat_id: chatId, message_id: msgId
        });
        result = await createTransaction({
          orderId, amount: PRICE,
          apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
        });
      } catch (err) {
        const errMsg = err?.response?.data?.message || err.message;
        return bot.editMessageText(`❌ Gagal buat transaksi:\n\`${errMsg}\``, {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
        });
      }

      const payment    = result?.payment || result;
      const qrisStr    = payment?.payment_number;
      const expiredAt  = payment?.expired_at;
      const total      = payment?.total_payment || PRICE;
      const fee        = payment?.fee || 0;
      const expStr     = expiredAt
        ? new Date(expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
        : "-";

      await savePending(orderId, {
        userId, chatId,
        amount: PRICE, fee, total_payment: total,
        expired_at: expiredAt, status: "pending"
      });

      await saveTransaction({
        orderId, userId, chatId,
        type: "buyreseller",
        amount: PRICE, fee, totalPayment: total,
        paymentMethod: "qris",
        status: "pending",
        productName: "Reseller Panel",
        expiredAt
      });

      await bot.deleteMessage(chatId, msgId).catch(() => {});

      const caption = buildQrisCaption(orderId, PRICE, fee, total, expStr, "pending", 0, userId, query.from);

      let sentMsg;
      if (qrisStr) {
        const qrBuf = await makeQrBuffer(qrisStr);
        sentMsg = await bot.sendPhoto(chatId, qrBuf, {
          caption,
          parse_mode: "Markdown",
          reply_markup: qrisCancelKeyboard(orderId)
        });
      } else {
        sentMsg = await bot.sendMessage(chatId, caption, {
          parse_mode: "Markdown",
          reply_markup: qrisCancelKeyboard(orderId)
        });
      }

      userState.set(userId, { step: "waiting_qris", orderId });
      // Pass `from` agar bisa dipakai waktu deliver setelah polling sukses
      startResellerPolling(bot, orderId, chatId, sentMsg.message_id, from);
    }

    // ── Cancel sebelum bayar ────────────────────────────────────────
    if (data.startsWith("rsl_cancel:")) {
      const orderId = data.split(":")[1];
      userState.delete(userId);
      await bot.deleteMessage(chatId, msgId).catch(() => {});
      const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : </em>${orderId}\n` +
        `<em>⌯⌲  Tanggal : </em>${tglCancel}</blockquote>`;
      const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
    }

    // ── Cancel QRIS aktif ───────────────────────────────────────────
    if (data.startsWith("rsl_cancel_qris:")) {
      const orderId = data.split(":")[1];
      const pending = await getPending(orderId);

      if (!pending) {
        return bot.answerCallbackQuery(query.id, {
          text: "Order tidak ditemukan atau sudah selesai.",
          show_alert: true
        });
      }

      if (pending.userId !== userId) {
        return bot.answerCallbackQuery(query.id, {
          text: "⛔ Bukan order kamu.",
          show_alert: true
        });
      }

      if (activePolls.has(orderId)) {
        clearInterval(activePolls.get(orderId));
        activePolls.delete(orderId);
      }

      await removePending(orderId);
      await updateTransactionStatus(orderId, "cancelled");
      userState.delete(userId);

      try {
        await cancelTransaction({
          orderId, amount: pending.amount,
          apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
        });
      } catch (e) { console.warn("[RSL CANCEL]", e?.message); }

      await bot.deleteMessage(chatId, msgId).catch(() => {});
      const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : ${orderId}</em>\n` +
        `<em>⌯⌲  Tanggal : ${tglCancel}</em></blockquote>`;
      const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
    }
  });
};
