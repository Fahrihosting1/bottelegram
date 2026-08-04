# Telegram Bot - Order System

Bot Telegram untuk pembelian VPS Linode dengan pembayaran via Saldo atau QRIS (Pakasir).

## Fitur

### /buyvps - Beli VPS Linode
- Full button-based UI (tanpa perlu mengetik command)
- Pilihan paket VPS:
  - 2GB RAM / 1 Core - Rp 50.000/bulan
  - 4GB RAM / 2 Core - Rp 100.000/bulan
  - 8GB RAM / 4 Core - Rp 200.000/bulan
  - 16GB RAM / 8 Core - Rp 400.000/bulan
- Pilih metode pembayaran (Saldo / QRIS Pakasir)
- Invoice detail lengkap
- Tombol: Bayar Sekarang / Cancel / Kembali ke Home
- Auto-create VPS setelah pembayaran berhasil

### /deposit <jumlah> - Isi Saldo
- Minimal deposit Rp 5.000
- Pembayaran via QRIS Pakasir
- Auto-check status pembayaran
- Progress bar real-time

### /saldo - Cek Saldo
- Lihat saldo terkini

### /history - Riwayat Transaksi (NEW!)
- Lihat SEMUA riwayat transaksi (deposit, beli VPS, dll)
- Filter berdasarkan tipe transaksi (Deposit, VPS, dll)
- Filter berdasarkan status (Sukses, Pending, Cancelled, Expired)
- Label status: pending, processing, completed, cancelled, expired, failed
- Label tipe: deposit, buy_vps, buy_domain, buy_hosting, dll

### /stats - Statistik Transaksi (NEW!)
- Total transaksi
- Breakdown: sukses, pending, cancelled, expired, failed
- Total deposit sukses
- Total belanja sukses
- Breakdown per kategori

### /vpshistory - Riwayat VPS
- Lihat 10 transaksi VPS terakhir

## Setup

### 1. Install Dependencies
```bash
cd bot
npm install
```

### 2. Konfigurasi Environment Variables

Edit `config.js` atau set environment variables:

```bash
# Telegram
TELEGRAM_TOKEN=your_telegram_bot_token

# Linode
LINODE_API_TOKEN=your_linode_api_token

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# Pakasir
PAKASIR_API_KEY=your_pakasir_api_key
PAKASIR_PROJECT=your_pakasir_project

# Channel & Broadcast (opsional)
OWNER_ID=your_telegram_user_id
LOG_CHANNEL_ID=-100xxxxxxxxxx      # Channel notif transaksi (opsional)
BROADCAST_CHANNEL_ID=-100xxxxxxxxxx  # Channel broadcast restock (opsional)
```

### 3. Setup Database

Jalankan SQL migration di Supabase SQL Editor:
- Buka file `supabase_migration.sql`
- Copy dan paste ke Supabase SQL Editor
- Run query

### 4. Jalankan Bot
```bash
npm start
# atau
npm run dev  # dengan auto-reload
```

## Struktur File

```
bot/
├── bot.js                    # Entry point
├── config.js                 # Konfigurasi
├── package.json              # Dependencies
├── supabase_migration.sql    # Database schema
├── commands/
│   ├── deposit/
│   │   └── deposit.js        # Command /deposit, /saldo
│   ├── buyvps/
│   │   └── linode.js         # Command /buyvps, /vpshistory
│   └── history/
│       └── history.js        # Command /history, /stats (NEW!)
└── lib/
    ├── supabase.js           # Supabase client
    └── pakasir.js            # Pakasir API, Saldo & Transaction functions
```

## Database Tables

### `transactions` (UNIFIED HISTORY - NEW!)
Menyimpan SEMUA transaksi dengan field:
| Field | Deskripsi |
|-------|-----------|
| `order_id` | ID unik transaksi |
| `user_id` | Telegram user ID |
| `type` | Tipe: 'deposit', 'buy_vps', 'buy_domain', dll |
| `status` | Status: 'pending', 'processing', 'completed', 'cancelled', 'expired', 'failed' |
| `amount` | Nominal transaksi |
| `fee` | Biaya admin |
| `payment_method` | 'saldo' atau 'qris' |
| `product_id` | ID produk (untuk pembelian) |
| `product_name` | Nama produk |
| `metadata` | Data tambahan (JSONB) |

### `vps_orders`
Detail spesifik untuk order VPS:
- `linode_id`, `ip_address`, `root_password`, `label`

### `saldo`
Saldo user

### `saldo_history`
Riwayat perubahan saldo

### `deposits`
Pending deposit (untuk polling QRIS)

## Flow Transaksi

### Deposit
1. User: `/deposit 50000`
2. Bot buat QRIS via Pakasir
3. Bot polling cek pembayaran setiap 5 detik
4. Jika sukses: topup saldo + save ke `transactions` (status: completed)
5. Jika expired: update `transactions` (status: expired)
6. Jika cancel: update `transactions` (status: cancelled)

### Beli VPS
1. User: `/buyvps` -> Pilih paket -> Pilih pembayaran
2. Save ke `transactions` (status: pending)
3. Jika Saldo: deduct saldo langsung
4. Jika QRIS: buat QRIS + polling
5. Setelah bayar: create VPS di Linode
6. Update `transactions` (status: completed) + save ke `vps_orders`

### Lihat History
1. User: `/history`
2. Bot query tabel `transactions`
3. Tampilkan dengan filter tipe/status + statistik

## API yang Digunakan

- **Telegram Bot API** - Bot interface
- **Linode API v4** - Create VPS instances
- **Pakasir API** - QRIS payment gateway
- **Supabase** - Database storage
