const supabase = require("./supabase");

/**
 * Ambil data bot (token, owner_id, dll) dari tabel telegram_bot_rentals
 * berdasarkan ID row-nya. (dipakai kalau mau spesifik 1 row aja)
 */
async function getRentalConfig(rentalId) {
  if (!rentalId) {
    throw new Error(
      "❌ RENTAL_ID belum diset. Isi env var RENTAL_ID dengan id row di tabel telegram_bot_rentals (kolom 'id')."
    );
  }

  const { data, error } = await supabase
    .from("telegram_bot_rentals")
    .select("id, user_id, owner_id, label, bot_token, status, enabled_features, payment_provider, logo_url, start_text, maintenance_mode, maintenance_message")
    .eq("id", rentalId)
    .single();

  if (error || !data) {
    throw new Error(
      `❌ Tidak ditemukan rental dengan id: ${rentalId}. Cek lagi di Supabase table editor.`
    );
  }

  if (!data.bot_token) {
    throw new Error(`❌ Row rental id ${rentalId} tidak punya bot_token.`);
  }

  if (data.status === "inactive") {
    throw new Error(
      `⛔ Rental id ${rentalId} berstatus 'inactive' — bot tidak dijalankan.`
    );
  }

  return data;
}

/**
 * Ambil SEMUA rental langsung dari Supabase — tidak perlu set env var
 * apapun untuk daftar bot-nya. Row yang statusnya 'suspended'/'expired'
 * otomatis dilewati. Dipanggil sekali saat startup.
 */
async function getAllActiveRentals() {
  const { data, error } = await supabase
    .from("telegram_bot_rentals")
    .select("id, user_id, owner_id, label, bot_token, bot_username, status, enabled_features, payment_provider, logo_url, start_text, maintenance_mode, maintenance_message")
    .neq("status", "inactive");

  if (error) {
    throw new Error(`❌ Gagal ambil daftar rental dari Supabase: ${error.message}`);
  }

  const valid = (data || []).filter(r => !!r.bot_token);

  if (valid.length === 0) {
    throw new Error(
      "❌ Tidak ada row di telegram_bot_rentals yang punya bot_token dan status aktif."
    );
  }

  return valid;
}

/**
 * Update kolom status di row rental — dipanggil bot.js begitu berhasil
 * (atau gagal) connect, supaya dashboard web (Marketplace) nunjukin
 * status yang sesuai kenyataan, bukan cuma 'pending' selamanya.
 */
async function updateRentalStatus(rentalId, status) {
  const { error } = await supabase
    .from("telegram_bot_rentals")
    .update({ status })
    .eq("id", rentalId);

  if (error) {
    console.error(`⚠️ Gagal update status rental ${rentalId} -> ${status}:`, error.message);
  }
}

/**
 * Subscribe realtime ke perubahan row rental tertentu (khususnya kolom
 * enabled_features). Begitu admin toggle fitur di dashboard dan row-nya
 * ke-UPDATE di Supabase, callback `onChange` langsung dipanggil dengan
 * data row terbaru — tanpa perlu restart proses bot.
 *
 * PENTING: fitur Realtime harus di-enable dulu untuk tabel
 * `telegram_bot_rentals` di Supabase Dashboard → Database → Replication
 * (centang tabelnya), kalau belom di-enable, event ini gak akan pernah
 * kepanggil walau kodenya udah bener.
 *
 * Balikin fungsi `unsubscribe()` kalau butuh berhenti listen (opsional).
 */
