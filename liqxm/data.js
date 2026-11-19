// liqxm data layer (public — no strategy logic here). Gate.io USDT-perp public API, CORS-open, reachable from Indonesia.
// Gold: XAU_USDT perp (liquid: native 10s/1m/5m candles, and every trade → 1s/15s bars) or index_XAU_USDT.
// Nasdaq: index_NAS100_USDT for 1m and up. Gate has no usable NAS seconds data (the index 10s candles carry one price per
// 10 s — no wicks — and the NAS100_USDT perp barely trades), so NAS runs without the seconds timeframes.
// All bars are CLOSED bars. Perp bars with no trades are dropped (TradingView prints no bar there) and so is anything
// printed while the CME market is closed (daily 17:00–18:00 ET break, Friday 17:00 → Sunday 18:00 ET).
// Works in browsers and in Node 22 (global fetch); no DOM.

const API = 'https://api.gateio.ws/api/v4/futures/usdt';
export const TF_SEC = { '1s': 1, '10s': 10, '15s': 15, '1m': 60, '3m': 180, '5m': 300, '15m': 900 };
export const INSTR = {
  XAU: { id: 'XAU', label: 'Gold', name: 'XAUUSD', perp: 'XAU_USDT', index: 'index_XAU_USDT', source: 'perp', ltf: true, digits: 2,
    lot: 100, lotNote: '1 lot = 100 oz', spread: 0.25, comm: 7, unit: '$' },
  NAS: { id: 'NAS', label: 'Nasdaq 100', name: 'NAS100', perp: 'NAS100_USDT', index: 'index_NAS100_USDT', source: 'index', ltf: false, digits: 1,
    lot: 1, lotNote: '1 lot = $1 per point (cek broker)', spread: 1.5, comm: 0, unit: 'pt' },
};

// ── market clock (CME day: Sunday 18:00 ET → Friday 17:00 ET, daily 17:00–18:00 ET break) ─────────────────────────────
function nthSunday(y, m, nth) { const d = new Date(Date.UTC(y, m, 1)); return (7 - d.getUTCDay()) % 7 + 1 + 7 * (nth - 1); }
const nyCache = new Map();
export function nyOffset(t) {
  const y = new Date(t * 1000).getUTCFullYear();
  let r = nyCache.get(y);
  if (!r) nyCache.set(y, r = [Date.UTC(y, 2, nthSunday(y, 2, 2), 7) / 1000, Date.UTC(y, 10, nthSunday(y, 10, 1), 6) / 1000]);
  return t >= r[0] && t < r[1] ? -4 : -5;
}
/** m = minutes since midnight New York, dow = New York weekday (0 = Sunday), open = CME market open. */
export function etClock(t) {
  const lt = t + nyOffset(t) * 3600, m = Math.floor((((lt % 86400) + 86400) % 86400) / 60), dow = new Date(lt * 1000).getUTCDay();
  const open = !(m >= 1020 && m < 1080) && dow !== 6 && !(dow === 5 && m >= 1020) && !(dow === 0 && m < 1080);
  return { m, dow, open };
}
/** Trading session of time t (New York clock), or null when the market is closed. */
export function sessionOf(t) {
  const k = etClock(t);
  if (!k.open) return null;
  return (k.m >= 1080 || k.m < 180) ? 'Asia' : k.m < 480 ? 'London' : k.m < 690 ? 'London + New York' : k.m < 960 ? 'New York' : 'NY sore';
}

