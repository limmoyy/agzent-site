// Thin wrapper over TradingView Lightweight Charts v5 (self-hosted in ../vendor, Apache-2.0).
// Candles + volume + EMAs, trade markers, price lines, and TradingView-style long/short position boxes
// (green entry→target, red entry→stop, the result shaded on top) painted by the chart itself as a series primitive,
// so they stay on the candles while panning, zooming or dragging the price axis.
// Times are shifted to WIB (UTC+7) because the library shows timestamps as-is.
const WIB = 7 * 3600;
export const toChartTime = t => t + WIB;

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
export function palette() {
  return {
    bg: css('--panel', '#211917'), text: css('--muted', '#B5A6A2'), grid: 'rgba(224,209,209,.06)', axis: 'rgba(224,209,209,.16)',
    up: css('--ok', '#7EE08A'), down: css('--bad', '#FF7A6B'), lime: css('--lime', '#D9FF57'), warn: css('--warn', '#FFC857'),
    info: css('--info', '#8EC5FF'), blush: css('--blush', '#E0D1D1'),
  };
}

export function priceFormatter(digits) {
  return p => Number(p).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const ok = v => v != null && v === v;
const GREEN = { fill: 'rgba(126,224,138,.14)', line: 'rgba(126,224,138,.5)', res: 'rgba(126,224,138,.28)', text: '#7EE08A' };
const RED = { fill: 'rgba(255,122,107,.14)', line: 'rgba(255,122,107,.5)', res: 'rgba(255,122,107,.3)', text: '#FF7A6B' };

export function makeChart(el, { height = 520 } = {}) {
  const L = window.LightweightCharts, C = palette();
  el.style.position = 'relative';
  el.style.height = height + 'px';
  const chart = L.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontSize: 11, attributionLogo: true },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.axis, scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: { borderColor: C.axis, timeVisible: true, secondsVisible: false, rightOffset: 8 },
    crosshair: { mode: L.CrosshairMode.Normal },
  });
  const candle = chart.addSeries(L.CandlestickSeries, { upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false, priceLineVisible: true });
  const vol = chart.addSeries(L.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  const emaS = [['#8EC5FF', 1], ['#FFC857', 1], ['#E0D1D1', 2]].map(([color, w]) =>
    chart.addSeries(L.LineSeries, { color, lineWidth: w, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }));
  const markers = L.createSeriesMarkers(candle, []);
  let lines = [], boxes = [], times = [], fmt = v => String(v), requestUpdate = () => { };
  // keep the stop/targets of the boxes on screen inside the price scale (autoscale only looks at candles otherwise);
  // a box scrolled out of view must not squash the candles that are in view
  candle.applyOptions({ autoscaleInfoProvider: orig => {
    const r = orig(), vr = chart.timeScale().getVisibleLogicalRange();
    if (!r || !vr) return r;
    const keep = boxes.filter(b => lgOf(b.t0) <= vr.to && (b.t1 ? lgOf(b.t1) : Infinity) >= vr.from).flatMap(b => [b.entry, b.sl, b.tp]).filter(ok);
    if (!keep.length) return r;
    return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...keep), maxValue: Math.max(r.priceRange.maxValue, ...keep) } };
  } });

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  el.appendChild(legend);

  // unix time → logical bar index. Inside a bar it interpolates; past the last candle it extrapolates by the bar
  // spacing (a planned exit or a limit's expiry can lie in the future).
  function lgOf(t) {
    const n = times.length;
    if (!n) return NaN;
    const sec = n > 1 ? times[n - 1] - times[n - 2] : 60;
    if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / sec;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; }
    return lo + Math.max(0, Math.min(1, (t - times[lo]) / sec));
  }
  const xOf = t => times.length ? chart.timeScale().logicalToCoordinate(lgOf(t)) : null;

  // Box: {t0, t1?, side?, entry, sl, tp?, tp1?, exit?, now?, label}. No t1 = runs to the right edge.
  // exit (closed trade) or now (open trade) shades entry → that price, green when it is in profit.
  function geometry(b, W) {
    if (!ok(b.entry) || !ok(b.sl)) return null;
    const yE = candle.priceToCoordinate(b.entry), yS = candle.priceToCoordinate(b.sl);
    let x0 = xOf(b.t0), x1 = b.t1 ? xOf(b.t1) : W;
    if (!ok(yE) || !ok(yS) || !ok(x0)) return null;
    if (!ok(x1)) x1 = W;
    x1 = Math.max(x1, x0 + 24);
    if (x1 < 0 || x0 > W) return null;
    const side = b.side || (b.sl < b.entry ? 1 : -1), yT = ok(b.tp) ? candle.priceToCoordinate(b.tp) : null;
    const res = ok(b.exit) ? b.exit : ok(b.now) ? b.now : null, yR = ok(res) ? candle.priceToCoordinate(res) : null;
    const xR = ok(b.exit) ? x1 : Math.min(x1, Math.max(x0 + 2, xOf(times[times.length - 1]) ?? x1));
    return { x0, x1, yE, yS, yT: ok(yT) ? yT : null, yR: ok(yR) ? yR : null, xR, side, good: ok(res) && (res - b.entry) * side >= 0,
      y1: ok(b.tp1) ? candle.priceToCoordinate(b.tp1) : null };
  }
  function rect(ctx, x0, x1, ya, yb, fill, line) {
    const y = Math.min(ya, yb), h = Math.max(1, Math.abs(yb - ya));
    ctx.fillStyle = fill; ctx.fillRect(x0, y, x1 - x0, h);
    if (line) { ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y) + 0.5, Math.round(x1 - x0) - 1, Math.round(h) - 1); }
  }
  function hline(ctx, x0, x1, y, color, dash = [], w = 1) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke(); ctx.restore();
  }
  // a text pill; `anchor` = the x it hangs from, extending right ('l') or left ('r'); y = its vertical centre
  function pill(ctx, text, x, y, anchor, color, W) {
    ctx.font = `600 11px ${css('--mono', 'ui-monospace, monospace')}`;
    const w = ctx.measureText(text).width + 12, h = 18;
    let left = anchor === 'r' ? x - w : x;
    left = Math.max(2, Math.min(left, W - w - 2));
    ctx.fillStyle = 'rgba(23,17,15,.82)';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(left, y - h / 2, w, h, 5) : ctx.rect(left, y - h / 2, w, h); ctx.fill();
    ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, left + 6, y + 0.5);
  }
  const pctTxt = (to, from) => `${Math.abs((to / from - 1) * 100).toFixed(2)}%`;

  function paintZones(ctx, W) {
    for (const b of boxes) {
      const g = geometry(b, W);
      if (!g) continue;
      rect(ctx, g.x0, g.x1, g.yE, g.yS, RED.fill, RED.line);
      if (g.yT != null) rect(ctx, g.x0, g.x1, g.yE, g.yT, GREEN.fill, GREEN.line);
      if (g.yR != null) {
        rect(ctx, g.x0, g.xR, g.yE, g.yR, g.good ? GREEN.res : RED.res);
        hline(ctx, g.x0, g.xR, g.yR, g.good ? GREEN.text : RED.text, [4, 3]);
      }
      if (g.y1 != null) hline(ctx, g.x0, g.x1, g.y1, 'rgba(126,224,138,.8)', [4, 3]);
      hline(ctx, g.x0, g.x1, g.yE, 'rgba(217,255,87,.9)', [], 1.5);
    }
  }
  function paintLabels(ctx, W) {
    for (const b of boxes) {
      const g = geometry(b, W);
      if (!g) continue;
      const narrow = g.x1 - g.x0 < 220, ax = narrow ? g.x1 - 4 : g.x0 + 4, an = narrow ? 'r' : 'l';
      // captions sit inside each zone at its far edge, or just outside when the zone is too thin
      const cap = (y, text, color) => {
        const dir = Math.sign(y - g.yE) || 1, inside = Math.abs(y - g.yE) >= 40;
        pill(ctx, text, ax, inside ? y - dir * 12 : y + dir * 12, an, color, W);
      };
      if (g.yT != null) cap(g.yT, `Target ${fmt(b.tp)} (${pctTxt(b.tp, b.entry)})`, GREEN.text);
      cap(g.yS, `Stop ${fmt(b.sl)} (${pctTxt(b.sl, b.entry)})`, RED.text);
      if (b.label) {
        // on the entry line, on the side away from the stop so it never covers the stop caption
        const away = -Math.sign(g.yS - g.yE) || -1;
        pill(ctx, b.label, ax, g.yE + away * 11, an, '#F3ECEA', W);
      }
    }
  }
  const view = (z, paint) => ({ zOrder: () => z, renderer: () => ({ draw: target => target.useMediaCoordinateSpace(({ context, mediaSize }) => paint(context, mediaSize.width)) }) });
  const views = [view('bottom', paintZones), view('top', paintLabels)];
  candle.attachPrimitive({ attached: p => { requestUpdate = p.requestUpdate; }, detached: () => { requestUpdate = () => { }; }, updateAllViews: () => { }, paneViews: () => views });

  chart.subscribeCrosshairMove(p => {
    if (!p || !p.time) { legend.innerHTML = legend.dataset.base || ''; return; }
    const d = p.seriesData.get(candle);
    if (d) legend.innerHTML = `${legend.dataset.base || ''} <span class="lg-o">O ${fmt(d.open)} H ${fmt(d.high)} L ${fmt(d.low)} C ${fmt(d.close)}</span>`;
  });

  return {
    chart, candle,
    setBars(b, digits, title = '') {
      times = b.t;
      fmt = priceFormatter(digits);
      chart.applyOptions({ localization: { priceFormatter: fmt } });
      candle.setData(b.t.map((t, i) => ({ time: toChartTime(t), open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] })));
      vol.setData(b.t.map((t, i) => ({ time: toChartTime(t), value: b.v[i], color: b.c[i] >= b.o[i] ? 'rgba(126,224,138,.28)' : 'rgba(255,122,107,.28)' })));
      legend.dataset.base = title; legend.innerHTML = title;
      requestUpdate();
    },
    setEmas(b, list) {
      list.forEach((arr, k) => emaS[k].setData(arr ? b.t.map((t, i) => ({ time: toChartTime(t), value: arr[i] })).filter(x => x.value === x.value) : []));
    },
    setMarkers(list) { markers.setMarkers([...list].sort((a, b) => a.time - b.time)); },
    setLines(list) {
      for (const pl of lines) candle.removePriceLine(pl);
      lines = list.filter(x => ok(x.price)).map(x => candle.createPriceLine({
        price: x.price, color: x.color, lineWidth: x.width || 1, lineStyle: x.style ?? 2, axisLabelVisible: true, title: x.title || '' }));
    },
    setBoxes(list) {
      boxes = list || [];
      requestUpdate();
    },
    focus(t0, t1, padBars = 40) {
      const ts = chart.timeScale(), i0 = times.findIndex(t => t >= t0), i1 = t1 ? times.findIndex(t => t >= t1) : times.length - 1;
      if (i0 < 0) return;
      ts.setVisibleLogicalRange({ from: Math.max(0, i0 - padBars), to: Math.min(times.length + 8, (i1 < 0 ? times.length : i1) + padBars) });
    },
    // `ahead` = empty bars kept right of the last candle (room for a live box that runs into the future)
    showRecent(nBars = 160, ahead = 8) { const n = times.length; chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - nBars), to: n + ahead }); },
    destroy() { chart.remove(); },
  };
}

