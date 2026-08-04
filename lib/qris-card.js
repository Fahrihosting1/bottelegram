/**
 * qris-card.js — Bungkus QR image (dari GoPay Merchant / provider manapun)
 * jadi "kartu" QRIS yang rapi: header brand + badge QRIS + QR asli (utuh,
 * TIDAK diubah pixel-nya sama sekali, cuma di-embed) + footer.
 *
 * Pola sama persis kayak lib/receipt.js: bangun SVG string → render ke PNG
 * pakai @resvg/resvg-js (udah ada di package.json, gak nambah dependency).
 *
 * CATATAN soal logo GoPay:
 *  Ini SENGAJA bukan file logo resmi GoPay (itu aset bermerek dagang milik
 *  GoJek/GoPay, gak boleh sembarangan ditempel ulang). Sebagai gantinya
 *  dibikin wordmark teks "GoPay" pakai warna hijau brand GoPay (#00AA13)
 *  dengan gaya rounded-bold — tetap kelihatan "GoPay banget" secara visual
 *  tanpa reproduksi logo resmi.
 *
 * Ekspor:
 *   generateQrisCard({ qrImageUrl, qrImageBuffer, merchantName, note, orderId })
 *     → Promise<{ buffer, filename }>
 */

const fetch = require("node-fetch");
const path = require("path");
const { buildStyledQrSvg } = require("./qr-style");

const FONT_DIR = path.join(__dirname, "fonts");
const FONT_FILES = [
  path.join(FONT_DIR, "DejaVuSans.ttf"),
  path.join(FONT_DIR, "DejaVuSans-Bold.ttf"),
];
const FONT_FAMILY = "DejaVu Sans"; // nama family di dalam file font di atas

