const fs = require("fs");
const path = require("path");

// Logo default kalau bot.logoUrl belum di-set dari dashboard (kolom
// `logo_url` di tabel telegram_bot_rentals). Dipakai supaya bot yang
// belum pasang gambar sendiri tetap kirim foto, bukan error/kosong.
const DEFAULT_LOGO_PATH = path.join(__dirname, "../media/biyu_logo.jpg");

/**
 * Balikin "photo" yang siap dipakai langsung di bot.sendPhoto(chatId, photo, ...).
 *
 * - Kalau bot.logoUrl ke-set (link gambar dari Supabase Storage / URL
 *   manapun yang di-isi lewat dashboard web), Telegram bisa langsung
 *   fetch dari URL itu — tinggal balikin string URL-nya apa adanya.
 * - Kalau belum di-set (kolom logo_url masih kosong), fallback ke file
 *   lokal media/biyu_logo.jpg biar tetap ada gambar yang terkirim.
 */
function getBotLogo(bot) {
  const url = bot && bot.logoUrl;
  if (url && typeof url === "string" && url.trim()) {
    return url.trim();
  }
  return fs.createReadStream(DEFAULT_LOGO_PATH);
}

module.exports = { getBotLogo, DEFAULT_LOGO_PATH };
