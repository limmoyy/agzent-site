// liqxm desk — public page shell (no strategy logic here). The private modules (engine.js, score.js and, when built,
// backtest.js) arrive encrypted and are loaded by loader.js after the passphrase is checked; this file only handles the
// gate, live data, preferences, rendering and chart drawing of what score.js returns.
import { decryptEngine, loadModules } from './loader.js?v=20261119e';
import { loadMarket, INSTR, TF_SEC, sessionOf, etClock, nyOffset } from './data.js?v=20261119e';
import { makeChart } from './chart.js?v=20261119e';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PW_KEY = 'agz_liqxm_pw', PREFS_KEY = 'agz_liqxm_prefs';
const CHART_TFS = ['15m', '5m', '3m', '1m', '15s', '10s', '1s'];
const MODEL_IDS = ['market', 'fvg', 'ob'];
const MODEL_NAME = { market: 'Market', fvg: 'Limit FVG', ob: 'Limit OB' };
const ROLE = { exec: 'EXEC', htf: 'HTF', ltf: 'LTF', info: 'info' };
const UI_DEF = { auto: true, notify: false, notifyMin: 65, layers: { fvg: true, liq: true, ob: true, sweep: true, pend: true, bt: true } };
const URL_LIMIT = 5900;   // claude.ai/new?q= … stays under 6 KB
const MAX_SHOW = 50;      // FVGs drawn per chart (Pine maxShow)

const st = {
  S: null, B: null, ver: null,          // decrypted modules: score.js, backtest.js (optional)
  raw: {}, ui: { ...UI_DEF }, newsUntil: 0,
  market: null, mInfo: null, ctx: null, ckey: '', R: null, err: null, loadMs: 0, anaMs: 0,
  busy: false, again: false, timer: null, nextAt: 0,
  tab: 'setup', sel: null, chart: null, chartTf: null, chartDirty: true, chartTfShown: null,
  notified: new Set(), nScope: '', bt: null, btBusy: false, btPct: 0, btModel: null, btTrade: null, btAll: false,
  lastExec: null, whyOpen: new Map(),
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── small formatting helpers ────────────────────────────────────────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
function wib(t, secs = false, date = false) {
  if (t == null || !isFinite(t)) return '—';
  const d = new Date((t + 7 * 3600) * 1000), mon = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return (date ? `${d.getUTCDate()} ${mon[d.getUTCMonth()]} ` : '') + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + (secs ? ':' + pad2(d.getUTCSeconds()) : '');
}
const nyHm = t => { const d = new Date((t + nyOffset(t) * 3600) * 1000); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); };
const sameDayWib = (a, b) => Math.floor((a + 7 * 3600) / 86400) === Math.floor((b + 7 * 3600) / 86400);
const r1 = x => x == null || !isFinite(x) ? '—' : String(Math.round(x * 10) / 10);
const pts = x => Number.isInteger(x) ? String(x) : (Math.round(x * 10) / 10).toFixed(1);
const usd = x => x == null || !isFinite(x) ? '—' : '$' + (Math.round(x * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function pxf(R) { const d = R.inst.digits, off = R.broker.offset || 0; return x => x == null || !isFinite(x) ? '—' : (x + off).toFixed(d); }

/** Indonesian text for an error that reaches the user (network / Gate / engine load). */
function errText(e, what) {
  const msg = String(e?.message || e || '');
  if (e?.name === 'TypeError' && /fetch|network|load failed/i.test(msg) || /failed to fetch|networkerror|load failed|network request failed/i.test(msg))
    return `${what === 'gate' ? 'Gagal menghubungi Gate' : 'Gagal memuat engine'} — cek koneksi/VPN.`;
  const code = (msg.match(/HTTP (\d{3})/) || [])[1];
  if (what === 'gate' && (code === '429' || /too_many|rate limit/i.test(msg))) return 'Gate membatasi request (429) — tunggu sebentar, nanti dicek ulang otomatis.';
  if (what === 'gate' && code) return `Gate menjawab error ${code} — coba lagi sebentar lagi.`;
  return (what === 'gate' ? 'Gagal ambil data Gate: ' : 'Gagal membuka: ') + msg;
}
const wrongPw = err => err?.name === 'OperationError' || /decrypt|operation/i.test(String(err?.message));

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2200);
}
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); return true; } catch (_) { }
  try {
    const ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (_) { return false; }
}

/** Clipboard blocked (permission / old browser): show the text selected so it can be copied by hand. */
function copyDialog(txt) {
  let m = $('#copyModal');
  if (!m) {
    m = document.createElement('div'); m.id = 'copyModal'; m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    m.innerHTML = '<div class="mbox"><h3>Salin manual</h3><p class="small muted">Browser menolak akses clipboard. Teks sudah terpilih — tekan Ctrl+C / ⌘C (atau tahan lalu Salin di HP).</p><textarea readonly></textarea><div class="acts"><button type="button" class="btn sm">Tutup</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m || e.target.closest('button')) m.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') m.hidden = true; });
  }
  const ta = m.querySelector('textarea'); ta.value = txt; m.hidden = false; ta.focus(); ta.select();
}

// ── gate ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function unlock(pw) {
  const payload = await decryptEngine(pw);
  const mods = await loadModules(payload, { optional: ['backtest.js'] });
  if (!mods.mods['score.js']) throw new Error('Build engine belum lengkap (score.js tidak ada).');
  st.S = mods.mods['score.js']; st.B = mods.mods['backtest.js'] || null; st.ver = mods.ver;
  st.btErr = (mods.errors || {})['backtest.js'] || null;
  $('#gate').remove(); $('#app').hidden = false;
  if (st.S.RUBRIC && st.S.RUBRIC.tagline) $('#appSub').textContent = st.S.RUBRIC.tagline;
  start();
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#pw').value;
  if (!pw) { $('#gateErr').textContent = 'Isi passphrase dulu.'; $('#pw').focus(); return; }
  $('#gateBtn').disabled = true; $('#gateErr').textContent = '';
  try { await unlock(pw); try { sessionStorage.setItem(PW_KEY, pw); } catch (_) { } }
  catch (err) { $('#gateErr').textContent = wrongPw(err) ? 'Passphrase salah.' : errText(err, 'engine'); }
  finally { const b = $('#gateBtn'); if (b) b.disabled = false; }
});
$('#lockBtn').addEventListener('click', () => { try { sessionStorage.removeItem(PW_KEY); } catch (_) { } location.reload(); });

// ── preferences (localStorage agz_liqxm_prefs; the news flag is session-only and expires after 30 minutes) ─────────────
function loadPrefs() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (_) { o = {}; }
  const { ui, news, ...raw } = o && typeof o === 'object' ? o : {};
  st.raw = raw;
  st.ui = { ...UI_DEF, ...(ui || {}), layers: { ...UI_DEF.layers, ...((ui && ui.layers) || {}) } };
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...st.raw, ui: st.ui })); } catch (_) { }
}
const newsOn = () => st.newsUntil > Date.now() / 1000;
function prefs() { return st.S.resolvePrefs({ ...st.raw, news: newsOn() }); }
function getPath(o, path) { return path.split('.').reduce((a, k) => a == null ? undefined : a[k], o); }
function setPath(o, path, v) {
  const ks = path.split('.'); let a = o;
  for (const k of ks.slice(0, -1)) { if (!a[k] || typeof a[k] !== 'object') a[k] = {}; else a[k] = { ...a[k] }; a = a[k]; }
  if (v === undefined) delete a[ks.at(-1)]; else a[ks.at(-1)] = v;
}
function setPref(path, v, { now = false } = {}) {
  setPath(st.raw, path, v); savePrefs(); syncControls(); syncForms();
  clearTimeout(setPref.h);
  if (now) recompute(); else setPref.h = setTimeout(recompute, 350);
}

// ── data + analysis ────────────────────────────────────────────────────────────────────────────────────────────────────
const srcOf = P => P.source || INSTR[P.instrument].source;
function marketFits(P) {
  const i = st.mInfo, m = st.market;
  return !!m && i.inst === P.instrument && i.src === srcOf(P) && i.min === P.tradeMinutes && (P.execTf === '1m' || !!m.bars['15m']);
}
async function check() {
  if (st.busy) { st.again = true; return; }
  st.busy = true; setBusy(true);
  const P = prefs();
  try {
    const t0 = performance.now();
    const m = await loadMarket(P.instrument, { source: srcOf(P), tradeMinutes: P.tradeMinutes, extra: P.execTf === '1m' ? [] : ['15m'] });
    st.loadMs = Math.round(performance.now() - t0);
    st.market = m; st.mInfo = { inst: P.instrument, src: srcOf(P), min: P.tradeMinutes };
    st.ctx = null; st.err = null;
    analyzeNow();
  } catch (e) {
    st.err = errText(e, 'gate');
    renderStatus(); renderNotes(); renderCards();          // cards turn "data basi" once the last bar is > 2 bars old
  } finally {
    st.busy = false; setBusy(false); schedule();
    if (st.again) { st.again = false; recompute(); }
  }
}
function recompute() {
  if (!st.S) return;
  const P = prefs();
  if (!marketFits(P)) { check(); return; }
  analyzeNow();
}
function analyzeNow() {
  const m = st.market; if (!m) return;
  const P = prefs();
  const ck = JSON.stringify([m.now, P.execTf, P.engine, P.secRefNonZero]);
  const t0 = performance.now();
  try {
    if (!st.ctx || st.ckey !== ck) { st.ctx = st.S.prepare(m, P); st.ckey = ck; st.prepMs = Math.round(performance.now() - t0); }
    const t1 = performance.now();
    st.R = st.S.analyze(m, P, undefined, { ctx: st.ctx });
    st.anaMs = Math.round(performance.now() - t1);
    st.err = null;
  } catch (e) { st.R = null; st.err = 'Analisa gagal: ' + (e?.message || e); }
  if (st.R && st.lastExec !== st.R.exec.tf) { if (st.lastExec) st.chartTf = null; st.lastExec = st.R.exec.tf; }
  if (st.sel && st.R && !findSel(st.sel)) st.sel = null;
  if (!st.sel && st.R && st.R.setups.length) st.sel = st.R.setups[0].key;
  st.chartDirty = true;
  renderAll();
  notifyNew();
}
/** Why the live result on screen can no longer be trusted (null = fine): the same veto score.js applies at analysis time
 *  (last exec bar > 2 bars old, market closed), re-checked every second against the clock — a failed refresh keeps the
 *  old result, which must not keep looking live. */
function staleWhy(R = st.R) {
  if (!R || !R.live || !R.exec.marketOpen) return null;          // closed at analysis time: score.js already vetoed
  const now = Date.now() / 1000, sec = R.exec.sec || TF_SEC[R.exec.tf] || 60;
  if (!etClock(now).open) return 'Market sudah tutup sejak data terakhir';
  const age = now - R.exec.lastBar.closeT;
  if (age > 2 * sec) return `Data basi — candle ${R.exec.tf} terakhir tutup ${wib(R.exec.lastBar.closeT)} WIB (${Math.floor(age / sec)} candle lalu)`;
  return null;
}
const shownScore = s => staleWhy() ? { score: 0, label: 'basi' } : { score: s.score, label: s.label };
function findSel(key) {
  const R = st.R; if (!R || !key) return null;
  const s = R.setups.find(x => x.key === key); if (s) return { kind: 'setup', s };
  const p = R.pending.find(x => x.key === key); if (p) return { kind: 'pending', s: p };
  return null;
}

