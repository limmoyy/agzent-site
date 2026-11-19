// liqxm desk — public page shell. The strategy modules arrive encrypted (loader.js); this file only handles the gate,
// live data and the chart. PREVIEW build: the engine is not wired in yet.
import { decryptEngine, loadModules } from './loader.js?v=20261119a';
import { loadMarket, INSTR, TF_SEC, sessionOf, etClock, nyOffset } from './data.js?v=20261119a';
import { makeChart } from '../scanner/lab/chart.js?v=20261119a';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TFS = ['5m', '3m', '1m', '15s', '10s', '1s'];
const PW_KEY = 'agz_liqxm_pw';
const st = { inst: 'XAU', tf: '1m', market: null, engine: null, chart: null, busy: false };
const fmtT = (t, secs) => t == null ? '—' : new Date(t * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}) });

// ── gate ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function unlock(pw) {
  const payload = await decryptEngine(pw);
  st.engine = await loadModules(payload);
  $('#gate').remove(); $('#app').hidden = false;
  start();
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#pw').value; if (!pw) return;
  $('#gateBtn').disabled = true; $('#gateErr').textContent = '';
  try { await unlock(pw); try { sessionStorage.setItem(PW_KEY, pw); } catch (_) { } }
  catch (err) { $('#gateErr').textContent = /decrypt|operation/i.test(String(err?.name) + err?.message) || err?.name === 'OperationError' ? 'Passphrase salah.' : 'Gagal membuka: ' + (err?.message || err); }
  finally { const b = $('#gateBtn'); if (b) b.disabled = false; }
});
$('#lockBtn').addEventListener('click', () => { try { sessionStorage.removeItem(PW_KEY); } catch (_) { } location.reload(); });

// ── app ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function tickClock() {
  const now = Date.now() / 1000, k = etClock(now), ny = new Date((now + nyOffset(now) * 3600) * 1000);
  const hm = d => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  const wib = new Date((now + 7 * 3600) * 1000);
  $('#clock').innerHTML = `New York <b class="mono">${hm(ny)}</b> · WIB <b class="mono">${hm(wib)}</b><br>${k.open ? 'Market buka · sesi <b>' + esc(sessionOf(now)) + '</b>' : '<span style="color:var(--warn)">Market tutup</span>'}`;
}

function renderLadder(m) {
  $('#ladder').innerHTML = TFS.map(tf => {
    const b = m?.bars[tf];
    if (!b) return `<div class="tf off"><div class="n">${tf}</div><div class="s no">tidak tersedia</div></div>`;
    const n = b.t.length, last = n ? b.c[n - 1] : null, d = m.inst.digits;
    return `<div class="tf"><div class="n">${tf}</div><div class="s"><span class="ok">●</span> ${n.toLocaleString('id-ID')} candle<br>${esc(fmtT(b.t[0], TF_SEC[tf] < 60))} → ${esc(fmtT(n ? b.t[n - 1] + b.sec : null, TF_SEC[tf] < 60))}<br><span class="mono">${last == null ? '—' : last.toFixed(d)}</span></div></div>`;
  }).join('');
}

function renderTfSeg(m) {
  $('#tfSeg').innerHTML = TFS.filter(tf => m?.bars[tf]).map(tf => `<button data-v="${tf}" aria-pressed="${tf === st.tf}">${tf}</button>`).join('');
}

function renderChart() {
  const m = st.market; if (!m) return;
  if (!m.bars[st.tf]) st.tf = '1m';
  if (!st.chart) st.chart = makeChart($('#chBox'), { height: Math.max(360, Math.min(560, window.innerHeight - 300)) });
  const b = m.bars[st.tf];
  st.chart.setBars(b, m.inst.digits, `${m.inst.name} · ${st.tf} · ${m.contract}`);
  st.chart.showRecent(st.tf.endsWith('s') ? 240 : 180);
}

async function refresh() {
  if (st.busy) return; st.busy = true;
  $('#reload').disabled = true; $('#status').textContent = 'Memuat data…';
  try {
    const t0 = performance.now();
    st.market = await loadMarket(st.inst, { tradeMinutes: 30 });
    renderLadder(st.market); renderTfSeg(st.market); renderChart();
    const m = st.market;
    $('#status').textContent = `${m.inst.name} ${m.price?.toFixed(m.inst.digits)} · ${Math.round(performance.now() - t0)} ms · ${m.notes.join(' ')}`;
  } catch (e) { $('#status').textContent = 'Gagal ambil data: ' + (e?.message || e); }
  finally { st.busy = false; $('#reload').disabled = false; }
}

function start() {
  tickClock(); setInterval(tickClock, 15000);
  $('#instSeg').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v || v === st.inst) return;
    st.inst = v; for (const b of $('#instSeg').children) b.setAttribute('aria-pressed', b.dataset.v === v);
    refresh();
  });
  $('#tfSeg').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v; if (!v) return;
    st.tf = v; for (const b of $('#tfSeg').children) b.setAttribute('aria-pressed', b.dataset.v === v);
    renderChart();
  });
  $('#reload').addEventListener('click', refresh);
  refresh();
}

(async () => {
  let pw = ''; try { pw = sessionStorage.getItem(PW_KEY) || ''; } catch (_) { }
  if (pw) { try { await unlock(pw); return; } catch (_) { try { sessionStorage.removeItem(PW_KEY); } catch (e) { } } }
  $('#pw').focus();
})();
