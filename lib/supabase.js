const { createClient } = require("@supabase/supabase-js");

// PENTING: JANGAN hardcode URL/key Supabase di sini. Sebelumnya key
// service_role (akses penuh, bypass semua RLS) ke-hardcode langsung di
// source code — kalau file ini pernah ke-share/ke-push ke repo, siapa aja
// yang pegang file ini bisa baca/tulis/hapus SELURUH database. Key yang
// lama HARUS di-rotate dari Supabase Dashboard -> Project Settings -> API
// -> "Reset service_role secret", baru isi key yang baru di env var di
// bawah (jangan pernah commit .env ke git).
const SUPABASE_URL = "https://itllcyjbhjkvyqilgtrd.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml0bGxjeWpiaGprdnlxaWxndHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Mjg0MDk4NSwiZXhwIjoyMDk4NDE2OTg1fQ.rDBC0Coh0eJlGi5bMS3FfWOjlbq9foCNe_xsJe0x-UM" || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "❌ SUPABASE_URL / SUPABASE_ANON_KEY belum diset di .env — bot tidak akan jalan tanpa ini."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

module.exports = supabase;