// ── auto re-check: ~5 s after every exec-bar close (every 5 minutes while the market is closed) ───────────────────────
function schedule() {
  clearTimeout(st.timer); st.nextAt = 0;
  if (!st.ui.auto || !st.S) { tickCountdown(); return; }
  const now = Date.now() / 1000, sec = TF_SEC[prefs().execTf] || 60;
  let next = Math.floor(now / sec) * sec + sec + 5;
  if (!etClock(now).open) next = now + 300;
  if (next - now < 2) next += sec;
  st.nextAt = next;
  st.timer = setTimeout(() => check(), (next - now) * 1000);
  tickCountdown();
}
function tickCountdown() {
  const el = $('#autoCd'); if (!el) return;
  if (st.busy) { el.textContent = '· memuat…'; return; }
  if (!st.ui.auto || !st.nextAt) { el.textContent = ''; return; }
  const s = Math.max(0, Math.round(st.nextAt - Date.now() / 1000));
  el.textContent = `· berikutnya ${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st.ui.auto && st.nextAt && Date.now() / 1000 > st.nextAt + 3 && !st.busy) check();
});

// ── desktop notification for new setups above the threshold ───────────────────────────────────────────────────────────
function notifyNew() {
  const R = st.R; if (!R) return;
  const min = +st.ui.notifyMin || 65;
  const scope = [R.inst.id, R.exec.tf, R.source, R.prefs.entry].join('|');
  const hits = R.setups.filter(s => s.score >= min);
  if (st.nScope !== scope) { st.nScope = scope; st.notified = new Set(hits.map(s => s.key)); return; }
  const fresh = hits.filter(s => !st.notified.has(s.key));
  for (const s of fresh) st.notified.add(s.key);
  if (!fresh.length || !st.ui.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const px = pxf(R);
  for (const s of fresh.slice(0, 3)) {
    const m = s.models[R.prefs.entry];
    try {
      const n = new Notification(`liqxm ${R.inst.name} ${s.dir.toUpperCase()} ${s.tf} · skor ${s.score} (${s.label})`, {
        body: m.ok ? `${m.name}: entry ${px(m.entry)} · SL ${px(m.sl)} · TP ${px(m.tp)} · lot ${m.lot.toFixed(2)}` : `grade ${s.grade} · ${m.name} tidak bisa: ${m.why}`,
        tag: s.key,
      });
      n.onclick = () => { window.focus(); st.sel = s.key; showTab('setup'); renderCards(); };
    } catch (_) { }
  }
}

// ── rendering ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function renderAll() {
  renderLadder(); renderNotes(); renderCards(); renderPending(); renderSelect(); renderStatus(); renderClock();
  if (st.bt && !st.btBusy && btStaleKey() !== st.btStaleShown) renderBacktest(st.bt.stats);   // refresh the "hasil ini untuk …" banner
  if (st.tab === 'chart') renderChart();
  syncControls();
}
function setBusy(b) {
  const btn = $('#btnCheck'); btn.disabled = b; btn.textContent = b ? 'Memuat…' : 'Cek sekarang';
  renderStatus(); tickCountdown();
}
function renderStatus() {
  const el = $('#status'), m = st.market, R = st.R, out = [];
  if (st.busy) out.push('<span><span class="spin"></span>Ambil data Gate…</span>');
  if (st.err) out.push(`<span class="err">${esc(st.err)}</span>`);
  if (m && R) {
    out.push(`<span>${esc(R.inst.name)} <b class="mono">${esc(pxf(R)(R.exec.price))}</b> · ${esc(m.contract)}</span>`);
    out.push(`<span class="dim">data ${st.loadMs} ms · engine ${st.prepMs || 0} ms · skor ${st.anaMs} ms</span>`);
  }
  el.innerHTML = out.join('');
}
function renderClock() {
  const now = Date.now() / 1000, k = etClock(now), sess = sessionOf(now);
  const dataT = st.R ? st.R.exec.priceT : st.market ? st.market.now : null;
  $('#clock').innerHTML = `<div class="ck">New York<b>${nyHm(now)}</b></div><div class="ck">WIB<b>${wib(now)}</b></div>` +
    `<div class="ck">Data terakhir<b>${dataT ? wib(dataT, true) : '—'}</b></div>` +
    (k.open ? `<span class="phase open">BUKA · ${esc(sess)}</span>` : '<span class="phase closed">MARKET TUTUP</span>');
  tickCountdown();
  if (st.newsUntil && !newsOn()) { st.newsUntil = 0; syncControls(); recompute(); }
  const sk = staleWhy() || '';
  if (sk.split(' (')[0] !== (st.staleShown || '').split(' (')[0]) { st.staleShown = sk; renderNotes(); renderCards(); renderSelect(); if (st.tab === 'chart') renderChart({ data: false }); }
}

function renderLadder() {
  const R = st.R, el = $('#ladder');
  if (!R) { el.innerHTML = ''; return; }
  el.className = 'ladder' + (R.ladder.length === 6 ? ' n6' : '');
  const now = R.at;
  el.innerHTML = R.ladder.map(x => {
    const bias = !x.available ? '<span class="bias na">– tidak ada data</span>' : x.bias === 'bull' ? '<span class="bias bull">▲ bullish</span>'
      : x.bias === 'bear' ? '<span class="bias bear">▼ bearish</span>' : '<span class="bias netral">· netral</span>';
    const sec = TF_SEC[x.tf] < 60;
    let act = '';
    if (x.available) act = x.role === 'exec' ? `<b>${R.setups.length}</b> setup live · <b>${R.pending.length}</b> pending` : `<b>${x.active}</b> FVG aktif${x.fresh ? ` · ${x.fresh} segar` : ''}`;
    const cov = x.coverage ? `${wib(x.coverage.from, sec, !sameDayWib(x.coverage.from, now))} → ${wib(x.coverage.to, sec)} · ${x.coverage.n.toLocaleString('id-ID')} candle${x.nonZeroRef ? ' · ref≠0' : ''}` : 'tidak tersedia';
    const tip = x.biasFvg ? `FVG ${x.biasFvg.isBull ? 'bullish' : 'bearish'} ${pxf(R)(x.biasFvg.bot)}–${pxf(R)(x.biasFvg.top)}, konfirmasi ${wib(x.biasFvg.confirmT)} WIB` : '';
    return `<button type="button" class="tf ${x.role === 'exec' ? 'exec' : ''} ${x.available ? '' : 'off'}" data-tf="${esc(x.tf)}" title="${esc(tip || 'Buka chart ' + x.tf)}">
      <span class="h"><span class="n">${esc(x.tf)}</span><span class="role ${esc(x.role)}">${ROLE[x.role] || ''}</span></span>
      ${bias}<span class="s">${act}${act ? '<br>' : ''}${esc(cov)}</span></button>`;
  }).join('');
}

function renderNotes() {
  const R = st.R, out = [];
  if (st.err) out.push(`<div class="note-b bad">${esc(st.err)}</div>`);
  const sw = staleWhy();
  if (sw) out.push(`<div class="note-b bad">${esc(sw)} — semua skor dianggap 0 (veto) sampai data baru masuk. Klik “Cek sekarang”.</div>`);
  if (R) {
    for (const n of R.notes) out.push(`<div class="note-b ${/tutup|basi|veto/i.test(n) ? 'warn' : ''}">${esc(n)}</div>`);
    if (R.prefs.news) out.push(`<div class="note-b warn">Flag news high-impact aktif sampai ${wib(st.newsUntil)} WIB — semua skor maksimal 20.</div>`);
    if (R.broker.offset) out.push(`<div class="note-b">Semua harga = harga Gate ${R.broker.offset > 0 ? '+' : '−'} ${Math.abs(R.broker.offset)} (offset broker ${esc(R.inst.id)} di Setelan).</div>`);
  }
  $('#notes').innerHTML = out.join('');
}

const gradeCls = g => g === 'A' ? 'gA' : g === 'B' ? 'gB' : g === 'C' ? 'gC' : '';
const compCls = c => c.na ? 'na' : c.ok ? 'good' : c.pts > 0 ? 'mid' : 'bad';

function renderCards() {
  const R = st.R, el = $('#cards');
  $('#cntSetup').textContent = R ? String(R.setups.length) : '';
  if (!R) { el.innerHTML = `<div class="empty">${st.err ? esc(st.err) : st.busy ? 'Memuat…' : 'Belum ada analisa — klik “Cek sekarang”.'}</div>`; $('#setupSub').textContent = ''; return; }
  const P = R.prefs;
  $('#setupSub').textContent = `konfirmasi ≤ ${P.freshBars} candle ${R.exec.tf} terakhir · dinilai pakai model ${MODEL_NAME[P.entry]} · RR 1:${P.rr}${P.dir !== 'both' ? ' · hanya ' + P.dir : ''}`;
  if (!R.setups.length) {
    el.innerHTML = `<div class="empty">Belum ada setup live di ${esc(R.exec.tf)} ${esc(R.inst.name)} (konfirmasi ≤ ${P.freshBars} candle terakhir).${R.pending.length ? ` Ada ${R.pending.length} kandidat yang menunggu konfirmasi di bawah.` : ''}</div>`;
    return;
  }
  el.innerHTML = R.setups.map((s, i) => cardHtml(R, s, i === 0)).join('');
}

function cardHtml(R, s, first) {
  const px = pxf(R), d = R.inst.digits, sel = st.sel === s.key, stale = staleWhy(), shown = shownScore(s);
  const late = s.liq.late ? 'lanjutan' : 'oranye';
  const hits = s.sweepHits.map(h => `${h.tf} ${h.tp === 2 ? 'liqxm' : 'swing'} ${px(h.px)}`).join('; ');
  const cov = s.ltfCoverage === 'full' ? 'penuh' : s.ltfCoverage === 'partial' ? `sebagian (${s.secCovered.join(', ') || '—'})` : 'tidak ada';
  const moved = R.exec.price != null ? `${px(R.exec.price)} · ${s.movedR >= 0 ? '+' : ''}${r1(s.movedR)}R dari close konfirmasi` : '—';
  // chip = points / full max (same as the breakdown); '*' = part of the component is N/A (title says how much is scoreable)
  const chips = s.components.map(c => `<span class="chip ${compCls(c)}" title="${esc(c.name)} — ${pts(c.pts)} dari ${c.max} poin${c.avail < c.max ? ` · * sebagian data N/A: yang bisa dinilai ${pts(c.avail)} dari ${c.max} poin` : ''}">${c.id} ${pts(c.pts)}/${c.max}${c.avail < c.max ? '*' : ''}</span>`).join('');
  const comps = s.components.map(c => {
    const w = c.max ? Math.max(0, Math.min(100, c.pts / c.max * 100)) : 0, na = c.max ? (c.max - c.avail) / c.max * 100 : 0;
    return `<div class="comp"><div class="ch"><span class="cid ${compCls(c)}">${c.id}</span><span>${esc(c.name)}</span>
      <span class="cpts">${pts(c.pts)}/${c.max}${c.avail < c.max ? ` <span class="dim">(tersedia ${pts(c.avail)})</span>` : ''}</span></div>
      <div class="meter"><i style="width:${w.toFixed(1)}%"></i>${na > 0 ? `<u style="width:${na.toFixed(1)}%"></u>` : ''}</div>
      <ul class="items">${c.items.map(it => `<li><span class="m ${it.ok === null ? 'z' : it.ok ? 'y' : 'n'}">${it.ok === null ? '·' : it.ok ? '✓' : '✗'}</span><span>${esc(it.text)}</span>
        <span class="p">${it.avail > 0 || it.pts ? `${pts(it.pts)}/${pts(it.avail)}` : 'N/A'}</span></li>`).join('')}</ul></div>`;
  }).join('');
  const caps = s.caps.length ? `<div class="caps">${s.caps.map(c => `<div class="cap ${c.id === 'veto' ? 'veto' : c.binding ? 'bind' : ''}"><b>maks ${c.max}</b>${esc(c.text)}${c.binding || c.id === 'veto' ? '' : ' <span class="dim">(tidak mengikat)</span>'}</div>`).join('')}</div>` : '';
  const warns = s.warnings.length ? `<ul class="warns">${s.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  const missing = s.missing.length ? `<div class="small dim">N/A: ${esc(s.missing.join(' · '))}</div>` : '';
  return `<article class="setup l-${esc(shown.label)} ${sel ? 'sel' : ''}${stale ? ' stale' : ''}" data-key="${esc(s.key)}">
    ${stale ? `<div class="stalebar">${esc(stale)} — skor ${s.score} dari analisa terakhir dianggap 0 (veto). Jangan entry dari kartu ini sebelum data baru masuk.</div>` : ''}
    <div class="shd">
      <div class="scbox" title="${stale ? `Veto: ${esc(stale)}` : `Skor ${s.score}/100 — bukan peluang menang`}"><b>${shown.score}</b><span>${esc(shown.label)}</span></div>
      <div class="sinfo">
        <div class="dirline"><span class="dir ${s.dir}">${s.dir.toUpperCase()}</span><span>${esc(s.tf)} · #${s.id}</span><span class="grade ${gradeCls(s.grade)}" title="Grade OB sweep">grade ${esc(s.grade)}</span></div>
        <div class="small muted">konfirmasi ${wib(s.confirm.closeT)} WIB · ${s.confirm.barsSince} candle lalu · poin ${pts(s.raw)}/${pts(s.availMax)}${s.scaled != null ? ' (diskalakan)' : ''}</div>
        <div class="chips">${chips}</div>
      </div>
    </div>
    <div class="facts">
      <span class="k">FVG</span><span class="v">${px(s.fvg.bot)}–${px(s.fvg.top)} · C3 ${wib(s.fvg.t3)}${s.fvg.gapX != null ? ` · gap ${r1(s.fvg.gapX)}×` : ''}</span>
      <span class="k">liqxm</span><span class="v">${px(s.liq.price)} · ${wib(s.liq.t)} · candle ke-${s.liq.ageC3} (${late})</span>
      <span class="k">OB</span><span class="v">${s.ob ? `${px(s.ob.bot)}–${px(s.ob.top)} · ${wib(s.ob.t)}${s.ob.extBar != null ? ' · diperluas' : ''}` : 'tidak ada'}</span>
      <span class="k">Sweep</span><span class="v" title="${esc(hits)}">${s.sweepTfs.length ? esc(s.sweepTfs.join(', ')) : '—'}</span>
      <span class="k">Harga</span><span class="v">${esc(moved)}</span>
      <span class="k">Data detik</span><span class="v">${esc(cov)}</span>
    </div>
    <details class="why" data-key="${esc(s.key)}"${(st.whyOpen.has(s.key) ? st.whyOpen.get(s.key) : first) ? ' open' : ''}><summary>Alasan skor per komponen</summary><div class="comps">${comps}</div></details>
    ${caps}
    ${modelsHtml(R, s, px, d)}
    ${warns}${missing}
    <div class="calib">${calibHtml(s)}</div>
    <div class="acts">
      <button type="button" class="btn sm" data-act="chart" data-key="${esc(s.key)}">Lihat di chart</button>
      ${stale ? '<span class="small dim" style="align-self:center">Salin / Analisa di Claude nonaktif — data basi</span>' : `<button type="button" class="btn sm" data-act="copy" data-key="${esc(s.key)}">Salin buat Claude</button>
      <a class="btn sm ask" href="${esc(claudeUrl(R, s))}" target="_blank" rel="noopener noreferrer">Analisa di Claude</a>`}
    </div>
  </article>`;
}

function modelsHtml(R, s, px, d) {
  const rows = [
    ['Entry', m => px(m.entry), 'en'], ['SL', m => px(m.sl), 'sl'], ['TP', m => px(m.tp), 'tp'],
    ['Risk', m => m.risk.toFixed(d)], ['R/biaya', m => r1(m.rc)], ['Lot', m => m.lot.toFixed(2)],
    ['Rugi di SL', m => usd(m.lossUsd)], ['Untung di TP', m => usd(m.rewardUsd)],
    ['Level lawan', m => m.firstLevel ? `${r1(m.firstLevel.r)}R` : '—'],
  ];
  const on = id => id === s.entry ? ' on' : '';
  let h = '<div class="k hd" style="text-align:left;padding:7px 8px">Model</div>' +
    MODEL_IDS.map(id => `<div class="hd${on(id)}"><button type="button" data-act="model" data-v="${id}" title="Pakai model ${MODEL_NAME[id]} untuk skor">${MODEL_NAME[id]}${id === s.entry ? ' ●' : ''}</button></div>`).join('');
  rows.forEach(([label, f, cls], ri) => {
    h += `<div class="k">${label}</div>`;
    for (const id of MODEL_IDS) {
      const m = s.models[id];
      if (!m.ok) { h += ri === 0 ? `<div class="v bad${on(id)}" title="${esc(m.why)}">tidak bisa: ${esc(m.why)}</div>` : `<div class="v dim${on(id)}">—</div>`; continue; }
      const title = label === 'Level lawan' && m.firstLevel ? ` title="${esc(m.firstLevel.label)} ${esc(px(m.firstLevel.px))}"`
        : label === 'Entry' && m.fillNow ? ' title="Harga sudah di/lewat level limit — langsung terisi"'
        : label === 'Entry' && m.beyondLiq ? ' title="Entry di luar harga liqxm — limit baru terisi setelah liqxm tersapu (setup hilang dari daftar live)"' : '';
      h += `<div class="v ${cls || ''}${on(id)}"${title}>${esc(f(m))}${label === 'Entry' && m.fillNow ? '*' : label === 'Entry' && m.beyondLiq ? '†' : ''}</div>`;
    }
  });
  h += '<div class="k last">Skor model</div>' + MODEL_IDS.map(id => `<div class="v last${on(id)}"><b>${s.scoreBy[id]}</b></div>`).join('');
  return `<div class="models" role="table" aria-label="Entry, SL, TP per model">${h}</div>`;
}

function renderPending() {
  const R = st.R, el = $('#pending'), sub = $('#pendSub');
  if (sub) sub.textContent = R && R.prefs.confirmBars ? `liqxm sudah ada, belum ${R.prefs.confirmBars} candle close` : 'liqxm sudah ada, menunggu candle konfirmasi';
  if (!R) { el.innerHTML = ''; return; }
  if (!R.pending.length) { el.innerHTML = '<div class="empty">Tidak ada liqxm yang menunggu konfirmasi.</div>'; return; }
  const px = pxf(R);
  el.innerHTML = R.pending.map(p => `<div class="pc ${st.sel === p.key ? 'sel' : ''}" data-key="${esc(p.key)}">
    <div class="ph"><span><span class="dir ${p.dir}">${p.dir.toUpperCase()}</span> <span class="small muted">${esc(p.tf)} · #${p.id}</span></span><span class="grade ${gradeCls(p.grade)}">grade ${esc(p.grade)}</span></div>
    <div><span class="pips">${Array.from({ length: p.need }, (_, i) => `<i class="${i < p.k ? 'on' : ''}"></i>`).join('')}</span>${esc(p.text)}</div>
    <div class="mono muted">FVG ${px(p.fvg.bot)}–${px(p.fvg.top)} · liqxm ${px(p.liq.price)} (${wib(p.liq.t)}, candle ke-${p.liq.ageC3}${p.liq.late ? ', lanjutan' : ''})</div>
    <div class="mono muted">OB ${p.ob ? `${px(p.ob.bot)}–${px(p.ob.top)}` : '—'} · sweep ${p.sweepTfs.length ? esc(p.sweepTfs.join(', ')) : '—'}</div>
    <div><button type="button" class="btn sm" data-act="chart" data-key="${esc(p.key)}">Lihat di chart</button></div>
  </div>`).join('');
}

// ── Claude hand-off ────────────────────────────────────────────────────────────────────────────────────────────────────
const CLAUDE_HEAD = 'Tolong cek ulang setup trading liqxm ini sebelum aku entry. Skor dari desk bukan peluang menang — nilai konfluensinya, risiko terbesarnya, dan apakah entry/SL/TP + lot masuk akal. Jawab singkat dalam bahasa Indonesia.\n\n';
function claudeUrl(R, s) {
  const base = 'https://claude.ai/new?q=';
  let lines = st.S.claudeText(R, s).split('\n');
  const enc = () => base + encodeURIComponent(CLAUDE_HEAD + lines.join('\n'));
  let url = enc();
  for (const pre of ['Data:', 'Catatan:', 'N/A:', 'Cap:']) { if (url.length <= URL_LIMIT) break; lines = lines.filter(l => !l.startsWith(pre)); url = enc(); }
  while (url.length > URL_LIMIT && lines.length > 4) { lines.splice(-2, 1); url = enc(); }
  return url;
}

// ── calibration line (filled once a backtest ran in this session) ───────────────────────────────────────────────────────
// Uses calibOf(stats, setup, model) from the encrypted backtest module: the historical result of setups in the same 10-point
// score bucket and with the same OB-sweep grade, for the model the card is scored with. Shown only while the last run is for
// the same instrument, source and exec TF as the screen; "sampel kecil" under 30 closed trades.
function calibHtml(s) {
  if (!st.B || typeof st.B.backtest !== 'function') return 'Kalibrasi: backtest belum tersedia di build ini.';
  const R = st.R;
  if (st.btBusy) return `Kalibrasi: backtest sedang jalan… <span class="btpct">${Math.round(st.btPct * 100)}%</span>`;
  const runBtn = t => `<button type="button" class="linkbtn" data-act="bt">${esc(t)}</button>`;
  if (!st.bt) return `Kalibrasi: belum ada backtest di sesi ini — ${runBtn('jalankan backtest')} (± beberapa detik).`;
  const B = st.bt;
  if (R && !btFits(B, R)) return `Kalibrasi: backtest terakhir untuk ${esc(B.inst)} ${esc(B.src)} ${esc(B.tf)} — ${runBtn(`jalankan ulang untuk ${R.inst.id} ${R.source} ${R.exec.tf}`)}.`;
  let c = null;
  try {
    if (typeof st.B.calibOf === 'function') c = st.B.calibOf(B.stats, s, s.entry);
    else if (typeof st.B.calibration === 'function') c = st.B.calibration(B.stats, s, B.P);
  } catch (_) { c = null; }
  if (!c) return 'Kalibrasi: tidak ada data backtest untuk bucket/grade ini.';
  if (typeof c === 'string') return esc(c);
  const part = (name, x) => {
    if (!x) return '';
    if (!x.n) return `<b>${esc(name)}</b>: belum ada trade`;
    const small = x.small ?? (x.n < SMALL_N);
    return `<b>${esc(name)}</b>: ${x.n} trade · win ${pctTxt(x.winPct ?? x.win)} · rata-rata <span class="${rCls(x.avgR)}">${sgnR(x.avgR)}R</span>${small ? ' <span class="small-n">sampel kecil</span>' : ''}`;
  };
  const bLab = c.bucket ? (c.bucket.label ?? (c.bucket.bucket != null ? `bucket ${c.bucket.bucket}–${c.bucket.bucket + 9}` : 'bucket')) : '';
  const gLab = c.grade ? 'grade ' + (c.grade.label ?? c.grade.grade ?? '') : '';
  const M = B.stats.meta || {};
  const parts = [part(bLab, c.bucket), part(gLab, c.grade)].filter(Boolean);
  if (!parts.length) return c.text ? esc(c.text) : 'Kalibrasi: —';
  const extra = [];
  if (R && M.rr != null && R.prefs.rr !== M.rr) extra.push(`backtest pakai RR 1:${M.rr}, sekarang 1:${R.prefs.rr}`);
  if (B.sig !== btSig(prefs())) extra.push('setelan berubah sejak backtest');
  return `<span title="Hasil historis setup dengan bucket skor dan grade yang sama — bukan peluang menang">Kalibrasi backtest ${esc(MODEL_NAME[c.model || s.entry] || '')} (RR 1:${esc(M.rr ?? '?')}, data s/d ${wib(M.now, false, true)})</span> — ${parts.join(' · ')}` +
    (extra.length ? ` <span class="dim">· ${esc(extra.join(' · '))} — ${runBtn('jalankan ulang')}</span>` : '');
}

// ── chart (drawing of the traces score.js returns; no analysis here) ───────────────────────────────────────────────────
const COL = {
  bull: ['rgba(0,150,136,.16)', 'rgba(0,150,136,.6)'], bear: ['rgba(242,54,69,.15)', 'rgba(242,54,69,.6)'],
  filled: ['rgba(120,123,134,.15)', 'rgba(149,152,161,.55)'], filled2: ['rgba(33,150,243,.15)', 'rgba(33,150,243,.55)'],
  obSw: ['rgba(76,175,80,.2)', 'rgba(76,175,80,.75)'], ob: ['rgba(255,235,59,.18)', 'rgba(255,235,59,.7)'],
  liq: '#FF9800', liq2: '#C77DFF', swept: '#9598A1', blue: '#2196F3', sweep: '#4CAF50', sel: 'rgba(217,255,87,.95)', pend: ['rgba(217,255,87,.05)', 'rgba(217,255,87,.7)'],
};
function renderSelect() {
  const R = st.R, el = $('#selSetup');
  if (!R) { el.innerHTML = '<option value="">—</option>'; return; }
  const opt = (v, t) => `<option value="${esc(v)}"${st.sel === v ? ' selected' : ''}>${esc(t)}</option>`;
  el.innerHTML = opt('', '— tanpa setup —') +
    R.setups.map(s => { const sh = shownScore(s); return opt(s.key, `${s.dir.toUpperCase()} ${s.tf} #${s.id} · skor ${sh.score} ${sh.label} · grade ${s.grade}`); }).join('') +
    R.pending.map(p => opt(p.key, `pending ${p.dir.toUpperCase()} #${p.id} · ${p.text}`)).join('');
}
function renderChart(opts = {}) {
  const R = st.R, m = st.market;
  if (st.tab !== 'chart' || !R || !m) { st.chartDirty = true; return; }
  const P = R.prefs, E = R.exec.tf;
  const tfs = CHART_TFS.filter(tf => m.bars[tf] && m.bars[tf].t.length && R.traces[tf]);
  if (!tfs.includes(st.chartTf)) st.chartTf = tfs.includes(E) ? E : tfs[0];
  const tf = st.chartTf;
  $('#segChartTf').innerHTML = tfs.map(x => `<button type="button" data-v="${x}" aria-pressed="${x === tf}">${x}${x === E ? '*' : ''}</button>`).join('');
  for (const cb of $$('[data-layer]')) { cb.checked = !!st.ui.layers[cb.dataset.layer]; cb.closest('.tog').classList.toggle('on', cb.checked); }
  if (!st.chart) st.chart = makeChart($('#chBox'), { height: Math.max(340, Math.min(620, window.innerHeight - 280)) });
  const b = m.bars[tf], off = R.broker.offset || 0;
  if (opts.data !== false) st.chart.setBars(b, R.inst.digits, `${R.inst.name} · ${tf}${tf === E ? ' (exec)' : ''} · ${m.contract}${off ? ` · harga +offset ${off}` : ''}`, off);
  const o = overlays(R, m, tf);
  st.chart.setZones(o.zones); st.chart.setSegs(o.segs); st.chart.setMarkers(o.marks); st.chart.setBox(o.box); st.chart.setLines(o.lines);
  if (opts.btFocus && o.btFocus) st.chart.focus(o.btFocus[0], o.btFocus[1], 30);
  else if (opts.focus && o.focusT != null) st.chart.focus(o.focusT, null, 30);
  else if (st.chartTfShown !== tf) st.chart.showRecent(TF_SEC[tf] < 60 ? 240 : 160);
  st.chartTfShown = tf; st.chartDirty = false;
  renderSelInfo(R);
}
function overlays(R, m, tf) {
  const out = { zones: [], segs: [], marks: [], box: null, lines: [], focusT: null, btFocus: null };
  const tr = R.traces[tf], b = m.bars[tf], L = st.ui.layers, E = R.exec.tf;
  if (!tr || !b) return out;
  const t = b.t, n = t.length;
  const sel = findSel(st.sel);
  const selId = sel && tf === E ? sel.s.id : null;
  const conf = tr.fvgs.filter(f => f.confirmBar != null && f.confirmBar < n && f.liq)
    .sort((a, c) => a.confirmBar - c.confirmBar || a.id - c.id).slice(-MAX_SHOW);
  for (const f of conf) {
    const stop = f.endBar != null ? f.endBar : f.sweptBar;
    const t1 = stop != null && stop < n ? t[stop] : null;
    const filled = f.endReason === 'filled', late = !!f.late, isSel = f.id === selId;
    if (L.fvg || isSel) {
      const c = filled ? (late ? COL.filled2 : COL.filled) : f.isBull ? COL.bull : COL.bear;
      out.zones.push({ t0: t[f.c1], t1, top: f.top, bot: f.bot, fill: c[0], line: isSel ? COL.sel : c[1], dash: filled && !isSel, lw: isSel ? 2 : 1 });
    }
    if (L.ob && f.ob) {
      const c = f.sweep.length ? COL.obSw : COL.ob;
      out.zones.push({ t0: t[f.ob.bar], t1, top: f.ob.top, bot: f.ob.bot, fill: c[0], line: c[1], label: isSel ? (f.sweep.length ? 'OB sweep' : 'OB') : null, labelColor: f.sweep.length ? '#7EE08A' : '#FFEB3B', labelBottom: f.isBull });
    }
    if (L.liq) {
      const swept = f.sweptBar != null && f.sweptBar < n;
      const color = filled ? (late ? COL.blue : COL.swept) : swept ? COL.swept : late ? COL.liq2 : COL.liq;
      out.segs.push({ t0: t[f.liq.bar], t1, px: f.liq.price, color, width: isSel ? 2 : 1.5, dash: filled || swept ? [4, 3] : null, label: 'liqxm', below: f.isBull });
    }
    if (L.sweep && f.ob && f.sweepHits && f.sweepHits.length) {
      for (const h of f.sweepHits) {
        const name = h.tf === 'C' ? tf : h.tf;
        out.segs.push({ t0: h.wt, t1: h.st, px: h.px, color: COL.sweep, width: 2, dash: [2, 3] });
        out.marks.push({ t: h.st, px: h.px, pos: 'price', shape: 'circle', color: COL.sweep, text: name });
      }
    }
  }
  if (L.pend && tf === E) {
    for (const p of R.pending) {
      const c1 = p.fvg.c3 - 2, isSel = p.key === st.sel;
      if (c1 < 0 || c1 >= n) continue;
      out.zones.push({ t0: t[c1], t1: null, top: p.fvg.top, bot: p.fvg.bot, fill: COL.pend[0], line: isSel ? COL.sel : COL.pend[1], dash: !isSel, lw: isSel ? 2 : 1, label: p.text, labelColor: '#D9FF57', labelBottom: p.isBull });
      out.segs.push({ t0: p.liq.t, t1: null, px: p.liq.price, color: p.liq.late ? COL.liq2 : COL.liq, width: 1.5, dash: [4, 3] });
      if (p.ob && L.ob) out.zones.push({ t0: p.ob.t, t1: null, top: p.ob.top, bot: p.ob.bot, fill: 'transparent', line: p.sweepTfs.length ? COL.obSw[1] : COL.ob[1], dash: true });
    }
  }
  if (sel) {
    const s = sel.s;
    out.focusT = sel.kind === 'setup' ? s.fvg.t1 : (s.fvg.c3 - 2 >= 0 && tf === E ? t[s.fvg.c3 - 2] : s.fvg.t3);
    if (tf !== E) {  // the exec setup's zones on another timeframe: outline only
      const t1 = sel.kind === 'setup' ? s.fvg.t1 : s.fvg.t3;
      out.zones.push({ t0: t1, t1: null, top: s.fvg.top, bot: s.fvg.bot, fill: 'rgba(217,255,87,.04)', line: COL.sel, lw: 1.5, label: `FVG ${E}`, labelColor: '#D9FF57', labelBottom: s.isBull });
      if (s.ob) out.zones.push({ t0: s.ob.t, t1: null, top: s.ob.top, bot: s.ob.bot, fill: 'transparent', line: s.sweepTfs.length ? COL.obSw[1] : COL.ob[1], dash: true, label: `OB ${E}`, labelColor: '#FFEB3B', labelBottom: s.isBull });
      out.segs.push({ t0: s.liq.t, t1: null, px: s.liq.price, color: s.liq.late ? COL.liq2 : COL.liq, width: 1.5, dash: [6, 3], label: `liqxm ${E}`, below: s.isBull });
    }
    out.marks.push({ t: s.liq.t, pos: s.isBull ? 'below' : 'above', shape: s.isBull ? 'arrowUp' : 'arrowDown', color: s.liq.late ? COL.liq2 : COL.liq, text: '' });
    if (sel.kind === 'setup') {
      out.marks.push({ t: s.confirm.t, pos: s.isBull ? 'below' : 'above', shape: 'circle', color: '#D9FF57', text: 'konfirmasi' });
      const md = s.models[R.prefs.entry];
      if (md && md.ok) {
        // market: entry = live price → the box starts now (R.exec.priceT); limits: their level exists from the confirmation
        const t0 = md.kind === 'market' ? Math.max(R.exec.priceT || 0, s.confirm.closeT) : s.confirm.closeT;
        out.box = { t0, t1: null, entry: md.entry, sl: md.sl, tp: md.tp, label: `${md.name} ${s.dir.toUpperCase()} · skor ${shownScore(s).score} · lot ${md.lot.toFixed(2)}` };
        out.lines = [{ px: md.entry, color: '#D9FF57', title: 'Entry', style: 0 }, { px: md.sl, color: '#FF7A6B', title: 'SL' }, { px: md.tp, color: '#7EE08A', title: 'TP' }];
      }
    }
  }
  btOverlays(R, tf, t, n, out);
  return out;
}
function renderSelInfo(R) {
  renderBtSelInfo(R);
  const sel = findSel(st.sel), el = $('#selInfo');
  if (!sel) { el.innerHTML = 'Pilih setup di atas (atau “Lihat di chart” di kartu setup) untuk menampilkan entry / SL / TP.'; return; }
  const s = sel.s, px = pxf(R);
  if (sel.kind === 'pending') { el.innerHTML = `<b>Pending ${s.dir.toUpperCase()} #${s.id}</b> · ${esc(s.text)} · FVG ${px(s.fvg.bot)}–${px(s.fvg.top)} · liqxm ${px(s.liq.price)}`; return; }
  const md = s.models[R.prefs.entry], sh = shownScore(s), sw = staleWhy();
  el.innerHTML = (sw ? `<span class="neg">${esc(sw)} — skor dianggap 0.</span> ` : '') + `<b>${s.dir.toUpperCase()} ${esc(s.tf)} #${s.id} · skor ${sh.score} (${esc(sh.label)}) · grade ${esc(s.grade)}</b> · ` +
    (md.ok ? `${esc(md.name)}: entry <b class="mono">${px(md.entry)}</b> · SL <b class="mono">${px(md.sl)}</b> · TP <b class="mono">${px(md.tp)}</b> · lot ${md.lot.toFixed(2)} (rugi ${usd(md.lossUsd)})` : `${esc(md.name)} tidak bisa: ${esc(md.why)}`);
}
function selectSetup(key, toChart) {
  st.sel = key || null; st.btTrade = null;
  for (const c of $$('#cards .setup, #pending .pc')) c.classList.toggle('sel', c.dataset.key === st.sel);
  renderSelect();
  if (toChart) { st.chartTf = st.R ? st.R.exec.tf : st.chartTf; showTab('chart', { focus: true }); }
  else if (st.tab === 'chart') renderChart({ data: false, focus: true });
}

// ── tabs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function showTab(id, opts = {}) {
  st.tab = id;
  for (const t of $$('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === id));
  for (const p of $$('.pane')) p.classList.toggle('on', p.id === 'pane-' + id);
  if (id === 'bt') requestAnimationFrame(renderBtCurve);
  if (id === 'chart') {
    requestAnimationFrame(() => {
      renderChart({ focus: !!opts.focus, btFocus: !!opts.btFocus });
      if (opts.focus || opts.btFocus) { const el = $('#pane-chart'); window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 64) }); }
    });
  }
}

