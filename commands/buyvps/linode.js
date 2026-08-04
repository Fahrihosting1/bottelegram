const QRCode = require("qrcode");
const {
  getSaldo, savePending, getPending, removePending,
  updatePendingStatus, topupSaldo,
  createTransaction, checkTransaction, cancelTransaction,
  saveTransaction, updateTransactionStatus
} = require("../../lib/pakasir");
const supabase = require("../../lib/supabase");
const config = require("../../config");
const { blockIfDisabled, blockCallbackIfDisabled } = require("../../lib/features");

const PAKASIR_API_KEY = config.PAKASIR_API_KEY || "ISI_API_KEY_PAKASIR_ANDA";
const PAKASIR_PROJECT = config.PAKASIR_PROJECT || "depodomain";
const LINODE_API_TOKEN = config.LINODE_API_TOKEN || "ISI_LINODE_TOKEN_ANDA";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const activePolls = new Map();

// ===== VPS PRODUCTS =====
const VPS_PRODUCTS = {
  "linode_1gb": {
    name: "Linode Nanode 1GB",
    ram: "1GB",
    cpu: "1 Core",
    storage: "25GB SSD",
    bandwidth: "1TB",
    price: 25000,
    type: "g6-nanode-1"
  },
  "linode_2gb": {
    name: "Linode 2GB RAM",
    ram: "2GB",
    cpu: "1 Core",
    storage: "50GB SSD",
    bandwidth: "2TB",
    price: 50000,
    type: "g6-standard-1"
  },
  "linode_4gb": {
    name: "Linode 4GB RAM",
    ram: "4GB",
    cpu: "2 Core",
    storage: "80GB SSD",
    bandwidth: "4TB",
    price: 100000,
    type: "g6-standard-2"
  },
  "linode_8gb": {
    name: "Linode 8GB RAM",
    ram: "8GB",
    cpu: "4 Core",
    storage: "160GB SSD",
    bandwidth: "5TB",
    price: 200000,
    type: "g6-standard-4"
  },
  "linode_16gb": {
    name: "Linode 16GB RAM",
    ram: "16GB",
    cpu: "8 Core",
    storage: "320GB SSD",
    bandwidth: "8TB",
    price: 400000,
    type: "g6-standard-8"
  }
};

// ===== VPS CATEGORIES (LOW / MEDIUM / HIGH) =====
const VPS_CATEGORIES = {
  low: {
    label: "🟢 LOW VPS",
    emoji: "🟢",
    garansi: "15 Hari",
    suspend: "10 Jam",
    replace: "0x",
    packages: ["linode_1gb", "linode_2gb"],
    startPrice: 25000
  },
  medium: {
    label: "🟡 MEDIUM VPS",
    emoji: "🟡",
    garansi: "25 Hari",
    suspend: "24 Jam",
    replace: "1x",
    packages: ["linode_4gb"],
    startPrice: 100000
  },
  high: {
    label: "🔴 HIGH VPS",
    emoji: "🔴",
    garansi: "30 Hari",
    suspend: "-",
    replace: "Unlimited",
    packages: ["linode_8gb", "linode_16gb"],
    startPrice: 200000
  }
};

