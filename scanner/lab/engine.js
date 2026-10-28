// Scanner lab engine: indicators, bar-by-bar backtest, strategies and the money simulation.
// Shared by /scanner (browser) and node research scripts, so the page and the research run the same code.
// Port of scalping-lab's engine rules, simulated on the candles of the signal timeframe (the lab uses a
// 1-minute grid, so results here are close to the lab but not identical):
//   - signal read at the close of bar t, market order filled at the open of bar t+1 (+slippage, taker fee)
//   - limit entry placed at close t, active bars t+1..t+limitBars, fills only when price trades THROUGH the
//     level (touch is not enough), at the level, maker fee, post-only (already-marketable level rejected)
//   - stop-entry fills when touched, at max(open, level) for longs
//   - stop beats take-profit when both are inside one bar; gaps through the stop fill at the open
//   - on the bar a limit fills, take-profit is checked against the close (the high may have come first)
//   - optional partial take-profit (tp1): fraction closed at tp1 (maker), stop moves to break-even next bar

export const TF_MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240 };
export const COSTS = { fee_t: 0.0005, fee_m: 0.0002, slip: 0.0001 };

import { nanArr, isn, dayOf, ema, rma, sma, rollStd, rollMedian, rollMean, highest, lowest, atr, rsi, bbands, vwapSession, nyOffset } from './ind.js';
export * from './ind.js';

// ── backtest engine ─────────────────────────────────────────────────────────────────────────
export const REASON = { 1: 'Stop-loss', 2: 'Take-profit', 3: 'Trailing', 4: 'Exit signal', 5: 'Time stop', 6: 'Still open', 7: 'Break-even' };
const SL = 1, TP = 2, TRAIL = 3, SIGNAL = 4, TIME = 5, END = 6, BE = 7;

function col(sig, name, n, fill) { const a = sig[name]; return a && a.length === n ? a : (fill === false ? new Uint8Array(n) : nanArr(n)); }