// ── bars helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
const empty = (sym, tf) => ({ sym, tf, sec: TF_SEC[tf], t: [], o: [], h: [], l: [], c: [], v: [] });
function push(b, t, o, h, l, c, v) { b.t.push(t); b.o.push(o); b.h.push(h); b.l.push(l); b.c.push(c); b.v.push(v); }
/** Keep bars where keep(i) is true. */
export function filterBars(b, keep) {
  const out = empty(b.sym, b.tf);
  for (let i = 0; i < b.t.length; i++) if (keep(i)) push(out, b.t[i], b.o[i], b.h[i], b.l[i], b.c[i], b.v[i]);
  return out;
}
/** Epoch-aligned resample (3m from 1m, 15s from 1s); buckets with no bars produce no bar. Closed buckets only up to `until`. */
export function resample(b, tf, until = Infinity) {
  const sec = TF_SEC[tf], out = empty(b.sym, tf);
  for (let i = 0; i < b.t.length; i++) {
    const t = Math.floor(b.t[i] / sec) * sec, k = out.t.length - 1;
    if (k < 0 || out.t[k] !== t) push(out, t, b.o[i], b.h[i], b.l[i], b.c[i], b.v[i]);
    else { out.h[k] = Math.max(out.h[k], b.h[i]); out.l[k] = Math.min(out.l[k], b.l[i]); out.c[k] = b.c[i]; out.v[k] += b.v[i]; }
  }
  while (out.t.length && out.t[out.t.length - 1] + sec > until) for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) out[k].pop();
  if (out.t.length && out.t[0] < b.t[0]) for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) out[k].shift(); // first bucket started before the data
  return out;
}
/** Last bar index with t <= time (binary search), −1 if none. */
export function idxAt(b, time) {
  let lo = 0, hi = b.t.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (b.t[m] <= time) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
/** Bars with t < time (no look-ahead: what was closed before `time` when every bar lasts b.sec). */
export function until(b, time) {
  const n = idxAt(b, time - b.sec) + 1, out = empty(b.sym, b.tf);
  for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) out[k] = b[k].slice(0, n);
  return out;
}

