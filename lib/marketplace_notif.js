/**
 * lib/marketplace_notif.js
 *
 * Notifikasi sewa marketplace hampir habis — dikirim LANGSUNG dari bot itu
 * sendiri ke owner-nya via sendMessage, lengkap dengan link invoice + QRIS
 * perpanjang yang bisa langsung dibayar.
 */

const supabase = require("./supabase");

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 jam
const WARN_HOURS        = 5;               // kirim notif kalau sisa ≤ 5 jam

// URL web (halaman invoice) — set WEB_BASE_URL di env bot
// contoh: WEB_BASE_URL=https://smscode9.vercel.app
const WEB_BASE_URL = (process.env.WEB_BASE_URL || "").replace(/\/$/, "");

const intervals = new Map(); // botId -> intervalId

function formatSisa(ms) {
  const totalMenit = Math.floor(ms / 60_000);
  const jam        = Math.floor(totalMenit / 60);
  const menit      = totalMenit % 60;
  if (jam > 0 && menit > 0) return `${jam} jam ${menit} menit`;
  if (jam > 0)               return `${jam} jam`;
  return `${menit} menit`;
}

function fmtWib(iso) {
  return new Date(iso).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }) + " WIB";
}

function rpFormat(n) {
  return `Rp ${Math.round(n).toLocaleString("id-ID")}`;
}

async function checkAndNotify(bot, userId, ownerId) {
  if (!ownerId) return;

  try {
    const now    = new Date();
    const cutoff = new Date(now.getTime() + WARN_HOURS * 60 * 60 * 1000);

    const { data: subs, error } = await supabase
      .from("marketplace_subscriptions")
      .select("id, active_until, amount_base")
      .eq("user_id", userId)
      .eq("status", "active")
      .eq("notif_5h_sent", false)
      .not("active_until", "is", null)
      .gt("active_until", now.toISOString())
      .lte("active_until", cutoff.toISOString())
      .order("active_until", { ascending: true })
      .limit(1);

    if (error) {
      console.error(`[marketplace_notif][${bot.label}] query error:`, error.message);
      return;
    }

    if (!subs || subs.length === 0) return;

    const sub    = subs[0];
    const sisaMs = new Date(sub.active_until).getTime() - now.getTime();
    const sisaStr = formatSisa(sisaMs);

    // Ambil info username Telegram owner kalau ada
    const { data: tgUser } = await supabase
      .from("telegram_users")
      .select("username, first_name")
      .eq("user_id", String(ownerId))
      .eq("bot_id", bot.id)
      .maybeSingle();

    const username = tgUser?.username
      ? `@${tgUser.username}`
      : tgUser?.first_name || "-";

    // Nominal perpanjang — ambil dari settings DB, fallback ke amount_base awal
    const { data: settings } = await supabase
      .from("marketplace_subscription_settings")
      .select("price_renewal")
      .eq("id", 1)
      .maybeSingle();
    const nominalPerpanjang = rpFormat(settings?.price_renewal ?? sub.amount_base ?? 0);

    // URL invoice
    const invoiceUrl = WEB_BASE_URL
      ? `${WEB_BASE_URL}/invoice/marketplace/${sub.id}?owner_id=${ownerId}`
      : null;

    // ── Format pesan sesuai template ────────────────────────────────────────
    const pesan =
      `<b>🏷 INFORMASI SEWA BOT</b>\n` +
      `✮⋆˙ Tanggal / Jam : ${fmtWib(now.toISOString())}\n` +
      `✮⋆˙ Nominal Perpanjang : ${nominalPerpanjang}\n` +
      `✮⋆˙ Sisa Waktu : <b>${sisaStr}</b>\n` +
      (invoiceUrl ? `✮⋆˙ Url Invoice : <a href="${invoiceUrl}">Klik di sini</a>\n` : "") +
      `──────୨ৎ──────\n` +
      `ᯓ★ ID Telegram : <code>${ownerId}</code>\n` +
      `ᯓ★ Username : ${username}\n` +
      `ᯓ★ ID Transaksi : <code>${sub.id}</code>\n\n` +
      `<i>#fahriofficial #sewabot #hosting</i>`;

    // Inline keyboard — tombol buka invoice kalau URL tersedia
    const replyMarkup = invoiceUrl
      ? {
          inline_keyboard: [[
            { text: "💳 Bayar & Perpanjang Sewa", url: invoiceUrl },
          ]],
        }
      : undefined;

    await bot.sendMessage(ownerId, pesan, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });

    // Tandai sudah dikirim
    const { error: updateErr } = await supabase
      .from("marketplace_subscriptions")
      .update({ notif_5h_sent: true })
      .eq("id", sub.id);

    if (updateErr) {
      console.error(`[marketplace_notif][${bot.label}] gagal update notif_5h_sent:`, updateErr.message);
    } else {
      console.log(`✅ [marketplace_notif][${bot.label}] notif + invoice dikirim ke owner ${ownerId}, sisa ${sisaStr}`);
    }

  } catch (err) {
    console.error(`[marketplace_notif][${bot.label}] unexpected error:`, err.message);
  }
}

function initMarketplaceNotif(bot, userId, ownerId) {
  if (!userId || !ownerId) return;

  // Cek sekali langsung pas start
  checkAndNotify(bot, userId, ownerId);

  const id = setInterval(() => checkAndNotify(bot, userId, ownerId), CHECK_INTERVAL_MS);
  intervals.set(bot.id, id);

  console.log(`🔔 [marketplace_notif][${bot.label}] scheduler aktif (cek tiap 1 jam)`);
}

function stopMarketplaceNotif(botId) {
  const id = intervals.get(botId);
  if (id !== undefined) {
    clearInterval(id);
    intervals.delete(botId);
  }
}

module.exports = { initMarketplaceNotif, stopMarketplaceNotif };

