const {
  getSaldo,
  getUserTransactions,
  getUserTransactionStats
} = require("../../lib/pakasir");

function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function getTypeLabel(type) {
  const labels = {
    "deposit": "💳 Deposit",
    "buy_vps": "🖥️ Beli VPS",
    "buy_domain": "🌐 Beli Domain",
    "buy_hosting": "🏠 Beli Hosting",
    "buy_ssl": "🔐 Beli SSL",
    "topup": "💵 Top Up",
    "transfer": "📤 Transfer"
  };
  return labels[type] || `📦 ${type}`;
}

function getStatusEmoji(status) {
  const emojis = {
    "pending": "⏳",
    "processing": "🔄",
    "completed": "✅",
    "cancelled": "❌",
    "expired": "⌛",
    "failed": "❗"
  };
  return emojis[status] || "❓";
}

function getStatusLabel(status) {
  const labels = {
    "pending": "Menunggu",
    "processing": "Diproses",
    "completed": "Sukses",
    "cancelled": "Dibatalkan",
    "expired": "Kedaluwarsa",
    "failed": "Gagal"
  };
  return labels[status] || status;
}

function buildHistoryMessage(transactions, filter = "all") {
  const sep = "─".repeat(28);
  
  if (!transactions.length) {
    return `📜 *RIWAYAT TRANSAKSI*\n${sep}\n\n_Belum ada transaksi._`;
  }

  let text = `📜 *RIWAYAT TRANSAKSI*\n`;
  if (filter !== "all") {
    text += `📌 Filter: ${getTypeLabel(filter)}\n`;
  }
  text += `${sep}\n\n`;

  transactions.forEach((trx, idx) => {
    const date = new Date(trx.created_at).toLocaleString("id-ID", { 
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
    
    const statusEmoji = getStatusEmoji(trx.status);
    const typeLabel = getTypeLabel(trx.type);
    
    text += `${idx + 1}. ${statusEmoji} *${typeLabel}*\n`;
    text += `   📅 ${date}\n`;
    text += `   💰 ${formatRupiah(trx.amount)}\n`;
    
    if (trx.product_name) {
      text += `   📦 ${trx.product_name}\n`;
    }
    
    if (trx.payment_method) {
      text += `   💳 ${trx.payment_method.toUpperCase()}\n`;
    }
    
    text += `   🔖 \`${trx.order_id}\`\n`;
    text += `   📊 ${getStatusLabel(trx.status)}\n`;
    text += `\n`;
  });

  return text;
}

function buildStatsMessage(stats, saldo) {
  const sep = "─".repeat(28);
  
  let text = `📊 *STATISTIK TRANSAKSI*\n${sep}\n\n`;
  
  text += `💵 *Saldo Saat Ini:* ${formatRupiah(saldo)}\n\n`;
  
  text += `📈 *Ringkasan:*\n`;
  text += `├ Total Transaksi : ${stats.total}\n`;
  text += `├ ✅ Sukses       : ${stats.completed}\n`;
  text += `├ ⏳ Pending      : ${stats.pending}\n`;
  text += `├ ❌ Dibatalkan   : ${stats.cancelled}\n`;
  text += `├ ⌛ Kedaluwarsa  : ${stats.expired}\n`;
  text += `└ ❗ Gagal        : ${stats.failed}\n\n`;
  
  text += `💰 *Total Deposit Sukses:* ${formatRupiah(stats.totalDeposit)}\n`;
  text += `🛒 *Total Belanja Sukses:* ${formatRupiah(stats.totalSpent)}\n\n`;
  
  if (Object.keys(stats.byType).length > 0) {
    text += `${sep}\n📦 *Per Kategori:*\n`;
    for (const [type, data] of Object.entries(stats.byType)) {
      text += `├ ${getTypeLabel(type)}: ${data.completed}/${data.total} sukses\n`;
    }
  }
  
  return text;
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📜 History", callback_data: "nav_noop" },
        { text: "📦 Buy Script", callback_data: "nav_noop" }
      ],
      [
        { text: "🌊 Buy VPS DO", callback_data: "nav_noop" },
        { text: "🟠 Buy VPS Linode", callback_data: "nav_noop" }
      ],
      [
        { text: "📜 Semua", callback_data: "hist_all" },
        { text: "💳 Deposit", callback_data: "hist_deposit" }
      ],
      [
        { text: "🖥️ VPS", callback_data: "hist_buy_vps" },
        { text: "📊 Statistik", callback_data: "hist_stats" }
      ],
      [
        { text: "✅ Sukses", callback_data: "hist_status_completed" },
        { text: "⏳ Pending", callback_data: "hist_status_pending" }
      ],
      [
        { text: "❌ Dibatalkan", callback_data: "hist_status_cancelled" },
        { text: "⌛ Expired", callback_data: "hist_status_expired" }
      ]
    ]
  };
}

function backKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Kembali ke Menu", callback_data: "hist_menu" }]
    ]
  };
}

module.exports = function (bot) {

  // /history - View all transaction history
  bot.onText(/\/history/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    
    const transactions = await getUserTransactions(userId, { limit: 10 });
    const message = buildHistoryMessage(transactions);
    
    bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard()
    });
  });

  // /stats - View transaction statistics
  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    
    const stats = await getUserTransactionStats(userId);
    const saldo = await getSaldo(userId);
    const message = buildStatsMessage(stats, saldo);
    
    bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: backKeyboard()
    });
  });

  // Callback query handler
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = String(query.from.id);
    const data = query.data;

    // Guard: hanya proses callback milik history
    const isHistCallback = (
      data === "nav_noop" ||
      data === "hist_menu" ||
      data === "hist_all" ||
      data === "hist_stats" ||
      data.startsWith("hist_status_") ||
      (data.startsWith("hist_") && !data.startsWith("hist_status_") && !data.startsWith("hist_stats"))
    );
    if (!isHistCallback) return; // bukan milik history, biarkan handler lain yang proses

    // Button navigasi dekoratif (tidak fungsional)
    if (data === "nav_noop") {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // Back to history menu
    if (data === "hist_menu") {
      const transactions = await getUserTransactions(userId, { limit: 10 });
      const message = buildHistoryMessage(transactions);
      
      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: mainKeyboard()
      });
      return;
    }

    // View all transactions
    if (data === "hist_all") {
      const transactions = await getUserTransactions(userId, { limit: 15 });
      const message = buildHistoryMessage(transactions);
      
      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: mainKeyboard()
      });
      return;
    }

    // Filter by type
    if (data.startsWith("hist_") && !data.startsWith("hist_status_") && !data.startsWith("hist_stats")) {
      const type = data.replace("hist_", "");
      if (type === "all" || type === "menu") {
        await bot.answerCallbackQuery(query.id);
        return;
      }
      
      const transactions = await getUserTransactions(userId, { type, limit: 15 });
      const message = buildHistoryMessage(transactions, type);
      
      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: mainKeyboard()
      });
      return;
    }

    // Filter by status
    if (data.startsWith("hist_status_")) {
      const status = data.replace("hist_status_", "");
      const transactions = await getUserTransactions(userId, { status, limit: 15 });
      
      const statusLabel = getStatusLabel(status);
      const sep = "─".repeat(28);
      
      let message;
      if (!transactions.length) {
        message = `📜 *RIWAYAT TRANSAKSI*\n📌 Filter: ${getStatusEmoji(status)} ${statusLabel}\n${sep}\n\n_Tidak ada transaksi dengan status ini._`;
      } else {
        message = `📜 *RIWAYAT TRANSAKSI*\n📌 Filter: ${getStatusEmoji(status)} ${statusLabel}\n${sep}\n\n`;
        
        transactions.forEach((trx, idx) => {
          const date = new Date(trx.created_at).toLocaleString("id-ID", { 
            timeZone: "Asia/Jakarta",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          });
          
          const typeLabel = getTypeLabel(trx.type);
          
          message += `${idx + 1}. *${typeLabel}*\n`;
          message += `   📅 ${date}\n`;
          message += `   💰 ${formatRupiah(trx.amount)}\n`;
          
          if (trx.product_name) {
            message += `   📦 ${trx.product_name}\n`;
          }
          
          message += `   🔖 \`${trx.order_id}\`\n\n`;
        });
      }
      
      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: mainKeyboard()
      });
      return;
    }

    // View statistics
    if (data === "hist_stats") {
      const stats = await getUserTransactionStats(userId);
      const saldo = await getSaldo(userId);
      const message = buildStatsMessage(stats, saldo);
      
      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(message, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: mainKeyboard()
      });
      return;
    }
  });

};
