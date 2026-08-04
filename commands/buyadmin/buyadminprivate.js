const QRCode = require("qrcode");
const fetch = require("node-fetch");
const {
  getSaldo, topupSaldo,
  savePending, getPending, removePending,
  createTransaction, checkTransaction, cancelTransaction,
  saveTransaction, updateTransactionStatus
} = require("../../lib/pakasir");
const {
  PAKASIR_API_KEY, PAKASIR_PROJECT, OWNER_ID, LOG_CHANNEL_ID,
  domain_private: domain,
  plta_private: plta
} = require("../../config");
const { generateReceipt } = require("../../lib/receipt");

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const activePolls = new Map();

// State untuk menampung flow per user
// { [userId]: { step, orderId, username, paymentMethod } }
const userState = new Map();

// Harga admin panel private — bisa disesuaikan
const ADMIN_PRICE = parseInt(process.env.BUYADMINPRIVATE_PRICE) || 25000;

async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function generateOrderId(userId) {
  return `ADMP${userId}${Date.now()}`;
}

function generateRandomPassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

// ===== Keyboard helpers =====

function payMethodKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "💳 QRIS", callback_data: `bap_pay_qris:${orderId}` }
      ],
      [{ text: "❌ Batalkan", callback_data: `bap_cancel:${orderId}` }]
    ]
  };
}

function passwordChoiceKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ Password Custom", callback_data: `bap_pass_custom:${orderId}` },
        { text: "🎲 Password Random", callback_data: `bap_pass_random:${orderId}` }
      ]
    ]
  };
}

function qrisCancelKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "❌ Batalkan Order", callback_data: `bap_cancel_qris:${orderId}` }]
    ]
  };
}

// ===== Pterodactyl Private API: buat user admin =====
async function createPteroAdminUser(username, password) {
  const res = await fetch(`${domain}/api/application/users`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + plta
    },
    body: JSON.stringify({
      email: `${username}@gmail.com`,
      username: username,
      first_name: username,
      last_name: "Admin",
      language: "en",
      root_admin: true,
      password: password
    })
  });
  return res.json();
}

// ===== Caption QRIS =====
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
Gunakan /buyadminprivate untuk mencoba lagi.`;
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
    `⌯⌲ Produk : Admin Panel Private
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


