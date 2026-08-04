const QRCode   = require("qrcode");
const { Client } = require("ssh2");
const {
  savePending, getPending, removePending,
  createTransaction, checkTransaction, cancelTransaction,
  saveTransaction, updateTransactionStatus
} = require("../../lib/pakasir");
const {
  PAKASIR_API_KEY, PAKASIR_PROJECT, OWNER_ID, LOG_CHANNEL_ID
} = require("../../config");
const { generateReceipt } = require("../../lib/receipt");
const { blockIfDisabled, blockCallbackIfDisabled } = require("../../lib/features");

const INSTALL_PRICE    = parseInt(process.env.BIP_PRICE)        || 50000;
const PANEL_ADMIN_USER = process.env.BIP_PANEL_USER             || "wyii";
const PANEL_ADMIN_PASS = process.env.BIP_PANEL_PASS             || "2901";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS  = 10 * 60 * 1000;

const activePolls = new Map();

// State per user setelah bayar:
// { step, orderId, ip, rootPass, domainPanel, domainNode, ram, chatId }
const userState = new Map();

// =====================================================================
// HELPERS
// =====================================================================
function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}
function generateOrderId(userId) {
  return `BIP${userId}${Date.now()}`;
}
async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

// =====================================================================
// KEYBOARDS
// =====================================================================
function noteKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🏠 Home",              callback_data: "start_home"     },
      { text: "💳 Lanjut Bayar QRIS", callback_data: "bip_pay_qris" }
    ]]
  };
}
function qrisCancelKeyboard(orderId) {
  return {
    inline_keyboard: [[
      { text: "❌ Batalkan Order", callback_data: `bip_cancel_qris:${orderId}` }
    ]]
  };
}
function confirmInstallKeyboard() {
  return {
    inline_keyboard: [[
      { text: "✅ Ya, Mulai Install!", callback_data: "bip_confirm_install" },
      { text: "❌ Batal",             callback_data: "bip_cancel_install"   }
    ]]
  };
}

