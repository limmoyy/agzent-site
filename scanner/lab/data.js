// Live candles for the scanner page, fetched in the browser from Gate.io USDT perpetuals (public, CORS-open,
// reachable from Indonesia where Binance/Bybit/OKX time out). Binance symbols map 1:1 (BTCUSDT → BTC_USDT);
// 1000PEPEUSDT maps to PEPE_USDT with prices × 1000 so levels match the Binance-based scanner.
// Gate serves at most the latest 10 000 candles per interval, 2000 per request.
export const TF_SEC = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };
const API = 'https://api.gateio.ws/api/v4/futures/usdt/candlesticks';
const cache = new Map();

export function gateContract(sym) {
  let base = sym.replace(/USDT$/, ''), mult = 1;
  const m = base.match(/^(1000+)(.+)$/);
  if (m) { mult = +m[1]; base = m[2]; }
  return { contract: `${base}_USDT`, mult };
}

async function getJson(url, tries = 3) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 429 && k < tries) { await new Promise(res => setTimeout(res, 800 * (k + 1))); continue; }
      const d = await r.json();
      if (!r.ok || !Array.isArray(d)) throw new Error(d?.message || d?.label || `HTTP ${r.status}`);
      return d;
    } catch (e) { if (k >= tries) throw e; await new Promise(res => setTimeout(res, 500 * (k + 1))); }
  }
}

/** Candles as column arrays {t,o,h,l,c,v} (v = USDT turnover). bars ≤ 10000. The last bar may still be forming:
 *  `forming` tells whether it is. Cached for `ttl` ms per (symbol, tf, bars). */
export async function candles(sym, tf = '1h', bars = 2000, ttl = 60e3) {
  const key = `${sym}|${tf}|${bars}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const { contract, mult } = gateContract(sym), sec = TF_SEC[tf];
  const now = Math.floor(Date.now() / 1000), n = Math.min(bars, 9990);
  const chunks = [];
  if (n <= 2000) chunks.push(`${API}?contract=${contract}&interval=${tf}&limit=${n}`);
  else for (let f = now - n * sec; f < now; f += 1999 * sec) chunks.push(`${API}?contract=${contract}&interval=${tf}&from=${f}&to=${Math.min(now, f + 1999 * sec)}`);
  const rows = new Map();
  for (const u of chunks) for (const k of await getJson(u)) rows.set(+k.t, k);
  const list = [...rows.values()].sort((a, b) => a.t - b.t);
  const data = { sym, tf, t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const k of list) {
    data.t.push(+k.t); data.o.push(+k.o * mult); data.h.push(+k.h * mult); data.l.push(+k.l * mult); data.c.push(+k.c * mult); data.v.push(+k.sum || 0);
  }
  data.forming = data.t.length > 0 && data.t[data.t.length - 1] + sec > now;
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Only closed candles (drop the forming one). */
export function closed(b) {
  if (!b.forming) return b;
  const k = b.t.length - 1, s = a => a.slice(0, k);
  return { ...b, t: s(b.t), o: s(b.o), h: s(b.h), l: s(b.l), c: s(b.c), v: s(b.v), forming: false };
}

/** Run fn over items with limited concurrency; onProgress(done, total). */
export async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length); let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: String(e.message || e) }; }
      onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
