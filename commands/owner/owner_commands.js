/**
 * owner_commands.js
 * Fitur khusus owner:
 *   /delscript  - Hapus produk script
 *   /delproduk  - Hapus produk katalog
 *   /delstock   - Hapus stok produk
 *   /editstock  - Edit stok produk
 *   /editproduk - Edit data produk
 */

const fs   = require("fs");
const path = require("path");

const { OWNER_ID }  = require("../../config");
const supabase      = require("../../lib/supabase");
const {
  getProdukList,
  getProdukById,
  hapusProduk,
  editProduk,
  getStokList,
}                   = require("../orderkuota/orderkuota_db");

// ─── path scripts.json (sama dengan script.js) ───────────────────────────────
const SCRIPTS_JSON   = path.join(__dirname, "../../scripts/scripts.json");
const SCRIPTS_FOLDER = path.join(__dirname, "../../scripts/media");

const sep = "─".repeat(28);

// ─── helper ──────────────────────────────────────────────────────────────────

function isOwner(userId) {
  const ids = OWNER_ID ? String(OWNER_ID).split(",").map(s => s.trim()) : [];
  return ids.includes(String(userId));
}

function readScriptsJSON() {
  try {
    const data = fs.readFileSync(SCRIPTS_JSON, "utf8");
    return JSON.parse(data).scripts || [];
  } catch {
    return [];
  }
}

function writeScriptsJSON(scripts) {
  fs.writeFileSync(SCRIPTS_JSON, JSON.stringify({ scripts }, null, 2));
}

