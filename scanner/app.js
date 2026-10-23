// /scanner app: passphrase gate + the VPS snapshot (Scanner tab), and live browser tools on Gate.io candles:
// Scan with Claude, Chart (TradingView Lightweight Charts), Backtest, Capital sim.
import { STRATEGIES, backtest, run, stats, simulateMoney, REASON, COSTS, TF_MIN } from './lab/engine.js';
import { CLAUDE, claudeSignals, tokenContext, marketRead, scoreSetup, narrative, digitsFor } from './lab/claude.js';
import { candles, closed, pool, TF_SEC } from './lab/data.js';
import { makeChart, makeLineChart, toChartTime } from './lab/chart.js';
import { ema } from './lab/ind.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
const fmtDT = s => s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtWib = t => t ? new Date(t * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = s => { if (!s) return ''; const d = (Date.now() - Date.parse(s)) / DAY; if (d < 1 / 24) return Math.max(1, Math.round(d * 1440)) + 'm ago'; if (d < 1) return Math.round(d * 24) + 'h ago'; return Math.round(d) + 'd ago'; };
const agoS = t => ago(new Date(t * 1000).toISOString());
const n2 = (v, d = 1) => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d);
const sgn = (v, d = 1) => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(d);
const pct = v => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
const vol = v => { if (v == null || isNaN(v)) return '—'; if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B'; if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M'; return '$' + Math.round(v); };
const money = (v, d = 2) => (v == null || isNaN(v)) ? '—' : (v < 0 ? '−$' : '$') + Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const px = (v, ref) => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: digitsFor(ref ?? v), maximumFractionDigits: digitsFor(ref ?? v) });
const cls = v => v == null || isNaN(v) ? '' : (v >= 0 ? 'pos' : 'neg');
const short = s => String(s || '').replace(/USDT$/, '');
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3400); }
function progress(sel, done, total) { const p = $(sel); p.classList.toggle('on', done < total); p.firstElementChild.style.width = (total ? done / total * 100 : 0) + '%'; }

// per-viewer conveniences (remembered inputs); the page works without them
const PREF_KEY = 'agz_scanner_prefs';
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (_) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { } };
function bindPref(sel, key, kind = 'value') {
  const el = $(sel); if (!el) return;
  if (prefs[key] != null) { if (kind === 'checked') el.checked = !!prefs[key]; else el.value = prefs[key]; }
  el.addEventListener('change', () => { prefs[key] = kind === 'checked' ? el.checked : el.value; savePrefs(); });
}

// ── gate: same scheme + passphrase as /bugbounty; v2 snapshots are gzip-compressed before encryption ──
const te = new TextEncoder(), td = new TextDecoder();
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pw, salt, iters) {
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function fetchPkg() {
  let file = 'scanner.enc.json';
  try { const m = await (await fetch('scanner.manifest.json?_=' + Date.now(), { cache: 'no-store' })).json(); if (m && m.file) file = m.file; } catch (_) { }
  return (await fetch(file + '?_=' + Date.now(), { cache: 'no-store' })).json();
}
async function decryptSnap(pw) {
  const pkg = await fetchPkg();
  const key = await deriveKey(pw, b64d(pkg.salt), pkg.iter || 200000);
  let pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(pkg.iv) }, key, b64d(pkg.ct));
  if (pkg.z === 'gzip' && typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to open the snapshot (no DecompressionStream).');
  if (pkg.z === 'gzip') pt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return JSON.parse(td.decode(pt));
}

let SNAP = null, PW = '';
const ST = { q: '', state: '', sort: 'fwd_t', dir: 1 };
const SYMS = () => {
  const list = (SNAP?.rows || []).map(r => r.symbol);
  return list.length ? list : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
};

async function unlock(pw) {
  SNAP = await decryptSnap(pw); PW = pw; document.body.classList.add('on');
  render(); fillSymbolSelects(); refreshMoneySources(); routeFromHash();
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault(); const pw = $('#pw').value, btn = $('#gateBtn'), err = $('#gerr');
  btn.disabled = true; btn.textContent = 'Decrypting…'; err.textContent = '';
  try { await unlock(pw); try { sessionStorage.setItem('agz_bb_pw', pw); } catch (_) { } }
  catch (_) { err.textContent = 'Wrong passphrase, or the snapshot could not be read.'; btn.disabled = false; btn.textContent = 'Unlock'; }
});
$('#lockBtn').addEventListener('click', () => { try { sessionStorage.removeItem('agz_bb_pw'); } catch (_) { } location.reload(); });
$('#refreshBtn').addEventListener('click', async () => {
  if (!PW) return; const b = $('#refreshBtn'); b.textContent = '…';
  try { SNAP = await decryptSnap(PW); render(); toast('Refreshed — scan made ' + fmtDT(SNAP.made)); } catch (e) { toast('Refresh failed'); }
  finally { b.textContent = 'Refresh'; }
});