// ── controls ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function syncControls() {
  if (!st.S) return;
  const P = prefs();
  const press = (sel, v) => { for (const b of $(sel).children) b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
  press('#segInst', P.instrument); press('#segSrc', srcOf(P)); press('#segTf', P.execTf); press('#segEntry', P.entry);
  press('#segDir', P.dir); press('#segRisk', P.riskMode);
  const setVal = (sel, v) => { const el = $(sel); if (document.activeElement !== el) el.value = v; };
  setVal('#inRr', P.rr); setVal('#inBal', P.balance); setVal('#inRisk', P.riskMode === 'usd' ? P.riskUsd : P.riskPct);
  $('#inRisk').step = P.riskMode === 'usd' ? '1' : '0.1';
  $('#inRisk').title = P.riskMode === 'usd' ? 'Risiko per trade dalam $' : 'Risiko per trade dalam % saldo';
  const nOn = newsOn();
  $('#togNews').checked = nOn; $('#togNewsL').classList.toggle('on', nOn);
  $('#newsTxt').textContent = nOn ? `News high-impact ≤ 30 menit (aktif s/d ${wib(st.newsUntil)})` : 'News high-impact ≤ 30 menit';
  $('#togAuto').checked = !!st.ui.auto; $('#togAutoL').classList.toggle('on', !!st.ui.auto);
  const nPerm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  $('#togNotif').checked = !!st.ui.notify && nPerm === 'granted'; $('#togNotifL').classList.toggle('on', $('#togNotif').checked);
  $('#togNotifL').title = nPerm === 'unsupported' ? 'Browser ini tidak mendukung notifikasi' : nPerm === 'denied' ? 'Izin notifikasi diblokir di browser' : `Notifikasi kalau ada setup baru dengan skor ≥ ${st.ui.notifyMin}`;
}
function bindControls() {
  const seg = (sel, path, opts) => $(sel).addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    if (path === 'source') setPref('source', v === INSTR[prefs().instrument].source ? undefined : v, { now: true });
    else setPref(path, v, opts || { now: true });
  });
  $('#segInst').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v || v === prefs().instrument) return;
    st.raw.source = undefined; delete st.raw.source; st.sel = null;
    setPref('instrument', v, { now: true });
  });
  seg('#segSrc', 'source'); seg('#segTf', 'execTf'); seg('#segEntry', 'entry'); seg('#segDir', 'dir'); seg('#segRisk', 'riskMode');
  const num = (sel, f) => $(sel).addEventListener('change', e => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0) f(v); else syncControls(); });
  num('#inRr', v => v > 0 && setPref('rr', v));
  num('#inBal', v => setPref('balance', v));
  num('#inRisk', v => setPref(prefs().riskMode === 'usd' ? 'riskUsd' : 'riskPct', v));
  $('#togNews').addEventListener('change', e => { st.newsUntil = e.target.checked ? Date.now() / 1000 + 30 * 60 : 0; syncControls(); recompute(); });
  $('#togAuto').addEventListener('change', e => { st.ui.auto = e.target.checked; savePrefs(); syncControls(); schedule(); });
  $('#togNotif').addEventListener('change', async e => {
    if (!e.target.checked) { st.ui.notify = false; savePrefs(); syncControls(); return; }
    if (typeof Notification === 'undefined') { toast('Browser ini tidak mendukung notifikasi.'); syncControls(); return; }
    let p = Notification.permission;
    if (p === 'default') { try { p = await Notification.requestPermission(); } catch (_) { } }
    st.ui.notify = p === 'granted'; savePrefs(); syncControls();
    toast(p === 'granted' ? `Notifikasi aktif untuk setup baru skor ≥ ${st.ui.notifyMin}.` : 'Izin notifikasi ditolak browser.');
  });
  $('#btnCheck').addEventListener('click', () => check());
  $('#ladder').addEventListener('click', e => {
    const tf = e.target.closest('.tf')?.dataset.tf; if (!tf || !st.market?.bars[tf]) return;
    st.chartTf = tf; showTab('chart');
  });
  for (const t of $$('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  const onAct = async e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'model') { setPref('entry', a.dataset.v, { now: true }); return; }
    if (act === 'bt') { runBacktest(); return; }
    if (act === 'bttab') { showTab('bt'); return; }
    const key = a.dataset.key, f = findSel(key); if (!f) return;
    if (act === 'chart') selectSetup(key, true);
    else if (act === 'copy') {
      if (staleWhy()) { toast('Data basi — klik “Cek sekarang” dulu.'); return; }
      const txt = CLAUDE_HEAD + st.S.claudeText(st.R, f.s);
      if (await copyText(txt)) toast('Tersalin — tinggal paste ke Claude.'); else copyDialog(txt);
    }
  };
  $('#cards').addEventListener('click', onAct); $('#pending').addEventListener('click', onAct);
  $('#cards').addEventListener('toggle', e => { const d = e.target; if (d.matches && d.matches('details.why')) st.whyOpen.set(d.dataset.key, d.open); }, true);
  $('#segChartTf').addEventListener('click', e => { const v = e.target.closest('button')?.dataset.v; if (!v) return; st.chartTf = v; renderChart(); });
  for (const cb of $$('[data-layer]')) cb.addEventListener('change', () => { st.ui.layers = { ...st.ui.layers, [cb.dataset.layer]: cb.checked }; savePrefs(); renderChart({ data: false }); });
  $('#selSetup').addEventListener('change', e => selectSetup(e.target.value, false));
  $('#btnRecent').addEventListener('click', () => st.chart && st.chart.showRecent(TF_SEC[st.chartTf] < 60 ? 240 : 160));
}