// ===== Kirim akun ke pembeli & owner =====
async function deliverAccount(bot, chatId, userId, username, password, fromObj) {
  const ADMIN_IDS = LOG_CHANNEL_ID ? [String(LOG_CHANNEL_ID).trim()] : [];

  const waitMsg = await bot.sendMessage(chatId, "⚙️ Membuat akun admin panel private...");

  const data = await createPteroAdminUser(username, password);

  await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

  if (data.errors) {
    const errText = JSON.stringify(data.errors[0], null, 2);
    return bot.sendMessage(chatId,
      `❌ *Gagal membuat akun!*\n\n\`\`\`\n${errText}\n\`\`\`\n\nHubungi owner untuk bantuan.`,
      { parse_mode: "Markdown" }
    );
  }

  const user = data.attributes;
  const sep = "─".repeat(28);

  // Kirim ke pembeli
  await bot.sendMessage(chatId,
    `✅ *AKUN ADMIN PANEL PRIVATE BERHASIL DIBUAT!*\n${sep}\n\n` +
    `👤 Username : \`${user.username}\`\n` +
    `🔑 Password : \`${password}\`\n` +
    `🌐 Login    : ${domain}\n\n` +
    `*📌 PENTING:*\n` +
    `• Simpan data ini baik-baik!\n` +
    `• Owner hanya mengirim 1x data akun\n` +
    `• Garansi klaim harus sertakan bukti beli\n` +
    `• Jangan rusuh server lain\n` +
    `• Buat panel secukupnya`,
    { parse_mode: "Markdown" }
  );

  // Kirim notif ke owner — struk image
  try {
    const buyerName = fromObj
      ? [fromObj.first_name, fromObj.last_name].filter(Boolean).join(" ")
      : String(userId);
    const buyerUsername = fromObj?.username || null;

    const { buffer, filename } = await generateReceipt(bot, {
      buyerUserId:   userId,
      buyerName,
      buyerUsername,
      orderId:       `ADMP${userId}`,
      productLabel:  "Admin Panel Private",
      productType:   "Admin Panel Private",
      price:         ADMIN_PRICE,
      paymentMethod: "saldo",
      extraRows: [
        { label: "Username Ptero", value: user.username },
        { label: "Ptero ID",       value: String(user.id) }
      ],
      storeName:    "BiYu Store",
      storeContact: "@BiYuStore"
    });

    for (const adminId of ADMIN_IDS) {
      const notifText =
        `🧾 *STRUK PEMBELIAN PRODUK*\n` +
        `━━━━━━━━━━━\n` +
        `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
        `𝗨𝗦𝗘𝗥 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : @${buyerUsername || "-"}\n` +
        `𝗣𝗥𝗢𝗗𝗨𝗞 : Admin Panel Private\n` +
        `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : Saldo\n` +
        `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
        `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRupiah(ADMIN_PRICE)}\n\n` +
        `━━━━━━━━━━━\n` +
        `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
        `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`ADMP${userId}\`\n` +
        `━━━━━━━━━━━`;
      bot.sendPhoto(adminId, buffer, {
        caption: notifText,
        parse_mode: "Markdown",
        reply_markup: buyerUsername ? { inline_keyboard: [[{ text: "👤 Cek Pembeli", url: `https://t.me/${buyerUsername}` }]] } : {}
      }).catch(() => {});
    }
  } catch (e) {
    for (const adminId of ADMIN_IDS) {
      const notifText =
        `🧾 *STRUK PEMBELIAN PRODUK*\n` +
        `━━━━━━━━━━━\n` +
        `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
        `𝗨𝗦𝗘𝗥 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : @${fromObj?.username || "-"}\n` +
        `𝗣𝗥𝗢𝗗𝗨𝗞 : Admin Panel Private\n` +
        `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : Saldo\n` +
        `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
        `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRupiah(ADMIN_PRICE)}\n\n` +
        `━━━━━━━━━━━\n` +
        `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
        `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`ADMP${userId}\`\n` +
        `━━━━━━━━━━━`;
      bot.sendMessage(adminId, notifText, {
// caption moved to sendMessage above
        parse_mode: "Markdown",
        reply_markup: fromObj?.username ? { inline_keyboard: [[{ text: "👤 Cek Pembeli", url: `https://t.me/${fromObj.username}` }]] } : {}
      }).catch(() => {});
    }
  }
}

