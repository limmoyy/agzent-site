// Claude's strategy for the scanner: "Flush & Reclaim", plus the per-token read used by "Scan with Claude".
//
// Idea: on liquidation-prone perps, a 1h candle that sweeps below the recent low on heavy volume and then
// closes back in its upper half means forced selling got absorbed. Buy a limit in the lower part of that
// wick (maker fee), stop just under the wick (the level that proves the idea wrong), half off at 1R with the
// stop moved to break-even, the rest at 2.5R, out after 24h at the latest. Long only: the mirrored short
// (shooting-star after a squeeze) lost money out-of-sample, even with a bear-market filter.
//
// Research (Gate.io USDT perps, 30 tokens, 1h, 2025-09-02 → 2026-10-23, costs = taker 5 bp / maker 2 bp /
// slippage 1 bp, engine rules identical to scalping-lab, checked trade-for-trade):
//   chosen on the first half (to 2026-03-29):  385 trades, +43 bp/trade, win 58%, t = 2.4
//   second half, untouched while choosing:     356 trades, +25 bp/trade, win 56%, t = 1.9
//   holdout BTC + ETH 2021-09 → 2025-08 (Binance): BTC +1 bp (146 trades), ETH −22 bp (149 trades)
//   gains come from big flushes (stop ≥ 150 bp away); October 2025's crash alone is ~1/3 of the total.
// Longer holdout (Binance USDT perps, same 30 tokens where listed, 2022-01 → 2025-08, never used to choose):
//   all flushes 1794 trades, +1 bp (t 0.1; 2022 −27, 2023 +3, 2024 +17); stop ≥ 150 bp only: 664 trades, +24 bp (t 1.9).
//   The same window on Binance data gives +15 bp where Gate gives +34 bp: the size of the edge depends on the feed.
// 15m: the same rules lose (2022-01 → 2026-09, 7977 trades, −5 bp, ≈ 0 before costs) — small 15m flushes are
//   fee food. Keeping only big ones (range ≥ 2.5 ATR, stop ≥ 150 bp, sweep of the 12h low = 48 bars):
//   2022–23 124 trades +50 bp, 2024–26 318 trades +14 bp (t 0.7), positive in 4 of 5 years (2025 −23 bp).
// Verdict: a hypothesis with some evidence on alts, none on BTC/ETH. Paper-trade it, size small.
import { ema, atr, rsi, rollMedian, lowest, highest, nanArr, isn } from './ind.js';

export const CLAUDE = {
  title: 'Claude · Flush & Reclaim — buy the absorbed liquidation wick',
  src: 'claude', tf: '1h', tfs: ['1h', '15m', '4h'],
  params: { rng_atr: 1.5, vol_mult: 1.5, wick: 0.55, low_n: 24, ent_frac: 0.4, buf: 0.2, max_sl: 4, min_risk_bp: 40,
    tp1_r: 1, tp1_frac: 0.5, tp2_r: 2.5, be_off: 0.0008, limit_bars: 3, max_hold_h: 24, shorts: 0 },
  // per-timeframe overrides: on 15m only big flushes clear the fees
  byTf: { '15m': { rng_atr: 2.5, low_n: 48, min_risk_bp: 150 } },
  help: {
    rng_atr: 'Flush candle range ≥ this × ATR(14)', vol_mult: 'Volume ≥ this × 72-bar median', wick: 'Lower wick ≥ this share of the range',
    low_n: 'Must sweep the lowest low of this many bars (0 = off)', ent_frac: 'Limit entry at wick low + this × range',
    buf: 'Stop = wick low − this × ATR', max_sl: 'Skip when the stop is wider than this × ATR', min_risk_bp: 'Skip when the stop is closer than this (bp)',
    tp1_r: 'TP1 at this × risk (0 = off)', tp1_frac: 'Share closed at TP1', tp2_r: 'TP2 at this × risk', be_off: 'Break-even stop offset after TP1 (fraction)',
    limit_bars: 'Bars the limit order stays live', max_hold_h: 'Time stop (hours)', shorts: '1 = also short the mirrored squeeze (lost OOS)',
  },
  signals: claudeSignals,
};
export const claudeParams = tf => ({ ...CLAUDE.params, ...(CLAUDE.byTf[tf] || {}) });
const TF_HOURS = { '5m': 1 / 12, '15m': 0.25, '30m': 0.5, '1h': 1, '4h': 4 };
/** Hours covered by the sweep window (low_n bars) on this timeframe. */
export const sweepHours = (p, tf) => +(p.low_n * (TF_HOURS[tf] || 1)).toFixed(1);

