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
const DO_API_TOKEN = config.apidigital || "ISI_DO_TOKEN_ANDA";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const activePolls = new Map();

// ===== TIER DEFINITIONS =====
// Kategori berdasarkan RAM
const TIER_CONFIG = {
  low: {
    label: "🟢 LOW VPS",
    // Garansi & info untuk display katalog
    garansi: "15 Hari",
    garansiSuspend: "10Jam",
    replace: "0x",
    hargaMulai: "Rp2.800",
    // Filter: droplet sizes dgn RAM <= 1024 MB (1GB)
    maxRamMb: 1024,
    minRamMb: 0
  },
  medium: {
    label: "🟡 MEDIUM VPS",
    garansi: "25 Hari",
    garansiSuspend: "24Jam",
    replace: "1x",
    hargaMulai: "Rp5.000",
    // Filter: RAM > 1GB dan <= 4096 MB (4GB)
    maxRamMb: 4096,
    minRamMb: 1025
  },
  high: {
    label: "🔴 HIGH VPS",
    garansi: "30 Hari",
    garansiSuspend: "-",
    replace: "Unlimited",
    hargaMulai: "Rp15.000",
    // Filter: RAM > 4GB
    maxRamMb: Infinity,
    minRamMb: 4097
  }
};

// ===== OS OPTIONS =====
const OS_OPTIONS = {
  "ubuntu24": { name: "Ubuntu 24.04 LTS", image: "ubuntu-24-04-x64", icon: "U" },
  "ubuntu22": { name: "Ubuntu 22.04 LTS", image: "ubuntu-22-04-x64", icon: "U" },
  "ubuntu20": { name: "Ubuntu 20.04 LTS", image: "ubuntu-20-04-x64", icon: "U" },
  "debian12": { name: "Debian 12", image: "debian-12-x64", icon: "D" },
  "debian11": { name: "Debian 11", image: "debian-11-x64", icon: "D" },
  "centos9": { name: "CentOS Stream 9", image: "centos-stream-9-x64", icon: "C" },
  "alma9": { name: "AlmaLinux 9", image: "almalinux-9-x64", icon: "A" },
  "rocky9": { name: "Rocky Linux 9", image: "rockylinux-9-x64", icon: "R" },
  "fedora40": { name: "Fedora 40", image: "fedora-40-x64", icon: "F" }
};

// ===== REGION OPTIONS (DigitalOcean) =====
const REGION_OPTIONS = {
  "sgp1": { name: "Singapore 1", flag: "SG", country: "Singapore" },
  "nyc1": { name: "New York 1", flag: "US", country: "USA" },
  "nyc3": { name: "New York 3", flag: "US", country: "USA" },
  "sfo3": { name: "San Francisco 3", flag: "US", country: "USA" },
  "ams3": { name: "Amsterdam 3", flag: "NL", country: "Netherlands" },
  "lon1": { name: "London 1", flag: "GB", country: "UK" },
  "fra1": { name: "Frankfurt 1", flag: "DE", country: "Germany" },
  "tor1": { name: "Toronto 1", flag: "CA", country: "Canada" },
  "blr1": { name: "Bangalore 1", flag: "IN", country: "India" },
  "syd1": { name: "Sydney 1", flag: "AU", country: "Australia" }
};

// ===== HARGA MAPPING (Rp per bulan per tier) =====
// Karena DO API tidak kasih harga IDR, kita tetap pakai harga manual per size slug
// Tapi size list diambil live dari DO API untuk validasi stok
const PRICE_MAP = {
  "s-1vcpu-1gb":    30000,
  "s-1vcpu-2gb":    60000,
  "s-2vcpu-2gb":    90000,
  "s-2vcpu-4gb":   120000,
  "s-4vcpu-8gb":   240000,
  "s-8vcpu-16gb":  480000,
  "s-8vcpu-32gb":  960000,
  "s-6vcpu-16gb":  480000,
  "c-2":            80000,
  "c-4":           160000,
  "c-8":           320000,
  "g-2vcpu-8gb":   250000,
  "g-4vcpu-16gb":  500000,
  "gd-2vcpu-8gb":  270000,
  "gd-4vcpu-16gb": 540000,
  "m-2vcpu-16gb":  350000,
  "m-4vcpu-32gb":  700000
};

// Cache DO sizes agar tidak fetch ulang setiap saat
let doSizesCache = null;
let doSizesCacheTime = 0;
const DO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