// ===== CEK STOK DARI LINODE API =====
async function checkLinodeStock() {
  try {
    const response = await fetch("https://api.linode.com/v4/linode/instances?page=1&page_size=1", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINODE_API_TOKEN}`
      }
    });
    if (!response.ok) return { available: false, count: 0 };
    const data = await response.json();
    // Cek apakah akun bisa membuat instance (jika API valid & results dapat diakses)
    return { available: true, count: data.results ?? 0 };
  } catch (e) {
    return { available: false, count: 0 };
  }
}

// ===== OS OPTIONS =====
const OS_OPTIONS = {
  "ubuntu_24": { name: "Ubuntu 24.04 LTS", image: "linode/ubuntu24.04", icon: "🐧" },
  "ubuntu_22": { name: "Ubuntu 22.04 LTS", image: "linode/ubuntu22.04", icon: "🐧" },
  "ubuntu_20": { name: "Ubuntu 20.04 LTS", image: "linode/ubuntu20.04", icon: "🐧" },
  "debian_12": { name: "Debian 12", image: "linode/debian12", icon: "🌀" },
  "debian_11": { name: "Debian 11", image: "linode/debian11", icon: "🌀" },
  "centos_stream9": { name: "CentOS Stream 9", image: "linode/centos-stream9", icon: "🎩" },
  "almalinux_9": { name: "AlmaLinux 9", image: "linode/almalinux9", icon: "💠" },
  "rocky_9": { name: "Rocky Linux 9", image: "linode/rocky9", icon: "🪨" },
  "fedora_40": { name: "Fedora 40", image: "linode/fedora40", icon: "🎩" }
};

// ===== REGION OPTIONS =====
const REGION_OPTIONS = {
  "ap-south": { name: "Singapore", flag: "🇸🇬", country: "Singapore" },
  "ap-northeast": { name: "Tokyo, Japan", flag: "🇯🇵", country: "Japan" },
  "ap-west": { name: "Mumbai, India", flag: "🇮🇳", country: "India" },
  "ap-southeast": { name: "Sydney, Australia", flag: "🇦🇺", country: "Australia" },
  "us-east": { name: "Newark, USA", flag: "🇺🇸", country: "USA" },
  "us-central": { name: "Dallas, USA", flag: "🇺🇸", country: "USA" },
  "us-west": { name: "Fremont, USA", flag: "🇺🇸", country: "USA" },
  "us-southeast": { name: "Atlanta, USA", flag: "🇺🇸", country: "USA" },
  "eu-central": { name: "Frankfurt, Germany", flag: "🇩🇪", country: "Germany" },
  "eu-west": { name: "London, UK", flag: "🇬🇧", country: "UK" },
  "ca-central": { name: "Toronto, Canada", flag: "🇨🇦", country: "Canada" }
};

// User session state: userId -> { productId, osId, regionId, orderId, paymentMethod }
const userSessions = new Map();

function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function generateOrderId(userId) {
  return `VPS${userId}${Date.now()}`;
}

function generateRandomPassword(length = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function makeQrBuffer(str) {
  return QRCode.toBuffer(str, { errorCorrectionLevel: "M", width: 420, margin: 2 });
}

// ===== SUPABASE FUNCTIONS =====

async function saveVpsOrder(orderId, data) {
  await supabase.from("vps_orders").upsert({
    order_id: orderId,
    user_id: String(data.userId),
    chat_id: data.chatId,
    product_id: data.productId,
    product_name: data.productName,
    os_id: data.osId || null,
    os_name: data.osName || null,
    region_id: data.regionId || null,
    region_name: data.regionName || null,
    price: data.price,
    payment_method: data.paymentMethod,
    status: data.status || "pending_payment",
    label: data.label || null,
    linode_id: data.linodeId || null,
    ip_address: data.ipAddress || null,
    root_password: data.rootPassword || null,
    created_at: new Date().toISOString()
  }, { onConflict: "order_id" });
}

async function getVpsOrder(orderId) {
  const { data, error } = await supabase
    .from("vps_orders")
    .select("*")
    .eq("order_id", orderId)
    .single();
  return error ? null : data;
}

async function updateVpsOrder(orderId, updates) {
  await supabase.from("vps_orders").update(updates).eq("order_id", orderId);
}

async function getVpsOrdersByUser(userId) {
  const { data } = await supabase
    .from("vps_orders")
    .select("*")
    .eq("user_id", String(userId))
    .order("created_at", { ascending: false })
    .limit(10);
  return data || [];
}

async function deductSaldo(userId, amount) {
  const current = await getSaldo(userId);
  if (current < amount) return false;
  
  const newBalance = current - amount;
  await supabase.from("saldo").upsert({
    user_id: String(userId),
    balance: newBalance,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });

  await supabase.from("saldo_history").insert({
    user_id: String(userId),
    type: "purchase",
    amount: -amount,
    balance_after: newBalance,
    description: "Pembelian VPS Linode"
  });

  return newBalance;
}

// ===== CREATE LINODE VPS =====
async function createLinodeVps(product, osImage, region, label) {
  const linodeData = {
    label: label,
    region: region,
    type: product.type,
    image: osImage,
    root_pass: generateRandomPassword(),
    backups_enabled: false
  };

  const response = await fetch("https://api.linode.com/v4/linode/instances", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINODE_API_TOKEN}`
    },
    body: JSON.stringify(linodeData)
  });

  const responseData = await response.json();

  if (!response.ok) {
    throw new Error(responseData.errors?.[0]?.reason || "Gagal membuat Linode");
  }

  return {
    linodeId: responseData.id,
    rootPassword: linodeData.root_pass
  };
}

async function getLinodeInfo(linodeId) {
  const response = await fetch(`https://api.linode.com/v4/linode/instances/${linodeId}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINODE_API_TOKEN}`
    }
  });

  const data = await response.json();
  return {
    ipAddress: data.ipv4?.[0] || "Pending...",
    status: data.status
  };
}

// ===== KEYBOARD BUILDERS =====

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🖥️ Beli VPS Linode", callback_data: "ln_vps_select_package" }],
      [{ text: "📜 Riwayat Transaksi", callback_data: "ln_vps_history" }],
      [{ text: "💰 Cek Saldo", callback_data: "ln_vps_saldo" }]
    ]
  };
}

function categoryListKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟢 LOW", callback_data: "ln_cat_low" }],
      [{ text: "🟡 MEDIUM", callback_data: "ln_cat_medium" }],
      [{ text: "🔴 HIGH", callback_data: "ln_cat_high" }],
      [{ text: "🔙 Kembali", callback_data: "ln_back_home" }]
    ]
  };
}

function packageListKeyboard(categoryId) {
  const cat = VPS_CATEGORIES[categoryId];
  if (!cat) return { inline_keyboard: [] };
  const rows = cat.packages.map(pkgId => {
    const p = VPS_PRODUCTS[pkgId];
    return [{ text: `💾 ${p.ram} / ${p.cpu} - ${formatRupiah(p.price)}/bln`, callback_data: `ln_pkg_${pkgId}` }];
  });
  rows.push([{ text: "🔙 Kembali ke Kategori", callback_data: "ln_vps_select_package" }]);
  return { inline_keyboard: rows };
}

function osListKeyboard(productId) {
  return {
    inline_keyboard: [
      [
        { text: "🐧 Ubuntu 24.04", callback_data: `ln_os_${productId}_ubuntu_24` },
        { text: "🐧 Ubuntu 22.04", callback_data: `ln_os_${productId}_ubuntu_22` }
      ],
      [
        { text: "🐧 Ubuntu 20.04", callback_data: `ln_os_${productId}_ubuntu_20` },
        { text: "🌀 Debian 12", callback_data: `ln_os_${productId}_debian_12` }
      ],
      [
        { text: "🌀 Debian 11", callback_data: `ln_os_${productId}_debian_11` },
        { text: "🎩 CentOS Stream 9", callback_data: `ln_os_${productId}_centos_stream9` }
      ],
      [
        { text: "💠 AlmaLinux 9", callback_data: `ln_os_${productId}_almalinux_9` },
        { text: "🪨 Rocky Linux 9", callback_data: `ln_os_${productId}_rocky_9` }
      ],
      [{ text: "🎩 Fedora 40", callback_data: `ln_os_${productId}_fedora_40` }],
      [{ text: "⬅️ Kembali ke Paket", callback_data: "ln_vps_select_package" }]
    ]
  };
}

