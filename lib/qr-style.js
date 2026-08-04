/**
 * qr-style.js — Render QR code dari data string jadi SVG bergaya
 * (dot rounded + warna brand), BUKAN dari image hasil provider.
 *
 * Kenapa dari data string, bukan restyle gambar QR yang udah jadi?
 * Karena warna/bentuk modul cuma bisa diubah AMAN kalau kita tau persis
 * mana modul gelap/terang dari sumbernya (qrcode.create), bukan nebak dari
 * pixel gambar raster. Finder pattern (3 kotak besar di pojok) SENGAJA
 * digambar presisi sesuai rasio standar (1:1:3:1:1) — itu bagian yang
 * paling gampang bikin scanner gagal kalau di-style sembarangan.
 *
 * errorCorrectionLevel dipaksa 'H' (30% toleransi rusak/ketutup) supaya
 * ada bantalan ekstra karena tampilannya udah "didekor".
 */

const QRCode = require("qrcode");

/**
 * @param {string} data              Payload QRIS mentah (hasil decode qr provider)
 * @param {Object} [opts]
 * @param {number} [opts.moduleSize] Ukuran 1 modul dalam px (default 16)
 * @param {number} [opts.quietZone]  Lebar quiet zone dalam modul (default 4)
 * @param {string} [opts.dotColor]   Warna modul data (default hijau tua brand)
 * @param {string} [opts.eyeColor]   Warna finder pattern (default hitam — kontras maksimal)
 * @param {string} [opts.bgColor]   Warna background (default putih)
 * @returns {{ svg: string, sizePx: number }}
 */
function buildStyledQrSvg(data, opts = {}) {
  const {
    moduleSize = 16,
    quietZone = 4,
    dotColor = "#0A5C22",
    eyeColor = "#111111",
    bgColor = "#ffffff",
  } = opts;

  const qr = QRCode.create(data, { errorCorrectionLevel: "H" });
  const size = qr.modules.size;
  const bits = qr.modules.data; // Uint8Array, 1 = dark

  const isDark = (r, c) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return false;
    return !!(bits[r * size + c] & 1);
  };

  // Zona finder pattern (7x7) di 3 pojok — modul di sini TIDAK digambar
  // per-titik, karena bentuknya digambar terpisah sebagai 1 shape presisi.
  const inFinderZone = (r, c) => {
    const tl = r < 7 && c < 7;
    const tr = r < 7 && c >= size - 7;
    const bl = r >= size - 7 && c < 7;
    return tl || tr || bl;
  };

  const totalModules = size + quietZone * 2;
  const sizePx = totalModules * moduleSize;
  const off = quietZone * moduleSize;

  let dots = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isDark(r, c)) continue;
      if (inFinderZone(r, c)) continue;
      const cx = off + c * moduleSize + moduleSize / 2;
      const cy = off + r * moduleSize + moduleSize / 2;
      const radius = moduleSize * 0.46; // circle dot, sedikit gap antar titik
      dots += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="${dotColor}"/>`;
    }
  }

  // Finder pattern presisi: outer 7x7 (dark) → ring 5x5 (bg) → inner 3x3 (dark)
  function finderEye(topLeftR, topLeftC) {
    const x = off + topLeftC * moduleSize;
    const y = off + topLeftR * moduleSize;
    const s7 = moduleSize * 7;
    const s5 = moduleSize * 5;
    const s3 = moduleSize * 3;
    const rOuter = moduleSize * 1.6;
    const rInner = moduleSize * 0.9;
    return `
      <rect x="${x}" y="${y}" width="${s7}" height="${s7}" rx="${rOuter}" fill="${eyeColor}"/>
      <rect x="${x + moduleSize}" y="${y + moduleSize}" width="${s5}" height="${s5}" rx="${rOuter * 0.7}" fill="${bgColor}"/>
      <rect x="${x + moduleSize * 2}" y="${y + moduleSize * 2}" width="${s3}" height="${s3}" rx="${rInner}" fill="${eyeColor}"/>
    `;
  }

  const eyes =
    finderEye(0, 0) +
    finderEye(0, size - 7) +
    finderEye(size - 7, 0);

  const inner = `<rect width="${sizePx}" height="${sizePx}" fill="${bgColor}"/>${dots}${eyes}`;

  const svg = `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

  return { svg, inner, sizePx };
}

module.exports = { buildStyledQrSvg };
