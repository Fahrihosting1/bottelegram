/**
 * GOPAY MERCHANT (QRIS statis → dinamis) — provider payment ke-2 buat bot,
 * di luar Pakasir. Ini port 1:1 dari `lib/qris.ts` yang sudah jalan di web
 * (dashboard) buat fitur deposit wallet — jadi kredensial & endpoint-nya
 * SAMA PERSIS dengan yang di web, biar admin cukup isi sekali di Supabase/env.
 *
 * Env yang dibutuhkan (isi di .env bot, sama kayak punya web):
 *  - QRIS_BASE_URL    (opsional, default https://fahri.otpcepet.site)
 *  - QRIS_STATIC_CODE (wajib — kode QRIS statis merchant/GoPay)
 *  - QRIS_OTP_TOKEN   (wajib — buat cek mutasi)
 *  - QRIS_API_KEY     (opsional, default "freeApikey")
 */

const axios = require("axios");
const {
  QRIS_BASE_URL,
  QRIS_STATIC_CODE,
  QRIS_OTP_TOKEN,
  QRIS_API_KEY,
} = require("../config");

const BASE_URL = QRIS_BASE_URL || "https://fahri.otpcepet.site";

/**
 * Bikin QRIS dinamis buat nominal tertentu. Providernya nambahin "kode unik"
 * kecil di atas nominal (field `fee` di response) supaya pembayaran yang
 * masuk bisa dicocokkan balik ke transaksi ini secara pasti.
 *
 * Return shape (field-field penting):
 *  { id_transaksi, status, amount_base, fee, amount_final,
 *    qris_dynamic, qr_image_url, qr_image_url_hd, created_at, expired_at }
 */
async function gopayCreate(amount) {
  if (!QRIS_STATIC_CODE) {
    throw new Error("QRIS_STATIC_CODE belum diset di .env — dibutuhkan buat GoPay Merchant.");
  }

  const url = `${BASE_URL}/qris/create?amount=${encodeURIComponent(amount)}&codeqr=${encodeURIComponent(QRIS_STATIC_CODE)}`;

  let res;
  try {
    res = await axios.get(url);
  } catch (err) {
    throw new Error(err?.response?.data?.message || err.message || "GoPay Merchant create gagal");
  }

  const json = res.data;
  if (!json?.success || !json?.data) {
    throw new Error(json?.message || `GoPay Merchant create gagal (HTTP ${res.status})`);
  }

  return json.data;
}

/**
 * Cek apakah pembayaran yang cocok sama `idTransaksi` udah masuk.
 * Balikin `null` kalau belum ada apa-apa / masih pending — itu kondisi
 * normal, BUKAN error.
 */
async function gopayCheckStatus(idTransaksi) {
  if (!QRIS_OTP_TOKEN) {
    throw new Error("QRIS_OTP_TOKEN belum diset di .env — dibutuhkan buat GoPay Merchant.");
  }
  const apiKey = QRIS_API_KEY || "freeApikey";

  const url =
    `${BASE_URL}/mutasi/${encodeURIComponent(idTransaksi)}` +
    `?otp_token=${encodeURIComponent(QRIS_OTP_TOKEN)}&apikey=${encodeURIComponent(apiKey)}`;

  try {
    const res = await axios.get(url);
    const json = res.data;
    if (!json?.success || !json?.transaksi) return null;
    return json.transaksi; // { status, kategori, jumlah_raw, waktu, id_qr, qris_matched, gopay_tx_id?, order_id? }
  } catch (_) {
    // Perlakukan error jaringan/404 sebagai "belum bayar" — sama kayak web,
    // biar polling loop gak berhenti gara-gara 1x gagal fetch.
    return null;
  }
}

/**
 * Batalin transaksi yang masih pending di sisi provider. Best-effort —
 * provider sendiri yang nolak kalau transaksinya udah settled.
 */
async function gopayCancel(idTransaksi) {
  const url = `${BASE_URL}/transaksi/${encodeURIComponent(idTransaksi)}/cancel`;
  try {
    const res = await axios.patch(url, {}, { headers: { "Content-Type": "application/json" } });
    return res.data;
  } catch (_) {
    return null;
  }
}

module.exports = { gopayCreate, gopayCheckStatus, gopayCancel };
