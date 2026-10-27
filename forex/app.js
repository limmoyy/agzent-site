// /forex app: passphrase gate (same as /scanner), the Claude FX desk for XAUUSD + NAS100, chart and backtest.
// Everything runs in the browser on Gate.io index candles; closed-market candles are dropped (see fx.js).
import { run, stats, REASON, TF_MIN } from '../scanner/lab/engine.js?v=20261027a';
import { candles, pool, TF_SEC } from '../scanner/lab/data.js?v=20261027a';
import { decryptSnap } from '../scanner/lab/gate.js?v=20261027a';
import { makeChart, makeLineChart, toChartTime } from '../scanner/lab/chart.js';
import { ema } from '../scanner/lab/ind.js';
import { INSTR, FX_STRATS, marketState, marketOnly, sessionLevels, trendState, brokerCost, atET, etClock, resample } from './fx.js?v=20261027c';
import { archiveBars } from './archive.js?v=20261027c';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtWib = (t, opt = {}) => t ? new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', weekday: opt.wd ? 'short' : undefined, day: opt.time ? undefined : 'numeric', month: opt.time ? undefined : 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const hhmm = (t, tz) => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const n2 = (v, d = 1) => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d);
const sgn = (v, d = 1) => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(d);
const pct = v => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';
const money = (v, d = 2) => (v == null || isNaN(v)) ? '—' : (v < 0 ? '−$' : '$') + Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const cls = v => v == null || isNaN(v) ? '' : (v >= 0 ? 'pos' : 'neg');
const px = (v, inst) => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: inst.digits, maximumFractionDigits: inst.digits });
const dist = (v, inst) => (v == null || isNaN(v)) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: inst.digits })} ${inst.unit}`;
const tfSec = tf => TF_SEC[tf] || 300;
const countdown = s => s <= 0 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3400); }
function progress(sel, done, total) { const p = $(sel); p.classList.toggle('on', done < total); p.firstElementChild.style.width = (total ? done / total * 100 : 0) + '%'; }

// per-viewer conveniences (remembered inputs, broker offsets); the page works without them
const PREF_KEY = 'agz_forex_prefs';
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (_) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { } };
function bindPref(sel, key, kind = 'value') {
  const el = $(sel); if (!el) return;
  if (prefs[key] != null) { if (kind === 'checked') el.checked = !!prefs[key]; else el.value = prefs[key]; }
  el.addEventListener('change', () => { prefs[key] = kind === 'checked' ? el.checked : el.value; savePrefs(); });
}
const offsetOf = inst => +((prefs.off || {})[inst.id] || 0); // your broker's price − index price
const adj = (v, inst) => v + offsetOf(inst);

// ── gate ─────────────────────────────────────────────────────────────────────────────────────
async function unlock(pw) {
  await decryptSnap(pw, '../scanner/');
  document.body.classList.add('on');
  routeFromHash(); scanDesk();
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault(); const pw = $('#pw').value, btn = $('#gateBtn'), err = $('#gerr');
  btn.disabled = true; btn.textContent = 'Checking…'; err.textContent = '';
  try { await unlock(pw); try { sessionStorage.setItem('agz_bb_pw', pw); } catch (_) { } }
  catch (_) { err.textContent = 'Wrong passphrase, or the check file could not be read.'; btn.disabled = false; btn.textContent = 'Unlock'; }
});
$('#lockBtn').addEventListener('click', () => { try { sessionStorage.removeItem('agz_bb_pw'); } catch (_) { } location.reload(); });

// ── tabs ─────────────────────────────────────────────────────────────────────────────────────
const TABS = ['desk', 'chart', 'backtest', 'check'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'desk';
  $$('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (name === 'chart' && (!CH.b || CH.dirty)) loadChart();
  if (name === 'check' && !CK.res && !CK.running && document.body.classList.contains('on')) runCheck();
}
$$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function routeFromHash() { showTab(location.hash.replace('#', '')); }
window.addEventListener('hashchange', routeFromHash);

// ── shared: costs, signals, trades ───────────────────────────────────────────────────────────
const BARS = { '1m': 2880, '5m': 9990, '15m': 3600, '1h': 6000 }; // Gate's index 15m history is short (≈ 40 days)
function costFor(inst, price) {
  const xau = inst.id === 'XAUUSD';
  return brokerCost(inst, price, +(xau ? $('#spX').value : $('#spN').value) || 0, xau ? +$('#cmX').value || 0 : 0, +$('#slip').value || 0);
}
/** Signals on a still-forming candle are not final until it closes. */
function maskForming(sig, b) {
  if (!b.forming) return sig;
  const k = b.t.length - 1;
  for (const key of ['lel', 'sel', 'les', 'ses']) if (sig[key]) sig[key][k] = NaN;
  for (const key of ['le', 'se']) if (sig[key]) sig[key][k] = 0;
  return sig;
}
function simulate(inst, b, id, tf, params = {}) {
  const S = FX_STRATS[id], p = { ...S.params, ...params };
  const sig = maskForming(S.signals(b, p, { tfMin: TF_MIN[tf] }), b);
  const res = run(b, sig, costFor(inst, b.c[b.c.length - 1]));
  const sec = tfSec(tf);
  const trades = res.trades.map(x => ({ inst: inst.id, tf, side: x.side, ep: x.ep, xp: x.xp, sl: x.sl, tp: x.tp, reason: x.reason, open: x.open,
    net: x.net, bp: x.net * 1e4, tIn: b.t[x.ei], tOut: b.t[x.xi] + sec, ei: x.ei, xi: x.xi }));
  return { trades, live: res.live, p, maxHold: sig.maxHold || 0 };
}
const closedOnly = list => list.filter(x => !x.open);
const nextClose = (sec, now = Date.now() / 1000) => (Math.floor(now / sec) + 1) * sec;
const reasonTxt = r => REASON[r] || r;
const held = s => s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;

// ── market clock ─────────────────────────────────────────────────────────────────────────────
function renderClock() {
  const now = Date.now() / 1000, ms = marketState(now);
  const label = { open: 'MARKET OPEN', break: 'DAILY BREAK', weekend: 'WEEKEND — CLOSED' }[ms.phase];
  $('#nowClock').textContent = `${hhmm(now, 'Asia/Jakarta')} WIB · ${hhmm(now, 'America/New_York')} New York`;
  $('#clockCard').innerHTML = `<div class="clock"><span class="phase ${ms.phase}">${label}</span>
    <div><div style="font-size:13px;color:var(--muted);margin-bottom:8px">${ms.session ? `Session now: <b style="color:var(--text)">${ms.session}</b>` : 'No session — gold and Nasdaq CFDs are closed. Index prices from Gate keep moving; the desk ignores them.'}</div>
    <div class="events">${ms.next.map(e => `<div class="ev"><b>${esc(e.name)}</b><span class="dim">${esc(fmtWib(e.t, { wd: true }))} WIB</span> · <span class="mono" data-until="${e.t}">${countdown(Math.round(e.t - now))}</span></div>`).join('')}</div></div></div>`;
}
function renderPlaybook() {
  const now = Date.now() / 1000, w = (h, m = 0) => hhmm(atET(now, h, m), 'Asia/Jakarta');
  const items = [
    ['Best hours', `London open ${w(3)} WIB and New York open ${w(9, 30)} WIB move the most. The Asian session (${w(18)}–${w(2)} WIB) is usually quiet: that is where the Asian range forms.`],
    ['Timeframe', '5m is what the rules were tested on. On 1m the intraday rule loses money; use 1m only to time an entry the 5m rule already gave. 15m was weaker.'],
    ['News', `US data comes at ${w(8, 30)} WIB (CPI, jobs) and Fed decisions at ${w(14)} WIB. Spreads widen and stops slip: skip entries 15 minutes either side. Check a calendar — this page cannot read one.`],
    ['Intraday vs swing', `Intraday (default) takes entries ${w(2)}–${w(13)} WIB, closes each trade within 2 hours and everything by ${w(16, 45)} WIB: no swap, no weekend risk. Swing holds up to 24 h (median 11–14 h), crosses the daily close at ${w(17)} WIB (swap) and does not close for the weekend.`],
    ['Size & spread', 'The intraday edge is small (≈ +3.6 bp a trade) and vanishes at 2–4× the spread: use a raw-spread account. A 0.6 % stop on gold is ~$24 per ounce; the lot box warns when even 0.01 lot is too much.'],
  ];
  $('#playbook').innerHTML = items.map(([k, v]) => `<div class="pb"><b>${esc(k)}</b>${esc(v)}</div>`).join('');
}

// ── Claude FX desk ───────────────────────────────────────────────────────────────────────────
const D = { res: null, running: false, nextAt: 0 };
const deskTf = () => ['1m', '5m', '15m'].includes(prefs.tf) ? prefs.tf : '5m';
const deskMode = () => prefs.mode === 'trend' ? 'trend' : 'intraday'; // intraday (default) or swing
const TF_NOTE = {
  intraday: {
    '1m': '<b>Intraday on 1m:</b> loses (−1.8 bp a trade, negative in all 6 test halves). Use 1m only to time an entry the 5m rule gave.',
    '5m': '<b>Intraday on 5m:</b> the researched setting — 459 trades, +3.6 bp a trade (t 2.0), longs and shorts both positive. Fragile: needs a low spread.',
    '15m': '<b>Intraday on 15m:</b> weak (+1.3 bp, 3 of 6 halves).',
  },
  trend: {
    '1m': '<b>Swing on 1m:</b> no edge after spread (≈ +1 bp).',
    '5m': '<b>Swing on 5m:</b> 747 trades, +8.4 bp, but only from trending markets; trades last 11–14 h and often cross the daily close (swap).',
    '15m': '<b>Swing on 15m:</b> weaker and mixed.',
  },
};
async function analyze(inst, tf, ttl) {
  const raw = await candles(inst.contract, tf, BARS[tf], ttl);
  const b = marketOnly(raw);
  if (b.t.length < 150) throw new Error(`only ${b.t.length} ${tf} candles`);
  const sim = simulate(inst, b, deskMode(), tf);
  const sdNow = etClock(b.t[b.t.length - 1]).sd;
  let prevClose = NaN; for (let i = b.t.length - 1; i >= 0; i--) if (etClock(b.t[i]).sd !== sdNow) { prevClose = b.c[i]; break; }
  return { inst, tf, mode: deskMode(), b, ...sim, st: stats(closedOnly(sim.trades)), trend: trendState(b, sim.p), lv: sessionLevels(b), price: raw.c[raw.c.length - 1], prevClose };
}
async function scanDesk({ auto = false } = {}) {
  if (D.running) { if (!auto) D.again = true; return; } // e.g. the timeframe changed mid-scan: run once more after
  D.running = true;
  const btn = $('#scanBtn'); btn.disabled = true; btn.textContent = auto ? 'Auto refresh…' : 'Loading…';
  const tf = deskTf();
  try {
    progress('#prog', 0, 2);
    const rows = await pool(Object.values(INSTR), 2, inst => analyze(inst, tf, auto ? 0 : 20e3), (d, t) => progress('#prog', d, t));
    D.res = { at: Date.now(), tf, mode: deskMode(), rows };
    D.nextAt = nextClose(tfSec(tf)) + 20;
    renderDesk();
  } catch (e) {
    D.nextAt = Date.now() / 1000 + 120;
    $('#instCards').innerHTML = `<div class="empty err">Could not load prices: ${esc(e.message || e)}. Gate.io (api.gateio.ws) must be reachable from this network.</div>`;
  } finally {
    D.running = false; btn.disabled = false; btn.textContent = '✦ Refresh desk'; progress('#prog', 1, 1);
    if (D.again) { D.again = false; scanDesk(); }
  }
}
$('#scanBtn').addEventListener('click', () => scanDesk());
$('#tfSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  prefs.tf = b.dataset.v; savePrefs(); syncTf(); scanDesk();
});
$('#modeSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  prefs.mode = b.dataset.v; savePrefs(); syncTf(); scanDesk();
});
function syncTf() {
  $$('#tfSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === deskTf())));
  $$('#modeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === deskMode())));
  $('#tfNote').innerHTML = TF_NOTE[deskMode()][deskTf()];
}

function lotBox(inst, entry, sl) {
  const cap = +$('#cap').value || 1000, riskPct = +$('#risk').value || 1, riskUsd = cap * riskPct / 100;
  const stop = Math.abs(entry - sl), perLot = stop * inst.lot; if (!(perLot > 0)) return '';
  const lots = Math.floor(riskUsd / perLot * 100) / 100, minRisk = perLot * 0.01;
  return `<div class="calc"><span>Lot size (${money(riskUsd, 0)} risk)</span><span>${lots >= 0.01 ? lots.toFixed(2) + ' lot' : '< 0.01 lot'}</span>
    <span>Loss at stop per 0.01 lot</span><span class="neg">${money(-minRisk)}</span></div>
    ${lots < 0.01 ? `<p class="note" style="color:var(--warn)">The smallest lot (0.01) already risks ${money(minRisk)} = ${n2(minRisk / cap * 100, 1)} % of ${money(cap, 0)}. Skip it or accept more risk knowingly.</p>` : ''}
    <p class="note" style="margin-top:4px">${esc(inst.lotNote)}.</p>`;
}
function levelsTable(r) {
  const { inst, lv, price } = r, rows = [];
  const add = (name, x, note) => { if (x && x.hi > -Infinity) rows.push(`<span>${esc(name)}${note ? ` <span class="dim">${esc(note)}</span>` : ''}</span><span class="r">${px(adj(x.hi, inst), inst)}</span><span class="r">${px(adj(x.lo, inst), inst)}</span><span class="r dim">${dist(price - x.hi, inst)} / ${dist(price - x.lo, inst)}</span>`); };
  add('Asian range', lv?.asia, lv?.asia && !lv.asia.done ? 'forming' : '');
  add('Previous day', lv?.prev);
  add('NY opening range', lv?.or, lv?.or && !lv.or.done ? 'forming' : '');
  add('Today', lv?.today);
  return rows.length ? `<div class="lvls"><span class="h">Level</span><span class="h r">High</span><span class="h r">Low</span><span class="h r">Price vs H / L</span>${rows.join('')}</div>` : '';
}
/** Intraday mode: when a trade entered at t must be closed (hold limit or 16:45 ET, whichever first). */
function closeBy(t, p) { const flat = atET(t, Math.floor(p.flat_m / 60), p.flat_m % 60); return Math.min(t + p.hold_min * 60, flat > t ? flat : Infinity); }
/** Intraday mode: entries only inside the window; when is the next one? */
function windowState(p, now = Date.now() / 1000) {
  const k = etClock(now), inWin = k.open && k.m >= p.win0 && k.m < p.win1;
  let next = null;
  for (let d = 0; d < 8 && !inWin && !next; d++) { const t = atET(now + d * 86400, Math.floor(p.win0 / 60), p.win0 % 60); if (t > now && etClock(t + 60).open) next = t; }
  return { inWin, next, end: atET(now, Math.floor(p.win1 / 60), p.win1 % 60) };
}
function stateBox(r) {
  const { inst, live, trend, b, tf, maxHold, price, p } = r, pos = live.position, pend = live.pending, intra = r.mode === 'intraday';
  if (pos) {
    const pnl = (price / pos.ep - 1) * 100 * pos.side, left = Math.max(0, maxHold - (b.t.length - 1 - pos.ei)), by = intra ? closeBy(b.t[pos.ei], p) : 0;
    return `<div class="state pos"><div class="sh"><b>${pos.side === 1 ? 'LONG' : 'SHORT'} · already in a trade</b><span class="pill ${cls(pnl)}">${pct(pnl)}</span></div>
      ${lvRows(inst, pos.ep, pos.sl, pos.tp, 'Entry (filled)', by)}
      <p class="say">The rule went ${pos.side === 1 ? 'long' : 'short'} at ${esc(fmtWib(b.t[pos.ei]))} WIB. If you are not in it, don't chase — wait for the next signal. ${intra ? `It closes at ${esc(fmtWib(by, { time: true }))} WIB.` : `Time stop in ~${countdown(left * tfSec(tf))} of market time.`}</p>
      ${lotBox(inst, pos.ep, pos.sl)}</div>`;
  }
  if (pend) {
    const by = intra ? closeBy(Date.now() / 1000, p) : 0;
    return `<div class="state sig"><div class="sh"><b>${pend.side === 1 ? 'BUY' : 'SELL'} at the next ${esc(tf)} open</b><span class="pill st-signal">SIGNAL</span></div>
      ${lvRows(inst, pend.price, pend.sl, pend.tp, 'Entry ≈', by)}
      <p class="say">${pend.side === 1 ? `Price is above EMA 100 and RSI dipped to ${n2(trend?.rsi, 0)}: buy the dip in the uptrend.` : `Price is below EMA 100 and RSI rose to ${n2(trend?.rsi, 0)}: sell the bounce in the downtrend.`} ${intra ? `No fixed target: close at ${esc(fmtWib(by, { time: true }))} WIB (2 h, or 16:45 New York if sooner); stop ${n2(p.stop_pct * 100, 1)} %.` : `Levels move with your actual fill: stop ${n2(p.sl * 100, 1)} %, target ${n2(p.tp * 100, 1)} %.`}</p>
      ${lotBox(inst, pend.price, pend.sl)}</div>`;
  }
  if (!trend) return '<div class="state">Not enough candles yet.</div>';
  const close = Math.abs(trend.rsi - trend.rsiNeed), w = intra ? windowState(p) : null;
  if (w && !w.inWin) return `<div class="state"><div class="sh"><b>Entry window closed</b><span class="pill">WAIT</span></div>
    <p class="say">Intraday entries only from 02:00 to 13:00 New York (London + New York morning). Next window opens ${esc(fmtWib(w.next, { wd: true }))} WIB${w.next ? ` · in <b data-until="${w.next}">${countdown(Math.round(w.next - Date.now() / 1000))}</b>` : ''}. Trend now: ${trend.up ? 'up' : 'down'}, RSI ${n2(trend.rsi, 0)}.</p></div>`;
  return `<div class="state"><div class="sh"><b>Waiting · trend ${trend.up ? 'up' : 'down'}</b><span class="pill">${close < 5 ? 'CLOSE' : 'NO SIGNAL'}</span></div>
    <div class="calc"><span>Price vs EMA 100</span><span class="${trend.up ? 'pos' : 'neg'}">${pct(trend.gapPct)} (${px(adj(trend.ema, inst), inst)})</span>
    <span>RSI 14 now</span><span>${n2(trend.rsi, 1)} — needs ${trend.up ? '<' : '>'} ${trend.rsiNeed}</span></div>
    <p class="say">Next ${trend.up ? 'buy' : 'sell'} comes when ${esc(trend.want)} while price stays ${trend.up ? 'above' : 'below'} EMA 100. Checked again at every ${esc(tf)} close.</p></div>`;
}
function lvRows(inst, entry, sl, tp, entryLabel, closeAt) {
  const R = Math.abs(entry - sl);
  const top = tp === tp && tp != null ? `<span class="k">Target</span><span class="p tp">${px(adj(tp, inst), inst)}</span><span class="d">${dist(tp - entry, inst)} · ${n2(Math.abs(tp - entry) / R, 2)}R</span>`
    : closeAt ? `<span class="k">Close by</span><span class="p tp">${esc(fmtWib(closeAt, { time: true }))} WIB</span><span class="d">time exit</span>` : '';
  return `<div class="lv">${top}
    <span class="k">${esc(entryLabel)}</span><span class="p en">${px(adj(entry, inst), inst)}</span><span class="d"></span>
    <span class="k">Stop</span><span class="p slc">${px(adj(sl, inst), inst)}</span><span class="d">${dist(sl - entry, inst)} · −1R</span></div>`;
}
function renderDesk() {
  const r = D.res; if (!r) return;
  $('#instCards').innerHTML = r.rows.map(x => {
    if (!x || x.error) return `<div class="card"><div class="err">${esc(x?.error || 'failed')}</div></div>`;
    const { inst, st, price, prevClose } = x, off = offsetOf(inst), chg = (price / prevClose - 1) * 100;
    const last = [...closedOnly(x.trades)].sort((a, b) => b.tIn - a.tIn).slice(0, 5);
    return `<div class="card inst" data-inst="${inst.id}">
      <div class="ihd"><div><h3>${esc(inst.id)} <span class="pill tfp">${esc(x.tf)}</span></h3><small>${esc(inst.label)} · index price${off ? `, levels shifted ${off >= 0 ? '+' : ''}${n2(off, inst.digits)} to your broker` : ''}</small></div>
        <div style="text-align:right"><div class="big">${px(adj(price, inst), inst)}</div><span class="${cls(chg)}" style="font-size:12.5px">${pct(chg)} today</span></div></div>
      ${stateBox(x)}
      ${levelsTable(x)}
      <div class="offset"><label class="fld sm"><span>Your broker's ${esc(inst.id)} price now</span><input type="number" step="any" data-off="${inst.id}" placeholder="${n2(price + off, inst.digits)}"></label>
        <button class="btn sm" data-offset="${inst.id}" type="button">Match levels</button>${off ? `<button class="btn sm" data-reset="${inst.id}" type="button">Reset (${n2(off, inst.digits)})</button>` : ''}</div>
      <div class="tags"><span class="tag">${esc(x.tf)} record here: ${st.n ? `${st.n} trades · ${sgn(st.avg, 1)} bp · win ${Math.round(st.win * 100)}%` : 'no closed trades'}</span><span class="tag">${x.b.t.length} candles since ${esc(fmtWib(x.b.t[0]))}</span></div>
      ${last.length ? `<div class="tblwrap"><table class="tk sm" style="min-width:0"><thead><tr><th class="l">Entry (WIB)</th><th class="l">Side</th><th>Entry</th><th>Exit</th><th class="l">Exit</th><th>bp</th><th>Held</th></tr></thead><tbody>
        ${last.map(t => `<tr data-chart="${inst.id}" data-t="${t.tIn}"><td class="l">${fmtWib(t.tIn)}</td><td class="l side-${t.side}">${t.side === 1 ? 'long' : 'short'}</td><td>${px(t.ep, inst)}</td><td>${px(t.xp, inst)}</td><td class="l">${esc(reasonTxt(t.reason))}</td><td class="${cls(t.bp)}">${sgn(t.bp, 0)}</td><td class="dim">${held(t.tOut - t.tIn)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="ctrls" style="margin:0"><button class="btn sm pri" data-chart="${inst.id}" type="button">Chart ${esc(x.tf)}</button><button class="btn sm" data-bt="${inst.id}" type="button">Backtest</button>${askBtn(x)}
        <span class="tag cdwrap">next ${esc(x.tf)} close in <b data-until="${nextClose(tfSec(x.tf))}">${countdown(Math.round(nextClose(tfSec(x.tf)) - Date.now() / 1000))}</b></span></div>
    </div>`;
  }).join('');
}
$('#instCards').addEventListener('click', e => {
  const o = e.target.closest('[data-offset]');
  if (o) {
    const inst = INSTR[o.dataset.offset], v = +$(`[data-off="${inst.id}"]`).value, row = D.res?.rows.find(x => x.inst === inst);
    if (!(v > 0) || !row) { toast(`Type your broker's ${inst.id} price first`); return; }
    prefs.off = { ...(prefs.off || {}), [inst.id]: +(v - row.price).toFixed(inst.digits) }; savePrefs(); renderDesk();
    toast(`${inst.id} levels shifted ${sgn(prefs.off[inst.id], inst.digits)} to match your broker`); return;
  }
  const z = e.target.closest('[data-reset]'); if (z) { if (prefs.off) delete prefs.off[z.dataset.reset]; savePrefs(); renderDesk(); return; }
  const c = e.target.closest('[data-chart]'); if (c) { openChart(c.dataset.chart, deskTf(), c.dataset.t ? +c.dataset.t : null); return; }
  const b = e.target.closest('[data-bt]'); if (b) { $('#btInst').value = b.dataset.bt; $('#btTf').value = deskTf(); $('#btStrat').value = deskMode(); renderParams(); showTab('backtest'); runBacktest(); }
});
['#cap', '#risk'].forEach(s => $(s).addEventListener('change', () => { renderDesk(); if (CH.b) renderChartSide(); }));

