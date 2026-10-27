// Binance futures kline archives (data.binance.vision, public, CORS-open): the same 1m data the forex research used,
// up to yesterday. Whole months come as one zip once the month is over; the rest as daily zips (published a day or two
// late). Zips are unpacked in the browser with DecompressionStream('deflate-raw').
const BASE = 'https://data.binance.vision/data/futures/um';
const cache = new Map();

async function unzipFirst(buf) {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error('not a zip');
  const method = v.getUint16(8, true), size = v.getUint32(18, true), start = 30 + v.getUint16(26, true) + v.getUint16(28, true);
  const data = new Uint8Array(buf, start, size);
  if (method === 0) return new TextDecoder().decode(data);
  if (method !== 8) throw new Error('unsupported zip method ' + method);
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unzip (no DecompressionStream)');
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
}
/** One archive file → rows [t, o, h, l, c, quoteVolume], or null when it does not exist (yet). */
async function file(url) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('/').pop()}`);
    const rows = [];
    for (const line of (await unzipFirst(await r.arrayBuffer())).split('\n')) {
      const x = line.split(','); if (x.length < 8 || !/^\d/.test(x[0])) continue; // skip the header line
      rows.push([Math.floor(+x[0] / 1000), +x[1], +x[2], +x[3], +x[4], +x[7]]);
    }
    return rows;
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const ymd = d => `${ym(d)}-${String(d.getUTCDate()).padStart(2, '0')}`;
/** Archive URLs covering [from, to): a monthly zip for a finished month we need more than 10 days of, else daily zips. */
function plan(sym, from, to) {
  const out = [], now = Date.now(), first = new Date(from * 1000), last = new Date(Math.min(to * 1000, now - 86400e3));
  for (let m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1); m <= last.getTime(); m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) {
    const mEnd = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1);
    const days = []; for (let d = Math.max(m, Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate())); d < Math.min(mEnd, last.getTime() + 1); d += 86400e3) days.push(new Date(d));
    const daily = days.map(d => `${BASE}/daily/klines/${sym}/1m/${sym}-1m-${ymd(d)}.zip`);
    if (days.length > 10 && mEnd + 2 * 86400e3 < now) out.push({ url: `${BASE}/monthly/klines/${sym}/1m/${sym}-1m-${ym(new Date(m))}.zip`, fallback: daily });
    else out.push(...daily.map(url => ({ url })));
  }
  return out;
}
/** 1m candles {t,o,h,l,c,v} of a Binance USDT-M symbol for [from, to) unix seconds. onProgress(done, total). */
export async function archiveBars(sym, from, to, onProgress) {
  const jobs = plan(sym, from, to), rows = new Map();
  let done = 0, total = jobs.length, next = 0;
  const take = r => { if (r) for (const x of r) if (x[0] >= from && x[0] < to) rows.set(x[0], x); };
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const r = await file(j.url);
      if (r) take(r);
      else if (j.fallback) { total += j.fallback.length; for (const u of j.fallback) { take(await file(u)); onProgress?.(++done, total); } }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  const list = [...rows.values()].sort((a, b) => a[0] - b[0]);
  return { sym, t: list.map(x => x[0]), o: list.map(x => x[1]), h: list.map(x => x[2]), l: list.map(x => x[3]), c: list.map(x => x[4]), v: list.map(x => x[5]) };
}