// ===== FETCH LIVE SIZES FROM DO API =====
async function fetchDOSizes() {
  const now = Date.now();
  if (doSizesCache && (now - doSizesCacheTime) < DO_CACHE_TTL_MS) {
    return doSizesCache;
  }

  const response = await fetch("https://api.digitalocean.com/v2/sizes?per_page=200", {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DO_API_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(`DO API error: ${response.status}`);
  }

  const data = await response.json();
  const sizes = (data.sizes || []).filter(s => s.available === true);

  doSizesCache = sizes;
  doSizesCacheTime = now;
  return sizes;
}

// Filter sizes berdasarkan tier
function getSizesByTier(sizes, tier) {
  const cfg = TIER_CONFIG[tier];
  if (!cfg) return [];
  return sizes.filter(s => s.memory >= cfg.minRamMb && s.memory <= cfg.maxRamMb);
}

// Konversi DO size object → VPS product object
function sizeToProduct(size) {
  const price = PRICE_MAP[size.slug] || Math.round(size.price_monthly * 15000); // fallback: USD * 15000
  return {
    name: `DO ${size.memory >= 1024 ? (size.memory / 1024) + "GB" : size.memory + "MB"} RAM / ${size.vcpus} vCPU`,
    ram: size.memory >= 1024 ? `${size.memory / 1024}GB` : `${size.memory}MB`,
    cpu: `${size.vcpus} vCPU`,
    storage: `${size.disk}GB SSD`,
    bandwidth: `${size.transfer}TB`,
    price: price,
    size: size.slug
  };
}

function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function generateOrderId(userId) {
  return `DO${userId}${Date.now()}`;
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
    provider: "digitalocean",
    label: data.label || null,
    droplet_id: data.dropletId || null,
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
    .eq("provider", "digitalocean")
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
    description: "Pembelian VPS DigitalOcean"
  });

  return newBalance;
}

// ===== CREATE DIGITALOCEAN DROPLET =====
async function createDroplet(product, osImage, region, label) {
  const password = generateRandomPassword();
  
  const dropletData = {
    name: label,
    region: region,
    size: product.size,
    image: osImage,
    ssh_keys: null,
    backups: false,
    ipv6: true,
    user_data: `#cloud-config\npassword: ${password}\nchpasswd: { expire: False }`,
    private_networking: null,
    volumes: null,
    tags: ["telegram-bot"]
  };

  const response = await fetch("https://api.digitalocean.com/v2/droplets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DO_API_TOKEN}`
    },
    body: JSON.stringify(dropletData)
  });

  const responseData = await response.json();

  if (!response.ok) {
    throw new Error(responseData.message || "Gagal membuat Droplet");
  }

  return {
    dropletId: responseData.droplet.id,
    rootPassword: password
  };
}

