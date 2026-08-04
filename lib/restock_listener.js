/**
 * RESTOCK LISTENER — Supabase Realtime
 * ─────────────────────────────────────────────────────────────────
 * Begitu ada INSERT baru di tabel `ok_stok`, otomatis:
 *  1. Ambil info produk dari tabel `ok_produk`
 *  2. Blast notifikasi ke SEMUA user di `telegram_users`
 *  3. Kirim juga ke channel broadcast (jika BROADCAST_CHANNEL_ID di-set)
 *
 * SYARAT DI SUPABASE:
 *  - Buka Supabase Dashboard → Database → Replication
 *  - Aktifkan Realtime untuk tabel `ok_stok`
 * ─────────────────────────────────────────────────────────────────
 */

const supabase            = require("./supabase");
const { getAllTelegramUsers } = require("./pakasir");
const { OWNER_ID, BROADCAST_CHANNEL_ID } = require("../config");

// Debounce per bot+produk: hindari blast berkali-kali kalau owner addstok
// massal. Key-nya digabung `${botId}:${produkId}` (bukan cuma produkId) —
// soalnya kode produk ("netflix", "vpn1", dst) bisa aja sama persis dipakai
// di lebih dari 1 bot rental, jadi kalau cuma pakai produkId doang, restock
// di bot A bisa salah nge-debounce restock produk dengan kode sama di bot B.
const recentlyBroadcasted = new Map(); // "botId:produkId" → timestamp
const DEBOUNCE_MS = 10_000; // 10 detik per produk

function formatRp(n) {
  return "Rp. " + Number(n).toLocaleString("id-ID");
}

/**
 * Ambil info produk dari tabel ok_produk — WAJIB di-scope per bot_id,
 * karena tabel ok_produk dipakai bareng oleh semua bot rental.
 */
async function getProdukInfo(botId, produkId) {
  const { data, error } = await supabase
    .from("ok_produk")
    .select("id, nama, harga")
    .eq("bot_id", botId)
    .eq("id", produkId)
    .single();
  if (error || !data) return null;
  return data;
}

/**
 * Hitung total stok aktif produk — juga WAJIB di-scope per bot_id.
 */
async function getStokCount(botId, produkId) {
  const { count, error } = await supabase
    .from("ok_stok")
    .select("*", { count: "exact", head: true })
    .eq("bot_id", botId)
    .eq("produk_id", produkId)
    .eq("is_used", false);
  return error ? 0 : (count || 0);
}

/**
 * Blast pesan ke semua user di database
 */
async function broadcastRestock(bot, produk, jumlahStok) {
  const sep = "━━━━━━━━━━━━━━━━━━━━";
  const text =
    `🔔 *RESTOCK PRODUK!*\n${sep}\n\n` +
    `Halo! Kami baru saja menambahkan stok untuk:\n\n` +
    `🏷️ *${produk.nama}*\n` +
    `💰 Harga  : *${formatRp(produk.harga)}*\n` +
    `📦 Stok   : *${jumlahStok} tersedia*\n\n` +
    `Buruan order sebelum kehabisan! 🚀\n${sep}`;

  // ── Kirim ke channel broadcast (jika di-set) ────────────────────────────────
  if (BROADCAST_CHANNEL_ID) {
    try {
      await bot.sendMessage(BROADCAST_CHANNEL_ID, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[RESTOCK] Gagal kirim ke channel:", err.message);
    }
  }

  // ── Blast ke semua user BOT INI SAJA ────────────────────────────────────────
  // (getAllTelegramUsers sekarang di-scope per bot_id, lihat lib/pakasir.js)
  const allUsers = await getAllTelegramUsers(bot.id);
  let berhasil = 0, gagal = 0;

  for (const u of allUsers) {
    const targetId = u.chat_id || u.user_id;
    if (!targetId) continue;
    try {
      await bot.sendMessage(targetId, text, { parse_mode: "Markdown" });
      berhasil++;
    } catch {
      gagal++;
    }
    // Delay kecil supaya tidak kena rate limit Telegram (30 msg/detik)
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`[RESTOCK] Produk: ${produk.nama} | ✅ ${berhasil} | ❌ ${gagal}`);

  // ── Laporan ke owner BOT INI (bot.ownerId = rental.owner_id) ────────────────
  const reportTo = bot.ownerId || OWNER_ID;
  try {
    await bot.sendMessage(
      reportTo,
      `📡 *Broadcast Restock Selesai!*\n\n` +
      `🏷️ Produk : *${produk.nama}*\n` +
      `✅ Terkirim : *${berhasil}* user\n` +
      `❌ Gagal   : *${gagal}* user`,
      { parse_mode: "Markdown" }
    );
  } catch {}
}

/**
 * Inisialisasi Supabase Realtime listener
 * Panggil sekali di bot.js setelah bot dibuat
 *
 * PENTING: `instanceId` WAJIB unik per rental/bot (mis. rental.id).
 * Karena semua bot rental jalan dalam 1 proses yang sama & pakai 1
 * Supabase client (singleton), memakai nama channel yang SAMA di semua
 * instance akan bikin Supabase Realtime melempar error:
 * "cannot add `postgres_changes` callbacks for realtime:restock-listener
 * after `subscribe()`" — karena channel dengan topic yang sama di-cache
 * dan channel pertama sudah ke-subscribe duluan sebelum bot berikutnya
 * sempat manggil `.on()`.
 */
function initRestockListener(bot, instanceId) {
  const channelName = instanceId ? `restock-listener-${instanceId}` : "restock-listener";
  const botId = instanceId; // instanceId == rental.id == bot_id di tabel ok_stok/ok_produk

  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event:  "INSERT",       // hanya trigger saat ada stok baru masuk
        schema: "public",
        table:  "ok_stok",
        // PENTING: filter di level Realtime supaya listener bot ini CUMA
        // nerima event INSERT stok milik bot ini sendiri (bot_id-nya cocok).
        // Tanpa filter ini, setiap bot rental bakal ke-trigger broadcast
        // setiap kali ADA bot manapun yang nambah stok — bukan cuma stoknya
        // sendiri.
        filter: botId ? `bot_id=eq.${botId}` : undefined,
      },
      async (payload) => {
        const produkId = payload.new?.produk_id;
        if (!produkId) return;

        // ── Debounce: skip kalau produk ini baru aja di-broadcast ─────────────
        const debounceKey = `${botId}:${produkId}`;
        const lastTime = recentlyBroadcasted.get(debounceKey);
        if (lastTime && Date.now() - lastTime < DEBOUNCE_MS) {
          console.log(`[RESTOCK] Debounced: ${debounceKey}`);
          return;
        }
        recentlyBroadcasted.set(debounceKey, Date.now());

        console.log(`[RESTOCK] Stok baru masuk untuk produk: ${produkId} (bot ${botId})`);

        try {
          const produk     = await getProdukInfo(botId, produkId);
          if (!produk) return;
          const jumlahStok = await getStokCount(botId, produkId);
          await broadcastRestock(bot, produk, jumlahStok);
        } catch (err) {
          console.error("[RESTOCK] Error:", err.message);
        }
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log(`✅ Restock Listener aktif (${channelName}) — mendengarkan tabel ok_stok...`);
      } else if (status === "CHANNEL_ERROR") {
        console.error(`❌ Restock Listener (${channelName}) gagal subscribe. Cek Supabase Realtime settings.`);
      }
    });

  return () => supabase.removeChannel(channel);
}

module.exports = { initRestockListener };