// ── settings ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const fieldRow = (path, label, type, extra = {}) => ({ path, label, type, ...extra });
function buildSettings() {
  const S = st.S, D = S.DEFAULT_PREFS, UI = S.UI_INPUTS || null;
  const brk = id => [
    { sub: `${INSTR[id].name} — ${INSTR[id].lotNote}` },
    fieldRow(`broker.${id}.spread`, 'Spread (harga)', 'num', { step: id === 'XAU' ? 0.01 : 0.1, min: 0 }),
    fieldRow(`broker.${id}.comm`, 'Komisi ($ per lot, pulang-pergi)', 'num', { step: 0.5, min: 0 }),
    fieldRow(`broker.${id}.lot`, 'Ukuran lot (unit per 1 lot)', 'num', { step: 1, min: 0.0001 }),
    fieldRow(`broker.${id}.offset`, 'Offset harga (broker − Gate)', 'num', { step: id === 'XAU' ? 0.01 : 0.1, hint: 'ditambahkan ke semua harga yang ditampilkan' }),
  ];
  const scoreRows = UI ? UI.score.map(x => fieldRow(x.k, x.label, typeof D[x.k] === 'boolean' ? 'bool' : 'num', x)) : [];
  const engGroups = UI ? UI.engine : [{ group: 'Engine', items: Object.keys(D.engine).map(k => ({ k, label: k })) }];
  const engRows = g => [{ sub: g.group }, ...g.items.filter(x => x.k in D.engine).map(x => {
    const dv = D.engine[x.k];
    const type = x.options ? 'sel' : typeof dv === 'boolean' ? 'bool' : 'num';
    return fieldRow('engine.' + x.k, x.label, type, { ...x, nullable: x.nullable || dv === null });
  })];
  $('#setBox').innerHTML = `<div class="sgrid">
    <div class="card"><h3>Broker</h3><p>Biaya per trade = spread + komisi ÷ ukuran lot + slippage. Offset dipakai supaya harga di desk sama dengan harga broker kamu.</p>
      <div class="form">${formRows([...brk('XAU'), ...brk('NAS'), { sub: 'Slippage' }, fieldRow('slip', 'Slippage per trade (harga)', 'num', { step: 0.01, min: 0, nullable: true, hint: 'kosong = 0.1 × spread' })])}</div>
      <div class="row" style="margin-top:12px"><label class="fld"><span>Harga broker sekarang (<span id="offInst">XAU</span>)</span><input id="inBrokerPx" type="number" step="0.01" inputmode="decimal" style="width:130px"></label><button type="button" class="btn sm" id="btnOffset">Hitung offset</button></div>
    </div>
    <div class="card"><h3>Saldo &amp; risiko</h3><p>Lot dihitung dari risiko (termasuk biaya) lalu dibulatkan ke bawah ke 0.01.</p>
      <div class="form">${formRows([fieldRow('balance', 'Saldo ($)', 'num', { step: 100, min: 0 }), fieldRow('riskMode', 'Mode risiko', 'sel', { options: ['pct', 'usd'], optionText: ['% dari saldo', '$ tetap'] }),
        fieldRow('riskPct', 'Risiko (% saldo)', 'num', { step: 0.1, min: 0 }), fieldRow('riskUsd', 'Risiko ($ per trade)', 'num', { step: 1, min: 0 }), fieldRow('rr', 'RR (TP = RR × risk)', 'num', { step: 0.5, min: 0.5 })])}</div>
    </div>
    <div class="card"><h3>Skor, data &amp; notifikasi</h3><p>Setelan analisa di luar engine.</p>
      <div class="form">${formRows([...scoreRows, { sub: 'Notifikasi' }, fieldRow('ui.notifyMin', 'Notifikasi kalau skor ≥', 'num', { step: 5, min: 1, max: 100 })])}</div>
    </div>
  </div>
  <details class="adv card" id="advBox"><summary>Advanced — input engine (default = indikator Pine)</summary>
    <p class="small muted" style="margin:0 0 10px">Ubah ini hanya kalau kamu juga mengubahnya di TradingView. Nilai yang beda dari default ditandai hijau.</p>
    <div class="sgrid">${engGroups.map(g => `<div><div class="form">${formRows(engRows(g))}</div></div>`).join('')}</div>
    <div class="sacts"><button type="button" class="btn sm" id="btnResetEngine">Reset engine ke default Pine</button></div>
  </details>
  <div class="sacts"><button type="button" class="btn sm" id="btnResetAll">Reset semua setelan</button><span class="small dim" style="align-self:center">Setelan disimpan di browser ini saja (localStorage).</span></div>`;

  $('#setBox').addEventListener('change', e => {
    const el = e.target.closest('[data-path]'); if (!el) return;
    const path = el.dataset.path, type = el.dataset.type;
    let v;
    if (type === 'bool') v = el.checked;
    else if (type === 'sel') v = el.value;
    else {
      const s = el.value.trim();
      if (s === '') v = el.dataset.nullable ? null : undefined;
      else { v = parseFloat(s); if (!isFinite(v)) { syncForms(); return; } }
    }
    if (path.startsWith('ui.')) { st.ui[path.slice(3)] = v ?? UI_DEF[path.slice(3)]; savePrefs(); syncForms(); syncControls(); return; }
    setPref(path, v);
  });
  $('#btnResetEngine').addEventListener('click', () => { delete st.raw.engine; setPref('secRefNonZero', undefined, { now: true }); toast('Input engine kembali ke default Pine.'); });
  $('#btnResetAll').addEventListener('click', e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Yakin? Klik lagi untuk reset'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'Reset semua setelan'; }, 3500); return; }
    const inst = st.raw.instrument; st.raw = inst ? { instrument: inst } : {}; st.ui = { ...UI_DEF, layers: { ...UI_DEF.layers } };
    delete b.dataset.armed; b.textContent = 'Reset semua setelan';
    savePrefs(); syncControls(); syncForms(); recompute(); toast('Semua setelan kembali ke default.');
  });
  $('#btnOffset').addEventListener('click', () => {
    const v = parseFloat($('#inBrokerPx').value), m = st.market, P = prefs();
    if (!isFinite(v) || !m || m.price == null) { toast('Isi harga broker dulu (dan tunggu data Gate termuat).'); return; }
    const d = INSTR[P.instrument].digits, off = Math.round((v - m.price) * 10 ** d) / 10 ** d;
    setPref(`broker.${P.instrument}.offset`, off, { now: true });
    toast(`Offset ${P.instrument} = ${off >= 0 ? '+' : ''}${off} (harga Gate ${m.price.toFixed(d)}).`);
  });
  syncForms();
}
function formRows(rows) {
  return rows.map(r => {
    if (r.sub) return `<div class="sub">${esc(r.sub)}</div>`;
    const id = 'f_' + r.path.replace(/\W/g, '_');
    const attrs = `id="${id}" data-path="${esc(r.path)}" data-type="${r.type}"${r.nullable ? ' data-nullable="1"' : ''}`;
    let input;
    if (r.type === 'bool') input = `<input type="checkbox" ${attrs}>`;
    else if (r.type === 'sel') input = `<select ${attrs}>${r.options.map((o, i) => `<option value="${esc(o)}">${esc((r.optionText || [])[i] || o)}</option>`).join('')}</select>`;
    else input = `<input type="number" inputmode="decimal" ${attrs}${r.step != null ? ` step="${r.step}"` : ''}${r.min != null ? ` min="${r.min}"` : ''}${r.max != null ? ` max="${r.max}"` : ''}>`;
    return `<div class="frow" style="display:contents"><label for="${id}">${esc(r.label)}<small data-hint-for="${esc(r.path)}" data-hint="${esc(r.hint || '')}">${esc(r.hint || '')}</small></label>${input}</div>`;
  }).join('');
}
function syncForms() {
  if (!st.S || !$('#setBox').firstChild) return;
  const P = prefs(), D = st.S.resolvePrefs({});
  for (const el of $$('#setBox [data-path]')) {
    const path = el.dataset.path, ui = path.startsWith('ui.');
    const v = ui ? st.ui[path.slice(3)] : getPath(P, path), dv = ui ? UI_DEF[path.slice(3)] : getPath(D, path);
    if (document.activeElement !== el) {
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : String(v);
    }
    if (el.dataset.nullable && v == null) el.placeholder = 'otomatis';
    const changed = JSON.stringify(v ?? null) !== JSON.stringify(dv ?? null);
    el.closest('.frow').classList.toggle('chg', changed);
    if (path.startsWith('engine.')) {
      const h = $(`#setBox [data-hint-for="${CSS.escape(path)}"]`);
      if (h) h.textContent = [h.dataset.hint, `default ${dv == null ? 'kosong' : typeof dv === 'boolean' ? (dv ? 'on' : 'off') : dv}`].filter(Boolean).join(' · ');
    }
  }
  const oi = $('#offInst'); if (oi) oi.textContent = prefs().instrument;
}

