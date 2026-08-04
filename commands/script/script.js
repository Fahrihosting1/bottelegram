const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

const {
  saveTransaction, updateTransactionStatus, getTransaction, createTransaction,
  checkTransaction, cancelTransaction, trackTelegramUser, getSaldo, topupSaldo,
  savePending, getPending, removePending
} = require("../../lib/pakasir");

const { PAKASIR_API_KEY, PAKASIR_PROJECT, OWNER_ID } = require("../../config");
const { blockIfDisabled, blockCallbackIfDisabled } = require("../../lib/features");

const SCRIPTS_JSON = path.join(__dirname, "../../scripts/scripts.json");
const SCRIPTS_FOLDER = path.join(__dirname, "../../scripts/media");
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// Ensure scripts directory exists
if (!fs.existsSync(SCRIPTS_FOLDER)) {
  fs.mkdirSync(SCRIPTS_FOLDER, { recursive: true });
}

// Initialize scripts.json if not exists
if (!fs.existsSync(SCRIPTS_JSON)) {
  fs.writeFileSync(SCRIPTS_JSON, JSON.stringify({ scripts: [] }, null, 2));
}

// Read scripts from JSON
function readScriptsJSON() {
  try {
    const data = fs.readFileSync(SCRIPTS_JSON, "utf8");
    return JSON.parse(data).scripts || [];
  } catch (err) {
    return [];
  }
}

// Write scripts to JSON
function writeScriptsJSON(scripts) {
  fs.writeFileSync(SCRIPTS_JSON, JSON.stringify({ scripts }, null, 2));
}

// Get script by name from JSON
function getScriptByNameJSON(name) {
  const scripts = readScriptsJSON();
  return scripts.find(s => s.name.toLowerCase() === name.toLowerCase());
}

// Get script by code from JSON
function getScriptByCodeJSON(code) {
  const scripts = readScriptsJSON();
  return scripts.find(s => s.code === code);
}

// Map to track active payment polling
const activePolls = new Map();

// Keyboard builders
function scriptListKeyboard() {
  const scripts = readScriptsJSON();
  
  if (scripts.length === 0) {
    return {
      inline_keyboard: [
        [{ text: "Belum ada script tersedia", callback_data: "no_scripts" }],
        [{ text: "Kembali ke Menu", callback_data: "buy_script_home" }]
      ]
    };
  }

  const keyboard = scripts.map(script => [
    { 
      text: `${script.name} - Rp ${script.price.toLocaleString("id-ID")}`,
      callback_data: `buy_script:${script.code}`
    }
  ]);

  keyboard.push([{ text: "Kembali ke Menu", callback_data: "buy_script_home" }]);
  return { inline_keyboard: keyboard };
}

function paymentMethodKeyboard(scriptCode) {
  return {
    inline_keyboard: [
      [
        { text: "QRIS", callback_data: `script_pay_qris:${scriptCode}` }
      ],
      [{ text: "Kembali Pilih Script", callback_data: "buy_script_list" }]
    ]
  };
}

function afterPaymentKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Beli Script Lagi", callback_data: "buy_script_list" }],
      [{ text: "Cek Saldo", callback_data: "check_saldo" }],
      [{ text: "Kembali ke Menu", callback_data: "back_home" }]
    ]
  };
}

// Helper: kirim file script ke user dengan size check
async function sendScriptFile(bot, chatId, script, caption = null, replyMarkup = null) {
  const MAX_SIZE = 50 * 1024 * 1024; // 50MB batas Telegram
  try {
    const stat = fs.statSync(script.filePath);
    if (stat.size > MAX_SIZE) {
      return bot.sendMessage(chatId,
        `⚠️ File terlalu besar (${(stat.size / 1024 / 1024).toFixed(1)}MB).\n` +
        `Telegram membatasi maksimal 50MB.\nHubungi admin untuk pengiriman manual.`
      );
    }
    const opts = {
      caption: caption || script.name,
      contentType: "application/zip",
      filename: `${script.name}.zip`
    };
    if (caption) opts.parse_mode = "Markdown";
    if (replyMarkup) opts.reply_markup = replyMarkup;
    await bot.sendDocument(chatId, fs.createReadStream(script.filePath), opts);
  } catch (err) {
    console.error("[SEND FILE]", err);
    bot.sendMessage(chatId, `❌ Error mengirim file: ${err.message}`);
  }
}

