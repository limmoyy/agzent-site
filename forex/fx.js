// Forex desk domain: market clock (New York time), session levels, instruments, strategies and broker costs.
// Prices come from Gate.io's index candles (index_XAU_USDT, index_NAS100_USDT): the underlying gold / Nasdaq-100
// price without perp premium, closest to a broker's XAUUSD / NAS100 quote. Index candles keep printing on weekends
// (synthetic), so every closed-market candle is dropped before charting or simulating.
//
// Research (Binance XAUUSDT perp 1m 2025-12 → 2026-10, PAXG spot 1m 2025, QQQUSDT perp 1m 2026-04 → 10,
// costs ≈ 0.5 bp a side + 0.25 bp slippage, ~170 configurations): no intraday edge found.
//   Claude's own Sweep & Reclaim of the Asian range / previous day high-low, and NY opening-range breakouts: ≤ 0.
//   The crypto Flush & Reclaim rules: ≤ 0.  1m: nothing beats costs.
//   Best: trend pullback (EMA 100 trend + RSI 14 dip, TP 1 % / SL 1.5 %, 24 h time stop) on 5m — 747 trades,
//   +8.4 bp, t 2.6, 5 of 6 half-periods positive. But the profit is the trend side in rising samples (gold 2025
//   longs +25 bp, Nasdaq 2026 longs +26 bp, shorts ≈ 0; flat gold 2026: −0.3 bp), the median trade lasts 11–14 h
//   and over half are held overnight (broker swap not modelled). Experimental: paper-trade it.
import { STRATEGIES } from '../scanner/lab/engine.js?v=20261027a';
import { nyOffset, ema, rsi, atr } from '../scanner/lab/ind.js';

export const INSTR = {
  XAUUSD: { id: 'XAUUSD', label: 'Gold', contract: 'index_XAU_USDT', digits: 2, unit: '$', ptName: '$', lot: 100, lotNote: '1 lot = 100 oz', spread: 0.25, comm: 7, tv: 'OANDA:XAUUSD' },
  NAS100: { id: 'NAS100', label: 'Nasdaq 100', contract: 'index_NAS100_USDT', digits: 1, unit: 'pt', ptName: 'pt', lot: 1, lotNote: '1 lot = $1 per point (check your broker)', spread: 1.5, comm: 0, tv: 'OANDA:NAS100USD' },
};

// ── market clock ────────────────────────────────────────────────────────────────────────────────
// Gold and Nasdaq CFDs follow the CME day: Sunday 18:00 ET → Friday 17:00 ET, with a 17:00–18:00 ET break each day.
/** m = minutes since midnight ET, sd = trading-day id (a day starts at 18:00 ET), sdow = its weekday (1 = Monday). */
export function etClock(t) {
  const lt = t + nyOffset(t) * 3600, m = Math.floor((lt % 86400) / 60), dow = new Date(lt * 1000).getUTCDay();
  const sd = Math.floor((lt + 6 * 3600) / 86400), sdow = new Date((lt + 6 * 3600) * 1000).getUTCDay();
  const open = !(m >= 1020 && m < 1080) && dow !== 6 && !(dow === 5 && m >= 1020) && !(dow === 0 && m < 1080);
  return { m, dow, sd, sdow, open };
}
/** Unix time of h:min New York time on the New York date that contains t. */
export const atET = (t, h, min = 0) => {
  const off = nyOffset(t) * 3600, day = Math.floor((t + off) / 86400) * 86400;
  return day + h * 3600 + min * 60 - off;
};
/** Where the market is now and what comes next (all unix seconds). */
export function marketState(now = Date.now() / 1000) {
  const k = etClock(now), phase = k.open ? 'open' : (k.m >= 1020 && k.m < 1080 && k.dow >= 1 && k.dow <= 4) ? 'break' : 'weekend';
  const session = !k.open ? null : (k.m >= 1080 || k.m < 180) ? 'Asia' : k.m < 480 ? 'London' : k.m < 690 ? 'London + New York' : 'New York';
  // next events: the first time each comes up on a trading day (an open needs the market open just after it, a close just before)
  const ev = [['London open', 180, 1], ['NY cash open', 570, 1], ['Daily close', 1020, -1], ['Daily open', 1080, 1]], next = [];
  for (const [name, m, side] of ev) for (let d = 0; d < 8; d++) {
    const t = atET(now + d * 86400, Math.floor(m / 60), m % 60);
    if (t > now && etClock(t + side * 60).open) { next.push({ name, t }); break; }
  }
  next.sort((a, b) => a.t - b.t);
  return { ...k, phase, session, next };
}
/** Drop candles printed while the market is closed (index candles keep moving on weekends). */
export function marketOnly(b) {
  const keep = b.t.map(t => etClock(t).open), f = a => a.filter((_, i) => keep[i]);
  const out = { ...b, t: f(b.t), o: f(b.o), h: f(b.h), l: f(b.l), c: f(b.c), v: f(b.v) };
  out.forming = !!b.forming && keep[keep.length - 1];
  return out;
}