/** Run one backtest. bars = {t,o,h,l,c,v} arrays; sig = signal arrays (see strategies). */
export function run(bars, sig, opt = {}) {
  const n = bars.c.length;
  const { fee_t, fee_m, slip } = { ...COSTS, ...opt };
  const maxHold = opt.maxHold ?? sig.maxHold ?? 0, limitBars = Math.max(1, opt.limitBars ?? sig.limitBars ?? 1);
  const reverse = opt.reverse ?? sig.reverse ?? true, start = opt.start ?? 0, end = opt.end ?? n;
  const tp1Frac = sig.tp1Frac ?? 0.5, beOff = sig.beOffset ?? 0;
  const pen = opt.limPen ?? 0; // a resting limit fills only once price trades this fraction beyond it (spread on CFDs)
  const { o, h, l, c } = bars;
  const le = col(sig, 'le', n, false), se = col(sig, 'se', n, false), lx = col(sig, 'lx', n, false), sx = col(sig, 'sx', n, false);
  const les = col(sig, 'les', n), ses = col(sig, 'ses', n), lel = col(sig, 'lel', n), sel = col(sig, 'sel', n);
  const sl_d = col(sig, 'sl_d', n), tp_d = col(sig, 'tp_d', n), tr_d = col(sig, 'tr_d', n);
  const sl_p = col(sig, 'sl_p', n), tp_p = col(sig, 'tp_p', n), tp1_p = col(sig, 'tp1_p', n), tp1_d = col(sig, 'tp1_d', n);
  const st_l = col(sig, 'st_l', n), st_s = col(sig, 'st_s', n);
  const trades = [], orders = [];
  let pos = 0, ep = 0, eidx = 0, fee_e = fee_t, sl = NaN, tp = NaN, tp1 = NaN, trail = NaN, best = 0, worst = 0;
  let part = 0, partPx = NaN, sigBar = -1, initSl = NaN;
  let p_exit = false, p_rsn = SIGNAL, p_entry = 0, p_les = NaN, p_ses = NaN, p_bar = -1;
  let p_sl = NaN, p_tp = NaN, p_tr = NaN, p_slp = NaN, p_tpp = NaN, p_tp1 = NaN, p_tp1d = NaN;
  let q_l = NaN, q_s = NaN, q_left = 0, q_bar = 0, q_sl = NaN, q_tp = NaN, q_tr = NaN, q_slp = NaN, q_tpp = NaN, q_tp1 = NaN, q_tp1d = NaN;

  const close = (t, xp, rsn, fee_x) => {
    const rem = 1 - part;
    let net = rem * (pos * (xp - ep) / ep - fee_x * xp / ep) - fee_e;
    let gross = rem * pos * (xp - ep) / ep;
    if (part) { net += part * (pos * (partPx - ep) / ep - fee_m * partPx / ep); gross += part * pos * (partPx - ep) / ep; }
    if (part && rsn === SL) rsn = BE;
    trades.push({ ei: eidx, xi: t, side: pos, ep, xp, reason: rsn, net, gross, sl: initSl, tp, tp1: part ? partPx : tp1,
      tp1Hit: !!part, mae: worst, mfe: best, sigBar, open: rsn === END });
    pos = 0; part = 0; partPx = NaN;
  };
  const drop = (bar, ql, qs, status, endBar) => {
    if (!isn(ql)) orders.push({ bar, side: 1, price: ql, status, end: endBar });
    if (!isn(qs)) orders.push({ bar, side: -1, price: qs, status, end: endBar });
  };
  const bracket = (base, slp, sld, tpp, tpd, t1p, t1d) => {
    sl = !isn(slp) ? slp : (!isn(sld) ? base - pos * sld : NaN);
    tp = !isn(tpp) ? tpp : (!isn(tpd) ? base + pos * tpd : NaN);
    tp1 = !isn(t1p) ? t1p : (!isn(t1d) ? base + pos * t1d : NaN);
    initSl = sl;
  };

  for (let t = start; t < end; t++) {
    // 1) orders pending from the previous close
    if (pos !== 0 && p_exit) close(t, o[t] * (1 - slip * pos), p_rsn, fee_t);
    let opened = false, limNow = false;
    if (pos === 0) {
      let nw = 0, px = 0;
      if (p_entry !== 0) { nw = p_entry; px = o[t]; }
      else {
        let hl = !isn(p_les) && h[t] >= p_les, hs = !isn(p_ses) && l[t] <= p_ses;
        if (hl && hs) { if (Math.abs(p_les - o[t]) <= Math.abs(o[t] - p_ses)) hs = false; else hl = false; }
        if (hl) { nw = 1; px = Math.max(o[t], p_les); } else if (hs) { nw = -1; px = Math.min(o[t], p_ses); }
      }
      if (nw === 0 && q_left > 0) {
        let hl = !isn(q_l) && l[t] < q_l * (1 - pen), hs = !isn(q_s) && h[t] > q_s * (1 + pen);
        if (hl && hs) { if (o[t] - q_l <= q_s - o[t]) hs = false; else hl = false; }
        if (hl || hs) {
          nw = hl ? 1 : -1; px = hl ? q_l : q_s; limNow = true;
          orders.push({ bar: q_bar, side: nw, price: px, status: 'filled', end: t });
          drop(q_bar, hl ? NaN : q_l, hs ? NaN : q_s, 'cancelled', t);
          q_left = 0;
        } else if (--q_left === 0) drop(q_bar, q_l, q_s, 'expired', t);
      } else if (nw !== 0 && q_left > 0) { drop(q_bar, q_l, q_s, 'cancelled', t); q_left = 0; }
      if (nw !== 0) {
        pos = nw; eidx = t; part = 0;
        if (limNow) { ep = px; fee_e = fee_m; sigBar = q_bar; bracket(ep, q_slp, q_sl, q_tpp, q_tp, q_tp1, q_tp1d); trail = q_tr; }
        else { ep = px * (1 + slip * pos); fee_e = fee_t; sigBar = p_bar; bracket(ep, p_slp, p_sl, p_tpp, p_tp, p_tp1, p_tp1d); trail = p_tr; }
        best = 0; worst = 0; opened = true;
      }
    }
    p_exit = false; p_entry = 0; p_les = NaN; p_ses = NaN;

    // 2) stop / take-profit inside the bar
    if (pos !== 0) {
      // adverse excursion: the extreme against us can always come after the fill
      const adv = pos === 1 ? l[t] / ep - 1 : 1 - h[t] / ep;
      if (adv < worst) worst = adv;
      let stop = sl, srsn = SL;
      if (!isn(trail)) {
        const ext = ep * (1 + pos * best), ts = ext - pos * trail;
        if (isn(stop) || (pos === 1 && ts > stop) || (pos === -1 && ts < stop)) { stop = ts; srsn = TRAIL; }
      }
      let xp = NaN, rsn = 0, fee_x = fee_t;
      if (opened && ((!isn(stop) && (stop - ep) * pos >= 0) || (!isn(tp) && (tp - ep) * pos <= 0))) {
        xp = ep * (1 - slip * pos); rsn = !isn(stop) && (stop - ep) * pos >= 0 ? srsn : TP;
      } else if (!isn(stop)) {
        if ((!opened || limNow) && ((pos === 1 && o[t] <= stop) || (pos === -1 && o[t] >= stop))) { xp = o[t] * (1 - slip * pos); rsn = srsn; }
        else if ((pos === 1 && l[t] <= stop) || (pos === -1 && h[t] >= stop)) { xp = stop * (1 - slip * pos); rsn = srsn; }
      }
      if (isn(xp)) {
        const hi = limNow ? c[t] : h[t], lo = limNow ? c[t] : l[t];
        const reach = lv => (pos === 1 && hi >= lv) || (pos === -1 && lo <= lv);
        if (!part && !isn(tp1) && reach(tp1)) {
          part = tp1Frac; partPx = tp1;
          sl = ep * (1 + pos * beOff); // break-even from the next bar (inside this bar the order is unknown)
        }
        if (!isn(tp) && reach(tp)) { xp = tp; rsn = TP; fee_x = fee_m; }
      }
      if (!isn(xp)) close(t, xp, rsn, fee_x);
    }

    // 3) favourable extreme for trailing + dynamic stops (valid from the next bar)
    if (pos !== 0) {
      const fav = pos === 1 ? (limNow ? c[t] : h[t]) / ep - 1 : 1 - (limNow ? c[t] : l[t]) / ep;
      if (fav > best) best = fav;
      if (pos === 1 && !isn(st_l[t])) sl = st_l[t];
      else if (pos === -1 && !isn(st_s[t])) sl = st_s[t];
    }

    // 4) close of the bar: time exit and signals → orders for the next bar
    if (pos !== 0 && maxHold > 0 && t - eidx + 1 >= maxHold) { p_exit = true; p_rsn = TIME; }
    if ((pos === 1 && lx[t]) || (pos === -1 && sx[t])) { p_exit = true; p_rsn = SIGNAL; }
    if (pos !== 0 && !reverse) { /* ignore entries while in a position */ }
    else if (le[t] && !se[t] && pos !== 1) { p_entry = 1; if (pos === -1) { p_exit = true; p_rsn = SIGNAL; } }
    else if (se[t] && !le[t] && pos !== -1) { p_entry = -1; if (pos === 1) { p_exit = true; p_rsn = SIGNAL; } }
    if (pos === 0 && p_entry === 0) {
      p_les = les[t]; p_ses = ses[t];
      if (!isn(lel[t]) || !isn(sel[t])) {
        if (q_left > 0) drop(q_bar, q_l, q_s, 'cancelled', t);
        q_l = lel[t]; q_s = sel[t];
        if (!isn(q_l) && q_l > c[t]) { orders.push({ bar: t, side: 1, price: q_l, status: 'rejected', end: t }); q_l = NaN; }
        if (!isn(q_s) && q_s < c[t]) { orders.push({ bar: t, side: -1, price: q_s, status: 'rejected', end: t }); q_s = NaN; }
        q_left = (!isn(q_l) || !isn(q_s)) ? limitBars : 0;
        q_bar = t; q_sl = sl_d[t]; q_tp = tp_d[t]; q_tr = tr_d[t]; q_slp = sl_p[t]; q_tpp = tp_p[t]; q_tp1 = tp1_p[t]; q_tp1d = tp1_d[t];
      }
    } else if (pos === 0 && q_left > 0) { drop(q_bar, q_l, q_s, 'cancelled', t); q_left = 0; }
    if (p_entry !== 0 || !isn(p_les) || !isn(p_ses)) {
      p_bar = t; p_sl = sl_d[t]; p_tp = tp_d[t]; p_tr = tr_d[t]; p_slp = sl_p[t]; p_tpp = tp_p[t]; p_tp1 = tp1_p[t]; p_tp1d = tp1_d[t];
    }
  }
  // what is live right now (after the last bar)
  const live = {};
  if (pos !== 0) {
    live.position = { side: pos, ep, ei: eidx, sl, sl0: initSl, tp, tp1: part ? partPx : tp1, tp1Hit: !!part, sigBar, last: c[end - 1] };
    close(end - 1, c[end - 1] * (1 - slip * pos), END, fee_t);
  }
  if (q_left > 0) {
    const side = !isn(q_l) ? 1 : -1, px = side === 1 ? q_l : q_s;
    const b = (slp, sld, tpp, tpd) => !isn(slp) ? slp : (!isn(sld) ? px - side * sld : NaN);
    const f = (tpp, tpd) => !isn(tpp) ? tpp : (!isn(tpd) ? px + side * tpd : NaN);
    live.pending = { kind: 'limit', side, price: px, sl: b(q_slp, q_sl), tp: f(q_tpp, q_tp), tp1: f(q_tp1, q_tp1d), barsLeft: q_left, sigBar: q_bar };
    drop(q_bar, q_l, q_s, 'cancelled', end - 1);
  } else if (p_entry !== 0 && pos === 0) {
    const px = c[end - 1], side = p_entry;
    live.pending = { kind: 'market', side, price: px,
      sl: !isn(p_slp) ? p_slp : px - side * p_sl, tp: !isn(p_tpp) ? p_tpp : (!isn(p_tp) ? px + side * p_tp : NaN),
      tp1: !isn(p_tp1) ? p_tp1 : (!isn(p_tp1d) ? px + side * p_tp1d : NaN), barsLeft: 1, sigBar: p_bar };
  } else if (pos === 0 && (!isn(p_les) || !isn(p_ses))) {
    const side = !isn(p_les) ? 1 : -1, px = side === 1 ? p_les : p_ses;
    live.pending = { kind: 'stop', side, price: px, sl: !isn(p_slp) ? p_slp : px - side * p_sl,
      tp: !isn(p_tpp) ? p_tpp : (!isn(p_tp) ? px + side * p_tp : NaN), tp1: NaN, barsLeft: 1, sigBar: p_bar };
  }
  return { trades, orders, live };
}

