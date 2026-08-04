const QRCode = require("qrcode");
const fetch = require("node-fetch");
const {
  getSaldo, topupSaldo,
  savePending, getPending, removePending,
  createTransaction, checkTransaction, cancelTransaction,
  saveTransaction, updateTransactionStatus
} = require("../../lib/pakasir");
const {
  PAKASIR_API_KEY, PAKASIR_PROJECT,
  OWNER_ID, LOG_CHANNEL_ID, domain, plta, egg, nestid, loc
} = require("../../config");
const { generateReceipt } = require("../../lib/receipt");

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const activePolls = new Map();
const activePackageMap = new Map(); // orderId → packageId

// State per user: { step, orderId, packageId, username, paymentMethod }
const userState = new Map();

// =====================================================================
// PAKET - sesuaikan harga lewat env atau langsung di sini
// =====================================================================
const PACKAGES = {
  "1gb": {
    label: "1GB RAM",
    emoji: "🟢",
    memory: 1024, cpu: 50,  disk: 1024,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_1GB)  || 1000
  },
  "2gb": {
    label: "2GB RAM",
    emoji: "🔵",
    memory: 2048, cpu: 70,  disk: 2048,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_2GB)  || 2000
  },
  "3gb": {
    label: "3GB RAM",
    emoji: "🟣",
    memory: 3072, cpu: 100, disk: 3072,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_3GB)  || 3000
  },
  "4gb": {
    label: "4GB RAM",
    emoji: "🟡",
    memory: 4048, cpu: 125, disk: 4048,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_4GB)  || 4000
  },
  "5gb": {
    label: "5GB RAM",
    emoji: "🟠",
    memory: 5138, cpu: 150, disk: 5138,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_5GB)  || 5000
  },
  "6gb": {
    label: "6GB RAM",
    emoji: "🔴",
    memory: 6014, cpu: 175, disk: 6014,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_6GB)  || 6000
  },
  "7gb": {
    label: "7GB RAM",
    emoji: "⚫",
    memory: 7014, cpu: 175, disk: 7014,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_7GB)  || 7000
  },
  "8gb": {
    label: "8GB RAM",
    emoji: "🌟",
    memory: 8015, cpu: 200, disk: 8015,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_8GB)  || 8000
  },
  "unli": {
    label: "Unlimited",
    emoji: "♾️",
    memory: 0, cpu: 0, disk: 0,
    databases: 5, backups: 5, allocations: 1,
    price: parseInt(process.env.BP_PRICE_UNLI) || 15000
  }
};