export function claudeSignals(b, p, ctx = {}) {
  const n = b.c.length, { o, h, l, c, v } = b;
  const a = atr(b, 14), vmed = rollMedian(v, 72, 36), ll = lowest(l, Math.max(1, p.low_n)), hh = highest(h, Math.max(1, p.low_n));
  const lel = nanArr(n), sel = nanArr(n), sl_p = nanArr(n), tp_p = nanArr(n), tp1_p = nanArr(n);
  const why = new Array(n);
  for (let i = 210; i < n; i++) {
    const rng = h[i] - l[i]; if (!(rng > 0)) continue;
    const big = rng >= p.rng_atr * a[i - 1], busy = v[i] >= p.vol_mult * vmed[i - 1];
    if (!big || !busy) continue;
    const lw = (Math.min(o[i], c[i]) - l[i]) / rng, uw = (h[i] - Math.max(o[i], c[i])) / rng;
    let side = 0;
    if (lw >= p.wick && (!p.low_n || l[i] <= ll[i - 1])) side = 1;
    else if (p.shorts && uw >= p.wick && (!p.low_n || h[i] >= hh[i - 1])) side = -1;
    if (!side) continue;
    const ext = side === 1 ? l[i] : h[i];
    const entry = side === 1 ? Math.min(c[i], ext + p.ent_frac * rng) : Math.max(c[i], ext - p.ent_frac * rng);
    const sl = ext - side * p.buf * a[i], risk = Math.abs(entry - sl);
    if (risk / entry * 1e4 < p.min_risk_bp || risk > p.max_sl * a[i]) continue;
    if (side === 1) lel[i] = entry; else sel[i] = entry;
    sl_p[i] = sl; tp_p[i] = entry + side * p.tp2_r * risk; tp1_p[i] = p.tp1_r ? entry + side * p.tp1_r * risk : NaN;
    why[i] = { side, rngAtr: rng / a[i - 1], volX: v[i] / vmed[i - 1], wick: side === 1 ? lw : uw, sweep: side === 1 ? ll[i - 1] : hh[i - 1], ext, riskBp: risk / entry * 1e4 };
  }
  return { lel, sel, sl_p, tp_p, tp1_p, why, limitBars: p.limit_bars, maxHold: Math.max(1, Math.round(p.max_hold_h * 60 / (ctx.tfMin || 60))),
    tp1Frac: p.tp1_frac, beOffset: p.be_off, reverse: false };
}

// ── "Scan with Claude": per-token read ─────────────────────────────────────────────────────
const pctDist = (a, b) => (a / b - 1) * 100;

/** Context of one token at its last closed bar: trend, momentum, levels, regime. */
export function tokenContext(b, btc) {
  const n = b.c.length, i = n - 1, c = b.c;
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), r = rsi(c, 14), a = atr(b, 14);
  const lo24 = Math.min(...b.l.slice(-24)), hi24 = Math.max(...b.h.slice(-24));
  const lo72 = Math.min(...b.l.slice(-72)), hi72 = Math.max(...b.h.slice(-72));
  const ret24 = n > 24 ? pctDist(c[i], c[i - 24]) : NaN, ret168 = n > 168 ? pctDist(c[i], c[i - 168]) : NaN;
  const trend = e50[i] > e200[i] && c[i] > e200[i] ? 'up' : e50[i] < e200[i] && c[i] < e200[i] ? 'down' : 'range';
  let rs = NaN;
  if (btc && btc.c.length > 168 && n > 168) rs = ret168 - pctDist(btc.c[btc.c.length - 1], btc.c[btc.c.length - 169]);
  return { price: c[i], e20: e20[i], e50: e50[i], e200: e200[i], rsi: r[i], atr: a[i], atrPct: a[i] / c[i] * 100,
    lo24, hi24, lo72, hi72, ret24, ret168, trend, rs, distLo24: pctDist(c[i], lo24) };
}

/** Market read across the scanned tokens. */
export function marketRead(btcBars, ctxs) {
  const c = btcBars.c, e600 = ema(c, 600), e200 = ema(c, 200), i = c.length - 1;
  const list = Object.values(ctxs).filter(Boolean);
  const above = list.filter(x => x.price > x.e200).length;
  const btcRegime = isn(e600[i]) ? 'unknown' : c[i] > e600[i] ? 'bull' : 'bear';
  const ret24 = pctDist(c[i], c[i - 24]), ret168 = pctDist(c[i], c[i - 168]);
  return { btcRegime, btcPrice: c[i], btcE600: e600[i], btcAboveE200: c[i] > e200[i], btcRet24: ret24, btcRet168: ret168,
    breadth: list.length ? above / list.length : NaN, tokens: list.length,
    stressed: list.filter(x => x.ret24 < -5).length, ripping: list.filter(x => x.ret24 > 8).length };
}

