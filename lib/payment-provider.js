/**
 * PAYMENT PROVIDER — lapisan abstraksi di atas Pakasir & GoPay Merchant.
 * ─────────────────────────────────────────────────────────────────
 * Tujuannya: kode fitur (orderkuota.js, dan nanti fitur lain kalau mau)
 * gak perlu tau detail tiap provider. Cukup panggil createPayment /
 * checkPayment / cancelPayment dengan nama provider ('pakasir' | 'gopay'),
 * hasilnya selalu dalam bentuk yang SAMA.
 *
 * Provider yang aktif buat 1 bot ditentuin lewat kolom `payment_provider`
 * di tabel `telegram_bot_rentals` (di-set admin lewat dashboard web),
 * disambungkan ke `bot.paymentProvider` — persis pola yang sama kayak
 * `bot.features` di lib/features.js (realtime, gak perlu restart proses).
 *
 * PENTING soal ID transaksi:
 *  - Pakasir: kita yang generate `orderId`, dan Pakasir pakai ID itu apa
 *    adanya buat create/check/cancel.
 *  - GoPay Merchant: providernya generate `id_transaksi` SENDIRI (beda
 *    string dari `orderId` kita). Makanya createPayment() balikin field
 *    `providerTrxId` terpisah — itu yang WAJIB dipakai buat checkPayment/
 *    cancelPayment nanti, bukan `orderId` internal kita.
 */

const {
  createTransaction: pakasirCreate,
  checkTransaction: pakasirCheck,
  cancelTransaction: pakasirCancel,
} = require("./pakasir");
const { gopayCreate, gopayCheckStatus, gopayCancel } = require("./gopay-merchant");
const { PAKASIR_API_KEY, PAKASIR_PROJECT } = require("../config");

const PROVIDERS = ["pakasir", "gopay"];
const DEFAULT_PROVIDER = "pakasir";

const PROVIDER_LABELS = {
  pakasir: "Pakasir",
  gopay: "GoPay Merchant (QRIS)",
};

function normalizeProvider(value) {
  return PROVIDERS.includes(value) ? value : DEFAULT_PROVIDER;
}

/**
 * Bikin transaksi QRIS baru lewat provider yang lagi aktif.
 *
 * Return (selalu bentuk ini apapun providernya):
 *  {
 *    provider,          'pakasir' | 'gopay'
 *    providerTrxId,      ID yang WAJIB dipakai buat check/cancel selanjutnya
 *    qrisString,         raw QRIS payload buat di-render jadi QR sendiri (Pakasir) — null kalau gak ada
 *    qrImageUrl,          link gambar QR siap pakai (GoPay Merchant) — null kalau gak ada
 *    qrImageUrlHd,
 *    fee,
 *    totalPayment,       nominal FINAL yang harus dibayar (base + fee/kode unik)
 *    expiredAt,
 *    raw,                response asli dari provider, buat debugging/log
 *  }
 */
async function createPayment(provider, { orderId, amount }) {
  provider = normalizeProvider(provider);

  if (provider === "gopay") {
    const data = await gopayCreate(amount);
    return {
      provider: "gopay",
      providerTrxId: data.id_transaksi,
      qrisString: null,
      qrisRawPayload: data.qris_dynamic || null, // buat render QR styled per-modul (lib/qr-style.js)
      qrImageUrl: data.qr_image_url || null,
      qrImageUrlHd: data.qr_image_url_hd || null,
      fee: data.fee || 0,
      totalPayment: data.amount_final ?? amount,
      expiredAt: data.expired_at || null,
      raw: data,
    };
  }

  // default: pakasir
  const txResult = await pakasirCreate({
    orderId,
    amount,
    apiKey: PAKASIR_API_KEY,
    project: PAKASIR_PROJECT,
    method: "qris",
  });
  const payment = txResult?.payment || txResult;
  return {
    provider: "pakasir",
    providerTrxId: orderId,
    qrisString: payment?.payment_number || null,
    qrImageUrl: null,
    qrImageUrlHd: null,
    fee: payment?.fee || 0,
    totalPayment: payment?.total_payment ?? amount,
    expiredAt: payment?.expired_at || null,
    raw: txResult,
  };
}

/**
 * Cek status transaksi. `providerTrxId` & `totalPayment` HARUS hasil dari
 * createPayment() yang sama — jangan campur antar provider di 1 order.
 *
 * Return: { status: 'pending' | 'completed' | 'expired' | 'failed' | <status lain dari provider>, raw }
 */
async function checkPayment(provider, { providerTrxId, amount, totalPayment }) {
  provider = normalizeProvider(provider);

  if (provider === "gopay") {
    const trx = await gopayCheckStatus(providerTrxId);
    if (!trx || trx.status !== "success" || !trx.qris_matched) {
      return { status: "pending", raw: trx };
    }
    // Cocokkan nominal PERSIS ke nominal final (base + kode unik) sebelum
    // dianggap lunas — sama kayak pengecekan di web (deposit/status).
    if (Number(trx.jumlah_raw) !== Number(totalPayment)) {
      return { status: "pending", raw: trx };
    }
    return { status: "completed", raw: trx };
  }

  // default: pakasir
  const result = await pakasirCheck({
    orderId: providerTrxId,
    amount,
    apiKey: PAKASIR_API_KEY,
    project: PAKASIR_PROJECT,
  });
  const trx = result?.transaction;
  const status = trx?.status;
  if (!status) return { status: "pending", raw: result };
  return { status, raw: result };
}

/**
 * Batalin transaksi yang masih pending. Best-effort, gak throw.
 */
async function cancelPayment(provider, { providerTrxId, amount }) {
  provider = normalizeProvider(provider);
  try {
    if (provider === "gopay") {
      await gopayCancel(providerTrxId);
    } else {
      await pakasirCancel({ orderId: providerTrxId, amount, apiKey: PAKASIR_API_KEY, project: PAKASIR_PROJECT });
    }
  } catch (_) {
    // sengaja ditelen — perilaku lama juga gitu (cancel gak penting2 amat kalau gagal)
  }
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  PROVIDER_LABELS,
  normalizeProvider,
  createPayment,
  checkPayment,
  cancelPayment,
};
