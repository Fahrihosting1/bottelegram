/**
 * ORDERKUOTA - Tampilan ala Cansa Pedia
 * QRIS only, polling logic sama persis dengan deposit.js yang work
 *
 * PERUBAHAN:
 * 1. "🏷️ List Produk" → callback (tidak perlu ketik /stok)
 * 2. Setelah transaksi selesai/expired/cancel → hapus semua pesan keyboard
 */

const QRCode = require("qrcode");
const path   = require("path");
const fs     = require("fs");
const { getBotLogo } = require("../../lib/media");

async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

const {
  saveTransaction,
  updateTransactionStatus,
  getTotalUsers,
} = require("../../lib/pakasir");
const supabase = require("../../lib/supabase");
const { createPayment, checkPayment, cancelPayment, PROVIDER_LABELS } = require("../../lib/payment-provider");
const { blockIfDisabled, blockCallbackIfDisabled } = require("../../lib/features");

const {
  getProdukList,
  getProdukById,
  addProduk,
  getStokCount,
  addStok,
  popStok,
  incrementTerjual,
  saveOrderKuota,
  updateOrderKuotaStatus,
  getOrderKuotaByOrderId,
  addBotSaldo,
  getCustomEmoji,
} = require("./orderkuota_db");

const {
  OWNER_ID,
} = require("../../config");


const { generateQrisCard } = require("../../lib/qris-card");

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS  = 10 * 60_000;
const ITEMS_PER_PAGE   = 6;

// State in-memory
const userState   = new Map(); // userId → { jumlahDetail, detailProdukId, waitingQty, keyboardMsgId }
const activePolls = new Map(); // orderId → intervalId
const pendingOrders = new Map(); // orderId → { userId, chatId, produk, jumlah, amount, fee, totalPayment, qrisMsgId, fromUser }
const processingOrders = new Set(); // orderId yang sedang diproses terminal — guard anti-dobel

// ── helpers ───────────────────────────────────────────────────────────────────

function formatRp(n) {
  return "Rp. " + Number(n).toLocaleString("id-ID");
}

function genOrderId(userId) {
  const short = String(userId).slice(-6);
  const ts    = Date.now().toString().slice(-8);
  return `KT${short}${ts}`;
}

function randomFee() {
  return Math.floor(Math.random() * 150) + 1;
}

// ── Reply Keyboard Dinamis ────────────────────────────────────────────────────

function buildMainKeyboard(produkList) {
  const count = produkList ? produkList.length : 0;

  const numButtons = [];
  for (let i = 1; i <= count; i++) {
    numButtons.push({ text: String(i) });
  }

  const numRows = [];
  for (let i = 0; i < numButtons.length; i += 3) {
    numRows.push(numButtons.slice(i, i + 3));
  }

  return {
    keyboard: [
      [
        { text: "🏷️ List Produk" },
        { text: "🎟️ Voucher" },
        { text: "📦 Laporan Stok" },
      ],
      ...numRows,
      [
        { text: "💰 Deposit" },
        { text: "❓ Cara Order" },
        { text: "⚠️ Information" },
      ],
    ],
    resize_keyboard: true,
    persistent: true,
  };
}

// Keyboard kosong → hapus reply keyboard
function removeKeyboard() {
  return { remove_keyboard: true };
}

async function getMainKeyboard(botId) {
  const produkList = await getProdukList(botId);
  return buildMainKeyboard(produkList);
}

// ── Helper: hapus pesan keyboard + kirim keyboard baru ───────────────────────

/**
 * Simpan message_id dari pesan "." yang jadi anchor reply keyboard.
 * Dipanggil setiap kali kita kirim reply keyboard baru.
 */
function saveKeyboardMsgId(userId, msgId) {
  const prev = userState.get(userId) || {};
  userState.set(userId, { ...prev, keyboardMsgId: msgId });
}

/**
 * Hapus pesan keyboard lama milik user (pesan "." yang punya reply_markup).
 * Dipanggil saat transaksi selesai / expired / cancel.
 */
async function deleteKeyboardMsg(bot, chatId, userId) {
  const state = userState.get(userId) || {};
  if (state.keyboardMsgId) {
    try { await bot.deleteMessage(chatId, state.keyboardMsgId); } catch (_) {}
    const updated = { ...state, keyboardMsgId: null };
    userState.set(userId, updated);
  }
}

// ── Inline Keyboards ──────────────────────────────────────────────────────────

function detailProdukKeyboard(produkId) {
  return {
    inline_keyboard: [
      [
        { text: "➖",       callback_data: `ok_minus:${produkId}` },
        { text: "📝 Edit",  callback_data: `ok_edit:${produkId}` },
        { text: "🔄",       callback_data: `ok_refresh:${produkId}` },
        { text: "➕",       callback_data: `ok_plus:${produkId}` },
      ],
      [
        { text: "🛒 Buy ( Now )", callback_data: `ok_buynow:${produkId}` },
      ],
    ],
  };
}

function qrisCancelKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "❌ Batalkan Pembayaran", callback_data: `ok_cancel:${orderId}` }],
    ],
  };
}

// ── Format pesan list produk ──────────────────────────────────────────────────

/**
 * Build satu baris nama produk dengan custom emoji Telegram Premium (kalau ada).
 *
 * Custom emoji Telegram ditulis dalam format HTML entity:
 *   <tg-emoji emoji-id="ID_ANGKA">FALLBACK_EMOJI</tg-emoji>
 *
 * Kalau user non-Premium, Telegram otomatis tampilkan FALLBACK_EMOJI (✨) biasa.
 * Kalau user Premium, tampil emoji animasi kustom yang sesuai.
 *
 * @param {string} nama - Nama produk
 * @param {string|null} customEmojiId - ID custom emoji Telegram
 * @returns {string} - Baris nama produk dengan atau tanpa custom emoji
 */