/** Score a live setup 0–100 (ranking aid, not a probability). */
export function scoreSetup(setup, why, ctx, track, global, mkt) {
  let s = 50;
  const notes = [];
  if (why) {
    s += Math.min(12, (why.wick - 0.55) * 40);
    s += Math.min(8, (why.volX - 1.5) * 3);
    if (why.riskBp >= 150) { s += 10; notes.push('big flush (stop ≥ 150 bp) — where the research edge was'); }
    else notes.push('small flush — costs eat most of the edge here');
  }
  // the token's own record on this strategy, shrunk toward the pooled average (k = 10 trades)
  if (track && track.n) {
    const k = 10, shrunk = (track.n * track.avg + k * (global?.avg || 0)) / (track.n + k);
    s += Math.max(-15, Math.min(15, shrunk / 4));
    notes.push(`own record ${track.n} trades, ${track.avg >= 0 ? '+' : ''}${track.avg.toFixed(0)} bp avg`);
  }
  if (mkt) {
    if (mkt.btcRegime === 'bull') { s += 5; notes.push('BTC above its ~25-day EMA'); }
    else if (mkt.btcRegime === 'bear') { s -= 5; notes.push('BTC below its ~25-day EMA'); }
    if (mkt.stressed >= Math.max(3, mkt.tokens * 0.3)) { s -= 6; notes.push('market-wide selloff — flushes cluster, correlated risk'); }
  }
  if (ctx) {
    if (ctx.trend === 'down') { s -= 4; notes.push('token in a 1h downtrend'); }
    if (ctx.atrPct > 4) { s -= 6; notes.push('very volatile (ATR > 4%/h)'); }
  }
  if (setup && setup.kind === 'limit') {
    const gap = Math.abs(setup.price / ctx.price - 1) * 100;
    if (gap > 3) { s -= 8; notes.push(`entry ${gap.toFixed(1)}% away — may not fill`); }
  }
  return { score: Math.max(0, Math.min(100, Math.round(s))), notes };
}