function regionListKeyboard(productId, osId) {
  return {
    inline_keyboard: [
      [
        { text: "🇸🇬 Singapore", callback_data: `ln_reg_${productId}_${osId}_ap-south` },
        { text: "🇯🇵 Tokyo", callback_data: `ln_reg_${productId}_${osId}_ap-northeast` }
      ],
      [
        { text: "🇮🇳 Mumbai", callback_data: `ln_reg_${productId}_${osId}_ap-west` },
        { text: "🇦🇺 Sydney", callback_data: `ln_reg_${productId}_${osId}_ap-southeast` }
      ],
      [
        { text: "🇺🇸 Newark", callback_data: `ln_reg_${productId}_${osId}_us-east` },
        { text: "🇺🇸 Dallas", callback_data: `ln_reg_${productId}_${osId}_us-central` }
      ],
      [
        { text: "🇺🇸 Fremont", callback_data: `ln_reg_${productId}_${osId}_us-west` },
        { text: "🇺🇸 Atlanta", callback_data: `ln_reg_${productId}_${osId}_us-southeast` }
      ],
      [
        { text: "🇩🇪 Frankfurt", callback_data: `ln_reg_${productId}_${osId}_eu-central` },
        { text: "🇬🇧 London", callback_data: `ln_reg_${productId}_${osId}_eu-west` }
      ],
      [{ text: "🇨🇦 Toronto", callback_data: `ln_reg_${productId}_${osId}_ca-central` }],
      [{ text: "⬅️ Kembali ke OS", callback_data: `ln_pkg_${productId}` }]
    ]
  };
}

function paymentMethodKeyboard(productId, osId, regionId) {
  return {
    inline_keyboard: [
      [{ text: "📱 Bayar dengan QRIS", callback_data: `ln_pay_qris_${productId}_${osId}_${regionId}` }],
      [{ text: "⬅️ Kembali ke Region", callback_data: `ln_os_${productId}_${osId}` }],
      [{ text: "🏠 Kembali ke Menu", callback_data: "ln_back_home" }]
    ]
  };
}

function invoiceKeyboard(orderId, paymentMethod) {
  if (paymentMethod === "saldo") {
    return {
      inline_keyboard: [
        [{ text: "✅ Bayar Sekarang", callback_data: `ln_confirm_saldo_${orderId}` }],
        [{ text: "❌ Cancel", callback_data: `ln_cancel_order_${orderId}` }],
        [{ text: "🏠 Kembali ke Menu", callback_data: "ln_back_home" }]
      ]
    };
  }
  return {
    inline_keyboard: [
      [{ text: "🔄 Cek Pembayaran", callback_data: `ln_cek_vps_${orderId}` }],
      [{ text: "❌ Batalkan", callback_data: `ln_cancel_vps_${orderId}` }],
      [{ text: "🏠 Kembali ke Menu", callback_data: "ln_back_home" }]
    ]
  };
}

function afterPaymentKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🖥️ Beli VPS Lagi", callback_data: "ln_vps_select_package" }],
      [{ text: "📜 Lihat Riwayat", callback_data: "ln_vps_history" }],
      [{ text: "🏠 Kembali ke Menu", callback_data: "ln_back_home" }]
    ]
  };
}

// ===== MESSAGE BUILDERS =====

function buildPackageDetail(product, os, region) {
  const sep = "─".repeat(28);
  return `🖥️ *KONFIGURASI VPS*\n` +
    `${sep}\n\n` +
    `📦 *Paket: ${product.name}*\n` +
    `💾 RAM      : ${product.ram}\n` +
    `🔧 CPU      : ${product.cpu}\n` +
    `💽 Storage  : ${product.storage}\n` +
    `🌐 Bandwidth: ${product.bandwidth}\n\n` +
    `${os.icon} *OS: ${os.name}*\n` +
    `${region.flag} *Region: ${region.name}*\n\n` +
    `${sep}\n` +
    `💰 *Harga: ${formatRupiah(product.price)}/bulan*\n` +
    `${sep}\n\n` +
    `_Pilih metode pembayaran:_`;
}

function buildInvoice(order, product, os, region, saldo) {
  const sep = "─".repeat(28);
  const timestamp = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  
  return `📋 *INVOICE PEMBELIAN VPS*\n` +
    `${sep}\n\n` +
    `🔖 Order ID: \`${order.orderId}\`\n` +
    `📅 Tanggal : ${timestamp}\n\n` +
    `${sep}\n` +
    `📦 *DETAIL PRODUK*\n` +
    `${sep}\n\n` +
    `🖥️ Paket    : ${product.name}\n` +
    `💾 RAM      : ${product.ram}\n` +
    `🔧 CPU      : ${product.cpu}\n` +
    `💽 Storage  : ${product.storage}\n` +
    `🌐 Bandwidth: ${product.bandwidth}\n` +
    `${os.icon} OS       : ${os.name}\n` +
    `${region.flag} Region   : ${region.name}\n\n` +
    `${sep}\n` +
    `💳 *PEMBAYARAN*\n` +
    `${sep}\n\n` +
    `💰 Harga    : ${formatRupiah(product.price)}\n` +
    `📱 Metode   : ${order.paymentMethod === "saldo" ? "Saldo" : "QRIS Pakasir"}\n` +
    `💵 Saldo    : ${formatRupiah(saldo)}\n\n` +
    `${sep}\n` +
    `💰 *TOTAL: ${formatRupiah(product.price)}*\n` +
    `${sep}`;
}