// "Analisa di Claude": a new claude.ai chat pre-filled with this desk (the viewer's own Claude account)
function fxPrompt(x) {
  const { inst, tf, b, live, trend, lv, st, p, price } = x, P = v => px(adj(v, inst), inst), ms = marketState();
  const L = [`Kamu analis trading forex. Review kondisi ${inst.id} dari "Forex Desk" gw. Jawab bahasa Indonesia santai, singkat, poin-poin.`];
  const rule = x.mode === 'intraday'
    ? `entry cuma jam 02:00–13:00 New York, tanpa target; keluar setelah ${p.hold_min} menit atau jam 16:45 New York, stop ${p.stop_pct * 100}%. Riset 5m: +3,6 bp/trade (t 2,0), rapuh: butuh spread rendah.`
    : `TP ${p.tp * 100}%, SL ${p.sl * 100}%, time stop 24 jam pasar. Riset: untungnya cuma dari pasar yang trending, median trade 11–14 jam.`;
  L.push(`\nATURAN (${FX_STRATS[x.mode].title}, ${tf}): long kalau harga di atas EMA ${p.ema_n} dan RSI ${p.rsi_n} < ${p.rsi_lo}; short kalau di bawah EMA ${p.ema_n} dan RSI > ${100 - p.rsi_lo}; ${rule}`);
  L.push(`\nSEKARANG: ${fmtWib(Date.now() / 1000)} WIB, pasar ${ms.phase}, sesi ${ms.session || '-'}. Harga ${P(price)} (sudah disesuaikan ke harga broker gw).`);
  if (live.position) L.push(`Status: rule sedang ${live.position.side === 1 ? 'LONG' : 'SHORT'} dari ${P(live.position.ep)}, stop ${P(live.position.sl)}${live.position.tp === live.position.tp ? `, target ${P(live.position.tp)}` : ''}.`);
  else if (live.pending) L.push(`Status: SINYAL ${live.pending.side === 1 ? 'BUY' : 'SELL'} di open candle berikutnya ≈ ${P(live.pending.price)}, stop ${P(live.pending.sl)}${live.pending.tp === live.pending.tp ? `, target ${P(live.pending.tp)}` : `, tutup jam ${fmtWib(closeBy(Date.now() / 1000, p), { time: true })} WIB`}.`);
  else if (trend) L.push(`Status: nunggu. Trend ${trend.up ? 'naik' : 'turun'} (harga ${pct(trend.gapPct)} dari EMA ${P(trend.ema)}), RSI ${n2(trend.rsi, 1)}, butuh ${trend.want}.`);
  const lvl = (n, z) => z && z.hi > -Infinity ? `${n} H ${P(z.hi)} / L ${P(z.lo)}` : null;
  L.push(`Level sesi: ${[lvl('Asia', lv?.asia), lvl('kemarin', lv?.prev), lvl('NY opening range', lv?.or), lvl('hari ini', lv?.today)].filter(Boolean).join('; ')}.`);
  L.push(`Track record rule ini di data yang ke-load (${tf}): ${st.n ? `${st.n} trade, ${sgn(st.avg, 1)} bp, win ${Math.round(st.win * 100)}%` : 'belum ada'}.`);
  const rows = []; for (let i = Math.max(0, b.t.length - 24); i < b.t.length; i++) rows.push(`${hhmm(b.t[i], 'Asia/Jakarta')} ${P(b.o[i])} ${P(b.h[i])} ${P(b.l[i])} ${P(b.c[i])}`);
  L.push(`\n${rows.length} candle ${tf} terakhir (jam WIB, O H L C):\n${rows.join('\n')}`);
  L.push(`\nYANG GW MAU:\n1. Verdict: AMBIL / TUNGGU / SKIP, plus alasan utama.\n2. Ada news besar hari ini (CPI, NFP, FOMC, data US lain) atau event yang bikin gw harus nunggu? Search web kalau bisa.\n3. Level mana yang paling penting buat entry/stop/target, pakai level sesi di atas.\n4. Apa yang bikin rencana ini batal?\nJangan ngarang angka, pakai data di atas.`);
  return L.join('\n');
}
const askBtn = x => `<a class="btn sm ask" href="${esc('https://claude.ai/new?q=' + encodeURIComponent(fxPrompt(x)))}" target="_blank" rel="noopener" title="Opens a new chat on claude.ai with this desk filled in — uses your own Claude account">✦ Analisa di Claude</a>`;