// ── session levels ──────────────────────────────────────────────────────────────────────────────
/** Levels forex traders watch, from the candles of the current and previous trading day:
 *  Asian range (18:00–02:00 ET), previous day high/low, NY opening range (09:30–10:00 ET), today's high/low. */
export function sessionLevels(b) {
  const n = b.t.length; if (!n) return null;
  const sdNow = etClock(b.t[n - 1]).sd;
  const L = { asia: null, prev: null, or: null, today: null };
  const grow = (key, i, t0) => { const x = L[key] || (L[key] = { hi: -Infinity, lo: Infinity, t0 }); x.hi = Math.max(x.hi, b.h[i]); x.lo = Math.min(x.lo, b.l[i]); };
  let prevSd = null;
  for (let i = n - 1; i >= 0; i--) {
    const k = etClock(b.t[i]);
    if (k.sd === sdNow) {
      grow('today', i, b.t[i]); L.today.t0 = b.t[i];
      if (k.m >= 1080 || k.m < 120) { grow('asia', i, b.t[i]); L.asia.t0 = b.t[i]; }
      if (k.m >= 570 && k.m < 600) { grow('or', i, b.t[i]); L.or.t0 = b.t[i]; }
    } else {
      if (prevSd === null) prevSd = k.sd;
      if (k.sd !== prevSd) break;
      grow('prev', i, b.t[i]); L.prev.t0 = b.t[i];
    }
  }
  const lastM = etClock(b.t[n - 1]).m;
  if (L.asia) L.asia.done = !(lastM >= 1080 || lastM < 120);
  if (L.or) L.or.done = lastM >= 600 && lastM < 1020;
  return L;
}

// ── strategies ──────────────────────────────────────────────────────────────────────────────────
const bools = n => new Uint8Array(n), nanArr = n => new Float64Array(n).fill(NaN);
const rsiEma = STRATEGIES.rsi_ema.signals;
/** Claude FX · Trend Pullback: the lab's RSI-dip-with-EMA-trend rule, plus a 24 h time stop. Long when price is
 *  above EMA 100 and RSI 14 dips under 40; short when below EMA 100 and RSI rises over 60. TP 1 %, SL 1.5 %. */
export const FX_TREND = {
  title: 'Claude FX · Trend Pullback', tf: '5m', tfs: ['1m', '5m', '15m'],
  params: { ema_n: 100, rsi_n: 14, rsi_lo: 40, tp: 0.01, sl: 0.015, max_hold: 1440 },
  help: { ema_n: 'Trend EMA length', rsi_n: 'RSI length', rsi_lo: 'Long when RSI < this (short when > 100 − this)', tp: 'Take-profit (fraction of price)', sl: 'Stop-loss (fraction of price)', max_hold: 'Time stop (minutes)' },
  signals: rsiEma,
};
/** Claude's Sweep & Reclaim (failed in research; kept for comparison): a candle in London / NY morning hours that pokes
 *  through the Asian range or previous day's low (high) and closes back inside, with a long wick. Limit in the wick. */
function sweep(b, p, ctx) {
  const n = b.c.length, a = atr(b, 14), tfMin = ctx.tfMin;
  const lel = nanArr(n), sel = nanArr(n), sl_p = nanArr(n), tp_p = nanArr(n), tp1_p = nanArr(n), lx = bools(n), sx = bools(n);
  let sd = -1, aH = -Infinity, aL = Infinity, dH = -Infinity, dL = Infinity, pH = NaN, pL = NaN, usedL = false, usedH = false;
  for (let i = 1; i < n; i++) {
    const k = etClock(b.t[i]);
    if (k.sd !== sd) { pH = dH; pL = dL; sd = k.sd; aH = -Infinity; aL = Infinity; dH = -Infinity; dL = Infinity; usedL = usedH = false; }
    const inAsia = k.m >= 1080 || k.m < 120, lows = [], highs = [];
    if (!inAsia && aL < Infinity) { lows.push(aL); highs.push(aH); }
    if (pL === pL && pL < Infinity) { lows.push(pL); highs.push(pH); }
    const act = k.open && k.m >= p.win0 && k.m < p.win1 && k.sdow >= 1 && k.sdow <= 5;
    if ((k.m + tfMin >= p.exit_m && k.m < p.exit_m + tfMin) || !k.open) lx[i] = sx[i] = 1;
    if (act && a[i - 1] > 0) {
      const o = b.o[i], h = b.h[i], l = b.l[i], c = b.c[i], rng = h - l;
      if (rng >= p.rng_atr * a[i - 1]) {
        const lw = (Math.min(o, c) - l) / rng, uw = (h - Math.max(o, c)) / rng;
        if (!usedL && lows.some(x => l < x && c > x) && lw >= p.wick) {
          const entry = Math.min(c, l + p.ent_frac * rng), sl = l - p.buf * a[i], risk = entry - sl;
          if (risk / entry * 1e4 >= p.min_risk_bp) { lel[i] = entry; sl_p[i] = sl; tp_p[i] = entry + p.tp2_r * risk; tp1_p[i] = entry + p.tp1_r * risk; usedL = true; }
        } else if (!usedH && highs.some(x => h > x && c < x) && uw >= p.wick) {
          const entry = Math.max(c, h - p.ent_frac * rng), sl = h + p.buf * a[i], risk = sl - entry;
          if (risk / entry * 1e4 >= p.min_risk_bp) { sel[i] = entry; sl_p[i] = sl; tp_p[i] = entry - p.tp2_r * risk; tp1_p[i] = entry - p.tp1_r * risk; usedH = true; }
        }
      }
    }
    if (inAsia && k.open) { aH = Math.max(aH, b.h[i]); aL = Math.min(aL, b.l[i]); }
    if (k.open) { dH = Math.max(dH, b.h[i]); dL = Math.min(dL, b.l[i]); }
  }
  return { lel, sel, sl_p, tp_p, tp1_p, lx, sx, limitBars: p.limit_bars, maxHold: Math.max(1, Math.round(p.max_hold_h * 60 / tfMin)), tp1Frac: 0.5, beOffset: 0.0001, reverse: false };
}
/** NY opening range: the first or_min minutes after 09:30 ET set the direction; enter at the next open, stop at the
 *  range's other end, target tp_r × risk, flat at 16:00 ET. */
