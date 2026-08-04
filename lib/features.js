/**
 * Helper untuk fitur toggle per bot (kolom `enabled_features` di tabel
 * telegram_bot_rentals). Key di sini HARUS SAMA PERSIS dengan
 * lib/bot-features.ts di source code dashboard (Next.js marketplace).
 */

const DEFAULT_FEATURES = {
  buy_vps: true,
  buy_pterodactyl: true,
  buy_scripts: true,
  katalog_produk: true,
  jasa_install_panel: true,
  informasi_bot: true,
};

/**
 * Normalisasi nilai enabled_features dari Supabase.
 * Kolom JSONB kadang balik sebagai object, kadang sebagai string JSON
 * (tergantung driver), jadi handle dua-duanya. Key yang tidak ada di
 * data dianggap default TRUE (fitur baru otomatis aktif).
 */
function normalizeFeatures(raw) {
  let parsed = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = {};
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    parsed = {};
  }

  return { ...DEFAULT_FEATURES, ...parsed };
}

/**
 * Cek apakah fitur `key` aktif untuk instance bot ini.
 * `bot.features` di-set sekali di bot.js saat startBotInstance().
 */
function isFeatureEnabled(bot, key) {
  const features = (bot && bot.features) || DEFAULT_FEATURES;
  return features[key] !== false;
}

const FEATURE_OFF_MESSAGE = "🚫 Fitur ini sedang dinonaktifkan oleh admin bot.";

/**
 * Shortcut buat dipakai di awal handler bot.onText(...):
 *   if (await blockIfDisabled(bot, "buy_vps", msg.chat.id)) return;
 * Balikin true kalau fitur mati (dan udah kirim pesan penolakan),
 * false kalau fitur aktif (lanjut proses seperti biasa).
 */
async function blockIfDisabled(bot, key, chatId) {
  if (isFeatureEnabled(bot, key)) return false;
  await bot.sendMessage(chatId, FEATURE_OFF_MESSAGE).catch(() => {});
  return true;
}

/**
 * Versi untuk callback_query: answerCallbackQuery dengan alert singkat,
 * bukan sendMessage baru (biar gak nyampah chat).
 */
async function blockCallbackIfDisabled(bot, key, query) {
  if (isFeatureEnabled(bot, key)) return false;
  await bot
    .answerCallbackQuery(query.id, {
      text: FEATURE_OFF_MESSAGE,
      show_alert: true,
    })
    .catch(() => {});
  return true;
}

module.exports = {
  DEFAULT_FEATURES,
  normalizeFeatures,
  isFeatureEnabled,
  blockIfDisabled,
  blockCallbackIfDisabled,
  FEATURE_OFF_MESSAGE,
};