function fmt(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

// ─── /delscript ───────────────────────────────────────────────────────────────

async function handleDelScript(bot, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk owner.");
  }

  const scripts = readScriptsJSON();

  if (!scripts.length) {
    return bot.sendMessage(chatId, "📭 Belum ada script yang tersimpan.");
  }

  // Tampilkan tombol pilih script yang akan dihapus
  const keyboard = {
    inline_keyboard: scripts.map(s => ([
      {
        text: `🗑 ${s.name} — ${fmt(s.price)}`,
        callback_data: `ow_delscript:${s.code}`
      }
    ])).concat([[{ text: "❌ Batal", callback_data: "ow_cancel" }]])
  };

  await bot.sendMessage(chatId,
    `🗑️ *HAPUS SCRIPT*\n${sep}\n\nPilih script yang ingin dihapus:`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
}

// ─── /delproduk ───────────────────────────────────────────────────────────────

async function handleDelProduk(bot, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk owner.");
  }

  let produkList;
  try {
    produkList = await getProdukList(bot.id);
  } catch (e) {
    return bot.sendMessage(chatId, `❌ Gagal mengambil produk: ${e.message}`);
  }

  if (!produkList.length) {
    return bot.sendMessage(chatId, "📭 Belum ada produk katalog.");
  }

  const keyboard = {
    inline_keyboard: produkList.map(p => ([
      {
        text: `🗑 [${p.id}] ${p.nama} — ${fmt(p.harga)}`,
        callback_data: `ow_delproduk:${p.id}`
      }
    ])).concat([[{ text: "❌ Batal", callback_data: "ow_cancel" }]])
  };

  await bot.sendMessage(chatId,
    `🗑️ *HAPUS PRODUK*\n${sep}\n\nPilih produk yang ingin dihapus:`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
}

// ─── /delstock ────────────────────────────────────────────────────────────────

async function handleDelStock(bot, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk owner.");
  }

  let produkList;
  try {
    produkList = await getProdukList(bot.id);
  } catch (e) {
    return bot.sendMessage(chatId, `❌ Gagal mengambil produk: ${e.message}`);
  }

  if (!produkList.length) {
    return bot.sendMessage(chatId, "📭 Belum ada produk.");
  }

  const keyboard = {
    inline_keyboard: produkList.map(p => ([
      {
        text: `📦 [${p.id}] ${p.nama}`,
        callback_data: `ow_delstock_pick:${p.id}`
      }
    ])).concat([[{ text: "❌ Batal", callback_data: "ow_cancel" }]])
  };

  await bot.sendMessage(chatId,
    `🗑️ *HAPUS STOK*\n${sep}\n\nPilih produk untuk lihat & hapus stoknya:`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
}

// ─── /editstock ───────────────────────────────────────────────────────────────

async function handleEditStock(bot, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk owner.");
  }

  // Format: /editstock <kode_produk>|<id_stok>|field:nilai
  const args = msg.text.replace(/^\/editstock\s*/i, "").trim();

  if (!args) {
    return bot.sendMessage(chatId,
      `📝 *FORMAT /editstock*\n${sep}\n\n` +
      "`/editstock <kode_produk>|<id_stok>|<field>:<nilai>`\n\n" +
      "*Field yang bisa diedit:*\n" +
      "• `email` — email akun\n" +
      "• `password` — password akun\n" +
      "• `profil` — profil\n" +
      "• `pin` — pin\n" +
      "• `a2f` — kode 2FA\n\n" +
      "*Contoh:*\n" +
      "`/editstock netflix|5|password:newpass123`\n\n" +
      "Gunakan `/delstock` untuk melihat ID stok.",
      { parse_mode: "Markdown" }
    );
  }

  const parts = args.split("|").map(s => s.trim());
  if (parts.length < 3) {
    return bot.sendMessage(chatId,
      `❌ Format salah!\n\`/editstock <kode_produk>|<id_stok>|<field>:<nilai>\``,
      { parse_mode: "Markdown" }
    );
  }

  const [kodeProduk, stokIdStr, fieldValue] = parts;
  const stokId = parseInt(stokIdStr);
  if (isNaN(stokId)) {
    return bot.sendMessage(chatId, "❌ ID stok harus berupa angka.");
  }

  const [field, ...valParts] = fieldValue.split(":");
  const nilai = valParts.join(":").trim();

  const allowedFields = ["email", "password", "profil", "pin", "a2f"];
  if (!allowedFields.includes(field.trim())) {
    return bot.sendMessage(chatId,
      `❌ Field tidak valid!\nField yang diizinkan: \`${allowedFields.join(", ")}\``,
      { parse_mode: "Markdown" }
    );
  }

  if (!nilai) {
    return bot.sendMessage(chatId, "❌ Nilai tidak boleh kosong.");
  }

  try {
    const { error } = await supabase
      .from("ok_stok")
      .update({ [field.trim()]: nilai, updated_at: new Date().toISOString() })
      .eq("bot_id", bot.id)
      .eq("id", stokId)
      .eq("produk_id", kodeProduk)
      .eq("is_used", false);

    if (error) throw new Error(error.message);

    await bot.sendMessage(chatId,
      `✅ *Stok berhasil diperbarui!*\n\n` +
      `📦 Produk : \`${kodeProduk}\`\n` +
      `🆔 ID Stok : \`${stokId}\`\n` +
      `📝 Field   : \`${field.trim()}\`\n` +
      `🔄 Nilai   : \`${nilai}\``,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal edit stok: ${e.message}`);
  }
}

// ─── /editproduk ──────────────────────────────────────────────────────────────

async function handleEditProduk(bot, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk owner.");
  }

  // Format: /editproduk <id>|<field>:<nilai>
  // Field: nama, harga, deskripsi
  const args = msg.text.replace(/^\/editproduk\s*/i, "").trim();

  if (!args) {
    return bot.sendMessage(chatId,
      `📝 *FORMAT /editproduk*\n${sep}\n\n` +
      "`/editproduk <id_produk>|<field>:<nilai>`\n\n" +
      "*Field yang bisa diedit:*\n" +
      "• `nama` — nama produk\n" +
      "• `harga` — harga produk (angka)\n" +
      "• `deskripsi` — deskripsi produk\n\n" +
      "*Contoh:*\n" +
      "`/editproduk netflix|harga:85000`\n" +
      "`/editproduk netflix|nama:Netflix Premium`\n" +
      "`/editproduk netflix|deskripsi:Akun sharing 4 screen`\n\n" +
      "Gunakan `/produk` untuk melihat ID produk.",
      { parse_mode: "Markdown" }
    );
  }

  const pipeIdx = args.indexOf("|");
  if (pipeIdx === -1) {
    return bot.sendMessage(chatId,
      `❌ Format salah!\n\`/editproduk <id>|<field>:<nilai>\``,
      { parse_mode: "Markdown" }
    );
  }

  const idProduk   = args.slice(0, pipeIdx).trim();
  const fieldValue = args.slice(pipeIdx + 1).trim();

  const colonIdx = fieldValue.indexOf(":");
  if (colonIdx === -1) {
    return bot.sendMessage(chatId, "❌ Format field salah. Gunakan `field:nilai`.", { parse_mode: "Markdown" });
  }

  const field = fieldValue.slice(0, colonIdx).trim();
  const nilai = fieldValue.slice(colonIdx + 1).trim();

  const allowedFields = ["nama", "harga", "deskripsi"];
  if (!allowedFields.includes(field)) {
    return bot.sendMessage(chatId,
      `❌ Field tidak valid!\nField yang diizinkan: \`${allowedFields.join(", ")}\``,
      { parse_mode: "Markdown" }
    );
  }

  if (!nilai) {
    return bot.sendMessage(chatId, "❌ Nilai tidak boleh kosong.");
  }

  // Validasi harga
  let updateVal = nilai;
  if (field === "harga") {
    updateVal = parseInt(nilai);
    if (isNaN(updateVal) || updateVal <= 0) {
      return bot.sendMessage(chatId, "❌ Harga harus berupa angka positif.");
    }
  }

  // Cek produk ada
  const produk = await getProdukById(bot.id, idProduk);
  if (!produk) {
    return bot.sendMessage(chatId,
      `❌ Produk \`${idProduk}\` tidak ditemukan.`,
      { parse_mode: "Markdown" }
    );
  }

  try {
    await editProduk(bot.id, idProduk, { [field]: updateVal });

    await bot.sendMessage(chatId,
      `✅ *Produk berhasil diperbarui!*\n\n` +
      `🔑 ID       : \`${idProduk}\`\n` +
      `📦 Produk   : ${produk.nama}\n` +
      `📝 Field    : \`${field}\`\n` +
      `🔄 Nilai    : \`${updateVal}\``,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal edit produk: ${e.message}`);
  }
}

// ─── CALLBACK HANDLER (untuk inline buttons) ─────────────────────────────────

// State untuk multi-step delete stock
const delStockState = new Map(); // userId -> { produkId, msgId }

// ─── MODULE EXPORT ────────────────────────────────────────────────────────────

module.exports = function (bot) {

  // ── Commands ────────────────────────────────────────────────────────────────
  bot.onText(/^\/delscript\b/i,  (msg) => handleDelScript(bot, msg));
  bot.onText(/^\/delproduk\b/i,  (msg) => handleDelProduk(bot, msg));
  bot.onText(/^\/delstock\b/i,   (msg) => handleDelStock(bot, msg));
  bot.onText(/^\/editstock\b/i,  (msg) => handleEditStock(bot, msg));
  bot.onText(/^\/editproduk\b/i, (msg) => handleEditProduk(bot, msg));

  // ── Callback Query ──────────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const userId = String(query.from.id);
    const data   = query.data;

    if (!data.startsWith("ow_")) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (!isOwner(userId)) {
      return bot.answerCallbackQuery(query.id, { text: "⛔ Bukan owner.", show_alert: true });
    }

    // ── Batal ─────────────────────────────────────────────────────────────────
    if (data === "ow_cancel") {
      return bot.editMessageText("❌ Dibatalkan.", {
        chat_id: chatId, message_id: msgId
      }).catch(() => {});
    }

    // ─────────────────────────── DELSCRIPT ────────────────────────────────────

    // Konfirmasi hapus script
    if (data.startsWith("ow_delscript:")) {
      const code    = data.slice("ow_delscript:".length);
      const scripts = readScriptsJSON();
      const script  = scripts.find(s => s.code === code);

      if (!script) {
        return bot.editMessageText("❌ Script tidak ditemukan.", {
          chat_id: chatId, message_id: msgId
        }).catch(() => {});
      }

      return bot.editMessageText(
        `⚠️ *Konfirmasi Hapus Script*\n${sep}\n\n` +
        `📦 Nama  : ${script.name}\n` +
        `💰 Harga : ${fmt(script.price)}\n\n` +
        `Tindakan ini *tidak dapat dibatalkan!*`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Ya, Hapus!", callback_data: `ow_delscript_ok:${code}` },
                { text: "❌ Batal",       callback_data: "ow_cancel" }
              ]
            ]
          }
        }
      ).catch(() => {});
    }

    // Eksekusi hapus script
    if (data.startsWith("ow_delscript_ok:")) {
      const code    = data.slice("ow_delscript_ok:".length);
      const scripts = readScriptsJSON();
      const idx     = scripts.findIndex(s => s.code === code);

      if (idx === -1) {
        return bot.editMessageText("❌ Script tidak ditemukan.", {
          chat_id: chatId, message_id: msgId
        }).catch(() => {});
      }

      const script = scripts[idx];

      // Hapus file ZIP jika ada
      try {
        if (script.filePath && fs.existsSync(script.filePath)) {
          fs.unlinkSync(script.filePath);
        }
      } catch (_) {}

      // Hapus dari JSON
      scripts.splice(idx, 1);
      writeScriptsJSON(scripts);

      return bot.editMessageText(
        `✅ *Script berhasil dihapus!*\n\n📦 Nama: ${script.name}`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      ).catch(() => {});
    }

    // ─────────────────────────── DELPRODUK ────────────────────────────────────

    // Konfirmasi hapus produk
    if (data.startsWith("ow_delproduk:")) {
      const id     = data.slice("ow_delproduk:".length);
      const produk = await getProdukById(bot.id, id);

      if (!produk) {
        return bot.editMessageText("❌ Produk tidak ditemukan.", {
          chat_id: chatId, message_id: msgId
        }).catch(() => {});
      }

      return bot.editMessageText(
        `⚠️ *Konfirmasi Hapus Produk*\n${sep}\n\n` +
        `🔑 ID    : \`${produk.id}\`\n` +
        `📦 Nama  : ${produk.nama}\n` +
        `💰 Harga : ${fmt(produk.harga)}\n\n` +
        `Tindakan ini *tidak dapat dibatalkan!*`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Ya, Hapus!", callback_data: `ow_delproduk_ok:${id}` },
                { text: "❌ Batal",       callback_data: "ow_cancel" }
              ]
            ]
          }
        }
      ).catch(() => {});
    }

    // Eksekusi hapus produk
    if (data.startsWith("ow_delproduk_ok:")) {
      const id = data.slice("ow_delproduk_ok:".length);

      try {
        await hapusProduk(bot.id, id);
        return bot.editMessageText(
          `✅ *Produk berhasil dihapus!*\n\n🔑 ID: \`${id}\``,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
        ).catch(() => {});
      } catch (e) {
        return bot.editMessageText(`❌ Gagal hapus produk: ${e.message}`, {
          chat_id: chatId, message_id: msgId
        }).catch(() => {});
      }
    }

    // ─────────────────────────── DELSTOCK ─────────────────────────────────────

    // Pilih produk → tampilkan list stok
    if (data.startsWith("ow_delstock_pick:")) {
      const produkId = data.slice("ow_delstock_pick:".length);

      let stokList;
      try {
        stokList = await getStokList(bot.id, produkId);
      } catch (e) {
        return bot.editMessageText(`❌ Gagal ambil stok: ${e.message}`, {
          chat_id: chatId, message_id: msgId
        }).catch(() => {});
      }

      if (!stokList.length) {
        return bot.editMessageText(
          `📭 *Stok Kosong*\n\nProduk \`${produkId}\` tidak punya stok aktif.`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "ow_cancel" }]] }
          }
        ).catch(() => {});
      }

      // Tampilkan max 10 stok pertama dengan tombol hapus
      const rows = stokList.slice(0, 10).map(s => ([{
        text: `🗑 #${s.id} — ${s.email}`,
        callback_data: `ow_delstock_ok:${s.id}:${produkId}`
      }]));
      rows.push([{ text: "❌ Batal", callback_data: "ow_cancel" }]);

      const listText = stokList.slice(0, 10).map((s, i) =>
        `${i + 1}. ID \`${s.id}\` — ${s.email}`
      ).join("\n");

      return bot.editMessageText(
        `🗑️ *Hapus Stok — ${produkId}*\n${sep}\n\n` +
        `${listText}\n\n` +
        `Pilih stok yang ingin dihapus:`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: rows }
        }
      ).catch(() => {});
    }

    // Eksekusi hapus 1 item stok
    if (data.startsWith("ow_delstock_ok:")) {
      const parts    = data.split(":");
      const stokId   = parts[1];
      const produkId = parts[2];

      try {
        const { error } = await supabase
          .from("ok_stok")
          .delete()
          .eq("bot_id", bot.id)
          .eq("id", stokId)
          .eq("produk_id", produkId);

        if (error) throw new Error(error.message);

        return bot.editMessageText(
          `✅ *Stok berhasil dihapus!*\n\n🆔 ID Stok: \`${stokId}\`\n📦 Produk: \`${produkId}\``,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
        ).catch(() => {});
      } catch (e) {
        return bot.editMessageText(`❌ Gagal hapus stok: ${e.message}`, {
          chat_id: chatId, message_id: msgId
        }).catch(() => {});
      }
    }

  }); // end callback_query

};
