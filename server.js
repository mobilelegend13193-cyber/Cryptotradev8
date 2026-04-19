/**
 * ═══════════════════════════════════════════════════════════
 *  CRYPTO AI ULTIMATE — Node.js Background Service
 *  Optimized for Render Free Tier (512MB RAM)
 * ═══════════════════════════════════════════════════════════
 *
 *  Fitur:
 *   - WebSocket Binance !miniTicker@arr  (realtime price semua USDT pair)
 *   - Auto-reconnect + ping/pong keepalive
 *   - Scan periodik top-N koin (klines 220 bar)  → 20+ indikator inti
 *   - Signal scoring (0-100) + LONG/SHORT/NEUTRAL
 *   - HTTP endpoints:
 *        GET  /            → Dashboard HTML (auto-refresh)
 *        GET  /api/data    → JSON lengkap (prices, signals, stats)
 *        GET  /api/prices  → JSON hanya harga live
 *        GET  /ping        → keep-alive (untuk UptimeRobot)
 *        GET  /health      → health-check
 *
 *  Memory strategy:
 *   - Hanya simpan harga terakhir per symbol (bukan seluruh history)
 *   - Analisa disimpan hanya objek ringkas (bukan array klines)
 *   - Batasi jumlah symbol yang di-scan (default 50)
 *   - GC manual setelah setiap cycle scan
 * ═══════════════════════════════════════════════════════════
 */

const express = require('express');
const WebSocket = require('ws');
const path = require('path');

// ═══ CONFIG ════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const WS_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const API_PUB = 'https://data-api.binance.vision/api/v3';

// Berapa banyak koin di-scan tiap cycle (by volume 24h)
const SCAN_TOP_N = parseInt(process.env.SCAN_TOP_N || '40', 10);
// Interval scan (ms) — default 5 menit
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '300000', 10);
// Timeframe klines (1m, 5m, 15m, 1h, 4h, 1d)
const TIMEFRAME = process.env.TIMEFRAME || '1h';
// Limit klines per pair (220 = cukup untuk semua indikator)
const KLINES_LIMIT = 220;
// Delay antar fetch klines (ms) — jangan terlalu cepat agar tidak kena rate limit
const FETCH_DELAY_MS = 120;

const SKIP_RE = /(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT|BUSD|TUSD|USDC|FDUSD|DAI)$/;

// ═══ STATE (in-memory, ringan) ════════════════════════════
const STATE = {
  prices: {},          // { BTC: { px, chg, vol, ts } }
  signals: {},         // { BTC: { sym, sig, score, entry, sl, tp1, tp2, rsi, ... } }
  lastScan: null,
  scanInProgress: false,
  wsStatus: 'connecting',
  wsConnectedAt: null,
  startedAt: Date.now(),
  stats: { scans: 0, errors: 0, signals: { long: 0, short: 0, neutral: 0 } },
};

// ═══ LOGGER ═══════════════════════════════════════════════
function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...args);
}