function buildQrisInvoice(orderId, product, os, region, qrisData) {
  const sep = "─".repeat(28);
  const expStr = qrisData.expired_at
    ? new Date(qrisData.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    : "-";

  return `📋 *INVOICE VPS - QRIS*\n` +
    `${sep}\n\n` +
    `🔖 Order ID: \`${orderId}\`\n` +
    `📦 Paket   : ${product.name}\n` +
    `${os.icon} OS      : ${os.name}\n` +
    `${region.flag} Region  : ${region.name}\n\n` +
    `💰 Total   : *${formatRupiah(qrisData.total_payment || product.price)}*\n` +
    `⚡ Fee     : ${formatRupiah(qrisData.fee || 0)}\n` +
    `⏰ Expired : ${expStr}\n\n` +
    `${sep}\n` +
    `📲 *Scan QRIS untuk bayar*\n` +
    `⏳ Menunggu pembayaran...\n` +
    `_Bot cek otomatis tiap 5 detik_`;
}

function buildVpsCreatedMessage(order, vpsInfo) {
  const sep = "─".repeat(28);
  return `✅ *VPS BERHASIL DIBUAT!*\n` +
    `${sep}\n\n` +
    `🔖 Order ID : \`${order.order_id}\`\n` +
    `📦 Paket    : ${order.product_name}\n` +
    `🐧 OS       : ${order.os_name || "-"}\n` +
    `🌍 Region   : ${order.region_name || "-"}\n\n` +
    `${sep}\n` +
    `🖥️ *DETAIL VPS*\n` +
    `${sep}\n\n` +
    `🆔 Linode ID: \`${order.linode_id}\`\n` +
    `🌐 IP Address: \`${vpsInfo.ipAddress}\`\n` +
    `🔑 Password : \`${order.root_password}\`\n` +
    `👤 Username : root\n\n` +
    `${sep}\n` +
    `📌 *Cara Akses:*\n` +
    `\`ssh root@${vpsInfo.ipAddress}\`\n` +
    `${sep}\n\n` +
    `⚠️ _Simpan password dengan aman!_`;
}

function buildHistoryMessage(orders) {
  if (!orders.length) {
    return "📜 *RIWAYAT TRANSAKSI VPS*\n\n_Belum ada transaksi VPS._";
  }

  const sep = "─".repeat(28);
  let text = `📜 *RIWAYAT TRANSAKSI VPS*\n${sep}\n\n`;

  orders.forEach((order, idx) => {
    const date = new Date(order.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const statusEmoji = {
      "pending_payment": "⏳",
      "processing": "🔄",
      "provisioning": "🔧",
      "completed": "✅",
      "cancelled": "❌",
      "expired": "⌛",
      "failed": "❗"
    }[order.status] || "❓";

    text += `${idx + 1}. ${statusEmoji} *${order.product_name}*\n`;
    text += `   🐧 ${order.os_name || "-"} | 🌍 ${order.region_name || "-"}\n`;
    text += `   📅 ${date}\n`;
    text += `   💰 ${formatRupiah(order.price)}\n`;
    text += `   🔖 \`${order.order_id}\`\n`;
    if (order.ip_address) {
      text += `   🌐 \`${order.ip_address}\`\n`;
    }
    text += `\n`;
  });

  return text;
}

// ===== POLLING FOR QRIS PAYMENT =====
function startVpsPolling(bot, orderId, chatId, msgId, product, os, region) {
  if (activePolls.has(orderId)) return;
  const startTime = Date.now();

  const intervalId = setInterval(async () => {
    const order = await getVpsOrder(orderId);

    if (!order || order.status !== "pending_payment") {
      clearInterval(intervalId);
      activePolls.delete(orderId);
      return;
    }

    const elapsed = Date.now() - startTime;

    if (elapsed > POLL_TIMEOUT_MS) {
      clearInterval(intervalId);
      activePolls.delete(orderId);
      await updateVpsOrder(orderId, { status: "expired" });
      await updateTransactionStatus(orderId, "expired");

      bot.editMessageCaption(
        `⌛ *PEMBAYARAN KEDALUWARSA*\n\nOrder: \`${orderId}\`\n\nGunakan /buyvps untuk order baru.`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: afterPaymentKeyboard()
        }
      ).catch(() => {});
      return;
    }

    try {
      const result = await checkTransaction({
        orderId,
        amount: product.price,
        apiKey: PAKASIR_API_KEY,
        project: PAKASIR_PROJECT
      });

      const trx = result?.transaction;
      const status = trx?.status;

      if (status === "completed") {
        clearInterval(intervalId);
        activePolls.delete(orderId);

        await updateVpsOrder(orderId, { status: "processing" });
        await updateTransactionStatus(orderId, "processing");

        bot.editMessageCaption(
          `✅ *PEMBAYARAN DITERIMA!*\n\n` +
          `🔖 Order: \`${orderId}\`\n` +
          `📦 Paket: ${product.name}\n` +
          `🐧 OS: ${os.name}\n` +
          `🌍 Region: ${region.name}\n\n` +
          `⏳ Sedang membuat VPS...\n` +
          `_Proses ini membutuhkan 1-2 menit_`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] }
          }
        ).catch(() => {});

        await processVpsCreation(bot, chatId, orderId, product, os, region);
      }
    } catch (err) {
      console.warn(`[VPS POLL] ${orderId}:`, err?.response?.data || err.message);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
}

async function processVpsCreation(bot, chatId, orderId, product, os, region) {
  try {
    const label = `vps-${orderId.slice(-8)}`;
    
    const { linodeId, rootPassword } = await createLinodeVps(product, os.image, region.id || Object.keys(REGION_OPTIONS).find(k => REGION_OPTIONS[k] === region), label);

    await updateVpsOrder(orderId, {
      linode_id: linodeId,
      root_password: rootPassword,
      label: label,
      status: "provisioning"
    });

    await new Promise(resolve => setTimeout(resolve, 60000));

    const vpsInfo = await getLinodeInfo(linodeId);

    await updateVpsOrder(orderId, {
      ip_address: vpsInfo.ipAddress,
      status: "completed",
      completed_at: new Date().toISOString()
    });

    await updateTransactionStatus(orderId, "completed", {
      metadata: { ip_address: vpsInfo.ipAddress, linode_id: linodeId }
    });

    const order = await getVpsOrder(orderId);
    const message = buildVpsCreatedMessage(order, vpsInfo);

    bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: afterPaymentKeyboard()
    });

  } catch (err) {
    console.error(`[VPS CREATE] Error:`, err);
    await updateVpsOrder(orderId, { status: "failed" });
    await updateTransactionStatus(orderId, "failed");
    bot.sendMessage(chatId,
      `❌ *GAGAL MEMBUAT VPS*\n\n` +
      `Order: \`${orderId}\`\n` +
      `Error: ${err.message}\n\n` +
      `_Silakan hubungi admin._`,
      { parse_mode: "Markdown", reply_markup: afterPaymentKeyboard() }
    );
  }
}

