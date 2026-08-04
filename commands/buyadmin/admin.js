const fetch = require("node-fetch");
const { OWNER_ID, domain, plta } = require("../../config");
const supabase = require("../../lib/supabase");

// =====================================================================
// HELPER
// =====================================================================

function isOwner(userId) {
  const ids = OWNER_ID ? String(OWNER_ID).split(",").map(s => s.trim()) : [];
  return ids.includes(String(userId));
}

const sep = "─".repeat(28);


// =====================================================================
// PREMIUM USER HELPERS (Supabase)
// =====================================================================

async function getAllPremiumUsers() {
  const { data, error } = await supabase
    .from("premium_users")
    .select("*")
    .order("bought_at", { ascending: false });
  if (error) return [];
  return data || [];
}

async function deletePremiumUser(userId) {
  const { error } = await supabase
    .from("premium_users")
    .delete()
    .eq("user_id", String(userId));
  return !error;
}

// =====================================================================
// PTERODACTYL API HELPERS
// =====================================================================

async function pteroGet(path) {
  const res = await fetch(`${domain}/api/application${path}?per_page=100`, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + plta
    }
  });
  return res.json();
}

async function pteroDelete(path) {
  const res = await fetch(`${domain}/api/application${path}`, {
    method: "DELETE",
    headers: {
      "Accept": "application/json",
      "Authorization": "Bearer " + plta
    }
  });
  return res.status; // 204 = success
}

async function getAllUsers() {
  const data = await pteroGet("/users");
  return data?.data || [];
}

async function getAllServers() {
  const data = await pteroGet("/servers");
  return data?.data || [];
}

async function getUserById(id) {
  const data = await pteroGet(`/users/${id}`);
  return data?.attributes || null;
}

async function getServerById(id) {
  const data = await pteroGet(`/servers/${id}`);
  return data?.attributes || null;
}

async function getServersByUser(userId) {
  const all = await getAllServers();
  return all.filter(s => s.attributes?.user === userId);
}

// =====================================================================
// KEYBOARD BUILDERS
// =====================================================================

function homeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🏠 Home Admin", callback_data: "adm_home" }]
    ]
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📋 List Server", callback_data: "adm_list_servers:1" },
        { text: "👤 List User", callback_data: "adm_list_users:1" }
      ],
      [
        { text: "🔴 List User Admin", callback_data: "adm_list_admins:1" },
        { text: "💎 List User Premium", callback_data: "adm_list_prem:1" }
      ]
    ]
  };
}

// Buat grid tombol user/server — 4 kolom, 3 baris per halaman = 12 per page
// listCallback = callback untuk prev/next (e.g. "adm_list_users")
function buildItemGrid(items, callbackPrefix, labelKey, page = 1, listCallback) {
  const PER_PAGE = 12; // 3 baris × 4 kolom
  const COLS = 4;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const start = (page - 1) * PER_PAGE;
  const slice = items.slice(start, start + PER_PAGE);

  const rows = [];

  // Item buttons — 4 per row
  for (let i = 0; i < slice.length; i += COLS) {
    const row = slice.slice(i, i + COLS).map(item => ({
      text: item[labelKey],
      callback_data: `${callbackPrefix}:${item.id}`
    }));
    rows.push(row);
  }

  // Navigasi halaman — pakai listCallback eksplisit
  const nav = listCallback || callbackPrefix;
  const navRow = [];
  if (page > 1) navRow.push({ text: "◀️ Prev", callback_data: `${nav}:${page - 1}` });
  navRow.push({ text: `📄 ${page}/${totalPages}`, callback_data: "adm_noop" });
  if (page < totalPages) navRow.push({ text: "Next ▶️", callback_data: `${nav}:${page + 1}` });
  if (navRow.length > 0) rows.push(navRow);

  rows.push([{ text: "🏠 Home", callback_data: "adm_home" }]);

  return { inline_keyboard: rows };
}