async function getDropletInfo(dropletId) {
  const response = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DO_API_TOKEN}`
    }
  });

  const data = await response.json();
  return {
    ipAddress: data.droplet?.networks?.v4?.[0]?.ip_address || "Pending...",
    status: data.droplet?.status
  };
}

// ===== KEYBOARD BUILDERS =====

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Beli VPS DigitalOcean", callback_data: "do_start" }],
      [{ text: "Riwayat Transaksi", callback_data: "do_history" }],
      [{ text: "Cek Saldo", callback_data: "do_saldo" }]
    ]
  };
}

// Step 0: Katalog dengan 3 tier (LOW / MEDIUM / HIGH)
function catalogKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟢 LOW", callback_data: "buyvps_pkg:low" }],
      [{ text: "🟡 MEDIUM", callback_data: "buyvps_pkg:medium" }],
      [{ text: "🔴 HIGH", callback_data: "buyvps_pkg:high" }],
      [{ text: "🔙 Kembali", callback_data: "do_back_home" }]
    ]
  };
}

// Step 1: Pilih size dari tier yang dipilih (dibangun dinamis)
function sizeListKeyboard(tier, sizes) {
  const rows = sizes.slice(0, 10).map(s => {
    const product = sizeToProduct(s);
    const slugSafe = s.slug.replace(/:/g, "_"); // aman di callback_data
    return [{ 
      text: `${product.ram} / ${product.cpu} — ${formatRupiah(product.price)}/bln`,
      callback_data: `do_size:${tier}:${slugSafe}`
    }];
  });
  rows.push([{ text: "<< Kembali ke Katalog", callback_data: "do_start" }]);
  return { inline_keyboard: rows };
}

// Step 2: Pilih Region
function regionListKeyboard(tier, sizeSlug) {
  return {
    inline_keyboard: [
      [
        { text: "Singapore", callback_data: `do_reg:${tier}:${sizeSlug}:sgp1` },
        { text: "New York 1", callback_data: `do_reg:${tier}:${sizeSlug}:nyc1` }
      ],
      [
        { text: "New York 3", callback_data: `do_reg:${tier}:${sizeSlug}:nyc3` },
        { text: "San Francisco", callback_data: `do_reg:${tier}:${sizeSlug}:sfo3` }
      ],
      [
        { text: "Amsterdam", callback_data: `do_reg:${tier}:${sizeSlug}:ams3` },
        { text: "London", callback_data: `do_reg:${tier}:${sizeSlug}:lon1` }
      ],
      [
        { text: "Frankfurt", callback_data: `do_reg:${tier}:${sizeSlug}:fra1` },
        { text: "Toronto", callback_data: `do_reg:${tier}:${sizeSlug}:tor1` }
      ],
      [
        { text: "Bangalore", callback_data: `do_reg:${tier}:${sizeSlug}:blr1` },
        { text: "Sydney", callback_data: `do_reg:${tier}:${sizeSlug}:syd1` }
      ],
      [{ text: "<< Kembali Pilih Paket", callback_data: `buyvps_pkg:${tier}` }]
    ]
  };
}

// Step 3: Pilih OS
function osListKeyboard(tier, sizeSlug, regionId) {
  return {
    inline_keyboard: [
      [
        { text: "Ubuntu 24.04", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:ubuntu24` },
        { text: "Ubuntu 22.04", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:ubuntu22` }
      ],
      [
        { text: "Ubuntu 20.04", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:ubuntu20` },
        { text: "Debian 12", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:debian12` }
      ],
      [
        { text: "Debian 11", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:debian11` },
        { text: "CentOS Stream 9", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:centos9` }
      ],
      [
        { text: "AlmaLinux 9", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:alma9` },
        { text: "Rocky Linux 9", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:rocky9` }
      ],
      [{ text: "Fedora 40", callback_data: `do_os:${tier}:${sizeSlug}:${regionId}:fedora40` }],
      [{ text: "<< Kembali Pilih Region", callback_data: `do_size:${tier}:${sizeSlug}` }]
    ]
  };
}

// Step 4: Invoice
function invoiceKeyboard(tier, sizeSlug, regionId, osId) {
  return {
    inline_keyboard: [
      [{ text: "Bayar dengan QRIS", callback_data: `do_pay_qris:${tier}:${sizeSlug}:${regionId}:${osId}` }],
      [{ text: "<< Kembali Pilih OS", callback_data: `do_reg:${tier}:${sizeSlug}:${regionId}` }],
      [{ text: "<< Kembali ke Menu", callback_data: "do_back_home" }]
    ]
  };
}

function qrisPaymentKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "Cek Pembayaran", callback_data: `do_cek:${orderId}` }],
      [{ text: "Batalkan", callback_data: `do_cancel:${orderId}` }],
      [{ text: "<< Kembali ke Menu", callback_data: "do_back_home" }]
    ]
  };
}

function afterPaymentKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Beli VPS Lagi", callback_data: "do_start" }],
      [{ text: "Lihat Riwayat", callback_data: "do_history" }],
      [{ text: "<< Kembali ke Menu", callback_data: "do_back_home" }]
    ]
  };
}

// ===== MESSAGE BUILDERS =====

// Teks katalog utama (seperti UI yang diminta)
function buildCatalogText(stockInfo) {
  const sep = "━━━━━━━━━━━━━━━━━━━━━━";
  const low = TIER_CONFIG.low;
  const med = TIER_CONFIG.medium;
  const high = TIER_CONFIG.high;

  const stockLine = stockInfo
    ? `📦 <b>STOK TERSEDIA:</b> ${stockInfo.low} LOW | ${stockInfo.medium} MEDIUM | ${stockInfo.high} HIGH`
    : `📦 <b>STOK:</b> Sedang mengecek...`;

  return (
    `<b>🛒 KATALOG VPS DIGITALOCEAN</b>\n` +
    `${sep}\n` +
    `${stockLine}\n` +
    `⚙️ <b>Pilih tipe VPS sesuai kebutuhan Anda:</b>\n\n` +
    `${sep}\n` +
    `🟢 <b>LOW VPS</b>\n` +
    `▪ Garansi: <b>${low.garansi}</b>\n` +
    `▪ Garansi Do Suspend: <b>${low.garansiSuspend}</b>\n` +
    `▪ Replace: <b>${low.replace}</b>\n` +
    `▪ Harga mulai: <b>${low.hargaMulai}</b>\n` +
    `${sep}\n` +
    `🟡 <b>MEDIUM VPS</b>\n` +
    `▪ Garansi: <b>${med.garansi}</b>\n` +
    `▪ Garansi Do Suspend: <b>${med.garansiSuspend}</b>\n` +
    `▪ Replace: <b>${med.replace}</b>\n` +
    `▪ Harga mulai: <b>${med.hargaMulai}</b>\n` +
    `${sep}\n` +
    `🔴 <b>HIGH VPS</b>\n` +
    `▪ Garansi: <b>${high.garansi}</b>\n` +
    `▪ Replace: <b>${high.replace}</b>\n` +
    `▪ Harga mulai: <b>${high.hargaMulai}</b>\n` +
    `${sep}\n\n` +
    `✨ <b>Silakan pilih kategori VPS:</b>`
  );
}

function buildInvoice(product, os, region, saldo) {
  const sep = "-".repeat(28);
  const timestamp = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  
  return `INVOICE VPS DIGITALOCEAN\n` +
    `${sep}\n\n` +
    `Tanggal : ${timestamp}\n\n` +
    `${sep}\n` +
    `DETAIL PRODUK\n` +
    `${sep}\n\n` +
    `Paket    : ${product.name}\n` +
    `RAM      : ${product.ram}\n` +
    `CPU      : ${product.cpu}\n` +
    `Storage  : ${product.storage}\n` +
    `Bandwidth: ${product.bandwidth}\n` +
    `OS       : ${os.name}\n` +
    `Region   : ${region.name}\n\n` +
    `${sep}\n` +
    `PEMBAYARAN\n` +
    `${sep}\n\n` +
    `Harga       : ${formatRupiah(product.price)}\n` +
    `Saldo Anda  : ${formatRupiah(saldo)}\n\n` +
    `${sep}\n` +
    `TOTAL: ${formatRupiah(product.price)}\n` +
    `${sep}\n\n` +
    `Pilih metode pembayaran:`;
}

function buildQrisInvoice(orderId, product, os, region, qrisData) {
  const sep = "-".repeat(28);
  const expStr = qrisData.expired_at
    ? new Date(qrisData.expired_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })
    : "-";

  return `INVOICE VPS DO - QRIS\n` +
    `${sep}\n\n` +
    `Order ID: ${orderId}\n` +
    `Paket   : ${product.name}\n` +
    `OS      : ${os.name}\n` +
    `Region  : ${region.name}\n\n` +
    `Total   : ${formatRupiah(qrisData.total_payment || product.price)}\n` +
    `Fee     : ${formatRupiah(qrisData.fee || 0)}\n` +
    `Expired : ${expStr}\n\n` +
    `${sep}\n` +
    `Scan QRIS untuk bayar\n` +
    `Menunggu pembayaran...\n` +
    `Bot cek otomatis tiap 5 detik`;
}

function buildVpsCreatedMessage(order, vpsInfo) {
  const sep = "-".repeat(28);
  return `VPS DIGITALOCEAN BERHASIL DIBUAT!\n` +
    `${sep}\n\n` +
    `Order ID : ${order.order_id}\n` +
    `Paket    : ${order.product_name}\n` +
    `OS       : ${order.os_name || "-"}\n` +
    `Region   : ${order.region_name || "-"}\n\n` +
    `${sep}\n` +
    `DETAIL VPS\n` +
    `${sep}\n\n` +
    `Droplet ID: ${order.droplet_id}\n` +
    `IP Address: ${vpsInfo.ipAddress}\n` +
    `Password  : ${order.root_password}\n` +
    `Username  : root\n\n` +
    `${sep}\n` +
    `Cara Akses:\n` +
    `ssh root@${vpsInfo.ipAddress}\n` +
    `${sep}\n\n` +
    `Simpan password dengan aman!`;
}

function buildHistoryMessage(orders) {
  if (!orders.length) {
    return "RIWAYAT VPS DIGITALOCEAN\n\nBelum ada transaksi VPS.";
  }

  const sep = "-".repeat(28);
  let text = `RIWAYAT VPS DIGITALOCEAN\n${sep}\n\n`;

  orders.forEach((order, idx) => {
    const date = new Date(order.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    const statusText = {
      "pending_payment": "[Pending]",
      "processing": "[Processing]",
      "provisioning": "[Provisioning]",
      "completed": "[Completed]",
      "cancelled": "[Cancelled]",
      "expired": "[Expired]",
      "failed": "[Failed]"
    }[order.status] || "[Unknown]";

    text += `${idx + 1}. ${statusText} ${order.product_name}\n`;
    text += `   ${order.os_name || "-"} | ${order.region_name || "-"}\n`;
    text += `   ${date}\n`;
    text += `   ${formatRupiah(order.price)}\n`;
    text += `   ${order.order_id}\n`;
    if (order.ip_address) {
      text += `   IP: ${order.ip_address}\n`;
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
        `PEMBAYARAN KEDALUWARSA\n\nOrder: ${orderId}\n\nGunakan /buyvpsdo untuk order baru.`,
        {
          chat_id: chatId,
          message_id: msgId,
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
          `PEMBAYARAN DITERIMA!\n\n` +
          `Order: ${orderId}\n` +
          `Paket: ${product.name}\n` +
          `OS: ${os.name}\n` +
          `Region: ${region.name}\n\n` +
          `Sedang membuat VPS...\n` +
          `Proses ini membutuhkan 1-2 menit`,
          {
            chat_id: chatId,
            message_id: msgId,
            reply_markup: { inline_keyboard: [] }
          }
        ).catch(() => {});

        await processVpsCreation(bot, chatId, orderId, product, os, region);
      }
    } catch (err) {
      console.warn(`[DO VPS POLL] ${orderId}:`, err?.response?.data || err.message);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(orderId, intervalId);
}

async function processVpsCreation(bot, chatId, orderId, product, os, region) {
  try {
    const label = `vps-${orderId.slice(-8)}`;
    
    const { dropletId, rootPassword } = await createDroplet(product, os.image, region.id, label);

    await updateVpsOrder(orderId, {
      droplet_id: dropletId,
      root_password: rootPassword,
      label: label,
      status: "provisioning"
    });

    // Wait for droplet to be ready
    await new Promise(resolve => setTimeout(resolve, 60000));

    const vpsInfo = await getDropletInfo(dropletId);

    await updateVpsOrder(orderId, {
      ip_address: vpsInfo.ipAddress,
      status: "completed",
      completed_at: new Date().toISOString()
    });

    await updateTransactionStatus(orderId, "completed", {
      metadata: { ip_address: vpsInfo.ipAddress, droplet_id: dropletId }
    });

    const order = await getVpsOrder(orderId);
    const message = buildVpsCreatedMessage(order, vpsInfo);

    bot.sendMessage(chatId, message, {
      reply_markup: afterPaymentKeyboard()
    });

  } catch (err) {
    console.error(`[DO VPS CREATE] Error:`, err);
    await updateVpsOrder(orderId, { status: "failed" });
    await updateTransactionStatus(orderId, "failed");
    bot.sendMessage(chatId,
      `GAGAL MEMBUAT VPS\n\n` +
      `Order: ${orderId}\n` +
      `Error: ${err.message}\n\n` +
      `Silakan hubungi admin.`,
      { reply_markup: afterPaymentKeyboard() }
    );
  }
}

// ===== MODULE EXPORT =====
module.exports = function (bot) {

  // /buyvpsdo - Main command
  const sendDOMenu = async (chatId) => {
    // Fetch live stock info
    let stockInfo = null;
    try {
      const sizes = await fetchDOSizes();
      stockInfo = {
        low: getSizesByTier(sizes, "low").length,
        medium: getSizesByTier(sizes, "medium").length,
        high: getSizesByTier(sizes, "high").length
      };
    } catch (err) {
      console.warn("[DO] Gagal fetch sizes:", err.message);
    }

    const text = buildCatalogText(stockInfo);
    bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: catalogKeyboard()
    });
  };

  bot.onText(/\/buyvpsdo/, async (msg) => {
    if (await blockIfDisabled(bot, "buy_vps", msg.chat.id)) return;
    sendDOMenu(msg.chat.id);
  });

  // /vpsdohistory - History command
  bot.onText(/\/vpsdohistory/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const orders = await getVpsOrdersByUser(userId);
    const text = buildHistoryMessage(orders);
    
    bot.sendMessage(chatId, text, {
      reply_markup: afterPaymentKeyboard()
    });
  });

  // ===== CALLBACK QUERY HANDLER =====
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const userId = query.from.id;
    const data = query.data;

    // Filter DigitalOcean + katalog callbacks
    const isDO = data.startsWith("do_") || data.startsWith("buyvps_pkg:");
    if (!isDO) return;

    if (await blockCallbackIfDisabled(bot, "buy_vps", query)) return;

    // ── Entry point via callback (dari menu /buyvps) ──────────────────
    if (data === "do_buyvpsdo") {
      await bot.answerCallbackQuery(query.id);
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (_) {}

      let stockInfo = null;
      try {
        const sizes = await fetchDOSizes();
        stockInfo = {
          low: getSizesByTier(sizes, "low").length,
          medium: getSizesByTier(sizes, "medium").length,
          high: getSizesByTier(sizes, "high").length
        };
      } catch (_) {}

      return bot.sendMessage(chatId, buildCatalogText(stockInfo), {
        parse_mode: "HTML",
        reply_markup: catalogKeyboard()
      });
    }

    // ── Back to Home (katalog) ─────────────────────────────────────────
    if (data === "do_back_home" || data === "do_start") {
      await bot.answerCallbackQuery(query.id);

      let stockInfo = null;
      try {
        const sizes = await fetchDOSizes();
        stockInfo = {
          low: getSizesByTier(sizes, "low").length,
          medium: getSizesByTier(sizes, "medium").length,
          high: getSizesByTier(sizes, "high").length
        };
      } catch (_) {}

      // Coba edit, kalau gagal (pesan foto) kirim baru
      const edited = await bot.editMessageText(buildCatalogText(stockInfo), {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
        reply_markup: catalogKeyboard()
      }).catch(() => null);

      if (!edited) {
        return bot.sendMessage(chatId, buildCatalogText(stockInfo), {
          parse_mode: "HTML",
          reply_markup: catalogKeyboard()
        });
      }
      return;
    }

    // ── Step 0: Pilih Tier (buyvps_pkg:low/medium/high) ───────────────
    const tierMatch = data.match(/^buyvps_pkg:(low|medium|high)$/);
    if (tierMatch) {
      const tier = tierMatch[1];
      await bot.answerCallbackQuery(query.id);

      let sizes = [];
      try {
        const allSizes = await fetchDOSizes();
        sizes = getSizesByTier(allSizes, tier);
      } catch (err) {
        return bot.answerCallbackQuery(query.id, {
          text: `Gagal fetch stok DO: ${err.message}`,
          show_alert: true
        });
      }

      if (!sizes.length) {
        return bot.answerCallbackQuery(query.id, {
          text: "Tidak ada stok tersedia untuk tier ini saat ini.",
          show_alert: true
        });
      }

      const tierInfo = TIER_CONFIG[tier];
      const tierText =
        `${tierInfo.label}\n` +
        `${"─".repeat(26)}\n\n` +
        `✅ Stok Tersedia: ${sizes.length} paket (live dari DO API)\n\n` +
        `▪ Garansi: <b>${tierInfo.garansi}</b>\n` +
        (tierInfo.garansiSuspend !== "-" ? `▪ Garansi Suspend: <b>${tierInfo.garansiSuspend}</b>\n` : "") +
        `▪ Replace: <b>${tierInfo.replace}</b>\n\n` +
        `Pilih spesifikasi VPS:`;

      return bot.editMessageText(tierText, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
        reply_markup: sizeListKeyboard(tier, sizes)
      }).catch(() => {});
    }

    // ── Step 1: Pilih Region (setelah pilih size) ────────────────────
    const sizeMatch = data.match(/^do_size:(low|medium|high):(.+)$/);
    if (sizeMatch) {
      const tier = sizeMatch[1];
      const sizeSlug = sizeMatch[2].replace(/_/g, "-"); // restore slug

      // Ambil product info dari DO API
      let product = null;
      try {
        const allSizes = await fetchDOSizes();
        const sizeObj = allSizes.find(s => s.slug === sizeSlug);
        if (!sizeObj) {
          return bot.answerCallbackQuery(query.id, { text: "Size tidak ditemukan!", show_alert: true });
        }
        product = sizeToProduct(sizeObj);
      } catch (err) {
        return bot.answerCallbackQuery(query.id, { text: "Gagal fetch stok!", show_alert: true });
      }

      await bot.answerCallbackQuery(query.id);
      const slugSafe = sizeSlug.replace(/:/g, "_");
      return bot.editMessageText(
        `PILIH REGION/NEGARA\n` +
        `${"─".repeat(26)}\n\n` +
        `Paket: ${product.name}\n` +
        `Harga: ${formatRupiah(product.price)}/bln\n\n` +
        `Pilih lokasi server:`,
        {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: regionListKeyboard(tier, slugSafe)
        }
      ).catch(() => {});
    }

    // ── Step 2: Pilih OS (setelah pilih region) ───────────────────────
    const regMatch = data.match(/^do_reg:(low|medium|high):([^:]+):(.+)$/);
    if (regMatch) {
      const tier = regMatch[1];
      const sizeSlug = regMatch[2].replace(/_/g, "-");
      const regionId = regMatch[3];

      const region = REGION_OPTIONS[regionId];
      if (!region) {
        return bot.answerCallbackQuery(query.id, { text: "Region tidak valid!", show_alert: true });
      }

      let product = null;
      try {
        const allSizes = await fetchDOSizes();
        const sizeObj = allSizes.find(s => s.slug === sizeSlug);
        if (!sizeObj) return bot.answerCallbackQuery(query.id, { text: "Size tidak ditemukan!", show_alert: true });
        product = sizeToProduct(sizeObj);
      } catch (_) {
        return bot.answerCallbackQuery(query.id, { text: "Gagal fetch stok!", show_alert: true });
      }

      await bot.answerCallbackQuery(query.id);
      const slugSafe = sizeSlug.replace(/:/g, "_");
      return bot.editMessageText(
        `PILIH SISTEM OPERASI\n` +
        `${"─".repeat(26)}\n\n` +
        `Paket: ${product.name}\n` +
        `Region: ${region.name}\n\n` +
        `Pilih OS untuk VPS kamu:`,
        {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: osListKeyboard(tier, slugSafe, regionId)
        }
      ).catch(() => {});
    }

    // ── Step 3: Invoice (setelah pilih OS) ───────────────────────────
    const osMatch = data.match(/^do_os:(low|medium|high):([^:]+):([^:]+):(.+)$/);
    if (osMatch) {
      const tier = osMatch[1];
      const sizeSlug = osMatch[2].replace(/_/g, "-");
      const regionId = osMatch[3];
      const osId = osMatch[4];

      const os = OS_OPTIONS[osId];
      const region = REGION_OPTIONS[regionId];
      if (!os || !region) {
        return bot.answerCallbackQuery(query.id, { text: "Pilihan tidak valid!", show_alert: true });
      }

      let product = null;
      try {
        const allSizes = await fetchDOSizes();
        const sizeObj = allSizes.find(s => s.slug === sizeSlug);
        if (!sizeObj) return bot.answerCallbackQuery(query.id, { text: "Size tidak ditemukan!", show_alert: true });
        product = sizeToProduct(sizeObj);
      } catch (_) {
        return bot.answerCallbackQuery(query.id, { text: "Gagal fetch stok!", show_alert: true });
      }

      await bot.answerCallbackQuery(query.id);
      const saldo = await getSaldo(userId);
      const invoice = buildInvoice(product, os, region, saldo);
      const slugSafe = sizeSlug.replace(/:/g, "_");

      return bot.editMessageText(invoice, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: invoiceKeyboard(tier, slugSafe, regionId, osId)
      }).catch(() => {});
    }

    // ── Pay with Saldo ────────────────────────────────────────────────
    const saldoPayMatch = data.match(/^do_pay_saldo:(low|medium|high):([^:]+):([^:]+):(.+)$/);
    if (saldoPayMatch) {
      const tier = saldoPayMatch[1];
      const sizeSlug = saldoPayMatch[2].replace(/_/g, "-");
      const regionId = saldoPayMatch[3];
      const osId = saldoPayMatch[4];

      const os = OS_OPTIONS[osId];
      const region = REGION_OPTIONS[regionId];
      if (!os || !region) {
        return bot.answerCallbackQuery(query.id, { text: "Pilihan tidak valid!", show_alert: true });
      }

      let product = null;
      try {
        const allSizes = await fetchDOSizes();
        const sizeObj = allSizes.find(s => s.slug === sizeSlug);
        if (!sizeObj) return bot.answerCallbackQuery(query.id, { text: "Size tidak ditemukan!", show_alert: true });
        product = sizeToProduct(sizeObj);
      } catch (_) {
        return bot.answerCallbackQuery(query.id, { text: "Gagal fetch stok!", show_alert: true });
      }

      const saldo = await getSaldo(userId);
      if (saldo < product.price) {
        return bot.answerCallbackQuery(query.id, {
          text: `Saldo tidak cukup! Saldo: ${formatRupiah(saldo)}, Harga: ${formatRupiah(product.price)}`,
          show_alert: true
        });
      }

      const orderId = generateOrderId(userId);
      const productId = sizeSlug;

      await saveVpsOrder(orderId, {
        userId, chatId,
        productId, productName: product.name,
        osId, osName: os.name,
        regionId, regionName: region.name,
        price: product.price,
        paymentMethod: "saldo",
        status: "processing"
      });

      const newBalance = await deductSaldo(userId, product.price);

      await saveTransaction({
        orderId,
        userId: String(userId), chatId,
        type: "vps_purchase",
        amount: product.price,
        paymentMethod: "saldo",
        status: "processing",
        productId, productName: product.name,
        metadata: { provider: "digitalocean", tier, regionId, osId }
      });

      await bot.editMessageText(
        `PEMBAYARAN BERHASIL!\n\n` +
        `Order: ${orderId}\n` +
        `Paket: ${product.name}\n` +
        `OS: ${os.name}\n` +
        `Region: ${region.name}\n` +
        `Sisa Saldo: ${formatRupiah(newBalance)}\n\n` +
        `Sedang membuat VPS...\n` +
        `Proses ini membutuhkan 1-2 menit`,
        {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: { inline_keyboard: [] }
        }
      );

      await processVpsCreation(bot, chatId, orderId, product, os, { ...region, id: regionId });
      return;
    }

    // ── Pay with QRIS ─────────────────────────────────────────────────
    const qrisPayMatch = data.match(/^do_pay_qris:(low|medium|high):([^:]+):([^:]+):(.+)$/);
    if (qrisPayMatch) {
      const tier = qrisPayMatch[1];
      const sizeSlug = qrisPayMatch[2].replace(/_/g, "-");
      const regionId = qrisPayMatch[3];
      const osId = qrisPayMatch[4];

      const os = OS_OPTIONS[osId];
      const region = REGION_OPTIONS[regionId];
      if (!os || !region) {
        return bot.answerCallbackQuery(query.id, { text: "Pilihan tidak valid!", show_alert: true });
      }

      let product = null;
      try {
        const allSizes = await fetchDOSizes();
        const sizeObj = allSizes.find(s => s.slug === sizeSlug);
        if (!sizeObj) return bot.answerCallbackQuery(query.id, { text: "Size tidak ditemukan!", show_alert: true });
        product = sizeToProduct(sizeObj);
      } catch (_) {
        return bot.answerCallbackQuery(query.id, { text: "Gagal fetch stok!", show_alert: true });
      }

      const orderId = generateOrderId(userId);
      const productId = sizeSlug;

      try {
        await saveVpsOrder(orderId, {
          userId, chatId,
          productId, productName: product.name,
          osId, osName: os.name,
          regionId, regionName: region.name,
          price: product.price,
          paymentMethod: "qris",
          status: "pending_payment"
        });

        const trxResult = await createTransaction({
          orderId,
          amount: product.price,
          apiKey: PAKASIR_API_KEY,
          project: PAKASIR_PROJECT
        });

        const payment = trxResult?.payment || trxResult;
        const qrisStr = payment?.payment_number;

        if (!qrisStr) {
          return bot.answerCallbackQuery(query.id, { text: "QRIS tidak tersedia!", show_alert: true });
        }

        await saveTransaction({
          orderId,
          userId: String(userId), chatId,
          type: "vps_purchase",
          amount: product.price,
          fee: payment?.fee || 0,
          totalPayment: payment?.total_payment || product.price,
          paymentMethod: "qris",
          status: "pending",
          productId, productName: product.name,
          expiredAt: payment?.expired_at || null,
          metadata: { provider: "digitalocean", tier, regionId, osId }
        });

        const qrBuffer = await makeQrBuffer(qrisStr);
        const caption = buildQrisInvoice(orderId, product, os, region, payment);

        await bot.deleteMessage(chatId, msgId).catch(() => {});
        const sentMsg = await bot.sendPhoto(chatId, qrBuffer, {
          caption,
          reply_markup: qrisPaymentKeyboard(orderId)
        });

        startVpsPolling(bot, orderId, chatId, sentMsg.message_id, product, os, { ...region, id: regionId });

      } catch (err) {
        console.error("[DO QRIS CREATE]", err);
        bot.answerCallbackQuery(query.id, { text: "Gagal membuat transaksi QRIS!", show_alert: true });
      }
      return;
    }

    // ── Cancel Order ──────────────────────────────────────────────────
    const cancelMatch = data.match(/^do_cancel:(.+)$/);
    if (cancelMatch) {
      const orderId = cancelMatch[1];
      const order = await getVpsOrder(orderId);
      const amount = order?.price || 0;

      await updateVpsOrder(orderId, { status: "cancelled" });
      await updateTransactionStatus(orderId, "cancelled").catch(() => {});

      if (activePolls.has(orderId)) {
        clearInterval(activePolls.get(orderId));
        activePolls.delete(orderId);
      }

      try {
        await cancelTransaction({ orderId, amount, apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT });
      } catch (err) {
        console.error("[DO CANCEL API]", err);
      }

      await bot.deleteMessage(chatId, msgId).catch(() => {});

      const tglCancel = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      const cancelCaption =
        `<blockquote><em>Order Berhasil Dibatalkan</em>\n` +
        `<em>⌯⌲ Order ID : ${orderId}</em>\n` +
        `<em>⌯⌲  Tanggal : ${tglCancel}</em></blockquote>`;
      const cancelMsg = await bot.sendMessage(chatId, cancelCaption, { parse_mode: "HTML" });
      return;
    }

    // ── Check Payment ─────────────────────────────────────────────────
    const cekMatch = data.match(/^do_cek:(.+)$/);
    if (cekMatch) {
      const orderId = cekMatch[1];
      const order = await getVpsOrder(orderId);

      if (!order) {
        return bot.answerCallbackQuery(query.id, { text: "Order tidak ditemukan!", show_alert: true });
      }
      if (order.status !== "pending_payment") {
        return bot.answerCallbackQuery(query.id, { text: `Status: ${order.status}`, show_alert: true });
      }

      try {
        const result = await checkTransaction({
          orderId,
          amount: order.price,
          apiKey: PAKASIR_API_KEY,
          project: PAKASIR_PROJECT
        });
        const status = result?.transaction?.status || "pending";
        bot.answerCallbackQuery(query.id, { text: `Status pembayaran: ${status}`, show_alert: true });
      } catch (_) {
        bot.answerCallbackQuery(query.id, { text: "Gagal cek status!", show_alert: true });
      }
      return;
    }

    // ── Cek Saldo ─────────────────────────────────────────────────────
    if (data === "do_saldo") {
      const saldo = await getSaldo(userId);
      return bot.answerCallbackQuery(query.id, {
        text: `Saldo kamu: ${formatRupiah(saldo)}`,
        show_alert: true
      });
    }

    // ── History ───────────────────────────────────────────────────────
    if (data === "do_history") {
      const orders = await getVpsOrdersByUser(userId);
      const text = buildHistoryMessage(orders);

      return bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: afterPaymentKeyboard()
      }).catch(() => {});
    }

  });
};
