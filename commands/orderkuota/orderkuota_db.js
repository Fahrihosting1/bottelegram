/**
 * orderkuota_db.js
 * Semua operasi Supabase untuk fitur orderkuota
 *
 * PENTING — MULTI-TENANT (1 proses = N bot rental):
 * Semua fungsi di bawah WAJIB dikasih `botId` sebagai argumen pertama, dan
 * SEMUA query WAJIB di-filter `.eq("bot_id", botId)`. Tabel ok_produk &
 * ok_stok dipakai bareng-bareng oleh semua bot rental (1 tabel Supabase
 * untuk semua tenant), jadi tanpa filter bot_id, produk/stok bot A bakal
 * kecampur / ketampil / bahkan bisa keedit-hapus dari bot B.
 */

const supabase = require("../../lib/supabase");

// ── PRODUK ────────────────────────────────────────────────────────────────────

async function getProdukList(botId) {
  const { data, error } = await supabase
    .from("ok_produk")
    .select("*, custom_emoji_id")
    .eq("bot_id", botId)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  // Urutkan sesuai abjad (A-Z), tidak case-sensitive
  return (data || []).sort((a, b) =>
    String(a.nama || "").localeCompare(String(b.nama || ""), "id", { sensitivity: "base" })
  );
}

/**
 * Ambil satu custom emoji dari tabel tg_custom_emoji berdasarkan ID-nya.
 * Return: { id, nama, icon_url } | null
 */
async function getCustomEmoji(emojiId) {
  if (!emojiId) return null;
  const { data, error } = await supabase
    .from("tg_custom_emoji")
    .select("id, nama, icon_url")
    .eq("id", emojiId)
    .eq("is_active", true)
    .single();
  if (error || !data) return null;
  return data;
}

async function getProdukById(botId, id) {
  const { data, error } = await supabase
    .from("ok_produk")
    .select("*")
    .eq("bot_id", botId)
    .eq("id", id)
    .eq("is_active", true)
    .single();
  if (error) return null;
  return data;
}

async function addProduk(botId, { id, nama, harga, deskripsi }) {
  const { error } = await supabase.from("ok_produk").upsert(
    { id, bot_id: botId, nama, harga, deskripsi, terjual: 0, is_active: true, created_at: new Date().toISOString() },
    { onConflict: "bot_id,id" }
  );
  if (error) throw new Error(error.message);
}