function userDetailKeyboard(userId, hasServer) {
  const rows = [];
  if (hasServer) {
    rows.push([{ text: "🗑️ Delete User + Server", callback_data: `adm_del_user_full:${userId}` }]);
  } else {
    rows.push([{ text: "🗑️ Delete User", callback_data: `adm_del_user:${userId}` }]);
  }
  rows.push([{ text: "🏠 Home", callback_data: "adm_home" }]);
  return { inline_keyboard: rows };
}

function serverDetailKeyboard(serverId) {
  return {
    inline_keyboard: [
      [{ text: "🗑️ Delete Server", callback_data: `adm_del_server:${serverId}` }],
      [{ text: "🏠 Home", callback_data: "adm_home" }]
    ]
  };
}

function confirmKeyboard(yesCallback, cancelData) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Ya, Hapus!", callback_data: yesCallback },
        { text: "❌ Batal", callback_data: cancelData }
      ]
    ]
  };
}

// =====================================================================
// TEXT BUILDERS
// =====================================================================

function mainMenuText() {
  return (
    `🛡️ *ADMIN PANEL*\n${sep}\n\n` +
    `Pilih menu di bawah ini:\n\n` +
    `📋 *List Server* — lihat & hapus server\n` +
    `👤 *List User* — lihat & hapus user biasa\n` +
    `🔴 *List User Admin* — lihat & hapus user admin\n` +
    `💎 *List User Premium* — lihat & hapus user reseller\n` +
    `⌯⌲ */addstock* - Untuk add stok produk\n` +
    `⌯⌲ */addproduk* - Membuat produk\n` +
    `⌯⌲ */addscript* - Untuk Mengadd Script\n` +
    `⌯⌲ */delscript* - untuk menghapus produk script\n` +
    `⌯⌲ */delproduk* - Untuk Menghapus produk\n` +
    `⌯⌲ */delstock* - Untuk menghapus stok\n` +
    `⌯⌲ */editstock* - Untuk ngedit stok\n` +
    `⌯⌲ */editproduk* - Untuk ngedit produk\n`
  );
}

// =====================================================================
// MODULE EXPORT
// =====================================================================