const f = (v, d) => v == null || isn(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
export const digitsFor = p => p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 7;

/** Plain-language read Claude gives for one token. opt.tf = the setup's timeframe; opt.lo / opt.loH / opt.atr =
 *  that timeframe's sweep level, its window in hours and ATR (defaults: the 1h context's 24h low). */
export function narrative(sym, st, ctx, mkt, opt = {}) {
  const d = digitsFor(ctx.price), out = [];
  const name = sym.replace(/USDT$/, ''), tf = opt.tf || '1h', p = claudeParams(tf);
  const lo = opt.lo ?? ctx.lo24, loH = opt.loH ?? 24, a = opt.atr ?? ctx.atr;
  if (st.position) {
    const x = st.position, pnl = (ctx.price / x.ep - 1) * 100 * x.side;
    out.push(`${name}: in a Flush & Reclaim long from ${f(x.ep, d)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% now).`);
    out.push(x.tp1Hit ? `TP1 already banked; the rest runs to TP2 ${f(x.tp, d)} with the stop at break-even ${f(x.sl, d)}.`
      : `Stop ${f(x.sl, d)} under the flush wick, TP1 ${f(x.tp1, d)} (half), TP2 ${f(x.tp, d)}.`);
  } else if (st.pending) {
    const x = st.pending, w = st.why;
    out.push(`${name}: a ${tf} candle swept the ${loH}h low ${f(w?.sweep, d)} (range ${f(w?.rngAtr, 1)}× ATR, volume ${f(w?.volX, 1)}× normal) and closed with ${Math.round((w?.wick || 0) * 100)}% lower wick — sellers got absorbed.`);
    out.push(`Plan: buy limit ${f(x.price, d)} (live ${x.barsLeft} more bar${x.barsLeft > 1 ? 's' : ''}), stop ${f(x.sl, d)}, TP1 ${f(x.tp1, d)} for half, TP2 ${f(x.tp, d)}. Risk ${f(Math.abs(x.price - x.sl) / x.price * 100, 2)}%.`);
  } else {
    out.push(`${name}: no ${tf} flush setup now. Trend ${ctx.trend}, RSI ${f(ctx.rsi, 0)}, ${f(pctDist(ctx.price, lo), 1)}% above the ${loH}h low ${f(lo, d)}.`);
    out.push(`Watch: a ${tf} candle that wicks below ${f(lo, d)} with a ≥ ${f(p.rng_atr * a / ctx.price * 100, 1)}% range on heavy volume and closes in its upper half arms a setup${p.min_risk_bp >= 100 ? ` (only if the stop ends up ≥ ${f(p.min_risk_bp / 100, 1)}% away)` : ''}.`);
  }
  if (mkt && mkt.btcRegime === 'bear' && (st.pending || st.position)) out.push('BTC is below its ~25-day EMA: flushes can keep flushing — keep size small.');
  return out;
}

// ── Forming setups: the still-open candle measured against the rules ───────────────────────
// A Flush & Reclaim setup can only arm when a candle closes, so between closes the useful question is
// "which candle is on its way to becoming one?". Tiers:
//   arming   — passes every rule right now: if it closes like this, a buy limit arms at the close
//   sweeping — took out the 24h low but has not closed back up / range / volume not there yet
//   near     — its low is within 1 ATR of the 24h low: a sweep is one push away
const median = a => { const s = [...a].filter(v => v === v).sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };

/** b = candles incl. the forming one (b.forming), now = unix seconds, tfSec = candle length.
 *  lo = the sweep level (lowest low of the previous low_n candles), loH = that window in hours. */
export function formingState(b, p, now, tfSec = 3600) {
  const n = b.c.length;
  if (n < 220) return null;
  const forming = !!b.forming, prev = forming ? n - 2 : n - 1;
  const AT = atr(b, 14), A = AT[prev], lo = Math.min(...b.l.slice(prev - p.low_n + 1, prev + 1)), vm = median(b.v.slice(prev - 71, prev + 1));
  const openT = forming ? b.t[n - 1] : b.t[prev] + tfSec, closesAt = openT + tfSec, loH = +(p.low_n * tfSec / 3600).toFixed(1);
  const base = { lo, loH, atr: A, closesAt, openT, tfMin: tfSec / 60 };
  if (!forming || !(A > 0)) {
    const distAtr = (b.c[prev] - lo) / A;
    return { ...base, tier: distAtr <= 1 ? 'near' : null, distAtr, price: b.c[prev], elapsed: 0 };
  }
  const i = n - 1, o = b.o[i], h = b.h[i], l = b.l[i], c = b.c[i], v = b.v[i], rng = h - l;
  const elapsed = Math.min(1, Math.max(0, (now - b.t[i]) / tfSec));
  const volPace = v / Math.max(elapsed, 1 / 12) / vm; // volume projected to the full candle
  const wick = rng > 0 ? (Math.min(o, c) - l) / rng : 0;
  const Ai = AT[i], entry = Math.min(c, l + p.ent_frac * rng), sl = l - p.buf * Ai, risk = entry - sl;
  const would = { entry, sl, tp1: entry + p.tp1_r * risk, tp: entry + p.tp2_r * risk, riskBp: risk / entry * 1e4 };
  const checks = [
    { k: 'sweep', label: `Sweeps ${loH}h low`, ok: l <= lo, now: l <= lo ? `−${((lo - l) / lo * 100).toFixed(2)}%` : `${((l - lo) / lo * 100).toFixed(2)}% above`, need: `a new ${loH}h low` },
    { k: 'range', label: 'Range', ok: rng / A >= p.rng_atr, now: `${(rng / A).toFixed(2)}× ATR`, need: `${p.rng_atr}×` },
    { k: 'vol', label: 'Volume pace', ok: volPace >= p.vol_mult, now: `${volPace.toFixed(2)}×`, need: `${p.vol_mult}×` },
    { k: 'wick', label: 'Lower wick', ok: wick >= p.wick, now: `${Math.round(wick * 100)}%`, need: `${Math.round(p.wick * 100)}%` },
    { k: 'risk', label: 'Stop distance', ok: would.riskBp >= p.min_risk_bp && risk <= p.max_sl * Ai, now: `${would.riskBp.toFixed(0)} bp`, need: `${p.min_risk_bp} bp – ${p.max_sl} ATR` },
  ];
  const distAtr = (l - lo) / A;
  const tier = checks.every(x => x.ok) ? 'arming' : checks[0].ok ? 'sweeping' : distAtr <= 1 ? 'near' : null;
  return { ...base, tier, checks, would, distAtr, price: c, low: l, elapsed, passed: checks.filter(x => x.ok).length };
}

/** Plain-language line for a forming setup. */
export function formingSay(sym, st) {
  const name = sym.replace(/USDT$/, ''), d = digitsFor(st.price);
  if (st.tier === 'arming') return `${name}: this candle swept the ${st.loH}h low on heavy volume and is back up with a long lower wick. If it closes like this, Claude arms a buy limit at ${f(st.would.entry, d)} — stop ${f(st.would.sl, d)}, TP1 ${f(st.would.tp1, d)}, TP2 ${f(st.would.tp, d)}.`;
  if (st.tier === 'sweeping') {
    const miss = st.checks.filter(x => !x.ok).map(x => `${x.label.toLowerCase()} ${x.now} (needs ${x.need})`);
    return `${name}: flush in progress — it broke the ${st.loH}h low ${f(st.lo, d)}. Still missing: ${miss.join(', ')}. Levels move until the candle closes.`;
  }
  return `${name}: low is ${st.distAtr.toFixed(2)} ATR above the ${st.loH}h low ${f(st.lo, d)}. A heavy-volume wick below it that closes back up would start a setup.`;
}
