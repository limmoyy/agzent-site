// Indicators for the scanner lab: causal (only data up to bar t), definitions follow pandas/Pine.
// Bars are column arrays {t (unix s), o, h, l, c, v}.

export const nanArr = n => new Float64Array(n).fill(NaN);
export const isn = v => v !== v;

export function ewm(x, alpha, minp) {
  const out = nanArr(x.length);
  let y = NaN, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!isn(v)) { y = isn(y) ? v : alpha * v + (1 - alpha) * y; cnt++; }
    if (cnt >= minp) out[i] = y;
  }
  return out;
}
export const ema = (x, n) => ewm(x, 2 / (n + 1), n);
export const rma = (x, n) => ewm(x, 1 / n, n);
export function sma(x, n) {
  const out = nanArr(x.length);
  let s = 0, k = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]; k++;
    if (k > n) { s -= x[i - n]; k = n; }
    if (k === n) out[i] = s / n;
  }
  return out;
}
export function rollStd(x, n, minp = n, ddof = 0) {
  const out = nanArr(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0, q = 0, k = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { const v = x[j]; if (!isn(v)) { s += v; q += v * v; k++; } }
    if (k >= minp && k > ddof) { const m = s / k; out[i] = Math.sqrt(Math.max(0, (q - k * m * m) / (k - ddof))); }
  }
  return out;
}
export function rollMedian(x, n, minp = n) {
  const out = nanArr(x.length), w = [];
  for (let i = 0; i < x.length; i++) {
    w.length = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) if (!isn(x[j])) w.push(x[j]);
    if (w.length >= minp) { w.sort((a, b) => a - b); const m = w.length >> 1; out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; }
  }
  return out;
}
export function rollMean(x, n, minp = n) {
  const out = nanArr(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) if (!isn(x[j])) { s += x[j]; k++; }
    if (k >= minp) out[i] = s / k;
  }
  return out;
}
export function highest(x, n) {
  const out = nanArr(x.length);
  for (let i = n - 1; i < x.length; i++) { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) if (x[j] > m) m = x[j]; out[i] = m; }
  return out;
}
export function lowest(x, n) {
  const out = nanArr(x.length);
  for (let i = n - 1; i < x.length; i++) { let m = Infinity; for (let j = i - n + 1; j <= i; j++) if (x[j] < m) m = x[j]; out[i] = m; }
  return out;
}
export function trueRange(b) {
  const n = b.c.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hl = b.h[i] - b.l[i];
    out[i] = i ? Math.max(hl, Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) : hl;
  }
  return out;
}
export const atr = (b, n = 14) => rma(trueRange(b), n);
export function rsi(x, n = 14) {
  const len = x.length, up = nanArr(len), dn = nanArr(len);
  for (let i = 1; i < len; i++) { const d = x[i] - x[i - 1]; up[i] = d > 0 ? d : 0; dn[i] = d < 0 ? -d : 0; }
  const u = rma(up, n), d = rma(dn, n), out = nanArr(len);
  for (let i = 0; i < len; i++) if (!isn(u[i]) && !isn(d[i]) && (u[i] || d[i])) out[i] = 100 - 100 / (1 + u[i] / d[i]);
  return out;
}
export function bbands(x, n = 20, k = 2) {
  const mid = sma(x, n), sd = rollStd(x, n), lo = nanArr(x.length), up = nanArr(x.length);
  for (let i = 0; i < x.length; i++) { lo[i] = mid[i] - k * sd[i]; up[i] = mid[i] + k * sd[i]; }
  return { lo, mid, up };
}
export const dayOf = t => Math.floor(t / 86400);
// VWAP that resets every UTC day (ta.vwap on Binance). src defaults to hlc3. bands -> volume-weighted sd too.
export function vwapSession(b, src = null, bands = false) {
  const n = b.c.length, vw = nanArr(n), sd = nanArr(n);
  let day = -1, cv = 0, cpv = 0, cp2v = 0;
  for (let i = 0; i < n; i++) {
    const d = dayOf(b.t[i]);
    if (d !== day) { day = d; cv = cpv = cp2v = 0; }
    const p = src ? src[i] : (b.h[i] + b.l[i] + b.c[i]) / 3, v = b.v[i];
    cv += v; cpv += p * v; cp2v += p * p * v;
    if (cv > 0) { vw[i] = cpv / cv; sd[i] = Math.sqrt(Math.max(0, cp2v / cv - vw[i] * vw[i])); }
  }
  return bands ? { vwap: vw, sd } : vw;
}
// New York UTC offset (hours) with US DST: 2nd Sunday of March 02:00 → 1st Sunday of November 02:00.
function nthSunday(y, m, nth) { const d = new Date(Date.UTC(y, m, 1)); const first = (7 - d.getUTCDay()) % 7 + 1; return first + 7 * (nth - 1); }
const nyCache = new Map();
export function nyOffset(t) {
  const y = new Date(t * 1000).getUTCFullYear();
  let r = nyCache.get(y);
  if (!r) {
    r = [Date.UTC(y, 2, nthSunday(y, 2, 2), 7) / 1000, Date.UTC(y, 10, nthSunday(y, 10, 1), 6) / 1000];
    nyCache.set(y, r);
  }
  return t >= r[0] && t < r[1] ? -4 : -5;
}
