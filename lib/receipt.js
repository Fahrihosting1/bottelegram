/**
 * receipt.js — Generator struk transaksi premium
 * Design: Gold & Black luxury ticket style
 * SVG murni, tidak butuh canvas.
 * Foto profil Telegram di-fetch via Bot API, di-embed sebagai base64 data URI.
 *
 * Ekspor:
 *   generateReceipt(bot, params) → Promise<{ buffer, filename }>
 */

const fetch = require("node-fetch");

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function nowWib() {
  return new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).replace(/\./g, "/").replace(",", "");
}

function xe(str) {
  return String(str ?? "-")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function trunc(str, max = 24) {
  const s = String(str ?? "-");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function fetchProfilePhotoBase64(bot, userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos || photos.total_count === 0) return null;
    const sizes  = photos.photos[0];
    const fileId = sizes[sizes.length - 1].file_id;
    const fileInfo = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf  = await res.buffer();
    const mime = fileInfo.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (_) { return null; }
}

// ─── SVG Builder ─────────────────────────────────────────────────────────────

function buildReceiptSVG({
  profileDataUri,
  productImageDataUri,
  buyerName,
  buyerUsername,
  buyerUserId,
  orderId,
  productLabel,
  productType,
  price,
  fee = 0,
  paymentMethod,
  extraRows = [],
  date,
  storeName    = "BiYu Store",
  storeContact = "@BiYuStore"
}) {
  const W      = 900;
  const H      = 520;
  const SPLIT  = 620;

  // Product image strip on the far left
  const IMG_W  = 68;   // lebar kolom gambar produk (compact)
  const INFO_X = productImageDataUri ? IMG_W + 16 : 0;  // geser konten info ke kanan jika ada gambar

  const dateStr = date || nowWib();
  const total   = Number(price) + Number(fee);
  const methStr = paymentMethod === "saldo" ? "Saldo" : "QRIS";

  // Nama toko untuk tanda tangan (baris terpisah tiap kata, maks 2 baris)
  const storeWords = storeName.split(" ").slice(0, 3);

  // Avatar
  const AX = SPLIT + (W - SPLIT) / 2;  // 760
  const AY = 148;
  const AR = 34;

  // Product image strip (kiri, compact, tidak lebar)
  let productImgSVG = "";
  if (productImageDataUri) {
    const PX = 4;            // X start strip
    const PY = 72;           // mulai di bawah header band
    const PH = H - 72 - 44; // tinggi area (minus header & footer)
    productImgSVG = `
      <defs><clipPath id="pc"><rect x="${PX}" y="${PY}" width="${IMG_W}" height="${PH}" rx="6"/></clipPath></defs>
      <!-- strip background -->
      <rect x="${PX}" y="${PY}" width="${IMG_W}" height="${PH}" rx="6" fill="#111111"/>
      <!-- product image -->
      <image href="${productImageDataUri}"
             x="${PX}" y="${PY}" width="${IMG_W}" height="${PH}"
             clip-path="url(#pc)" preserveAspectRatio="xMidYMid slice" opacity="0.88"/>
      <!-- subtle gold overlay border -->
      <rect x="${PX}" y="${PY}" width="${IMG_W}" height="${PH}" rx="6"
            fill="none" stroke="#C9A84C" stroke-width="1.2" opacity="0.6"/>
      <!-- label "PRODUK" di bawah gambar -->
      <rect x="${PX}" y="${PY + PH - 20}" width="${IMG_W}" height="20" rx="0"
            fill="#C9A84C" opacity="0.85"/>
      <text x="${PX + IMG_W / 2}" y="${PY + PH - 7}"
            font-family="Arial,sans-serif" font-size="8" font-weight="700"
            fill="#000000" text-anchor="middle" letter-spacing="1">PRODUK</text>
    `;
  }
  if (profileDataUri) {
    avatarSVG = `
      <defs><clipPath id="ac"><circle cx="${AX}" cy="${AY}" r="${AR}"/></clipPath></defs>
      <circle cx="${AX}" cy="${AY}" r="${AR + 3}" fill="#C9A84C" opacity="0.85"/>
      <image href="${profileDataUri}"
             x="${AX - AR}" y="${AY - AR}" width="${AR * 2}" height="${AR * 2}"
             clip-path="url(#ac)" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    const initials = (buyerName || "U").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
    avatarSVG = `
      <circle cx="${AX}" cy="${AY}" r="${AR + 3}" fill="#C9A84C" opacity="0.8"/>
      <circle cx="${AX}" cy="${AY}" r="${AR}" fill="#1A1400"/>
      <text x="${AX}" y="${AY + 7}" font-family="Georgia,serif" font-size="18"
            fill="#F0D080" text-anchor="middle" font-weight="bold">${xe(initials)}</text>`;
  }

  // Store name lines (right panel)
  const storeNameLines = storeWords.map((word, i) => {
    const fs = i === 0 ? 20 : 16;
    const y  = 72 + i * 20;
    return `<text x="${AX}" y="${y}" font-family="Georgia,serif" font-size="${fs}"
          font-weight="bold" fill="#FFFFFF" text-anchor="middle" letter-spacing="2">${xe(word)}</text>`;
  }).join("\n");
  const storeSubY = 72 + storeWords.length * 20 + 4;

  // Signature: first word of storeName
  const sigWord = storeWords[0] || "Store";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="gG" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#C9A84C"/>
      <stop offset="40%"  stop-color="#F0D080"/>
      <stop offset="70%"  stop-color="#C9A84C"/>
      <stop offset="100%" stop-color="#8B6914"/>
    </linearGradient>
    <linearGradient id="gH" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="#8B6914"/>
      <stop offset="50%"  stop-color="#F0D080"/>
      <stop offset="100%" stop-color="#8B6914"/>
    </linearGradient>
    <linearGradient id="gDark" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#1A1500"/>
      <stop offset="100%" stop-color="#0A0A0A"/>
    </linearGradient>
    <linearGradient id="gRight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#181410"/>
      <stop offset="100%" stop-color="#0D0C09"/>
    </linearGradient>
    <clipPath id="cardClip">
      <rect x="0" y="0" width="${W}" height="${H}" rx="16"/>
    </clipPath>
    <filter id="sh">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#00000066"/>
    </filter>
  </defs>

  <!-- Shadow -->
  <rect x="4" y="4" width="${W-8}" height="${H-8}" rx="16" fill="#00000044" filter="url(#sh)"/>

  <g clip-path="url(#cardClip)">

    <!-- ── Panels ── -->
    <rect x="0"       y="0" width="${SPLIT}"     height="${H}" fill="#F8F4EC"/>
    <rect x="${SPLIT}" y="0" width="${W - SPLIT}" height="${H}" fill="url(#gRight)"/>
    <polygon points="${SPLIT},0 ${SPLIT+130},0 ${SPLIT},${H}" fill="#C9A84C" opacity="0.06"/>

    <!-- ── Header band ── -->
    <rect x="0" y="0" width="${SPLIT}" height="72" fill="url(#gDark)"/>

    <!-- Cart icon -->
    <circle cx="${50 + INFO_X}" cy="36" r="24" fill="#C9A84C" opacity="0.15"/>
    <circle cx="${50 + INFO_X}" cy="36" r="19" fill="none" stroke="#C9A84C" stroke-width="1.5"/>
    <g transform="translate(${39 + INFO_X},25)" fill="none" stroke="#F0D080" stroke-width="1.6"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="M1 1h2l1.5 8h8l1.5-5H5"/>
      <circle cx="8.5"  cy="19.5" r="1.5" fill="#F0D080" stroke="none"/>
      <circle cx="15.5" cy="19.5" r="1.5" fill="#F0D080" stroke="none"/>
    </g>

    <!-- Title -->
    <text x="${88 + INFO_X}" y="33" font-family="Georgia,serif" font-size="27" font-weight="bold"
          fill="#FFFFFF" letter-spacing="2">STRUK</text>
    <text x="${88 + INFO_X}" y="63" font-family="Georgia,serif" font-size="27" font-weight="bold"
          fill="url(#gG)" letter-spacing="2">PEMBELIAN</text>
    <text x="${280 + INFO_X}" y="85" font-family="Arial,sans-serif" font-size="9.5"
          fill="#C9A84C" letter-spacing="1">TERIMA KASIH TELAH BERBELANJA DI TOKO KAMI ♥</text>
    <line x1="0" y1="72" x2="${SPLIT}" y2="72" stroke="url(#gH)" stroke-width="2"/>

    <!-- ── Info rows ── -->
    <!-- Id Pembeli -->
    <rect x="${32 + INFO_X}" y="100" width="26" height="26" rx="13" fill="#111111"/>
    <text x="${45 + INFO_X}" y="118" font-family="Arial" font-size="12" fill="#C9A84C" text-anchor="middle">👤</text>
    <text x="${68 + INFO_X}" y="118" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#222">Id Pembeli</text>
    <text x="${190 + INFO_X}" y="118" font-family="Arial,sans-serif" font-size="13" fill="#666">:</text>
    <text x="${206 + INFO_X}" y="118" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#000">${xe(trunc(String(buyerUserId), 22))}</text>

    <!-- Produk -->
    <rect x="${32 + INFO_X}" y="134" width="26" height="26" rx="13" fill="#111111"/>
    <text x="${45 + INFO_X}" y="152" font-family="Arial" font-size="12" fill="#C9A84C" text-anchor="middle">📦</text>
    <text x="${68 + INFO_X}" y="152" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#222">Produk</text>
    <text x="${190 + INFO_X}" y="152" font-family="Arial,sans-serif" font-size="13" fill="#666">:</text>
    <text x="${206 + INFO_X}" y="152" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#000">${xe(trunc(productType + " " + productLabel, 28))}</text>

    <!-- Metode -->
    <rect x="${32 + INFO_X}" y="168" width="26" height="26" rx="13" fill="#111111"/>
    <text x="${45 + INFO_X}" y="186" font-family="Arial" font-size="12" fill="#C9A84C" text-anchor="middle">💳</text>
    <text x="${68 + INFO_X}" y="186" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#222">Methode Bayar</text>
    <text x="${190 + INFO_X}" y="186" font-family="Arial,sans-serif" font-size="13" fill="#666">:</text>
    <text x="${206 + INFO_X}" y="186" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#000">${xe(methStr)}</text>

    <!-- Tanggal -->
    <rect x="${32 + INFO_X}" y="202" width="26" height="26" rx="13" fill="#111111"/>
    <text x="${45 + INFO_X}" y="220" font-family="Arial" font-size="12" fill="#C9A84C" text-anchor="middle">📅</text>
    <text x="${68 + INFO_X}" y="220" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#222">Tanggal</text>
    <text x="${190 + INFO_X}" y="220" font-family="Arial,sans-serif" font-size="13" fill="#666">:</text>
    <text x="${206 + INFO_X}" y="220" font-family="Arial,sans-serif" font-size="13" fill="#000">${xe(dateStr)}</text>
    <text x="490" y="220" font-family="Georgia,serif" font-size="13" font-style="italic"
          fill="#C9A84C" text-anchor="end">Thanks you!</text>

    <!-- Status -->
    <rect x="${32 + INFO_X}" y="236" width="26" height="26" rx="13" fill="#111111"/>
    <text x="${45 + INFO_X}" y="254" font-family="Arial" font-size="12" fill="#C9A84C" text-anchor="middle">✅</text>
    <text x="${68 + INFO_X}" y="254" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#222">Status</text>
    <text x="${190 + INFO_X}" y="254" font-family="Arial,sans-serif" font-size="13" fill="#666">:</text>
    <text x="${206 + INFO_X}" y="254" font-family="Arial,sans-serif" font-size="13" font-weight="800" fill="#000">PAID</text>

    <!-- ── Detail table ── -->
    <rect x="${30 + INFO_X}" y="270" width="${560 - INFO_X}" height="30" fill="#111111" rx="4"/>
    <line x1="${80 + INFO_X}"  y1="270" x2="${80 + INFO_X}"  y2="300" stroke="#7A5C1E" stroke-width="1"/>
    <line x1="${260 + INFO_X}" y1="270" x2="${260 + INFO_X}" y2="300" stroke="#7A5C1E" stroke-width="1"/>
    <line x1="${370 + INFO_X}" y1="270" x2="${370 + INFO_X}" y2="300" stroke="#7A5C1E" stroke-width="1"/>
    <line x1="${460 + INFO_X}" y1="270" x2="${460 + INFO_X}" y2="300" stroke="#7A5C1E" stroke-width="1"/>
    <text x="${55 + INFO_X}"  y="289" font-family="Arial,sans-serif" font-size="10" font-weight="700"
          fill="#F0D080" text-anchor="middle" letter-spacing="0.5">NO.</text>
    <text x="${170 + INFO_X}" y="289" font-family="Arial,sans-serif" font-size="10" font-weight="700"
          fill="#F0D080" text-anchor="middle">&#x1F4DD; DETAIL</text>
    <text x="${315 + INFO_X}" y="284" font-family="Arial,sans-serif" font-size="9" font-weight="700"
          fill="#F0D080" text-anchor="middle">&#x1F4B0; HARGA</text>
    <text x="${315 + INFO_X}" y="296" font-family="Arial,sans-serif" font-size="9" font-weight="700"
          fill="#F0D080" text-anchor="middle">SATUAN</text>
    <text x="${415 + INFO_X}" y="284" font-family="Arial,sans-serif" font-size="9" font-weight="700"
          fill="#F0D080" text-anchor="middle">&#x1F4E6; JUMLAH</text>
    <text x="${415 + INFO_X}" y="296" font-family="Arial,sans-serif" font-size="9" font-weight="700"
          fill="#F0D080" text-anchor="middle">/ QTY</text>
    <text x="${533 + INFO_X}" y="284" font-family="Arial,sans-serif" font-size="9" font-weight="700"
          fill="#F0D080" text-anchor="middle">&#x1F4CB; SUBTOTAL</text>

    <rect x="${30 + INFO_X}" y="270" width="${560 - INFO_X}" height="66" fill="none"
          stroke="#7A5C1E" stroke-width="1.5" rx="4"/>
    <line x1="${30 + INFO_X}" y1="300" x2="590" y2="300"
          stroke="#7A5C1E" stroke-width="1" stroke-dasharray="3 3"/>

    <!-- Row data -->
    <text x="${55 + INFO_X}"  y="323" font-family="Arial,sans-serif" font-size="12" fill="#222" text-anchor="middle">1</text>
    <text x="${170 + INFO_X}" y="323" font-family="Arial,sans-serif" font-size="11" font-weight="600" fill="#111" text-anchor="middle">${xe(trunc(productLabel, 20))}</text>
    <text x="${315 + INFO_X}" y="323" font-family="Arial,sans-serif" font-size="11" fill="#333" text-anchor="middle">${xe(formatRupiah(price))}</text>
    <text x="${415 + INFO_X}" y="323" font-family="Arial,sans-serif" font-size="12" fill="#333" text-anchor="middle">1</text>
    <text x="${533 + INFO_X}" y="323" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="#111" text-anchor="middle">${xe(formatRupiah(price))}</text>

    <!-- ── Rincian biaya ── -->
    <text x="${120 + INFO_X}" y="385" font-family="Georgia,serif" font-size="16" letter-spacing="2"
          fill="#C9A84C" text-anchor="middle">RINCIAN BIAYA :</text>

    <rect x="${278 + INFO_X}" y="362" width="${312 - INFO_X}" height="58" rx="6"
          fill="#111111" stroke="url(#gH)" stroke-width="1.5"/>
    <text x="${296 + INFO_X}" y="382" font-family="Arial,sans-serif" font-size="12" font-weight="700"
          fill="#F0D080" letter-spacing="1">FEE ADMIN :</text>
    <text x="578" y="382" font-family="Arial,sans-serif" font-size="13" font-weight="700"
          fill="#FFFFFF" text-anchor="end">${xe(formatRupiah(fee))}</text>
    <line x1="${286 + INFO_X}" y1="391" x2="578" y2="391" stroke="#7A5C1E" stroke-width="0.5"/>
    <text x="${296 + INFO_X}" y="408" font-family="Arial,sans-serif" font-size="12" font-weight="700"
          fill="#F0D080" letter-spacing="1">SUBTOTAL :</text>
    <text x="578" y="410" font-family="Arial,sans-serif" font-size="15" font-weight="800"
          fill="#F0D080" text-anchor="end">${xe(formatRupiah(total))}</text>

    <!-- Order ID -->
    <text x="${30 + INFO_X}" y="458" font-family="monospace" font-size="10" fill="#888888">Order ID: ${xe(trunc(orderId, 32))}</text>

    <!-- ── Footer ── -->
    <rect x="0" y="476" width="${SPLIT}" height="44" fill="#111111"/>
    <text x="${SPLIT / 2}" y="502" font-family="Arial,sans-serif" font-size="11"
          letter-spacing="2" fill="url(#gH)" text-anchor="middle">&#x2605;  Credits : ${xe(storeName)}  &#x2605;</text>

    <!-- ── Product image strip (kiri, samping info) ── -->
    ${productImgSVG}

    <!-- ── Ticket perforation ── -->
    <circle cx="${SPLIT}" cy="26"  r="13" fill="#F8F4EC"/>
    <circle cx="${SPLIT}" cy="494" r="13" fill="#F8F4EC"/>
    <line x1="${SPLIT}" y1="39" x2="${SPLIT}" y2="481"
          stroke="#7A5C1E" stroke-width="1.5" stroke-dasharray="6 5"/>

    <!-- ── RIGHT PANEL ── -->

    <!-- Bag icon + store name -->
    <text x="${AX}" y="34" font-family="Arial,sans-serif" font-size="28" text-anchor="middle">&#x1F6CD;&#xFE0F;</text>
    <text x="${AX}" y="54" font-family="Georgia,serif" font-size="11" letter-spacing="3"
          fill="#C9A84C" text-anchor="middle">TOKO</text>
    ${storeNameLines}
    <text x="${AX}" y="${storeSubY}"
          font-family="Arial,sans-serif" font-size="9" letter-spacing="3"
          fill="#C9A84C" text-anchor="middle">${xe(storeContact)}</text>

    <!-- Avatar -->
    ${avatarSVG}

    <!-- Buyer info -->
    <text x="${AX}" y="${AY + AR + 20}" font-family="Arial,sans-serif" font-size="12"
          font-weight="700" fill="#FFFFFF" text-anchor="middle">${xe(trunc(buyerName, 18))}</text>
    ${buyerUsername
      ? `<text x="${AX}" y="${AY + AR + 35}" font-family="monospace" font-size="10"
               fill="#C9A84C" text-anchor="middle">@${xe(trunc(buyerUsername, 16))}</text>`
      : ""}

    <!-- ── Tanda Tangan ── -->
    <rect x="638" y="233" width="244" height="92"
          rx="8" fill="#1A1600" stroke="url(#gH)" stroke-width="1.5"/>
    <rect x="682" y="223" width="156" height="22"
          rx="11" fill="url(#gG)"/>
    <text x="${AX}" y="239" font-family="Arial,sans-serif" font-size="10" font-weight="700"
          fill="#000000" text-anchor="middle" letter-spacing="2">&#x2605;  TANDA TANGAN  &#x2605;</text>

    <!-- Signature script -->
    <text x="${AX}" y="279" font-family="'Brush Script MT',cursive" font-size="32"
          fill="#FFFFFF" text-anchor="middle" font-style="italic" opacity="0.9">${xe(sigWord)}</text>
    <line x1="650" y1="296" x2="872" y2="296" stroke="#7A5C1E" stroke-width="1"/>
    <text x="${AX}" y="313" font-family="Georgia,serif" font-size="9" letter-spacing="3"
          fill="#C9A84C" text-anchor="middle">&#x2014; OFFICIAL &#x2014;</text>

    <!-- ── Thank You ── -->
    <rect x="638" y="432" width="244" height="54"
          rx="10" fill="#000000" stroke="url(#gH)" stroke-width="1.5"/>
    <text x="648"    y="452" font-family="Arial" font-size="10" fill="#C9A84C">&#x2736;</text>
    <text x="874"    y="452" font-family="Arial" font-size="10" fill="#C9A84C" text-anchor="end">&#x2736;</text>
    <text x="${AX}"  y="452" font-family="Arial,sans-serif" font-size="13" font-weight="800"
          fill="#F0D080" text-anchor="middle" letter-spacing="2">&#x2736; THANK YOU &#x2736;</text>
    <text x="648"    y="472" font-family="Arial" font-size="10" fill="#C9A84C">&#x2736;</text>
    <text x="874"    y="472" font-family="Arial" font-size="10" fill="#C9A84C" text-anchor="end">&#x2736;</text>
    <text x="${AX}"  y="472" font-family="Arial,sans-serif" font-size="10"
          fill="#C9A84C" text-anchor="middle" letter-spacing="1">ATAS KEPERCAYAAN ANDA</text>
    <text x="${AX}"  y="496" font-family="Arial" font-size="14" fill="#C9A84C" text-anchor="middle">&#x2665;</text>

    <!-- Gold border -->
    <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="15"
          fill="none" stroke="url(#gG)" stroke-width="2"/>

  </g>
</svg>`;
}

// ─── SVG → PNG ───────────────────────────────────────────────────────────────

let Resvg = null;
try { Resvg = require("@resvg/resvg-js").Resvg; } catch (_) {}

async function svgToBuffer(svgString) {
  if (Resvg) {
    try {
      const resvg = new Resvg(svgString, { fitTo: { mode: "width", value: 900 } });
      return resvg.render().asPng();
    } catch (_) {}
  }
  // Fallback: kirim raw SVG (Telegram tidak bisa render, tapi tidak crash)
  return Buffer.from(svgString, "utf8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function generateReceipt(bot, params) {
  const profileDataUri = await fetchProfilePhotoBase64(bot, params.buyerUserId).catch(() => null);

  // Fetch product image jika ada URL-nya
  let productImageDataUri = params.productImageDataUri || null;
  if (!productImageDataUri && params.productImageUrl) {
    try {
      const res = await fetch(params.productImageUrl);
      if (res.ok) {
        const buf  = await res.buffer();
        const ct   = res.headers.get("content-type") || "image/jpeg";
        productImageDataUri = `data:${ct};base64,${buf.toString("base64")}`;
      }
    } catch (_) {}
  }

  const svg    = buildReceiptSVG({ ...params, profileDataUri, productImageDataUri });
  const buffer = await svgToBuffer(svg);
  const ext    = Resvg ? "png" : "svg";
  return { buffer, filename: `struk_${params.orderId || Date.now()}.${ext}` };
}

module.exports = { generateReceipt };