async function editProduk(botId, id, fields) {
  const { error } = await supabase
    .from("ok_produk")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("bot_id", botId)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

async function hapusProduk(botId, id) {
  const { error } = await supabase
    .from("ok_produk")
    .update({ is_active: false })
    .eq("bot_id", botId)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

async function incrementTerjual(botId, id, jumlah = 1) {
  // Ambil terjual lama dulu, lalu update
  const { data } = await supabase
    .from("ok_produk")
    .select("terjual")
    .eq("bot_id", botId)
    .eq("id", id)
    .single();

  const newTerjual = (data?.terjual || 0) + jumlah;

  await supabase
    .from("ok_produk")
    .update({ terjual: newTerjual, updated_at: new Date().toISOString() })
    .eq("bot_id", botId)
    .eq("id", id);
}

// ── STOK ──────────────────────────────────────────────────────────────────────

async function getStokList(botId, produkId) {
  const { data, error } = await supabase
    .from("ok_stok")
    .select("*")
    .eq("bot_id", botId)
    .eq("produk_id", produkId)
    .eq("is_used", false)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getStokCount(botId, produkId) {
  const { count, error } = await supabase
    .from("ok_stok")
    .select("*", { count: "exact", head: true })
    .eq("bot_id", botId)
    .eq("produk_id", produkId)
    .eq("is_used", false);
  if (error) return 0;
  return count || 0;
}

async function addStok(botId, produkId, { email, password, profil, pin, a2f }) {
  const { error } = await supabase.from("ok_stok").insert({
    bot_id: botId,
    produk_id: produkId,
    email,
    password,
    profil: profil || null,
    pin: pin || null,
    a2f,
    is_used: false,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/**
 * Ambil 1 stok dan tandai is_used = true (FIFO)
 * Return: object stok | null
 */
async function popStok(botId, produkId) {
  // Ambil stok pertama yang belum dipakai
  const { data, error } = await supabase
    .from("ok_stok")
    .select("*")
    .eq("bot_id", botId)
    .eq("produk_id", produkId)
    .eq("is_used", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error || !data) return null;

  // Tandai as used
  await supabase
    .from("ok_stok")
    .update({ is_used: true, used_at: new Date().toISOString() })
    .eq("id", data.id);

  return {
    email:    data.email,
    password: data.password,
    profil:   data.profil,
    pin:      data.pin,
    a2f:      data.a2f,
  };
}

// ── SALDO BOT ─────────────────────────────────────────────────────────────────
// Saldo di sini adalah saldo PENDAPATAN milik bot rental itu sendiri (kolom
// `saldo` di tabel `telegram_bot_rentals`) — BUKAN saldo akun login owner di
// dashboard (itu kolom `balance` di tabel `profiles`, beda tabel & beda tujuan).
// Dipanggil cuma sekali, pas order katalog produk berstatus "completed",
// dengan amount = harga ASLI produk (produk.harga × jumlah), TANPA fee QRIS —
// fee itu biaya payment gateway, bukan pendapatan bot.

async function addBotSaldo(botId, amount) {
  const { data, error: fetchError } = await supabase
    .from("telegram_bot_rentals")
    .select("saldo")
    .eq("id", botId)
    .single();
  if (fetchError) throw new Error(fetchError.message);

  const newSaldo = Number(data?.saldo || 0) + Number(amount || 0);

  const { error } = await supabase
    .from("telegram_bot_rentals")
    .update({ saldo: newSaldo })
    .eq("id", botId);
  if (error) throw new Error(error.message);

  return newSaldo;
}

// ── ORDER KUOTA ───────────────────────────────────────────────────────────────
// Order tetap di-scope per bot_id juga, supaya laporan/cek status order bot A
// gak ke-mix sama order bot B walau order_id-nya sengaja dibikin unik global.
// Tabel ok_orders ini juga dipakai sebagai riwayat transaksi (trx) yang
// ditampilkan di halaman detail bot pada dashboard.

async function saveOrderKuota({
  botId, orderId, userId, chatId, produkId, produkNama,
  jumlah, harga, fee, totalAmount, status,
  paymentProvider, providerTrxId,
  buyerName, buyerUsername,
}) {
  const { error } = await supabase.from("ok_orders").upsert(
    {
      order_id:    orderId,
      bot_id:      botId,
      user_id:     String(userId),
      chat_id:     chatId,
      produk_id:   produkId,
      produk_nama: produkNama,
      jumlah,
      harga,
      fee,
      total_amount: totalAmount,
      status:       status || "pending_payment",
      payment_provider: paymentProvider || "pakasir",
      provider_trx_id:  providerTrxId || orderId,
      // Identitas pembeli (buat ditampilin di trx dashboard) — user_id Telegram
      // udah pasti ada, tapi nama & @username belum tentu (username bisa kosong
      // kalau orangnya emang gak set username di Telegram).
      buyer_name:     buyerName || null,
      buyer_username: buyerUsername || null,
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    },
    { onConflict: "order_id" }
  );
  if (error) throw new Error(error.message);
}

async function getOrderKuotaByOrderId(orderId) {
  const { data, error } = await supabase
    .from("ok_orders")
    .select("*")
    .eq("order_id", orderId)
    .single();
  if (error) return null;
  return data;
}

async function updateOrderKuotaStatus(orderId, status) {
  const update = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === "completed") update.completed_at = new Date().toISOString();

  await supabase.from("ok_orders").update(update).eq("order_id", orderId);
}

module.exports = {
  // Produk
  getProdukList,
  getProdukById,
  addProduk,
  editProduk,
  hapusProduk,
  incrementTerjual,
  getCustomEmoji,
  // Stok
  getStokList,
  getStokCount,
  addStok,
  popStok,
  // Order
  saveOrderKuota,
  getOrderKuotaByOrderId,
  updateOrderKuotaStatus,
  // Saldo bot
  addBotSaldo,
};