// ===== POLLING QRIS =====
function startAdminPolling(bot, orderId, chatId, msgId) {
  if (activePolls.has(orderId)) return;
  const startTime = Date.now();

  let lastCaption = null;
  function editCap(text, keyboard) {
    if (text === lastCaption) return;
    lastCaption = text;
    bot.editMessageCaption(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown", reply_markup: keyboard
    }).catch((err) => {
      if (err?.response?.body?.description?.includes("message is not modified")) return;
      console.warn("[BAP EDITCAP]", err?.message);
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

        const state = userState.get(pending.userId);
        if (state && state.username) {
          await bot.sendMessage(chatId,
            `✅ *Pembayaran diterima!*\n\n` +
            `👤 Username: \`${state.username}\`\n\n` +
            `Sekarang pilih jenis password untuk akun admin private kamu:`,
            { parse_mode: "Markdown", reply_markup: passwordChoiceKeyboard(orderId) }
          );
          userState.set(pending.userId, { ...state, step: "choose_password", orderId });
        } else {
          await bot.sendMessage(chatId,
            `✅ *Pembayaran diterima!*\n\n` +
            `Sekarang kirimkan *username* yang kamu inginkan untuk akun admin panel private:\n\n` +
            `_Contoh: \`johndoe123\`_\n\n` +
            `_(Hanya huruf, angka, dan strip. Minimal 4 karakter)_`,
            { parse_mode: "Markdown" }
          );
          userState.set(pending.userId, { step: "awaiting_username", orderId, paymentMethod: "qris" });
        }
      } else {
        editCap(
          buildQrisCaption(orderId, pending.amount, pending.fee, pending.total_payment,
            pending.expired_at ? new Date(pending.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "-",
            status, 0),
          { inline_keyboard: [] }
        );
      }
    } catch (err) {
      console.warn(`[BUYADMINPRIVATE POLL] ${orderId}:`, err?.message);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
}

// ===== MODULE EXPORT =====
module.exports = function (bot) {

  // ===== Helper: jalankan flow buyadminprivate =====
  async function startBuyAdminPrivateFlow(chatId, userId, fromUser) {
    const saldo = await getSaldo(userId);
    const orderId = generateOrderId(userId);
    const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

    userState.set(userId, { step: "choose_payment", orderId });

    await bot.sendMessage(chatId,
        `<blockquote>` +
      `<em>🛍️ BELI ADMIN PANEL PTERODACTYL</em>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⌯⌲ Produk : Admin Panel Private\n` +
      `⌯⌲ Harga : ${formatRupiah(ADMIN_PRICE)}\n` +
      `⌯⌲ ID Telegram : <code>${userId}</code>\n` +
      `⌯⌲ Username Telegram : ${fromUser?.username ? `@${fromUser.username}` : "-"}\n` +
      `⌯⌲ Tanggal : ${tanggalStr}\n\n` +
      `<em>Pilih Metode Pembayaran anda</em>` +
            `</blockquote>`,
      { parse_mode: "HTML", reply_markup: payMethodKeyboard(orderId) }
    );
  }

  // ===== /buyadminprivate =====
  bot.onText(/\/buyadminprivate/, async (msg) => {
    await startBuyAdminPrivateFlow(msg.chat.id, String(msg.from.id), msg.from);
  });

  // ===== CALLBACK HANDLER =====
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = String(query.from.id);
    const data = query.data;

    // ─── Trigger dari tombol menu (start_adminprivate) ───
    if (data === "menu_adminprivate") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await startBuyAdminPrivateFlow(chatId, userId, query.from);
      return;
    }

    // Guard: hanya proses callback milik buyadminprivate
    if (!data.startsWith("bap_")) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ─── Bayar via Saldo ───
    if (data.startsWith("bap_pay_saldo:")) {
      const orderId = data.split(":")[1];
      const saldo = await getSaldo(userId);

      if (saldo < ADMIN_PRICE) {
        return bot.answerCallbackQuery(query.id, {
          text: `Saldo tidak cukup! Saldo kamu: ${formatRupiah(saldo)}`,
          show_alert: true
        });
      }

      await topupSaldo(userId, -ADMIN_PRICE);
      await saveTransaction({
        orderId, userId, chatId,
        type: "buyadminprivate",
        amount: ADMIN_PRICE,
        paymentMethod: "saldo",
        status: "paid",
        productName: "Admin Panel Private"
      });

      await bot.editMessageText(
        `✅ *Saldo berhasil dipotong!*\n\n` +
        `💵 Terpotong: ${formatRupiah(ADMIN_PRICE)}\n` +
        `💰 Sisa Saldo: ${formatRupiah(saldo - ADMIN_PRICE)}\n\n` +
        `Sekarang kirimkan *username* yang kamu inginkan untuk akun admin panel private:\n\n` +
        `_Contoh: \`johndoe123\`_\n_(Hanya huruf, angka, dan strip. Minimal 4 karakter)_`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      );

      userState.set(userId, { step: "awaiting_username", orderId, paymentMethod: "saldo" });
    }

    // ─── Bayar via QRIS ───
    if (data.startsWith("bap_pay_qris:")) {
      const orderId = data.split(":")[1];

      let result;
      try {
        await bot.editMessageText("⏳ Membuat transaksi QRIS...", { chat_id: chatId, message_id: msgId });
        result = await createTransaction({
          orderId, amount: ADMIN_PRICE,
          apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
        });
      } catch (err) {
        const errMsg = err?.response?.data?.message || err.message;
        return bot.editMessageText(`❌ Gagal buat transaksi:\n\`${errMsg}\``, {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
        });
      }

      const payment = result?.payment || result;
      const qrisStr = payment?.payment_number;
      const expiredAt = payment?.expired_at;
      const total = payment?.total_payment || ADMIN_PRICE;
      const fee = payment?.fee || 0;
      const expStr = expiredAt
        ? new Date(expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
        : "-";

      await savePending(orderId, {
        userId, chatId,
        amount: ADMIN_PRICE, fee, total_payment: total,
        expired_at: expiredAt, status: "pending"
      });

      await saveTransaction({
        orderId, userId, chatId,
        type: "buyadminprivate",
        amount: ADMIN_PRICE, fee, totalPayment: total,
        paymentMethod: "qris",
        status: "pending",
        productName: "Admin Panel Private",
        expiredAt
      });

      await bot.deleteMessage(chatId, msgId).catch(() => {});

      const caption = buildQrisCaption(orderId, ADMIN_PRICE, fee, total, expStr, "pending", 0, userId, query.from);

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

      userState.set(userId, { step: "waiting_qris", orderId, paymentMethod: "qris" });
      startAdminPolling(bot, orderId, chatId, sentMsg.message_id);
    }

    // ─── Cancel sebelum bayar ───
    if (data.startsWith("bap_cancel:")) {
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

    // ─── Cancel order QRIS yang sedang berjalan ───
    if (data.startsWith("bap_cancel_qris:")) {
      const orderId = data.split(":")[1];
      const pending = await getPending(orderId);

      if (!pending) {
        return bot.answerCallbackQuery(query.id, { text: "Order tidak ditemukan atau sudah selesai.", show_alert: true });
      }

      if (pending.userId !== userId) {
        return bot.answerCallbackQuery(query.id, { text: "⛔ Bukan order kamu.", show_alert: true });
      }

      if (activePolls.has(orderId)) {
        clearInterval(activePolls.get(orderId));
        activePolls.delete(orderId);
      }

      await removePending(orderId);
      await updateTransactionStatus(orderId, "cancelled");
      userState.delete(userId);

      try {
        await cancelTransaction({ orderId, amount: pending.amount, apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT });
      } catch (e) { console.warn("[BAP CANCEL]", e?.message); }

      await bot.deleteMessage(chatId, msgId).catch(() => {});
      const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : ${orderId}</em>\n` +
        `<em>⌯⌲  Tanggal : ${tglCancel}</em></blockquote>`;
      const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
    }

    // ─── Pilih password random ───
    if (data.startsWith("bap_pass_random:")) {
      const state = userState.get(userId);

      if (!state || !state.username) {
        return bot.sendMessage(chatId, "❌ Sesi habis. Silakan /buyadminprivate lagi.");
      }

      const password = generateRandomPassword();
      userState.delete(userId);

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      await deliverAccount(bot, chatId, userId, state.username, password, query.from);
    }

    // ─── Pilih password custom → minta input ───
    if (data.startsWith("bap_pass_custom:")) {
      const orderId = data.split(":")[1];
      const state = userState.get(userId);

      if (!state || !state.username) {
        return bot.sendMessage(chatId, "❌ Sesi habis. Silakan /buyadminprivate lagi.");
      }

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});

      await bot.sendMessage(chatId,
        `✏️ *Masukkan password custom kamu:*\n\n` +
        `_Minimal 8 karakter, boleh huruf, angka, dan simbol._`,
        { parse_mode: "Markdown" }
      );

      userState.set(userId, { ...state, step: "awaiting_custom_password", orderId });
    }
  });

  // ===== HANDLER PESAN TEKS (untuk input username & custom password) =====
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const state = userState.get(userId);

    if (!state) return;

    // ─── Step: Menunggu username ───
    if (state.step === "awaiting_username") {
      const username = msg.text.trim();

      if (!/^[a-zA-Z0-9_-]{4,32}$/.test(username)) {
        return bot.sendMessage(chatId,
          `❌ Username tidak valid!\n\n` +
          `• Minimal 4 karakter\n` +
          `• Maksimal 32 karakter\n` +
          `• Hanya huruf, angka, \`_\`, dan \`-\`\n\n` +
          `Coba kirim lagi:`,
          { parse_mode: "Markdown" }
        );
      }

      userState.set(userId, { ...state, step: "choose_password", username });

      await bot.sendMessage(chatId,
        `👤 Username: \`${username}\`\n\n` +
        `Pilih jenis password untuk akun admin private kamu:`,
        { parse_mode: "Markdown", reply_markup: passwordChoiceKeyboard(state.orderId) }
      );
    }

    // ─── Step: Menunggu custom password ───
    if (state.step === "awaiting_custom_password") {
      const password = msg.text.trim();

      if (password.length < 8) {
        return bot.sendMessage(chatId,
          `❌ Password terlalu pendek! Minimal 8 karakter.\n\nCoba kirim lagi:`
        );
      }

      userState.delete(userId);
      await deliverAccount(bot, chatId, userId, state.username, password, msg.from);
    }
  });
};