// =====================================================================
// TEKS
// =====================================================================
function noteText(userId, fromUser) {
  const tanggalStr = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  return (
    `<i>🛍️ JASA INSTALL PANEL PTERODACTYL</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⌯⌲ Produk : Jasa Install Panel\n` +
    `⌯⌲ Harga : ${formatRupiah(INSTALL_PRICE)}\n` +
    `⌯⌲ ID Telegram : <code>${userId}</code>\n` +
    `⌯⌲ Username Telegram : ${fromUser?.username ? `@${fromUser.username}` : "-"}\n` +
    `⌯⌲ Tanggal : ${tanggalStr}\n\n` +
    `<i>Pilih Metode Pembayaran anda</i>`
  );
}
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
Gunakan /buyinstallpanel untuk mencoba lagi.`;
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
    `⌯⌲ Produk : Jasa Install Panel
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
// SSH INSTALL (otomatis setelah data VPS lengkap)
// =====================================================================
async function runInstall(bot, chatId, userId, orderId, { ip, rootPass, domainPanel, domainNode, ram }, fromObj) {
  const sep = "─".repeat(28);
  const user = PANEL_ADMIN_USER;
  const pass = PANEL_ADMIN_PASS;
  const commandPanel = `bash <(curl -s https://pterodactyl-installer.se)`;

  const ress = new Client();

  console.log(`[BIP] ▶ runInstall dimulai | orderId=${orderId} | userId=${userId} | ip=${ip} | domainPanel=${domainPanel} | domainNode=${domainNode} | ram=${ram}`);

  // Generate struk di awal agar tersedia untuk semua notifikasi
  const ADMIN_IDS = LOG_CHANNEL_ID ? [String(LOG_CHANNEL_ID).trim()] : [];
  const buyerName = fromObj
    ? [fromObj.first_name, fromObj.last_name].filter(Boolean).join(" ")
    : String(userId);
  const buyerUsername = fromObj?.username || null;
  let receiptBuffer = null;
  try {
    const { buffer: rb } = await generateReceipt(bot, {
      buyerUserId:   userId,
      buyerName,
      buyerUsername,
      orderId,
      productLabel:  `Install Panel - ${domainPanel}`,
      productType:   "Install Panel",
      price:         0,
      paymentMethod: "saldo",
      extraRows: [
        { label: "IP VPS",       value: ip },
        { label: "Domain Panel", value: domainPanel },
        { label: "Domain Node",  value: domainNode || "-" }
      ],
      storeName:    "BiYu Store",
      storeContact: "@BiYuStore"
    });
    receiptBuffer = rb;
  } catch (_) {}

  // Kirim status sedang proses
  await bot.sendMessage(chatId,
    `⚙️ *Memproses install panel...*\n${sep}\n\n` +
    `🔌 Menghubungkan ke VPS \`${ip}\`...\n\n` +
    `_Mohon tunggu, proses ini memakan waktu 10–30 menit._`,
    { parse_mode: "Markdown" }
  );

  // Notif owner — struk image (install dimulai)
  for (const adminId of ADMIN_IDS) {
    if (receiptBuffer) {
      bot.sendPhoto(adminId, receiptBuffer, {
        caption:
          `🧾 *STRUK PEMBELIAN PRODUK*\n` +
          `━━━━━━━━━━━\n` +
          `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
          `𝗣𝗥𝗢𝗗𝗨𝗞 : Install Panel\n` +
          `𝗜𝗣 𝗩𝗣𝗦 : \`${ip}\`\n` +
          `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n` +
          `━━━━━━━━━━━\n` +
          `𝗦𝗧𝗔𝗧𝗨𝗦 : ⏳ Proses Install\n` +
          `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
          `━━━━━━━━━━━`,
        parse_mode: "Markdown"
      }).catch(() => {});
    } else {
      bot.sendMessage(adminId,
        `🧾 *STRUK PEMBELIAN PRODUK*\n` +
        `━━━━━━━━━━━\n` +
        `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
        `𝗣𝗥𝗢𝗗𝗨𝗞 : Install Panel\n` +
        `𝗜𝗣 𝗩𝗣𝗦 : \`${ip}\`\n` +
        `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n` +
        `━━━━━━━━━━━\n` +
        `𝗦𝗧𝗔𝗧𝗨𝗦 : ⏳ Proses Install\n` +
        `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
        `━━━━━━━━━━━`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  }

  // ── Install Wings ─────────────────────────────────────────────────
  function instalWings() {
    return new Promise((resolve, reject) => {
      console.log(`[BIP] 🔧 instalWings() dimulai | orderId=${orderId}`);
      ress.exec(commandPanel, (err, stream) => {
        if (err) {
          console.error(`[BIP] ❌ instalWings exec error | orderId=${orderId} | err=${err.message}`);
          return reject(err);
        }
        stream.setEncoding("utf8");
        stream.on("data", (data) => {
          const out = data.toString();
          console.log(`[BIP WINGS STDOUT] ${out.trim()}`);
          if (out.includes("Input 0-6"))             stream.write("1\n");
          if (out.includes("(y/N)"))                 stream.write("y\n");
          if (out.includes("(Y)es"))                 stream.write("y\n");
          if (out.includes("Enter the panel address")) stream.write(`${domainPanel}\n`);
          if (out.includes("Database host username")) stream.write(`${user}\n`);
          if (out.includes("Database host password")) stream.write(`${pass}\n`);
          if (out.includes("node.example.com"))       stream.write(`${domainNode}\n`);
          if (out.includes("Enter email"))            stream.write("wyi@gmail.com\n");
        });
        stream.stderr.on("data", (data) => {
          console.warn(`[BIP WINGS STDERR] ${data.toString().trim()}`);
        });
        stream.on("close", async () => {
          console.log(`[BIP] ✅ instalWings script selesai, lanjut createnode | orderId=${orderId}`);
          // Selesai wings → create node
          ress.exec(
            `bash <(curl -s https://raw.githubusercontent.com/Bangsano/Autoinstaller-Theme-Pterodactyl/main/createnode.sh)`,
            (err2, stream2) => {
              if (err2) {
                console.error(`[BIP] ❌ createnode exec error | orderId=${orderId} | err=${err2.message}`);
                return reject(err2);
              }
              stream2.setEncoding("utf8");
              stream2.on("data", (chunk) => {
                const out = chunk.toString();
                console.log(`[BIP CREATENODE STDOUT] ${out.trim()}`);
                if (out.includes("Masukkan nama lokasi"))       stream2.write("SGP\n");
                if (out.includes("Masukkan deskripsi lokasi"))  stream2.write("WYII STORE NIH!!!\n");
                if (out.includes("Masukkan domain"))            stream2.write(`${domainNode}\n`);
                if (out.includes("Masukkan nama node"))         stream2.write("NODE BY WYII\n");
                if (out.includes("Masukkan RAM"))               stream2.write(`${ram}\n`);
                if (out.includes("disk space"))                 stream2.write(`${ram}\n`);
                if (out.includes("Masukkan Locid"))             stream2.write("1\n");
              });
              stream2.stderr.on("data", (data) => {
                console.warn(`[BIP CREATENODE STDERR] ${data.toString().trim()}`);
              });
              stream2.on("close", () => {
                console.log(`[BIP] ✅ createnode selesai, generate config.yml & restart wings | orderId=${orderId}`);
                // Generate config.yml & restart wings
                const cmdCfg =
                  `cd /var/www/pterodactyl && ` +
                  `php artisan p:node:configuration 1 > /etc/pterodactyl/config.yml && ` +
                  `chmod 600 /etc/pterodactyl/config.yml && systemctl restart wings`;
                ress.exec(cmdCfg, (err3) => {
                  if (err3) {
                    console.error(`[BIP] ❌ config.yml/restart wings error | orderId=${orderId} | err=${err3.message}`);
                    return reject(err3);
                  }
                  console.log(`[BIP] ✅ Wings berhasil direstart | orderId=${orderId}`);
                  resolve();
                });
              });
            }
          );
        });
      });
    });
  }

  // ── Install Panel ─────────────────────────────────────────────────
  function instalPanel() {
    return new Promise((resolve, reject) => {
      console.log(`[BIP] 🔧 instalPanel() dimulai | orderId=${orderId}`);
      ress.exec(commandPanel, (err, stream) => {
        if (err) {
          console.error(`[BIP] ❌ instalPanel exec error | orderId=${orderId} | err=${err.message}`);
          return reject(err);
        }
        stream.setEncoding("utf8");
        stream.on("data", (data) => {
          const out = data.toString();
          console.log(`[BIP PANEL STDOUT] ${out.trim()}`);
          if (out.includes("Input 0-6"))                        stream.write("0\n");
          if (out.includes("(y/N)"))                            stream.write("y\n");
          if (out.includes("Database name"))                    stream.write(`${user}\n`);
          if (out.includes("Database username"))                stream.write(`${user}\n`);
          if (out.includes("Password"))                         stream.write(`${pass}\n`);
          if (out.includes("Select timezone"))                  stream.write("Asia/Jakarta\n");
          if (out.includes("Provide the email"))                stream.write("wyi@gmail.com\n");
          if (out.includes("Email address for the initial admin")) stream.write("wyi@gmail.com\n");
          if (out.includes("Username for the initial admin"))   stream.write(`${user}\n`);
          if (out.includes("First name"))                       stream.write("wyi\n");
          if (out.includes("Last name"))                        stream.write("wyi\n");
          if (out.includes("Set the FQDN"))                     stream.write(`${domainPanel}\n`);
          if (out.includes("UFW"))                              stream.write("y\n");
          if (out.includes("HTTPS"))                            stream.write("y\n");
          if (out.includes("Select the appropriate number"))    stream.write("1\n");
          if (out.includes("I agree"))                          stream.write("y\n");
          if (out.includes("Proceed anyways"))                  stream.write("y\n");
          if (out.includes("(yes/no)"))                         stream.write("yes\n");
          if (out.includes("Initial configuration completed"))  stream.write("y\n");
          if (out.includes("Still assume SSL"))                 stream.write("y\n");
          if (out.includes("Terms of Service"))                 stream.write("y\n");
          if (out.includes("(A)gree"))                          stream.write("A\n");
        });
        stream.stderr.on("data", (data) => {
          console.warn(`[BIP PANEL STDERR] ${data.toString().trim()}`);
        });
        stream.on("close", () => {
          console.log(`[BIP] ✅ instalPanel() selesai | orderId=${orderId}`);
          resolve();
        });
      });
    });
  }

  // ── Koneksi SSH ───────────────────────────────────────────────────
  ress.on("ready", async () => {
    console.log(`[BIP] ✅ SSH terhubung ke VPS ${ip} | orderId=${orderId}`);
    try {
      // Kirim update: terhubung, mulai install
      await bot.sendMessage(chatId,
        `✅ *Terhubung ke VPS!*\n\n` +
        `🔄 *Step 1/3* — Menginstall Panel Pterodactyl...\n` +
        `_Proses ini ±10 menit, jangan tutup bot._`,
        { parse_mode: "Markdown" }
      );

      console.log(`[BIP] 🔄 Step 1/3 - Mulai instalPanel | orderId=${orderId}`);
      await instalPanel();
      console.log(`[BIP] ✅ Step 1/3 - instalPanel selesai | orderId=${orderId}`);

      await bot.sendMessage(chatId,
        `✅ *Panel selesai diinstall!*\n\n` +
        `🔄 *Step 2/3* — Menginstall Wings & membuat Node...\n` +
        `_Hampir selesai, tunggu sebentar lagi..._`,
        { parse_mode: "Markdown" }
      );

      console.log(`[BIP] 🔄 Step 2/3 - Mulai instalWings | orderId=${orderId}`);
      await instalWings();
      console.log(`[BIP] ✅ Step 2/3 - instalWings selesai | orderId=${orderId}`);

      ress.end();

      // ── SELESAI — kirim kredensial ke buyer ────────────────────
      console.log(`[BIP] 🎉 Step 3/3 - Install SELESAI! Kirim kredensial ke buyer | orderId=${orderId} | userId=${userId}`);
      await bot.sendMessage(chatId,
        `🎉 *INSTALL SELESAI!*\n${sep}\n\n` +
        `📦 *Detail Akun Admin Panel:*\n\n` +
        `🌐 *Domain Panel* : \`${domainPanel}\`\n` +
        `👤 *Username*     : \`${user}\`\n` +
        `🔑 *Password*     : \`${pass}\`\n\n` +
        `${sep}\n` +
        `📌 *PENTING — Simpan data ini!*\n` +
        `• Login ke panel: \`${domainPanel}\`\n` +
        `• Segera ganti password setelah login\n` +
        `• Node sudah terkonfigurasi & aktif\n\n` +
        `🔖 Order ID: \`${orderId}\`\n\n` +
        `_Terima kasih sudah menggunakan layanan kami!_ 🙏`,
        { parse_mode: "Markdown" }
      );

      // Notif owner: selesai — struk image
      try {
        console.log(`[BIP] 📨 Generate receipt & notif owner | orderId=${orderId}`);
        const buyerName = fromObj
          ? [fromObj.first_name, fromObj.last_name].filter(Boolean).join(" ")
          : String(userId);
        const buyerUsername = fromObj?.username || null;

        const { buffer, filename } = await generateReceipt(bot, {
          buyerUserId:   userId,
          buyerName,
          buyerUsername,
          orderId,
          productLabel:  "Install Panel Pterodactyl",
          productType:   "Jasa Install",
          price:         INSTALL_PRICE,
          paymentMethod: "qris",
          extraRows: [
            { label: "IP VPS",    value: ip },
            { label: "Domain Panel", value: domainPanel },
            { label: "Domain Node",  value: domainNode },
            { label: "RAM",          value: ram + " MB" }
          ],
          storeName:    "BiYu Store",
          storeContact: "@BiYuStore"
        });

        for (const adminId of ADMIN_IDS) {
          bot.sendPhoto(adminId, buffer, {
            caption:
              `🧾 *STRUK PEMBELIAN PRODUK*\n` +
              `━━━━━━━━━━━\n` +
              `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
              `𝗣𝗥𝗢𝗗𝗨𝗞 : Install Panel\n` +
              `𝗣𝗔𝗡𝗘𝗟 : ${domainPanel}\n` +
              `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n` +
              `━━━━━━━━━━━\n` +
              `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
              `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
              `━━━━━━━━━━━`,
            parse_mode: "Markdown"
          }).catch(() => {});
        }
      } catch (_e) {
        console.warn(`[BIP] ⚠️ Gagal generate receipt, kirim teks biasa ke owner | orderId=${orderId} | err=${_e.message}`);
        for (const adminId of ADMIN_IDS) {
          bot.sendPhoto(adminId, receiptBuffer, {
            caption:
              `🧾 *STRUK PEMBELIAN PRODUK*\n` +
              `━━━━━━━━━━━\n` +
              `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
              `𝗣𝗥𝗢𝗗𝗨𝗞 : Install Panel\n` +
              `𝗣𝗔𝗡𝗘𝗟 : ${domainPanel}\n` +
              `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n` +
              `━━━━━━━━━━━\n` +
              `𝗦𝗧𝗔𝗧𝗨𝗦 : ✅\n` +
              `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
              `━━━━━━━━━━━`,
            parse_mode: "Markdown"
          }).catch(() => {});
        }
      }

      // Hapus state
      console.log(`[BIP] 🧹 userState dihapus setelah install selesai | userId=${userId} | orderId=${orderId}`);
      userState.delete(userId);

    } catch (err) {
      ress.end();
      console.error(`[BIP] ❌ INSTALL GAGAL | orderId=${orderId} | userId=${userId} | err=${err.message}`);
      await bot.sendMessage(chatId,
        `❌ *Gagal saat proses install!*\n\n` +
        `Error: \`${err.message}\`\n\n` +
        `Hubungi admin dengan Order ID: \`${orderId}\``,
        { parse_mode: "Markdown" }
      );
      for (const adminId of ADMIN_IDS) {
        bot.sendPhoto(adminId, receiptBuffer, {
          caption:
            `🧾 *STRUK PEMBELIAN PRODUK*\n` +
            `━━━━━━━━━━━\n` +
            `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
            `𝗣𝗥𝗢𝗗𝗨𝗞 : Install Panel\n` +
            `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n\n` +
            `━━━━━━━━━━━\n` +
            `𝗦𝗧𝗔𝗧𝗨𝗦 : ❌ Gagal\n` +
            `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
            `━━━━━━━━━━━`,
          parse_mode: "Markdown"
        }).catch(() => {});
      }
      console.log(`[BIP] 🧹 userState dihapus setelah error | userId=${userId} | orderId=${orderId}`);
      userState.delete(userId);
    }
  });

  ress.on("error", async (err) => {
    console.error(`[BIP] ❌ SSH KONEKSI GAGAL | orderId=${orderId} | ip=${ip} | err=${err.message}`);
    await bot.sendMessage(chatId,
      `❌ *Gagal konek ke VPS!*\n\n` +
      `Error: \`${err.message}\`\n\n` +
      `Pastikan:\n` +
      `• IP VPS benar\n` +
      `• Password root benar\n` +
      `• Port 22 terbuka\n\n` +
      `Hubungi admin dengan Order ID: \`${orderId}\``,
      { parse_mode: "Markdown" }
    );
    console.log(`[BIP] 🧹 userState dihapus setelah koneksi gagal | userId=${userId}`);
    userState.delete(userId);
  });

  console.log(`[BIP] 🔌 Mencoba SSH ke ${ip}:22 | orderId=${orderId}`);
  ress.connect({ host: ip, port: 22, username: "root", password: rootPass });
}

// =====================================================================
// POLLING QRIS
// =====================================================================
function startInstallPolling(bot, orderId, chatId, msgId, userId) {
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
      console.warn("[BIP EDITCAP]", err?.message);
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
      const expStr  = pending.expired_at
        ? new Date(pending.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
        : "-";

      if (elapsed > POLL_TIMEOUT_MS) {
        clearInterval(intervalId);
        activePolls.delete(orderId);
        await removePending(orderId);
        await updateTransactionStatus(orderId, "expired");
        editCap(
          buildQrisCaption(orderId, pending.amount, pending.fee, pending.total_payment, expStr, "expired", elapsed, pending.userId, null),
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
          buildQrisCaption(orderId, pending.amount, pending.fee, pending.total_payment, expStr, "pending", elapsed, pending.userId, null),
          qrisCancelKeyboard(orderId)
        );
        return;
      }

      clearInterval(intervalId);
      activePolls.delete(orderId);
      await removePending(orderId);
      await updateTransactionStatus(orderId, status);

      if (status === "completed") {
        await bot.deleteMessage(chatId, msgId).catch(() => {});

        // ── BAYAR SUKSES → minta data VPS sekaligus ──────────────
        await bot.sendMessage(chatId,
          `✅ *Pembayaran Diterima!*\n\n` +
          `🖥️ *Jasa Install Panel Pterodactyl*\n` +
          `🔖 Order ID: \`${orderId}\`\n\n` +
          `${"─".repeat(28)}\n\n` +
          `📋 *Kirimkan data VPS kamu dalam format berikut:*\n\n` +
          `\`ipvps|password|domainpanel.com|domainnode.com|rammb\`\n\n` +
          `*Contoh:*\n` +
          `\`167.235.1.1|rootpass123|panel.domain.com|node.domain.com|100000\`\n\n` +
          `${"─".repeat(28)}\n` +
          `_Kirim semuanya dalam satu pesan sekaligus._`,
          { parse_mode: "Markdown" }
        );

        // Set state → tunggu data VPS satu baris
        userState.set(userId, {
          step: "awaiting_vps_data",
          orderId,
          chatId
        });

        // Notif owner
        const ADMIN_IDS = LOG_CHANNEL_ID ? [String(LOG_CHANNEL_ID).trim()] : [];
        const notifCaption =
          `🧾 *STRUK PEMBELIAN PRODUK*\n` +
          `━━━━━━━━━━━\n` +
          `𝗜𝗗 𝗣𝗘𝗠𝗕𝗘𝗟𝗜 : \`${userId}\`\n` +
          `𝗣𝗥𝗢𝗗𝗨𝗞 : Install Panel\n` +
          `𝗣𝗔𝗬𝗠𝗘𝗡𝗧 : QRIS\n` +
          `𝗧𝗔𝗡𝗚𝗚𝗔𝗟 : ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}\n` +
          `𝗛𝗔𝗥𝗚𝗔 𝗣𝗥𝗢𝗗𝗨𝗞 : ${formatRupiah(pending.amount)}\n\n` +
          `━━━━━━━━━━━\n` +
          `𝗦𝗧𝗔𝗧𝗨𝗦 : ⏳ Menunggu Data VPS\n` +
          `𝗜𝗗 𝗣𝗥𝗢𝗗𝗨𝗞 : \`${orderId}\`\n` +
          `━━━━━━━━━━━`;
        let pollReceiptBuffer = null;
        try {
          const { buffer: prb } = await generateReceipt(bot, {
            buyerUserId:   userId,
            buyerName:     pending.fromUser ? [pending.fromUser.first_name, pending.fromUser.last_name].filter(Boolean).join(" ") : String(userId),
            buyerUsername: pending.fromUser?.username || null,
            orderId,
            productLabel:  "Install Panel Pterodactyl",
            productType:   "Jasa Install",
            price:         pending.amount,
            paymentMethod: "qris",
            storeName:    "BiYu Store",
            storeContact: "@BiYuStore"
          });
          pollReceiptBuffer = prb;
        } catch (_) {}
        for (const adminId of ADMIN_IDS) {
          if (pollReceiptBuffer) {
            bot.sendPhoto(adminId, pollReceiptBuffer, { caption: notifCaption, parse_mode: "Markdown" }).catch(() => {});
          } else {
            bot.sendMessage(adminId, notifCaption, { parse_mode: "Markdown" }).catch(() => {});
          }
        }

      } else {
        editCap(
          buildQrisCaption(orderId, pending.amount, pending.fee, pending.total_payment, expStr, status, 0, pending.userId, null),
          { inline_keyboard: [] }
        );
      }
    } catch (err) {
      console.warn(`[BIP POLL] ${orderId}:`, err?.message);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
}

// =====================================================================
// MODULE EXPORT
// =====================================================================
module.exports = function (bot) {

  // ── /buyinstallpanel ───────────────────────────────────────────────
  bot.onText(/\/buyinstallpanel/, async (msg) => {
    const chatId = msg.chat.id;
    if (await blockIfDisabled(bot, "jasa_install_panel", chatId)) return;
    await bot.sendMessage(chatId, noteText(userId, msg?.from || query?.from), {
      parse_mode: "Markdown",
      reply_markup: noteKeyboard()
    });
  });

  // ── CALLBACK HANDLER ───────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const userId = String(query.from.id);
    const data   = query.data;

    const isBipCb = (
      data === "bip_home"           ||
      data === "bip_pay_qris"       ||
      data === "bip_confirm_install"||
      data === "bip_cancel_install" ||
      data === "start_jasainstall"  ||
      data.startsWith("bip_cancel_qris:")
    );
    if (!isBipCb) return;

    if (await blockCallbackIfDisabled(bot, "jasa_install_panel", query)) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // Dari tombol menu /start
    if (data === "start_jasainstall") {
      await bot.deleteMessage(chatId, msgId).catch(() => {});
      return bot.sendMessage(chatId, noteText(userId, msg?.from || query?.from), {
        parse_mode: "Markdown",
        reply_markup: noteKeyboard()
      });
    }

    // Home
    if (data === "bip_home") {
      await bot.deleteMessage(chatId, msgId).catch(() => {});
      return bot.sendMessage(chatId,
        `🏠 *Kembali ke menu utama.*\n\nKetik /start untuk melihat semua layanan.`,
        { parse_mode: "Markdown" }
      );
    }

    // Lanjut Bayar QRIS
    if (data === "bip_pay_qris") {
      const orderId = generateOrderId(userId);
      let result;
      try {
        await bot.editMessageText("⏳ Membuat transaksi QRIS...", { chat_id: chatId, message_id: msgId });
        result = await createTransaction({
          orderId, amount: INSTALL_PRICE,
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
      const total     = payment?.total_payment || INSTALL_PRICE;
      const fee       = payment?.fee || 0;
      const expStr    = expiredAt
        ? new Date(expiredAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
        : "-";

      await savePending(orderId, {
        userId, chatId,
        amount: INSTALL_PRICE, fee, total_payment: total,
        expired_at: expiredAt, status: "pending"
      });
      await saveTransaction({
        orderId, userId, chatId,
        type: "buyinstallpanel",
        amount: INSTALL_PRICE, fee, totalPayment: total,
        paymentMethod: "qris", status: "pending",
        productName: "Jasa Install Panel Pterodactyl",
        expiredAt
      });

      await bot.deleteMessage(chatId, msgId).catch(() => {});

      const caption = buildQrisCaption(orderId, INSTALL_PRICE, fee, total, expStr, "pending", 0, userId, query.from);
      let sentMsg;
      if (qrisStr) {
        const qrBuf = await makeQrBuffer(qrisStr);
        sentMsg = await bot.sendPhoto(chatId, qrBuf, {
          caption, parse_mode: "Markdown",
          reply_markup: qrisCancelKeyboard(orderId)
        });
      } else {
        sentMsg = await bot.sendMessage(chatId, caption, {
          parse_mode: "Markdown",
          reply_markup: qrisCancelKeyboard(orderId)
        });
      }

      startInstallPolling(bot, orderId, chatId, sentMsg.message_id, userId);
    }

    // Konfirmasi mulai install
    if (data === "bip_confirm_install") {
      const state = userState.get(userId);
      if (!state || state.step !== "confirming") {
        return bot.sendMessage(chatId, "❌ Sesi tidak ditemukan, hubungi admin.");
      }
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      userState.set(userId, { ...state, step: "installing" });

      // Mulai install
      runInstall(bot, chatId, userId, state.orderId, {
        ip: state.ip,
        rootPass: state.rootPass,
        domainPanel: state.domainPanel,
        domainNode: state.domainNode,
        ram: state.ram
      }, query.from);
    }

    // Batal install (sebelum SSH)
    if (data === "bip_cancel_install") {
      userState.delete(userId);
      await bot.editMessageText("🚫 *Install dibatalkan.*\n\nHubungi admin jika ada pertanyaan.", {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
      });
    }

    // Cancel QRIS aktif
    if (data.startsWith("bip_cancel_qris:")) {
      const orderId = data.split(":")[1];
      const pending = await getPending(orderId);

      if (!pending) {
        return bot.answerCallbackQuery(query.id, {
          text: "Order tidak ditemukan atau sudah selesai.", show_alert: true
        });
      }
      if (pending.userId !== userId) {
        return bot.answerCallbackQuery(query.id, {
          text: "⛔ Bukan order kamu.", show_alert: true
        });
      }

      if (activePolls.has(orderId)) {
        clearInterval(activePolls.get(orderId));
        activePolls.delete(orderId);
      }

      await removePending(orderId);
      await updateTransactionStatus(orderId, "cancelled");

      try {
        await cancelTransaction({
          orderId, amount: pending.amount,
          apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT
        });
      } catch (e) { console.warn("[BIP CANCEL]", e?.message); }

      await bot.deleteMessage(chatId, msgId).catch(() => {});
      const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : ${orderId}</em>\n` +
        `<em>⌯⌲  Tanggal : ${tglCancel}</em></blockquote>`;
      const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
    }
  });

  // ── HANDLER TEKS: data VPS satu baris ────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const state  = userState.get(userId);

    if (!state || state.step !== "awaiting_vps_data") return;

    const text = msg.text.trim();
    const sep  = "─".repeat(28);
    const parts = text.split("|");

    // Validasi: harus 5 bagian
    if (parts.length !== 5) {
      return bot.sendMessage(chatId,
        `❌ *Format salah!* Harus 5 bagian dipisah \`|\`\n\n` +
        `📋 *Format yang benar:*\n` +
        `\`ipvps|password|domainpanel.com|domainnode.com|rammb\`\n\n` +
        `*Contoh:*\n` +
        `\`167.235.1.1|rootpass123|panel.domain.com|node.domain.com|100000\``,
        { parse_mode: "Markdown" }
      );
    }

    const [ip, rootPass, domainPanel, domainNode, ramRaw] = parts.map(s => s.trim());
    const ram = parseInt(ramRaw);

    // Validasi IP
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return bot.sendMessage(chatId,
        `❌ *IP VPS tidak valid!*\n_Contoh IP yang benar: \`167.235.1.1\`_\n\nKirim ulang dengan format:\n\`ipvps|password|domainpanel.com|domainnode.com|rammb\``,
        { parse_mode: "Markdown" }
      );
    }

    // Validasi password
    if (rootPass.length < 4) {
      return bot.sendMessage(chatId,
        `❌ *Password terlalu pendek!* Minimal 4 karakter.\n\nKirim ulang dengan format:\n\`ipvps|password|domainpanel.com|domainnode.com|rammb\``,
        { parse_mode: "Markdown" }
      );
    }

    // Validasi domain panel
    if (!domainPanel.includes(".")) {
      return bot.sendMessage(chatId,
        `❌ *Domain Panel tidak valid!*\n_Contoh: \`panel.domain.com\`_\n\nKirim ulang dengan format:\n\`ipvps|password|domainpanel.com|domainnode.com|rammb\``,
        { parse_mode: "Markdown" }
      );
    }

    // Validasi domain node
    if (!domainNode.includes(".")) {
      return bot.sendMessage(chatId,
        `❌ *Domain Node tidak valid!*\n_Contoh: \`node.domain.com\`_\n\nKirim ulang dengan format:\n\`ipvps|password|domainpanel.com|domainnode.com|rammb\``,
        { parse_mode: "Markdown" }
      );
    }

    // Validasi RAM
    if (isNaN(ram) || ram < 512) {
      return bot.sendMessage(chatId,
        `❌ *RAM tidak valid!* Minimal 512 MB.\n_Contoh: \`100000\`_\n\nKirim ulang dengan format:\n\`ipvps|password|domainpanel.com|domainnode.com|rammb\``,
        { parse_mode: "Markdown" }
      );
    }

    // Semua valid → simpan state & tampilkan ringkasan
    const newState = { ...state, step: "confirming", ip, rootPass, domainPanel, domainNode, ram };
    userState.set(userId, newState);

    return bot.sendMessage(chatId,
      `📋 *Ringkasan Data VPS*\n${sep}\n\n` +
      `🌐 *IP VPS*       : \`${ip}\`\n` +
      `🔑 *Password*     : \`${rootPass}\`\n` +
      `🖥️ *Domain Panel* : \`${domainPanel}\`\n` +
      `🔗 *Domain Node*  : \`${domainNode}\`\n` +
      `💾 *RAM*          : \`${ram} MB\`\n\n` +
      `${sep}\n` +
      `⚠️ *Pastikan semua data di atas sudah benar!*\n` +
      `Setelah konfirmasi, proses install akan dimulai otomatis.`,
      {
        parse_mode: "Markdown",
        reply_markup: confirmInstallKeyboard()
      }
    );
  });
};
