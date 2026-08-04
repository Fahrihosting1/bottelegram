-- Jalankan di Supabase Dashboard -> SQL Editor.
-- Nambah kolom logo_url ke tabel telegram_bot_rentals supaya tiap bot
-- rental bisa punya gambar/logo sendiri-sendiri (di-set dari web dashboard,
-- bukan hardcode di source code bot).

alter table telegram_bot_rentals
  add column if not exists logo_url text;

comment on column telegram_bot_rentals.logo_url is
  'URL publik gambar/logo bot ini (mis. link file di Supabase Storage). '
  'Dipakai bot.js untuk foto /start dan foto list produk. '
  'Kalau NULL/kosong, bot fallback ke logo default lokal (media/biyu_logo.jpg).';

alter table telegram_bot_rentals
  add column if not exists start_text text;

comment on column telegram_bot_rentals.start_text is
  'Teks caption custom buat pesan /start bot ini (boleh pakai tag HTML '
  'sederhana yang didukung Telegram: <b>, <i>, <blockquote>, dst — bot '
  'kirim dengan parse_mode HTML). Kalau NULL/kosong, bot fallback ke teks '
  'default yang di-hardcode di commands/start/start.js.';