// clock + countdowns + auto refresh
function tick() {
  const now = Date.now() / 1000;
  if (document.body.classList.contains('on')) renderClock();
  for (const el of document.querySelectorAll('[data-until]')) {
    const left = Math.round(+el.dataset.until - now);
    el.textContent = countdown(left);
    el.closest('.cdwrap')?.classList.toggle('due', left <= 0);
  }
  if (D.res && $('#auto').checked && !D.running && D.nextAt && now >= D.nextAt) {
    if (marketState(now).phase === 'open') scanDesk({ auto: true }); else D.nextAt = nextClose(900) + 20; // closed: look again every 15 min
  }
}
setInterval(tick, 1000);

// ── chart ────────────────────────────────────────────────────────────────────────────────────
const CH = { chart: null, b: null, inst: null, tf: '5m', trades: [], live: null, sel: null, dirty: false, focusAt: null };
$('#chOv').innerHTML = Object.entries(FX_STRATS).map(([k, s]) => `<option value="${k}">${esc(s.title)}</option>`).join('') + '<option value="none">No strategy</option>';
function openChart(id, tf, at) {
  $('#chInst').value = id; if (tf) $('#chTf').value = tf; $('#chOv').value = deskMode();
  CH.focusAt = at || null; CH.dirty = true; showTab('chart');
}
let chartSeq = 0;
async function loadChart() {
  if (!CH.chart) CH.chart = makeChart($('#chBox'), { height: Math.max(380, Math.min(560, window.innerHeight - 260)) });
  CH.dirty = false;
  const seq = ++chartSeq, inst = INSTR[$('#chInst').value], tf = $('#chTf').value, ov = $('#chOv').value;
  $('#chTv').href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(inst.tv)}&interval=${({ '1m': 1, '5m': 5, '15m': 15, '1h': 60 })[tf]}`;
  $('#chSide').innerHTML = '<div class="muted">Loading candles…</div>';
  try {
    const b = marketOnly(await candles(inst.contract, tf, BARS[tf], 20e3));
    if (seq !== chartSeq) return;
    CH.b = b; CH.inst = inst; CH.tf = tf; CH.sel = null; CH.ov = ov;
    CH.chart.setBars(b, inst.digits, `<b>${esc(inst.id)}</b> · ${esc(tf)} · ${esc(ov === 'none' ? 'no strategy' : FX_STRATS[ov].title)}`);
    CH.chart.setEmas(b, [ema(b.c, 20), ema(b.c, 50), ema(b.c, 100)]);
    if (ov !== 'none' && FX_STRATS[ov]) { const s = simulate(inst, b, ov, tf, ov === $('#btStrat').value ? readParams() : {}); CH.trades = s.trades; CH.live = s.live; CH.p = s.p; }
    else { CH.trades = []; CH.live = null; }
    CH.lv = sessionLevels(b);
    drawChart();
    if (CH.focusAt) { const t = CH.trades.find(x => Math.abs(x.tIn - CH.focusAt) < tfSec(tf)); if (t) selectTrade(t); else CH.chart.focus(CH.focusAt, null, 60); CH.focusAt = null; }
    else CH.chart.showRecent(tf === '1m' ? 240 : 180);
  } catch (e) { $('#chSide').innerHTML = `<div class="err">Could not load ${esc(inst.id)} ${esc(tf)}: ${esc(e.message || e)}</div>`; }
}
function drawChart() {
  const b = CH.b, inst = CH.inst, sec = tfSec(CH.tf), C = { up: '#7EE08A', down: '#FF7A6B', lime: '#D9FF57', warn: '#FFC857' };
  const bar = t => Math.floor(t / sec) * sec, first = b.t[0], lastT = b.t[b.t.length - 1], mk = [];
  for (const x of CH.trades) {
    if (x.tIn < first || x.tIn > lastT + sec) continue;
    mk.push({ time: toChartTime(bar(x.tIn)), position: x.side === 1 ? 'belowBar' : 'aboveBar', color: x.side === 1 ? C.lime : C.warn, shape: x.side === 1 ? 'arrowUp' : 'arrowDown', text: x.side === 1 ? 'L' : 'S' });
    if (!x.open) mk.push({ time: toChartTime(bar(Math.min(x.tOut - sec, lastT))), position: x.side === 1 ? 'aboveBar' : 'belowBar', color: x.bp >= 0 ? C.up : C.down, shape: 'circle', text: sgn(x.bp, 0) });
  }
  CH.chart.setMarkers(mk);
  const lines = [], boxes = [];
  if ($('#chLv').checked && CH.lv) {
    const L = CH.lv, add = (z, color, name) => { if (z && z.hi > -Infinity) lines.push({ price: z.hi, color, title: name + ' H', style: 2 }, { price: z.lo, color, title: name + ' L', style: 2 }); };
    add(L.asia, '#B98CFF', 'Asia'); add(L.prev, '#FF9F5A', 'Prev day'); add(L.or, '#7FD7E8', 'NY OR');
  }
  const lv = CH.live?.position || CH.live?.pending;
  if (lv) {
    const en = lv.ep ?? lv.price;
    lines.push({ price: en, color: C.lime, title: CH.live.position ? 'Entry (filled)' : 'Entry ≈ next open', width: 2, style: 0 }, { price: lv.sl, color: C.down, title: 'Stop', width: 2, style: 0 }, { price: lv.tp, color: C.up, title: 'Target', width: 2, style: 0 });
    boxes.push({ t0: CH.live.position ? b.t[lv.ei] : lastT, entry: en, sl: lv.sl, tp: lv.tp, label: `${lv.side === 1 ? 'LONG' : 'SHORT'} · ${n2(Math.abs(lv.tp - en) / Math.abs(en - lv.sl), 2)}R` });
  }
  // intraday trades have no target: shade entry → exit when it won
  if (CH.sel && CH.sel.sl === CH.sel.sl) boxes.push({ t0: bar(CH.sel.tIn), t1: bar(CH.sel.tOut - sec) + sec, entry: CH.sel.ep, sl: CH.sel.sl, tp: CH.sel.tp === CH.sel.tp ? CH.sel.tp : (CH.sel.bp > 0 ? CH.sel.xp : CH.sel.ep), label: `${CH.sel.side === 1 ? 'LONG' : 'SHORT'} ${sgn(CH.sel.bp, 0)} bp · ${reasonTxt(CH.sel.reason)}` });
  CH.chart.setLines(lines); CH.chart.setBoxes(boxes);
  renderChartSide();
}
function renderChartSide() {
  const inst = CH.inst, b = CH.b, last = b.c[b.c.length - 1], lv = CH.live?.position || CH.live?.pending;
  let html = `<h2 class="sec">${esc(inst.id)} · ${esc(CH.tf)}</h2>`;
  if (lv) html += `<div class="state ${CH.live.position ? 'pos' : 'sig'}"><b>${CH.live.position ? (lv.side === 1 ? 'In a long' : 'In a short') : (lv.side === 1 ? 'BUY at next open' : 'SELL at next open')}</b>${lvRows(inst, lv.ep ?? lv.price, lv.sl, lv.tp, CH.live.position ? 'Entry (filled)' : 'Entry ≈')}${lotBox(inst, lv.ep ?? lv.price, lv.sl)}</div>`;
  else if (CH.ov === 'trend' || CH.ov === 'intraday') { const t = trendState(b, CH.p); html += t ? `<div class="calc"><span>Trend</span><span class="${t.up ? 'pos' : 'neg'}">${t.up ? 'up' : 'down'} (${pct(t.gapPct)} vs EMA 100)</span><span>RSI 14</span><span>${n2(t.rsi, 1)} — needs ${t.up ? '<' : '>'} ${t.rsiNeed}</span></div>` : ''; }
  else html += '<div class="muted">No open trade or signal on the latest candle.</div>';
  html += `<p class="note">Price now ${px(last, inst)} (index)${offsetOf(inst) ? ` · ${px(adj(last, inst), inst)} at your broker` : ''}. Levels on the chart are index prices.</p>`;
  $('#chSide').innerHTML = html;
  const st = stats(closedOnly(CH.trades));
  $('#chTrades').innerHTML = CH.trades.length ? `<h2 class="sec">Trades on this chart</h2><div class="calc" style="margin-bottom:8px"><span>Closed trades</span><span>${st.n || 0}</span><span>Avg / trade</span><span class="${cls(st.avg)}">${st.n ? sgn(st.avg, 1) + ' bp' : '—'}</span><span>Win rate</span><span>${st.n ? Math.round(st.win * 100) + '%' : '—'}</span></div>
    <div class="tblwrap" style="max-height:360px;overflow:auto"><table class="tk sm" style="min-width:0"><thead><tr><th class="l">Entry (WIB)</th><th class="l">Side</th><th>Entry</th><th>Exit</th><th>bp</th></tr></thead><tbody>
    ${[...CH.trades].sort((a, c) => c.tIn - a.tIn).map(x => `<tr data-t="${x.tIn}"><td class="l">${fmtWib(x.tIn)}</td><td class="l side-${x.side}">${x.side === 1 ? 'L' : 'S'}</td><td>${px(x.ep, inst)}</td><td>${x.open ? 'open' : px(x.xp, inst)}</td><td class="${cls(x.bp)}">${sgn(x.bp, 0)}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="muted">${CH.ov === 'none' ? 'Pick a strategy to see its trades.' : 'No trades in these candles.'}</div>`;
}
function selectTrade(x) { CH.sel = x; drawChart(); CH.chart.focus(Math.floor(x.tIn / tfSec(CH.tf)) * tfSec(CH.tf), Math.floor(x.tOut / tfSec(CH.tf)) * tfSec(CH.tf), 50); }
$('#chTrades').addEventListener('click', e => { const tr = e.target.closest('tr[data-t]'); if (!tr) return; const x = CH.trades.find(t => t.tIn === +tr.dataset.t); if (x) selectTrade(x); });
['#chInst', '#chTf', '#chOv'].forEach(s => $(s).addEventListener('change', loadChart));
$('#chLv').addEventListener('change', () => CH.b && drawChart());
$('#chLoad').addEventListener('click', loadChart);

// ── backtest ─────────────────────────────────────────────────────────────────────────────────
const BT = { last: null, eq: null };
$('#btStrat').innerHTML = Object.entries(FX_STRATS).map(([k, s]) => `<option value="${k}">${esc(s.title)}</option>`).join('');
function renderParams() {
  const id = $('#btStrat').value, S = FX_STRATS[id], saved = (prefs.params || {})[id] || {};
  $('#btNote').textContent = id === 'intraday' ? 'Claude FX default: in and out the same day. Researched on 5m; see the notes on the Claude FX tab.' : id === 'trend' ? 'Claude FX swing mode: holds up to 24 h. Researched on 5m.' : id === 'sweep' || id === 'orb' ? 'Claude tried this and it failed out-of-sample; here so you can check.' : 'Lab strategy built for crypto, shown for comparison.';
  $('#btParams').innerHTML = Object.entries(S.params).filter(([, v]) => typeof v === 'number').map(([k, v]) => `<label class="fld sm" title="${esc(S.help?.[k] || '')}"><span>${esc(k)}</span><input type="number" data-p="${esc(k)}" value="${esc(saved[k] ?? v)}" step="any"></label>`).join('');
}
function readParams() { const p = {}; $$('#btParams [data-p]').forEach(el => { p[el.dataset.p] = +el.value; }); return p; }
$('#btStrat').addEventListener('change', renderParams);
$('#btParams').addEventListener('change', () => { prefs.params = { ...(prefs.params || {}), [$('#btStrat').value]: readParams() }; savePrefs(); });
const btInsts = () => $('#btInst').value === 'both' ? Object.values(INSTR) : [INSTR[$('#btInst').value]];
async function btOne(inst, id, tf, params) {
  const b = marketOnly(await candles(inst.contract, tf, BARS[tf], 120e3));
  return { inst, b, ...simulate(inst, b, id, tf, params) };
}
async function runBacktest() {
  const id = $('#btStrat').value, tf = $('#btTf').value, params = readParams(), insts = btInsts(), btn = $('#btRun');
  btn.disabled = true; btn.textContent = 'Running…';
  try {
    progress('#btProg', 0, insts.length);
    const out = await pool(insts, 2, inst => btOne(inst, id, tf, params), (d, t) => progress('#btProg', d, t));
    const ok = out.filter(x => x && !x.error), all = closedOnly(ok.flatMap(x => x.trades));
    const span = ok.length ? [Math.min(...ok.map(x => x.b.t[0])), Math.max(...ok.map(x => x.b.t[x.b.t.length - 1]))] : [0, 0];
    BT.last = { id, tf, ok, all, span };
    renderBacktest();
  } catch (e) { $('#btOut').innerHTML = `<div class="empty err">Backtest failed: ${esc(e.message || e)}</div>`; }
  finally { btn.disabled = false; btn.textContent = 'Run backtest'; progress('#btProg', 1, 1); }
}
function tiles(st, extra = []) {
  if (!st || !st.n) return '<div class="stats"><div class="stat"><b>0</b><span>closed trades</span></div></div>';
  const t = [['Trades', st.n, ''], ['Win rate', Math.round(st.win * 100) + '%', ''], ['Avg / trade', sgn(st.avg, 1) + ' bp', st.avg >= 0 ? 'good' : 'badv'],
    ['Total', sgn(st.sum, 0) + ' bp', st.sum >= 0 ? 'good' : 'badv'], ['t-stat', n2(st.t, 2), Math.abs(st.t) >= 2 ? (st.t > 0 ? 'good' : 'badv') : ''],
    ['Profit factor', isFinite(st.pf) ? n2(st.pf, 2) : '∞', ''], ['Max DD', sgn(st.maxdd, 0) + ' bp', 'badv'], ...extra];
  return '<div class="stats">' + t.map(([k, v, c]) => `<div class="stat ${c}"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('') + '</div>';
}
function renderBacktest() {
  const r = BT.last, st = stats(r.all), days = (r.span[1] - r.span[0]) / 86400, mid = (r.span[0] + r.span[1]) / 2;
  const h1 = stats(r.all.filter(x => x.tIn < mid)), h2 = stats(r.all.filter(x => x.tIn >= mid));
  const L = stats(r.all.filter(x => x.side === 1)), S = stats(r.all.filter(x => x.side === -1));
  const instOf = id => INSTR[id];
  $('#btOut').innerHTML = `<div class="card"><h2 class="sec">${esc(FX_STRATS[r.id].title)} · ${esc(r.tf)} · ${esc(r.ok.map(x => x.inst.id).join(' + '))} <span class="dim" style="font:13px var(--body)">· ${n2(days, 0)} days</span></h2>
      ${tiles(st, [['1st half', h1.n ? sgn(h1.avg, 1) + ' bp' : '—', h1.avg >= 0 ? 'good' : 'badv'], ['2nd half', h2.n ? sgn(h2.avg, 1) + ' bp' : '—', h2.avg >= 0 ? 'good' : 'badv'], ['Longs', L.n ? `${sgn(L.avg, 1)} × ${L.n}` : '—', L.avg >= 0 ? 'good' : 'badv'], ['Shorts', S.n ? `${sgn(S.avg, 1)} × ${S.n}` : '—', S.avg >= 0 ? 'good' : 'badv']])}
      <div class="chartbox" id="btEq"></div>
      <p class="note">Net of your spread, commission and slippage. Only market hours (weekends and the 17:00 ET break removed). Short history — Gate keeps 10 000 candles — so treat any number here as a sanity check, not proof.</p></div>
    <div class="card"><h2 class="sec">Trades <span class="dim" style="font:13px var(--body)">(latest 200; click for the chart)</span></h2><div class="tblwrap"><table class="tk sm"><thead><tr><th class="l">Entry (WIB)</th><th class="l">Instrument</th><th class="l">Side</th><th>Entry</th><th>Exit</th><th class="l">Exit reason</th><th>Net bp</th><th>Held</th></tr></thead><tbody>
    ${[...r.all].sort((a, b) => b.tIn - a.tIn).slice(0, 200).map(x => `<tr data-chart="${x.inst}" data-t="${x.tIn}"><td class="l">${fmtWib(x.tIn)}</td><td class="l"><span class="sym">${esc(x.inst)}</span></td><td class="l side-${x.side}">${x.side === 1 ? 'long' : 'short'}</td><td>${px(x.ep, instOf(x.inst))}</td><td>${px(x.xp, instOf(x.inst))}</td><td class="l">${esc(reasonTxt(x.reason))}</td><td class="${cls(x.bp)}">${sgn(x.bp, 0)}</td><td class="dim">${held(x.tOut - x.tIn)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  BT.eq?.destroy(); BT.eq = makeLineChart($('#btEq'), { height: 240 });
  let cum = 0; BT.eq.set([...r.all].sort((a, b) => a.tOut - b.tOut).map(x => ({ t: x.tOut, v: cum += x.bp })));
}
$('#btOut').addEventListener('click', e => {
  const u = e.target.closest('[data-use]'); if (u) { $('#btStrat').value = u.dataset.use; renderParams(); runBacktest(); return; }
  const tr = e.target.closest('tr[data-chart]'); if (tr && BT.last) { $('#chOv').value = BT.last.id; $('#chInst').value = tr.dataset.chart; $('#chTf').value = BT.last.tf; CH.focusAt = +tr.dataset.t; CH.dirty = true; showTab('chart'); }
});
$('#btRun').addEventListener('click', runBacktest);
$('#btCompare').addEventListener('click', async () => {
  const tf = $('#btTf').value, insts = btInsts(), ids = Object.keys(FX_STRATS), btn = $('#btCompare');
  btn.disabled = true; btn.textContent = 'Comparing…';
  try {
    const jobs = ids.flatMap(id => insts.map(inst => ({ id, inst })));
    progress('#btProg', 0, jobs.length);
    const out = await pool(jobs, 2, j => btOne(j.inst, j.id, tf, {}).then(r => ({ ...j, trades: r.trades })), (d, t) => progress('#btProg', d, t));
    const rows = ids.map(id => { const tr = closedOnly(out.filter(x => x && !x.error && x.id === id).flatMap(x => x.trades)); return { id, st: stats(tr), L: stats(tr.filter(x => x.side === 1)), S: stats(tr.filter(x => x.side === -1)) }; })
      .sort((a, b) => (b.st.n ? b.st.avg : -1e9) - (a.st.n ? a.st.avg : -1e9));
    $('#btOut').innerHTML = `<div class="card"><h2 class="sec">All strategies · ${esc(tf)} · ${esc(insts.map(i => i.id).join(' + '))} <span class="dim" style="font:13px var(--body)">· default parameters · net of costs</span></h2>
      <div class="tblwrap"><table class="tk sm"><thead><tr><th class="l">Strategy</th><th>Trades</th><th>Win</th><th>Avg bp</th><th>t</th><th>Longs</th><th>Shorts</th><th>Max DD</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="l">${r.id === 'trend' || r.id === 'intraday' ? '✦ <b>' + esc(FX_STRATS[r.id].title) + '</b>' : esc(FX_STRATS[r.id].title)}</td><td>${r.st.n || 0}</td><td>${r.st.n ? Math.round(r.st.win * 100) + '%' : '—'}</td><td class="${cls(r.st.avg)}">${r.st.n ? sgn(r.st.avg, 1) : '—'}</td><td>${r.st.n ? n2(r.st.t, 2) : '—'}</td>
        <td class="${cls(r.L.avg)}">${r.L.n ? `${sgn(r.L.avg, 0)} × ${r.L.n}` : '—'}</td><td class="${cls(r.S.avg)}">${r.S.n ? `${sgn(r.S.avg, 0)} × ${r.S.n}` : '—'}</td><td class="neg">${r.st.n ? sgn(r.st.maxdd, 0) : '—'}</td><td><button class="btn sm" data-use="${esc(r.id)}">Use</button></td></tr>`).join('')}
      </tbody></table></div><p class="note">Ranked by average net bp per trade on Gate's short history. Check the longs/shorts split: a strategy that only wins on one side is mostly riding the trend of these few weeks.</p></div>`;
  } catch (e) { $('#btOut').innerHTML = `<div class="empty err">Compare failed: ${esc(e.message || e)}</div>`; }
  finally { btn.disabled = false; btn.textContent = 'Compare all strategies'; progress('#btProg', 1, 1); }
});

// ── strategy check: research period vs the last 2 months vs the last month ──────────────────
// Recent months use the research's own data (Binance XAUUSDT / QQQUSDT perps, 1m) so the numbers compare like for like.
const CK = { res: null, running: false, eq: null };
const ARCH = { XAUUSD: 'XAUUSDT', NAS100: 'QQQUSDT' };
const TACTICS = [['intraday', 'Intraday (current)'], ['trend', 'Swing']];
// full research samples, both tactics (same costs as the defaults here); see fx.js for the study
const RESEARCH = [
  ['Gold · XAUUSDT perp, Dec 2025 – Oct 2026', { n: 180, win: .55, avg: 4.0, sum: 717, t: 1.26, L: 1.7, S: 7.1 }, { n: 293, win: .47, avg: -0.3, sum: -79, t: -0.05 }],
  ['Gold · PAXG spot, 2025', { n: 163, win: .53, avg: 4.6, sum: 746, t: 1.61, L: 4.6, S: 4.5 }, { n: 277, win: .50, avg: 13.8, sum: 3833, t: 2.82 }],
  ['Nasdaq · QQQUSDT perp, Apr – Oct 2026', { n: 116, win: .47, avg: 1.5, sum: 178, t: 0.48, L: -1.4, S: 5.8 }, { n: 177, win: .53, avg: 14.2, sum: 2510, t: 2.32 }],
  ['All research samples', { n: 459, win: .52, avg: 3.6, sum: 1641, t: 2.0, L: 2.0, S: 5.9 }, { n: 747, win: .50, avg: 8.4, sum: 6264, t: 2.6 }],
];
async function runCheck() {
  if (CK.running) return;
  CK.running = true;
  const btn = $('#ckRun'); btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const now = Math.floor(Date.now() / 1000), from = (Math.floor(now / 86400) - 64) * 86400; // 60 days + a few for EMA warm-up
    const prog = {}, tick = () => { const d = Object.values(prog).reduce((a, x) => a + x[0], 0), t = Object.values(prog).reduce((a, x) => a + x[1], 0); progress('#ckProg', d, t || 1); };
    const nasRef = D.res?.rows.find(x => x?.inst?.id === 'NAS100')?.price || 29000;
    const insts = {};
    await Promise.all(Object.values(INSTR).map(async inst => {
      const raw = await archiveBars(ARCH[inst.id], from, now, (d, t) => { prog[inst.id] = [d, t]; tick(); });
      if (raw.t.length < 5000) throw new Error(`only ${raw.t.length} candles for ${ARCH[inst.id]}`);
      const b = resample(marketOnly(raw), 5), last = b.c[b.c.length - 1];
      // the QQQ series stands in for NAS100: convert the NAS100 spread (points) with the NAS100 price, not QQQ's
      const cost = inst.id === 'NAS100' ? brokerCost(inst, nasRef, +$('#spN').value || 0, 0, +$('#slip').value || 0) : brokerCost(inst, last, +$('#spX').value || 0, +$('#cmX').value || 0, +$('#slip').value || 0);
      const tr = {};
      for (const [k] of TACTICS) {
        const S = FX_STRATS[k], res = run(b, S.signals(b, S.params, { tfMin: 5 }), cost);
        tr[k] = res.trades.filter(x => !x.open).map(x => ({ ...x, inst: inst.id, tIn: b.t[x.ei], tOut: b.t[x.xi] + 300, bp: x.net * 1e4 }));
      }
      insts[inst.id] = { inst, end: b.t[b.t.length - 1] + 300, start: b.t[0], tr };
    }));
    CK.res = { at: Date.now(), insts };
    renderCheck();
  } catch (e) { $('#ckOut').innerHTML = `<div class="empty err">Check failed: ${esc(e.message || e)}. data.binance.vision must be reachable from this network.</div>`; }
  finally { CK.running = false; btn.disabled = false; btn.textContent = '✦ Run check'; progress('#ckProg', 1, 1); }
}
$('#ckRun').addEventListener('click', runCheck);
function renderCheck() {
  const r = CK.res, I = r.insts, end = Math.min(...Object.values(I).map(x => x.end));
  const win = days => [end - days * 86400, end];
  const pick = (id, k, [a, b]) => (id ? I[id].tr[k] : Object.values(I).flatMap(x => x.tr[k])).filter(x => x.tIn >= a && x.tIn < b);
  const side = (list, s) => stats(list.filter(x => x.side === s));
  const cells = (st, ls) => st.n ? `<td>${st.n}</td><td>${Math.round(st.win * 100)}%</td><td class="${cls(st.avg)}">${sgn(st.avg, 1)}</td><td class="${cls(st.sum)}">${sgn(st.sum, 0)}</td><td>${n2(st.t, 2)}</td>${ls ? `<td class="dim">${sgn(ls[0], 1)} / ${sgn(ls[1], 1)}</td>` : ''}` : `<td>0</td><td colspan="${ls ? 5 : 4}" class="dim">no trades</td>`;
  const swingCells = st => st.n ? `<td>${st.n}</td><td class="${cls(st.avg)}">${sgn(st.avg, 1)}</td><td class="${cls(st.sum)}">${sgn(st.sum, 0)}</td><td>${n2(st.t, 2)}</td>` : '<td>0</td><td colspan="3" class="dim">no trades</td>';
  const live = (label, days) => {
    const w = win(days), rows = [['Gold', 'XAUUSD'], ['Nasdaq', 'NAS100'], ['Both', null]];
    return rows.map(([name, id], i) => {
      const a = pick(id, 'intraday', w), b = pick(id, 'trend', w), A = stats(a);
      return `<tr${i === 2 ? ' style="font-weight:600"' : ''}>${i === 0 ? `<td class="l" rowspan="3">${esc(label)}<br><span class="dim">${esc(fmtWib(w[0]))} → ${esc(fmtWib(w[1]))}</span></td>` : ''}<td class="l">${name}</td>
        ${cells(A, [side(a, 1).avg, side(a, -1).avg])}${swingCells(stats(b))}</tr>`;
    }).join('');
  };
  const research = RESEARCH.map(([label, a, b], i) => `<tr${i === 3 ? ' style="font-weight:600"' : ''}>${i === 0 ? '<td class="l" rowspan="4">Research period<br><span class="dim">Binance archives, 2025 – Oct 2026</span></td>' : ''}<td class="l">${esc(label)}</td>${cells(a, [a.L, a.S])}${swingCells(b)}</tr>`).join('');
  // plain-language read of the current tactic
  const say = [], m1 = win(30);
  for (const [name, id, base] of [['Gold', 'XAUUSD', 4.3], ['Nasdaq', 'NAS100', 1.5]]) {
    const list = pick(id, 'intraday', m1), st = stats(list);
    if (!st.n) { say.push(`${name}: no intraday trades in the last month.`); continue; }
    const sd = Math.sqrt(list.reduce((q, x) => q + (x.bp - st.avg) ** 2, 0) / Math.max(1, st.n - 1)), band = 2 * sd / Math.sqrt(st.n);
    const verdict = st.avg < 0 && st.t <= -1.5 ? 'clearly worse than the research — consider pausing it' : st.avg < 0 ? 'negative, but within the noise of so few trades' : st.avg >= base ? 'in line with or better than the research' : 'positive but below the research average';
    say.push(`${name}: ${st.n} trades last month, ${sgn(st.avg, 1)} bp a trade (research ≈ ${sgn(base, 1)}); with this few trades anything within ±${n2(band, 0)} bp is noise — ${verdict}.`);
  }
  // week by week, current tactic
  const wk = new Map();
  for (const x of pick(null, 'intraday', win(60))) {
    const d = Math.floor((x.tIn + 7 * 3600) / 86400), monday = d - (d + 3) % 7;
    const g = wk.get(monday) || { XAUUSD: [], NAS100: [] }; g[x.inst].push(x); wk.set(monday, g);
  }
  const wcell = l => { const st = stats(l); return st.n ? `<td>${st.n}</td><td class="${cls(st.sum)}">${sgn(st.sum, 0)}</td>` : '<td>0</td><td class="dim">—</td>'; };
  const weeks = [...wk.entries()].sort((a, b) => b[0] - a[0]).map(([d, g]) => `<tr><td class="l">${esc(new Date(d * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }))}</td>${wcell(g.XAUUSD)}${wcell(g.NAS100)}${(() => { const st = stats([...g.XAUUSD, ...g.NAS100]); return `<td class="${cls(st.sum)}">${st.n ? sgn(st.sum, 0) : '—'}</td>`; })()}</tr>`).join('');
  const recent = pick(null, 'intraday', win(60)).sort((a, b) => b.tIn - a.tIn).slice(0, 12);
  $('#ckOut').innerHTML = `<div class="card"><h2 class="sec">Current tactic vs swing, by period</h2>
      <ul class="say" style="margin-bottom:12px">${say.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="tblwrap"><table class="tk sm" style="min-width:860px"><thead>
        <tr><th class="l" rowspan="2">Period</th><th class="l" rowspan="2">Market</th><th colspan="6" style="text-align:center;color:var(--lime)">Intraday (current) · out within 2 h</th><th colspan="4" style="text-align:center">Swing · up to 24 h</th></tr>
        <tr><th>Trades</th><th>Win</th><th>Avg bp</th><th>Total bp</th><th>t</th><th>Long / short bp</th><th>Trades</th><th>Avg bp</th><th>Total bp</th><th>t</th></tr></thead>
        <tbody>${research}${live('Last 2 months', 60)}${live('Last month', 30)}</tbody></table></div>
      <p class="note">Recent rows: data through ${esc(fmtWib(end))} WIB (the archive is published a day or two late), costs from the Backtest tab (${esc($('#spX').value)} $ gold spread + $${esc($('#cmX').value)}/lot, ${esc($('#spN').value)} pt Nasdaq spread, ${esc($('#slip').value)} bp slippage). Nasdaq here is the QQQ perp, as in the research. The last months overlap the end of the research period, so they are a check-up, not fresh proof. t below ~2 means the average could still be luck.</p></div>
    <div class="grid2" style="margin-top:14px">
      <div class="card"><h2 class="sec">Intraday equity, last 2 months <span class="dim" style="font:13px var(--body)">(cumulative net bp, both markets)</span></h2><div class="chartbox" id="ckEq"></div></div>
      <div class="card"><h2 class="sec">Week by week · intraday</h2><div class="tblwrap"><table class="tk sm" style="min-width:0"><thead><tr><th class="l">Week of</th><th>Gold</th><th>bp</th><th>Nasdaq</th><th>bp</th><th>Total bp</th></tr></thead><tbody>${weeks || '<tr><td class="l" colspan="6">No trades.</td></tr>'}</tbody></table></div></div>
    </div>
    <div class="card"><h2 class="sec">Latest intraday trades</h2><div class="tblwrap"><table class="tk sm"><thead><tr><th class="l">Entry (WIB)</th><th class="l">Market</th><th class="l">Side</th><th>Entry</th><th>Exit</th><th class="l">Exit reason</th><th>Net bp</th><th>Held</th></tr></thead><tbody>
      ${recent.map(x => `<tr><td class="l">${fmtWib(x.tIn)}</td><td class="l"><span class="sym">${x.inst === 'NAS100' ? 'QQQ (NAS)' : 'XAU'}</span></td><td class="l side-${x.side}">${x.side === 1 ? 'long' : 'short'}</td><td>${n2(x.ep, 2)}</td><td>${n2(x.xp, 2)}</td><td class="l">${esc(reasonTxt(x.reason))}</td><td class="${cls(x.bp)}">${sgn(x.bp, 0)}</td><td class="dim">${held(x.tOut - x.tIn)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  CK.eq?.destroy(); CK.eq = makeLineChart($('#ckEq'), { height: 240 });
  let cum = 0; CK.eq.set(pick(null, 'intraday', win(60)).sort((a, b) => a.tOut - b.tOut).map(x => ({ t: x.tOut, v: cum += x.bp })));
}

// ── research notes (static: the offline study) ───────────────────────────────────────────────
$('#researchBody').innerHTML = `
  <p><b>Data.</b> Gate's index candles only go back 7 days on 1m and about 35 days on 5m, so the research used Binance archives: the XAUUSDT perp (Dec 2025 → Oct 2026, gold −5 %), PAXG spot for 2025 (gold +61 %, an independent year) and the QQQUSDT perp for Nasdaq (Apr → Oct 2026, +20 %). Costs: about a $0.25 gold spread / 1.5 pt Nasdaq spread, i.e. 0.5 bp a side, plus 0.25 bp slippage. Each sample was split in two halves by time: 6 halves in all.</p>
  <p><b>Are 5-minute moves predictable?</b> Barely. A 5m move did not reliably continue or reverse over the next 15–60 minutes (≈ 0.3 bp per standard deviation, well under the spread), no hour of the day drifted the same way in both halves, extreme 5m candles (news or not) did not follow through or snap back, and price far from the day's average did not come back within the hour.</p>
  <table><thead><tr><th>Idea (1m / 5m / 15m)</th><th>Result</th></tr></thead><tbody>
    <tr><td>Claude's Sweep &amp; Reclaim of the Asian range / previous day high-low</td><td class="neg">≤ 0 out-of-sample</td></tr>
    <tr><td>NY opening-range breakout (direction and breakout, 5/15/30 min)</td><td class="neg">−1 to −13 bp</td></tr>
    <tr><td>The crypto Flush &amp; Reclaim rules</td><td class="neg">≤ 0</td></tr>
    <tr><td>Nasdaq intraday momentum (first half hour → last half hour)</td><td>+4 then 0 bp</td></tr>
  </tbody></table>
  <p><b>Why the first version held trades for a day.</b> Its target was 1 % (≈ $40 on gold) while a 5m candle moves $3–5, so it took hours. Shortening the hold with the same entries shows where the money is:</p>
  <table><thead><tr><th>Same pullback entries, exit…</th><th>Median hold</th><th>Avg bp</th></tr></thead><tbody>
    <tr><td>2 ATR target / 1.5 ATR stop</td><td>25 min</td><td>+0.2</td></tr>
    <tr><td>after 1 hour</td><td>1 h</td><td>+1.3</td></tr>
    <tr><td>after 4 hours</td><td>4 h</td><td>+4.3</td></tr>
    <tr><td>Swing: target 1 % / stop 1.5 % / 24 h</td><td>11–14 h</td><td class="pos">+8.4</td></tr>
  </tbody></table>
  <p>The longer it holds, the more it earns: the rule rides a slow drift, it does not time 5-minute wiggles. Swing's +8.4 bp came almost all from the trend side in rising samples (gold 2025 longs +25 bp, Nasdaq longs +26 bp, shorts ≈ 0; flat gold 2026: −0.3 bp).</p>
  <table><thead><tr><th>Intraday mode, 5m</th><th>Trades</th><th>Avg bp</th><th>t</th></tr></thead><tbody>
    <tr><td>Entries 02:00–13:00 ET, out after 2 h or 16:45 ET, stop 0.6 %</td><td>459</td><td class="pos">+3.6</td><td>2.0</td></tr>
    <tr><td>· longs / shorts</td><td colspan="3">+2 / +6 bp — both sides positive</td></tr>
    <tr><td>· by sample (halves): gold 26, gold 25, Nasdaq</td><td colspan="3">−6.7 / +12.9 · +6.8 / +2.9 · +3.0 / −0.4</td></tr>
    <tr><td>· 2× spread / 4× spread</td><td colspan="3">+2.1 / −0.9 bp</td></tr>
    <tr><td>· neighbouring settings (RSI 45 or 7, EMA 200, 90 min, other stops)</td><td colspan="3">−0.1 to +3.6 bp</td></tr>
    <tr><td>· entries at any hour</td><td colspan="3">+0.2 bp</td></tr>
    <tr><td>· same rule on 1m / 15m</td><td colspan="3"><span class="neg">−1.8</span> / +1.3 bp</td></tr>
  </tbody></table>
  <p><b>Verdict.</b> Intraday is the better fit for a 5m chart — no overnight swap, both directions — but its edge is a few bp, needs a raw-spread account, depends on trading the London + New York morning only, and the exact settings were picked from ~25 tries. Swing earned more per trade but only from trends. Paper-trade either for a few weeks and compare with these numbers before risking money. The rules and code are in <span class="mono">forex/fx.js</span>.</p>`;


// ── boot ─────────────────────────────────────────────────────────────────────────────────────
bindPref('#cap', 'cap'); bindPref('#risk', 'risk'); bindPref('#auto', 'auto', 'checked');
['#spX', '#cmX', '#spN', '#slip'].forEach(s => bindPref(s, s.slice(1)));
bindPref('#btStrat', 'btStrat'); bindPref('#btInst', 'btInst'); bindPref('#btTf', 'btTf');
renderParams(); syncTf(); renderPlaybook();
(async () => {
  let pw = ''; try { pw = sessionStorage.getItem('agz_bb_pw') || ''; } catch (_) { }
  if (pw) { try { await unlock(pw); return; } catch (_) { try { sessionStorage.removeItem('agz_bb_pw'); } catch (e) { } } }
  $('#pw')?.focus();
})();