function subscribeToRentalChanges(rentalId, onChange) {
  const channel = supabase
    .channel(`rental-features-${rentalId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "telegram_bot_rentals",
        filter: `id=eq.${rentalId}`,
      },
      (payload) => {
        try {
          onChange(payload.new);
        } catch (err) {
          console.error(`⚠️ Error handling realtime update rental ${rentalId}:`, err.message);
        }
      }
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(
          `⚠️ Realtime channel rental ${rentalId} gagal (${status}). ` +
          `Cek apakah Replication untuk tabel telegram_bot_rentals sudah di-enable di Supabase Dashboard.`,
          err?.message || ""
        );
      }
    });

  return () => supabase.removeChannel(channel);
}

/**
 * Listen realtime buat rental BARU (INSERT) atau rental yang diaktifkan
 * lagi (UPDATE status dari 'inactive' -> selain 'inactive') di tabel
 * telegram_bot_rentals — dipanggil lewat `onRentalShouldStart`.
 *
 * Ini yang bikin "tambah row di Supabase = bot baru langsung jalan"
 * TANPA perlu restart proses sama sekali. Sebelumnya daftar rental cuma
 * di-fetch SEKALI doang pas `main()` start (lewat getAllActiveRentals),
 * jadi row baru gak akan ke-pickup sampai proses di-restart manual.
 *
 * Juga listen buat rental yang DIHAPUS (DELETE) atau di-nonaktifkan
 * (UPDATE status -> 'inactive') — dipanggil lewat `onRentalShouldStop`,
 * supaya bot.js bisa `stopPolling()` instance yang bersangkutan. Tanpa
 * ini, hapus/nonaktifkan row di dashboard cuma ngubah database — proses
 * bot yang sudah jalan di memory gak pernah tau dan terus polling.
 *
 * PENTING: sama kayak subscribeToRentalChanges, fitur Realtime harus
 * di-enable dulu untuk tabel `telegram_bot_rentals` di Supabase
 * Dashboard → Database → Replication.
 *
 * Cukup dipanggil SEKALI di bot.js (bukan per-rental), makanya nama
 * channel-nya fixed/global — beda dengan restock-listener yang harus
 * unik per instance karena dipanggil di dalam loop per-rental.
 */
function subscribeToRentalLifecycle(onRentalShouldStart, onRentalShouldStop) {
  const channel = supabase
    .channel("rental-lifecycle-listener")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "telegram_bot_rentals" },
      (payload) => {
        try {
          onRentalShouldStart(payload.new);
        } catch (err) {
          console.error("⚠️ Error handling realtime INSERT rental baru:", err.message);
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "telegram_bot_rentals" },
      (payload) => {
        try {
          // PENTING: JANGAN cek payload.old?.status di sini. Secara default
          // Supabase Realtime cuma ngirim PRIMARY KEY doang di payload.old
          // (bukan seluruh kolom row lama) kecuali REPLICA IDENTITY tabel
          // di-set ke FULL. Jadi payload.old?.status hampir selalu
          // `undefined` -> kondisi "old === inactive" gak akan pernah
          // ke-detect -> reaktivasi manual dari dashboard/Supabase gak
          // pernah nge-trigger start bot. Ini akar masalah "udah diubah ke
          // active tapi bot tetep offline".
          //
          // Solusinya: gak usah tebak-tebak transisi status dari payload.
          // Cukup panggil onRentalShouldStart tiap ada UPDATE — pengecekan
          // "udah jalan belom" (runningRentals) dan "status valid gak"
          // udah di-handle di sisi caller (bot.js), jadi aman dipanggil
          // berkali-kali / gak perlu tau status lama.
          if (payload.new?.status && payload.new.status !== "inactive") {
            onRentalShouldStart(payload.new);
          } else if (payload.new?.status === "inactive") {
            // Admin nonaktifkan/suspend bot dari dashboard sementara
            // prosesnya masih jalan — matikan polling-nya sekarang juga.
            onRentalShouldStop(payload.new.id, "suspended");
          }
        } catch (err) {
          console.error("⚠️ Error handling realtime UPDATE rental (reaktivasi/nonaktifkan):", err.message);
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "telegram_bot_rentals" },
      (payload) => {
        try {
          // Row-nya dihapus total dari dashboard/Supabase — matikan bot
          // yang lagi jalan buat rental ini. payload.old cuma berisi kolom
          // primary key (`id`) secara default, itu udah cukup buat lookup
          // instance-nya di runningRentals/botInstances.
          const deletedId = payload.old?.id;
          if (deletedId) onRentalShouldStop(deletedId, "deleted");
        } catch (err) {
          console.error("⚠️ Error handling realtime DELETE rental:", err.message);
        }
      }
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log("✅ Listener rental baru aktif — nambah/hapus/nonaktifkan rental di Supabase langsung ke-detect, gak perlu restart.");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(
          `⚠️ Realtime channel rental-lifecycle gagal (${status}). ` +
          `Cek apakah Replication untuk tabel telegram_bot_rentals sudah di-enable di Supabase Dashboard.`,
          err?.message || ""
        );
      }
    });

  return () => supabase.removeChannel(channel);
}

module.exports = { getRentalConfig, getAllActiveRentals, updateRentalStatus, subscribeToRentalChanges, subscribeToRentalLifecycle };