// ── fetching ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 429 && k < tries + 2) { await sleep(1200 * (k + 1)); continue; }
      const d = await r.json();
      if (!r.ok || !Array.isArray(d)) throw new Error(d?.message || d?.label || `HTTP ${r.status}`);
      return d;
    } catch (e) { if (k >= tries) throw e; await sleep(600 * (k + 1)); }
  }
}
async function pool(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

const candleCache = new Map();   // contract|interval → { rows: Map(t → row), at }
/** Native Gate candles (interval 10s, 1m, 5m, 15m): the last `n` (≤ 9990) CLOSED bars + the forming bar. */
async function nativeCandles(contract, interval, n, now) {
  const sec = TF_SEC[interval], key = contract + '|' + interval;
  let c = candleCache.get(key);
  const need = c ? Math.ceil((now - Math.max(...c.rows.keys())) / sec) + 2 : n;
  const urls = [];
  if (c && need <= 1990) urls.push(`${API}/candlesticks?contract=${contract}&interval=${interval}&limit=${need}`);
  else {
    c = { rows: new Map() };
    const nowI = Math.floor(now), from0 = nowI - Math.min(n, 9990) * sec;
    for (let f = from0; f < nowI; f += 1999 * sec) urls.push(`${API}/candlesticks?contract=${contract}&interval=${interval}&from=${f}&to=${Math.min(nowI, f + 1999 * sec)}`);
  }
  const tolerant = contract.startsWith('index_');
  const res = await pool(urls, 3, async u => { try { return await getJson(u, tolerant ? 1 : 3); } catch (e) { if (tolerant) return []; throw e; } });
  for (const d of res) for (const k of d) c.rows.set(+k.t, [+k.t, +k.o, +k.h, +k.l, +k.c, +k.sum || +k.v || 0, +k.v || 0]);
  c.at = now; candleCache.set(key, c);
  const ts = [...c.rows.keys()].sort((a, b) => a - b);
  if (ts.length > n + 50) for (const t of ts.slice(0, ts.length - n - 50)) c.rows.delete(t);
  const closed = empty(contract, interval), formingT = Math.floor(now / sec) * sec;
  let forming = null;
  for (const t of ts.slice(-n - 1)) {
    const r = c.rows.get(t);
    if (t + sec > now) { if (t === formingT) forming = { t, o: r[1], h: r[2], l: r[3], c: r[4] }; continue; }
    push(closed, t, r[1], r[2], r[3], r[4], r[6]);
  }
  return { closed, forming };
}

const tradeCache = new Map();    // contract → { trades: Map(id → [ms, price, size]), from }
async function tradesWindow(contract, from, to, out) {
  const d = await getJson(`${API}/trades?contract=${contract}&limit=1000&from=${from}&to=${to}`);
  if (d.length >= 1000 && to - from > 1) {
    const mid = Math.floor((from + to) / 2);
    await tradesWindow(contract, from, mid, out); await tradesWindow(contract, mid, to, out); return;
  }
  for (const x of d) out.set(x.id, [+x.create_time_ms * 1000, +x.price, Math.abs(+x.size)]);
}
/** Every trade of the last `minutes` (incremental on refresh) → closed 1s bars. */
async function tradeBars(contract, minutes, now) {
  let c = tradeCache.get(contract);
  const start = now - minutes * 60;
  if (!c || c.from > start) c = { trades: new Map(), from: start, last: start };
  const from = Math.max(start, c.last - 3), wins = [];
  for (let f = Math.floor(from); f < now; f += 120) wins.push([f, Math.min(Math.ceil(now), f + 120)]);
  await pool(wins, 4, ([f, t]) => tradesWindow(contract, f, t, c.trades));
  for (const [id, x] of c.trades) if (x[0] < start * 1000) c.trades.delete(id);
  c.last = now; c.from = Math.min(c.from, start); tradeCache.set(contract, c);
  const list = [...c.trades.entries()].sort((a, b) => a[1][0] - b[1][0] || a[0] - b[0]);
  const b = empty(contract, '1s'), nowS = Math.floor(now);
  let lastPx = null, lastT = null;
  for (const [, [ms, p, q]] of list) {
    const t = Math.floor(ms / 1000); lastPx = p; lastT = ms / 1000;
    if (t >= nowS) continue;                     // the second still in progress
    const k = b.t.length - 1;
    if (k < 0 || b.t[k] !== t) push(b, t, p, p, p, p, q);
    else { b.h[k] = Math.max(b.h[k], p); b.l[k] = Math.min(b.l[k], p); b.c[k] = p; b.v[k] += q; }
  }
  return { bars: b, lastPx, lastT, count: list.length };
}

/** Clean a series: perp bars without trades dropped, closed-market bars dropped. */
function clean(b, perp) {
  return filterBars(b, i => (!perp || b.v[i] > 0) && etClock(b.t[i]).open);
}

/**
 * Load every timeframe the analysis needs for one instrument.
 * opts: { source: 'perp'|'index', bars: { '5m': n, '1m': n, '10s': n, '15m': n }, tradeMinutes: 30, ltf: bool, extra: ['15m'], now }
 * → { inst, source, contract, now, price, priceT, bars: { '5m','3m','1m','15s','10s','1s' } (missing → absent),
 *     coverage: { tf: { from, to, n } }, notes: [] }
 */
export async function loadMarket(instId, opts = {}) {
  const inst = INSTR[instId]; if (!inst) throw new Error('unknown instrument ' + instId);
  const now = opts.now ?? Date.now() / 1000, source = opts.source || inst.source;
  const contract = source === 'index' ? inst.index : inst.perp, perp = source !== 'index';
  const want = { '5m': 3000, '1m': 9990, '10s': 9990, ...(opts.bars || {}) };
  const ltf = (opts.ltf ?? true) && inst.ltf && perp;
  const notes = [];
  const jobs = [nativeCandles(contract, '5m', want['5m'], now), nativeCandles(contract, '1m', want['1m'], now),
    ltf ? nativeCandles(contract, '10s', want['10s'], now) : null, ltf ? tradeBars(contract, opts.tradeMinutes ?? 30, now) : null];
  const want15 = (opts.extra || []).includes('15m');
  const [m5, m1, s10, tr, m15] = await Promise.all([...jobs, want15 ? nativeCandles(contract, '15m', opts.bars?.['15m'] || 2000, now) : null]);
  const bars = {};
  if (m15) bars['15m'] = clean(m15.closed, perp);
  bars['5m'] = clean(m5.closed, perp);
  bars['1m'] = clean(m1.closed, perp);
  bars['3m'] = resample(bars['1m'], '3m', now);
  let price = m1.forming?.c ?? bars['1m'].c.at(-1), priceT = m1.forming ? now : bars['1m'].t.at(-1) + 60;
  if (s10) bars['10s'] = clean(s10.closed, perp);
  if (tr) {
    bars['1s'] = clean(tr.bars, perp);
    bars['15s'] = resample(bars['1s'], '15s', now);
    if (tr.lastPx != null) { price = tr.lastPx; priceT = tr.lastT; }
  }
  if (!inst.ltf) notes.push(`${inst.name}: data detik (15s/10s/1s) tidak tersedia di Gate — analisa berhenti di 1m.`);
  else if (!perp) notes.push('Sumber index: data detik dimatikan (index tidak punya trade).');
  const coverage = {};
  for (const [tf, b] of Object.entries(bars)) coverage[tf] = { n: b.t.length, from: b.t[0] ?? null, to: b.t.length ? b.t[b.t.length - 1] + b.sec : null };
  return { inst, source, contract, now, price, priceT, bars, coverage, notes, market: etClock(now), session: sessionOf(now) };
}