// =====================================================================
// HELPERS
// =====================================================================
function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function escapeMd(str) {
  return String(str).replace(/([_*`\[\]])/g, "\\$1");
}

function generateOrderId(userId) {
  return `BP${userId}${Date.now()}`;
}

function generateRandomPassword(length = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}

async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

// =====================================================================
// KEYBOARDS
// =====================================================================
function packageListKeyboard() {
  const rows = [];
  const pkgKeys = Object.keys(PACKAGES);

  // Susun 2 per baris
  for (let i = 0; i < pkgKeys.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, pkgKeys.length); j++) {
      const id = pkgKeys[j];
      const p = PACKAGES[id];
      row.push({
        text: `${p.emoji} ${p.label} — ${formatRupiah(p.price)}`,
        callback_data: `bp_select:${id}`
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "❌ Batal", callback_data: "bp_cancel" }]);
  return { inline_keyboard: rows };
}

function payMethodKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "💳 QRIS", callback_data: `bp_pay_qris:${orderId}` }
      ],
      [{ text: "⬅️ Kembali", callback_data: "bp_back_list" },
       { text: "❌ Batal", callback_data: "bp_cancel" }]
    ]
  };
}

function passwordChoiceKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ Password Custom", callback_data: `bp_pass_custom:${orderId}` },
        { text: "🎲 Password Random", callback_data: `bp_pass_random:${orderId}` }
      ]
    ]
  };
}

function qrisCancelKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "❌ Batalkan Order", callback_data: `bp_cancel_qris:${orderId}` }]
    ]
  };
}

// =====================================================================
// INVOICE TEXT
// =====================================================================
function buildInvoiceText(pkg, pkgId, saldo, userId, fromUser) {
  const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  return (
    `<i>🛍️ BELI PANEL PTERODACTYL</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⌯⌲ Produk : ${pkg.emoji} ${pkg.label}\n` +
    `⌯⌲ Harga : ${formatRupiah(pkg.price)}\n` +
    `⌯⌲ ID Telegram : <code>${userId}</code>\n` +
    `⌯⌲ Username Telegram : ${fromUser?.username ? `@${fromUser.username}` : "-"}\n` +
    `⌯⌲ Tanggal : ${tanggalStr}\n\n` +
    `<i>Pilih Metode Pembayaran anda</i>`
  );
}

// =====================================================================
// QRIS CAPTION
// =====================================================================
function buildQrisCaption(orderId, pkg, amount, fee, total, expStr, status, elapsed, userId, fromUser) {
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
Gunakan /buypanel untuk mencoba lagi.`;
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
    `⌯⌲ Produk : ${pkg.emoji} ${pkg.label}
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
// PTERODACTYL - buat user + server
// =====================================================================
async function createPteroUser(username, password) {
  const res = await fetch(`${domain}/api/application/users`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + plta
    },
    body: JSON.stringify({
      email: `${username}@gmail.com`,
      username,
      first_name: username,
      last_name: username,
      language: "en",
      password
    })
  });
  return res.json();
}

async function getEggStartup() {
  const res = await fetch(`${domain}/api/application/nests/${nestid}/eggs/${egg}`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + plta
    }
  });
  const data = await res.json();
  return data?.attributes?.startup || "node index.js";
}

async function createPteroServer(userId, username, pkg) {
  const startupCmd = await getEggStartup();
  const res = await fetch(`${domain}/api/application/servers`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + plta
    },
    body: JSON.stringify({
      name: `${username}-${pkg.label.replace(" ", "")}`,
      description: `Panel ${pkg.label}`,
      user: userId,
      egg: parseInt(egg),
      docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
      startup: startupCmd,
      environment: {
        INST: "npm",
        USER_UPLOAD: "0",
        AUTO_UPDATE: "0",
        CMD_RUN: "npm start"
      },
      limits: {
        memory: pkg.memory,
        swap: 0,
        disk: pkg.disk,
        io: 500,
        cpu: pkg.cpu
      },
      feature_limits: {
        databases: pkg.databases,
        backups: pkg.backups,
        allocations: pkg.allocations
      },
      deploy: {
        locations: [parseInt(loc)],
        dedicated_ip: false,
        port_range: []
      }
    })
  });
  return res.json();
}

// =====================================================================
// DELIVER PANEL ke user setelah bayar + username + password dipilih
// =====================================================================
async function deliverPanel(bot, chatId, telegramUserId, username, password, pkgId, fromObj) {
  const pkg = PACKAGES[pkgId];
  const ADMIN_IDS = LOG_CHANNEL_ID ? [String(LOG_CHANNEL_ID).trim()] : [];
  const sep = "─".repeat(28);

  const waitMsg = await bot.sendMessage(chatId, "⚙️ Sedang membuat akun & server panel kamu...");

  // 1. Buat user Pterodactyl
  const userData = await createPteroUser(username, password);

  if (userData.errors) {
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    const errText = JSON.stringify(userData.errors[0], null, 2);
    return bot.sendMessage(chatId,
      `❌ *Gagal membuat akun!*\n\n\`\`\`\n${errText}\n\`\`\`\n\nHubungi owner untuk bantuan.`,
      { parse_mode: "Markdown" }
    );
  }

  const pteroUser = userData.attributes;

  // 2. Buat server Pterodactyl
  const serverData = await createPteroServer(pteroUser.id, username, pkg);

  await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

  if (serverData.errors) {
    const errText = JSON.stringify(serverData.errors[0], null, 2);
    // User sudah terbuat tapi server gagal — tetap kirim kredensial
    await bot.sendMessage(chatId,
      `⚠️ *Akun berhasil dibuat, tapi server gagal dibuat!*\n\n\`\`\`\n${errText}\n\`\`\`\n\nHubungi owner dengan Order ID kamu.`,
      { parse_mode: "Markdown" }
    );
  }

  const server = serverData?.attributes;

  // 3. Kirim detail ke pembeli
  await bot.sendMessage(chatId,
    `✅ *PANEL BERHASIL DIBUAT!*\n${sep}\n\n` +
    `📦 Paket    : ${pkg.emoji} ${pkg.label}\n` +
    `🖥️ RAM      : ${pkg.memory === 0 ? "Unlimited" : pkg.memory + " MB"}\n` +
    `⚡ CPU      : ${pkg.cpu === 0 ? "Unlimited" : pkg.cpu + "%"}\n` +
    `💾 Disk     : ${pkg.disk === 0 ? "Unlimited" : pkg.disk + " MB"}\n` +
    `${sep}\n\n` +
    `👤 Username : \`${escapeMd(username)}\`\n` +
    `🔑 Password : \`${escapeMd(password)}\`\n` +
    `🌐 Login    : ${domain}\n` +
    (server ? `🖥️ Server   : \`${escapeMd(server.name)}\`\n` : "") +
    `\n*📌 PENTING — SIMPAN DATA INI!*\n` +
    `• Owner hanya kirim 1x data akun\n` +
    `• Garansi klaim wajib sertakan bukti beli\n` +
    `• Jangan rusuh server lain\n` +
    `• Buat panel secukupnya`,
    { parse_mode: "Markdown" }
  );

  // 4. Notif ke owner — kirim struk image
  try {
    const buyerName = fromObj
      ? [fromObj.first_name, fromObj.last_name].filter(Boolean).join(" ")
      : String(telegramUserId);
    const buyerUsername = fromObj?.username || null;

    const { buffer, filename } = await generateReceipt(bot, {
      buyerUserId:   telegramUserId,
      buyerName,
      buyerUsername,
      orderId:       `BP${telegramUserId}`,
      productLabel:  pkg.label,
      productType:   "Panel Pterodactyl",
      price:         pkg.price,
      paymentMethod: "saldo",   // default; dioverride dari state jika tersedia
      extraRows: [
        { label: "Username Ptero", value: username },
        { label: "Ptero ID",       value: String(pteroUser.id) },
        ...(server ? [{ label: "Server ID", value: String(server.id) }] : []),
        { label: "RAM",            value: pkg.memory === 0 ? "Unlimited" : pkg.memory + " MB" },
        { label: "CPU",            value: pkg.cpu === 0 ? "Unlimited" : pkg.cpu + "%" },
        { label: "Disk",           value: pkg.disk === 0 ? "Unlimited" : pkg.disk + " MB" }
      ],
      storeName:    "BiYu Store",
      storeContact: "@BiYuStore"
    });

    for (const adminId of ADMIN_IDS) {
      const notifText =
        `🧾 *STRUK PEMBELIAN PRODUK*\n` +
        `━━━━━━━━━━━\n` +
        `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${telegramUserId}\`\n` +
        `𝗨𝗦𝗘𝗥 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : @${buyerUsername || "-"}\n` +
        `𝗣𝗥𝗢𝗗𝗨𝗞 : ${pkg.emoji} ${pkg.label}\n` +
        `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : Saldo\n` +
        `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
        `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRupiah(pkg.price)}\n\n` +
        `━━━━━━━━━━━\n` +
        `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
        `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`BP${telegramUserId}\`\n` +
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
        `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${telegramUserId}\`\n` +
        `𝗨𝗦𝗘𝗥 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : @${fromObj?.username || "-"}\n` +
        `𝗣𝗥𝗢𝗗𝗨𝗞 : ${pkg.emoji} ${pkg.label}\n` +
        `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : Saldo\n` +
        `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
        `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRupiah(pkg.price)}\n\n` +
        `━━━━━━━━━━━\n` +
        `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
        `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`BP${telegramUserId}\`\n` +
        `━━━━━━━━━━━`;
      bot.sendMessage(adminId, notifText, {
// caption moved to sendMessage above
        parse_mode: "Markdown",
        reply_markup: fromObj?.username ? { inline_keyboard: [[{ text: "👤 Cek Pembeli", url: `https://t.me/${fromObj.username}` }]] } : {}
      }).catch(() => {});
    }
  }
}

