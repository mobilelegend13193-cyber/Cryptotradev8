# Crypto AI Monitor — Node.js Service

Monitor harga crypto real-time + auto-scan signal (LONG/SHORT) menggunakan Binance WebSocket + 12+ indikator teknikal. Dirancang untuk jalan **24/7 di Render Free Tier** (512 MB RAM).

## 📁 Struktur File

```
render-service/
├── server.js          # Express + WebSocket + analisa
├── package.json       # Dependencies (express, ws)
├── public/
│   └── index.html     # Dashboard (auto-refresh /api/data)
├── .gitignore
└── README.md
```

## 🚀 Deploy ke Render

### 1. Push ke GitHub
Buat repo baru di GitHub, lalu upload isi folder `render-service/` (bukan folder-nya, tapi isinya — `server.js`, `package.json`, `public/`, dll).

```bash
cd render-service
git init
git add .
git commit -m "init"
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

### 2. Buat Web Service di Render
1. Login ke [render.com](https://render.com) → **New** → **Web Service**
2. Connect GitHub repo Anda
3. Isi konfigurasi:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
4. (Opsional) **Environment Variables**:
   | Key | Default | Deskripsi |
   |---|---|---|
   | `TIMEFRAME` | `1h` | Timeframe klines (`5m`, `15m`, `1h`, `4h`, `1d`) |
   | `SCAN_TOP_N` | `40` | Jumlah koin di-scan per cycle (max 100) |
   | `SCAN_INTERVAL_MS` | `300000` | Interval scan (ms). Default 5 menit |

5. Klik **Create Web Service** → tunggu build selesai.
6. Render akan kasih URL: `https://NAMA-SERVICE.onrender.com`

### 3. Keep-Alive dengan UptimeRobot
Render Free Tier akan **tidur setelah 15 menit tanpa traffic**. Solusi:

1. Daftar di [uptimerobot.com](https://uptimerobot.com)
2. **Add New Monitor**:
   - Type: `HTTP(s)`
   - URL: `https://NAMA-SERVICE.onrender.com/ping`
   - Interval: `5 minutes`
3. Simpan. UptimeRobot akan ping tiap 5 menit → server tetap hidup.

## 🌐 Endpoints

| Endpoint | Deskripsi |
|---|---|
| `GET /` | Dashboard HTML (auto-refresh 5s) |
| `GET /api/data` | JSON lengkap: signals + prices + stats |
| `GET /api/prices` | JSON ringan: hanya live prices |
| `GET /ping` | Keep-alive untuk UptimeRobot |
| `GET /health` | Health check + memory usage |

## 🧠 Cara Kerja

1. **WebSocket** (`wss://stream.binance.com:9443/ws/!miniTicker@arr`) → terima update harga semua pair USDT setiap detik, disimpan di memory.
2. **Scan cycle** (default 5 menit) → fetch top N koin by volume → ambil klines 220 bar → hitung 12+ indikator → generate signal + score.
3. **Signal scoring**:
   - Indikator: EMA stack, RSI, MACD, Stochastic, Bollinger, ADX, CCI, MFI, VWAP, Supertrend, OBV, ATR
   - Score 0–100 berdasarkan konsensus bull vs bear
   - `LONG` jika ≥60% bull, `SHORT` jika ≥60% bear
   - Entry/SL/TP otomatis berdasarkan ATR (1.5× SL, 2×/3.5× TP)
4. **Dashboard** polling `/api/data` setiap 5 detik → tampilkan top signals + live price overlay.

## 💾 Optimasi Memori (Render Free Tier)

- **Tidak simpan history klines** — hanya hasil analisa ringkas (~20 field per symbol)
- **Tidak simpan tick-by-tick** — hanya harga terakhir per symbol
- **`perMessageDeflate: false`** di WebSocket → hemat CPU decompress
- Rata-rata penggunaan memori: **~60–90 MB** (jauh di bawah limit 512 MB)

Cek: `GET /health` → field `memMB`.

## ⚙️ Konfigurasi Lanjutan

Ubah via environment variable di Render dashboard **tanpa redeploy** (restart otomatis):

```bash
TIMEFRAME=4h           # lebih sedikit noise, signal lebih kuat
SCAN_TOP_N=60          # scan lebih banyak koin
SCAN_INTERVAL_MS=600000 # scan tiap 10 menit (hemat rate limit)
```

## 🔒 Disclaimer

Ini adalah tool monitoring/analisa, **bukan saran finansial**. Semua signal hanya berdasarkan analisa teknikal historis. Selalu DYOR.