// ═══ FETCH HELPER ═════════════════════════════════════════
async function fetchJSON(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══ INDICATORS ═══════════════════════════════════════════
// Semua fungsi return SATU angka (atau object kecil) — hemat memori.

function sma(arr, p) {
  if (arr.length < p) return null;
  let s = 0;
  for (let i = arr.length - p; i < arr.length; i++) s += arr[i];
  return s / p;
}

function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function rsi(arr, p = 14) {
  if (arr.length < p + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= p; loss /= p;
  for (let i = p + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    gain = (gain * (p - 1) + Math.max(d, 0)) / p;
    loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function macd(arr, f = 12, s = 26, sig = 9) {
  const efast = ema(arr, f);
  const eslow = ema(arr, s);
  if (efast === null || eslow === null) return { macd: 0, signal: 0, hist: 0 };
  const macdLine = efast - eslow;
  // signal line approx: EMA of last few macd values (butuh series, jadi simplifikasi)
  // kita hitung ulang MACD series untuk p terakhir
  const n = arr.length;
  const series = [];
  for (let i = s; i <= n; i++) {
    const slice = arr.slice(0, i);
    const a = ema(slice, f), b = ema(slice, s);
    if (a !== null && b !== null) series.push(a - b);
  }
  const signalLine = ema(series, sig) ?? macdLine;
  return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
}

function atr(h, l, c, p = 14) {
  if (c.length < p + 1) return 0;
  const trs = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  return sma(trs, p) || 0;
}

function bb(arr, p = 20, k = 2) {
  if (arr.length < p) return { mid: 0, up: 0, lo: 0, width: 0 };
  const mid = sma(arr, p);
  const slice = arr.slice(-p);
  const v = slice.reduce((a, x) => a + (x - mid) ** 2, 0) / p;
  const sd = Math.sqrt(v);
  return { mid, up: mid + k * sd, lo: mid - k * sd, width: (2 * k * sd) / mid };
}

function stoch(h, l, c, p = 14) {
  if (c.length < p) return 50;
  const hi = Math.max(...h.slice(-p));
  const lo = Math.min(...l.slice(-p));
  if (hi === lo) return 50;
  return ((c[c.length - 1] - lo) / (hi - lo)) * 100;
}

function adx(h, l, c, p = 14) {
  if (c.length < p * 2) return 20;
  let pdi = 0, ndi = 0, tr = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const upMove = h[i] - h[i - 1];
    const dnMove = l[i - 1] - l[i];
    const plusDM = upMove > dnMove && upMove > 0 ? upMove : 0;
    const minusDM = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    pdi += plusDM; ndi += minusDM; tr += t;
  }
  if (tr === 0) return 20;
  const pDI = (pdi / tr) * 100;
  const nDI = (ndi / tr) * 100;
  const dx = (Math.abs(pDI - nDI) / (pDI + nDI || 1)) * 100;
  return dx;
}

function obv(c, v) {
  let o = 0;
  for (let i = 1; i < c.length; i++) {
    if (c[i] > c[i - 1]) o += v[i];
    else if (c[i] < c[i - 1]) o -= v[i];
  }
  return o;
}

function cci(h, l, c, p = 20) {
  if (c.length < p) return 0;
  const tp = [];
  for (let i = 0; i < c.length; i++) tp.push((h[i] + l[i] + c[i]) / 3);
  const mean = sma(tp, p);
  const slice = tp.slice(-p);
  const md = slice.reduce((a, x) => a + Math.abs(x - mean), 0) / p;
  if (md === 0) return 0;
  return (tp[tp.length - 1] - mean) / (0.015 * md);
}

function mfi(h, l, c, v, p = 14) {
  if (c.length < p + 1) return 50;
  let pos = 0, neg = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const tp = (h[i] + l[i] + c[i]) / 3;
    const tpPrev = (h[i - 1] + l[i - 1] + c[i - 1]) / 3;
    const mf = tp * v[i];
    if (tp > tpPrev) pos += mf;
    else if (tp < tpPrev) neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function vwap(h, l, c, v, p = 20) {
  if (c.length < p) return c[c.length - 1];
  let pv = 0, vv = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const tp = (h[i] + l[i] + c[i]) / 3;
    pv += tp * v[i]; vv += v[i];
  }
  return vv ? pv / vv : c[c.length - 1];
}

function supertrend(h, l, c, p = 10, mult = 3) {
  const a = atr(h, l, c, p);
  const last = c.length - 1;
  const hl2 = (h[last] + l[last]) / 2;
  const up = hl2 + mult * a;
  const dn = hl2 - mult * a;
  return { up, dn, trend: c[last] > hl2 ? 'up' : 'down' };
}

// ═══ ANALISA (kombinasi indikator → signal) ══════════════
function analyze(klines, sym) {
  if (!klines || klines.length < 55) return null;

  const O = [], H = [], L = [], C = [], V = [];
  for (const k of klines) {
    O.push(+k[1]); H.push(+k[2]); L.push(+k[3]); C.push(+k[4]); V.push(+k[5]);
  }
  const close = C[C.length - 1];
  const open = O[O.length - 1];
  const chg = ((close - C[C.length - 2]) / C[C.length - 2]) * 100;

  // Core indicators
  const ema9 = ema(C, 9);
  const ema21 = ema(C, 21);
  const ema50 = ema(C, 50);
  const ema200 = C.length >= 200 ? ema(C, 200) : ema50;
  const rsiVal = rsi(C, 14);
  const macdVal = macd(C);
  const atrVal = atr(H, L, C, 14);
  const bbVal = bb(C, 20, 2);
  const stochVal = stoch(H, L, C, 14);
  const adxVal = adx(H, L, C, 14);
  const cciVal = cci(H, L, C, 20);
  const mfiVal = mfi(H, L, C, V, 14);
  const vwapVal = vwap(H, L, C, V, 20);
  const stVal = supertrend(H, L, C, 10, 3);
  const obvVal = obv(C, V);

  // ═══ SCORING SYSTEM ══════════════════════════════════
  const bullR = [], bearR = [];

  // Trend (EMA stack)
  if (ema9 > ema21 && ema21 > ema50) bullR.push('EMA stack bullish');
  if (ema9 < ema21 && ema21 < ema50) bearR.push('EMA stack bearish');
  if (close > ema200) bullR.push('Above EMA200');
  else bearR.push('Below EMA200');

  // Momentum
  if (rsiVal < 30) bullR.push('RSI oversold');
  if (rsiVal > 70) bearR.push('RSI overbought');
  if (rsiVal > 50 && rsiVal < 70) bullR.push('RSI bullish zone');
  if (rsiVal < 50 && rsiVal > 30) bearR.push('RSI bearish zone');

  // MACD
  if (macdVal.hist > 0 && macdVal.macd > macdVal.signal) bullR.push('MACD bullish cross');
  if (macdVal.hist < 0 && macdVal.macd < macdVal.signal) bearR.push('MACD bearish cross');

  // Stochastic
  if (stochVal < 20) bullR.push('Stoch oversold');
  if (stochVal > 80) bearR.push('Stoch overbought');

  // Bollinger
  if (close <= bbVal.lo) bullR.push('BB lower band');
  if (close >= bbVal.up) bearR.push('BB upper band');

  // ADX strength
  const strongTrend = adxVal > 25;

  // CCI
  if (cciVal < -100) bullR.push('CCI oversold');
  if (cciVal > 100) bearR.push('CCI overbought');

  // MFI
  if (mfiVal < 20) bullR.push('MFI oversold');
  if (mfiVal > 80) bearR.push('MFI overbought');

  // VWAP
  if (close > vwapVal) bullR.push('Above VWAP');
  else bearR.push('Below VWAP');

  // Supertrend
  if (stVal.trend === 'up') bullR.push('Supertrend up');
  else bearR.push('Supertrend down');

  // Score
  const bullScore = bullR.length;
  const bearScore = bearR.length;
  const totalSignals = bullScore + bearScore;
  let ultScore = 0;
  let sig = 'NEUTRAL';

  if (totalSignals > 0) {
    const bullPct = (bullScore / totalSignals) * 100;
    const bearPct = (bearScore / totalSignals) * 100;

    if (bullPct >= 60) {
      sig = 'LONG';
      ultScore = Math.min(100, Math.round(bullPct + (strongTrend ? 10 : 0)));
    } else if (bearPct >= 60) {
      sig = 'SHORT';
      ultScore = Math.min(100, Math.round(bearPct + (strongTrend ? 10 : 0)));
    } else {
      ultScore = Math.round(Math.max(bullPct, bearPct));
    }
  }

  // Risk management: Entry / SL / TP berdasarkan ATR
  const isL = sig === 'LONG';
  const entry = close;
  const sl = isL ? close - atrVal * 1.5 : close + atrVal * 1.5;
  const tp1 = isL ? close + atrVal * 2 : close - atrVal * 2;
  const tp2 = isL ? close + atrVal * 3.5 : close - atrVal * 3.5;
  const rr = Math.abs((tp1 - entry) / (entry - sl)) || 0;

  return {
    sym,
    sig,
    ultScore,
    entry: +entry.toFixed(8),
    sl: +sl.toFixed(8),
    tp1: +tp1.toFixed(8),
    tp2: +tp2.toFixed(8),
    rr: +rr.toFixed(2),
    close: +close.toFixed(8),
    chg: +chg.toFixed(2),
    rsi: +rsiVal.toFixed(1),
    adx: +adxVal.toFixed(1),
    atr: +atrVal.toFixed(8),
    stoch: +stochVal.toFixed(1),
    mfi: +mfiVal.toFixed(1),
    cci: +cciVal.toFixed(1),
    macdHist: +macdVal.hist.toFixed(6),
    trend: stVal.trend,
    reasons: sig === 'LONG' ? bullR : sig === 'SHORT' ? bearR : [...bullR, ...bearR],
    ts: Date.now(),
  };
}

// ═══ WEBSOCKET (realtime prices) ═══════════════════════
let wsConn = null;
let wsPingTimer = null;
let wsReconTimer = null;

function connectWS() {
  clearTimeout(wsReconTimer);
  try { if (wsConn) wsConn.terminate(); } catch (_) {}

  STATE.wsStatus = 'connecting';
  log('WS → connecting to Binance...');

  wsConn = new WebSocket(WS_URL, { perMessageDeflate: false });

  wsConn.on('open', () => {
    STATE.wsStatus = 'live';
    STATE.wsConnectedAt = Date.now();
    log('WS → LIVE ✓');

    clearInterval(wsPingTimer);
    wsPingTimer = setInterval(() => {
      if (wsConn && wsConn.readyState === WebSocket.OPEN) {
        try { wsConn.ping(); } catch (_) {}
      }
    }, 20000);
  });

  wsConn.on('message', (buf) => {
    try {
      const arr = JSON.parse(buf.toString());
      if (!Array.isArray(arr)) return;
      const now = Date.now();
      for (const d of arr) {
        if (!d.s || !d.s.endsWith('USDT')) continue;
        if (SKIP_RE.test(d.s)) continue;
        const sym = d.s.replace('USDT', '');
        STATE.prices[sym] = {
          px: +d.c,
          chg: +d.P,
          vol: +d.q,
          ts: now,
        };
      }
    } catch (_) {}
  });

  wsConn.on('error', (e) => {
    STATE.stats.errors++;
    log('WS error:', e.message);
  });

  wsConn.on('close', () => {
    STATE.wsStatus = 'reconnecting';
    clearInterval(wsPingTimer);
    log('WS → closed, reconnecting in 3.5s...');
    wsReconTimer = setTimeout(connectWS, 3500);
  });
}

// ═══ SCAN CYCLE (periodik) ═════════════════════════════
async function scanCycle() {
  if (STATE.scanInProgress) return;
  STATE.scanInProgress = true;
  const t0 = Date.now();

  try {
    log(`SCAN → fetching top ${SCAN_TOP_N} USDT pairs...`);
    const tickers = await fetchJSON(`${API_PUB}/ticker/24hr`);
    const pairs = tickers
      .filter((t) => t.symbol.endsWith('USDT') && !SKIP_RE.test(t.symbol) && +t.quoteVolume > 100000)
      .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
      .slice(0, SCAN_TOP_N);

    const newSignals = {};
    let long = 0, short = 0, neutral = 0;

    for (let i = 0; i < pairs.length; i++) {
      const t = pairs[i];
      const base = t.symbol.replace('USDT', '');
      try {
        const klines = await fetchJSON(
          `${API_PUB}/klines?symbol=${t.symbol}&interval=${TIMEFRAME}&limit=${KLINES_LIMIT}`,
          10000
        );
        const a = analyze(klines, base);
        if (a) {
          a.vol24 = +t.quoteVolume;
          newSignals[base] = a;
          if (a.sig === 'LONG') long++;
          else if (a.sig === 'SHORT') short++;
          else neutral++;
        }
      } catch (e) {
        STATE.stats.errors++;
      }
      await sleep(FETCH_DELAY_MS);
    }

    STATE.signals = newSignals;
    STATE.lastScan = Date.now();
    STATE.stats.scans++;
    STATE.stats.signals = { long, short, neutral };

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log(`SCAN ✓ ${pairs.length} pairs in ${dt}s | LONG:${long} SHORT:${short} NEUTRAL:${neutral}`);
  } catch (e) {
    STATE.stats.errors++;
    log('SCAN error:', e.message);
  } finally {
    STATE.scanInProgress = false;
    // Manual GC hint (Node akan cleanup sendiri)
    if (global.gc) try { global.gc(); } catch (_) {}
  }
}

// ═══ EXPRESS SERVER ═══════════════════════════════════
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// Dashboard HTML
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JSON: prices + signals
app.get('/api/data', (_req, res) => {
  const uptimeSec = Math.floor((Date.now() - STATE.startedAt) / 1000);
  const signals = Object.values(STATE.signals)
    .sort((a, b) => b.ultScore - a.ultScore);

  res.json({
    status: 'ok',
    wsStatus: STATE.wsStatus,
    uptime: uptimeSec,
    lastScan: STATE.lastScan,
    nextScanIn: STATE.lastScan
      ? Math.max(0, Math.round((STATE.lastScan + SCAN_INTERVAL_MS - Date.now()) / 1000))
      : null,
    timeframe: TIMEFRAME,
    stats: STATE.stats,
    signals,
    prices: STATE.prices,
  });
});

// JSON: hanya harga live (ringan)
app.get('/api/prices', (_req, res) => {
  res.json({ wsStatus: STATE.wsStatus, prices: STATE.prices });
});

// Keep-alive untuk UptimeRobot
app.get('/ping', (_req, res) => res.type('text').send('pong'));

// Health-check
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ws: STATE.wsStatus,
    uptime: Math.floor((Date.now() - STATE.startedAt) / 1000),
    memMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
    pricesCount: Object.keys(STATE.prices).length,
    signalsCount: Object.keys(STATE.signals).length,
  });
});

// ═══ BOOT ═════════════════════════════════════════════
app.listen(PORT, () => {
  log(`HTTP server listening on port ${PORT}`);
  log(`Scan every ${SCAN_INTERVAL_MS / 1000}s on ${TIMEFRAME} (top ${SCAN_TOP_N} pairs)`);
  connectWS();
  // Scan pertama setelah 5 detik (biar WS sudah connect duluan)
  setTimeout(scanCycle, 5000);
  setInterval(scanCycle, SCAN_INTERVAL_MS);
});

// Graceful shutdown
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
process.on('unhandledRejection', (e) => log('UnhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => log('UncaughtException:', e?.message || e));