// ===== MODULE EXPORT =====
module.exports = function (bot) {

  // /buyvpslinode - Main command (also triggered via ln_buyvpslinode callback)
  const sendLinodeMenu = (chatId) => {
    bot.sendMessage(chatId,
      `🖥️ *BELI VPS LINODE*\n` +
      `${"─".repeat(28)}\n\n` +
      `Selamat datang di layanan VPS Linode!\n\n` +
      `✅ Pilih Paket sesuai kebutuhan\n` +
      `✅ Pilih OS favorit kamu\n` +
      `✅ Pilih Region terdekat\n` +
      `✅ Full root access\n\n` +
      `_Pilih menu di bawah:_`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
  };

  bot.onText(/\/buyvpslinode$/, async (msg) => {
    if (await blockIfDisabled(bot, "buy_vps", msg.chat.id)) return;
    sendLinodeMenu(msg.chat.id);
  });

  // /vpshistory - View history
  bot.onText(/\/vpshistory/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    
    const orders = await getVpsOrdersByUser(userId);
    bot.sendMessage(chatId, buildHistoryMessage(orders), {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard()
    });
  });

  // ===== CALLBACK QUERY HANDLER =====
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = String(query.from.id);
    const data = query.data;

    // Guard: hanya proses callback milik linode
    const isLinodeCb = (
      data === "ln_buyvpslinode" ||
      data === "ln_back_home" ||
      data === "ln_vps_history" ||
      data === "ln_vps_saldo" ||
      data === "ln_vps_select_package" ||
      data.startsWith("ln_cat_") ||
      data.startsWith("ln_pkg_linode_") ||
      data.startsWith("ln_pkg_") ||
      data.startsWith("ln_os_") ||
      data.startsWith("ln_reg_") ||
      data.startsWith("ln_pay_qris_") ||
      data.startsWith("ln_pay_saldo_") ||
      data.startsWith("ln_confirm_saldo_") ||
      data.startsWith("ln_cancel_order_") ||
      data.startsWith("ln_cancel_vps_") ||
      data.startsWith("ln_cek_vps_")
    );
    if (!isLinodeCb) return;

    if (await blockCallbackIfDisabled(bot, "buy_vps", query)) return;

// Entry point via callback (dari menu /buyvps)
if (data === "ln_buyvpslinode") {
  await bot.answerCallbackQuery(query.id);

  // Hapus pesan tombol sebelumnya
  await bot.deleteMessage(chatId, query.message.message_id);

  return sendLinodeMenu(chatId);
}
    // Back to home menu
    if (data === "ln_back_home") {
      await bot.answerCallbackQuery(query.id);
      userSessions.delete(userId);
      bot.editMessageText(
        `🖥️ *BELI VPS LINODE*\n` +
        `${"─".repeat(28)}\n\n` +
        `Selamat datang di layanan VPS Linode!\n\n` +
        `✅ Pilih Paket sesuai kebutuhan\n` +
        `✅ Pilih OS favorit kamu\n` +
        `✅ Pilih Region terdekat\n` +
        `✅ Full root access\n\n` +
        `_Pilih menu di bawah:_`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard()
        }
      );
      return;
    }

    // Step 1: Katalog Kategori VPS
    if (data === "ln_vps_select_package") {
      await bot.answerCallbackQuery(query.id);
      userSessions.delete(userId);

      const stock = await checkLinodeStock();
      const stockText = stock.available
        ? `📦 <b>STOK TERSEDIA:</b> Ready untuk pemesanan!`
        : `⚠️ <b>STOK:</b> Sedang dalam pengecekan...`;

      const sep = "━━━━━━━━━━━━━━━━━━━━━━";
      const text =
        `<b>🛒 KATALOG VPS LINODE</b>
${sep}
` +
        `${stockText}
` +
        `⚙️ <b>Pilih tipe VPS sesuai kebutuhan Anda:</b>
${sep}
` +
        `🟢 <b>LOW VPS</b>
` +
        `▪ Garansi: <b>${VPS_CATEGORIES.low.garansi}</b>
` +
        `▪ Garansi Suspend: <b>${VPS_CATEGORIES.low.suspend}</b>
` +
        `▪ Replace: <b>${VPS_CATEGORIES.low.replace}</b>
` +
        `▪ Harga mulai: <b>${formatRupiah(VPS_CATEGORIES.low.startPrice)}</b>
${sep}
` +
        `🟡 <b>MEDIUM VPS</b>
` +
        `▪ Garansi: <b>${VPS_CATEGORIES.medium.garansi}</b>
` +
        `▪ Garansi Suspend: <b>${VPS_CATEGORIES.medium.suspend}</b>
` +
        `▪ Replace: <b>${VPS_CATEGORIES.medium.replace}</b>
` +
        `▪ Harga mulai: <b>${formatRupiah(VPS_CATEGORIES.medium.startPrice)}</b>
${sep}
` +
        `🔴 <b>HIGH VPS</b>
` +
        `▪ Garansi: <b>${VPS_CATEGORIES.high.garansi}</b>
` +
        `▪ Replace: <b>${VPS_CATEGORIES.high.replace}</b>
` +
        `▪ Harga mulai: <b>${formatRupiah(VPS_CATEGORIES.high.startPrice)}</b>
${sep}
` +
        `✨ <b>Silakan pilih kategori VPS:</b>`;

      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
        reply_markup: categoryListKeyboard()
      });
      return;
    }

    // Step 1b: Pilih paket dalam kategori
    if (data.startsWith("ln_cat_")) {
      const categoryId = data.replace("ln_cat_", "");
      const cat = VPS_CATEGORIES[categoryId];
      if (!cat) return bot.answerCallbackQuery(query.id, { text: "Kategori tidak ditemukan", show_alert: true });

      await bot.answerCallbackQuery(query.id);
      userSessions.set(userId, { categoryId });

      const sep = "━━━━━━━━━━━━━━━━━━━━━━";
      bot.editMessageText(
        `${cat.label}
${sep}

` +
        `▪ Garansi: <b>${cat.garansi}</b>
` +
        `▪ Garansi Suspend: <b>${cat.suspend}</b>
` +
        `▪ Replace: <b>${cat.replace}</b>

` +
        `<b>Pilih spesifikasi VPS:</b>`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "HTML",
          reply_markup: packageListKeyboard(categoryId)
        }
      );
      return;
    }

    // Step 2: Select OS (after package selection)
    if (data.startsWith("ln_pkg_")) {
      const productId = data.replace("ln_pkg_", "");
      const product = VPS_PRODUCTS[productId];
      
      if (!product) {
        return bot.answerCallbackQuery(query.id, { text: "Paket tidak ditemukan", show_alert: true });
      }

      userSessions.set(userId, { productId });

      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(
        `🐧 *STEP 2: PILIH SISTEM OPERASI*\n` +
        `${"─".repeat(28)}\n\n` +
        `📦 Paket: *${product.name}*\n` +
        `💰 Harga: *${formatRupiah(product.price)}/bln*\n\n` +
        `Pilih OS yang ingin diinstall:\n`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: osListKeyboard(productId)
        }
      );
      return;
    }

    // Step 3: Select Region (after OS selection)
    if (data.startsWith("ln_os_")) {
      const parts = data.replace("ln_os_", "").split("_");
      const productId = parts[0] + "_" + parts[1]; // linode_1gb, linode_2gb, etc.
      const osId = parts.slice(2).join("_"); // ubuntu_24, debian_12, etc.
      
      const product = VPS_PRODUCTS[productId];
      const os = OS_OPTIONS[osId];
      
      if (!product || !os) {
        return bot.answerCallbackQuery(query.id, { text: "Konfigurasi tidak valid", show_alert: true });
      }

      userSessions.set(userId, { productId, osId });

      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(
        `🌍 *STEP 3: PILIH REGION*\n` +
        `${"─".repeat(28)}\n\n` +
        `📦 Paket: *${product.name}*\n` +
        `${os.icon} OS: *${os.name}*\n` +
        `💰 Harga: *${formatRupiah(product.price)}/bln*\n\n` +
        `Pilih lokasi server:\n`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: regionListKeyboard(productId, osId)
        }
      );
      return;
    }

    // Step 4: Select Payment (after region selection)
    if (data.startsWith("ln_reg_")) {
      const parts = data.replace("ln_reg_", "").split("_");
      const productId = parts[0] + "_" + parts[1];
      const osId = parts[2] + "_" + parts[3];
      const regionId = parts.slice(4).join("-"); // ap-south, us-east, etc.
      
      const product = VPS_PRODUCTS[productId];
      const os = OS_OPTIONS[osId];
      const region = REGION_OPTIONS[regionId];
      
      if (!product || !os || !region) {
        return bot.answerCallbackQuery(query.id, { text: "Konfigurasi tidak valid", show_alert: true });
      }

      userSessions.set(userId, { productId, osId, regionId });

      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(
        buildPackageDetail(product, os, region),
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: paymentMethodKeyboard(productId, osId, regionId)
        }
      );
      return;
    }

    // Check saldo
    if (data === "ln_vps_saldo") {
      const saldo = await getSaldo(userId);
      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(
        `💰 *SALDO KAMU*\n` +
        `${"─".repeat(28)}\n\n` +
        `👤 User ID: \`${userId}\`\n` +
        `💵 Saldo  : *${formatRupiah(saldo)}*\n\n` +
        `_Gunakan /deposit untuk isi saldo_`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard()
        }
      );
      return;
    }

    // View history
    if (data === "ln_vps_history") {
      const orders = await getVpsOrdersByUser(userId);
      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(
        buildHistoryMessage(orders),
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard()
        }
      );
      return;
    }

    // Pay with Saldo - Show Invoice
    if (data.startsWith("ln_pay_saldo_")) {
      const parts = data.replace("ln_pay_saldo_", "").split("_");
      const productId = parts[0] + "_" + parts[1];
      const osId = parts[2] + "_" + parts[3];
      const regionId = parts.slice(4).join("-");
      
      const product = VPS_PRODUCTS[productId];
      const os = OS_OPTIONS[osId];
      const region = REGION_OPTIONS[regionId];
      
      if (!product || !os || !region) {
        return bot.answerCallbackQuery(query.id, { text: "Konfigurasi tidak valid", show_alert: true });
      }

      const saldo = await getSaldo(userId);
      const orderId = generateOrderId(userId);

      await saveVpsOrder(orderId, {
        userId,
        chatId,
        productId,
        productName: product.name,
        osId,
        osName: os.name,
        regionId,
        regionName: region.name,
        price: product.price,
        paymentMethod: "saldo",
        status: "pending_payment"
      });

      await saveTransaction({
        orderId,
        userId,
        chatId,
        type: "buy_vps",
        status: "pending",
        amount: product.price,
        paymentMethod: "saldo",
        productId,
        productName: product.name,
        metadata: { 
          provider: "linode", 
          os: os.name, 
          region: region.name,
          specs: { ram: product.ram, cpu: product.cpu, storage: product.storage } 
        }
      });

      userSessions.set(userId, { orderId, productId, osId, regionId, paymentMethod: "saldo" });

      const invoice = buildInvoice({ orderId, paymentMethod: "saldo" }, product, os, region, saldo);
      
      let finalText = invoice;
      if (saldo < product.price) {
        finalText += `\n\n⚠️ *Saldo tidak cukup!*\n_Gunakan /deposit untuk isi saldo_`;
      }

      await bot.answerCallbackQuery(query.id);
      bot.editMessageText(
        finalText,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: invoiceKeyboard(orderId, "saldo")
        }
      );
      return;
    }

    // Confirm pay with saldo
    if (data.startsWith("ln_confirm_saldo_")) {
      const orderId = data.replace("ln_confirm_saldo_", "");
      const order = await getVpsOrder(orderId);

      if (!order) {
        return bot.answerCallbackQuery(query.id, { text: "Order tidak ditemukan", show_alert: true });
      }

      if (order.user_id !== userId) {
        return bot.answerCallbackQuery(query.id, { text: "Bukan order Anda", show_alert: true });
      }

      const product = VPS_PRODUCTS[order.product_id];
      const os = OS_OPTIONS[order.os_id] || { name: order.os_name, icon: "🐧" };
      const region = REGION_OPTIONS[order.region_id] || { name: order.region_name, flag: "🌍" };
      const saldo = await getSaldo(userId);

      if (saldo < product.price) {
        return bot.answerCallbackQuery(query.id, { 
          text: `Saldo tidak cukup! Saldo: ${formatRupiah(saldo)}, Harga: ${formatRupiah(product.price)}`, 
          show_alert: true 
        });
      }

      await bot.answerCallbackQuery(query.id, { text: "Memproses pembayaran..." });

      const newBalance = await deductSaldo(userId, product.price);

      if (newBalance === false) {
        await updateVpsOrder(orderId, { status: "failed" });
        await updateTransactionStatus(orderId, "failed");
        return bot.editMessageText(
          `❌ *PEMBAYARAN GAGAL*\n\nSaldo tidak mencukupi.`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "Markdown",
            reply_markup: afterPaymentKeyboard()
          }
        );
      }

      await updateVpsOrder(orderId, { status: "processing" });
      await updateTransactionStatus(orderId, "processing");

      bot.editMessageText(
        `✅ *PEMBAYARAN BERHASIL!*\n\n` +
        `🔖 Order: \`${orderId}\`\n` +
        `📦 Paket: ${product.name}\n` +
        `${os.icon} OS: ${os.name}\n` +
        `${region.flag} Region: ${region.name}\n` +
        `💰 Total: ${formatRupiah(product.price)}\n` +
        `💵 Sisa Saldo: ${formatRupiah(newBalance)}\n\n` +
        `⏳ Sedang membuat VPS...\n` +
        `_Proses ini membutuhkan 1-2 menit_`,
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [] }
        }
      );

      await processVpsCreation(bot, chatId, orderId, product, os, region);
      return;
    }

    // Pay with QRIS
    if (data.startsWith("ln_pay_qris_")) {
      const parts = data.replace("ln_pay_qris_", "").split("_");
      const productId = parts[0] + "_" + parts[1];
      const osId = parts[2] + "_" + parts[3];
      const regionId = parts.slice(4).join("-");
      
      const product = VPS_PRODUCTS[productId];
      const os = OS_OPTIONS[osId];
      const region = REGION_OPTIONS[regionId];
      
      if (!product || !os || !region) {
        return bot.answerCallbackQuery(query.id, { text: "Konfigurasi tidak valid", show_alert: true });
      }

      await bot.answerCallbackQuery(query.id, { text: "Membuat QRIS..." });

      const orderId = generateOrderId(userId);

      try {
        const result = await createTransaction({
          orderId,
          amount: product.price,
          apiKey: PAKASIR_API_KEY,
          project: PAKASIR_PROJECT
        });

        const payment = result?.payment || result;
        const qrisStr = payment?.payment_number;

        await saveVpsOrder(orderId, {
          userId,
          chatId,
          productId,
          productName: product.name,
          osId,
          osName: os.name,
          regionId,
          regionName: region.name,
          price: product.price,
          paymentMethod: "qris",
          status: "pending_payment"
        });

        await saveTransaction({
          orderId,
          userId,
          chatId,
          type: "buy_vps",
          status: "pending",
          amount: product.price,
          paymentMethod: "qris",
          productId,
          productName: product.name,
          metadata: { 
            provider: "linode", 
            os: os.name, 
            region: region.name,
            specs: { ram: product.ram, cpu: product.cpu, storage: product.storage } 
          },
          expiredAt: payment?.expired_at
        });

        userSessions.set(userId, { orderId, productId, osId, regionId, paymentMethod: "qris", price: product.price });

        const caption = buildQrisInvoice(orderId, product, os, region, payment);

        if (qrisStr) {
          const qrBuf = await makeQrBuffer(qrisStr);
          await bot.deleteMessage(chatId, msgId).catch(() => {});
          
          const sent = await bot.sendPhoto(chatId, qrBuf, {
            caption,
            parse_mode: "Markdown",
            reply_markup: invoiceKeyboard(orderId, "qris")
          });

          startVpsPolling(bot, orderId, chatId, sent.message_id, product, os, region);
        } else {
          bot.editMessageText(
            caption + "\n\n_QRIS tidak tersedia_",
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "Markdown",
              reply_markup: afterPaymentKeyboard()
            }
          );
        }

      } catch (err) {
        console.error("[QRIS Error]:", err);
        bot.editMessageText(
          `❌ *GAGAL MEMBUAT QRIS*\n\n${err?.response?.data?.message || err.message}`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "Markdown",
            reply_markup: mainMenuKeyboard()
          }
        );
      }
      return;
    }

    // Cancel order (saldo)
    if (data.startsWith("ln_cancel_order_")) {
      const orderId = data.replace("ln_cancel_order_", "");
      const order = await getVpsOrder(orderId);

      if (order) {
        await updateVpsOrder(orderId, { status: "cancelled" });
        await updateTransactionStatus(orderId, "cancelled");
      }
      
      userSessions.delete(userId);

      // Delete the invoice message first
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (e) {
        console.warn("Delete message failed:", e.message);
      }

      // Send new cancellation success message
      await bot.answerCallbackQuery(query.id, { text: "Order dibatalkan" });
      const tglCancel1 = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption1 =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : </em>${orderId}\n` +
        `<em>⌯⌲  Tanggal : </em>${tglCancel1}</blockquote>`;
      const cancelMsg1 = await bot.sendMessage(chatId, cancelCaption1, { parse_mode: "HTML" });
      return;
    }

  // Cancel VPS order (QRIS)
  if (data.startsWith("ln_cancel_vps_")) {
    const orderId = data.replace("ln_cancel_vps_", "");
    const order = await getVpsOrder(orderId);
    const session = userSessions.get(userId);
    
    // Stop polling if active
    if (activePolls.has(orderId)) {
      clearInterval(activePolls.get(orderId));
      activePolls.delete(orderId);
    }
    
    // Get amount from order, session, or VPS_PRODUCTS
    let amount = order?.price;
    if (!amount && session?.price) {
      amount = session.price;
    }
    if (!amount && session?.productId && VPS_PRODUCTS[session.productId]) {
      amount = VPS_PRODUCTS[session.productId].price;
    }
    
    console.log(`[CANCEL] orderId=${orderId}, amount=${amount}, session=`, JSON.stringify(session));
    
    // Try to cancel transaction at Pakasir API
    if (amount) {
      try {
        console.log(`[CANCEL] Calling Pakasir cancel API: project=${PAKASIR_PROJECT}, order_id=${orderId}, amount=${amount}`);
        const cancelResult = await cancelTransaction({
          orderId,
          amount,
          apiKey: PAKASIR_API_KEY,
          project: PAKASIR_PROJECT
        });
        console.log(`[CANCEL] Pakasir response:`, JSON.stringify(cancelResult));
      } catch (e) {
        console.error("[CANCEL] Pakasir API error:", e?.response?.status, e?.response?.data || e.message);
      }
    } else {
      console.warn("[CANCEL] No amount found, skipping Pakasir cancel");
    }
    
    // Update database if order exists
    if (order) {
      await updateVpsOrder(orderId, { status: "cancelled" });
      await updateTransactionStatus(orderId, "cancelled");
    }
    
    userSessions.delete(userId);
    
    // Delete the QR message first
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch (e) {
      console.warn("Delete message failed:", e.message);
    }
    
    // Send new cancellation success message
    await bot.answerCallbackQuery(query.id, { text: "Order dibatalkan" });
    const tglCancel2 = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const cancelCaption2 =
      `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
      `<em>⌯⌲ Order ID : ${orderId}</em>\n` +
      `<em>⌯⌲  Tanggal : ${tglCancel2}</em></blockquote>`;
    const cancelMsg2 = await bot.sendMessage(chatId, cancelCaption2, { parse_mode: "HTML" });
    return;
  }

    // Check VPS payment status
    if (data.startsWith("ln_cek_vps_")) {
      const orderId = data.replace("ln_cek_vps_", "");
      const order = await getVpsOrder(orderId);

      if (!order) {
        return bot.answerCallbackQuery(query.id, { text: "Order tidak ditemukan" });
      }

      if (order.user_id !== userId) {
        return bot.answerCallbackQuery(query.id, { text: "Bukan order Anda", show_alert: true });
      }

      await bot.answerCallbackQuery(query.id, { text: "Mengecek pembayaran..." });

      try {
        const result = await checkTransaction({
          orderId,
          amount: order.price,
          apiKey: PAKASIR_API_KEY,
          project: PAKASIR_PROJECT
        });

        const trx = result?.transaction;
        const status = trx?.status || "pending";

        if (status === "completed") {
          if (activePolls.has(orderId)) {
            clearInterval(activePolls.get(orderId));
            activePolls.delete(orderId);
          }

          const product = VPS_PRODUCTS[order.product_id];
          const os = OS_OPTIONS[order.os_id] || { name: order.os_name, icon: "🐧" };
          const region = REGION_OPTIONS[order.region_id] || { name: order.region_name, flag: "🌍" };

          await updateVpsOrder(orderId, { status: "processing" });
          await updateTransactionStatus(orderId, "processing");

          bot.editMessageCaption(
            `✅ *PEMBAYARAN DITERIMA!*\n\n` +
            `🔖 Order: \`${orderId}\`\n` +
            `📦 Paket: ${product.name}\n` +
            `${os.icon} OS: ${os.name}\n` +
            `${region.flag} Region: ${region.name}\n\n` +
            `⏳ Sedang membuat VPS...\n` +
            `_Proses ini membutuhkan 1-2 menit_`,
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [] }
            }
          ).catch(() => {});

          await processVpsCreation(bot, chatId, orderId, product, os, region);
        } else {
          bot.answerCallbackQuery(query.id, { text: `Status: ${status}` });
        }

      } catch (err) {
        bot.answerCallbackQuery(query.id, {
          text: "❌ " + (err?.response?.data?.message || err.message),
          show_alert: true
        });
      }
      return;
    }
  });
};