module.exports = function (bot) {

  // ── /admin ─────────────────────────────────────────────────────────
  bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);

    if (!isOwner(userId)) {
      return bot.sendMessage(chatId, "⛔ Perintah ini hanya untuk owner.");
    }

    await bot.sendMessage(chatId, mainMenuText(), {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard()
    });
  });

  // ── CALLBACK HANDLER ───────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const userId = String(query.from.id);
    const data   = query.data;

    if (!data.startsWith("adm_")) return;

    // Semua aksi admin hanya untuk owner
    if (!isOwner(userId)) {
      return bot.answerCallbackQuery(query.id, { text: "⛔ Bukan owner.", show_alert: true });
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── Home ─────────────────────────────────────────────────────────
    if (data === "adm_home") {
      return bot.editMessageText(mainMenuText(), {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard()
      }).catch(() => {});
    }

    // ── No-op (halaman info tombol) ───────────────────────────────────
    if (data === "adm_noop") return;

    // ── LIST SERVERS ─────────────────────────────────────────────────
    if (data.startsWith("adm_list_servers:")) {
      const page = parseInt(data.split(":")[1]) || 1;

      await bot.editMessageText(`⏳ Mengambil daftar server...`, {
        chat_id: chatId, message_id: msgId
      }).catch(() => {});

      const servers = await getAllServers();

      if (!servers.length) {
        return bot.editMessageText(
          `📋 *List Server*\n${sep}\n\n_Tidak ada server._`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }

      const items = servers.map(s => ({
        id: s.attributes.id,
        label: s.attributes.name.substring(0, 12)
      }));

      const keyboard = buildItemGrid(items, "adm_server_detail", "label", page, "adm_list_servers");
      const PER_PAGE = 12;
      const start = (page - 1) * PER_PAGE;

      return bot.editMessageText(
        `📋 *List Server* (${servers.length} total)\n${sep}\n\n` +
        `Menampilkan server ${start + 1}–${Math.min(start + PER_PAGE, servers.length)}.\nKlik server untuk detail:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: keyboard }
      ).catch(() => {});
    }

    // ── LIST USERS (non-admin) ────────────────────────────────────────
    if (data.startsWith("adm_list_users:")) {
      const page = parseInt(data.split(":")[1]) || 1;

      await bot.editMessageText(`⏳ Mengambil daftar user...`, {
        chat_id: chatId, message_id: msgId
      }).catch(() => {});

      const allUsers = await getAllUsers();
      const users = allUsers.filter(u => !u.attributes.root_admin);

      if (!users.length) {
        return bot.editMessageText(
          `👤 *List User*\n${sep}\n\n_Tidak ada user biasa._`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }

      const items = users.map(u => ({
        id: u.attributes.id,
        label: u.attributes.username.substring(0, 12)
      }));

      const keyboard = buildItemGrid(items, "adm_user_detail", "label", page, "adm_list_users");
      const PER_PAGE = 12;
      const start = (page - 1) * PER_PAGE;

      return bot.editMessageText(
        `👤 *List User* (${users.length} total)\n${sep}\n\n` +
        `Menampilkan user ${start + 1}–${Math.min(start + PER_PAGE, users.length)}.\nKlik user untuk detail:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: keyboard }
      ).catch(() => {});
    }

    // ── LIST ADMIN USERS ──────────────────────────────────────────────
    if (data.startsWith("adm_list_admins:")) {
      const page = parseInt(data.split(":")[1]) || 1;

      await bot.editMessageText(`⏳ Mengambil daftar user admin...`, {
        chat_id: chatId, message_id: msgId
      }).catch(() => {});

      const allUsers = await getAllUsers();
      const admins = allUsers.filter(u => u.attributes.root_admin);

      if (!admins.length) {
        return bot.editMessageText(
          `🔴 *List User Admin*\n${sep}\n\n_Tidak ada user admin._`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }

      const items = admins.map(u => ({
        id: u.attributes.id,
        label: u.attributes.username.substring(0, 12)
      }));

      const keyboard = buildItemGrid(items, "adm_admin_detail", "label", page, "adm_list_admins");
      const PER_PAGE = 12;
      const start = (page - 1) * PER_PAGE;

      return bot.editMessageText(
        `🔴 *List User Admin* (${admins.length} total)\n${sep}\n\n` +
        `Menampilkan admin ${start + 1}–${Math.min(start + PER_PAGE, admins.length)}.\nKlik user untuk detail:`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: keyboard }
      ).catch(() => {});
    }

    // ── DETAIL SERVER ─────────────────────────────────────────────────
    if (data.startsWith("adm_server_detail:")) {
      const serverId = data.split(":")[1];

      await bot.editMessageText(`⏳ Mengambil detail server...`, {
        chat_id: chatId, message_id: msgId
      }).catch(() => {});

      const sv = await getServerById(serverId);
      if (!sv) {
        return bot.editMessageText("❌ Server tidak ditemukan.", {
          chat_id: chatId, message_id: msgId, reply_markup: homeKeyboard()
        }).catch(() => {});
      }

      const memGb = (sv.limits.memory / 1024).toFixed(1);
      const diskGb = (sv.limits.disk / 1024).toFixed(1);
      const text =
        `📋 *Detail Server*\n${sep}\n\n` +
        `🖥️ Nama      : \`${sv.name}\`\n` +
        `🆔 ID        : \`${sv.id}\`\n` +
        `🔑 UUID      : \`${sv.uuid}\`\n` +
        `👤 User ID   : \`${sv.user}\`\n` +
        `💾 RAM       : ${memGb} GB\n` +
        `💿 Disk      : ${diskGb} GB\n` +
        `⚡ CPU       : ${sv.limits.cpu}%\n` +
        `📅 Dibuat    : ${new Date(sv.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n` +
        `⚠️ Tekan *Delete* untuk menghapus server ini.`;

      return bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: serverDetailKeyboard(sv.id)
      }).catch(() => {});
    }

    // ── DETAIL USER (biasa) ───────────────────────────────────────────
    if (data.startsWith("adm_user_detail:")) {
      const pteroId = data.split(":")[1];
      await _showUserDetail(bot, chatId, msgId, pteroId, false);
      return;
    }

    // ── DETAIL USER ADMIN ─────────────────────────────────────────────
    if (data.startsWith("adm_admin_detail:")) {
      const pteroId = data.split(":")[1];
      await _showUserDetail(bot, chatId, msgId, pteroId, true);
      return;
    }

    // ── KONFIRMASI DELETE SERVER ───────────────────────────────────────
    if (data.startsWith("adm_del_server:")) {
      const serverId = data.split(":")[1];
      return bot.editMessageText(
        `⚠️ *Konfirmasi Hapus Server*\n${sep}\n\n` +
        `Server ID: \`${serverId}\`\n\n` +
        `Tindakan ini *tidak dapat dibatalkan!*\nYakin ingin menghapus?`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: confirmKeyboard(`adm_confirm_del_server:${serverId}`, "adm_home")
        }
      ).catch(() => {});
    }

    // ── KONFIRMASI DELETE USER ─────────────────────────────────────────
    if (data.startsWith("adm_del_user:")) {
      const pteroId = data.split(":")[1];
      return bot.editMessageText(
        `⚠️ *Konfirmasi Hapus User*\n${sep}\n\n` +
        `User ID: \`${pteroId}\`\n\n` +
        `Tindakan ini *tidak dapat dibatalkan!*\nYakin ingin menghapus?`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: confirmKeyboard(`adm_confirm_del_user:${pteroId}`, "adm_home")
        }
      ).catch(() => {});
    }

    // ── KONFIRMASI DELETE USER + SERVER ────────────────────────────────
    if (data.startsWith("adm_del_user_full:")) {
      const pteroId = data.split(":")[1];
      return bot.editMessageText(
        `⚠️ *Konfirmasi Hapus User + Server*\n${sep}\n\n` +
        `User ID: \`${pteroId}\`\n\n` +
        `Semua server milik user ini juga akan *dihapus!*\nTindakan ini *tidak dapat dibatalkan!*\nYakin?`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: confirmKeyboard(`adm_confirm_del_user_full:${pteroId}`, "adm_home")
        }
      ).catch(() => {});
    }

    // ── EKSEKUSI DELETE SERVER ─────────────────────────────────────────
    if (data.startsWith("adm_confirm_del_server:")) {
      const serverId = data.split(":")[1];

      await bot.editMessageText(`⏳ Menghapus server \`${serverId}\`...`, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
      }).catch(() => {});

      const status = await pteroDelete(`/servers/${serverId}`);

      if (status === 204) {
        return bot.editMessageText(
          `✅ *Server berhasil dihapus!*\n\nID: \`${serverId}\``,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      } else {
        return bot.editMessageText(
          `❌ *Gagal menghapus server!*\n\nStatus: ${status}\nCoba lagi atau cek Pterodactyl.`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }
    }

    // ── EKSEKUSI DELETE USER (tanpa server) ───────────────────────────
    if (data.startsWith("adm_confirm_del_user:")) {
      const pteroId = data.split(":")[1];

      await bot.editMessageText(`⏳ Menghapus user \`${pteroId}\`...`, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
      }).catch(() => {});

      const status = await pteroDelete(`/users/${pteroId}`);

      if (status === 204) {
        return bot.editMessageText(
          `✅ *User berhasil dihapus!*\n\nID: \`${pteroId}\``,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      } else {
        return bot.editMessageText(
          `❌ *Gagal menghapus user!*\n\nStatus: ${status}\n_Pastikan user tidak punya server aktif, atau gunakan opsi Delete User + Server._`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }
    }

    // ── EKSEKUSI DELETE USER + SEMUA SERVER ───────────────────────────
    if (data.startsWith("adm_confirm_del_user_full:")) {
      const pteroId = parseInt(data.split(":")[1]);

      await bot.editMessageText(`⏳ Menghapus server milik user \`${pteroId}\`...`, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
      }).catch(() => {});

      // Hapus semua server milik user
      const userServers = await getServersByUser(pteroId);
      let deletedServers = 0;
      for (const sv of userServers) {
        const st = await pteroDelete(`/servers/${sv.attributes.id}`);
        if (st === 204) deletedServers++;
      }

      // Hapus user
      await bot.editMessageText(`⏳ Menghapus user \`${pteroId}\`...`, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
      }).catch(() => {});

      const userStatus = await pteroDelete(`/users/${pteroId}`);

      if (userStatus === 204) {
        return bot.editMessageText(
          `✅ *User + Server berhasil dihapus!*\n\n` +
          `👤 User ID  : \`${pteroId}\`\n` +
          `🖥️ Server   : ${deletedServers} dihapus`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      } else {
        return bot.editMessageText(
          `⚠️ *Server terhapus tapi user gagal dihapus!*\n\n` +
          `🖥️ Server dihapus : ${deletedServers}\n` +
          `❌ Status user    : ${userStatus}\n\n` +
          `Coba hapus user manual di panel.`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }
    }

    // ── LIST USER PREMIUM ─────────────────────────────────────────────
    if (data.startsWith("adm_list_prem:")) {
      const page = parseInt(data.split(":")[1]) || 1;

      await bot.editMessageText(`⏳ Mengambil daftar user premium...`, {
        chat_id: chatId, message_id: msgId
      }).catch(() => {});

      const premUsers = await getAllPremiumUsers();

      if (!premUsers.length) {
        return bot.editMessageText(
          `💎 *List User Premium*\n${sep}\n\n_Belum ada user premium._`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }

      const PER_PAGE = 12;
      const totalPages = Math.max(1, Math.ceil(premUsers.length / PER_PAGE));
      const start = (page - 1) * PER_PAGE;
      const slice = premUsers.slice(start, start + PER_PAGE);
      const COLS = 4;

      const rows = [];
      for (let i = 0; i < slice.length; i += COLS) {
        const row = slice.slice(i, i + COLS).map(u => ({
          text: (u.username ? `@${u.username}` : u.telegram_name || u.user_id).substring(0, 12),
          callback_data: `adm_prem_detail:${u.user_id}`
        }));
        rows.push(row);
      }

      const navRow = [];
      if (page > 1) navRow.push({ text: "◀️ Prev", callback_data: `adm_list_prem:${page - 1}` });
      navRow.push({ text: `📄 ${page}/${totalPages}`, callback_data: "adm_noop" });
      if (page < totalPages) navRow.push({ text: "Next ▶️", callback_data: `adm_list_prem:${page + 1}` });
      if (navRow.length > 0) rows.push(navRow);
      rows.push([{ text: "🏠 Home", callback_data: "adm_home" }]);

      return bot.editMessageText(
        `💎 *List User Premium* (${premUsers.length} total)\n${sep}\n\n` +
        `Menampilkan ${start + 1}–${Math.min(start + PER_PAGE, premUsers.length)}. Klik user untuk detail:`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: rows }
        }
      ).catch(() => {});
    }

    // ── DETAIL USER PREMIUM ───────────────────────────────────────────
    if (data.startsWith("adm_prem_detail:")) {
      const premUserId = data.slice("adm_prem_detail:".length);

      await bot.editMessageText(`⏳ Mengambil detail user premium...`, {
        chat_id: chatId, message_id: msgId
      }).catch(() => {});

      const { data: u, error } = await supabase
        .from("premium_users")
        .select("*")
        .eq("user_id", String(premUserId))
        .single();

      if (error || !u) {
        return bot.editMessageText("❌ User premium tidak ditemukan.", {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: homeKeyboard()
        }).catch(() => {});
      }

      const boughtAt = new Date(u.bought_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const text =
        `💎 *Detail User Premium*\n${sep}\n\n` +
        `🆔 User ID    : \`${u.user_id}\`\n` +
        `👤 Nama       : ${u.telegram_name || "-"}\n` +
        `📛 Username   : ${u.username ? `@${u.username}` : "-"}\n` +
        `💳 Metode     : ${u.payment_method || "-"}\n` +
        `🔗 Join Grup  : ${u.joined_group ? "✅ Sudah" : "❌ Belum"}\n` +
        `🔖 Order ID   : \`${u.order_id || "-"}\`\n` +
        `📅 Beli Tgl   : ${boughtAt}`;

      return bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🗑️ Delete User Premium", callback_data: `adm_dprem:${u.user_id}` }],
            [{ text: "🏠 Home", callback_data: "adm_home" }]
          ]
        }
      }).catch(() => {});
    }

    // ── KONFIRMASI DELETE USER PREMIUM ────────────────────────────────
    if (data.startsWith("adm_dprem:")) {
      const premUserId = data.slice("adm_dprem:".length);

      return bot.editMessageText(
        `⚠️ *Konfirmasi Hapus User Premium*\n${sep}\n\n` +
        `🆔 User ID: \`${premUserId}\`\n\n` +
        `User akan dihapus dari daftar premium.\n` +
        `Tindakan ini *tidak dapat dibatalkan!*\n\nYakin ingin menghapus?`,
        {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Ya, Hapus!", callback_data: `adm_okdprem:${premUserId}` },
                { text: "❌ Batal", callback_data: "adm_home" }
              ]
            ]
          }
        }
      ).catch(() => {});
    }

    // ── EKSEKUSI DELETE USER PREMIUM ──────────────────────────────────
    if (data.startsWith("adm_okdprem:")) {
      const premUserId = data.slice("adm_okdprem:".length);

      await bot.editMessageText(`⏳ Menghapus user premium \`${premUserId}\`...`, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
      }).catch(() => {});

      const ok = await deletePremiumUser(premUserId);

      if (ok) {
        return bot.editMessageText(
          `✅ *User Premium berhasil dihapus!*\n\n🆔 User ID: \`${premUserId}\``,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      } else {
        return bot.editMessageText(
          `❌ *Gagal menghapus user premium!*\n\nCek koneksi Supabase.`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: homeKeyboard() }
        ).catch(() => {});
      }
    }
  });

  // ── Internal: tampilkan detail user ───────────────────────────────
  async function _showUserDetail(bot, chatId, msgId, pteroId, isAdmin) {
    await bot.editMessageText(`⏳ Mengambil detail user...`, {
      chat_id: chatId, message_id: msgId
    }).catch(() => {});

    const user = await getUserById(pteroId);
    if (!user) {
      return bot.editMessageText("❌ User tidak ditemukan.", {
        chat_id: chatId, message_id: msgId, reply_markup: homeKeyboard()
      }).catch(() => {});
    }

    const servers = await getServersByUser(user.id);
    const hasServer = servers.length > 0;

    let serverList = "";
    if (hasServer) {
      serverList = "\n📂 *Server milik user:*\n";
      servers.forEach((sv, i) => {
        const memGb = (sv.attributes.limits.memory / 1024).toFixed(1);
        serverList += `  ${i + 1}. \`${sv.attributes.name}\` — ${memGb}GB RAM\n`;
      });
    }

    const adminBadge = user.root_admin ? "🔴 Admin" : "👤 User";
    const text =
      `${isAdmin ? "🔴" : "👤"} *Detail ${isAdmin ? "User Admin" : "User"}*\n${sep}\n\n` +
      `🆔 ID         : \`${user.id}\`\n` +
      `👤 Username   : \`${user.username}\`\n` +
      `📧 Email      : \`${user.email}\`\n` +
      `🏷️ Role       : ${adminBadge}\n` +
      `🖥️ Server     : ${hasServer ? `${servers.length} server aktif` : "_Tidak ada server_"}\n` +
      `📅 Dibuat     : ${new Date(user.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
      serverList +
      `\n⚠️ Tekan *Delete* untuk menghapus user ini.`;

    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: userDetailKeyboard(user.id, hasServer)
    }).catch(() => {});
  }
};
