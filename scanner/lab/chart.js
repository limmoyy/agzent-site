// Thin wrapper over TradingView Lightweight Charts v5 (self-hosted in ../vendor, Apache-2.0).
// Candles + volume + EMAs, trade markers, price lines, and a TradingView-style "long position" box
// (green entry→TP, red entry→SL) drawn as an HTML overlay that follows the chart's coordinates.
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
  let lines = [], boxes = [], times = [], keep = [];
  // keep the live setup's stop/targets inside the price scale (autoscale only looks at candles otherwise)
  candle.applyOptions({ autoscaleInfoProvider: orig => {
    const r = orig();
    if (!r || !keep.length) return r;
    return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...keep), maxValue: Math.max(r.priceRange.maxValue, ...keep) } };
  } });

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;overflow:hidden';
  el.appendChild(overlay);
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  el.appendChild(legend);

  function drawBoxes() {
    overlay.textContent = '';
    if (!boxes.length || !times.length) return;
    const ts = chart.timeScale(), w = el.clientWidth - (chart.priceScale('right').width() || 60);
    for (const b of boxes) {
      let x0 = ts.timeToCoordinate(toChartTime(b.t0)), x1 = b.t1 ? ts.timeToCoordinate(toChartTime(b.t1)) : w;
      if (x0 == null) { const r = ts.getVisibleRange(); if (!r || toChartTime(b.t0) > r.to) continue; x0 = 0; }
      if (x1 == null) x1 = w;
      x1 = Math.min(Math.max(x1, x0 + 24), w);
      const yE = candle.priceToCoordinate(b.entry), yT = candle.priceToCoordinate(b.tp), yS = candle.priceToCoordinate(b.sl);
      if (yE == null || yT == null || yS == null) continue;
      const mk = (ya, yb, bg, bd) => {
        const d = document.createElement('div');
        d.style.cssText = `position:absolute;left:${x0}px;width:${x1 - x0}px;top:${Math.min(ya, yb)}px;height:${Math.max(1, Math.abs(yb - ya))}px;background:${bg};border:1px solid ${bd};box-sizing:border-box`;
        overlay.appendChild(d);
      };
      mk(yE, yT, 'rgba(126,224,138,.16)', 'rgba(126,224,138,.45)');
      mk(yE, yS, 'rgba(255,122,107,.16)', 'rgba(255,122,107,.45)');
      if (b.tp1 != null) {
        const y1 = candle.priceToCoordinate(b.tp1);
        if (y1 != null) { const d = document.createElement('div'); d.style.cssText = `position:absolute;left:${x0}px;width:${x1 - x0}px;top:${y1}px;border-top:1px dashed rgba(126,224,138,.8)`; overlay.appendChild(d); }
      }
      if (b.label) {
        const t = document.createElement('div');
        t.className = 'box-label';
        // narrow box (the open candle at the right edge): hang the label leftwards from the box's right side
        t.style.cssText = x1 - x0 < 180 ? `position:absolute;right:${el.clientWidth - x1 + 4}px;top:${Math.min(yT, yS) + 3}px`
          : `position:absolute;left:${x0 + 4}px;top:${Math.min(yT, yS) + 3}px`;
        t.textContent = b.label;
        overlay.appendChild(t);
      }
    }
  }
  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawBoxes); };
  chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
  chart.subscribeCrosshairMove(p => {
    schedule();
    if (!p || !p.time) { legend.innerHTML = legend.dataset.base || ''; return; }
    const d = p.seriesData.get(candle);
    if (d) legend.innerHTML = `${legend.dataset.base || ''} <span class="lg-o">O ${fmt(d.open)} H ${fmt(d.high)} L ${fmt(d.low)} C ${fmt(d.close)}</span>`;
  });
  const ro = new ResizeObserver(schedule); ro.observe(el);
  let fmt = v => String(v);

  return {
    chart, candle,
    setBars(b, digits, title = '') {
      times = b.t;
      fmt = priceFormatter(digits);
      chart.applyOptions({ localization: { priceFormatter: fmt } });
      candle.setData(b.t.map((t, i) => ({ time: toChartTime(t), open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] })));
      vol.setData(b.t.map((t, i) => ({ time: toChartTime(t), value: b.v[i], color: b.c[i] >= b.o[i] ? 'rgba(126,224,138,.28)' : 'rgba(255,122,107,.28)' })));
      legend.dataset.base = title; legend.innerHTML = title;
      schedule();
    },
    setEmas(b, list) {
      list.forEach((arr, k) => emaS[k].setData(arr ? b.t.map((t, i) => ({ time: toChartTime(t), value: arr[i] })).filter(x => x.value === x.value) : []));
    },
    setMarkers(list) { markers.setMarkers([...list].sort((a, b) => a.time - b.time)); },
    setLines(list) {
      for (const pl of lines) candle.removePriceLine(pl);
      lines = list.filter(x => x.price === x.price && x.price != null).map(x => candle.createPriceLine({
        price: x.price, color: x.color, lineWidth: x.width || 1, lineStyle: x.style ?? 2, axisLabelVisible: true, title: x.title || '' }));
    },
    setBoxes(list) {
      boxes = list || [];
      keep = boxes.filter(b => !b.t1).flatMap(b => [b.entry, b.sl, b.tp]).filter(v => v === v && v != null);
      schedule();
    },
    focus(t0, t1, padBars = 40) {
      const ts = chart.timeScale(), i0 = times.findIndex(t => t >= t0), i1 = t1 ? times.findIndex(t => t >= t1) : times.length - 1;
      if (i0 < 0) return;
      ts.setVisibleLogicalRange({ from: Math.max(0, i0 - padBars), to: Math.min(times.length + 8, (i1 < 0 ? times.length : i1) + padBars) });
    },
    showRecent(nBars = 160) { const n = times.length; chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - nBars), to: n + 8 }); },
    destroy() { ro.disconnect(); cancelAnimationFrame(raf); chart.remove(); },
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
