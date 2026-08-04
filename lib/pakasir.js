const axios = require("axios");
const supabase = require("./supabase");

// ===== SALDO =====

async function getSaldo(userId) {
  const { data, error } = await supabase
    .from("saldo")
    .select("balance")
    .eq("user_id", String(userId))
    .single();
  if (error || !data) return 0;
  return data.balance;
}

async function topupSaldo(userId, amount) {
  const current = await getSaldo(userId);
  const newBalance = current + amount;

  await supabase.from("saldo").upsert({
    user_id: String(userId),
    balance: newBalance,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });

  await supabase.from("saldo_history").insert({
    user_id: String(userId),
    type: "deposit",
    amount,
    balance_after: newBalance,
    description: "Deposit via QRIS Pakasir"
  });

  return newBalance;
}

// ===== DEPOSIT (pending) =====

async function savePending(orderId, data) {
  await supabase.from("deposits").upsert({
    order_id: orderId,
    user_id: String(data.userId),
    chat_id: data.chatId,
    main_msg_id: data.mainMsgId || null,
    amount: data.amount,
    fee: data.fee || 0,
    total_payment: data.total_payment || data.amount,
    status: data.status || "pending",
    expired_at: data.expired_at || null,
    created_at: new Date().toISOString()
  }, { onConflict: "order_id" });
}

async function updateMainMsgId(orderId, mainMsgId) {
  await supabase.from("deposits")
    .update({ main_msg_id: mainMsgId })
    .eq("order_id", orderId);
}

async function getPending(orderId) {
  const { data, error } = await supabase
    .from("deposits")
    .select("*")
    .eq("order_id", orderId)
    .single();
  if (error || !data) return null;
  return {
    userId: data.user_id,
    chatId: data.chat_id,
    mainMsgId: data.main_msg_id,
    amount: data.amount,
    fee: data.fee,
    total_payment: data.total_payment,
    order_id: data.order_id,
    status: data.status,
    expired_at: data.expired_at,
    created_at: new Date(data.created_at).getTime()
  };
}

async function removePending(orderId) {
  await supabase.from("deposits").delete().eq("order_id", orderId);
}

async function getAllPending() {
  const { data } = await supabase
    .from("deposits")
    .select("*")
    .eq("status", "pending");
  if (!data) return {};
  const result = {};
  for (const row of data) {
    result[row.order_id] = {
      userId: row.user_id,
      chatId: row.chat_id,
      mainMsgId: row.main_msg_id,
      amount: row.amount,
      fee: row.fee,
      total_payment: row.total_payment,
      order_id: row.order_id,
      status: row.status,
      expired_at: row.expired_at,
      created_at: new Date(row.created_at).getTime()
    };
  }
  return result;
}

async function updatePendingStatus(orderId, status) {
  const update = { status };
  if (status === "completed") update.completed_at = new Date().toISOString();
  await supabase.from("deposits").update(update).eq("order_id", orderId);
}

// ===== PAKASIR API =====

async function createTransaction({ orderId, amount, apiKey, project, method = "qris" }) {
  const res = await axios.post(
    `https://app.pakasir.com/api/transactioncreate/${method}`,
    { project, order_id: orderId, amount, api_key: apiKey },
    { headers: { "Content-Type": "application/json" } }
  );
  return res.data;
}