// ── legend ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function secRefLabel() {
  const x = ((st.S.UI_INPUTS || {}).score || []).find(i => i.k === 'secRefNonZero');
  return x ? x.label : 'TF detik memakai pembanding khusus (lihat Setelan)';
}
function buildLegend() {
  const R = st.S.RUBRIC;
  const note = String(R.note || '').replace(/^\s*Skor bukan peluang menang\.?\s*/i, '');
  $('#legBox').innerHTML = `<div class="big-note"><b>Skor bukan peluang menang.</b> ${esc(note)} Skor 1–100 = poin komponen A–F (maks ${R.total}), lalu dibatasi cap di bawah. Angka kemenangan yang sebenarnya hanya bisa dilihat dari backtest per bucket skor.</div>
  <div class="lg">
    <div class="card"><h3>Komponen skor</h3><table>${R.components.map(c => `<tr><td>${esc(c.id)} ${esc(c.name)}</td><td>${esc(c.desc)}</td><td class="mx">${c.max}</td></tr>`).join('')}
      <tr><td>chip *</td><td>Chip di kartu = poin / maks komponen (sama dengan rincian). Tanda * = sebagian (atau semua) data komponen itu N/A — arahkan kursor ke chip untuk lihat berapa poin yang bisa dinilai. Skor lalu diskalakan dari poin yang tersedia (cap “data kurang”, maks 80).</td><td></td></tr>
      <tr><td>† di Entry</td><td>Entry limit di luar harga liqxm: baru terisi setelah liqxm tersapu.</td><td></td></tr></table></div>
    <div class="card"><h3>Cap / veto</h3><table>${R.caps.map(c => `<tr><td>maks ${c.max}</td><td>${esc(c.text)}</td></tr>`).join('')}</table>
      <p class="small muted" style="margin:10px 0 0">Cap yang “mengikat” = cap yang benar-benar menurunkan skor. Cap lain yang syaratnya terpenuhi tetap ditampilkan sebagai info.</p></div>
    <div class="card"><h3>Label</h3><table>${R.labels.map(l => `<tr><td>${esc(l.id)}</td><td>${esc(l.text)}</td></tr>`).join('')}</table>
      <h3 style="margin-top:16px">Grade OB sweep</h3><table>${R.grades.map(g => `<tr><td>${esc(g.id)}</td><td>${esc(g.text)}</td></tr>`).join('')}</table></div>
    <div class="card"><h3>Model entry</h3><table>${R.models.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.text)}</td></tr>`).join('')}</table>
      <p class="small muted" style="margin:10px 0 0">Ketiga model selalu dihitung; skor utama memakai model yang dipilih di kontrol (klik nama model di tabel kartu untuk ganti). TP = entry ± RR × risk.</p></div>
    <div class="card"><h3>Tangga TF</h3><table>
      <tr><td>EXEC</td><td>TF eksekusi (1m / 3m / 5m) — setup dan entry diambil dari sini.</td></tr>
      <tr><td>HTF</td><td>TF di atas exec yang dipakai untuk bias (komponen A).</td></tr>
      <tr><td>LTF</td><td>TF di bawah exec — konfirmasi TF kecil dan sweep OB berjenjang.</td></tr>
      <tr><td>▲ ▼ ·</td><td>Bias TF itu: bullish, bearish, atau netral. “FVG aktif” = jumlah FVG yang masih hidup, “segar” = konfirmasinya masih baru.</td></tr>
      <tr><td>ref≠0</td><td>${esc(secRefLabel())}.</td></tr>
      <tr><td>–</td><td>Tidak ada data untuk TF itu (mis. NAS tidak punya data detik di Gate) — komponennya dihitung N/A, bukan gagal.</td></tr></table></div>
    <div class="card"><h3>Chart</h3><table>
      <tr><td>FVG</td><td>Kotak hijau-teal (bullish) / merah (bearish); abu-abu putus-putus = sudah terisi penuh; biru = terisi, liqxm lanjutan.</td></tr>
      <tr><td>liqxm</td><td>Garis oranye = liqxm, ungu = liqxm lanjutan, abu-abu putus-putus = sudah ter-sweep.</td></tr>
      <tr><td>OB</td><td>Hijau = OB men-sweep liquidity, kuning = tanpa sweep. Garis hijau titik-titik + titik “sweep TF” = level liquidity yang di-sweep.</td></tr>
      <tr><td>Box</td><td>Entry (garis lime) → TP hijau / SL merah untuk model entry yang dipilih. Model Market mulai dari harga live sekarang; model limit mulai dari candle konfirmasi.</td></tr>
      <tr><td>▲ ▼ ●</td><td>Layer “Trade backtest”: panah = fill trade backtest model yang dipilih di tab Backtest, titik = keluar dengan hasil R. Klik baris trade di tab Backtest untuk lihat kotak TP/SL-nya.</td></tr></table></div>
    <div class="card"><h3>Backtest &amp; kalibrasi</h3><table>
      <tr><td>R</td><td>Hasil trade dalam kelipatan risk (jarak entry → SL), sudah dipotong biaya. +4R = TP di RR 1:4, −1R = kena SL.</td></tr>
      <tr><td>win%</td><td>Persen trade dengan R &gt; 0. Angka dalam kurung = interval 95% — makin sedikit trade, makin lebar.</td></tr>
      <tr><td>PF</td><td>Profit factor: total R menang ÷ total R kalah (∞ = belum ada yang kalah).</td></tr>
      <tr><td>max DD</td><td>Penurunan terdalam kurva R kumulatif (urut waktu fill).</td></tr>
      <tr><td>kecil</td><td>Kurang dari 30 trade — angkanya belum bisa dipegang.</td></tr>
      <tr><td>× budget</td><td>Hasil dalam kelipatan budget risiko per trade kalau lot dihitung seperti di kartu (biaya ikut di lot, jadi rugi di SL = 1 budget). Ini yang kira-kira kamu dapat; R biasa = hasil (sudah dipotong biaya) ÷ jarak entry→SL.</td></tr>
      <tr><td>batal rc</td><td>Order tidak di-entry karena risk/biaya di harga fill di bawah batas di Setelan (default sama dengan cap skor) — biaya terlalu besar dibanding risk.</td></tr>
      <tr><td>Kalibrasi</td><td>Baris di tiap kartu: hasil backtest terakhir di sesi ini untuk setup dengan bucket skor dan grade yang sama. Ini catatan historis, bukan peluang menang.</td></tr></table></div>
  </div>`;
}

// ════ BACKTEST TAB ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Drives backtest(market, prefs, onProgress) from the encrypted backtest module and renders the stats object it returns
// (rendering only — every number comes from the module). Contract used here:
//   backtest(market, prefs, onProgress?) → stats | Promise<stats>   onProgress(p): p = 0..1 | { pct } | { done, total, phase }
//   calibOf(stats, setup, model) → { model, bucket{bucket,n,winPct,avgR,small}, grade{grade,…}, text }  (card calibration)
//   backtestText(stats) → the CLI tables (for "Salin teks")
// renderBacktest(stats) can also be called from outside (window.liqxmDesk.renderBacktest).
const BT_COL = { market: '#3987e5', fvg: '#d95926', ob: '#199e70' };   // categorical slots, validated on the dark panel
const SMALL_N = 30;
const REASON = { tp: 'TP', sl: 'SL', time: 'waktu', break: 'jeda', open: 'jalan' };
const FILL_KIND = { market: 'open', now: 'open', cross: 'limit', touch: 'limit', gap: 'gap' };
const COV_NAME = { full: 'detik penuh', partial: 'detik sebagian', none: 'tanpa detik' };
const PHASE = { skor: 'Menilai setup', statistik: 'Menghitung statistik', selesai: 'Selesai' };
const sgnR = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d);
const pctTxt = x => x == null || !isFinite(x) ? '—' : Math.round(x) + '%';
const pfTxt = r => r.pfInf ? '∞' : r.pf == null ? '—' : r.pf.toFixed(2);
const rCls = x => x == null || !isFinite(x) || Math.abs(x) < 0.005 ? '' : x > 0 ? 'pos' : 'neg';
const idn = x => Number(x).toLocaleString('id-ID');
const msTxt = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
/** Wilson 95 % interval of a win rate (k wins out of n) in percent. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h) * 100, Math.min(1, c + h) * 100];
}
/** Prefs that change a backtest result (balance / risk / news / fresh window do not). */
function btSig(P) {
  const inst = P.instrument, b = P.broker[inst] || {};
  return JSON.stringify([inst, srcOf(P), P.execTf, P.rr, P.dir, b.spread, b.comm, b.lot, P.slip, P.slBufRef, P.limitBars, P.maxHoldBars, P.minRcFill, P.tradeMinutes, P.engine, P.secRefNonZero]);
}
const btFits = (B, R) => !!B && !!R && B.inst === R.inst.id && B.tf === R.exec.tf && B.src === R.source;
const btSameData = (B, R) => !!B && !!R && B.inst === R.inst.id && B.src === R.source;      // trades can be drawn on any TF of the same data
const btStaleKey = () => !st.bt ? '' : `${btFits(st.bt, st.R)}|${st.bt.sig === btSig(prefs())}`;
const btMod = () => st.btModel || (st.bt && st.bt.P.entry) || 'market';
const tradeKey = x => `${x.model}:${x.id}`;
function btPx(S) { const d = INSTR[S.meta.inst]?.digits ?? (S.meta.inst === 'NAS' ? 1 : 2), off = (S.meta.broker && S.meta.broker.offset) || 0; return x => x == null || !isFinite(x) ? '—' : (x + off).toFixed(d); }

function buildBacktestPane() {
  const box = $('#btBox');
  if (!st.B || typeof st.B.backtest !== 'function') {
    box.innerHTML = '<h3 style="font-size:17px;margin-bottom:6px">Backtest</h3><div class="empty">' + (st.btErr ? 'Modul backtest gagal dimuat: ' + esc(st.btErr)
      : 'Backtest belum tersedia di build ini. Begitu modul backtest ikut di-build, tombol “Jalankan backtest” muncul di sini dan hasil per bucket skor tampil di tiap kartu setup.') + '</div>';
    return;
  }
  box.innerHTML = `<div class="bthead">
      <div class="grow"><h3>Backtest</h3><div class="small muted" id="btSub">Semua setup di data yang termuat dinilai per waktu konfirmasinya (tanpa look-ahead), lalu disimulasikan untuk 3 model entry. Pakai instrumen, sumber, TF exec, RR dan setelan broker yang aktif.</div></div>
      <div class="acts"><button type="button" class="btn sm" id="btnBtCopy" hidden>Salin teks</button><button type="button" class="btn pri" id="btnBt">Jalankan backtest</button></div></div>
    <div class="prog" id="btProg"><i></i></div><div class="small muted" id="btStat" style="margin-top:6px" aria-live="polite"></div>
    <div id="btOut"><div class="empty" style="margin-top:12px">Belum dijalankan di sesi ini. Hasilnya juga dipakai untuk baris “Kalibrasi” di tiap kartu setup.</div></div>`;
  $('#btnBt').addEventListener('click', () => runBacktest());
  $('#btnBtCopy').addEventListener('click', async () => {
    if (!st.bt || typeof st.B.backtestText !== 'function') return;
    const txt = st.B.backtestText(st.bt.stats, st.bt.P);
    if (await copyText(txt)) toast('Tabel backtest tersalin.'); else copyDialog(txt);
  });
  $('#btOut').addEventListener('click', e => {
    if (e.target.closest('[data-act="bt"]')) { runBacktest(); return; }
    const m = e.target.closest('[data-btm]');
    if (m) { st.btModel = m.dataset.btm; st.btTrade = null; renderBacktest(st.bt && st.bt.stats); if (st.tab === 'chart') renderChart({ data: false }); return; }
    const tr = e.target.closest('[data-tk]');
    if (tr) { selectTrade(tr.dataset.tk, true); return; }
    if (e.target.closest('[data-btall]')) { st.btAll = !st.btAll; renderBacktest(st.bt && st.bt.stats); }
  });
  $('#btOut').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('[data-tk]'); if (tr) { e.preventDefault(); selectTrade(tr.dataset.tk, true); }
  });
}

function btProgress(p) {
  const frac = typeof p === 'number' ? p : p?.pct != null ? p.pct : p?.total ? p.done / p.total : 0;
  st.btPct = Math.max(0, Math.min(1, frac || 0));
  const bar = $('#btProg i'); if (bar) bar.style.width = Math.round(st.btPct * 100) + '%';
  const stat = $('#btStat');
  if (stat && p && typeof p === 'object' && p.phase) stat.textContent = `${PHASE[p.phase] || p.phase}${p.phase === 'skor' && p.total ? ` ${p.done}/${p.total}` : ''}…`;
  for (const el of $$('.calib .btpct')) el.textContent = Math.round(st.btPct * 100) + '%';
}

export async function runBacktest() {
  if (!st.B || typeof st.B.backtest !== 'function' || st.btBusy) return null;
  st.btBusy = true; st.btPct = 0;
  const btn = $('#btnBt'), prog = $('#btProg'), stat = $('#btStat');
  if (btn) { btn.disabled = true; btn.textContent = 'Menghitung…'; }
  if (prog) { prog.classList.add('on'); prog.firstElementChild.style.width = '0%'; }
  renderCards();
  try {
    // the data on screen must be the data of the current prefs (instrument / source / exec TF / seconds window)
    for (let k = 0; k < 3 && (st.busy || !marketFits(prefs())); k++) { while (st.busy) await sleep(120); if (!marketFits(prefs())) await check(); }
    while (st.busy) await sleep(120);
    const P = prefs(), m = st.market;
    if (!m || !marketFits(P)) throw new Error(st.err || 'data Gate belum termuat');
    if (stat) stat.textContent = 'Menyiapkan engine di seluruh data…';
    await sleep(30);                                        // let the status paint before the synchronous engine runs
    const t0 = performance.now();
    const stats = await st.B.backtest(m, P, btProgress);
    const ms = Math.round(performance.now() - t0);
    st.bt = { stats, P, ms, at: Date.now() / 1000, inst: P.instrument, src: srcOf(P), tf: P.execTf, sig: btSig(P) };
    st.btModel = P.entry; st.btTrade = null; st.btAll = false;
    if (stat) stat.innerHTML = `Selesai dalam <b class="${ms > 10000 ? 'neg' : ''}">${msTxt(ms)}</b> di browser ini · ${esc(INSTR[P.instrument].name)} ${esc(srcOf(P))} · exec ${esc(P.execTf)} · data s/d ${wib(stats.meta.now, false, true)} WIB` +
      (ms > 10000 ? ' <span class="neg">(lebih dari 10 s — coba kurangi menit data detik di Setelan)</span>' : '');
    renderBacktest(stats);
    renderCards();
    if (st.tab === 'chart') renderChart({ data: false });
    return stats;
  } catch (e) {
    if (stat) stat.innerHTML = `<span class="neg">Backtest gagal: ${esc(e?.message || e)}</span>`;
    return null;
  } finally {
    st.btBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = st.bt ? 'Jalankan ulang' : 'Jalankan backtest'; }
    if (prog) setTimeout(() => prog.classList.remove('on'), 600);
    const cp = $('#btnBtCopy'); if (cp) cp.hidden = !st.bt || typeof st.B.backtestText !== 'function';
    renderCards();
  }
}

export function renderBacktest(stats) {
  const out = $('#btOut'); if (!out) return;
  if (!stats) { out.innerHTML = '<div class="empty" style="margin-top:12px">Belum ada hasil backtest.</div>'; return; }
  if (!st.bt || st.bt.stats !== stats) {   // stats computed elsewhere (debug handle): show them as the current run
    const P = prefs();
    st.bt = { stats, P, ms: null, at: Date.now() / 1000, inst: stats.meta.inst, src: stats.meta.source || srcOf(P), tf: stats.meta.execTf, sig: btSig(P) };
  }
  try {
    out.innerHTML = btHtml(stats);
    st.btStaleShown = btStaleKey();
    renderBtCurve();
  } catch (e) { out.innerHTML = `<div class="empty">Gagal menampilkan hasil backtest: ${esc(e?.message || e)}</div>`; }
}

function btHtml(S) {
  const M = S.meta, B = st.bt, id = btMod(), px = btPx(S);
  const days = (M.to - M.from) / 86400;
  const sk = M.skipped || {}, skN = (sk.dir || 0) + (sk.warmup || 0) + (sk.notLive || 0) + (sk.error || 0);
  const C = S.coverage || { full: 0, partial: 0, none: 0, secTfs: [], ranges: {} };
  const h = [];

  // stale / mismatch banner
  const R = st.R, warn = [];
  if (R && !btFits(B, R)) warn.push(`Hasil ini untuk ${M.name} ${M.source || ''} exec ${M.execTf}, layar sekarang ${R.inst.name} ${R.source} ${R.exec.tf}.`);
  else if (B.sig !== btSig(prefs())) warn.push('Setelan (RR / broker / engine / arah / batas limit) berubah sejak backtest ini.');
  if (warn.length) h.push(`<div class="note-b warn">${esc(warn.join(' '))} <button type="button" class="linkbtn" data-act="bt">Jalankan ulang</button></div>`);

  // honest sample-size banner
  const smallM = MODEL_IDS.filter(m => S.summary[m].n < SMALL_N);
  const honest = [`Riwayat ${days < 1.5 ? Math.round(days * 24) + ' jam' : '± ' + Math.round(days) + ' hari'} (${idn(M.bars)} candle ${M.execTf}) dan ${idn(M.scored)} setup — ini kalibrasi kasar, bukan bukti edge.`];
  if (smallM.length) honest.push(`Sampel kecil (< ${SMALL_N} trade): ${smallM.map(m => `${MODEL_NAME[m]} ${S.summary[m].n}`).join(', ')}.`);
  honest.push(`Baris dengan < ${SMALL_N} trade ditandai “kecil”: win% dan avg R-nya bisa berubah jauh dengan beberapa trade lagi.`);
  const tiny = MODEL_IDS.map(m => { const t = S.trades.filter(x => x.model === m && x.reason !== 'open' && x.costR > 1); return t.length ? `${MODEL_NAME[m]} ${t.length} (${sgnR(t.reduce((a, x) => a + x.R, 0), 1)}R)` : ''; }).filter(Boolean);
  if (tiny.length) honest.push(`Trade dengan risk lebih kecil dari biaya (fill dekat SL, R ekstrem): ${tiny.join(', ')} — ikut dihitung di total; lihat bucket skornya.`);
  const rcN = MODEL_IDS.map(m => S.summary[m].cancelRc ? `${MODEL_NAME[m]} ${S.summary[m].cancelRc}` : '').filter(Boolean);
  if (rcN.length) honest.push(`Tidak di-entry karena risk/biaya di harga fill < ${M.minRcFill}: ${rcN.join(', ')} setup (batal “rc”).`);
  h.push(`<div class="note-b warn bt-honest"><b>Baca dengan hati-hati.</b> ${esc(honest.join(' '))}</div>`);

  // meta facts
  const rng = tf => C.ranges && C.ranges[tf] ? `${tf} dari ${wib(C.ranges[tf].from, tf.endsWith('s'), true)}` : tf;
  h.push(`<div class="facts bt-facts">
    <span class="k">Data</span><span class="v">${esc(M.name)} (${esc(M.contract || '?')}, ${esc(M.source || '?')}) · exec ${esc(M.execTf)} · ${wib(M.from, false, true)} → ${wib(M.to, false, true)} WIB</span>
    <span class="k">Setup</span><span class="v">${idn(M.confirmed)} terkonfirmasi · ${idn(M.scored)} dinilai${skN ? ` · dilewati ${[sk.dir && `${sk.dir} arah`, sk.warmup && `${sk.warmup} pemanasan`, sk.notLive && `${sk.notLive} sudah selesai saat konfirmasi`, sk.error && `${sk.error} error`].filter(Boolean).join(', ')}` : ''}</span>
    <span class="k">TF</span><span class="v">HTF ${esc((M.htfs || []).join(' + ') || '—')} · LTF ${esc((M.srcTfs || []).join(', ') || '—')}${M.dir !== 'both' ? ` · hanya ${esc(M.dir)}` : ''}</span>
    <span class="k">Aturan</span><span class="v">RR 1:${M.rr} · limit berlaku ${M.limitBars} candle · tahan maks ${M.maxHoldBars} candle${M.minRcFill > 0 ? ` · entry hanya kalau risk/biaya di fill ≥ ${M.minRcFill}` : ' · tanpa cek risk/biaya saat fill'}${M.flatAtBreak ? ' · tutup sebelum jeda market' : ''}</span>
    <span class="k">Biaya</span><span class="v">${M.broker.cost.toFixed(3)}/trade (spread ${M.broker.spread} + komisi ${(M.broker.comm / M.broker.lot).toFixed(3)} + slip ${M.broker.slip.toFixed(3)}) · dipotong di tiap R</span>
    <span class="k">Data detik</span><span class="v">penuh ${C.full} · sebagian ${C.partial} · tanpa detik ${C.none}${C.secTfs && C.secTfs.length ? ` (${esc(C.secTfs.map(rng).join(', '))})` : ' (tidak ada data detik)'}</span>
    <span class="k">Waktu</span><span class="v">${B.ms != null ? `${msTxt(B.ms)} di browser · ` : ''}engine ${Math.round(S.timing.prepareMs)} ms · skor ${Math.round(S.timing.scoreMs)} ms · simulasi ${Math.round(S.timing.simMs)} ms</span>
  </div>`);

  // per-model summary cards
  h.push(`<h4 class="bt-h">Ringkasan per model <small>RR 1:${M.rr} · R sudah dipotong biaya · klik model untuk detail</small></h4><div class="btm-grid">${MODEL_IDS.map(m => btModelCard(S, m, m === id)).join('')}</div>`);

  // equity curve
  h.push(`<h4 class="bt-h">Kurva ekuitas (R kumulatif) <small>urut waktu fill · RR 1:${M.rr} · tanpa trade yang masih jalan</small></h4>
    <div class="btleg">${MODEL_IDS.map(m => `<button type="button" data-btm="${m}" class="${m === id ? 'on' : ''}"><i style="background:${BT_COL[m]}"></i>${MODEL_NAME[m]} <span class="mono">${sgnR(S.summary[m].totalR, 1)}R</span></button>`).join('')}</div>
    <div class="btcurve" id="btCurve" role="img" aria-label="Kurva R kumulatif per model entry"></div>`);

  // detail tables for the selected model
  h.push(`<div class="bt-detail-h"><h4 class="bt-h" style="margin:0">Detail model</h4><div class="seg" role="group" aria-label="Model backtest">${MODEL_IDS.map(m => `<button type="button" data-btm="${m}" aria-pressed="${m === id}">${MODEL_NAME[m]}</button>`).join('')}</div></div>`);
  h.push('<div class="btt-grid">');
  h.push(btRRTable(S, id));
  h.push(btGroupTable(`Per bucket skor`, `skor ${MODEL_NAME[id]} saat konfirmasi`, S.byBucket[id], 'bucket', k => `${k}–${k + 9}`));
  const gA = ((st.S.RUBRIC || {}).grades || []).find(g => g.id === 'A');
  h.push(btGroupTable('Per grade OB sweep', gA ? `A = ${gA.text}` : '', S.byGrade[id], 'grade', k => `grade ${k}`));
  h.push(btGroupTable('Per cakupan data detik', 'dipisah: penuh / sebagian / tanpa', S.byCoverage[id], 'cov', k => COV_NAME[k] || k));
  h.push(btGroupTable('Per label skor', '', S.byLabel[id], 'label', k => k));
  h.push(btGroupTable('Per arah', '', S.byDir[id], 'dir', k => k));
  h.push('</div>');

  // trade list
  h.push(btTradeList(S, id, px));

  // notes from the module
  if (S.notes && S.notes.length) h.push(`<div class="notes" style="margin-top:12px">${S.notes.map(n => `<div class="note-b">${esc(n)}</div>`).join('')}</div>`);
  if (M.errors && M.errors.length) h.push(`<div class="note-b bad">Error saat menilai: ${esc(M.errors.join(' · '))}</div>`);
  return h.join('');
}

function btModelCard(S, m, on) {
  const s = S.summary[m], ci = wilson(s.wins, s.n), small = s.n < SMALL_N;
  const sel = st.bt && st.bt.P.entry === m;
  return `<button type="button" class="btm ${on ? 'on' : ''}" data-btm="${m}" aria-pressed="${on}">
    <span class="btm-h"><span><i class="sw" style="background:${BT_COL[m]}"></i>${MODEL_NAME[m]}</span>${sel ? '<span class="tagx">dipilih</span>' : ''}${small ? '<span class="tagx warn">sampel kecil</span>' : ''}</span>
    <span class="btm-big ${rCls(s.totalR)}">${sgnR(s.totalR, 1)}R</span>
    <span class="btm-rows">
      <span>trade</span><b>${s.n}</b>
      <span>win</span><b>${pctTxt(s.winPct)}${ci ? ` <small>(${Math.round(ci[0])}–${Math.round(ci[1])}%)</small>` : ''}</b>
      <span>avg R</span><b class="${rCls(s.avgR)}">${sgnR(s.avgR)} <small>kotor ${sgnR(s.avgRGross)}</small></b>
      <span>PF · max DD</span><b>${pfTxt(s)} · ${s.maxDD.toFixed(1)}R</b>
      ${s.totalRb != null ? `<span title="Hasil dalam kelipatan budget risiko kalau lot dihitung seperti di kartu (biaya ikut di lot)">× budget (lot kartu)</span><b class="${rCls(s.totalRb)}">${sgnR(s.totalRb, 1)} <small>DD ${s.maxDDb.toFixed(1)}</small></b>` : ''}
      <span>fill</span><b>${s.fills}/${s.valid}${s.fillPct != null ? ` (${pctTxt(s.fillPct)})` : ''}</b>
      <span>batal · kedaluwarsa</span><b title="batal SL ${s.cancelSl} · FVG ${s.cancelFvg} · gap ${s.cancelGap} · risk/biaya ${s.cancelRc || 0}">${s.cancelSl + s.cancelFvg + s.cancelGap + (s.cancelRc || 0)}${s.cancelRc ? ` <small>(rc ${s.cancelRc})</small>` : ''} · ${s.expired}${s.open + s.pending ? ` <small>· ${s.open + s.pending} jalan</small>` : ''}</b>
      <span>TP · SL · waktu</span><b>${s.tp} · ${s.sl} · ${s.time}${s.brk ? ` · jeda ${s.brk}` : ''}</b>
      <span>hold rata-rata</span><b>${s.avgHold == null ? '—' : `${Math.round(s.avgHold)} candle`}</b>
      <span>biaya per trade</span><b>${s.avgCostR == null ? '—' : s.avgCostR.toFixed(2) + 'R'}</b>
    </span>
    ${s.cross && s.cross.n ? `<span class="small dim">${s.cross.n} trade ditahan lewat jeda market (${sgnR(s.cross.totalR, 1)}R)</span>` : ''}
  </button>`;
}

function dbar(v, max) {
  if (v == null || !isFinite(v) || !max) return '<span class="dbar"></span>';
  const w = Math.min(50, Math.abs(v) / max * 50);
  return `<span class="dbar"><i class="${v >= 0 ? 'p' : 'n'}" style="width:${w.toFixed(1)}%"></i></span>`;
}
function smallTag(n) { return n < SMALL_N ? ' <span class="kecil" title="kurang dari 30 trade">kecil</span>' : ''; }

function btRRTable(S, id) {
  const rows = S.byRR[id] || [], rr = S.meta.rr;
  return `<div class="btt"><h5>Varian RR <small>TP saja; entry, SL dan fill sama</small></h5><div class="tscroll"><table class="bt-tbl">
    <thead><tr><th>RR</th><th>trade</th><th>win%</th><th>avg R</th><th>total R</th><th>PF</th><th>max DD</th><th>TP/SL/waktu</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.rr === rr ? 'cur' : ''} ${r.n < SMALL_N ? 'smalln' : ''}"><td>1:${r.rr}</td><td>${r.n}${smallTag(r.n)}</td><td>${pctTxt(r.winPct)}</td>
      <td class="${rCls(r.avgR)}">${sgnR(r.avgR)}</td><td class="${rCls(r.totalR)}">${sgnR(r.totalR, 1)}</td><td>${pfTxt(r)}</td><td>${r.maxDD.toFixed(1)}</td><td>${r.tp}/${r.sl}/${r.time}${r.brk ? '/' + r.brk : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function btGroupTable(title, sub, rows, key, fmt) {
  rows = rows || [];
  if (!rows.length) return `<div class="btt"><h5>${esc(title)}</h5><div class="empty">Tidak ada setup.</div></div>`;
  const max = Math.max(0, ...rows.filter(r => r.n && r.avgR != null).map(r => Math.abs(r.avgR)));
  return `<div class="btt"><h5>${esc(title)}${sub ? ` <small>${esc(sub)}</small>` : ''}</h5><div class="tscroll"><table class="bt-tbl">
    <thead><tr><th></th><th title="setup di mana model ini valid">setup</th><th title="trade selesai">trade</th><th>win%</th><th>avg R</th><th class="dbh" aria-hidden="true"></th><th>total R</th></tr></thead>
    <tbody>${rows.map(r => { const ci = wilson(r.wins, r.n); return `<tr class="${r.n < SMALL_N ? 'smalln' : ''}"><td>${esc(fmt(r[key]))}</td><td>${r.setups}</td><td>${r.n}${smallTag(r.n)}</td>
      <td title="${ci ? `interval 95%: ${Math.round(ci[0])}–${Math.round(ci[1])}%` : ''}">${pctTxt(r.winPct)}</td><td class="${rCls(r.avgR)}">${sgnR(r.avgR)}</td><td class="dbc">${dbar(r.avgR, max)}</td><td class="${rCls(r.totalR)}">${sgnR(r.totalR, 1)}</td></tr>`; }).join('')}</tbody></table></div></div>`;
}

function btTradeList(S, id, px) {
  const all = S.trades.filter(t => t.model === id).sort((a, b) => b.fillT - a.fillT || b.id - a.id);
  const LIM = 25, list = st.btAll ? all : all.slice(0, LIM);
  if (!all.length) return `<h4 class="bt-h">Trade ${MODEL_NAME[id]}</h4><div class="empty">Belum ada trade untuk model ini.</div>`;
  const sameDay = all.every(t => sameDayWib(t.fillT, all[0].fillT));
  return `<h4 class="bt-h">Trade ${MODEL_NAME[id]} <small>terbaru dulu · klik baris untuk lihat di chart · harga ${S.meta.broker && S.meta.broker.offset ? 'Gate + offset' : 'Gate'}</small></h4>
    <div class="tscroll"><table class="bt-tbl trades">
    <thead><tr><th>fill (WIB)</th><th>arah</th><th>skor</th><th>grade</th><th>entry</th><th>SL</th><th>TP</th><th>keluar</th><th>R</th></tr></thead>
    <tbody>${list.map(t => `<tr data-tk="${esc(tradeKey(t))}" tabindex="0" class="${st.btTrade === tradeKey(t) ? 'sel' : ''}">
      <td>${wib(t.fillT, false, !sameDay)}</td><td class="tdir ${t.dir}">${t.dir === 'long' ? 'L' : 'S'}</td><td>${t.score}</td><td>${esc(t.grade)}</td>
      <td>${px(t.fill)} <small>${FILL_KIND[t.fillKind] || t.fillKind}</small></td><td>${px(t.sl)}</td><td>${px(t.tp)}</td>
      <td>${t.reason === 'open' ? '<span class="dim">jalan</span>' : `${REASON[t.reason] || t.reason} ${wib(t.exitT)} <small>${t.hold}c</small>`}</td>
      <td class="${t.reason === 'open' ? 'dim' : rCls(t.R)}"><b>${t.reason === 'open' ? '—' : sgnR(t.R)}</b></td></tr>`).join('')}</tbody></table></div>
    ${all.length > LIM ? `<div style="margin-top:8px"><button type="button" class="btn sm" data-btall="1">${st.btAll ? 'Tampilkan 25 terbaru' : `Tampilkan semua (${all.length})`}</button></div>` : ''}`;
}

// equity curve: inline SVG at the container's pixel width (re-rendered on resize / when the tab is shown)
function renderBtCurve() {
  const box = $('#btCurve'); if (!box || !st.bt) return;
  const W = Math.round(box.clientWidth); if (!W) return;
  const S = st.bt.stats, M = S.meta, sel = btMod();
  const series = MODEL_IDS.map(id => ({ id, pts: [[M.from, 0], ...(S.curve[id] || [])] }));
  const narrow = W < 520, H = narrow ? 210 : 270, pl = 44, pr = narrow ? 62 : 132, pt = 12, pb = 24;
  const x0 = M.from, x1 = M.to;
  let lo = 0, hi = 0;
  for (const s of series) for (const p of s.pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  if (hi - lo < 2) { hi += 1; lo -= 1; }
  const step = niceStep((hi - lo) / (narrow ? 4 : 6));
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = t => pl + (t - x0) / Math.max(1, x1 - x0) * (W - pl - pr), Y = v => pt + (hi - v) / (hi - lo) * (H - pt - pb);
  const g = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = Y(v).toFixed(1);
    g.push(`<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" class="${Math.abs(v) < 1e-9 ? 'zero' : 'grid'}"/><text x="${pl - 6}" y="${y}" class="ytick">${Math.abs(v) < 1e-9 ? '0' : sgnR(v, step < 1 ? 1 : 0)}</text>`);
  }
  // day ticks (00:00 WIB)
  const day = 86400, first = Math.ceil((x0 + 7 * 3600) / day) * day - 7 * 3600;
  const days = []; for (let t = first; t <= x1; t += day) days.push(t);
  const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor((W - pl - pr) / 62))));
  days.forEach((t, i) => { if (i % every) return; const x = X(t).toFixed(1); g.push(`<line x1="${x}" x2="${x}" y1="${pt}" y2="${H - pb}" class="vgrid"/><text x="${x}" y="${H - 6}" class="xtick">${wib(t, false, true).replace(/ \d\d:\d\d$/, '')}</text>`); });
  // lines (step after each trade), selected model on top
  const order = [...series].sort((a, b) => (a.id === sel) - (b.id === sel));
  const ends = [];
  for (const s of order) {
    let d = '', last = 0;
    s.pts.forEach((p, i) => { const x = X(p[0]).toFixed(1), y = Y(p[1]).toFixed(1); d += i ? `H${x}V${y}` : `M${x} ${y}`; last = p[1]; });
    d += `H${X(x1).toFixed(1)}`;
    g.push(`<path d="${d}" fill="none" stroke="${BT_COL[s.id]}" stroke-width="${s.id === sel ? 2.4 : 1.5}" stroke-opacity="${s.id === sel ? 1 : 0.75}" stroke-linejoin="round"/>`);
    ends.push({ id: s.id, v: last, y: Y(last) });
  }
  // direct labels at the right end, pushed apart
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const over = ends.length ? ends[ends.length - 1].y - (H - pb) : 0;
  if (over > 0) for (const e of ends) e.y -= over;
  for (const e of ends) g.push(`<circle cx="${(W - pr).toFixed(1)}" cy="${Y(e.v).toFixed(1)}" r="3" fill="${BT_COL[e.id]}"/><text x="${W - pr + 6}" y="${e.y.toFixed(1)}" class="elab${e.id === sel ? ' on' : ''}">${narrow ? '' : esc(MODEL_NAME[e.id]) + ' '}${sgnR(e.v, 1)}R</text>`);
  box.style.height = H + 'px';
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g.join('')}<line class="hair" x1="0" x2="0" y1="${pt}" y2="${H - pb}" visibility="hidden"/><rect class="hit" x="${pl}" y="${pt}" width="${Math.max(1, W - pl - pr)}" height="${H - pt - pb}" fill="transparent"/></svg><div class="bttip" hidden></div>`;
  const svg = box.firstElementChild, hair = svg.querySelector('.hair'), tip = box.querySelector('.bttip');
  const valAt = (pts, t) => { let a = 0, b = pts.length - 1, r = 0; while (a <= b) { const m = (a + b) >> 1; if (pts[m][0] <= t) { r = m; a = m + 1; } else b = m - 1; } return [pts[r][1], r]; };
  const move = e => {
    const rc = svg.getBoundingClientRect(), x = Math.max(pl, Math.min(W - pr, e.clientX - rc.left));
    const t = x0 + (x - pl) / Math.max(1, W - pl - pr) * (x1 - x0);
    hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const hd = document.createElement('div'); hd.className = 'tt-h'; hd.textContent = wib(t, false, true) + ' WIB'; tip.appendChild(hd);
    for (const s of series) {
      const [v, k] = valAt(s.pts, t), row = document.createElement('div'), sw = document.createElement('i'), b = document.createElement('b'), sp = document.createElement('span');
      sw.style.background = BT_COL[s.id]; b.textContent = sgnR(v, 1) + 'R'; sp.textContent = ` ${MODEL_NAME[s.id]} · ${k} trade`;
      row.append(sw, b, sp); tip.appendChild(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth; tip.style.left = Math.max(0, Math.min(W - tw, x + (x > W / 2 ? -tw - 10 : 10))) + 'px'; tip.style.top = pt + 'px';
  };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}
function niceStep(x) {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9))), f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// ── backtest trades on the chart ───────────────────────────────────────────────────────────────────────────────────────
function findTrade(key) {
  if (!st.bt || !key) return null;
  return st.bt.stats.trades.find(x => tradeKey(x) === key) || null;
}
export function selectTrade(key, toChart) {
  const x = findTrade(key); if (!x) return;
  st.btTrade = key; st.btModel = x.model;
  for (const r of $$('#btOut tr[data-tk]')) r.classList.toggle('sel', r.dataset.tk === key);
  if (toChart && st.market && st.market.bars[st.bt.tf]) { st.chartTf = st.bt.tf; showTab('chart', { btFocus: true }); }
  else if (st.tab === 'chart') renderChart({ data: false, btFocus: true });
}
function btOverlays(R, tf, t, n, out) {
  const B = st.bt;
  if (!B || !btSameData(B, R) || !n) return;
  const sec = TF_SEC[tf] || 60, tMin = t[0], tMax = t[n - 1] + sec, id = btMod();
  const inRange = x => x >= tMin && x < tMax;
  if (st.ui.layers.bt) {
    for (const x of B.stats.trades) {
      if (x.model !== id || !inRange(x.fillT)) continue;
      out.marks.push({ t: x.fillT, pos: x.isBull ? 'below' : 'above', shape: x.isBull ? 'arrowUp' : 'arrowDown', color: BT_COL[id], text: '' });
      if (x.reason !== 'open' && inRange(x.exitT - 1)) out.marks.push({ t: x.exitT - 1, px: x.exit, pos: 'price', shape: 'circle', color: x.R > 0 ? '#7EE08A' : '#FF7A6B', text: sgnR(x.R, 1) + 'R' });
    }
  }
  const x = findTrade(st.btTrade);
  if (x && inRange(x.fillT)) {
    const t1 = x.reason === 'open' ? null : x.exitT;
    out.zones.push({ t0: x.fillT, t1, top: Math.max(x.fill, x.tp), bot: Math.min(x.fill, x.tp), fill: 'rgba(126,224,138,.13)', line: 'rgba(126,224,138,.55)' });
    out.zones.push({ t0: x.fillT, t1, top: Math.max(x.fill, x.sl), bot: Math.min(x.fill, x.sl), fill: 'rgba(255,122,107,.13)', line: 'rgba(255,122,107,.55)' });
    out.segs.push({ t0: x.fillT, t1, px: x.fill, color: '#D9FF57', width: 2, label: `BT #${x.id} ${x.dir.toUpperCase()} skor ${x.score} · ${REASON[x.reason] || x.reason}${x.reason === 'open' ? '' : ' ' + sgnR(x.R) + 'R'}`, labelColor: '#D9FF57', below: !x.isBull });
    if (!st.ui.layers.bt) out.marks.push({ t: x.fillT, pos: x.isBull ? 'below' : 'above', shape: x.isBull ? 'arrowUp' : 'arrowDown', color: BT_COL[x.model], text: '' });
    out.btFocus = [x.fillT, t1 == null ? null : t1];
    out.box = null; out.lines = [];        // the picked backtest trade replaces the live setup's position box until cleared
  }
}
function renderBtSelInfo(R) {
  const el = $('#btSelInfo'); if (!el) return;
  const B = st.bt, x = findTrade(st.btTrade);
  if (!B || !btSameData(B, R)) { el.innerHTML = ''; return; }
  const n = B.stats.trades.filter(t => t.model === btMod()).length;
  let h = `<span>Backtest${B.tf !== R.exec.tf ? ` exec ${esc(B.tf)}` : ''}: panah <i class="sw" style="background:${BT_COL[btMod()]}"></i>= fill ${esc(MODEL_NAME[btMod()])} (${n} trade), titik = keluar dengan R.</span>`;
  if (x) {
    const px = btPx(B.stats);
    h += ` <span><b>#${x.id} ${x.dir.toUpperCase()} skor ${x.score} · grade ${esc(x.grade)}</b> · fill ${wib(x.fillT, false, true)} @ <b class="mono">${px(x.fill)}</b> · SL ${px(x.sl)} · TP ${px(x.tp)} → ${x.reason === 'open' ? 'masih jalan' : `${REASON[x.reason] || x.reason} ${wib(x.exitT)} @ ${px(x.exit)} <b class="${rCls(x.R)}">${sgnR(x.R)}R</b>`}</span>
      <button type="button" class="linkbtn" id="btClear">hapus pilihan</button>`;
  }
  el.innerHTML = h;
  const c = $('#btClear'); if (c) c.addEventListener('click', () => { st.btTrade = null; renderChart({ data: false }); });
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function start() {
  loadPrefs();
  buildSettings(); buildLegend(); buildBacktestPane(); bindControls(); syncControls();
  renderClock(); setInterval(() => { renderClock(); }, 1000);
  window.addEventListener('resize', () => {
    if (st.chart && st.tab === 'chart') st.chart.resize(Math.max(340, Math.min(620, window.innerHeight - 280)));
    clearTimeout(renderBtCurve.h); if (st.tab === 'bt') renderBtCurve.h = setTimeout(renderBtCurve, 120);
  });
  window.liqxmDesk = Object.freeze({ renderBacktest, runBacktest, check, showTab, selectTrade,
    state: () => ({ R: st.R, market: st.market, prefs: prefs(), bt: st.bt, btModel: st.btModel, btTrade: st.btTrade, sel: st.sel, tab: st.tab, chartTf: st.chartTf }) });
  check();
}

(async () => {
  let pw = ''; try { pw = sessionStorage.getItem(PW_KEY) || ''; } catch (_) { }
  if (pw) {
    try { await unlock(pw); return; }
    catch (err) {
      if (wrongPw(err)) { try { sessionStorage.removeItem(PW_KEY); } catch (_) { } $('#gateErr').textContent = 'Sesi berakhir — masukkan passphrase lagi.'; }
      else $('#gateErr').textContent = errText(err, 'engine') + ' Muat ulang halaman untuk coba lagi.';   // passphrase kept: a reload retries
    }
  }
  $('#pw').focus();
})();