/** Simple line/area chart for equity curves. points = [{t (unix s), v}]. */
export function makeLineChart(el, { height = 260, money = false } = {}) {
  const L = window.LightweightCharts, C = palette();
  el.style.height = height + 'px';
  const chart = L.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.axis }, timeScale: { borderColor: C.axis, timeVisible: true },
    localization: { priceFormatter: money ? (p => '$' + Number(p).toLocaleString('en-US', { maximumFractionDigits: 2 })) : (p => Number(p).toFixed(0) + ' bp') },
  });
  const s = chart.addSeries(L.BaselineSeries, { baseValue: { type: 'price', price: 0 }, lineWidth: 2,
    topLineColor: C.up, topFillColor1: 'rgba(126,224,138,.25)', topFillColor2: 'rgba(126,224,138,.02)',
    bottomLineColor: C.down, bottomFillColor1: 'rgba(255,122,107,.02)', bottomFillColor2: 'rgba(255,122,107,.25)', priceLineVisible: false });
  return {
    chart,
    set(points, base = 0) {
      s.applyOptions({ baseValue: { type: 'price', price: base } });
      const seen = new Map();
      for (const p of points) seen.set(toChartTime(p.t), p.v); // one value per timestamp (the last one)
      s.setData([...seen.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value })));
      chart.timeScale().fitContent();
    },
    destroy() { chart.remove(); },
  };
}