async function checkTransaction({ orderId, amount, apiKey, project }) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(project)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(orderId)}` +
    `&api_key=${encodeURIComponent(apiKey)}`;

  console.log(`[CEK] ${url}`);
  try {
    const res = await axios.get(url);
    console.log(`[CEK] response:`, JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.error(`[CEK] HTTP ${err?.response?.status}:`, JSON.stringify(err?.response?.data));
    throw err;
  }
}

async function cancelTransaction({ orderId, amount, apiKey, project }) {
  const res = await axios.post(
    "https://app.pakasir.com/api/transactioncancel",
    { project, order_id: orderId, amount, api_key: apiKey },
    { headers: { "Content-Type": "application/json" } }
  );
  return res.data;
}

// ===== UNIFIED TRANSACTION HISTORY =====

/**
 * Save transaction to unified history
 * @param {object} data - Transaction data
 * @param {string} data.orderId - Unique order ID
 * @param {string} data.userId - Telegram user ID
 * @param {number} data.chatId - Telegram chat ID
 * @param {string} data.type - Transaction type: 'deposit', 'buy_vps', 'buy_domain', etc.
 * @param {string} data.status - Status: 'pending', 'processing', 'completed', 'cancelled', 'expired', 'failed'
 * @param {number} data.amount - Transaction amount
 * @param {number} data.fee - Fee (optional)
 * @param {number} data.totalPayment - Total payment (optional)
 * @param {string} data.paymentMethod - Payment method: 'saldo', 'qris' (optional)
 * @param {string} data.productId - Product ID (optional)
 * @param {string} data.productName - Product name (optional)
 * @param {object} data.metadata - Additional data as JSON (optional)
 * @param {string} data.expiredAt - Expiry timestamp (optional)
 */
async function saveTransaction(data) {
  await supabase.from("transactions").upsert({
    order_id: data.orderId,
    user_id: String(data.userId),
    chat_id: data.chatId,
    type: data.type,
    status: data.status || "pending",
    amount: data.amount,
    fee: data.fee || 0,
    total_payment: data.totalPayment || data.amount,
    payment_method: data.paymentMethod || null,
    product_id: data.productId || null,
    product_name: data.productName || null,
    metadata: data.metadata || {},
    expired_at: data.expiredAt || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: "order_id" });
}

/**
 * Update transaction status
 * @param {string} orderId - Order ID
 * @param {string} status - New status
 * @param {object} additionalData - Additional fields to update
 */
async function updateTransactionStatus(orderId, status, additionalData = {}) {
  const update = { 
    status, 
    updated_at: new Date().toISOString(),
    ...additionalData
  };
  if (status === "completed") update.completed_at = new Date().toISOString();
  await supabase.from("transactions").update(update).eq("order_id", orderId);
}

/**
 * Get transaction by order ID
 * @param {string} orderId - Order ID
 */
async function getTransaction(orderId) {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("order_id", orderId)
    .single();
  return error ? null : data;
}

/**
 * Get all transactions for a user
 * @param {string} userId - User ID
 * @param {object} options - Query options
 * @param {string} options.type - Filter by type (optional)
 * @param {string} options.status - Filter by status (optional)
 * @param {number} options.limit - Limit results (default 20)
 */
async function getUserTransactions(userId, options = {}) {
  let query = supabase
    .from("transactions")
    .select("*")
    .eq("user_id", String(userId))
    .order("created_at", { ascending: false })
    .limit(options.limit || 20);

  if (options.type) {
    query = query.eq("type", options.type);
  }
  if (options.status) {
    query = query.eq("status", options.status);
  }

  const { data } = await query;
  return data || [];
}

/**
 * Get transaction statistics for a user
 * @param {string} userId - User ID
 */
async function getUserTransactionStats(userId) {
  const { data } = await supabase
    .from("transactions")
    .select("type, status, amount")
    .eq("user_id", String(userId));

  if (!data) return { total: 0, completed: 0, pending: 0, cancelled: 0, expired: 0, byType: {} };

  const stats = {
    total: data.length,
    completed: 0,
    pending: 0,
    cancelled: 0,
    expired: 0,
    failed: 0,
    totalSpent: 0,
    totalDeposit: 0,
    byType: {}
  };

  for (const trx of data) {
    // Count by status
    if (trx.status === "completed") {
      stats.completed++;
      if (trx.type === "deposit") {
        stats.totalDeposit += Number(trx.amount);
      } else {
        stats.totalSpent += Number(trx.amount);
      }
    } else if (trx.status === "pending" || trx.status === "processing") {
      stats.pending++;
    } else if (trx.status === "cancelled") {
      stats.cancelled++;
    } else if (trx.status === "expired") {
      stats.expired++;
    } else if (trx.status === "failed") {
      stats.failed++;
    }

    // Count by type
    if (!stats.byType[trx.type]) {
      stats.byType[trx.type] = { total: 0, completed: 0 };
    }
    stats.byType[trx.type].total++;
    if (trx.status === "completed") {
      stats.byType[trx.type].completed++;
    }
  }

  return stats;
}

// ===== TELEGRAM USER TRACKING =====
//
// PENTING — MULTI-TENANT (1 proses = N bot rental):
// Tabel `telegram_users` dipakai bareng-bareng oleh SEMUA bot rental (1 tabel
// Supabase untuk semua tenant), sama persis kayak ok_produk/ok_stok. Makanya
// SEMUA fungsi di bawah WAJIB dikasih `botId` (= bot.id dari bot.js) sebagai
// argumen, dan SEMUA query WAJIB di-filter `.eq("bot_id", botId)`. Tanpa ini,
// user yang /start di bot A bakal ketarik & ke-broadcast juga sama bot B.
//
// Catatan: user_id Telegram yang sama bisa aja /start di bot A DAN bot B —
// itu dianggap 2 baris terpisah (unique key sekarang jadi bot_id + user_id,
// bukan user_id doang), karena secara bisnis dia adalah "member" masing-
// masing bot secara independen.

/**
 * Track or update Telegram user
 * Menyimpan/update data user setiap kali ada interaksi dengan bot
 * @param {object} telegramUser - Telegram user object dari msg.from
 * @param {number} chatId - Chat ID
 * @param {string} botId - bot.id (rental id) — WAJIB, buat scoping per bot
 */
async function trackTelegramUser(telegramUser, chatId, botId) {
  if (!telegramUser || !telegramUser.id) return null;
  if (!botId) throw new Error("trackTelegramUser: botId wajib diisi (multi-tenant).");

  // Jangan track akun bot (termasuk bot ini sendiri kalau Telegram ngirim
  // balik echo pesan yang dikirim bot itu sendiri). Cuma user manusia yang
  // boleh masuk telegram_users.
  if (telegramUser.is_bot) return null;

  const userId = String(telegramUser.id);
  const now = new Date().toISOString();

  // Cek apakah user sudah ada — DI BOT INI SAJA
  const { data: existingUser } = await supabase
    .from("telegram_users")
    .select("interaction_count")
    .eq("bot_id", botId)
    .eq("user_id", userId)
    .single();

  if (existingUser) {
    // Update user yang sudah ada
    await supabase
      .from("telegram_users")
      .update({
        chat_id: chatId,
        username: telegramUser.username || null,
        first_name: telegramUser.first_name || null,
        last_name: telegramUser.last_name || null,
        language_code: telegramUser.language_code || null,
        is_premium: telegramUser.is_premium || false,
        last_active_at: now,
        interaction_count: existingUser.interaction_count + 1,
        updated_at: now
      })
      .eq("bot_id", botId)
      .eq("user_id", userId);
  } else {
    // Insert user baru (baru pertama kali /start atau interaksi di bot INI)
    await supabase.from("telegram_users").insert({
      bot_id: botId,
      user_id: userId,
      chat_id: chatId,
      username: telegramUser.username || null,
      first_name: telegramUser.first_name || null,
      last_name: telegramUser.last_name || null,
      language_code: telegramUser.language_code || null,
      is_bot: telegramUser.is_bot || false,
      is_premium: telegramUser.is_premium || false,
      first_seen_at: now,
      last_active_at: now,
      interaction_count: 1,
      created_at: now,
      updated_at: now
    });
  }

  return userId;
}

/**
 * Get total number of unique users — DI BOT INI SAJA
 * @param {string} botId
 */
async function getTotalUsers(botId) {
  if (!botId) return 0;
  const { count, error } = await supabase
    .from("telegram_users")
    .select("*", { count: "exact", head: true })
    .eq("bot_id", botId);

  return error ? 0 : count;
}

/**
 * Get user statistics — DI BOT INI SAJA
 * @param {string} botId
 */
async function getUserStats(botId) {
  if (!botId) return { total: 0, activeToday: 0, activeWeek: 0, premiumUsers: 0, users: [] };

  const { data, error } = await supabase
    .from("telegram_users")
    .select("*")
    .eq("bot_id", botId)
    .order("last_active_at", { ascending: false });

  if (error || !data) return { total: 0, activeToday: 0, activeWeek: 0, premiumUsers: 0, users: [] };

  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const stats = {
    total: data.length,
    activeToday: 0,
    activeWeek: 0,
    premiumUsers: 0,
    totalInteractions: 0,
    users: data.slice(0, 50) // Return top 50 most recent users
  };

  for (const user of data) {
    const lastActive = new Date(user.last_active_at);
    if (lastActive >= oneDayAgo) stats.activeToday++;
    if (lastActive >= oneWeekAgo) stats.activeWeek++;
    if (user.is_premium) stats.premiumUsers++;
    stats.totalInteractions += user.interaction_count || 0;
  }

  return stats;
}

/**
 * Get all Telegram users (for broadcast) — DI BOT INI SAJA
 * @param {string} botId
 * @returns {Array} - list of { user_id, chat_id }
 */
async function getAllTelegramUsers(botId) {
  if (!botId) return [];
  const { data, error } = await supabase
    .from("telegram_users")
    .select("user_id, chat_id")
    .eq("bot_id", botId);
  return error ? [] : (data || []);
}

/**
 * Get a specific Telegram user by user_id — DI BOT INI SAJA
 * @param {string} userId - Telegram user ID
 * @param {string} botId
 */
async function getTelegramUser(userId, botId) {
  if (!botId) return null;
  const { data, error } = await supabase
    .from("telegram_users")
    .select("*")
    .eq("bot_id", botId)
    .eq("user_id", String(userId))
    .single();

  return error ? null : data;
}

// ===== SCRIPT FUNCTIONS =====

/**
 * Add new script to database
 * @param {object} scriptData - {code, name, description, price, fileId, fileName, createdBy}
 */
async function addScript(scriptData) {
  const { data, error } = await supabase
    .from("scripts")
    .insert([{
      code: scriptData.code,
      name: scriptData.name,
      description: scriptData.description || null,
      price: scriptData.price,
      file_id: scriptData.fileId,
      file_name: scriptData.fileName,
      created_by: String(scriptData.createdBy),
      is_active: true,
      created_at: new Date().toISOString()
    }])
    .select();

  return data?.[0] || null;
}

/**
 * Get all active scripts
 */
async function getScripts() {
  const { data, error } = await supabase
    .from("scripts")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  return error ? [] : (data || []);
}

/**
 * Get script by code
 */
async function getScriptByCode(code) {
  const { data, error } = await supabase
    .from("scripts")
    .select("*")
    .eq("code", code)
    .eq("is_active", true)
    .single();

  return error ? null : data;
}

/**
 * Save script order
 */
async function saveScriptOrder(orderData) {
  const { data, error } = await supabase
    .from("script_orders")
    .insert([{
      order_id: orderData.orderId,
      user_id: String(orderData.userId),
      chat_id: orderData.chatId,
      script_code: orderData.scriptCode,
      script_name: orderData.scriptName,
      price: orderData.price,
      payment_method: orderData.paymentMethod,
      status: orderData.status || "pending_payment",
      created_at: new Date().toISOString()
    }])
    .select();

  return data?.[0] || null;
}

/**
 * Get script order by ID
 */
async function getScriptOrder(orderId) {
  const { data, error } = await supabase
    .from("script_orders")
    .select("*")
    .eq("order_id", orderId)
    .single();

  return error ? null : data;
}

/**
 * Update script order status
 */
async function updateScriptOrderStatus(orderId, status) {
  const { data, error } = await supabase
    .from("script_orders")
    .update({
      status,
      updated_at: new Date().toISOString(),
      completed_at: status === "completed" ? new Date().toISOString() : null
    })
    .eq("order_id", orderId)
    .select();

  return data?.[0] || null;
}

/**
 * Get user script purchases
 */
async function getUserScriptPurchases(userId) {
  const { data, error } = await supabase
    .from("script_orders")
    .select("*")
    .eq("user_id", String(userId))
    .eq("status", "completed")
    .order("completed_at", { ascending: false });

  return error ? [] : (data || []);
}

module.exports = {
  getSaldo, topupSaldo,
  savePending, getPending, removePending, getAllPending,
  updatePendingStatus, updateMainMsgId,
  createTransaction, checkTransaction, cancelTransaction,
  // Unified transaction history
  saveTransaction, updateTransactionStatus, getTransaction,
  getUserTransactions, getUserTransactionStats,
  // Telegram user tracking
  trackTelegramUser, getTotalUsers, getUserStats, getTelegramUser, getAllTelegramUsers,
  // Script functions
  addScript, getScripts, getScriptByCode, saveScriptOrder, getScriptOrder,
  updateScriptOrderStatus, getUserScriptPurchases
};