function formatNamaProdukWithEmoji(nama, customEmojiId) {
  if (!customEmojiId) return nama.toUpperCase();
  // Custom emoji di Telegram pakai tag <tg-emoji> di parse_mode HTML
  // Fallback ✨ muncul untuk user non-Premium
  return `<tg-emoji emoji-id="${customEmojiId}">✨</tg-emoji> ${nama.toUpperCase()}`;
}

async function buildListProduk(botId, produkList, page = 1) {
  const totalPage = Math.ceil(produkList.length / ITEMS_PER_PAGE) || 1;
  const start     = (page - 1) * ITEMS_PER_PAGE;
  const slice     = produkList.slice(start, start + ITEMS_PER_PAGE);

  let lines = `LIST PRODUCT\n\n`;
  for (let i = 0; i < slice.length; i++) {
    const p    = slice[i];
    const stok = await getStokCount(botId, p.id);
    const namaWithEmoji = formatNamaProdukWithEmoji(p.nama, p.custom_emoji_id);
    lines += `[${start + i + 1}]. ${namaWithEmoji} ( ${stok} )\n`;
  }

  const now = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour12: false });
  lines += `\n📄 Halaman ${page} / ${totalPage}\n🕐 ${now}`;

  return { text: lines, totalPage, page };
}

// ── Format pesan detail produk ────────────────────────────────────────────────

