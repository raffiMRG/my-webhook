# my-webhook

Tool pengembangan lokal untuk menerima dan menginspeksi HTTP callback (webhook) dari project lain — terinspirasi dari [webhook.site](https://webhook.site). Dirancang untuk berjalan di server lokal jaringan rumah/kantor dan dapat di-forward ke IP publik.

---

## Fitur

- **Terima semua HTTP method** — GET, POST, PUT, PATCH, DELETE, dsb.
- **Dashboard real-time** — request masuk langsung muncul tanpa reload (Server-Sent Events)
- **Inspeksi lengkap** — lihat headers, query params, dan body (auto pretty-print JSON)
- **Multi-user** — login & register, setiap user punya webhook URL masing-masing
- **Forward/relay** — teruskan request yang masuk ke endpoint lain (opsional per token)
- **Notifikasi desktop** — browser notification saat ada request baru (opsional)
- **Database PostgreSQL** — semua data persisten, tidak hilang saat container di-restart
- **Docker ready** — satu perintah untuk menjalankan app + database

---

## Teknologi

| Komponen | Stack |
|----------|-------|
| Runtime | Node.js 24 |
| Web framework | Express.js |
| Database | PostgreSQL 17 |
| Autentikasi | Session cookie + password hashing (scrypt) |
| Real-time | Server-Sent Events (SSE) |
| Frontend | Vanilla HTML/CSS/JS (tanpa framework/build step) |
| Containerisasi | Docker + Docker Compose |

---

## Cara Menjalankan

### Dengan Docker (direkomendasikan)

Pastikan Docker dan Docker Compose sudah terinstall.

```bash
# Clone / masuk ke direktori project
cd my-webhook

# Jalankan (pertama kali otomatis buat database dan tabel)
docker compose up -d

# Buka dashboard
# http://localhost:3000
```

Ganti port host (default 3000):
```bash
PORT=8080 docker compose up -d
```

Lihat log:
```bash
docker compose logs -f           # semua service
docker compose logs app -f       # hanya aplikasi
docker compose logs postgres -f  # hanya database
```

Stop:
```bash
docker compose down        # stop — data tetap ada
docker compose down -v     # stop + hapus semua data (tidak bisa dikembalikan)
```

---

### Tanpa Docker (local dev)

**Prasyarat:** Node.js 22+ dan PostgreSQL berjalan.

Cara termudah: jalankan PostgreSQL via Docker, app-nya langsung:

```bash
# Jalankan hanya PostgreSQL
docker compose up postgres -d

# Install dependencies
npm install

# Jalankan app
DATABASE_URL=postgresql://webhook:webhook_pass@localhost:5432/webhooks node server.js

# Atau dengan npm
npm start
```

Hot-reload saat development:
```bash
npm run dev
```

---

## Konfigurasi

Semua konfigurasi lewat environment variable.

| Variable | Default | Keterangan |
|----------|---------|------------|
| `PORT` | `3000` | Port yang didengarkan app |
| `DATABASE_URL` | `postgresql://webhook:webhook_pass@localhost:5432/webhooks` | Koneksi PostgreSQL |
| `SESSION_SECRET` | *(auto-generate ke file)* | Secret untuk signing session cookie |

Di Docker, nilai-nilai ini sudah diset di `docker-compose.yml`. Untuk production, **ganti** `POSTGRES_PASSWORD` dan `SESSION_SECRET` dengan nilai acak yang kuat.

---

## Struktur Project

```
my-webhook/
├── server.js          # Express server — routing, auth, SSE, webhook receiver
├── db.js              # Query PostgreSQL (pg Pool)
├── public/
│   ├── index.html     # Dashboard (halaman utama)
│   ├── app.js         # Frontend logic — token list, SSE, request detail
│   ├── login.html     # Halaman login
│   └── register.html  # Halaman registrasi
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Cara Pakai

### 1. Register & Login

Buka `http://<server-ip>:3000` → diarahkan ke halaman register jika belum ada akun.

### 2. Buat Webhook URL

Klik tombol **+ New** di sidebar → URL unik langsung tersedia:
```
http://<server-ip>:3000/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 3. Gunakan di Project Lain

Set URL tersebut sebagai callback/webhook di project lain yang sedang dikembangkan:

```bash
# Contoh — kirim test webhook
curl -X POST http://192.168.0.123:3000/hook/<token-id> \
  -H "Content-Type: application/json" \
  -d '{"event": "payment.success", "order_id": 42}'
```

### 4. Inspeksi Request

Request muncul real-time di dashboard. Klik request untuk melihat:
- Method & path lengkap
- IP pengirim & timestamp
- Query parameters
- Semua headers
- Body (JSON di-format otomatis)

### 5. Forward (Opsional)

Isi kolom **Forward URL** di dashboard → setiap request yang masuk diteruskan ke endpoint tersebut secara otomatis.

---

## Tampilan Frontend

### Halaman Login / Register

```
        ⚡ my-webhook

  ┌─────────────────────────────────┐
  │     Sign in to your account     │
  │                                 │
  │  Username                       │
  │  ┌─────────────────────────┐    │
  │  │                         │    │
  │  └─────────────────────────┘    │
  │                                 │
  │  Password                       │
  │  ┌─────────────────────────┐    │
  │  │                         │    │
  │  └─────────────────────────┘    │
  │                                 │
  │  ┌─────────────────────────┐    │
  │  │         Sign in         │    │
  │  └─────────────────────────┘    │
  └─────────────────────────────────┘

     Don't have an account? Register here
```

---

### Dashboard Utama

Layout tiga kolom dengan tema gelap (dark mode):

```
┌────────────────────┬──────────────────────────────────┬──────────────────────────────┐
│ ⚡ my-webhook  +New│  Webhook URL                     │  REQUEST DETAIL              │
├────────────────────│  http://192.168.0.123:3000/     │                              │
│ Logged in as mrg   │  hook/3e523dbf...  [Copy]        │  POST                        │
│              Logout│                                  │  /hook/3e523dbf-...          │
├────────────────────│  Forward URL (optional)          │                              │
│ > 3e523dbf…        │  [http://localhost:8080/cb][Save]│  Received  27/06/2026 15:30  │
│   a1b2c3d4…        │  [Delete]                        │  From IP   192.168.0.143     │
│                    ├──────────────────────────────────│  Request # 2                 │
│                    │ ● 2 requests  [🔔 Notify: Off]   │                              │
│                    │              [Clear All]          │  Headers                     │
│                    ├──────────────────────────────────│  content-type  app/json      │
│                    │ POST  just now  192.168.0.143     │  user-agent    curl/8.5      │
│                    │ POST  1m ago    192.168.0.143     │  ...                         │
│                    │                                  │                              │
│                    │                                  │  Body                        │
│                    │                                  │  {                           │
│                    │                                  │    "event": "payment.ok",    │
│                    │                                  │    "order_id": 42            │
│                    │                                  │  }                           │
└────────────────────┴──────────────────────────────────┴──────────────────────────────┘
```

**Kolom kiri — Sidebar token:**
- Daftar semua webhook URL milik user yang login
- Tombol `+ New` untuk membuat token baru
- Info user yang sedang login + tombol Logout

**Kolom tengah — Panel token:**
- URL webhook yang bisa langsung di-copy
- Input forward URL (opsional)
- Daftar request yang masuk secara real-time
- Setiap item menampilkan: method badge berwarna, waktu relatif, IP pengirim
- Indikator koneksi SSE (● hijau = terhubung)

**Kolom kanan — Detail request:**
- Muncul saat klik salah satu request
- Menampilkan semua informasi request secara lengkap
- Body JSON di-format otomatis (pretty-print)

**Method badge berwarna:**

| Method | Warna |
|--------|-------|
| `GET` | Hijau |
| `POST` | Biru |
| `PUT` | Kuning |
| `PATCH` | Ungu |
| `DELETE` | Merah |

---

## Database

PostgreSQL dengan 3 tabel:

```
users
  id · username · password_hash · password_salt · created_at

tokens
  id (UUID) · user_id → users · created_at · forward_url

requests
  id · token_id → tokens · received_at · method · path
  query (JSONB) · headers (JSONB) · body · ip
```

Data disimpan di Docker named volume `pg_data` (`/var/lib/postgresql/data`).
Volume **tidak terhapus** saat `docker compose down` — hanya hilang jika `docker compose down -v`
atau `docker volume rm my-webhook_pg_data`.

---

## Akses dari Jaringan Lokal

Jika app berjalan di server `192.168.0.123`:

```bash
# Dashboard
http://192.168.0.123:3000

# Webhook URL format
http://192.168.0.123:3000/hook/<token-id>
```

Untuk akses dari internet, forward port `3000` (atau port yang dipakai) dari router ke IP server lokal.
