const QRCode = require("qrcode");
const {
  getSaldo, savePending, getPending, removePending,
  updateMainMsgId, updatePendingStatus,
  createTransaction, checkTransaction, cancelTransaction, topupSaldo,
  saveTransaction, updateTransactionStatus
} = require("../../lib/pakasir");
const config = require("../../config");

const PAKASIR_API_KEY = config.PAKASIR_API_KEY || "ISI_API_KEY_PAKASIR_ANDA";
const PAKASIR_PROJECT = config.PAKASIR_PROJECT || "depodomain";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// Map<orderId, intervalId>
const activePolls = new Map();

function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}
function generateOrderId(userId) {
  return `DEP${userId}${Date.now()}`;
}
async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

// ===== CAPTION BUILDER (info + status jadi 1 teks) =====
function buildCaption(orderId, amount, fee, total, expStr, status, elapsed, completedAt, userId, fromUser) {
  const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const info =
    `🧾 *QRIS PEMBAYARAN PRODUK*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⌯⌲ ID Transaksi : \`${orderId}\`\n` +
    `⌯⌲ Produk : Deposit Saldo\n` +
    `⌯⌲ Harga Produk : ${formatRupiah(amount)}\n` +
    `⌯⌲ Fee Admin : ${formatRupiah(fee)}\n` +
    `⌯⌲ Total Harga : *${formatRupiah(total)}*\n` +
    `━━━━━━━━━━━\n` +
    `⌯⌲ ID Telegram : \`${userId || "-"}\`\n` +
    `⌯⌲ Username Telegram : ${fromUser?.username ? `@${fromUser.username}` : "-"}\n` +
    `⌯⌲ Tanggal : ${tanggalStr}\n` +
    `⌯⌲ Expired : ${expStr}\n\n`;

  if (status === "pending") {
    const bar = buildBar(elapsed);
    return info +
      `⏳ *Menunggu pembayaran...*\n` +
      `🕐 ${bar}\n` +
      `_Bot cek otomatis tiap 5 detik_`;
  }
  if (status === "completed") {
    const t = completedAt
      ? new Date(completedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
      : "-";
    return info + `✅ *PEMBAYARAN BERHASIL!*\n🕐 Waktu : ${t}`;
  }
  if (status === "expired") return info + `⌛ *KEDALUWARSA*\nGunakan /deposit untuk coba lagi.`;
  if (status === "cancelled") return info + `🚫 *DIBATALKAN*`;
  return info + `❓ Status tidak diketahui`;
}

function buildBar(elapsedMs) {
  const pct = Math.min(elapsedMs / POLL_TIMEOUT_MS, 1);
  const filled = Math.round(pct * 10);
  const minLeft = Math.max(0, Math.ceil((POLL_TIMEOUT_MS - elapsedMs) / 60000));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} sisa ~${minLeft} menit`;
}

function statusKeyboard(orderId, isDone) {
  if (isDone) return { inline_keyboard: [] };
  return {
    inline_keyboard: [[
      { text: "🔄 Refresh Status", callback_data: `cek_${orderId}` },
      { text: "❌ Batalkan", callback_data: `batal_${orderId}` }
    ]]
  };
}

// Helper ambil expStr dari pending
function getExpStr(pending) {
  return pending.expired_at
    ? new Date(pending.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    : "-";
}

// Edit caption foto (realtime update)
function editCaption(bot, chatId, msgId, text, keyboard) {
  bot.editMessageCaption(text, {
    chat_id: chatId, message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: keyboard
  }).catch(() => { });
}

// ===== POLLING ENGINE =====
function startPolling(bot, orderId, chatId, msgId) {
  if (activePolls.has(orderId)) return;
  const startTime = Date.now();

  const intervalId = setInterval(async () => {
    const pending = await getPending(orderId);

    if (!pending || pending.status !== "pending") {
      clearInterval(intervalId);
      activePolls.delete(orderId);
      return;
    }

    const elapsed = Date.now() - startTime;

// Timeout lokal
  if (elapsed > POLL_TIMEOUT_MS) {
  clearInterval(intervalId);
  activePolls.delete(orderId);
  await removePending(orderId);
  // Update unified transaction history
  await updateTransactionStatus(orderId, "expired");
  const text = buildCaption(orderId, pending.amount, pending.fee, pending.total_payment, getExpStr(pending), "expired", elapsed, null, pending.userId, null);
      editCaption(bot, chatId, msgId, text, statusKeyboard(orderId, true));
      return;
    }

    try {
      const result = await checkTransaction({
        orderId,
        amount: pending.amount,
        apiKey: PAKASIR_API_KEY,
        project: PAKASIR_PROJECT
      });

      const trx = result?.transaction;
      const status = trx?.status;

      if (!status || status === "pending") {
        // Update progress bar
        const text = buildCaption(orderId, pending.amount, pending.fee, pending.total_payment, getExpStr(pending), "pending", elapsed, null, pending.userId, null);
        editCaption(bot, chatId, msgId, text, statusKeyboard(orderId, false));
        return;
      }

      // Terminal status
      clearInterval(intervalId);
      activePolls.delete(orderId);

if (status === "completed") {
  const newBalance = await topupSaldo(pending.userId, pending.amount);
  await removePending(orderId);
  
  // Update unified transaction history
  await updateTransactionStatus(orderId, "completed");
  
  const text = buildCaption(orderId, pending.amount, pending.fee, pending.total_payment, getExpStr(pending), "completed", elapsed, trx.completed_at, pending.userId, null);
  editCaption(bot, chatId, msgId, text, statusKeyboard(orderId, true));

        bot.sendMessage(chatId,
          `🎉 *Deposit Berhasil!*\n\n` +
          `💰 +${formatRupiah(pending.amount)} masuk ke saldo\n` +
          `💵 Saldo sekarang: *${formatRupiah(newBalance)}*`,
          { parse_mode: "Markdown" }
        );
      } else {
        await removePending(orderId);
        const text = buildCaption(orderId, pending.amount, pending.fee, pending.total_payment, getExpStr(pending), status, elapsed, null, pending.userId, null);
        editCaption(bot, chatId, msgId, text, statusKeyboard(orderId, true));
      }

    } catch (err) {
      console.warn(`[POLL] ${orderId}:`, err?.response?.data || err.message);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
  console.log(`[POLL] Started: ${orderId}`);
}

// ===== MODULE =====
module.exports = function (bot) {

  // /deposit <jumlah>
  bot.onText(/\/deposit(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const amount = parseInt(match[1]);

    if (!amount || amount < 5000) {
      return bot.sendMessage(chatId,
        "❌ *Format salah!*\n\n" +
        "Gunakan: `/deposit <jumlah>`\n" +
        "Contoh: `/deposit 50000`\n\n" +
        "_Minimal deposit: Rp 5.000_",
        { parse_mode: "Markdown" }
      );
    }

    const orderId = generateOrderId(userId);
    const waitMsg = await bot.sendMessage(chatId, "⏳ Membuat transaksi...");

    let result;
    try {
      result = await createTransaction({
        orderId, amount,
        apiKey: PAKASIR_API_KEY,
        project: PAKASIR_PROJECT
      });
    } catch (apiErr) {
      await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => { });
      const errMsg = apiErr?.response?.data?.message || apiErr.message;
      return bot.sendMessage(chatId, `❌ Gagal buat transaksi:\n\`${errMsg}\``, { parse_mode: "Markdown" });
    }

    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => { });

    const payment = result?.payment || result;
    const qrisStr = payment?.payment_number;
    const expiredAt = payment?.expired_at;
    const total = payment?.total_payment || amount;
    const fee = payment?.fee || 0;
    const expStr = expiredAt
      ? new Date(expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
      : "-";

    // Simpan ke Supabase
    await savePending(orderId, {
      userId, chatId, amount,
      total_payment: total, fee,
      order_id: orderId,
      status: "pending",
      expired_at: expiredAt
    });

    // Save to unified transactions history
    await saveTransaction({
      orderId,
      userId,
      chatId,
      type: "deposit",
      status: "pending",
      amount,
      fee,
      totalPayment: total,
      paymentMethod: "qris",
      expiredAt
    });

    // Kirim pesan (foto + caption gabung)
    const fullCaption = buildCaption(orderId, amount, fee, total, expStr, "pending", 0, null, userId, msg.from);
    let mainMsgId;

    if (qrisStr) {
      try {
        const qrBuf = await makeQrBuffer(qrisStr);
        const sent = await bot.sendPhoto(chatId, qrBuf, {
          caption: fullCaption,
          parse_mode: "Markdown",
          reply_markup: statusKeyboard(orderId, false)
        });
        mainMsgId = sent.message_id;
      } catch {
        const sent = await bot.sendMessage(chatId,
          fullCaption + `\n\n\`\`\`\n${qrisStr}\n\`\`\``,
          { parse_mode: "Markdown", reply_markup: statusKeyboard(orderId, false) }
        );
        mainMsgId = sent.message_id;
      }
    } else {
      const sent = await bot.sendMessage(chatId, fullCaption, {
        parse_mode: "Markdown",
        reply_markup: statusKeyboard(orderId, false)
      });
      mainMsgId = sent.message_id;
    }

    // Simpan message_id ke Supabase supaya bisa di-edit setelah bot restart
    await updateMainMsgId(orderId, mainMsgId);

    startPolling(bot, orderId, chatId, mainMsgId);
  });

  // ===== CALLBACK QUERY =====
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = String(query.from.id);
    const data = query.data;

    // Guard: hanya proses callback milik deposit
    const isDepositCb = (
      data === "check_saldo" ||
      data === "deposit" ||
      (data.startsWith("cek_") && !data.startsWith("cek_vps_")) ||
      (data.startsWith("batal_") && !data.startsWith("batal_vps_"))
    );
    if (!isDepositCb) return;

    // Tombol Refresh
    if (data.startsWith("cek_") && !data.startsWith("cek_vps_")) {
      const orderId = data.replace("cek_", "");
      const pending = await getPending(orderId);

      if (!pending) return bot.answerCallbackQuery(query.id, { text: "Order tidak ditemukan." });
      if (pending.userId !== userId) return bot.answerCallbackQuery(query.id, { text: "⛔ Bukan order Anda.", show_alert: true });

      await bot.answerCallbackQuery(query.id, { text: "🔍 Mengecek ke Pakasir..." });

      try {
        const result = await checkTransaction({
          orderId,
          amount: pending.amount,
          apiKey: PAKASIR_API_KEY,
          project: PAKASIR_PROJECT
        });

        const trx = result?.transaction;
        const status = trx?.status || "pending";
        const isDone = status !== "pending";
        const elapsed = Date.now() - (pending.created_at || Date.now());

        const text = buildCaption(orderId, pending.amount, pending.fee, pending.total_payment, getExpStr(pending), status, elapsed, trx?.completed_at, pending.userId, null);
        editCaption(bot, chatId, msgId, text, statusKeyboard(orderId, isDone));

        if (status === "completed") {
          const stillPending = await getPending(orderId);
          if (stillPending) {
            const newBalance = await topupSaldo(pending.userId, pending.amount);
            await removePending(orderId);
            if (activePolls.has(orderId)) { clearInterval(activePolls.get(orderId)); activePolls.delete(orderId); }
            bot.sendMessage(chatId,
              `🎉 *Deposit Berhasil!*\n\n💵 Saldo: *${formatRupiah(newBalance)}*`,
              { parse_mode: "Markdown" }
            );
          }
        }

      } catch (err) {
        bot.answerCallbackQuery(query.id, {
          text: "❌ " + (err?.response?.data?.message || err.message),
          show_alert: true
        });
      }
    }

    // Tombol Batalkan
    if (data.startsWith("batal_") && !data.startsWith("batal_vps_")) {
      const orderId = data.replace("batal_", "");
      const pending = await getPending(orderId);

      if (!pending) return bot.answerCallbackQuery(query.id, { text: "Order tidak ditemukan." });
      if (pending.userId !== userId) return bot.answerCallbackQuery(query.id, { text: "⛔ Bukan order Anda.", show_alert: true });
      if (pending.status !== "pending") return bot.answerCallbackQuery(query.id, { text: `Status sudah: ${pending.status}` });

      if (activePolls.has(orderId)) { clearInterval(activePolls.get(orderId)); activePolls.delete(orderId); }

      try {
        await cancelTransaction({
          orderId, amount: pending.amount,
          apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
        });
      } catch (e) { console.warn("Cancel:", e?.response?.data || e.message); }

  await removePending(orderId);
  
  // Update unified transaction history
  await updateTransactionStatus(orderId, "cancelled");
  
  const text = buildCaption(orderId, pending.amount, pending.fee, pending.total_payment, getExpStr(pending), "cancelled", 0, null, pending.userId, null);
  editCaption(bot, chatId, msgId, text, statusKeyboard(orderId, true));
  bot.answerCallbackQuery(query.id, { text: "🚫 Deposit dibatalkan." });

  const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const cancelCaption =
    `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
    `<em>⌯⌲ Order ID : </em>${orderId}\n` +
    `<em>⌯⌲  Tanggal : </em>${tglCancel}</blockquote>`;
  const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
    }
  });

  // /saldo
  bot.onText(/\/saldo/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const saldo = await getSaldo(userId);
    bot.sendMessage(chatId,
      `💰 *Saldo Kamu*\n\n` +
      `👤 User  : \`${userId}\`\n` +
      `💵 Saldo : *${formatRupiah(saldo)}*`,
      { parse_mode: "Markdown" }
    );
  });

};