// =====================================================================
// POLLING QRIS
// =====================================================================
function startPanelPolling(bot, orderId, chatId, msgId) {
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
      console.warn("[BP EDITCAP]", err?.message);
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
      const pkgId = activePackageMap.get(orderId) || pending.packageId || "1gb";
      const pkg = PACKAGES[pkgId] || PACKAGES["1gb"];
      const expStr = pending.expired_at
        ? new Date(pending.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
        : "-";

      // Timeout
      if (elapsed > POLL_TIMEOUT_MS) {
        clearInterval(intervalId);
        activePolls.delete(orderId);
        await removePending(orderId);
        await updateTransactionStatus(orderId, "expired");
        editCap(
          buildQrisCaption(orderId, pkg, pending.amount, pending.fee, pending.total_payment, expStr, "expired", elapsed, pending.userId, null),
          { inline_keyboard: [] }
        );
        return;
      }

      // Cek ke API
      const result = await checkTransaction({
        orderId, amount: pending.amount,
        apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
      });

      const status = result?.transaction?.status;

      if (!status || status === "pending") {
        editCap(
          buildQrisCaption(orderId, pkg, pending.amount, pending.fee, pending.total_payment, expStr, "pending", elapsed, pending.userId, null),
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
          // Username sudah ada → langsung tanya password
          await bot.sendMessage(chatId,
            `✅ *Pembayaran diterima!*\n\n` +
            `📦 Paket: ${pkg.emoji} ${pkg.label}\n` +
            `👤 Username: \`${escapeMd(state.username)}\`\n\n` +
            `Pilih jenis password:`,
            { parse_mode: "Markdown", reply_markup: passwordChoiceKeyboard(orderId) }
          );
          userState.set(pending.userId, { ...state, step: "choose_password", orderId });
        } else {
          // Minta username dulu
          await bot.sendMessage(chatId,
            `✅ *Pembayaran diterima!*\n\n` +
            `📦 Paket: ${pkg.emoji} ${pkg.label}\n\n` +
            `Sekarang kirim *username* yang kamu inginkan:\n\n` +
            `_Hanya huruf, angka, underscore dan strip. Min 4 karakter._`,
            { parse_mode: "Markdown" }
          );
          userState.set(pending.userId, {
            step: "awaiting_username",
            orderId,
            packageId: pkgId,
            paymentMethod: "qris"
          });
        }
      } else {
        editCap(
          buildQrisCaption(orderId, pkg, pending.amount, pending.fee, pending.total_payment, expStr, status, 0, pending.userId, null),
          { inline_keyboard: [] }
        );
      }
    } catch (err) {
      console.warn(`[BUYPANEL POLL] ${orderId}:`, err?.message);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
}

// =====================================================================
// MODULE EXPORT
// =====================================================================
// ── Helper: build teks list paket ────────────────────────────────────
async function buildPackageListText(userId) {
  const sep   = "─".repeat(28);
  const saldo = await getSaldo(userId);
  return (
    `🛒 *BELI PANEL PTERODACTYL*\n${sep}\n\n` +
    `Pilih paket yang kamu inginkan:\n\n` +
    Object.entries(PACKAGES).map(([id, p]) =>
      `${p.emoji} *${p.label}* — ${formatRupiah(p.price)}\n` +
      `   RAM: ${p.memory === 0 ? "∞" : p.memory + "MB"} | CPU: ${p.cpu === 0 ? "∞" : p.cpu + "%"} | Disk: ${p.disk === 0 ? "∞" : p.disk + "MB"}`
    ).join("\n\n") +
    `\n\n💵 Saldo kamu: *${formatRupiah(saldo)}*`
  );
}

module.exports = function (bot) {

  // ── /buypanel command ──────────────────────────────────────────────
  bot.onText(/\/buypanel/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text   = await buildPackageListText(userId);
    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: packageListKeyboard()
    });
  });

  // ── CALLBACK HANDLER ───────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const userId = String(query.from.id);
    const data   = query.data;

    // ── menu_buypanel: dari tombol "Buy Panel" di menu_panel.js ──────
    // Hapus pesan lama, kirim list paket baru
    if (data === "menu_panel") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try { await bot.deleteMessage(chatId, msgId); } catch (_) {}
      const text = await buildPackageListText(userId);
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: packageListKeyboard()
      });
      return;
    }

    // Guard — hanya milik buypanel
    const isBpCb = (
      data === "bp_cancel" ||
      data === "bp_back_list" ||
      data.startsWith("bp_select:") ||
      data.startsWith("bp_pay_qris:") ||
      data.startsWith("bp_pay_saldo:") ||
      data.startsWith("bp_cancel_qris:") ||
      data.startsWith("bp_pass_custom:") ||
      data.startsWith("bp_pass_random:")
    );
    if (!isBpCb) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── Batal ──────────────────────────────────────────────────────
    if (data === "bp_cancel") {
      const cancelState = userState.get(userId);
      const cancelOrderId = cancelState?.orderId || "-";
      userState.delete(userId);
      await bot.deleteMessage(chatId, msgId).catch(() => {});
      const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : </em>${cancelOrderId}\n` +
        `<em>⌯⌲  Tanggal : </em>${tglCancel}</blockquote>`;
      const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
      return;
    }

    // ── Kembali ke list paket ──────────────────────────────────────
    if (data === "bp_back_list") {
      const text = await buildPackageListText(userId);
      return bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: packageListKeyboard()
      });
    }

    // ── Pilih paket ────────────────────────────────────────────────
    if (data.startsWith("bp_select:")) {
      const pkgId = data.split(":")[1];
      const pkg   = PACKAGES[pkgId];
      if (!pkg) return;

      const orderId = generateOrderId(userId);
      const saldo   = await getSaldo(userId);

      userState.set(userId, { step: "choose_payment", orderId, packageId: pkgId });

      return bot.editMessageText(
        buildInvoiceText(pkg, pkgId, saldo, userId, query.from),
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "HTML",
          reply_markup: payMethodKeyboard(orderId)
        }
      );
    }

    // ── Bayar via Saldo ────────────────────────────────────────────
    if (data.startsWith("bp_pay_saldo:")) {
      const orderId = data.split(":")[1];
      const state   = userState.get(userId);
      if (!state) return;

      const pkg   = PACKAGES[state.packageId];
      const saldo = await getSaldo(userId);

      if (saldo < pkg.price) {
        return bot.answerCallbackQuery(query.id, {
          text: `Saldo tidak cukup! Saldo kamu: ${formatRupiah(saldo)}`,
          show_alert: true
        });
      }

      await topupSaldo(userId, -pkg.price);
      await saveTransaction({
        orderId, userId, chatId,
        type: "buypanel",
        amount: pkg.price,
        paymentMethod: "saldo",
        status: "paid",
        productName: `Panel ${pkg.label}`
      });

      await bot.editMessageText(
        `✅ *Saldo berhasil dipotong!*\n\n` +
        `📦 Paket: ${pkg.emoji} ${pkg.label}\n` +
        `💵 Terpotong: ${formatRupiah(pkg.price)}\n` +
        `💰 Sisa Saldo: ${formatRupiah(saldo - pkg.price)}\n\n` +
        `Sekarang kirim *username* yang kamu inginkan:\n\n` +
        `_Hanya huruf, angka, underscore dan strip. Min 4 karakter._`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      );

      userState.set(userId, {
        step: "awaiting_username",
        orderId,
        packageId: state.packageId,
        paymentMethod: "saldo"
      });
    }

    // ── Bayar via QRIS ─────────────────────────────────────────────
    if (data.startsWith("bp_pay_qris:")) {
      const orderId = data.split(":")[1];
      const state   = userState.get(userId);
      if (!state) return;

      const pkg = PACKAGES[state.packageId];

      let result;
      try {
        await bot.editMessageText("⏳ Membuat transaksi QRIS...", { chat_id: chatId, message_id: msgId });
        result = await createTransaction({
          orderId, amount: pkg.price,
          apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
        });
      } catch (err) {
        return bot.editMessageText(
          `❌ Gagal buat transaksi:\n\`${err?.response?.data?.message || err.message}\``,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
        );
      }

      const payment   = result?.payment || result;
      const qrisStr   = payment?.payment_number;
      const expiredAt = payment?.expired_at;
      const total     = payment?.total_payment || pkg.price;
      const fee       = payment?.fee || 0;
      const expStr    = expiredAt
        ? new Date(expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
        : "-";

      // Simpan ke pending — tambah packageId di metadata
      await savePending(orderId, {
        userId, chatId,
        amount: pkg.price, fee, total_payment: total,
        expired_at: expiredAt, status: "pending"
      });

      // Simpan packageId supaya polling tahu paketnya
      // Kita patch: simpan di userState dan juga override field di supabase via saveTransaction
      await saveTransaction({
        orderId, userId, chatId,
        type: "buypanel",
        amount: pkg.price, fee, totalPayment: total,
        paymentMethod: "qris",
        status: "pending",
        productName: `Panel ${pkg.label}`,
        expiredAt,
        metadata: { packageId: state.packageId }
      });

      userState.set(userId, {
        ...state,
        step: "waiting_qris",
        orderId,
        paymentMethod: "qris"
      });

      await bot.deleteMessage(chatId, msgId).catch(() => {});

      const caption = buildQrisCaption(orderId, pkg, pkg.price, fee, total, expStr, "pending", 0, userId, query.from);

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

      activePackageMap.set(orderId, state.packageId);

      startPanelPolling(bot, orderId, chatId, sentMsg.message_id);
    }

    // ── Cancel QRIS aktif ──────────────────────────────────────────
    if (data.startsWith("bp_cancel_qris:")) {
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
      activePackageMap.delete(orderId);

      await removePending(orderId);
      await updateTransactionStatus(orderId, "cancelled");
      userState.delete(userId);

      try {
        await cancelTransaction({ orderId, amount: pending.amount, apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT });
      } catch (e) { console.warn("[BP CANCEL]", e?.message); }

      await bot.deleteMessage(chatId, msgId).catch(() => {});
      const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : ${orderId}</em>\n` +
        `<em>⌯⌲  Tanggal : ${tglCancel}</em></blockquote>`;
      const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
    }

    // ── Password Random ────────────────────────────────────────────
    if (data.startsWith("bp_pass_random:")) {
      const state = userState.get(userId);
      if (!state || !state.username) {
        return bot.sendMessage(chatId, "❌ Sesi habis. Silakan /buypanel lagi.");
      }

      const password = generateRandomPassword();
      userState.delete(userId);

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      await deliverPanel(bot, chatId, userId, state.username, password, state.packageId, query.from);
    }

    // ── Password Custom → minta input ─────────────────────────────
    if (data.startsWith("bp_pass_custom:")) {
      const orderId = data.split(":")[1];
      const state   = userState.get(userId);
      if (!state || !state.username) {
        return bot.sendMessage(chatId, "❌ Sesi habis. Silakan /buypanel lagi.");
      }

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      await bot.sendMessage(chatId,
        `✏️ *Masukkan password custom kamu:*\n\n_Minimal 8 karakter, boleh huruf, angka, dan simbol._`,
        { parse_mode: "Markdown" }
      );

      userState.set(userId, { ...state, step: "awaiting_custom_password", orderId });
    }
  });

  // ── HANDLER TEKS: username & custom password ───────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const state  = userState.get(userId);

    if (!state || !state.step) return;

    // ── Tunggu username ──────────────────────────────────────────
    if (state.step === "awaiting_username") {
      const username = msg.text.trim();

      if (!/^[a-zA-Z0-9_-]{4,32}$/.test(username)) {
        return bot.sendMessage(chatId,
          `❌ *Username tidak valid!*\n\n` +
          `• Min 4 karakter, maks 32\n` +
          `• Hanya huruf, angka, underscore dan strip\n\n` +
          `Coba kirim lagi:`,
          { parse_mode: "Markdown" }
        );
      }

      userState.set(userId, { ...state, step: "choose_password", username });

      await bot.sendMessage(chatId,
        `👤 Username: \`${escapeMd(username)}\`\n` +
        `📦 Paket: ${PACKAGES[state.packageId]?.emoji} ${PACKAGES[state.packageId]?.label}\n\n` +
        `Pilih jenis password:`,
        { parse_mode: "Markdown", reply_markup: passwordChoiceKeyboard(state.orderId) }
      );
    }

    // ── Tunggu custom password ───────────────────────────────────
    if (state.step === "awaiting_custom_password") {
      const password = msg.text.trim();

      if (password.length < 8) {
        return bot.sendMessage(chatId,
          `❌ Password terlalu pendek! Minimal 8 karakter.\n\nCoba kirim lagi:`
        );
      }

      userState.delete(userId);
      await deliverPanel(bot, chatId, userId, state.username, password, state.packageId, msg.from);
    }
  });
};


