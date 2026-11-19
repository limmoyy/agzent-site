// liqxm desk — chart wrapper over TradingView Lightweight Charts v5 (self-hosted in ../scanner/vendor, Apache-2.0).
// Drawing only (no analysis here): candles + volume, a zone primitive that paints rectangles (FVG / OB boxes) and
// horizontal segments (liqxm lines, swept-liquidity lines) in bar-time coordinates, a TradingView-style position box
// (entry → target green, entry → stop red), series markers and price lines. The primitive is painted by the chart itself,
// so everything stays glued to the candles while panning, zooming or dragging the price axis.
// Times are unix seconds and are shown in WIB (UTC+7); prices are Gate prices and get `offset` (broker − Gate) added.
const WIB = 7 * 3600;
export const toChartTime = t => t + WIB;

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function palette() {
  return {
    bg: css('--panel', '#211917'), text: css('--muted', '#B5A6A2'), grid: 'rgba(224,209,209,.06)', axis: 'rgba(224,209,209,.16)',
    up: css('--ok', '#7EE08A'), down: css('--bad', '#FF7A6B'),
  };
}
export function priceFormatter(digits) {
  return p => Number(p).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const ok = v => v != null && v === v && isFinite(v);
const GREEN = { fill: 'rgba(126,224,138,.13)', line: 'rgba(126,224,138,.55)', text: '#7EE08A' };
const RED = { fill: 'rgba(255,122,107,.13)', line: 'rgba(255,122,107,.55)', text: '#FF7A6B' };

/**
 * makeChart(el, { height }) → api
 *   setBars(bars, digits, title, offset)   bars = { t, o, h, l, c, v } (unix s, Gate prices)
 *   setZones(list)   [{ t0, t1|null (= right edge), top, bot, fill, line, dash, lw, label, labelColor }]
 *   setSegs(list)    [{ t0, t1|null, px, color, width, dash: [..]|null, label, labelColor, below }]
 *   setBox(box|null) { t0, t1|null, entry, sl, tp, label }  (position box of the selected setup)
 *   setMarkers(list) [{ t, px?, pos ('above'|'below'|'price'), shape, color, text }]
 *   setLines(list)   [{ px, color, title, style }]  (price-axis lines)
 *   focus(t0, t1, padBars), showRecent(nBars, ahead), destroy()
 */
export function makeChart(el, { height = 520 } = {}) {
  const L = window.LightweightCharts, C = palette();
  el.style.position = 'relative';
  el.style.height = height + 'px';
  const chart = L.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.axis, scaleMargins: { top: 0.08, bottom: 0.18 } },
    timeScale: { borderColor: C.axis, timeVisible: true, secondsVisible: false, rightOffset: 8 },
    crosshair: { mode: L.CrosshairMode.Normal },
  });
  const candle = chart.addSeries(L.CandlestickSeries, { upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false, priceLineVisible: true });
  const vol = chart.addSeries(L.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
  const markers = L.createSeriesMarkers(candle, []);
  let times = [], off = 0, digits = 2, fmt = v => String(v), requestUpdate = () => { };
  let zones = [], segs = [], box = null, lines = [];

  // keep the selected position box (stop / target) inside the price scale while it is in view
  candle.applyOptions({ autoscaleInfoProvider: orig => {
    const r = orig(), vr = chart.timeScale().getVisibleLogicalRange();
    if (!r || !vr || !box) return r;
    if (lgOf(box.t0) > vr.to || (box.t1 && lgOf(box.t1) < vr.from)) return r;
    // a level is pulled into view only when it does not more than triple the candle range (a far TP stays off-screen,
    // its caption is pinned to the pane edge instead of squashing the candles)
    const lo = r.priceRange.minValue, hi = r.priceRange.maxValue, span = Math.max(hi - lo, 1e-9);
    const keep = [box.entry, box.sl, box.tp].filter(ok).map(p => p + off).filter(p => p >= lo - span && p <= hi + span);
    if (!keep.length) return r;
    return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...keep), maxValue: Math.max(r.priceRange.maxValue, ...keep) } };
  } });

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  el.appendChild(legend);
  const legendBottom = () => { const h = legend.offsetHeight; return h ? legend.offsetTop + h : 24; };

  // unix time → logical bar index (interpolated inside a bar, extrapolated past the last candle)
  function lgOf(t) {
    const n = times.length;
    if (!n) return NaN;
    const sec = n > 1 ? times[n - 1] - times[n - 2] : 60;
    if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / sec;
    if (t <= times[0]) return (t - times[0]) / sec;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; }
    const step = lo + 1 < n ? times[lo + 1] - times[lo] : sec;
    return lo + Math.max(0, Math.min(1, (t - times[lo]) / Math.min(step, sec)));
  }
  // logicalToCoordinate() returns 0 for a non-integer logical index (Lightweight Charts maps only whole bars), so a time
  // inside a bar or past the last candle (e.g. the live price time) is interpolated between its two neighbouring bars.
  const xOf = t => {
    if (!times.length) return null;
    const lg = lgOf(t); if (!ok(lg)) return null;
    const ts = chart.timeScale(), i = Math.floor(lg), f = lg - i, a = ts.logicalToCoordinate(i);
    if (!f || a == null) return a;
    const b = ts.logicalToCoordinate(i + 1);
    return b == null ? a : a + f * (b - a);
  };
  const yOf = p => candle.priceToCoordinate(p + off);
  const barTime = t => { // open time of the bar that contains t (or the first bar)
    let lo = 0, hi = times.length - 1, r = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return times[r];
  };

  function xRange(t0, t1, W) {
    let x0 = xOf(t0), x1 = t1 == null ? W : xOf(t1);
    if (!ok(x0)) return null;
    if (!ok(x1)) x1 = W;
    if (x1 < x0 + 2) x1 = x0 + 2;
    if (x1 < 0 || x0 > W) return null;
    return [Math.max(-2, x0), Math.min(W + 2, x1)];
  }
  function rect(ctx, x0, x1, ya, yb, fill, line, dash, lw = 1) {
    const y = Math.min(ya, yb), h = Math.max(1, Math.abs(yb - ya));
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(x0, y, x1 - x0, h); }
    if (line) {
      ctx.save(); ctx.strokeStyle = line; ctx.lineWidth = lw; ctx.setLineDash(dash ? [4, 3] : []);
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y) + 0.5, Math.max(1, Math.round(x1 - x0) - 1), Math.max(1, Math.round(h) - 1));
      ctx.restore();
    }
  }
  function hline(ctx, x0, x1, y, color, dash, w = 1) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke(); ctx.restore();
  }
  function pill(ctx, text, x, y, anchor, color, W, small, rightPad = 2) {
    ctx.font = `600 ${small ? 10 : 11}px ${css('--mono', 'ui-monospace, monospace')}`;
    const w = ctx.measureText(text).width + (small ? 8 : 12), h = small ? 15 : 18;
    let left = anchor === 'r' ? x - w : x;
    left = Math.max(2, Math.min(left, W - w - rightPad));
    ctx.fillStyle = 'rgba(23,17,15,.82)';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(left, y - h / 2, w, h, 4) : ctx.rect(left, y - h / 2, w, h); ctx.fill();
    ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, left + (small ? 4 : 6), y + 0.5);
  }
  const pctTxt = (to, from) => `${Math.abs((to / from - 1) * 100).toFixed(2)}%`;

  function boxGeo(W) {
    const b = box;
    if (!b || !ok(b.entry) || !ok(b.sl)) return null;
    const xr = xRange(b.t0, b.t1 ?? null, W);
    if (!xr) return null;
    const yE = yOf(b.entry), yS = yOf(b.sl), yT = ok(b.tp) ? yOf(b.tp) : null;
    if (!ok(yE) || !ok(yS)) return null;
    return { x0: xr[0], x1: Math.max(xr[1], xr[0] + 24), yE, yS, yT: ok(yT) ? yT : null };
  }

  function paintBack(ctx, W, H) {
    for (const z of zones) {
      const xr = xRange(z.t0, z.t1, W); if (!xr) continue;
      const ya = yOf(z.top), yb = yOf(z.bot);
      if (!ok(ya) || !ok(yb) || (Math.max(ya, yb) < 0 || Math.min(ya, yb) > H)) continue;
      rect(ctx, xr[0], xr[1], ya, yb, z.fill, z.line, z.dash, z.lw || 1);
    }
    for (const s of segs) {
      const xr = xRange(s.t0, s.t1, W); if (!xr) continue;
      const y = yOf(s.px); if (!ok(y) || y < -2 || y > H + 2) continue;
      hline(ctx, xr[0], xr[1], y, s.color, s.dash, s.width || 1);
    }
    const g = boxGeo(W);
    if (g) {
      rect(ctx, g.x0, g.x1, g.yE, g.yS, RED.fill, RED.line);
      if (g.yT != null) rect(ctx, g.x0, g.x1, g.yE, g.yT, GREEN.fill, GREEN.line);
      hline(ctx, g.x0, g.x1, g.yE, 'rgba(217,255,87,.95)', null, 1.5);
    }
  }
  function paintFront(ctx, W, H) {
    for (const z of zones) {
      if (!z.label) continue;
      const xr = xRange(z.t0, z.t1, W); if (!xr || xr[0] < -1) continue;
      const ya = yOf(z.top), yb = yOf(z.bot); if (!ok(ya) || !ok(yb)) continue;
      const y = z.labelBottom ? Math.max(ya, yb) + 9 : Math.min(ya, yb) - 9;
      if (y < 0 || y > H) continue;
      pill(ctx, z.label, xr[0] + 2, y, 'l', z.labelColor || '#F3ECEA', W, true);
    }
    for (const s of segs) {
      if (!s.label) continue;
      const xr = xRange(s.t0, s.t1, W); if (!xr || xr[0] < -1) continue;
      const y = yOf(s.px); if (!ok(y) || y < 0 || y > H) continue;
      pill(ctx, s.label, s.labelAtEnd ? xr[1] : xr[0] + 2, y + (s.below ? 10 : -10), s.labelAtEnd ? 'r' : 'l', s.labelColor || s.color, W, true);
    }
    const g = boxGeo(W);
    if (g) {
      // RM: room for the Entry / SL / TP price-line titles that the chart draws at the pane's right edge.
      // Captions start right of the confirmation marker text (x0 + 36), or hug the box's right end when it is narrow.
      const b = box, RM = 64, narrow = g.x1 - g.x0 < 230, an = narrow ? 'r' : 'l';
      const ax = narrow ? Math.max(g.x0 + 4, Math.min(g.x1, W - RM) - 4) : g.x0 + 36;
      const top = legendBottom() + 12, bot = H - 42;       // below the (possibly wrapped) legend / above the attribution logo
      const placed = [];
      const free = y => placed.every(p => Math.abs(p - y) >= 19);
      const place = (y, prefer) => {                         // nearest free row, first in the preferred direction
        y = Math.max(top, Math.min(bot, y));
        for (let k = 0; k < 8; k++) for (const d of [prefer, -prefer]) {
          const yy = y + d * k * 19;
          if (yy >= top && yy <= bot && free(yy)) return yy;
        }
        return y;
      };
      const cap = (y, text, color) => {
        let yy, arrow = '';
        if (y < top - 9) { yy = top; arrow = y < 0 ? ' ↑' : ''; }   // off-screen (or hidden under the legend): pinned to the edge
        else if (y > H) { yy = bot; arrow = ' ↓'; }
        else { const dir = Math.sign(y - g.yE) || 1, inside = Math.abs(y - g.yE) >= 40; yy = inside ? y - dir * 12 : y + dir * 12; }
        yy = place(yy, yy <= top + 1 ? 1 : yy >= bot - 1 ? -1 : 1);
        pill(ctx, text + arrow, ax, yy, an, color, W, false, RM); placed.push(yy);
      };
      if (g.yT != null) cap(g.yT, `TP ${fmt(b.tp + off)} (${pctTxt(b.tp, b.entry)})`, GREEN.text);
      cap(g.yS, `SL ${fmt(b.sl + off)} (${pctTxt(b.sl, b.entry)})`, RED.text);
      if (b.label) {
        const away = -Math.sign(g.yS - g.yE) || -1;          // TP side of the entry line first, then the SL side, then further out
        let yy = null;
        for (const c of [g.yE + away * 11, g.yE - away * 11, g.yE + away * 30, g.yE - away * 30, g.yE + away * 49]) if (c >= top && c <= bot && free(c)) { yy = c; break; }
        if (yy == null) yy = place(g.yE + away * 11, away);
        pill(ctx, b.label, ax, yy, an, '#F3ECEA', W, false, RM); placed.push(yy);
      }
    }
  }
  const view = (z, paint) => ({ zOrder: () => z, renderer: () => ({ draw: target => target.useMediaCoordinateSpace(({ context, mediaSize }) => paint(context, mediaSize.width, mediaSize.height)) }) });
  const views = [view('bottom', paintBack), view('top', paintFront)];
  candle.attachPrimitive({ attached: p => { requestUpdate = p.requestUpdate; }, detached: () => { requestUpdate = () => { }; }, updateAllViews: () => { }, paneViews: () => views });

  chart.subscribeCrosshairMove(p => {
    if (!p || !p.time) { legend.innerHTML = legend.dataset.base || ''; return; }
    const d = p.seriesData.get(candle);
    if (d) legend.innerHTML = `${legend.dataset.base || ''} <span class="lg-o">O ${fmt(d.open)} H ${fmt(d.high)} L ${fmt(d.low)} C ${fmt(d.close)}</span>`;
  });

  return {
    chart, candle,
    setBars(b, dg, title = '', offset = 0) {
      times = b.t; off = +offset || 0; digits = dg;
      fmt = priceFormatter(digits);
      chart.applyOptions({ localization: { priceFormatter: fmt }, timeScale: { secondsVisible: (b.sec || 60) < 60 } });
      candle.setData(b.t.map((t, i) => ({ time: toChartTime(t), open: b.o[i] + off, high: b.h[i] + off, low: b.l[i] + off, close: b.c[i] + off })));
      vol.setData(b.t.map((t, i) => ({ time: toChartTime(t), value: b.v[i] || 0, color: b.c[i] >= b.o[i] ? 'rgba(126,224,138,.25)' : 'rgba(255,122,107,.25)' })));
      legend.dataset.base = title; legend.innerHTML = title;
      requestUpdate();
    },
    setZones(list) { zones = list || []; requestUpdate(); },
    setSegs(list) { segs = list || []; requestUpdate(); },
    setBox(b) { box = b || null; requestUpdate(); },
    setMarkers(list) {
      if (!times.length) { markers.setMarkers([]); return; }
      const out = (list || []).filter(m => ok(m.t)).map(m => {
        const o = { time: toChartTime(barTime(m.t)), color: m.color, shape: m.shape || 'circle', text: m.text || '', size: m.size || 1 };
        if (m.pos === 'price' && ok(m.px)) { o.position = m.shape === 'arrowDown' ? 'atPriceBottom' : m.shape === 'arrowUp' ? 'atPriceTop' : 'atPriceMiddle'; o.price = m.px + off; }
        else o.position = m.pos === 'below' ? 'belowBar' : 'aboveBar';
        return o;
      });
      out.sort((a, b) => a.time - b.time);
      markers.setMarkers(out);
    },
    setLines(list) {
      for (const pl of lines) candle.removePriceLine(pl);
      lines = (list || []).filter(x => ok(x.px)).map(x => candle.createPriceLine({
        price: x.px + off, color: x.color, lineWidth: x.width || 1, lineStyle: x.style ?? 2, axisLabelVisible: true, title: x.title || '' }));
    },
    focus(t0, t1, padBars = 30) {
      if (!times.length) return;
      const i0 = Math.floor(lgOf(t0)), i1 = t1 == null ? times.length - 1 : Math.ceil(lgOf(t1));
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(-5, i0 - padBars), to: Math.max(i0 + 20, i1) + Math.max(8, Math.round(padBars / 3)) });
    },
    showRecent(nBars = 160, ahead = 10) { const n = times.length; chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - nBars), to: n + ahead }); },
    resize(h) { el.style.height = h + 'px'; },
    destroy() { chart.remove(); },
  };
}