// ── tabs ─────────────────────────────────────────────────────────────────────────────────────
const TABS = ['scanner', 'claude', 'chart', 'backtest', 'money'];
function showTab(name, push = true) {
  if (!TABS.includes(name)) name = 'scanner';
  $$('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
  if (push && location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (name === 'chart') ensureChart();
  if (name === 'money') renderMoney();
}
$$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function routeFromHash() { const h = location.hash.replace('#', ''); showTab(TABS.includes(h) ? h : 'scanner', false); }
window.addEventListener('hashchange', routeFromHash);

// ── Scanner tab (VPS snapshot) ───────────────────────────────────────────────────────────────
const COLS = [
  { k: 'symbol', t: 'Token', l: 1, kind: 'sym' },
  { k: 'state', t: 'State', l: 1, kind: 'state' },
  { k: 'side', t: 'Side', l: 1, kind: 'side' },
  { k: 'strategy', t: 'Strategy', l: 1, kind: 'strat' },
  { k: 'fwd_t', t: 't-stat', kind: 'tstat' },
  { k: 'fwd_avg_bps', t: 'bp/trade', kind: 'sgn' },
  { k: 'fwd_win_rate', t: 'Win', kind: 'winrate' },
  { k: 'fwd_trades', t: 'Trades', kind: 'int' },
  { k: 'fwd_return_pct', t: '14d ret', kind: 'pct' },
  { k: 'fwd_max_dd_bps', t: 'Max DD', kind: 'sgn' },
  { k: 'unreal_bps', t: 'Unreal', kind: 'sgn' },
  { k: 'trades_today', t: 'T.today', kind: 'int' },
  { k: 'signals_today', t: 'Sig.today', kind: 'int' },
  { k: 'chg24', t: '24h', kind: 'pct' },
  { k: 'vol24', t: 'Vol 24h', kind: 'vol' },
  { k: 'cost_bps', t: 'Cost bp', kind: 'num0' },
  { k: 'corr_btc', t: 'BTC ρ', kind: 'num2' },
];
function render() {
  const s = SNAP; if (!s) return;
  $('#age').textContent = 'Scan ' + ago(s.made);
  const u = s.universe || {}, c = s.config || {};
  $('#stats').innerHTML = [
    ['Tokens', (s.rows || []).length], ['Scan made', fmtDT(s.made)], ['Record', (c.days || 14) + ' days'],
    ['Lookback', (c.lookback_months || '—') + ' mo'], ['Mode', c.mode || '—'], ['Universe', (u.above_volume || '—') + ' liquid'],
    ['Chance cut', '±' + n2(s.cut, 1) + ' t'],
  ].map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  const ss = s.sessions || [];
  $('#sessionsWrap').style.display = ss.length ? '' : 'none';
  $('#sessions').innerHTML = ss.map(se => {
    const r = se.summary || {}, up = (r.return ?? 0) >= 0, m = se.money || {};
    return `<div class="scard"><h3>${esc(se.name || se.id)}</h3>
      <div class="pnl ${up ? 'up' : 'down'}">${r.return == null ? '—' : pct(r.return * 100)}</div>
      <div class="meta">Equity ${money(r.equity, 0)} · P&L ${money(r.profit, 0)} of ${money(m.capital, 0)}<br>
      ${se.trades || 0} trades · ${se.days || 0} days · ${se.stopped ? 'stopped' : 'running'} · updated ${ago(se.updated || se.started)}</div>
      <div class="mono">${esc(m.margin_pct ?? '?')}% × ${esc(m.leverage ?? '?')}x · max ${esc(m.max_positions ?? '?')} pos · top ${esc(se.scan?.top ?? '?')}</div></div>`;
  }).join('');
  renderTable();
}
function renderTable() {
  const rows = (SNAP.rows || []).filter(r => (!ST.state || r.state === ST.state) && (!ST.q || `${r.symbol} ${r.strategy}`.toLowerCase().includes(ST.q)));
  const key = ST.sort;
  rows.sort((a, b) => {
    if (key === 'symbol' || key === 'strategy' || key === 'state') return String(a[key] || '').localeCompare(String(b[key] || '')) * ST.dir;
    const av = a[key], bv = b[key];
    const an = (av == null || isNaN(av)) ? -Infinity : av, bn = (bv == null || isNaN(bv)) ? -Infinity : bv;
    return (bn - an) * ST.dir;
  });
  const th = COLS.map(c => `<th class="${c.l ? 'l' : ''}" data-k="${c.k}" ${ST.sort === c.k ? `aria-sort="${ST.dir > 0 ? 'descending' : 'ascending'}"` : ''}>${esc(c.t)}${ST.sort === c.k ? ` <span class="ar">${ST.dir > 0 ? '↓' : '↑'}</span>` : ''}</th>`).join('');
  const body = rows.map(r => `<tr data-sym="${esc(r.symbol)}">` + COLS.map(c => cell(r, c)).join('') + '</tr>').join('');
  $('#tbl').innerHTML = `<thead><tr>${th}</tr></thead><tbody>${body || `<tr><td class="l" colspan="${COLS.length}">No tokens match.</td></tr>`}</tbody>`;
  $('#foot').textContent = `${rows.length} tokens · snapshot generated ${fmtDT(SNAP.generatedAt)} · decrypted locally in your browser · live candles from Gate.io (public API) · charts by TradingView Lightweight Charts · research only, not financial advice.`;
}
function cell(r, c) {
  const v = r[c.k];
  switch (c.kind) {
    case 'sym': return `<td class="l"><span class="sym">${esc(v)}</span></td>`;
    case 'state': return `<td class="l"><span class="pill st-${esc(v)}">${esc(v)}</span></td>`;
    case 'side': return `<td class="l side-${esc(v)}">${v === 1 ? 'long' : v === -1 ? 'short' : '—'}</td>`;
    case 'strat': return `<td class="l"><span class="strat">${esc(v || '—')}</span>${r.tf ? ` <span class="mono" style="color:var(--dim)">${esc(r.tf)}</span>` : ''}</td>`;
    case 'tstat': { const strong = v != null && Math.abs(v) >= (SNAP.cut || 2); return `<td class="${cls(v)} ${strong ? 't-strong' : ''}">${sgn(v, 2)}</td>`; }
    case 'sgn': return `<td class="${cls(v)}">${sgn(v, 0)}</td>`;
    case 'winrate': return `<td>${v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%'}</td>`;
    case 'int': return `<td>${v == null ? '—' : v}</td>`;
    case 'pct': return `<td class="${cls(v)}">${pct(v)}</td>`;
    case 'vol': return `<td>${vol(v)}</td>`;
    case 'num0': return `<td>${n2(v, 0)}</td>`;
    case 'num2': return `<td>${n2(v, 2)}</td>`;
    default: return `<td>${esc(v)}</td>`;
  }
}
$('#tbl').addEventListener('click', e => {
  const th = e.target.closest('th');
  if (th) { const k = th.dataset.k; if (ST.sort === k) ST.dir *= -1; else { ST.sort = k; ST.dir = 1; } renderTable(); return; }
  const tr = e.target.closest('tr[data-sym]'); if (tr) openChart(tr.dataset.sym, { overlay: 'bot', tf: '15m' });
});
$('#q').addEventListener('input', e => { ST.q = e.target.value.trim().toLowerCase(); renderTable(); });
$('#stateSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $('#stateSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); ST.state = b.dataset.v; renderTable(); });

// ── helpers shared by the live tabs ──────────────────────────────────────────────────────────
const tfSec = tf => TF_SEC[tf] || 3600;
/** Engine trades → flat records with times (for tables, equity and the capital sim). */
function flatTrades(sym, b, trades, tf) {
  const sec = tfSec(tf);
  return trades.map(x => ({ sym, side: x.side, ep: x.ep, xp: x.xp, sl: x.sl, tp: x.tp, tp1: x.tp1, tp1Hit: x.tp1Hit, reason: x.reason, open: x.open,
    net: x.net, bp: x.net * 1e4, mae: x.mae, slFrac: x.sl === x.sl ? Math.abs(x.ep - x.sl) / x.ep : 0,
    tIn: b.t[x.ei], tOut: b.t[x.xi] + sec, ei: x.ei, xi: x.xi, tf }));
}
/** Drop signals on a still-forming candle (they are not final until it closes). */
function maskForming(sig, b) {
  if (!b.forming) return sig;
  const k = b.t.length - 1;
  for (const key of ['lel', 'sel', 'les', 'ses']) if (sig[key]) sig[key][k] = NaN;
  for (const key of ['le', 'se']) if (sig[key]) sig[key][k] = 0;
  return sig;
}
function equityPoints(list) {
  const sorted = [...list].filter(x => !x.open).sort((a, b) => a.tOut - b.tOut);
  let cum = 0; const pts = sorted.length ? [{ t: sorted[0].tIn, v: 0 }] : [];
  for (const x of sorted) { cum += x.bp; pts.push({ t: x.tOut, v: cum }); }
  return pts;
}
function statTiles(st, extra = []) {
  if (!st || !st.n) return '<div class="stats"><div class="stat"><b>0</b><span>closed trades</span></div></div>';
  const t = [
    ['Trades', st.n, ''], ['Win rate', Math.round(st.win * 100) + '%', ''], ['Avg / trade', sgn(st.avg, 1) + ' bp', st.avg >= 0 ? 'good' : 'badv'],
    ['Total', sgn(st.sum, 0) + ' bp', st.sum >= 0 ? 'good' : 'badv'], ['t-stat', n2(st.t, 2), Math.abs(st.t) >= 2 ? (st.t > 0 ? 'good' : 'badv') : ''],
    ['Profit factor', isFinite(st.pf) ? n2(st.pf, 2) : '∞', ''], ['Max DD', sgn(st.maxdd, 0) + ' bp', 'badv'], ['TP / SL', `${st.tp} / ${st.sl}`, ''], ...extra,
  ];
  return '<div class="stats">' + t.map(([k, v, c]) => `<div class="stat ${c}"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('') + '</div>';
}
const reasonTxt = r => REASON[r] || r;
function tradeRows(list, limit = 200) {
  const sorted = [...list].sort((a, b) => b.tIn - a.tIn).slice(0, limit);
  return sorted.map((x, i) => `<tr data-i="${i}" data-sym="${esc(x.sym)}" data-t="${x.tIn}" data-tf="${esc(x.tf || '')}">
    <td class="l">${fmtWib(x.tIn)}</td><td class="l"><span class="sym">${esc(short(x.sym))}</span></td><td class="l side-${x.side}">${x.side === 1 ? 'long' : 'short'}</td>
    <td>${px(x.ep)}</td><td>${px(x.xp, x.ep)}</td><td class="l">${esc(x.open ? 'open' : reasonTxt(x.reason))}${x.tp1Hit ? ' <span class="dim">(TP1 ✓)</span>' : ''}</td>
    <td class="${cls(x.bp)}">${sgn(x.bp, 0)}</td><td class="dim">${Math.round((x.tOut - x.tIn) / 3600)}h</td></tr>`).join('');
}
const tradeHead = '<thead><tr><th class="l">Entry (WIB)</th><th class="l">Token</th><th class="l">Side</th><th>Entry</th><th>Exit</th><th class="l">Exit reason</th><th>Net bp</th><th>Held</th></tr></thead>';

// ── Scan with Claude ─────────────────────────────────────────────────────────────────────────
const CL = { res: null, running: false };
async function analyzeToken(sym, raw, btcRaw) {
  const p = CLAUDE.params, sig = maskForming(claudeSignals(raw, p, { tfMin: 60 }), raw);
  const res = run(raw, sig, {});
  const b = closed(raw), btc = closed(btcRaw);
  const ctx = tokenContext(b, btc);
  ctx.price = raw.c[raw.c.length - 1];
  const trades = flatTrades(sym, raw, res.trades, '1h');
  const live = res.live, why = live.pending ? sig.why[live.pending.sigBar] : live.position ? sig.why[live.position.sigBar] : null;
  return { sym, raw, ctx, trades, st: stats(trades), live, why };
}
async function claudeScan() {
  if (CL.running) return;
  CL.running = true;
  const btn = $('#cRun'); btn.disabled = true; btn.textContent = 'Claude is scanning…';
  const depth = +$('#cDepth').value, syms = [...new Set(['BTCUSDT', ...SYMS()])];
  try {
    progress('#cProg', 0, syms.length);
    const btcRaw = await candles('BTCUSDT', '1h', depth, 120e3);
    const out = await pool(syms, 4, async sym => analyzeToken(sym, sym === 'BTCUSDT' ? btcRaw : await candles(sym, '1h', depth, 120e3), btcRaw),
      (d, t) => progress('#cProg', d, t));
    const ok = out.filter(x => x && !x.error), failed = syms.filter((s, i) => !out[i] || out[i].error);
    const ctxs = Object.fromEntries(ok.map(x => [x.sym, x.ctx]));
    const mkt = marketRead(closed(btcRaw), ctxs);
    const all = ok.flatMap(x => x.trades), global = stats(all);
    for (const x of ok) {
      const setup = x.live.position || x.live.pending;
      x.state = x.live.position ? 'position' : x.live.pending ? 'pending' : 'none';
      x.scored = setup ? scoreSetup(x.live.pending, x.why, x.ctx, x.st, global, mkt) : null;
      x.say = narrative(x.sym, { ...x.live, why: x.why }, x.ctx, mkt);
    }
    CL.res = { at: Date.now(), depth, ok, failed, mkt, global, all };
    renderClaude();
    refreshMoneySources();
    const live = ok.filter(x => x.state !== 'none').length;
    toast(`Claude scanned ${ok.length} tokens — ${live} live setup${live === 1 ? '' : 's'}`);
  } catch (e) {
    $('#cOut').innerHTML = `<div class="empty err">Scan failed: ${esc(e.message || e)}. Gate.io (api.gateio.ws) must be reachable from this network.</div>`;
  } finally {
    CL.running = false; btn.disabled = false; btn.textContent = '✦ Scan with Claude'; progress('#cProg', 1, 1);
  }
}
$('#cRun').addEventListener('click', claudeScan);

function claudeMarketNote(m) {
  const s = [];
  s.push(m.btcRegime === 'bull' ? `BTC ${px(m.btcPrice)} is above its ~25-day EMA (${px(m.btcE600, m.btcPrice)}) — the backdrop helps longs.`
    : `BTC ${px(m.btcPrice)} is below its ~25-day EMA (${px(m.btcE600, m.btcPrice)}) — flushes can keep flushing; Claude would size down.`);
  s.push(`${Math.round(m.breadth * 100)}% of ${m.tokens} tokens trade above their 1h EMA 200. BTC ${pct(m.btcRet24)} 24h, ${pct(m.btcRet168)} 7d.`);
  if (m.stressed) s.push(`${m.stressed} token${m.stressed > 1 ? 's are' : ' is'} down more than 5% in 24h — that is where flush setups come from.`);
  if (m.ripping) s.push(`${m.ripping} up more than 8% in 24h — chasing those is not this strategy.`);
  return s;
}
function levelRows(x, ref) {
  const d = (v) => v == null || isNaN(v) ? '' : `${sgn((v / ref - 1) * 100, 2)}%`;
  const en = x.price ?? x.ep, sl0 = x.sl0 ?? x.sl, R = Math.abs(en - sl0), be = x.tp1Hit && x.sl !== sl0;
  return `<div class="lv">
    <span class="k">TP2</span><span class="p tp">${px(x.tp, en)}</span><span class="d">${d(x.tp)} · ${n2(Math.abs(x.tp - en) / R, 1)}R</span>
    ${x.tp1 === x.tp1 && x.tp1 != null ? `<span class="k">TP1 ½${x.tp1Hit ? ' ✓' : ''}</span><span class="p tp">${px(x.tp1, en)}</span><span class="d">${d(x.tp1)} · ${n2(Math.abs(x.tp1 - en) / R, 1)}R</span>` : ''}
    <span class="k">Entry</span><span class="p en">${px(en)}</span><span class="d">${d(en)}</span>
    ${be ? `<span class="k">Stop → BE</span><span class="p slc">${px(x.sl, en)}</span><span class="d">${d(x.sl)} · ±0R</span>` : ''}
    <span class="k">${be ? 'First stop' : 'Stop'}</span><span class="p slc">${px(sl0, en)}</span><span class="d">${d(sl0)} · −1R</span>
  </div>`;
}
function renderClaude() {
  const r = CL.res; if (!r) return;
  const m = r.mkt, live = r.ok.filter(x => x.state !== 'none').sort((a, b) => (b.state === 'position') - (a.state === 'position') || (b.scored?.score || 0) - (a.scored?.score || 0));
  const g = r.global;
  const mk = [
    ['BTC regime', m.btcRegime === 'bull' ? 'Bull' : 'Bear', m.btcRegime === 'bull' ? 'good' : 'badv'],
    ['Breadth > EMA200', Math.round(m.breadth * 100) + '%', ''], ['BTC 24h', pct(m.btcRet24), m.btcRet24 >= 0 ? 'good' : 'badv'],
    ['Live setups', live.length, live.length ? 'warnv' : ''], ['Tokens scanned', r.ok.length, ''],
    ['Strategy record', `${sgn(g.avg, 0)} bp × ${g.n}`, g.avg >= 0 ? 'good' : 'badv'],
  ];
  const cards = live.map(x => {
    const s = x.live.position || x.live.pending, isPos = x.state === 'position';
    const ref = s.price ?? s.ep, risk = Math.abs(ref - (s.sl0 ?? s.sl)) / ref * 100;
    const score = x.scored?.score ?? 0;
    const until = x.live.pending ? fmtWib(x.raw.t[x.live.pending.sigBar] + (CLAUDE.params.limit_bars + 1) * 3600) : '';
    return `<div class="setup ${isPos ? 'position' : ''}">
      <div class="hd"><b>${esc(short(x.sym))}</b><span class="pill ${isPos ? 'st-position' : 'st-pending'}">${isPos ? 'IN TRADE · LONG' : 'BUY LIMIT'}</span><span class="score ${score >= 65 ? 'hi' : ''}" title="Ranking aid, not a probability">${score}</span></div>
      ${levelRows(isPos ? { ...s, price: s.ep } : s, ref)}
      <div class="tags"><span class="tag">risk ${n2(risk, 2)}%</span><span class="tag">now ${px(x.ctx.price, ref)}</span>${until ? `<span class="tag">limit valid to ${esc(until)} WIB</span>` : `<span class="tag">since ${esc(fmtWib(x.raw.t[s.ei]))}</span>`}<span class="tag">token record ${x.st.n ? `${x.st.n} × ${sgn(x.st.avg, 0)} bp` : 'none'}</span></div>
      <ul class="say">${x.say.map(t => `<li>${esc(t)}</li>`).join('')}${(x.scored?.notes || []).map(t => `<li class="dim">${esc(t)}</li>`).join('')}</ul>
      <div class="ctrls" style="margin:0"><button class="btn sm pri" data-chart="${esc(x.sym)}">Chart with levels</button><button class="btn sm" data-bt="${esc(x.sym)}">Backtest this token</button></div>
    </div>`;
  }).join('');
  const watch = [...r.ok].sort((a, b) => (a.ctx.distLo24 ?? 99) - (b.ctx.distLo24 ?? 99));
  const recent = [...r.all].sort((a, b) => b.tIn - a.tIn).slice(0, 25);
  $('#cOut').innerHTML = `
    <div class="card"><h2 class="sec">Claude's market read</h2><div class="stats" style="margin-bottom:10px">${mk.map(([k, v, c]) => `<div class="stat ${c}"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>
      <ul class="say">${claudeMarketNote(m).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      <p class="note">Scanned ${fmtDT(new Date(r.at).toISOString())} · ${r.depth} 1h candles per token${r.failed.length ? ` · failed: ${esc(r.failed.map(short).join(', '))}` : ''}</p></div>
    <h2 class="sec" style="margin-top:18px">Live setups</h2>
    ${live.length ? `<div class="grid3">${cards}</div>` : `<div class="empty">No flush setup is live on any token right now — Claude says <b>no trade</b>. Flushes are event-driven (≈ 1–2 per day across 30 tokens); the watchlist below shows who is closest to its 24h low.</div>`}
    <h2 class="sec" style="margin-top:20px">Watchlist</h2>
    <div class="tblwrap"><table class="tk" id="cWatch"><thead><tr><th class="l">Token</th><th class="l">State</th><th>Price</th><th class="l">Trend 1h</th><th>RSI</th><th>ATR %/h</th><th>24h low</th><th>Above low</th><th>24h</th><th>7d vs BTC</th><th>Claude trades</th><th>Avg bp</th><th>Win</th></tr></thead><tbody>
    ${watch.map(x => `<tr data-sym="${esc(x.sym)}"><td class="l"><span class="sym">${esc(short(x.sym))}</span></td><td class="l"><span class="pill st-${x.state}">${x.state === 'none' ? 'watch' : x.state}</span></td>
      <td>${px(x.ctx.price)}</td><td class="l ${x.ctx.trend === 'up' ? 'pos' : x.ctx.trend === 'down' ? 'neg' : 'dim'}">${x.ctx.trend}</td><td>${n2(x.ctx.rsi, 0)}</td><td>${n2(x.ctx.atrPct, 2)}</td>
      <td>${px(x.ctx.lo24, x.ctx.price)}</td><td>${n2(x.ctx.distLo24, 1)}%</td><td class="${cls(x.ctx.ret24)}">${pct(x.ctx.ret24)}</td><td class="${cls(x.ctx.rs)}">${pct(x.ctx.rs)}</td>
      <td>${x.st.n || 0}</td><td class="${cls(x.st.avg)}">${x.st.n ? sgn(x.st.avg, 0) : '—'}</td><td>${x.st.n ? Math.round(x.st.win * 100) + '%' : '—'}</td></tr>`).join('')}
    </tbody></table></div>
    <h2 class="sec" style="margin-top:20px">Track record on this history (all tokens pooled)</h2>
    ${statTiles(g)}
    <div class="chartbox" id="cEq"></div>
    <div class="ctrls" style="margin:12px 0 0"><button class="btn pri" id="cToMoney" type="button">Simulate capital with these ${g.n || 0} trades →</button></div>
    <h2 class="sec" style="margin-top:20px">Latest Claude trades</h2>
    <div class="tblwrap"><table class="tk sm" id="cRecent">${tradeHead}<tbody>${tradeRows(recent)}</tbody></table></div>
    <p class="note">Same rules, costs and fill logic as the research. Past trades here were simulated on the candles, not traded.</p>`;
  CL.eq?.destroy(); CL.eq = makeLineChart($('#cEq'), { height: 240 });
  CL.eq.set(equityPoints(r.all));
  $('#cToMoney').addEventListener('click', () => { $('#mSrc').value = 'claude'; showTab('money'); });
}
$('#cOut').addEventListener('click', e => {
  const c = e.target.closest('[data-chart]'); if (c) { openChart(c.dataset.chart, { overlay: 'claude', tf: '1h' }); return; }
  const b = e.target.closest('[data-bt]'); if (b) { openBacktest(b.dataset.bt, 'claude', '1h'); return; }
  const tr = e.target.closest('tr[data-sym]');
  if (tr) openChart(tr.dataset.sym, { overlay: 'claude', tf: '1h', at: tr.dataset.t ? +tr.dataset.t : null });
});

// ── Chart ────────────────────────────────────────────────────────────────────────────────────
const CH = { chart: null, data: null, trades: [], live: null, sel: null };
function fillSymbolSelects() {
  const syms = SYMS();
  const opts = syms.map(s => `<option value="${esc(s)}">${esc(short(s))}</option>`).join('');
  $('#chSym').innerHTML = opts;
  $('#btSym').innerHTML = `<option value="__ALL__">All ${syms.length} scanner tokens</option>` + opts;
  const ov = [['claude', '✦ Claude · Flush & Reclaim'], ['bot', 'VPS bot · 14-day record'], ['none', 'No overlay'],
    ...Object.entries(STRATEGIES).filter(([k]) => k !== 'claude').map(([k, s]) => [k, `Lab · ${k}`])];
  $('#chOverlay').innerHTML = ov.map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
  $('#btStrat').innerHTML = Object.entries(STRATEGIES).map(([k, s]) => `<option value="${k}">${k === 'claude' ? '✦ Claude · Flush & Reclaim' : esc(k)}</option>`).join('');
  bindPref('#chOverlay', 'chOverlay'); bindPref('#chTf', 'chTf'); bindPref('#chDepth', 'chDepth'); bindPref('#chSym', 'chSym');
  bindPref('#btStrat', 'btStrat'); bindPref('#btDepth', 'btDepth'); bindPref('#btSym', 'btSym'); bindPref('#cDepth', 'cDepth');
  onStratChange();
}
function ensureChart() {
  ensureChartOnly();
  if (!CH.data || CH.dirty) loadChart();
}
function openChart(sym, { overlay, tf, at } = {}) {
  if (![...$('#chSym').options].some(o => o.value === sym)) $('#chCustom').value = sym; else { $('#chSym').value = sym; $('#chCustom').value = ''; }
  if (overlay) $('#chOverlay').value = overlay;
  if (tf) $('#chTf').value = tf;
  CH.focusAt = at || null;
  CH.dirty = true;
  showTab('chart');
}
const chartSym = () => ($('#chCustom').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || $('#chSym').value);
let chartSeq = 0;
async function loadChart() {
  ensureChartOnly();
  CH.dirty = false;
  const seq = ++chartSeq;
  const sym = chartSym(), tf = $('#chTf').value, depth = +$('#chDepth').value, ov = $('#chOverlay').value;
  const symFull = /USDT$/.test(sym) ? sym : sym + 'USDT';
  $('#chTv').href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent('BINANCE:' + symFull + '.P')}&interval=${({ '5m': 5, '15m': 15, '1h': 60, '4h': 240 })[tf] || 60}`;
  $('#chSetup').innerHTML = '<div class="muted">Loading candles…</div>';
  try {
    const b = await candles(symFull, tf, depth, 30e3);
    if (seq !== chartSeq) return; // a newer load started meanwhile
    if (!b.t.length) throw new Error('no candles for ' + symFull + ' on Gate.io');
    CH.data = b; CH.sym = symFull; CH.tf = tf; CH.sel = null;
    const d = digitsFor(b.c[b.c.length - 1]);
    CH.chart.setBars(b, d, `<b>${esc(short(symFull))}</b> · ${esc(tf)} · ${esc(ov === 'claude' ? 'Claude' : ov === 'bot' ? 'VPS bot' : ov)}`);
    CH.chart.setEmas(b, [ema(b.c, 20), ema(b.c, 50), ema(b.c, 200)]);
    computeOverlay(ov);
    drawOverlay();
    if (CH.focusAt) { CH.chart.focus(CH.focusAt, null, 60); const t = CH.trades.find(x => Math.abs(x.tIn - CH.focusAt) < tfSec(tf)); if (t) selectTrade(t); CH.focusAt = null; }
    else CH.chart.showRecent(tf === '5m' ? 220 : 160);
  } catch (e) {
    $('#chSetup').innerHTML = `<div class="err">Could not load ${esc(symFull)} ${esc(tf)}: ${esc(e.message || e)}</div>`;
  }
}
function ensureChartOnly() { if (!CH.chart) CH.chart = makeChart($('#chBox'), { height: Math.max(380, Math.min(560, window.innerHeight - 260)) }); }
function computeOverlay(ov) {
  const b = CH.data, tf = CH.tf;
  CH.trades = []; CH.live = null; CH.ovName = ov; CH.liveWhy = null;
  if (ov === 'none') return;
  if (ov === 'bot') {
    const rec = SNAP?.bot?.[CH.sym];
    CH.botInfo = rec || null;
    if (rec) CH.trades = rec.trades.map(([tIn, tOut, side, ep, xp, reason, bp, strat, open]) => ({ sym: CH.sym, tIn, tOut, side, ep, xp, reason, bp, strat, open: !!open, sl: NaN, tp: NaN, tp1: NaN, net: bp / 1e4, bot: true }));
    return;
  }
  const S = STRATEGIES[ov]; if (!S) return;
  const params = ov === $('#btStrat').value ? readParams() : {};
  const p = { ...S.params, ...params };
  const sig = maskForming(S.signals(b, p, { tfMin: TF_MIN[tf] || 60 }), b);
  const res = run(b, sig, {});
  CH.trades = flatTrades(CH.sym, b, res.trades, tf);
  CH.live = res.live;
  CH.liveWhy = ov === 'claude' && res.live.pending ? sig.why[res.live.pending.sigBar] : ov === 'claude' && res.live.position ? sig.why[res.live.position.sigBar] : null;
}
function barTime(t) { const sec = tfSec(CH.tf); return Math.floor(t / sec) * sec; }
function drawOverlay() {
  const b = CH.data, C = { up: '#7EE08A', down: '#FF7A6B', lime: '#D9FF57', warn: '#FFC857' };
  const mk = [], first = b.t[0], lastT = b.t[b.t.length - 1];
  for (const x of CH.trades) {
    if (x.tIn < first || x.tIn > lastT + tfSec(CH.tf)) continue;
    mk.push({ time: toChartTime(barTime(x.tIn)), position: x.side === 1 ? 'belowBar' : 'aboveBar', color: x.side === 1 ? C.lime : C.warn, shape: x.side === 1 ? 'arrowUp' : 'arrowDown', text: x.side === 1 ? 'L' : 'S' });
    if (!x.open) mk.push({ time: toChartTime(barTime(Math.min(x.tOut - (x.bot ? 0 : tfSec(CH.tf)), lastT))), position: x.side === 1 ? 'aboveBar' : 'belowBar', color: x.bp >= 0 ? C.up : C.down, shape: 'circle', text: sgn(x.bp, 0) });
  }
  CH.chart.setMarkers(mk);
  const lines = [], boxes = [];
  const lv = CH.live?.position || CH.live?.pending;
  if (lv) {
    const en = lv.price ?? lv.ep, t0 = b.t[lv.sigBar >= 0 ? lv.sigBar : lv.ei] ?? b.t[b.t.length - 1];
    lines.push({ price: en, color: C.lime, title: CH.live.position ? 'Entry (filled)' : 'Entry limit', width: 2, style: 0 });
    const sl0 = lv.sl0 ?? lv.sl;
    lines.push({ price: lv.sl, color: C.down, title: lv.tp1Hit && lv.sl !== sl0 ? 'Stop (break-even)' : 'Stop', width: 2, style: 0 });
    if (lv.tp1 === lv.tp1) lines.push({ price: lv.tp1, color: C.up, title: 'TP1 ½', style: 2 });
    if (lv.tp === lv.tp) lines.push({ price: lv.tp, color: C.up, title: 'TP2', width: 2, style: 0 });
    if (lv.tp === lv.tp && sl0 === sl0) boxes.push({ t0, entry: en, sl: sl0, tp: lv.tp, tp1: lv.tp1 === lv.tp1 ? lv.tp1 : null,
      label: `${lv.side === 1 ? 'LONG' : 'SHORT'} · ${n2(Math.abs(lv.tp - en) / Math.abs(en - sl0), 1)}R` });
  }
  if (CH.sel && CH.sel.sl === CH.sel.sl && CH.sel.tp === CH.sel.tp) {
    const x = CH.sel;
    boxes.push({ t0: barTime(x.tIn), t1: barTime(x.tOut - tfSec(CH.tf)) + tfSec(CH.tf), entry: x.ep, sl: x.sl, tp: x.tp, tp1: x.tp1 === x.tp1 ? x.tp1 : null, label: `${x.side === 1 ? 'LONG' : 'SHORT'} ${sgn(x.bp, 0)} bp · ${reasonTxt(x.reason)}` });
  } else if (CH.sel) {
    lines.push({ price: CH.sel.ep, color: C.lime, title: 'Entry', style: 2 }, { price: CH.sel.xp, color: CH.sel.bp >= 0 ? C.up : C.down, title: 'Exit', style: 2 });
  }
  CH.chart.setLines(lines);
  CH.chart.setBoxes(boxes);
  renderChartSide();
}
function sizeCalc(en, sl, tp1, tp, side) {
  const cap = +($('#mCap').value || 100), risk = +($('#mRisk').value || 1), maxLev = +($('#mLev').value || 10);
  const slFrac = Math.abs(en - sl) / en; if (!(slFrac > 0)) return '';
  const lev = Math.max(1, Math.min(maxLev, Math.floor(1 / (1.5 * slFrac + 0.004))));
  const riskUsd = cap * risk / 100, notional = Math.min(riskUsd / slFrac, cap * lev), qty = notional / en, margin = notional / lev;
  const liq = en * (1 - side * Math.max(1 / lev - 0.004, 0));
  const fee = notional * (COSTS.fee_m + COSTS.fee_t);
  const g1 = tp1 === tp1 ? qty * Math.abs(tp1 - en) : NaN, g2 = qty * Math.abs(tp - en);
  const both = tp1 === tp1 ? 0.5 * g1 + 0.5 * g2 : g2;
  return `<h3 style="font-size:15px;margin:12px 0 6px">Position size <span class="dim" style="font:12px var(--body)">— ${money(cap, 0)} capital, ${risk}% risk (Capital sim settings)</span></h3>
    <div class="calc"><span>Quantity</span><span>${qty.toLocaleString('en-US', { maximumFractionDigits: qty < 1 ? 4 : 2 })} ${esc(short(CH.sym))}</span>
    <span>Position value</span><span>${money(notional)}</span><span>Leverage · margin</span><span>${lev}x · ${money(margin)}</span>
    <span>Loss at stop</span><span class="neg">${money(-riskUsd)}</span>
    <span>${tp1 === tp1 ? 'TP1 + TP2 (half each)' : 'Gain at TP'}</span><span class="pos">+${money(both)}</span>
    <span>Fees (approx.)</span><span>${money(fee)}</span><span>Liquidation ≈</span><span>${px(liq, en)}</span></div>`;
}
function renderChartSide() {
  const lv = CH.live?.position || CH.live?.pending, b = CH.data, last = b.c[b.c.length - 1];
  let html = '';
  if (CH.ovName === 'bot') {
    const row = (SNAP?.rows || []).find(r => r.symbol === CH.sym), info = CH.botInfo;
    html = `<h2 class="sec">VPS bot · ${esc(short(CH.sym))}</h2>` + (row ? `<div class="calc">
      <span>State now</span><span><span class="pill st-${esc(row.state)}">${esc(row.state)}</span> ${row.side === 1 ? 'long' : row.side === -1 ? 'short' : ''}</span>
      <span>Today's strategy</span><span class="strat">${esc(row.strategy || '—')} ${esc(row.tf || '')}</span>
      <span>14-day record</span><span class="${cls(row.fwd_avg_bps)}">${row.fwd_trades ?? 0} × ${sgn(row.fwd_avg_bps, 0)} bp</span>
      <span>t-stat</span><span>${sgn(row.fwd_t, 2)}</span><span>Unrealised</span><span class="${cls(row.unreal_bps)}">${sgn(row.unreal_bps, 0)} bp</span></div>
      <p class="note">${info ? `${info.trades.length} trades from the snapshot.` : 'This snapshot has no per-trade record yet (published after the next VPS scan).'} The bot runs on 1-minute data; markers are placed on the nearest candle.</p>`
      : `<div class="muted">${esc(short(CH.sym))} is not in the VPS scan.</div>`);
  } else if (lv) {
    const en = lv.price ?? lv.ep, isPos = !!CH.live.position;
    html = `<h2 class="sec">${CH.ovName === 'claude' ? '✦ Claude' : esc(CH.ovName)} · ${isPos ? 'in trade' : (lv.kind === 'market' ? 'enter at next open' : lv.kind === 'stop' ? 'stop entry' : 'buy limit')}</h2>
      ${levelRows({ ...lv, price: en, tp1: lv.tp1 === lv.tp1 ? lv.tp1 : NaN }, en)}
      <div class="tags" style="margin-top:8px"><span class="tag">price now ${px(last, en)}</span><span class="tag">${lv.side === 1 ? 'long' : 'short'}</span>${isPos ? `<span class="tag">${sgn((last / en - 1) * 100 * lv.side, 2)}% open P&L</span>` : `<span class="tag">valid ${lv.barsLeft} more bar${lv.barsLeft > 1 ? 's' : ''}</span>`}</div>
      ${CH.ovName === 'claude' ? `<ul class="say" style="margin-top:8px">${narrative(CH.sym, { ...CH.live, why: CH.liveWhy }, { ...tokenContext(closed(b), null), price: last }, CL.res?.mkt).map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${lv.tp === lv.tp ? sizeCalc(en, lv.sl0 ?? lv.sl, lv.tp1, lv.tp, lv.side) : ''}`;
  } else if (CH.ovName === 'none') {
    html = '<div class="muted">No overlay. Pick Claude, the VPS bot or a lab strategy to see entries, stops and targets.</div>';
  } else {
    const ctx = tokenContext(closed(b), null); ctx.price = last;
    html = `<h2 class="sec">${CH.ovName === 'claude' ? '✦ Claude' : esc(CH.ovName)} · no live setup</h2>` +
      (CH.ovName === 'claude' ? `<ul class="say">${narrative(CH.sym, {}, ctx, CL.res?.mkt).map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<div class="muted">No open position or pending order on the latest candle.</div>') +
      '<p class="note">Click a past trade on the right/below to draw its entry, stop and target box.</p>';
  }
  $('#chSetup').innerHTML = html;
  const st = stats(CH.trades.filter(x => !x.open));
  $('#chTrades').innerHTML = `<h2 class="sec">${CH.trades.length ? 'Trades on this chart' : 'No trades on this chart'}</h2>
    ${CH.trades.length ? `<div class="calc" style="margin-bottom:8px"><span>Closed trades</span><span>${st.n || 0}</span><span>Avg / trade</span><span class="${cls(st.avg)}">${st.n ? sgn(st.avg, 1) + ' bp' : '—'}</span><span>Win rate</span><span>${st.n ? Math.round(st.win * 100) + '%' : '—'}</span></div>
    <div class="tblwrap" style="max-height:360px;overflow:auto"><table class="tk sm" id="chTradeTbl" style="min-width:0">
    <thead><tr><th class="l">Entry (WIB)</th><th class="l">Side</th><th>Entry</th><th>Exit</th><th>bp</th></tr></thead><tbody>
    ${[...CH.trades].sort((a, b) => b.tIn - a.tIn).map((x, i) => `<tr data-t="${x.tIn}"><td class="l">${fmtWib(x.tIn)}</td><td class="l side-${x.side}">${x.side === 1 ? 'L' : 'S'}</td><td>${px(x.ep)}</td><td>${x.open ? 'open' : px(x.xp, x.ep)}</td><td class="${cls(x.bp)}">${sgn(x.bp, 0)}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="muted">${CH.ovName === 'none' ? '' : 'The strategy found no trades in these candles. Try more candles or another timeframe.'}</div>`}`;
}
function selectTrade(x) { CH.sel = x; drawOverlay(); CH.chart.focus(barTime(x.tIn), barTime(x.tOut), 50); }
$('#chTrades').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-t]'); if (!tr) return;
  const x = CH.trades.find(t => t.tIn === +tr.dataset.t); if (x) selectTrade(x);
});
$('#chLoad').addEventListener('click', loadChart);
['#chSym', '#chTf', '#chOverlay', '#chDepth'].forEach(s => $(s).addEventListener('change', () => { if (s === '#chSym') $('#chCustom').value = ''; loadChart(); }));
$('#chCustom').addEventListener('keydown', e => { if (e.key === 'Enter') loadChart(); });

// ── Backtest ─────────────────────────────────────────────────────────────────────────────────
const BT = { last: null };
const CHOICES = { stop: ['mid', 'far'], days: ['weekdays', 'tue_wed_fri'], target: ['vwap', 'band'] };
function onStratChange() {
  const id = $('#btStrat').value, S = STRATEGIES[id];
  const cur = $('#btTf').value;
  $('#btTf').innerHTML = S.tfs.map(t => `<option ${t === S.tf ? 'selected' : ''}>${t}</option>`).join('');
  if (S.tfs.includes(cur)) $('#btTf').value = cur;
  $('#btStratNote').textContent = `${S.title}${S.src === 'lab' ? ' — ported from scalping-lab (trade-for-trade identical to the Python engine on the same candles).' : ' — researched on 1h candles.'}`;
  const saved = (prefs.params || {})[id] || {};
  $('#btParams').innerHTML = Object.entries(S.params).map(([k, v]) => {
    const val = saved[k] ?? v, help = S.help?.[k] || '';
    if (typeof v === 'string') return `<label class="fld sm" title="${esc(help)}"><span>${esc(k)}</span><select data-p="${esc(k)}">${(CHOICES[k] || [v]).map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    return `<label class="fld sm" title="${esc(help)}"><span>${esc(k)}</span><input type="number" data-p="${esc(k)}" value="${esc(val)}" step="any"></label>`;
  }).join('');
}
function readParams() {
  const id = $('#btStrat').value, S = STRATEGIES[id], p = {};
  $$('#btParams [data-p]').forEach(el => { const k = el.dataset.p; p[k] = typeof S.params[k] === 'string' ? el.value : +el.value; });
  return p;
}
$('#btStrat').addEventListener('change', onStratChange);
$('#btParams').addEventListener('change', () => { const id = $('#btStrat').value; prefs.params = { ...(prefs.params || {}), [id]: readParams() }; savePrefs(); });
$('#btReset').addEventListener('click', () => { const id = $('#btStrat').value; if (prefs.params) delete prefs.params[id]; savePrefs(); onStratChange(); $('#btFeeT').value = 5; $('#btFeeM').value = 2; $('#btSlip').value = 1; });
const costs = () => ({ fee_t: +$('#btFeeT').value / 1e4, fee_m: +$('#btFeeM').value / 1e4, slip: +$('#btSlip').value / 1e4 });
function openBacktest(sym, strat, tf) {
  $('#btSym').value = sym; $('#btStrat').value = strat; onStratChange(); if (tf) $('#btTf').value = tf;
  showTab('backtest'); runBacktest();
}
async function runOne(sym, id, tf, depth, params, cost) {
  const b = await candles(sym, tf, depth, 120e3), S = STRATEGIES[id];
  const p = { ...S.params, ...params };
  const sig = maskForming(S.signals(b, p, { tfMin: TF_MIN[tf] || 60 }), b);
  const res = run(b, sig, cost);
  return { sym, b, trades: flatTrades(sym, b, res.trades, tf), live: res.live };
}
async function runBacktest() {
  const id = $('#btStrat').value, tf = $('#btTf').value, depth = +$('#btDepth').value, symSel = $('#btSym').value;
  const syms = symSel === '__ALL__' ? SYMS() : [symSel], params = readParams(), cost = costs();
  const btn = $('#btRun'); btn.disabled = true; btn.textContent = 'Running…';
  try {
    progress('#btProg', 0, syms.length);
    const out = await pool(syms, 4, s => runOne(s, id, tf, depth, params, cost), (d, t) => progress('#btProg', d, t));
    const ok = out.filter(x => x && !x.error), all = ok.flatMap(x => x.trades);
    const span = ok.length ? [Math.min(...ok.map(x => x.b.t[0])), Math.max(...ok.map(x => x.b.t[x.b.t.length - 1]))] : [0, 0];
    BT.last = { id, tf, depth, syms, ok, all, span, params, label: `${id === 'claude' ? 'Claude' : id} · ${tf} · ${symSel === '__ALL__' ? syms.length + ' tokens' : short(symSel)}` };
    renderBacktest();
    refreshMoneySources();
  } catch (e) { $('#btOut').innerHTML = `<div class="empty err">Backtest failed: ${esc(e.message || e)}</div>`; }
  finally { btn.disabled = false; btn.textContent = 'Run backtest'; progress('#btProg', 1, 1); }
}
function renderBacktest() {
  const r = BT.last, st = stats(r.all), days = (r.span[1] - r.span[0]) / 86400;
  const perTok = r.ok.map(x => ({ sym: x.sym, st: stats(x.trades) })).sort((a, b) => (b.st.avg || -1e9) - (a.st.avg || -1e9));
  const mid = r.span[0] + (r.span[1] - r.span[0]) / 2;
  const h1 = stats(r.all.filter(x => x.tIn < mid)), h2 = stats(r.all.filter(x => x.tIn >= mid));
  $('#btOut').innerHTML = `
    <div class="card"><h2 class="sec">${esc(r.label)} <span class="dim" style="font:13px var(--body)">· ${n2(days, 0)} days · ${fmtWib(r.span[0])} → ${fmtWib(r.span[1])} WIB</span></h2>
      ${statTiles(st, [['Trades / day', n2(st.n / Math.max(1, days), 2), ''], ['1st half avg', h1.n ? sgn(h1.avg, 1) + ' bp' : '—', h1.avg >= 0 ? 'good' : 'badv'], ['2nd half avg', h2.n ? sgn(h2.avg, 1) + ' bp' : '—', h2.avg >= 0 ? 'good' : 'badv']])}
      <div class="chartbox" id="btEq"></div>
      <div class="ctrls" style="margin:12px 0 0"><button class="btn pri" id="btToMoney" type="button">Simulate capital with these trades →</button>${r.syms.length === 1 ? `<button class="btn" id="btToChart" type="button">Show on chart</button>` : ''}</div>
      <p class="note">Net of fees and slippage. Simulated on ${esc(r.tf)} candles (the lab uses a 1-minute grid, so exits can differ slightly). Half-by-half averages: an edge should hold in both.</p></div>
    ${r.syms.length > 1 ? `<div class="card"><h2 class="sec">Per token</h2><div class="tblwrap"><table class="tk sm"><thead><tr><th class="l">Token</th><th>Trades</th><th>Win</th><th>Avg bp</th><th>Total bp</th><th>t</th><th>PF</th></tr></thead><tbody>
      ${perTok.map(x => `<tr data-sym="${esc(x.sym)}"><td class="l"><span class="sym">${esc(short(x.sym))}</span></td><td>${x.st.n || 0}</td><td>${x.st.n ? Math.round(x.st.win * 100) + '%' : '—'}</td><td class="${cls(x.st.avg)}">${x.st.n ? sgn(x.st.avg, 1) : '—'}</td><td class="${cls(x.st.sum)}">${x.st.n ? sgn(x.st.sum, 0) : '—'}</td><td>${x.st.n ? n2(x.st.t, 2) : '—'}</td><td>${x.st.n ? (isFinite(x.st.pf) ? n2(x.st.pf, 2) : '∞') : '—'}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
    <div class="card"><h2 class="sec">Trades <span class="dim" style="font:13px var(--body)">(latest 200; click to view on the chart)</span></h2><div class="tblwrap"><table class="tk sm" id="btTrades">${tradeHead}<tbody>${tradeRows(r.all)}</tbody></table></div></div>`;
  BT.eq?.destroy(); BT.eq = makeLineChart($('#btEq'), { height: 240 });
  BT.eq.set(equityPoints(r.all));
  $('#btToMoney').addEventListener('click', () => { $('#mSrc').value = 'bt'; showTab('money'); });
  $('#btToChart')?.addEventListener('click', () => openChart(r.syms[0], { overlay: r.id, tf: r.tf }));
}
$('#btOut').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-sym]'); if (!tr || !BT.last) return;
  if (tr.dataset.t) openChart(tr.dataset.sym, { overlay: BT.last.id, tf: BT.last.tf, at: +tr.dataset.t });
  else { $('#btSym').value = tr.dataset.sym; runBacktest(); }
});
$('#btRun').addEventListener('click', runBacktest);
$('#btCompare').addEventListener('click', async () => {
  const symSel = $('#btSym').value, depth = +$('#btDepth').value, cost = costs();
  const syms = symSel === '__ALL__' ? SYMS() : [symSel], ids = Object.keys(STRATEGIES);
  const tfSel = $('#btTf').value;
  const jobs = []; for (const id of ids) { const S = STRATEGIES[id]; const tf = S.tfs.includes(tfSel) ? tfSel : S.tf; for (const s of syms) jobs.push({ id, tf, s }); }
  const btn = $('#btCompare'); btn.disabled = true; btn.textContent = 'Comparing…';
  try {
    progress('#btProg', 0, jobs.length);
    const out = await pool(jobs, 4, j => runOne(j.s, j.id, j.tf, depth, {}, cost).then(r => ({ ...j, trades: r.trades, b: r.b })), (d, t) => progress('#btProg', d, t));
    const rows = ids.map(id => {
      const mine = out.filter(x => x && !x.error && x.id === id), all = mine.flatMap(x => x.trades);
      const span = mine.length ? (Math.max(...mine.map(x => x.b.t[x.b.t.length - 1])) - Math.min(...mine.map(x => x.b.t[0]))) / 86400 : 0;
      return { id, tf: mine[0]?.tf || STRATEGIES[id].tf, st: stats(all), days: span };
    }).sort((a, b) => (b.st.n ? b.st.avg : -1e9) - (a.st.n ? a.st.avg : -1e9));
    $('#btOut').innerHTML = `<div class="card"><h2 class="sec">All strategies · ${esc(symSel === '__ALL__' ? syms.length + ' tokens' : short(symSel))} <span class="dim" style="font:13px var(--body)">· default parameters · net of costs</span></h2>
      <div class="tblwrap"><table class="tk sm"><thead><tr><th class="l">Strategy</th><th class="l">TF</th><th>Days</th><th>Trades</th><th>Win</th><th>Avg bp</th><th>Total bp</th><th>t</th><th>PF</th><th>Max DD bp</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td class="l">${r.id === 'claude' ? '✦ <b>Claude</b>' : `<span class="strat">${esc(r.id)}</span>`}</td><td class="l">${esc(r.tf)}</td><td>${n2(r.days, 0)}</td><td>${r.st.n || 0}</td><td>${r.st.n ? Math.round(r.st.win * 100) + '%' : '—'}</td>
        <td class="${cls(r.st.avg)}">${r.st.n ? sgn(r.st.avg, 1) : '—'}</td><td class="${cls(r.st.sum)}">${r.st.n ? sgn(r.st.sum, 0) : '—'}</td><td>${r.st.n ? n2(r.st.t, 2) : '—'}</td><td>${r.st.n ? (isFinite(r.st.pf) ? n2(r.st.pf, 2) : '∞') : '—'}</td><td class="neg">${r.st.n ? sgn(r.st.maxdd, 0) : '—'}</td>
        <td><button class="btn sm" data-use="${esc(r.id)}" data-tf="${esc(r.tf)}">Use</button></td></tr>`).join('')}
      </tbody></table></div><p class="note">Short timeframes cover fewer days (Gate serves the latest 10 000 candles: 5m ≈ 35 days, 15m ≈ 104 days, 1h ≈ 416 days). Ranked by average net bp per trade — check trades and t-stat before trusting a row.</p></div>`;
  } catch (e) { $('#btOut').innerHTML = `<div class="empty err">Compare failed: ${esc(e.message || e)}</div>`; }
  finally { btn.disabled = false; btn.textContent = 'Compare all strategies'; progress('#btProg', 1, 1); }
});
$('#btOut').addEventListener('click', e => {
  const u = e.target.closest('[data-use]'); if (!u) return;
  $('#btStrat').value = u.dataset.use; onStratChange(); $('#btTf').value = u.dataset.tf; runBacktest();
});

// ── Capital sim ──────────────────────────────────────────────────────────────────────────────
function refreshMoneySources() {
  const cur = $('#mSrc').value, opts = [];
  if (CL.res) opts.push(['claude', `✦ Claude scan — ${CL.res.all.filter(x => !x.open).length} trades`]);
  if (BT.last) opts.push(['bt', `Backtest — ${BT.last.label} (${BT.last.all.filter(x => !x.open).length})`]);
  $('#mSrc').innerHTML = opts.length ? opts.map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('') : '<option value="">— run a scan or backtest —</option>';
  if (opts.some(o => o[0] === cur)) $('#mSrc').value = cur;
  if ($('#pane-money').classList.contains('on')) renderMoney();
}
function moneyCfg() {
  return { capital: +$('#mCap').value || 100, mode: $('#mMode').value, riskPct: +$('#mRisk').value || 1, marginPct: +$('#mMargin').value || 10,
    leverage: Math.max(1, +$('#mLev').value || 1), maxPos: Math.max(1, +$('#mPos').value || 1), dailyLoss: +$('#mDl').value || 0,
    dailyTarget: +$('#mDt').value || 0, compound: $('#mComp').checked, autoLev: $('#mAuto').checked };
}
let mEq = null;
function renderMoney() {
  const risk = $('#mMode').value === 'risk';
  $('#mRiskF').style.display = risk ? '' : 'none'; $('#mAutoF').style.display = risk ? '' : 'none'; $('#mMarginF').style.display = risk ? 'none' : '';
  const src = $('#mSrc').value, trades = src === 'claude' ? CL.res?.all : src === 'bt' ? BT.last?.all : null;
  if (!trades) { mEq?.destroy(); mEq = null; $('#mOut').innerHTML = '<div class="empty">Run <b>Scan with Claude</b> or a <b>Backtest</b> first — their trades feed this simulation.</div>'; return; }
  const cfg = moneyCfg(), m = simulateMoney(trades, cfg);
  const span = m.taken.length ? (Math.max(...m.taken.map(x => x.tOut)) - Math.min(...m.taken.map(x => x.tIn))) / 86400 : 0;
  const tiles = [
    ['Final balance', money(m.final), m.final >= cfg.capital ? 'good' : 'badv'], ['Return', pct(m.ret * 100), m.ret >= 0 ? 'good' : 'badv'],
    ['Max drawdown', pct(m.maxdd * 100), 'badv'], ['Trades taken', m.taken.length, ''], ['Skipped (slots/margin)', m.skipped, ''],
    ['Skipped (daily limit)', m.skippedDay, ''], ['Liquidations', m.liq, m.liq ? 'badv' : 'good'], ['Green / red days', `${m.winDays} / ${m.lossDays}`, ''],
    ['Span', n2(span, 0) + ' days', ''],
  ];
  const warns = [];
  if (m.ruined) warns.push('The balance fell below 1% of the start — account blown. Lower the margin/leverage.');
  if (m.liq) warns.push(`${m.liq} trade${m.liq > 1 ? 's were' : ' was'} counted as liquidated: the worst price of the bars it was open (incl. its stop bar) reached the liquidation distance. Conservative — a stop that fills in time saves you — but it is what a gap through the stop costs. Lower the leverage.`);
  if (m.maxdd < -0.3) warns.push('Drawdown deeper than 30% — most people abandon a system there. Consider half the size.');
  if (cfg.mode === 'margin' && cfg.marginPct * cfg.leverage > 300) warns.push(`Each position is ${cfg.marginPct * cfg.leverage}% of the balance — one bad flush can erase days of gains.`);
  mEq?.destroy(); mEq = null;
  const ledger = [...m.taken].sort((a, b) => b.tOut - a.tOut).slice(0, 150);
  $('#mOut').innerHTML = `
    <div class="card"><div class="stats">${tiles.map(([k, v, c]) => `<div class="stat ${c}"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>
      ${warns.length ? `<div class="warn-banner" style="margin:0 0 12px">${warns.map(esc).join('<br>')}</div>` : ''}
      <div class="chartbox" id="mEq"></div>
      <p class="note">${cfg.mode === 'risk' ? `Each trade risks ${cfg.riskPct}% of the ${cfg.compound ? 'current' : 'starting'} balance at its stop; position = risk ÷ stop distance, capped at ${cfg.leverage}x${cfg.autoLev ? ' (leverage lowered per trade so liquidation is 1.5× beyond the stop)' : ''}.` : `Each trade uses ${cfg.marginPct}% of the ${cfg.compound ? 'current' : 'starting'} balance as margin at ${cfg.leverage}x.`} Max ${cfg.maxPos} open at once; extra signals are skipped.</p></div>
    <div class="card"><h2 class="sec">Ledger <span class="dim" style="font:13px var(--body)">(latest 150 · click a row for its chart)</span></h2><div class="tblwrap" style="max-height:520px;overflow:auto"><table class="tk sm">
      <thead><tr><th class="l">Exit (WIB)</th><th class="l">Token</th><th class="l">Side</th><th>Lev</th><th>Margin</th><th>Position</th><th>Net bp</th><th>P&L</th><th class="l">Note</th></tr></thead><tbody>
      ${ledger.map(x => `<tr data-sym="${esc(x.sym)}" data-t="${x.tIn}" data-tf="${esc(x.tf || '')}"><td class="l">${fmtWib(x.tOut)}</td><td class="l"><span class="sym">${esc(short(x.sym))}</span></td><td class="l side-${x.side}">${x.side === 1 ? 'long' : 'short'}</td>
        <td>${n2(x.lev, 0)}x</td><td>${money(x.margin)}</td><td>${money(x.notional)}</td><td class="${cls(x.bp)}">${sgn(x.bp, 0)}</td><td class="${cls(x.pnl)}">${money(x.pnl)}</td><td class="l ${x.liq ? 'neg' : 'dim'}">${x.liq ? 'liquidated' : esc(reasonTxt(x.reason))}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  mEq = makeLineChart($('#mEq'), { height: 260, money: true });
  mEq.set(m.curve.map(p => ({ t: p.t, v: p.bal })), cfg.capital);
}
$('#mOut').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-sym]'); if (!tr) return;
  const src = $('#mSrc').value, ov = src === 'claude' ? 'claude' : BT.last?.id || 'claude';
  openChart(tr.dataset.sym, { overlay: ov, tf: tr.dataset.tf || '1h', at: +tr.dataset.t });
});
['#mSrc', '#mCap', '#mMode', '#mRisk', '#mMargin', '#mLev', '#mPos', '#mDl', '#mDt', '#mComp', '#mAuto'].forEach(s => {
  bindPref(s, 'm' + s.slice(2), $(s).type === 'checkbox' ? 'checked' : 'value');
  $(s).addEventListener('change', () => { renderMoney(); if (CH.data && (CH.live?.pending || CH.live?.position)) renderChartSide(); });
});

// ── research notes (static: numbers from the offline study that chose the rules) ─────────────
$('#researchBody').innerHTML = `
  <p><b>What I looked for.</b> The lab's own history says sub-15-minute edges die on fees, and that most "signals" just ride the market's direction. I checked that first: across 30 Gate.io perps (Sep 2025 → Oct 2026, 1h) the two halves of the year were opposite regimes — almost every long signal won in the second half and lost in the first. So I looked for something that worked in <i>both</i>, for a structural reason, not because the market went up.</p>
  <p><b>What survived.</b> Liquidation flushes that get absorbed: a 1h candle at least 1.5× ATR long, on 1.5× normal volume, that sweeps the 24h low and closes with ≥ 55% lower wick. Forced sellers hit bids; when the candle closes back up, the selling was absorbed. Buying a limit in the lower 40% of that wick, stop just under it, was positive in both halves.</p>
  <table><thead><tr><th>Test (net of 5/2 bp fees + 1 bp slippage)</th><th>Trades</th><th>Avg bp</th><th>Win</th><th>t</th></tr></thead><tbody>
    <tr><td>30 tokens, 1st half (rules chosen here)</td><td>385</td><td class="pos">+43</td><td>58%</td><td>2.4</td></tr>
    <tr><td>30 tokens, 2nd half (untouched while choosing)</td><td>356</td><td class="pos">+25</td><td>56%</td><td>1.9</td></tr>
    <tr><td>Holdout BTC 2021-09 → 2025-08 (Binance)</td><td>146</td><td>+1</td><td>52%</td><td>0.1</td></tr>
    <tr><td>Holdout ETH 2021-09 → 2025-08 (Binance)</td><td>149</td><td class="neg">−22</td><td>44%</td><td>−1.9</td></tr>
    <tr><td>Mirrored short (squeeze fade), 2nd half</td><td>127</td><td class="neg">−135</td><td>46%</td><td>−3.1</td></tr>
  </tbody></table>
  <p><b>What failed on the way</b> (so you don't have to retry them): trend pullbacks to EMA 20 (−10 bp both halves), regime-filtered impulse follow (≈ 0), short squeezes even with a BTC bear filter (−135 bp out-of-sample).</p>
  <p><b>Honest verdict.</b> Positive on alts in both halves, but the BTC/ETH holdout fails, October 2025's crash supplies about a third of the profit, and small flushes (stop under 150 bp) barely cover costs. Capital sim on the whole year with 1% risk per trade and 3 slots: +33% with a −26% drawdown; with 30% margin × 50x the account blows up. Treat it as a paper-trading hypothesis. The engine, rules and numbers are all in <span class="mono">scanner/lab/</span>.</p>`;

// ── boot ─────────────────────────────────────────────────────────────────────────────────────
(async () => {
  let pw = ''; try { pw = sessionStorage.getItem('agz_bb_pw') || ''; } catch (_) { }
  if (pw) { try { await unlock(pw); return; } catch (_) { try { sessionStorage.removeItem('agz_bb_pw'); } catch (e) { } } }
  $('#pw')?.focus();
})();