module.exports = function (bot) {
  // ===== /ADDSCRIPT - Admin Add Script (space-separated args) =====
  bot.onText(/\/addscript(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const ADMIN_IDS = OWNER_ID ? String(OWNER_ID).split(",") : [];

    // Check admin
    if (!ADMIN_IDS.includes(userId)) {
      return bot.sendMessage(chatId, "Anda tidak memiliki akses ke command ini!");
    }

    // Check if reply to file
    if (!msg.reply_to_message?.document?.file_id) {
      return bot.sendMessage(
        chatId,
        "Reply pesan ke file ZIP script dengan format:\n" +
        "`/addscript NamaScript Harga Deskripsi`\n\n" +
        "Contoh:\n" +
        "`/addscript XC-AutoBot 50000 Bot Auto Claim XChain`"
      );
    }

    const argsText = match && match[1] ? match[1].trim() : "";
    
    if (!argsText || argsText.length === 0) {
      return bot.sendMessage(
        chatId,
        "Reply pesan ke file ZIP script dengan format:\n" +
        "`/addscript NamaScript Harga Deskripsi`\n\n" +
        "Contoh:\n" +
        "`/addscript XC-AutoBot 50000 Bot Auto Claim XChain`"
      );
    }

    const parts = argsText.split(/\s+/);

    if (parts.length < 3) {
      return bot.sendMessage(
        chatId,
        "Format tidak valid!\nGunakan: `/addscript NamaScript Harga Deskripsi`"
      );
    }

    const name = parts[0];
    const priceStr = parts[1];
    const description = parts.slice(2).join(" ");
    const price = parseInt(priceStr) || 0;

    if (!name || price <= 0) {
      return bot.sendMessage(chatId, "Nama atau Harga tidak valid!");
    }

    try {
      // Cek ukuran file sebelum download (Telegram Bot API max 20MB)
      const MAX_DOWNLOAD = 20 * 1024 * 1024;
      const fileSize = msg.reply_to_message.document.file_size || 0;
      if (fileSize > MAX_DOWNLOAD) {
        return bot.sendMessage(
          chatId,
          `❌ File terlalu besar! (${(fileSize / 1024 / 1024).toFixed(1)}MB)\n` +
          `Maksimal upload via bot adalah 20MB.\n` +
          `Kompres atau pecah file ZIP terlebih dahulu.`
        );
      }

      const statusMsg = await bot.sendMessage(chatId, "Mengunduh file...");

      // Download file
      const fileId = msg.reply_to_message.document.file_id;
      const fileStream = await bot.getFileStream(fileId);
      const tempPath = path.join(SCRIPTS_FOLDER, `temp_${Date.now()}.zip`);
      const writeStream = fs.createWriteStream(tempPath);

      fileStream.on("error", async (err) => {
        console.error("[DOWNLOAD STREAM]", err);
        fs.unlink(tempPath, () => {});
        await bot.editMessageText(
          `❌ Gagal mengunduh file: ${err.message}`,
          { chat_id: chatId, message_id: statusMsg.message_id }
        );
      });

      fileStream.pipe(writeStream);

      writeStream.on("finish", async () => {
        try {
          const safeFileName = name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
          const fileName = `${safeFileName}_${Date.now()}.zip`;
          const filePath = path.join(SCRIPTS_FOLDER, fileName);

          // Simpan ZIP langsung (rename dari temp)
          fs.renameSync(tempPath, filePath);

          // Update scripts.json
          const safeCode = name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
          const scripts = readScriptsJSON();
          scripts.push({
            name,
            code: safeCode,
            price,
            description,
            filePath,
            timestamp: Date.now()
          });

          writeScriptsJSON(scripts);

          await bot.editMessageText(
            `✅ SCRIPT BERHASIL DITAMBAHKAN\n\n` +
            `Nama: ${name}\n` +
            `Harga: Rp ${price.toLocaleString("id-ID")}\n` +
            `Deskripsi: ${description}`,
            { chat_id: chatId, message_id: statusMsg.message_id }
          );
        } catch (err) {
          console.error("[ADDSCRIPT]", err);
          await bot.editMessageText(
            `❌ Gagal extract file: ${err.message}`,
            { chat_id: chatId, message_id: statusMsg.message_id }
          );
        }
      });

      writeStream.on("error", async (err) => {
        console.error("[ADDSCRIPT WRITE]", err);
        await bot.editMessageText(
          `❌ Gagal unduh file: ${err.message}`,
          { chat_id: chatId, message_id: statusMsg.message_id }
        );
      });
    } catch (err) {
      console.error("[ADDSCRIPT ERROR]", err);
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });

  // ===== /BUYSCRIPT {NamaScript} - Direct Purchase =====
  bot.onText(/\/buyscript\s+(.+)/, async (msg) => {
    if (await blockIfDisabled(bot, "buy_scripts", msg.chat.id)) return;
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const scriptName = msg.match[1].trim();

    await trackTelegramUser(msg.from, chatId, bot.id);

    const script = getScriptByNameJSON(scriptName);

    if (!script) {
      return bot.sendMessage(
        chatId,
        `Script "${scriptName}" tidak ditemukan!\n\nGunakan /buyscript tanpa argumen untuk melihat list.`
      );
    }

    const saldo = await getSaldo(userId);

    const invoice =
      `BELI SCRIPT\n${"-".repeat(28)}\n\n` +
      `Script: ${script.name}\n` +
      `Harga: Rp ${script.price.toLocaleString("id-ID")}\n` +
      `Deskripsi: ${script.description || "-"}\n\n` +
      `SALDO ANDA\n${"-".repeat(28)}\n` +
      `Saldo: Rp ${saldo.toLocaleString("id-ID")}\n`;

    if (saldo >= script.price) {
      // Saldo cukup - langsung deduct dan kirim
      await topupSaldo(userId, -script.price);
      const orderId = `SCPT${Date.now()}`;

      await saveTransaction({
        orderId,
        userId,
        chatId,
        type: "script_purchase",
        amount: script.price,
        paymentMethod: "saldo",
        status: "completed",
        productId: script.name,
        productName: script.name,
        metadata: { provider: "local_script" }
      });

      // Send script file
      const fileMsg = `✅ PEMBELIAN BERHASIL!\n\n` +
        `Script: ${script.name}\n` +
        `Harga: Rp ${script.price.toLocaleString("id-ID")}\n` +
        `Saldo Tersisa: Rp ${(saldo - script.price).toLocaleString("id-ID")}\n\n` +
        `File siap didownload:`;

      await bot.sendMessage(chatId, fileMsg);

      // Send file
      await sendScriptFile(bot, chatId, script);
    } else {
      // Saldo kurang - minta pembayaran QRIS
      const deficit = script.price - saldo;

      return bot.sendMessage(
        chatId,
        invoice +
        `\n⚠️ SALDO TIDAK CUKUP!\n` +
        `Kurang: Rp ${deficit.toLocaleString("id-ID")}\n\n` +
        `Pilih metode pembayaran:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Saldo", callback_data: `script_pay_saldo:${script.name}` },
                { text: "QRIS", callback_data: `script_pay_qris:${script.name}` }
              ],
              [{ text: "Deposit Saldo", callback_data: "deposit" }]
            ]
          }
        }
      );
    }
  });

  // ===== /BUYSCRIPT - List Scripts (tanpa argumen) =====
  bot.onText(/\/buyscript$/, async (msg) => {
    if (await blockIfDisabled(bot, "buy_scripts", msg.chat.id)) return;
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);

    await trackTelegramUser(msg.from, chatId, bot.id);

    const scripts = readScriptsJSON();
    if (scripts.length === 0) {
      return bot.sendMessage(chatId, "Belum ada script tersedia.");
    }

    bot.sendMessage(
      chatId,
      `BELI SCRIPT\n${"─".repeat(28)}\n\nPilih script yang ingin dibeli:`,
      { reply_markup: scriptListKeyboard() }
    );
  });

  // ===== CALLBACK HANDLERS =====
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = String(query.from.id);
    const data = query.data;

    // Guard: hanya proses callback milik script
    if (!data.startsWith("script_") && !data.startsWith("buy_script")) return;

    if (await blockCallbackIfDisabled(bot, "buy_scripts", query)) return;

    try {
      // === List Scripts ===
      if (data === "buy_script_list") {
        await bot.editMessageText(
          `BELI SCRIPT\n${"─".repeat(28)}\n\nPilih script yang ingin dibeli:`,
          {
            chat_id: chatId,
            message_id: msgId,
            reply_markup: scriptListKeyboard()
          }
        );
      }

      // === Buy Script (Select) ===
      const buyMatch = data.match(/^buy_script:(.+)$/);
      if (buyMatch) {
        const scriptCode = buyMatch[1];
        const script = getScriptByCodeJSON(scriptCode);

        if (!script) {
          return bot.answerCallbackQuery(query.id, { text: "Script tidak ditemukan!", show_alert: true });
        }

        const tanggalStrScript = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        bot.editMessageText(
          `<i>🛍️ BELI SCRIPT</i>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `⌯⌲ Produk : ${script.name}\n` +
          `⌯⌲ Harga : Rp ${script.price.toLocaleString("id-ID")}\n` +
          `⌯⌲ ID Telegram : <code>${userId}</code>\n` +
          `⌯⌲ Username Telegram : ${query.from?.username ? `@${query.from.username}` : "-"}\n` +
          `⌯⌲ Tanggal : ${tanggalStrScript}\n\n` +
          `<i>Pilih Metode Pembayaran anda</i>`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "HTML",
            reply_markup: paymentMethodKeyboard(scriptCode)
          }
        );
      }

      // === Payment Saldo ===
      const saldoMatch = data.match(/^script_pay_saldo:(.+)$/);
      if (saldoMatch) {
        const scriptName = saldoMatch[1];
        const script = getScriptByNameJSON(scriptName);

        if (!script) {
          return bot.answerCallbackQuery(query.id, { text: "Script tidak ditemukan!", show_alert: true });
        }

        const saldo = await getSaldo(userId);

        if (saldo < script.price) {
          return bot.answerCallbackQuery(query.id, { text: "Saldo tidak cukup!", show_alert: true });
        }

        // Deduct saldo
        await topupSaldo(userId, -script.price);
        const orderId = `SCPT${Date.now()}`;

        await saveTransaction({
          orderId,
          userId,
          chatId,
          type: "script_purchase",
          amount: script.price,
          paymentMethod: "saldo",
          status: "completed",
          productId: script.name,
          productName: script.name,
          metadata: { provider: "local_script" }
        });

        // Send file
        const fileMsg = `✅ PEMBELIAN BERHASIL!\n\n` +
          `Script: ${script.name}\n` +
          `Harga: Rp ${script.price.toLocaleString("id-ID")}\n` +
          `Saldo Tersisa: Rp ${(saldo - script.price).toLocaleString("id-ID")}`;

        await bot.editMessageText(fileMsg, {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: afterPaymentKeyboard()
        });

        await sendScriptFile(bot, chatId, script);
      }

      // === Payment QRIS ===
      const qrisMatch = data.match(/^script_pay_qris:(.+)$/);
      if (qrisMatch) {
        const scriptName = qrisMatch[1];
        const script = getScriptByNameJSON(scriptName);

        if (!script) {
          return bot.answerCallbackQuery(query.id, { text: "Script tidak ditemukan!", show_alert: true });
        }

        const orderId = `SCPT${Date.now()}`;

        try {
          const trxResult = await createTransaction({
            orderId,
            amount: script.price,
            apiKey: PAKASIR_API_KEY,
            project: PAKASIR_PROJECT
          });

          const payment = trxResult?.payment || trxResult;
          const qrisStr = payment?.payment_number;

          if (!qrisStr) {
            return bot.answerCallbackQuery(query.id, { text: "QRIS tidak tersedia!", show_alert: true });
          }

          const fee = payment?.fee || 0;
          const total = payment?.total_payment || script.price;
          const expiredAt = payment?.expired_at || null;

          // Simpan ke pending (deposits table) - pakai signature yang benar
          await savePending(orderId, {
            userId, chatId,
            amount: script.price,
            fee,
            total_payment: total,
            expired_at: expiredAt,
            status: "pending"
          });
          // Simpan ke transactions history
          await saveTransaction({
            orderId, userId, chatId,
            type: "script_purchase",
            amount: script.price,
            fee, totalPayment: total,
            paymentMethod: "qris",
            status: "pending",
            productId: script.name,
            productName: script.name,
            expiredAt,
            metadata: { provider: "local_script", scriptName: script.name }
          });

          function buildScriptCaption(status, elapsed) {
            const expStr = expiredAt
              ? new Date(expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
              : "N/A";
            const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
            let statusLine = "";
            if (status === "pending") {
              const minLeft = Math.max(0, Math.ceil((POLL_TIMEOUT_MS - elapsed) / 60000));
              statusLine = `⏳ *Menunggu pembayaran...*\nSisa waktu: ±${minLeft} menit`;
            } else if (status === "completed") {
              statusLine = `✅ *PEMBAYARAN BERHASIL!*`;
            } else if (status === "expired") {
              statusLine = `⌛ *KEDALUWARSA*`;
            } else if (status === "cancelled") {
              statusLine = `🚫 *DIBATALKAN*`;
            }
            return (
              `🧾 *QRIS PEMBAYARAN PRODUK*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n\n` +
              `⌯⌲ ID Transaksi : \`${orderId}\`\n` +
              `⌯⌲ Produk : ${script.name}\n` +
              `⌯⌲ Harga Produk : Rp ${script.price.toLocaleString("id-ID")}\n` +
              `⌯⌲ Fee Admin : Rp ${fee.toLocaleString("id-ID")}\n` +
              `⌯⌲ Total Harga : *Rp ${total.toLocaleString("id-ID")}*\n` +
              `━━━━━━━━━━━\n` +
              `⌯⌲ ID Telegram : \`${userId}\`\n` +
              `⌯⌲ Username Telegram : ${query?.from?.username ? `@${query.from.username}` : "-"}\n` +
              `⌯⌲ Tanggal : ${tanggalStr}\n` +
              `⌯⌲ Expired : ${expStr}\n\n` +
              statusLine
            );
          }

          let lastCaption = null;
          function editCap(msgId2, text, keyboard) {
            if (text === lastCaption) return; // skip jika konten sama persis
            lastCaption = text;
            bot.editMessageCaption(text, {
              chat_id: chatId, message_id: msgId2,
              parse_mode: "Markdown",
              reply_markup: keyboard
            }).catch((err) => {
              // Abaikan error "message is not modified" dari Telegram
              if (err?.response?.body?.description?.includes("message is not modified")) return;
              console.warn("[EDITCAP]", err?.message);
            });
          }

          function qrisKeyboard(done) {
            if (done) return { inline_keyboard: [[{ text: "🏠 Kembali ke Menu", callback_data: "back_home" }]] };
            return { inline_keyboard: [[{ text: "❌ Batalkan Order", callback_data: `script_cancel:${orderId}` }]] };
          }

          const qrBuffer = await makeQrBuffer(qrisStr);
          await bot.deleteMessage(chatId, msgId).catch(() => {});

          const sentMsg = await bot.sendPhoto(chatId, qrBuffer, {
            caption: buildScriptCaption("pending", 0),
            parse_mode: "Markdown",
            reply_markup: qrisKeyboard(false)
          });

          const sentMsgId = sentMsg.message_id;

          // Realtime polling
          if (activePolls.has(orderId)) return;
          const startTime = Date.now();

          const pollInterval = setInterval(async () => {
            try {
              const pending = await getPending(orderId);
              if (!pending || pending.status !== "pending") {
                clearInterval(pollInterval);
                activePolls.delete(orderId);
                return;
              }

              const elapsed = Date.now() - startTime;

              // Timeout
              if (elapsed > POLL_TIMEOUT_MS) {
                clearInterval(pollInterval);
                activePolls.delete(orderId);
                await removePending(orderId);
                await updateTransactionStatus(orderId, "expired");
                editCap(sentMsgId, buildScriptCaption("expired", elapsed), qrisKeyboard(true));
                return;
              }

              // Cek ke API
              const result = await checkTransaction({
                orderId,
                amount: script.price,
                apiKey: PAKASIR_API_KEY,
                project: PAKASIR_PROJECT
              });

              const status = result?.transaction?.status;

              if (!status || status === "pending") {
                // Update countdown realtime
                editCap(sentMsgId, buildScriptCaption("pending", elapsed), qrisKeyboard(false));
                return;
              }

              // Status terminal
              clearInterval(pollInterval);
              activePolls.delete(orderId);
              await removePending(orderId);
              await updateTransactionStatus(orderId, status);

              if (status === "completed") {
                // Hapus foto QRIS
                await bot.deleteMessage(chatId, sentMsgId).catch(() => {});
                // Kirim file script sekaligus dengan caption ucapan terima kasih + keyboard
                await sendScriptFile(bot, chatId, script,
                  `🎉 *Terima kasih telah berbelanja!*\n\n` +
                  `✅ Pembayaran *Rp ${total.toLocaleString("id-ID")}* diterima\n` +
                  `📦 Script: *${script.name}*\n` +
                  `🔖 Order ID: \`${orderId}\`\n\n` +
                  `File siap didownload 👇`,
                  afterPaymentKeyboard()
                );
              } else {
                editCap(sentMsgId, buildScriptCaption(status, elapsed), qrisKeyboard(true));
              }
            } catch (err) {
              console.warn(`[SCRIPT POLL] ${orderId}:`, err?.message);
            }
          }, POLL_INTERVAL_MS);

          activePolls.set(orderId, pollInterval);

        } catch (err) {
          console.error("[QRIS ERROR]", err);
          bot.answerCallbackQuery(query.id, { text: `Error: ${err.message}`, show_alert: true });
        }
      }

      // === Cancel Order ===
      const cancelMatch = data.match(/^script_cancel:(.+)$/);
      if (cancelMatch) {
        const orderId = cancelMatch[1];

        // Cek pending dulu (bisa juga cek transaction)
        const order = await getPending(orderId) || await getTransaction(orderId);

        if (!order) {
          return bot.answerCallbackQuery(query.id, { text: "Order tidak ditemukan atau sudah selesai!", show_alert: true });
        }

        // Stop polling
        if (activePolls.has(orderId)) {
          clearInterval(activePolls.get(orderId));
          activePolls.delete(orderId);
        }

        // Hapus dari pending table
        await removePending(orderId).catch(() => {});

        // Update status di transactions table
        await updateTransactionStatus(orderId, "cancelled").catch(() => {});

        // Cancel ke API Pakasir
        try {
          await cancelTransaction({
            orderId,
            amount: order.amount,
            apiKey: PAKASIR_API_KEY,
            project: PAKASIR_PROJECT
          });
        } catch (err) {
          console.error("[CANCEL API]", err?.response?.data || err.message);
          // Lanjut meski API cancel gagal — status DB sudah cancelled
        }

        // Hapus pesan QRIS
        await bot.deleteMessage(chatId, msgId).catch(() => {});

        // Kirim konfirmasi cancel
        const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
        const cancelCaption =
          `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
          `<em>⌯⌲ Order ID : ${orderId}</em>\n` +
          `<em>⌯⌲  Tanggal : ${tglCancel}</em></blockquote>`;
        const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });

        return bot.answerCallbackQuery(query.id, { text: "✅ Order berhasil dibatalkan" });
      }

      // === Back to Menu ===
      if (data === "buy_script_home") {
        await bot.editMessageText(
          `BELI SCRIPT\n${"─".repeat(28)}\n\nPilih script yang ingin dibeli:`,
          {
            chat_id: chatId,
            message_id: msgId,
            reply_markup: scriptListKeyboard()
          }
        );
      }

      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error("[SCRIPT CALLBACK]", err);
      bot.answerCallbackQuery(query.id, { text: `Error: ${err.message}`, show_alert: true });
    }
  });
};