function orb(b, p, ctx) {
  const n = b.c.length, tfMin = ctx.tfMin, le = bools(n), se = bools(n), lx = bools(n), sx = bools(n), sl_p = nanArr(n), tp_p = nanArr(n);
  let sd = -1, oh = -Infinity, ol = Infinity, oo = NaN, oc = NaN, done = false;
  const END = 570 + p.or_min;
  for (let i = 0; i < n; i++) {
    const k = etClock(b.t[i]);
    if (k.sd !== sd) { sd = k.sd; oh = -Infinity; ol = Infinity; oo = NaN; oc = NaN; done = false; }
    if (k.m >= 570 && k.m < END) { if (oo !== oo) oo = b.o[i]; oh = Math.max(oh, b.h[i]); ol = Math.min(ol, b.l[i]); oc = b.c[i]; }
    if (!done && k.m + tfMin === END && k.sdow >= 1 && k.sdow <= 5 && oh > ol && oc !== oo) {
      const up = oc > oo, risk = up ? b.c[i] - ol : oh - b.c[i];
      if (risk > 0) { if (up) { le[i] = 1; sl_p[i] = ol; tp_p[i] = b.c[i] + p.tp_r * risk; } else { se[i] = 1; sl_p[i] = oh; tp_p[i] = b.c[i] - p.tp_r * risk; } }
      done = true;
    }
    if (k.m + tfMin >= 960 && k.m < 960 + tfMin) lx[i] = sx[i] = 1;
  }
  return { le, se, lx, sx, sl_p, tp_p, maxHold: 0, reverse: false };
}
export const FX_STRATS = {
  trend: FX_TREND,
  sweep: { title: 'Claude · Sweep & Reclaim (failed in research)', tf: '5m', tfs: ['1m', '5m', '15m'],
    params: { rng_atr: 1, wick: 0.5, ent_frac: 0.4, buf: 0.2, min_risk_bp: 5, tp1_r: 1, tp2_r: 2.5, limit_bars: 3, max_hold_h: 4, win0: 120, win1: 690, exit_m: 960 },
    help: { win0: 'Active from (minutes after midnight ET)', win1: 'Active until (minutes ET)', exit_m: 'Flat at (minutes ET)' }, signals: sweep },
  orb: { title: 'NY opening range, direction of the first minutes', tf: '5m', tfs: ['1m', '5m', '15m'],
    params: { or_min: 15, tp_r: 10 }, help: { or_min: 'Opening range length (minutes after 09:30 ET)', tp_r: 'Target in R (flat at 16:00 ET otherwise)' }, signals: orb },
  // lab strategies that need no volume (index candles have none)
  ...Object.fromEntries(['session_breakout', 'ema_pullback', 'rsi_ema'].map(id => [id, { ...STRATEGIES[id], title: `Lab · ${id}`, tfs: ['1m', '5m', '15m'] }])),
};

/** What the trend-pullback rule is waiting for on the last closed candle. */
export function trendState(b, p) {
  const k = b.forming ? b.c.length - 2 : b.c.length - 1;
  if (k < p.ema_n) return null;
  const e = ema(b.c, p.ema_n), r = rsi(b.c, p.rsi_n), c = b.c[k], up = c > e[k];
  const want = up ? `RSI under ${p.rsi_lo}` : `RSI over ${100 - p.rsi_lo}`;
  const armed = up ? r[k] < p.rsi_lo : r[k] > 100 - p.rsi_lo;
  return { up, ema: e[k], rsi: r[k], price: c, want, armed, gapPct: (c / e[k] - 1) * 100, rsiNeed: up ? p.rsi_lo : 100 - p.rsi_lo };
}

/** Broker CFD costs → engine fractions. spread in price units (round trip), commission in $ per lot round trip. */
export function brokerCost(inst, price, spread, comm, slipBp) {
  const perSide = (spread / 2 + comm / 2 / inst.lot) / price;
  return { fee_t: perSide, fee_m: perSide, slip: slipBp / 1e4 };
}
