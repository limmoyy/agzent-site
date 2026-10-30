// /alerts: passphrase gate (same as /scanner), then the encrypted snapshot the VPS signal service publishes
// (alerts.manifest.json → alerts.<hash>.enc.json): the Telegram invite link, open setups/trades, recent signals.
import { decryptSnap } from '../scanner/lab/gate.js?v=20261029a';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtP = v => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumSignificantDigits: 6 });
const wib = iso => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const coin = s => String(s || '').replace(/USDT$/, '');
const REASON = { take_profit: 'TP2', stop_loss: 'stop', break_even: 'break-even', time_stop: '24 h time stop', limit_expired: 'expired' };

const SAMPLE = { event: 'setup', id: '3f1c9a0b5d2e7f41', source: 'agzent/claude-flush-reclaim', mode: 'paper', strategy: 'flush_reclaim_1h', symbol: 'NEARUSDT', exchange: 'gateio', contract: 'NEAR_USDT', side: 'long',
  signal_time: '2026-10-24T15:00:00.000Z', order: { type: 'limit', price: 4.32622, post_only: true, valid_until: '2026-10-24T18:00:00.000Z' }, stop_loss: 4.2101,
  take_profit: [{ price: 4.4423, size_pct: 50 }, { price: 4.6165, size_pct: 50 }], break_even_after_tp1: true, time_stop_hours: 24,
  risk: { stop_distance_pct: 2.683, risk_pct: 1, suggested_notional_usdt: null }, why: { range_atr: 2.1, volume_x: 3.4, lower_wick: 0.62, swept_low: 4.25 }, sent_at: '2026-10-24T15:01:16.000Z' };

function detail(e) {
  const tp = e.take_profit || [];
  switch (e.event) {
    case 'setup': return `${e.side === 'short' ? 'sell' : 'buy'} limit ${fmtP(e.order?.price)} until ${wib(e.order?.valid_until)} · SL ${fmtP(e.stop_loss)} · TP1 ${fmtP(tp[0]?.price)} · TP2 ${fmtP(tp[1]?.price)}`;
    case 'entry': return `filled ${fmtP(e.fill?.price)} · SL ${fmtP(e.stop_loss)} · TP1 ${fmtP(tp[0]?.price)} · TP2 ${fmtP(tp[1]?.price)}`;
    case 'tp1': return `TP1 ${fmtP(e.tp1?.price)} · stop → ${fmtP(e.new_stop_loss)}`;
    case 'exit': return `closed ${fmtP(e.exit?.price)} · ${REASON[e.exit?.reason] || e.exit?.reason || ''}`;
    case 'cancel': return `limit ${fmtP(e.order?.price)} not filled`;
    default: return '';
  }
}