// ── statistics ──────────────────────────────────────────────────────────────────────────────
export function stats(trades) {
  const closed = trades.filter(x => !x.open), n = closed.length;
  if (!n) return { n: 0 };
  const bp = closed.map(x => x.net * 1e4);
  const sum = bp.reduce((a, b) => a + b, 0), avg = sum / n;
  const sd = n > 1 ? Math.sqrt(bp.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
  let cum = 0, peak = 0, dd = 0;
  for (const v of bp) { cum += v; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const wins = bp.filter(v => v > 0), losses = bp.filter(v => v <= 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  const rs = closed.filter(x => !isn(x.sl)).map(x => x.net / Math.abs(x.ep - x.sl) * x.ep);
  return { n, win: wins.length / n, avg, sum, sd, t: sd ? avg / sd * Math.sqrt(n) : 0, pf: gl ? gw / gl : (gw ? Infinity : 0),
    maxdd: dd, best: Math.max(...bp), worst: Math.min(...bp), avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN,
    tp: closed.filter(x => x.reason === TP).length, sl: closed.filter(x => x.reason === SL).length };
}

// ── money simulation (one shared balance, several tokens, max N positions) ───────────────────
// trades: [{sym, tIn, tOut, net, mae, slFrac}] (times in seconds). Isolated margin: a trade whose worst
// excursion reaches 1/leverage − maintenance loses its whole margin. Funding fees are not modelled.
export function simulateMoney(trades, cfg) {
  const { capital = 100, mode = 'margin', marginPct = 10, riskPct = 1, leverage = 10, compound = true, maxPos = 3,
    mmr = 0.004, dailyLoss = 0, dailyTarget = 0, autoLev = true } = cfg;
  const list = [...trades].filter(x => !x.open).sort((a, b) => a.tIn - b.tIn || a.tOut - b.tOut);
  let bal = capital, peak = capital, maxdd = 0, liq = 0, skipped = 0, skippedDay = 0, ruined = false;
  const open = [], taken = [], curve = [{ t: list.length ? list[0].tIn : 0, bal: capital }];
  const dayPnl = new Map();
  const settle = upTo => {
    open.sort((a, b) => a.tOut - b.tOut);
    while (open.length && open[0].tOut <= upTo) {
      const p = open.shift(); bal += p.pnl;
      const d = Math.floor((p.tOut + 7 * 3600) / 86400); // WIB day
      dayPnl.set(d, (dayPnl.get(d) || 0) + p.pnl);
      peak = Math.max(peak, bal); maxdd = Math.min(maxdd, peak ? (bal - peak) / peak : 0);
      curve.push({ t: p.tOut, bal });
      if (bal < capital * 0.01) ruined = true;
    }
  };
  for (const x of list) {
    settle(x.tIn);
    if (ruined) break;
    const d = Math.floor((x.tIn + 7 * 3600) / 86400), dp = dayPnl.get(d) || 0;
    if ((dailyLoss > 0 && dp <= -dailyLoss) || (dailyTarget > 0 && dp >= dailyTarget)) { skippedDay++; continue; }
    if (open.length >= maxPos) { skipped++; continue; }
    const used = open.reduce((a, p) => a + p.margin, 0), base = compound ? bal : capital;
    let margin, notional, lev = leverage;
    if (mode === 'risk' && x.slFrac > 0) {
      // size from the stop distance; with autoLev the leverage drops until liquidation sits 1.5× beyond the stop
      if (autoLev) lev = Math.max(1, Math.min(leverage, Math.floor(1 / (1.5 * x.slFrac + mmr))));
      notional = Math.min(base * riskPct / 100 / x.slFrac, base * lev);
      margin = notional / lev;
    } else { margin = base * marginPct / 100; notional = margin * lev; }
    if (margin > bal - used + 1e-9) { margin = Math.max(0, bal - used); notional = margin * lev; }
    if (margin <= 0) { skipped++; continue; }
    const isLiq = x.mae <= -Math.max(1 / lev - mmr, 0);
    const pnl = isLiq ? -margin : notional * x.net;
    if (isLiq) liq++;
    const rec = { ...x, margin, notional, lev, pnl, liq: isLiq };
    open.push(rec); taken.push(rec);
  }
  settle(Infinity);
  const days = [...dayPnl.entries()].sort((a, b) => a[0] - b[0]);
  return { final: bal, ret: bal / capital - 1, maxdd, liq, skipped, skippedDay, ruined, taken, curve,
    winDays: days.filter(d => d[1] > 0).length, lossDays: days.filter(d => d[1] < 0).length, days };
}

// ── strategies ──────────────────────────────────────────────────────────────────────────────
// signals(bars, p, ctx) returns arrays: le/se (bool, market next open), lx/sx (exit), lel/sel (limit levels),
// les/ses (stop-entry levels), sl_d/tp_d/tr_d (distances), sl_p/tp_p/tp1_p (absolute), st_l/st_s,
// plus limitBars / maxHold (bars) / tp1Frac / beOffset. ctx = { tfMin, btc } (btc = BTC bars, same grid).
const bools = n => new Uint8Array(n);
const holdBars = (min, ctx) => min ? Math.max(1, Math.round(min / ctx.tfMin)) : 0;

function rsiEma(b, p, ctx) {
  const n = b.c.length, e = ema(b.c, p.ema_n), r = rsi(b.c, p.rsi_n), le = bools(n), se = bools(n), sl_d = nanArr(n), tp_d = nanArr(n);
  for (let i = 0; i < n; i++) {
    le[i] = b.c[i] > e[i] && r[i] < p.rsi_lo; se[i] = b.c[i] < e[i] && r[i] > 100 - p.rsi_lo;
    sl_d[i] = p.sl * b.c[i]; tp_d[i] = p.tp * b.c[i];
  }
  return { le, se, sl_d, tp_d, maxHold: holdBars(p.max_hold, ctx) };
}
function vwapBbRsi(b, p, ctx) {
  const n = b.c.length, vw = vwapSession(b, b.c), r = rsi(b.c, p.rsi_n), bb = bbands(b.c, p.bb_n, p.bb_k), a = atr(b, p.atr_n);
  const le = bools(n), se = bools(n), lx = bools(n), sx = bools(n), sl_p = nanArr(n), tp_p = nanArr(n);
  let ab = 0, bl = 0;
  for (let i = 0; i < n; i++) {
    ab = b.c[i] >= vw[i] ? ab + 1 : 0; bl = b.c[i] <= vw[i] ? bl + 1 : 0;
    const d = p.atr_mult * a[i];
    le[i] = ab >= p.trend_n && b.c[i] <= bb.lo[i] && r[i] < 45;
    se[i] = bl >= p.trend_n && b.c[i] >= bb.up[i] && r[i] > 55;
    sl_p[i] = le[i] ? b.c[i] - d : b.c[i] + d; tp_p[i] = le[i] ? b.c[i] + p.rr * d : b.c[i] - p.rr * d;
    lx[i] = r[i] >= 90; sx[i] = r[i] <= 10;
  }
  return { le, se, lx, sx, sl_p, tp_p, maxHold: holdBars(p.max_hold, ctx) };
}
function impulseFollow(b, p, ctx) {
  const n = b.c.length, r = nanArr(n);
  for (let i = p.look; i < n; i++) r[i] = b.c[i] / b.c[i - p.look] - 1;
  const sd = rollStd(r, p.z_n, p.z_n >> 1, 1), vm = rollMean(b.v, p.look, p.look), vmed = rollMedian(b.v, p.z_n, p.z_n >> 1), a = atr(b, p.atr_n);
  const lel = nanArr(n), sel = nanArr(n), le = bools(n), se = bools(n), sl_d = nanArr(n), tp_d = nanArr(n);
  for (let i = 0; i < n; i++) {
    const z = r[i] / sd[i], busy = vm[i] > p.vol_mult * vmed[i];
    const up = z > p.z_th && busy, dn = z < -p.z_th && busy;
    if (p.offset) { if (up) lel[i] = b.c[i] - p.offset * a[i]; if (dn) sel[i] = b.c[i] + p.offset * a[i]; }
    else { le[i] = up; se[i] = dn; }
    sl_d[i] = p.sl_atr * a[i]; tp_d[i] = p.tp_atr ? p.tp_atr * a[i] : NaN;
  }
  return { le, se, lel, sel, sl_d, tp_d, limitBars: p.limit_bars, maxHold: holdBars(p.max_hold, ctx) };
}
function trendPullback(b, p, ctx) {
  const n = b.c.length, e = ema(b.c, p.trend_n), r = rsi(b.c, p.rsi_n), a = atr(b, p.atr_n);
  const lel = nanArr(n), sel = nanArr(n), sl_d = nanArr(n), tp_d = nanArr(n);
  for (let i = 0; i < n; i++) {
    const rising = i >= p.slope_n && e[i] > e[i - p.slope_n], wide = p.tp_atr * a[i] / b.c[i] * 1e4 >= p.min_tp_bp;
    if (b.c[i] > e[i] && rising && r[i] < p.rsi_lo && wide) lel[i] = b.c[i] - p.offset * a[i];
    if (b.c[i] < e[i] && !rising && i >= p.slope_n && r[i] > 100 - p.rsi_lo && wide) sel[i] = b.c[i] + p.offset * a[i];
    sl_d[i] = p.sl_atr * a[i]; tp_d[i] = p.tp_atr * a[i];
  }
  return { lel, sel, sl_d, tp_d, limitBars: p.limit_bars, maxHold: holdBars(p.max_hold, ctx) };
}
function emaPullback(b, p, ctx) {
  const n = b.c.length, c = b.c, e1 = ema(c, p.fast), e2 = ema(c, p.mid), e3 = ema(c, p.slow);
  const le = bools(n), se = bools(n), sl_d = nanArr(n), tp_d = nanArr(n);
  let minC = Infinity, maxC = -Infinity;
  for (let i = 1; i < n; i++) {
    const xu = c[i] < e1[i] && c[i - 1] >= e1[i - 1], xo = c[i] > e1[i] && c[i - 1] <= e1[i - 1];
    minC = xu ? c[i] : Math.min(minC, c[i]); maxC = xo ? c[i] : Math.max(maxC, c[i]);
    le[i] = e1[i] > e2[i] && e2[i] > e3[i] && xo && e3[i] < minC && minC < e1[i] && (c[i] - e2[i]) / c[i] > p.min_gap;
    se[i] = e1[i] < e2[i] && e2[i] < e3[i] && xu && e1[i] < maxC && maxC < e3[i] && (e2[i] - c[i]) / c[i] > p.min_gap;
    const risk = Math.abs(c[i] - e2[i]); sl_d[i] = risk; tp_d[i] = p.rr * risk;
  }
  return { le, se, sl_d, tp_d, maxHold: holdBars(p.max_hold, ctx) };
}
function orbNy(b, p, ctx) {
  const n = b.c.length, le = bools(n), se = bools(n), lx = bools(n), sx = bools(n), sl_p = nanArr(n), tp_d = nanArr(n);
  const days = { weekdays: [1, 2, 3, 4, 5], tue_wed_fri: [2, 3, 5] }[p.days] || [1, 2, 3, 4, 5];
  const OPEN = 570, LAST = 720, CLOSE = 960;
  let day = -1, oh = -Infinity, ol = Infinity, done = false, rangeEnd = 0;
  // the opening-range high/low is only used after the window ends, so the running max is causal
  for (let i = 0; i < n; i++) {
    const lt = b.t[i] + nyOffset(b.t[i]) * 3600, d = Math.floor(lt / 86400), m = Math.floor((lt % 86400) / 60);
    if (d !== day) { day = d; oh = -Infinity; ol = Infinity; done = false; }
    rangeEnd = OPEN + p.range_min;
    if (m >= OPEN && m < rangeEnd) { oh = Math.max(oh, b.h[i]); ol = Math.min(ol, b.l[i]); }
    const dow = new Date(lt * 1000).getUTCDay(), w = oh - ol;
    if (days.includes(dow) && m >= rangeEnd && m < LAST && w > 0 && !done) {
      if (b.c[i] > oh) { le[i] = 1; done = true; }
      else if (b.c[i] < ol) { se[i] = 1; done = true; }
      if (le[i] || se[i]) { sl_p[i] = p.stop === 'mid' ? (oh + ol) / 2 : (le[i] ? ol : oh); tp_d[i] = p.tp_mult * w; }
    }
    if (m >= CLOSE && m < CLOSE + ctx.tfMin) lx[i] = sx[i] = 1;
  }
  return { le, se, lx, sx, sl_p, tp_d, maxHold: holdBars(p.max_hold, ctx) };
}
function sessionBreakout(b, p, ctx) {
  const n = b.c.length, a = atr(b, p.atr_n), fh = highest(b.h, p.fast_n), fl = lowest(b.l, p.fast_n), inst = ema(b.c, 3);
  const les = nanArr(n), ses = nanArr(n), sl_p = nanArr(n), st_l = nanArr(n), st_s = nanArr(n), lx = bools(n), sx = bools(n);
  let day = -1, dh = -Infinity, dl = Infinity;
  for (let i = 0; i < n; i++) {
    const d = dayOf(b.t[i]);
    if (d !== day) { day = d; dh = -Infinity; dl = Infinity; }
    dh = Math.max(dh, b.h[i]); dl = Math.min(dl, b.l[i]);
    const fH = Math.min(dh, fh[i]), fL = Math.max(dl, fl[i]), fm = (fH + fL) / 2, smid = (dh + dl) / 2;
    const cloud = (fm - smid) / a[i], hour = Math.floor((b.t[i] % 86400) / 3600), inS = hour >= p.sess_start && hour < p.sess_end;
    const gl = inS && inst[i] > fm && cloud > p.thr, gs = inS && inst[i] < fm && cloud < -p.thr;
    if (gl) les[i] = dh; if (gs) ses[i] = dl;
    sl_p[i] = gl ? fL : fH; st_l[i] = fL; st_s[i] = fH;
    lx[i] = cloud < 0 || !inS; sx[i] = cloud > 0 || !inS;
  }
  return { les, ses, sl_p, st_l, st_s, lx, sx, maxHold: holdBars(p.max_hold, ctx) };
}
function vwapBandFade(b, p, ctx) {
  const n = b.c.length, { vwap, sd } = vwapSession(b, null, true), a = atr(b, 14);
  const le = bools(n), se = bools(n), lx = bools(n), sx = bools(n), sl_p = nanArr(n);
  const { o, h, l, c } = b;
  for (let i = 0; i < n; i++) {
    const up = vwap[i] + p.sd_mult * sd[i], lo = vwap[i] - p.sd_mult * sd[i], volOk = !(p.sd_mult * sd[i] < p.vol_mult * a[i]);
    const rng = h[i] > l[i] ? h[i] - l[i] : NaN, bull = isn(rng) ? 0 : (c[i] - l[i]) / rng, bear = isn(rng) ? 0 : (h[i] - c[i]) / rng;
    le[i] = volOk && o[i] < lo && c[i] > lo && bull >= p.strength;
    se[i] = volOk && o[i] > up && c[i] < up && bear >= p.strength;
    sl_p[i] = le[i] ? l[i] - p.stop_atr * a[i] : h[i] + p.stop_atr * a[i];
    const tl = p.target === 'vwap' ? vwap[i] : up, ts = p.target === 'vwap' ? vwap[i] : lo;
    const d3 = i >= 2 && c[i] < o[i] && c[i - 1] < o[i - 1] && c[i - 2] < o[i - 2], u3 = i >= 2 && c[i] > o[i] && c[i - 1] > o[i - 1] && c[i - 2] > o[i - 2];
    lx[i] = h[i] >= tl || d3; sx[i] = l[i] <= ts || u3;
  }
  return { le, se, lx, sx, sl_p, maxHold: holdBars(p.max_hold, ctx) };
}
const withLimit = (fn, base) => (b, p, ctx) => {
  const s = fn(b, p, ctx), n = b.c.length, a = atr(b, 14), lel = nanArr(n), sel = nanArr(n);
  for (let i = 0; i < n; i++) { const d = p.offset ? p.offset * a[i] : 0; if (s.le[i]) lel[i] = b.c[i] - d; if (s.se[i]) sel[i] = b.c[i] + d; }
  delete s.le; delete s.se; return { ...s, lel, sel, limitBars: p.limit_bars };
};

// ── Claude's strategy ───────────────────────────────────────────────────────────────────────
import { CLAUDE } from './claude.js?v=20261024a';

export const STRATEGIES = {
  claude: CLAUDE,
  impulse_follow: { title: 'Impulse follow — ride high-volume extreme moves', src: 'lab', tf: '1h', tfs: ['1h'],
    params: { look: 1, z_n: 72, z_th: 2.5, vol_mult: 1.5, atr_n: 14, sl_atr: 1.5, tp_atr: 0, offset: 0.3, limit_bars: 2, max_hold: 960 }, signals: impulseFollow },
  trend_pullback: { title: 'Trend pullback, ATR bracket, limit entry', src: 'lab', tf: '15m', tfs: ['5m', '15m', '1h'],
    params: { trend_n: 200, slope_n: 10, rsi_n: 14, rsi_lo: 35, atr_n: 14, tp_atr: 2, sl_atr: 2.5, min_tp_bp: 40, offset: 0.25, limit_bars: 2, max_hold: 720 }, signals: trendPullback },
  rsi_ema: { title: 'RSI dip with the EMA trend, fixed % bracket', src: 'lab', tf: '5m', tfs: ['5m', '15m'],
    params: { ema_n: 100, rsi_n: 14, rsi_lo: 40, tp: 0.01, sl: 0.015, max_hold: 0 }, signals: rsiEma },
  rsi_ema_maker: { title: 'RSI dip with the EMA trend — limit entry (maker)', src: 'lab', tf: '5m', tfs: ['5m', '15m'],
    params: { ema_n: 100, rsi_n: 14, rsi_lo: 40, tp: 0.01, sl: 0.015, max_hold: 0, offset: 0, limit_bars: 1 }, signals: withLimit(rsiEma) },
  vwap_bb_rsi: { title: 'VWAP trend + Bollinger/RSI dip, ATR bracket', src: 'lab', tf: '5m', tfs: ['5m', '15m'],
    params: { rsi_n: 16, bb_n: 14, bb_k: 2, atr_n: 7, atr_mult: 1.2, rr: 1.5, trend_n: 15, max_hold: 0 }, signals: vwapBbRsi },
  vwap_bb_rsi_maker: { title: 'VWAP trend + Bollinger/RSI dip — limit entry (maker)', src: 'lab', tf: '5m', tfs: ['5m', '15m'],
    params: { rsi_n: 16, bb_n: 14, bb_k: 2, atr_n: 7, atr_mult: 1.2, rr: 1.5, trend_n: 15, max_hold: 0, offset: 0, limit_bars: 1 }, signals: withLimit(vwapBbRsi) },
  ema_pullback: { title: 'Triple EMA pullback + fixed R:R', src: 'lab', tf: '5m', tfs: ['5m', '15m'],
    params: { fast: 25, mid: 100, slow: 200, min_gap: 0.001, rr: 2, max_hold: 0 }, signals: emaPullback },
  orb_ny: { title: 'New York open range breakout (1 trade/day)', src: 'lab', tf: '15m', tfs: ['5m', '15m'],
    params: { range_min: 30, tp_mult: 1.5, stop: 'mid', days: 'weekdays', max_hold: 0 }, signals: orbNy },
  session_breakout: { title: 'Session daily high/low breakout + Donchian trail', src: 'lab', tf: '15m', tfs: ['5m', '15m'],
    params: { fast_n: 13, atr_n: 52, thr: 1, sess_start: 10, sess_end: 15, max_hold: 0 }, signals: sessionBreakout },
  vwap_band_fade: { title: 'VWAP band fade + volatility filter', src: 'lab', tf: '5m', tfs: ['5m', '15m'],
    params: { sd_mult: 2, vol_mult: 3, strength: 0.7, stop_atr: 1, target: 'vwap', max_hold: 0 }, signals: vwapBandFade },
};

/** Backtest one strategy on bars. Returns {trades, orders, live, stats, sig}. */
export function backtest(id, bars, params = {}, ctx = {}, cost = {}) {
  const S = STRATEGIES[id];
  const c = { tfMin: 60, ...ctx };
  const tf = Object.keys(TF_MIN).find(k => TF_MIN[k] === c.tfMin);
  const p = { ...S.params, ...(S.byTf?.[tf] || {}), ...params };
  const sig = S.signals(bars, p, c);
  const res = run(bars, sig, cost);
  return { ...res, stats: stats(res.trades), sig, params: p };
}