function escMd(str) {
  return String(str || "").replace(/([_*`[\]])/g, "\\$1");
}

async function buildDetailProduk(bot, botId, produk, jumlah = 1, fromUser = null) {
  const stok  = produk._stokOverride !== undefined
    ? produk._stokOverride
    : await getStokCount(botId, produk.id);
  const total = produk.harga * jumlah;
  const now   = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour12: false });

  const hargaGrosirMin = 5;
  const hargaGrosir    = Math.round(produk.harga * 0.83);

  // ── Ambil owner_id dari DB (tabel telegram_bot_rentals) ───────────────────
  let ownerIdRaw = "-";
  let ownerName  = "-";
  try {
    const { data: botRow } = await supabase
      .from("telegram_bot_rentals")
      .select("owner_id")
      .eq("id", botId)
      .single();
    if (botRow?.owner_id) {
      ownerIdRaw = String(botRow.owner_id);
      // Coba ambil nama owner dari Telegram
      try {
        const ownerChat = await bot.getChat(ownerIdRaw);
        const parts = [ownerChat.first_name, ownerChat.last_name].filter(Boolean);
        ownerName = parts.length ? parts.join(" ") : (ownerChat.username ? `@${ownerChat.username}` : ownerIdRaw);
      } catch (_) {
        ownerName = ownerIdRaw; // fallback ke ID kalau getChat gagal
      }
    }
  } catch (_) {}

  // ── Ambil total user & total trx user ini dari ok_orders ──────────────────
  const cusId = fromUser?.id ?? null;

  const [totalUser, trxCount] = await Promise.all([
    getTotalUsers(botId).catch(() => 0),
    cusId
      ? supabase
          .from("ok_orders")
          .select("order_id", { count: "exact", head: true })
          .eq("bot_id", botId)
          .eq("user_id", String(cusId))
          .then(({ count }) => count ?? 0)
          .catch(() => 0)
      : Promise.resolve(0),
  ]);

  // ── Info customer ──────────────────────────────────────────────────────────
  const cusUsername = fromUser?.username ? `@${fromUser.username}` : "-";
  const ownerTag    = ownerIdRaw !== "-"
    ? `<a href="tg://user?id=${ownerIdRaw}">${ownerName}</a>`
    : "-";

  return (
    `<b>🏷 INFORMASI CUSTOMER</b>\n` +
    `➜ Name Cus : ${cusUsername}\n` +
    `➜ ID Cus : <code>${cusId ?? "-"}</code>\n` +
    `➜ Tanggal / Jam : ${now}\n\n` +
    `<b>🏷 INFORMASI BOT</b>\n` +
    `➜ Name Owner : ${ownerTag}\n` +
    `➜ ID Owner : <code>${ownerIdRaw}</code>\n` +
    `➜ Users : ${totalUser} Pengguna\n` +
    `➜ Transaksi : ${trxCount} Transaksi\n` +
    `────────────────\n` +
    `〢Produk : ${produk.nama}\n` +
    `〢Kode : <code>${produk.id}</code>\n` +
    `〢Sisa Stok : ${stok} ${stok > 0 ? "🟢" : "🔴"}\n` +
    `〢Stok Terjual : ${produk.terjual || 0}\n` +
    `〢Total Stok : ${stok + (produk.terjual || 0)}\n` +
    `〢Desk : ${produk.deskripsi || "-"}\n\n` +
    `────────────────\n` +
    `➜ Jumlah : <b>${jumlah}</b>\n` +
    `➜ Harga : ${formatRp(produk.harga)}\n` +
    `➜ Total Harga : <b>${formatRp(total)}</b>\n\n` +
    `📆 ${now}`
  );
}

// ── Kirim list produk dengan foto ─────────────────────────────────────────────

async function sendListProdukFull(bot, chatId, userId, page = 1) {
  const produkList = await getProdukList(bot.id);

  if (!produkList.length) {
    return bot.sendMessage(chatId, "❌ Belum ada produk tersedia.", {
      reply_markup: buildMainKeyboard([]),
    });
  }

  const { text, totalPage } = await buildListProduk(bot.id, produkList, page);

  const navButtons = [];
  if (totalPage > 1) {
    if (page > 1) navButtons.push({ text: "◀️ Prev", callback_data: `ok_page:${page - 1}` });
    if (page < totalPage) navButtons.push({ text: "Next ▶️", callback_data: `ok_page:${page + 1}` });
  }

  const inlineKb = {
    inline_keyboard: [
      [{ text: "🔥 PRODUK POPULER", callback_data: "ok_populer" }],
      ...(navButtons.length ? [navButtons] : []),
    ],
  };

  // Kirim foto logo (per-bot, dari Supabase — lihat lib/media.js) + caption list produk
  // parse_mode: "HTML" diperlukan agar tag <tg-emoji> custom emoji Telegram Premium dirender
  try {
    await bot.sendPhoto(chatId, getBotLogo(bot), {
      caption: text,
      parse_mode: "HTML",
      reply_markup: inlineKb,
    });
  } catch (_) {
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: inlineKb });
  }

  // Kirim reply keyboard + simpan message_id-nya
  if (userId) {
    const kbMsg = await bot.sendMessage(chatId, ".", { reply_markup: buildMainKeyboard(produkList) }).catch(() => null);
    if (kbMsg) saveKeyboardMsgId(userId, kbMsg.message_id);
  } else {
    // Fallback kalau tidak ada userId (misal dari /stok command)
    await bot.sendMessage(chatId, ".", { reply_markup: buildMainKeyboard(produkList) }).catch(() => {});
  }
}

// ── Kirim detail produk ────────────────────────────────────────────────────────

async function sendDetailProduk(bot, chatId, userId, produk, jumlah = 1, fromUser = null) {
  const text = await buildDetailProduk(bot, bot.id, produk, jumlah, fromUser);
  const prev = userState.get(userId) || {};
  userState.set(userId, { ...prev, detailProdukId: produk.id, jumlahDetail: jumlah });

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: detailProdukKeyboard(produk.id),
  });
}

// ── Owner notification ────────────────────────────────────────────────────────

async function notifOwner(bot, {
  produk,
  jumlah,
  totalAmount,
  buyer,
  orderId,
  status
}) {
  // ── Ambil owner_id dari DB ─────────────────────────────────────────────────
  let ownerIds = [];
  try {
    const { data: botRow } = await supabase
      .from("telegram_bot_rentals")
      .select("owner_id")
      .eq("id", bot.id)
      .single();
    if (botRow?.owner_id) {
      ownerIds = [String(botRow.owner_id)];
    }
  } catch (_) {}

  // Fallback ke OWNER_ID .env kalau DB kosong
  if (!ownerIds.length && OWNER_ID) {
    ownerIds = String(OWNER_ID).split(",").map(s => s.trim()).filter(Boolean);
  }
  if (!ownerIds.length) return;

  const icon =
    status === "completed" ? "✅" :
    status === "cancelled" ? "❌" : "⏳";

  const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const buyerTag = buyer.username ? `@${buyer.username}` : `ID: ${buyer.userId}`;

  const notifText =
    `🧾 *STRUK PEMBELIAN PRODUK*\n` +
    `━━━━━━━━━━━\n` +
    `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${buyer.userId}\`\n` +
    `𝗨𝗦𝗘𝗥 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : ${buyerTag}\n` +
    `𝗣𝗥𝗢𝗗𝗨𝗞 : ${produk.nama}\n` +
    `𝗝𝗨𝗠𝗟𝗔𝗛 : ${jumlah}\n` +
    `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : QRIS\n` +
    `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${tgl}\n` +
    `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRp(totalAmount)}\n\n` +
    `━━━━━━━━━━━\n` +
    `𝗦𝗧𝗔𝗧𝗨𝗦 : ${icon}\n` +
    `𝗜𝗗 𝗢𝗥𝗗𝗘𝗥 : \`${orderId}\`\n` +
    `━━━━━━━━━━━`;

  const replyMarkup = buyer.username
    ? { inline_keyboard: [[{ text: "👤 Cek Pembeli", url: `https://t.me/${buyer.username}` }]] }
    : {};

  for (const ownerId of ownerIds) {
    try {
      await bot.sendMessage(ownerId, notifText, {
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
    } catch (_) {}
  }
}

// ── Kirim detail stok ke pembeli ──────────────────────────────────────────────

async function kirimDetailProduk(bot, chatId, produk, items, jumlah, orderId) {
  const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

  const os   = require("os");
  const path = require("path");
  const fs   = require("fs");

  let txtContent =
    `╔══════════════════════════════════╗\n` +
    `          ✅ PESANAN BERHASIL       \n` +
    `╚══════════════════════════════════╝\n\n` +
    `Produk   : ${produk.nama}\n` +
    `Jumlah   : ${jumlah}\n` +
    `Order ID : ${orderId}\n` +
    `Tanggal  : ${tgl}\n` +
    `${"─".repeat(36)}\n`;

  items.forEach((item, i) => {
    txtContent +=
      `\n[ Akun ${i + 1} dari ${jumlah} ]\n` +
      `Email    : ${item.email || "N/A"}\n` +
      `Password : ${item.password || "N/A"}\n` +
      (item.profil ? `Profil   : ${item.profil}\n` : "") +
      (item.pin    ? `PIN      : ${item.pin}\n`    : "") +
      `2FA      : ${item.a2f || "N/A"}\n`;
  });

  txtContent +=
    `\n${"─".repeat(36)}\n` +
    `  ⚠ Simpan file ini baik-baik!\n` +
    `  ⚠ Jangan bagikan ke siapapun.\n` +
    `${"─".repeat(36)}\n` +
    `         © OrderKuota Bot\n`;

  const tmpFile = path.join(os.tmpdir(), `pesanan_${orderId}.txt`);
  try {
    fs.writeFileSync(tmpFile, txtContent, "utf8");
    await bot.sendDocument(chatId, tmpFile, {
      caption:
        `✅ Pembayaran berhasil!\n\n` +
        `📦 ${produk.nama} x ${jumlah}\n` +
        `🧾 Order ID: ${orderId}\n\n` +
        `📄 Detail akun ada di file di atas\n` +
        `Simpan baik-baik, jangan dibagikan.`,
    });
  } catch (e) {
    console.warn("[kirimDetailProduk] gagal kirim file:", e.message);
    await bot.sendMessage(chatId, txtContent);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }

  // ── Kirim Syarat & Ketentuan sebagai pesan TERPISAH ───────────────────────
  // Teksnya diatur owner lewat dashboard web (Katalog Produk → Syarat & Ketentuan),
  // kesimpen di kolom ok_produk.syarat_ketentuan. Kalau kosong, gak kirim apa-apa.
  const syarat = produk.syarat_ketentuan && String(produk.syarat_ketentuan).trim();
  if (syarat) {
    try {
      await bot.sendMessage(chatId, syarat);
    } catch (e) {
      console.warn("[kirimDetailProduk] gagal kirim syarat & ketentuan:", e.message);
    }
  }
}

// ── /addproduk ────────────────────────────────────────────────────────────────

async function handleAddProduk(bot, msg) {
  const userId = String(msg.from.id);
  if (userId !== String(OWNER_ID).split(",")[0].trim()) {
    return bot.sendMessage(msg.chat.id, "⛔ Hanya owner yang bisa menambah produk.");
  }
  const args = msg.text.replace("/addproduk", "").trim();
  const [id, nama, hargaStr, ...deskArr] = args.split("|").map(s => s.trim());
  const harga = parseInt(hargaStr);
  const deskripsi = deskArr.join("|") || "-";
  if (!id || !nama || isNaN(harga)) {
    return bot.sendMessage(msg.chat.id,
      `❌ Format salah!\n\`/addproduk <id>|<nama>|<harga>|<deskripsi>\``,
      { parse_mode: "Markdown" }
    );
  }
  try {
    await addProduk(bot.id, { id, nama, harga, deskripsi });
    bot.sendMessage(msg.chat.id,
      `✅ Produk ditambahkan!\n🔑 ID: \`${id}\`\n📦 Nama: ${nama}\n💰 Harga: ${formatRp(harga)}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${e.message}`);
  }
}

// ── /addstock ─────────────────────────────────────────────────────────────────

async function handleAddStock(bot, msg) {
  const userId = String(msg.from.id);
  if (userId !== String(OWNER_ID).split(",")[0].trim()) {
    return bot.sendMessage(msg.chat.id, "⛔ Hanya owner yang bisa menambah stok.");
  }
  const args = msg.text.replace("/addstock", "").trim();
  const [idProduk, credentials] = args.split("|").map(s => s.trim());
  if (!idProduk || !credentials) {
    return bot.sendMessage(msg.chat.id,
      `❌ Format salah!\n\`/addstock <kode>|<email>:<password>:<profil>:<pin>:<a2f>\``,
      { parse_mode: "Markdown" }
    );
  }
  const [email, password, profil, pin, a2f] = credentials.split(":").map(s => s.trim());
  if (!email || !password || !a2f) {
    return bot.sendMessage(msg.chat.id, `❌ Field wajib: email, password, a2f!`);
  }
  const produk = await getProdukById(bot.id, idProduk);
  if (!produk) {
    return bot.sendMessage(msg.chat.id, `❌ Kode produk \`${idProduk}\` tidak ditemukan.`, { parse_mode: "Markdown" });
  }
  try {
    await addStok(bot.id, idProduk, { email, password, profil, pin: pin || null, a2f });
    const jumlahStok = await getStokCount(bot.id, idProduk);

    // ── Konfirmasi ke owner ───────────────────────────────────────────────────
    // Catatan: broadcast restock ke semua user & channel SUDAH ditangani otomatis
    // oleh lib/restock_listener.js (dengar INSERT di tabel ok_stok, di-scope per
    // bot_id). Sengaja gak di-blast manual di sini lagi supaya user gak kirim
    // notifikasi restock dobel setiap kali /addstock dipakai.
    bot.sendMessage(msg.chat.id,
      `✅ Stok ditambahkan ke *${produk.nama}*\n📧 ${email}\n📊 Total stok: *${jumlahStok}*`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${e.message}`);
  }
}


// ── POLLING ENGINE ────────────────────────────────────────────────────────────

function startPolling(bot, orderId, chatId, userId, qrisMsgId) {
  if (activePolls.has(orderId)) return;
  const startTime = Date.now();
  console.log(`[POLL orderkuota] Started: ${orderId}`);

  const intervalId = setInterval(async () => {
    // Guard utama: cegah 2 tick jalan barengan untuk orderId yang sama
    if (processingOrders.has(orderId)) return;

    const order = pendingOrders.get(orderId);
    if (!order) {
      clearInterval(intervalId);
      activePolls.delete(orderId);
      return;
    }

    const elapsed = Date.now() - startTime;

    // Timeout → expired
    if (elapsed > POLL_TIMEOUT_MS) {
      if (processingOrders.has(orderId)) return;
      processingOrders.add(orderId);
      clearInterval(intervalId);
      activePolls.delete(orderId);
      pendingOrders.delete(orderId);

      await updateOrderKuotaStatus(orderId, "expired");
      await updateTransactionStatus(orderId, "expired");

      // Hapus QRIS + keyboard
      try { await bot.deleteMessage(chatId, qrisMsgId); } catch (_) {}
      await deleteKeyboardMsg(bot, chatId, userId);

      bot.sendMessage(chatId, `⏰ *Order kedaluwarsa.*\nSilakan buat order baru.`, { parse_mode: "Markdown" });
      processingOrders.delete(orderId);
      return;
    }

    try {
      const result = await checkPayment(order.provider, {
        providerTrxId: order.providerTrxId,
        amount: order.amount,
        totalPayment: order.totalPayment,
      });

      const status = result?.status;

      if (!status || status === "pending") return;

      // Lock sebelum semua await — ini yang cegah tick dobel masuk
      if (processingOrders.has(orderId)) return;
      processingOrders.add(orderId);

      // Terminal
      clearInterval(intervalId);
      activePolls.delete(orderId);
      pendingOrders.delete(orderId);

      if (status === "completed") {
        await updateOrderKuotaStatus(orderId, "completed");
        await updateTransactionStatus(orderId, "completed");
        await incrementTerjual(bot.id, order.produk.id, order.jumlah);

        // Order sukses → catet ke saldo BOT ini sendiri (bukan saldo akun
        // login owner di dashboard). Yang masuk cuma harga ASLI produk
        // (order.amount = produk.harga × jumlah), TANPA fee QRIS, karena fee
        // itu jatah payment gateway bukan pendapatan bot. Transaksinya sendiri
        // udah otomatis kesimpen di ok_orders (lewat saveOrderKuota di atas +
        // updateOrderKuotaStatus barusan), dan itu yang ditampilin sebagai
        // riwayat trx di halaman detail bot pada dashboard.
        try {
          await addBotSaldo(bot.id, order.amount);
        } catch (err) {
          console.error(`[ORDERKUOTA] Gagal nambah saldo bot ${bot.id}:`, err.message);
        }

        const items = [];
        for (let i = 0; i < order.jumlah; i++) {
          const item = await popStok(bot.id, order.produk.id);
          if (item) items.push(item);
        }

        // Hapus QRIS + keyboard
        try { await bot.deleteMessage(chatId, qrisMsgId); } catch (_) {}
        await deleteKeyboardMsg(bot, chatId, userId);

        await kirimDetailProduk(bot, chatId, order.produk, items, order.jumlah, orderId);

        const buyer = {
          userId: order.userId,
          name: order.buyerName,
          username: order.buyerUsername,
        };
        await notifOwner(bot, { produk: order.produk, jumlah: order.jumlah, totalAmount: order.totalPayment, buyer, orderId, status: "completed" });
        processingOrders.delete(orderId);

      } else {
        await updateOrderKuotaStatus(orderId, status);
        await updateTransactionStatus(orderId, status);

        // Hapus QRIS + keyboard
        try { await bot.deleteMessage(chatId, qrisMsgId); } catch (_) {}
        await deleteKeyboardMsg(bot, chatId, userId);

        bot.sendMessage(chatId, `❌ Pembayaran *${status}*.\nSilakan buat order baru.`, { parse_mode: "Markdown" });
        processingOrders.delete(orderId);
      }

    } catch (err) {
      processingOrders.delete(orderId); // pastikan lock dibersihkan juga kalau ada error
      console.warn(`[POLL orderkuota] ${orderId}:`, err?.response?.data || err.message);
    }

  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
}

// ── Core buy flow ─────────────────────────────────────────────────────────────

async function startBuyFlow(bot, chatId, userId, fromUser, produk, jumlah) {
  const stok = await getStokCount(bot.id, produk.id);
  if (stok <= 0) {
    return bot.sendMessage(chatId, `❌ Stok *${produk.nama}* habis.`, { parse_mode: "Markdown" });
  }
  if (jumlah > stok) {
    return bot.sendMessage(chatId, `❌ Stok hanya *${stok}*, kamu minta *${jumlah}*.`, { parse_mode: "Markdown" });
  }

  const amount   = produk.harga * jumlah;
  const orderId  = genOrderId(userId);
  const provider = bot.paymentProvider || "pakasir";

  const waitMsg = await bot.sendMessage(chatId, "⏳ Membuat transaksi QRIS...");

  let payment;
  try {
    payment = await createPayment(provider, { orderId, amount });
    console.log(`[ORDERKUOTA] createPayment (${provider}) OK:`, JSON.stringify(payment.raw));
  } catch (e) {
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    console.error(`[ORDERKUOTA] createPayment (${provider}) FAIL:`, e?.response?.data || e.message);
    return bot.sendMessage(chatId, `❌ Gagal membuat QRIS (${PROVIDER_LABELS[provider] || provider}): ${e?.response?.data?.message || e.message}`);
  }

  await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});

  const feeActual  = payment.fee || 0;
  const totalFinal = payment.totalPayment ?? (amount + feeActual);
  const expiredAt  = payment.expiredAt;

  const expStr = expiredAt
    ? new Date(expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    : "10 menit";

  if (!payment.qrisString && !payment.qrImageUrl) {
    console.error(`[ORDERKUOTA] Gak ada QR sama sekali:`, JSON.stringify(payment.raw));
    return bot.sendMessage(chatId, `❌ Gagal mendapat QRIS.\nResponse: \`${JSON.stringify(payment.raw).slice(0, 200)}\``, { parse_mode: "Markdown" });
  }

  await saveOrderKuota({
    botId: bot.id,
    orderId, userId, chatId,
    produkId: produk.id, produkNama: produk.nama,
    jumlah, harga: produk.harga, fee: feeActual, totalAmount: totalFinal,
    status: "pending_payment",
    paymentProvider: provider,
    providerTrxId: payment.providerTrxId,
    buyerName: [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(" ") || null,
    buyerUsername: fromUser?.username || null,
  });
  await saveTransaction({
    orderId, userId, chatId,
    type: "Produk Auto Order", status: "pending",
    amount, fee: feeActual, totalPayment: totalFinal,
    paymentMethod: provider,
    productId: produk.id, productName: produk.nama,
    metadata: { jumlah, provider_trx_id: payment.providerTrxId }, expiredAt,
  });

  pendingOrders.set(orderId, {
    userId, chatId, produk, jumlah,
    amount,
    fee: feeActual,
    totalPayment: totalFinal,
    provider,
    providerTrxId: payment.providerTrxId,
    expiredAt,
    buyerName: [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(" ") || userId,
    buyerUsername: fromUser?.username,
  });

  const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const caption =
    `🧾 *QRIS PEMBAYARAN PRODUK*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⌯⌲ ID Transaksi : \`${orderId}\`\n` +
    `⌯⌲ Metode : ${PROVIDER_LABELS[provider] || provider}\n` +
    `⌯⌲ Produk : ${escMd(produk.nama)}\n` +
    `⌯⌲ Harga Produk : ${formatRp(produk.harga)} × ${jumlah}\n` +
    `⌯⌲ Fee Admin : ${formatRp(feeActual)}\n` +
    `⌯⌲ Total Harga : *${formatRp(totalFinal)}*\n` +
    `━━━━━━━━━━━\n` +
    `⌯⌲ ID Telegram : \`${userId}\`\n` +
    `⌯⌲ Username Telegram : ${fromUser?.username ? `@${fromUser.username}` : "-"}\n` +
    `⌯⌲ Tanggal : ${tanggalStr}\n` +
    `⌯⌲ Expired : ${expStr}`;

  let qrisMsg;
  try {
    if (payment.qrisString) {
      // Pakasir dkk: dapet raw payload QRIS, kita render sendiri jadi gambar.
      const qrBuf = await makeQrBuffer(payment.qrisString);
      qrisMsg = await bot.sendPhoto(chatId, qrBuf, {
        caption,
        parse_mode: "Markdown",
        reply_markup: qrisCancelKeyboard(orderId),
      });
    } else {
      // GoPay Merchant dkk: providernya kasih link gambar QR siap pakai —
      // dibungkus dulu jadi kartu QRIS bergaya "GoPay Merchant" (rapi, ada
      // frame, badge QRIS) sebelum dikirim. QR asli TIDAK diubah pixel-nya,
      // cuma di-embed di dalam kartu, jadi tetap valid buat discan.
      try {
        const { buffer: cardBuf } = await generateQrisCard({
          qrisRawPayload: payment.qrisRawPayload || null,
          qrImageUrl: payment.qrImageUrl,
          merchantName: "GoPay Merchant",
          orderId,
        });
        qrisMsg = await bot.sendPhoto(chatId, cardBuf, {
          caption,
          parse_mode: "Markdown",
          reply_markup: qrisCancelKeyboard(orderId),
        });
      } catch (cardErr) {
        console.error(`[ORDERKUOTA] generateQrisCard gagal, fallback ke qrImageUrl asli:`, cardErr.message);
        qrisMsg = await bot.sendPhoto(chatId, payment.qrImageUrl, {
          caption,
          parse_mode: "Markdown",
          reply_markup: qrisCancelKeyboard(orderId),
        });
      }
    }
  } catch (e) {
    const fallbackBody = payment.qrisString ? `\n\n\`\`\`\n${payment.qrisString}\n\`\`\`` : `\n\n${payment.qrImageUrl}`;
    qrisMsg = await bot.sendMessage(chatId,
      caption + fallbackBody,
      { parse_mode: "Markdown", reply_markup: qrisCancelKeyboard(orderId) }
    );
  }

  // Mulai polling — sekarang juga pass userId untuk deleteKeyboardMsg
  startPolling(bot, orderId, chatId, userId, qrisMsg.message_id);
}

// ── Handle cancel ─────────────────────────────────────────────────────────────

async function handleCancel(bot, chatId, userId, orderId) {
  if (orderId && activePolls.has(orderId)) {
    clearInterval(activePolls.get(orderId));
    activePolls.delete(orderId);
  }

  let order = orderId ? pendingOrders.get(orderId) : null;
  if (orderId) pendingOrders.delete(orderId);

  // Fallback ke DB kalau order tidak ada di memory (misal bot restart)
  if (orderId && !order) {
    try {
      const dbOrder = await getOrderKuotaByOrderId(orderId);
      if (dbOrder) {
        order = {
          amount:        dbOrder.harga,                        // amount asli (sebelum fee) untuk API cancel
          totalPayment:  dbOrder.total_amount ?? dbOrder.harga,
          produk:        { nama: dbOrder.produk_nama },
          jumlah:        dbOrder.jumlah,
          provider:      dbOrder.payment_provider || "pakasir",
          providerTrxId: dbOrder.provider_trx_id || orderId,
          buyerName:     null,
          buyerUsername: null,
        };
      }
    } catch (_) {}
  }

  if (orderId) {
    try {
      await cancelPayment(order?.provider || "pakasir", {
        providerTrxId: order?.providerTrxId || orderId,
        amount: order?.amount ?? order?.totalPayment,
      });
    } catch (_) {}
    await updateOrderKuotaStatus(orderId, "cancelled").catch(() => {});
    await updateTransactionStatus(orderId, "cancelled").catch(() => {});

    if (order) {
      const buyer = { userId, name: order.buyerName, username: order.buyerUsername };
      await notifOwner(bot, { produk: order.produk, jumlah: order.jumlah, totalAmount: order.totalPayment, buyer, orderId, status: "cancelled" });
    }
  }

  // Hapus keyboard saat cancel
  await deleteKeyboardMsg(bot, chatId, userId);

  const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const cancelCaption =
    `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
    `<em>⌯⌲ Order ID : ${orderId || "-"}</em>\n` +
    `<em>⌯⌲  Tanggal : ${tglCancel}</em></blockquote>`;

  const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });

  // Auto delete pesan cancel setelah 5 detik
  setTimeout(async () => {
    try { await bot.deleteMessage(chatId, cancelMsg.message_id); } catch (_) {}
  }, 5000);
}

// ── Module export ─────────────────────────────────────────────────────────────

// Set untuk track bot instance yang sudah di-register — cegah dobel register
// handler kalau loadCommands dipanggil >1x untuk bot yang sama (Node.js
// meng-cache module require, tapi command(bot) bisa dipanggil ulang).
const registeredBots = new Set();

module.exports = function (bot) {
  // Guard: kalau bot ini sudah di-register sebelumnya, skip semua handler
  const botKey = bot.id || bot.token;
  if (registeredBots.has(botKey)) {
    console.warn(`[orderkuota] bot ${botKey} sudah di-register, skip.`);
    return;
  }
  registeredBots.add(botKey);

  // Commands — tetap ada tapi tanpa userId (fallback)
  bot.onText(/^\/stok$/i,       async (msg) => {
    if (await blockIfDisabled(bot, "katalog_produk", msg.chat.id)) return;
    sendListProdukFull(bot, msg.chat.id, String(msg.from.id));
  });
  bot.onText(/^\/produk$/i,     async (msg) => {
    if (await blockIfDisabled(bot, "katalog_produk", msg.chat.id)) return;
    sendListProdukFull(bot, msg.chat.id, String(msg.from.id));
  });
  bot.onText(/^\/addstock\b/i,  (msg) => handleAddStock(bot, msg));
  bot.onText(/^\/addproduk\b/i, (msg) => handleAddProduk(bot, msg));

  // Reply keyboard handler
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text   = msg.text || "";
    const state  = userState.get(userId) || {};

    // Input jumlah manual (setelah Edit)
    if (state.waitingQty && /^\d+$/.test(text)) {
      const produkId = state.waitingQty;
      const jumlah   = parseInt(text);
      const produk   = await getProdukById(bot.id, produkId);
      if (!produk) return bot.sendMessage(chatId, "❌ Produk tidak ditemukan.");
      const stok = await getStokCount(bot.id, produkId);
      if (jumlah < 1 || jumlah > stok) {
        return bot.sendMessage(chatId, `❌ Jumlah harus 1–${stok}.`);
      }
      userState.set(userId, { ...state, waitingQty: null, jumlahDetail: jumlah });
      return sendDetailProduk(bot, chatId, userId, produk, jumlah, msg.from);
    }

    // "🏷️ List Produk" sekarang jadi callback — tapi tetap handle text-nya
    // jaga-jaga kalau ada user lama yang masih kirim teks biasa
    if (text === "🏷️ List Produk") return sendListProdukFull(bot, chatId, userId);

    // Angka → pilih produk
    const numMatch = text.match(/^(\d+)$/);
    if (numMatch) {
      const idx        = parseInt(numMatch[1]) - 1;
      const produkList = await getProdukList(bot.id);
      if (idx < 0 || idx >= produkList.length) {
        return bot.sendMessage(chatId, `❌ Produk ke-${numMatch[1]} tidak ditemukan.`);
      }
      const produk = produkList[idx];
      return sendDetailProduk(bot, chatId, userId, produk, 1, msg.from);
    }

    if (text === "📦 Laporan Stok") {
      const produkList = await getProdukList(bot.id);
      if (!produkList.length) return bot.sendMessage(chatId, "❌ Belum ada produk.");
      let laporan = `📦 *LAPORAN STOK*\n${"─".repeat(28)}\n`;
      for (const p of produkList) {
        const stok = await getStokCount(bot.id, p.id);
        laporan += `• ${p.nama}: *${stok}* tersisa\n`;
      }
      return bot.sendMessage(chatId, laporan, { parse_mode: "Markdown" });
    }

    if (text === "💰 Deposit") return bot.sendMessage(chatId, "💰 Gunakan /deposit untuk mengisi saldo.");
    if (text === "🎟️ Voucher") return bot.sendMessage(chatId, "🎟️ Fitur voucher segera hadir!");
    if (text === "❓ Cara Order") {
      const produkList = await getProdukList(bot.id);
      const count = produkList.length || 1;
      return bot.sendMessage(chatId,
        `❓ *CARA ORDER*\n${"─".repeat(28)}\n\n` +
        `1️⃣ Tekan *List Produk* atau ketik /stok\n` +
        `2️⃣ Tekan angka (1–${count}) untuk pilih produk\n` +
        `3️⃣ Tekan ➕/➖ untuk atur jumlah\n` +
        `4️⃣ Tekan *🛒 Buy (Now)* untuk beli via QRIS\n` +
        `5️⃣ Scan QR & produk dikirim otomatis ✅`,
        { parse_mode: "Markdown" }
      );
    }
    if (text === "⚠️ Information") {
      return bot.sendMessage(chatId,
        `⚠️ *INFORMASI*\n\nBot auto-order 24 jam.\nTransaksi diproses otomatis.\nHubungi admin jika ada masalah.`,
        { parse_mode: "Markdown" }
      );
    }
  });

  // Callback query
  bot.on("callback_query", async (query) => {
    const data   = query.data || "";
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    const msgId  = query.message.message_id;

    // ── Handle "🏷️ List Produk" button → callback "ok_listproduk" ──────────
    if (data === "ok_listproduk") {
      if (await blockCallbackIfDisabled(bot, "katalog_produk", query)) return;
      await bot.answerCallbackQuery(query.id).catch(() => {});
      // Hapus pesan yang ada tombolnya sebelum kirim list
      try { await bot.deleteMessage(chatId, msgId); } catch (_) {}
      return sendListProdukFull(bot, chatId, userId);
    }

    if (!data.startsWith("ok_")) return;

    if (await blockCallbackIfDisabled(bot, "katalog_produk", query)) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // Navigasi halaman
    if (data.startsWith("ok_page:")) {
      const page       = parseInt(data.split(":")[1]);
      const produkList = await getProdukList(bot.id);
      const { text, totalPage } = await buildListProduk(bot.id, produkList, page);
      const navButtons = [];
      if (page > 1) navButtons.push({ text: "◀️ Prev", callback_data: `ok_page:${page - 1}` });
      if (page < totalPage) navButtons.push({ text: "Next ▶️", callback_data: `ok_page:${page + 1}` });
      return bot.editMessageCaption(text, {
        chat_id: chatId, message_id: msgId,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 PRODUK POPULER", callback_data: "ok_populer" }],
            ...(navButtons.length ? [navButtons] : []),
          ],
        },
      }).catch(() => {});
    }

    // Produk populer
    if (data === "ok_populer") {
      const produkList = await getProdukList(bot.id);
      const sorted     = [...produkList].sort((a, b) => (b.terjual || 0) - (a.terjual || 0));
      if (!sorted.length) return bot.sendMessage(chatId, "❌ Belum ada produk.");
      return sendDetailProduk(bot, chatId, userId, sorted[0], 1, query.from);
    }

    // ➕
    if (data.startsWith("ok_plus:")) {
      const produkId = data.split(":")[1];
      const produk   = await getProdukById(bot.id, produkId);
      if (!produk) return;
      const stok   = await getStokCount(bot.id, produkId);
      const prev   = userState.get(userId) || {};
      const jumlah = Math.min((prev.jumlahDetail || 1) + 1, stok || 1);
      userState.set(userId, { ...prev, jumlahDetail: jumlah, detailProdukId: produkId });
      const newText = await buildDetailProduk(bot, bot.id, produk, jumlah, query.from);
      return bot.editMessageText(newText, {
        chat_id: chatId, message_id: msgId,
        parse_mode: "HTML",
        reply_markup: detailProdukKeyboard(produkId),
      }).catch((e) => {
        if (!e.message?.includes("message is not modified")) console.warn("[ok_plus]", e.message);
      });
    }

    // ➖
    if (data.startsWith("ok_minus:")) {
      const produkId = data.split(":")[1];
      const produk   = await getProdukById(bot.id, produkId);
      if (!produk) return;
      const prev   = userState.get(userId) || {};
      const jumlah = Math.max((prev.jumlahDetail || 1) - 1, 1);
      userState.set(userId, { ...prev, jumlahDetail: jumlah, detailProdukId: produkId });
      const newText = await buildDetailProduk(bot, bot.id, produk, jumlah, query.from);
      return bot.editMessageText(newText, {
        chat_id: chatId, message_id: msgId,
        parse_mode: "HTML",
        reply_markup: detailProdukKeyboard(produkId),
      }).catch((e) => {
        if (!e.message?.includes("message is not modified")) console.warn("[ok_minus]", e.message);
      });
    }

    // 🔄 Refresh
    if (data.startsWith("ok_refresh:")) {
      const produkId = data.split(":")[1];
      const [produk, stokFresh] = await Promise.all([
        getProdukById(bot.id, produkId),
        getStokCount(bot.id, produkId),
      ]);
      if (!produk) return;
      const prev    = userState.get(userId) || {};
      const jumlah  = prev.jumlahDetail || 1;
      const produkFresh = { ...produk, _stokOverride: stokFresh };
      const newText = await buildDetailProduk(bot, bot.id, produkFresh, jumlah, query.from);
      return bot.editMessageText(newText, {
        chat_id: chatId, message_id: msgId,
        parse_mode: "HTML",
        reply_markup: detailProdukKeyboard(produkId),
      }).catch((e) => {
        if (e.message?.includes("message is not modified")) {
          return bot.answerCallbackQuery(query.id, { text: "✅ Stok sudah up-to-date!", show_alert: false }).catch(() => {});
        }
        console.warn("[ok_refresh]", e.message);
      });
    }

    // 📝 Edit
    if (data.startsWith("ok_edit:")) {
      const produkId = data.split(":")[1];
      const prev     = userState.get(userId) || {};
      userState.set(userId, { ...prev, waitingQty: produkId });
      return bot.sendMessage(chatId, "📝 Masukkan jumlah yang ingin dibeli (angka):");
    }

    // 🛒 Buy Now
    if (data.startsWith("ok_buynow:")) {
      const produkId = data.split(":")[1];
      const produk   = await getProdukById(bot.id, produkId);
      if (!produk) return bot.sendMessage(chatId, "❌ Produk tidak ditemukan.");
      const prev   = userState.get(userId) || {};
      const jumlah = prev.jumlahDetail || 1;
      return startBuyFlow(bot, chatId, userId, query.from, produk, jumlah);
    }

    // ❌ Cancel
    if (data === "ok_cancel" || data.startsWith("ok_cancel:")) {
      const orderId = data.includes(":") ? data.split(":").slice(1).join(":") : null;
      try { await bot.deleteMessage(chatId, msgId); } catch (_) {}
      return handleCancel(bot, chatId, userId, orderId);
    }
  });
};