function wrapText(str, maxChars) {
  const words = String(str).split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = (cur + " " + w).trim();
    if (test.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function xe(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/png"; // fallback
}

async function toDataUri(qrImageUrl, qrImageBuffer) {
  if (qrImageBuffer) {
    const mime = sniffMime(qrImageBuffer);
    return `data:${mime};base64,${qrImageBuffer.toString("base64")}`;
  }
  const res = await fetch(qrImageUrl);
  if (!res.ok) throw new Error(`Gagal fetch QR image (HTTP ${res.status})`);
  const buf = await res.buffer();
  const ct = res.headers.get("content-type") || sniffMime(buf);
  return `data:${ct};base64,${buf.toString("base64")}`;
}

function buildQrisCardSVG({ qrDataUri, qrisRawPayload, merchantName, note }) {
  const W = 1080, H = 1500;
  const cardW = 900, cardH = 1020;
  const cardX = (W - cardW) / 2, cardY = 356;
  const qrSize = 660;
  const qrX = (W - qrSize) / 2;
  const qrY = cardY + 200;

  const name = xe(merchantName || "GoPay Merchant");
  const noteText = note || "Berlaku untuk semua GoPay, OVO, Dana, ShopeePay & m-Banking";
  const noteLines = wrapText(noteText, 40); // ~40 char/baris di font-size 26

  // QR: kalau ada raw payload, render VECTOR bergaya (dot + rounded eyes,
  // warna brand, tetap presisi finder pattern). Kalau nggak ada, fallback
  // ke embed gambar QR polos dari provider (aman, walau visualnya default).
  let qrMarkup;
  if (qrisRawPayload) {
    const { inner, sizePx } = buildStyledQrSvg(qrisRawPayload, {
      moduleSize: 16,
      quietZone: 2, // quiet zone tambahan udah disediain sama frame putih di luar
      dotColor: "#0A5C22",
      eyeColor: "#111111",
      bgColor: "#ffffff",
    });
    qrMarkup = `<svg x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" viewBox="0 0 ${sizePx} ${sizePx}">${inner}</svg>`;
  } else {
    qrMarkup = `<image x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" href="${qrDataUri}"/>`;
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0C6B1E"/>
      <stop offset="100%" stop-color="#00390D"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="-40" cy="-60" r="320" fill="#ffffff" opacity="0.05"/>
  <circle cx="${W + 60}" cy="${H - 120}" r="360" fill="#ffffff" opacity="0.04"/>
  <circle cx="${W - 80}" cy="20" r="220" fill="#00AA13" opacity="0.18"/>

  <!-- GoPay wordmark badge (text-based, bukan logo resmi) -->
  <g transform="translate(${W / 2}, 150)">
    <rect x="-165" y="-64" width="330" height="128" rx="64" fill="#ffffff"/>
    <text x="0" y="20" font-family="DejaVu Sans" font-size="62" font-weight="700"
          fill="#00AA13" text-anchor="middle">GoPay</text>
  </g>

  <text x="${W / 2}" y="272" font-family="DejaVu Sans" font-size="56" font-weight="700"
        fill="#ffffff" text-anchor="middle">${name}</text>
  <text x="${W / 2}" y="316" font-family="DejaVu Sans" font-size="30"
        fill="#D9F2DC" text-anchor="middle">Scan untuk Bayar</text>

  <!-- White card -->
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="48" fill="#ffffff" filter="url(#shadow)"/>

  <!-- QRIS badge -->
  <g transform="translate(${W / 2}, ${cardY + 74})">
    <rect x="-96" y="-34" width="192" height="68" rx="34" fill="#111111"/>
    <text x="0" y="12" font-family="DejaVu Sans" font-size="40" font-weight="700"
          fill="#ffffff" text-anchor="middle">QRIS</text>
  </g>
  <text x="${W / 2}" y="${cardY + 140}" font-family="DejaVu Sans" font-size="26"
        fill="#787878" text-anchor="middle">Quick Response Code Indonesian Standard</text>

  <!-- QR frame -->
  <rect x="${qrX - 18}" y="${qrY - 18}" width="${qrSize + 36}" height="${qrSize + 36}" rx="24"
        fill="none" stroke="#E6E6E6" stroke-width="3"/>
  ${qrMarkup}

  <!-- Footer note (SVG text murni, wrap manual — foreignObject gak didukung resvg) -->
  ${noteLines.map((line, i) => `<text x="${W / 2}" y="${qrY + qrSize + 46 + i * 34}" font-family="DejaVu Sans" font-size="26" fill="#5a5a5a" text-anchor="middle">${xe(line)}</text>`).join("\n  ")}

  <rect x="${W / 2 - 60}" y="${cardY + cardH - 46}" width="120" height="6" rx="3" fill="#00AA13"/>

  <text x="${W / 2}" y="${cardY + cardH + 60}" font-family="DejaVu Sans" font-size="26"
        fill="#D9F2DC" text-anchor="middle">Powered by GoPay Merchant</text>
</svg>`;
}

let Resvg = null;
try { Resvg = require("@resvg/resvg-js").Resvg; } catch (_) {}

async function svgToBuffer(svgString) {
  if (Resvg) {
    try {
      const resvg = new Resvg(svgString, {
        fitTo: { mode: "width", value: 1080 },
        font: {
          loadSystemFonts: false,
          fontFiles: FONT_FILES,
          defaultFontFamily: FONT_FAMILY,
          sansSerifFamily: FONT_FAMILY,
        },
      });
      return resvg.render().asPng();
    } catch (_) {}
  }
  // Fallback: kirim raw SVG kalau resvg gagal load (tetap gak crash bot-nya)
  return Buffer.from(svgString, "utf8");
}

/**
 * @param {Object} params
 * @param {string} [params.qrisRawPayload] Payload QRIS mentah (EMV string) — kalau ada,
 *                                          QR di-render VECTOR bergaya (dot + rounded eyes).
 * @param {string} [params.qrImageUrl]     URL gambar QR dari provider — dipakai kalau
 *                                          qrisRawPayload gak ada (fallback, QR polos).
 * @param {Buffer} [params.qrImageBuffer]  ATAU langsung buffer gambar QR
 * @param {string} [params.merchantName]   Default "GoPay Merchant"
 * @param {string} [params.note]           Teks kecil di bawah QR
 * @param {string} [params.orderId]        Buat nama file aja
 */
async function generateQrisCard({ qrisRawPayload, qrImageUrl, qrImageBuffer, merchantName, note, orderId }) {
  let qrDataUri = null;
  if (!qrisRawPayload) {
    qrDataUri = await toDataUri(qrImageUrl, qrImageBuffer);
  }
  const svg = buildQrisCardSVG({ qrDataUri, qrisRawPayload, merchantName, note });
  const buffer = await svgToBuffer(svg);
  const ext = Resvg ? "png" : "svg";
  return { buffer, filename: `qris_${orderId || Date.now()}.${ext}` };
}

module.exports = { generateQrisCard };