function render(d) {
  $('#lastCheck').textContent = d ? `Checked ${wib(d.lastCheck)} WIB` : 'Not live yet';
  if (!d) {
    $('#stats').innerHTML = '';
    $('#joinBox').innerHTML = '<div class="muted">The signal service has not published yet — check back in a few minutes.</div>';
    $('#events').innerHTML = '<div class="empty">No signals yet.</div>'; $('#open').innerHTML = '<div class="muted">—</div>';
    $('#example').textContent = JSON.stringify(SAMPLE, null, 2); $('#exNote').textContent = '(sample)';
    return;
  }
  const closed = d.events.filter(e => e.event === 'exit'), won = closed.filter(e => e.exit?.net_bp > 0).length;
  $('#stats').innerHTML = [
    [d.tokens.length, 'tokens watched'], [d.open.length, 'open now'], [d.events.filter(e => e.event === 'setup').length, 'setups (recent)'],
    [closed.length ? `${won}/${closed.length}` : '—', 'recent trades won'], [d.subscribers, 'subscribers'],
  ].map(([v, k]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  $('#joinBox').innerHTML = d.invite
    ? `<a class="btn pri big" href="${esc(d.invite)}" target="_blank" rel="noopener">Open @${esc(d.bot)} on Telegram ↗</a><div style="margin-top:8px;text-align:right"><button class="btn sm" id="copyInv" type="button">Copy invite link</button></div>`
    : '<div class="muted">Invite link not available yet.</div>';
  $('#copyInv')?.addEventListener('click', async e => { try { await navigator.clipboard.writeText(d.invite); e.target.textContent = 'Copied ✓'; } catch (_) { e.target.textContent = d.invite; } });

  const ev = [...d.events].reverse().slice(0, 60);
  $('#events').innerHTML = ev.length ? `<div class="tblwrap" style="max-height:520px;overflow:auto"><table class="tk sm" style="min-width:560px"><thead><tr><th class="l">Time (WIB)</th><th class="l">Token</th><th class="l">Event</th><th class="l">Details</th><th>bp</th></tr></thead><tbody>
    ${ev.map(e => `<tr style="cursor:default"><td class="l">${esc(wib(e.sent_at))}</td><td class="l"><b>${esc(coin(e.symbol))}</b> <span class="sd ${e.side === 'short' ? 's' : 'l'}">${e.side === 'short' ? 'S' : 'L'}</span></td><td class="l"><span class="evt ${esc(e.event)}">${esc(e.event)}</span></td><td class="l" style="white-space:normal">${esc(detail(e))}</td><td class="${e.exit ? (e.exit.net_bp >= 0 ? 'pos' : 'neg') : ''}">${e.exit ? (e.exit.net_bp >= 0 ? '+' : '') + esc(e.exit.net_bp) : ''}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">No signals since the service started. Setups are rare — a few a week across ${esc(d.tokens.length)} tokens.</div>`;
  $('#open').innerHTML = d.open.length ? d.open.map(o => o.position
    ? `<div class="calc" style="margin-bottom:8px"><span><b>${esc(coin(o.symbol))}</b> <span class="evt entry">${o.position.side === -1 ? 'short' : 'long'}</span></span><span>entry ${esc(fmtP(o.position.entry))} · SL ${esc(fmtP(o.position.sl))}${o.position.tp1_hit ? ' · TP1 ✓' : ''}</span></div>`
    : `<div class="calc" style="margin-bottom:8px"><span><b>${esc(coin(o.symbol))}</b> <span class="evt setup">${o.pending.side === -1 ? 'sell' : 'buy'} limit</span></span><span>${esc(fmtP(o.pending.price))} until ${esc(wib(o.pending.valid_until))}</span></div>`).join('')
    : '<div class="muted">No setup or trade open right now.</div>';
  const ex = [...d.events].reverse().find(e => e.event === 'setup');
  $('#example').textContent = JSON.stringify(ex || SAMPLE, null, 2); $('#exNote').textContent = ex ? `(latest real setup, ${coin(ex.symbol)})` : '(sample)';
}

// ── gate ─────────────────────────────────────────────────────────────────────────────────────
let PW = '';
async function load(pw) {
  try { return await decryptSnap(pw, '', 'alerts'); }
  catch (err) { await decryptSnap(pw, '../scanner/'); return null; } // passphrase right, alerts not published yet
}
async function unlock(pw) { const d = await load(pw); PW = pw; document.body.classList.add('on'); render(d); }
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault(); const pw = $('#pw').value, btn = $('#gateBtn'), err = $('#gerr');
  btn.disabled = true; btn.textContent = 'Checking…'; err.textContent = '';
  try { await unlock(pw); try { sessionStorage.setItem('agz_bb_pw', pw); } catch (_) { } }
  catch (_) { err.textContent = 'Wrong passphrase, or the check file could not be read.'; btn.disabled = false; btn.textContent = 'Unlock'; }
});
$('#lockBtn').addEventListener('click', () => { try { sessionStorage.removeItem('agz_bb_pw'); } catch (_) { } location.reload(); });
setInterval(async () => { if (PW && !document.hidden) { try { render(await load(PW)); } catch (_) { } } }, 5 * 60 * 1000);
(async () => {
  let pw = ''; try { pw = sessionStorage.getItem('agz_bb_pw') || ''; } catch (_) { }
  if (pw) { try { await unlock(pw); return; } catch (_) { try { sessionStorage.removeItem('agz_bb_pw'); } catch (e) { } } }
})();
