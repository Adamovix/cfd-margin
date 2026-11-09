// Price chart with the open / margin call / stop-out / target lines, the shaded
// danger zones, a crosshair legend, and dragging of the margin call and target
// lines. It knows nothing about money: dragging just reports the new price.
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineSeries,
  CandlestickSeries,
  LineStyle,
} from '../vendor/lightweight-charts.standalone.production.mjs';
import { css, fill } from './dom.js';
import { finite, fmtPrice, fmtDate, isoDate, timeToIso, rgba } from './format.js';

const DAY = 24 * 60 * 60 * 1000;
const DRAGGABLE = ['mc', 'target'];
const RANGE_MONTHS = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '5Y': 60 };

/** Series primitive that fills horizontal bands (the margin call / stop-out zones). */
class ZonesPrimitive {
  constructor(onRedraw) {
    this._zones = [];
    this._rects = [];
    this._onRedraw = onRedraw;
    const renderer = { draw: (target) => this._draw(target) };
    this._views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
  }
  attached({ series, requestUpdate }) {
    this._series = series;
    this._requestUpdate = requestUpdate;
  }
  detached() {
    this._series = null;
    this._requestUpdate = null;
  }
  paneViews() {
    return this._views;
  }
  updateAllViews() {
    this._rects = [];
    const s = this._series;
    if (s) {
      for (const z of this._zones) {
        const yTop = z.top === Infinity ? -Infinity : s.priceToCoordinate(z.top);
        const yBottom = z.bottom === -Infinity ? Infinity : s.priceToCoordinate(z.bottom);
        if (yTop != null && yBottom != null) this._rects.push({ yTop, yBottom, color: z.color });
      }
    }
    this._onRedraw();
  }
  set(zones) {
    this._zones = zones;
    this._requestUpdate?.();
  }
  _draw(target) {
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vr }) => {
      for (const r of this._rects) {
        const top = Math.max(0, r.yTop * vr);
        const bottom = Math.min(bitmapSize.height, r.yBottom * vr);
        if (bottom <= top) continue;
        ctx.fillStyle = r.color;
        ctx.fillRect(0, top, bitmapSize.width, bottom - top);
      }
    });
  }
}

/** Bands beyond the margin call (warning) and the stop-out (danger). */
function zonesFor({ mc, so, direction }) {
  const warn = rgba(css('--mc'), 0.13);
  const danger = rgba(css('--so'), 0.13);
  const hasMc = mc > 0;
  const hasSo = so > 0;
  const zones = [];
  if (direction === 'long') {
    if (hasMc) zones.push({ top: mc, bottom: hasSo && so < mc ? so : -Infinity, color: warn });
    if (hasSo) zones.push({ top: hasMc ? Math.min(so, mc) : so, bottom: -Infinity, color: danger });
  } else {
    if (hasMc) zones.push({ bottom: mc, top: hasSo && so > mc ? so : Infinity, color: warn });
    if (hasSo) zones.push({ bottom: hasMc ? Math.max(so, mc) : so, top: Infinity, color: danger });
  }
  return zones;
}

export class PriceChart {
  /**
   * @param {HTMLElement} el          chart container
   * @param {object} o
   * @param {HTMLElement} o.legendEl  crosshair readout
   * @param {HTMLElement} o.tipEl     "drag me" pill shown on the margin call line
   * @param {boolean} o.tipSeen       hide the pill (user already dragged once)
   * @param {() => void} o.onTipSeen  called on the first margin call drag
   * @param {(line: 'mc'|'target', price: number) => void} o.onDrag
   * @param {(line: 'mc'|'target') => void} o.onDragEnd
   */
  constructor(el, { legendEl, tipEl, tipSeen, onTipSeen, onDrag, onDragEnd }) {
    this.el = el;
    this.legendEl = legendEl;
    this.tipEl = tipEl;
    this.tipSeen = tipSeen;
    this.onTipSeen = onTipSeen;
    this.onDrag = onDrag;
    this.onDragEnd = onDragEnd;

    this.label = '';
    this.bars = []; // [date, open, high, low, close][]
    this.type = 'line';
    this.levels = { open: NaN, mc: NaN, so: NaN, target: NaN, direction: 'long' };
    this.series = null;
    this.lines = {};
    this.drag = { active: null, hover: null }; // 'mc' | 'target' | null
    this.tipFrame = 0;

    this.chart = createChart(el, { autoSize: true });
    this.zones = new ZonesPrimitive(() => this.scheduleTip());
    this.chart.subscribeCrosshairMove((param) => {
      const d = param.time && this.series ? param.seriesData.get(this.series) : null;
      this.renderLegend(d ? { time: param.time, ...d } : null);
    });
    this.applyTheme();
    this.bindPointer();
  }

  get dragging() {
    return this.drag.active;
  }

  get hasBars() {
    return this.bars.length > 0;
  }

  // ----- data & appearance -----

  /** Show an instrument. `bars` may be empty (no history): then only the lines are drawn. */
  setInstrument({ label, bars, type }) {
    this.label = label;
    this.bars = bars;
    this.type = type;
    this.rebuild();
  }

  setType(type) {
    this.type = type;
    this.rebuild();
  }

  /** New data for the same instrument (keeps the view). */
  setBars(bars) {
    this.bars = bars;
    this.setData();
    this.renderLegend(null);
  }

  /** Re-read the colors after a light/dark switch. */
  setTheme() {
    this.applyTheme();
    this.rebuild();
  }

  /** levels: {open, mc, so, target, direction}; NaN or <= 0 hides a line. */
  setLevels(levels, { keepScale = false } = {}) {
    this.levels = { ...levels };
    if (!this.hasBars) this.setData(); // the invisible flat line follows the open price
    this.drawLevels();
    if (!keepScale && !this.drag.active) this.autoScale();
    this.scheduleTip();
  }

  setRange(range) {
    const ts = this.chart.timeScale();
    const months = RANGE_MONTHS[range];
    if (!this.hasBars || !months) {
      ts.fitContent();
    } else {
      const last = this.bars.at(-1)[0];
      const from = new Date(`${last}T00:00:00Z`);
      from.setUTCMonth(from.getUTCMonth() - months);
      const fromIso = isoDate(from);
      if (fromIso <= this.bars[0][0]) ts.fitContent();
      else ts.setVisibleRange({ from: fromIso, to: last });
    }
    this.autoScale();
  }

  autoScale() {
    this.chart.priceScale('right').applyOptions({ autoScale: true });
  }

  applyTheme() {
    this.chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: css('--surface') },
        textColor: css('--text-2'),
        fontFamily: getComputedStyle(document.body).fontFamily,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--grid') } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, rightOffset: 3 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: fmtPrice },
    });
  }

  rebuild() {
    if (this.series) this.chart.removeSeries(this.series);
    // Without history the time axis means nothing.
    this.chart.applyOptions({ timeScale: { visible: this.hasBars } });
    const common = {
      priceLineVisible: false,
      autoscaleInfoProvider: (original) => this.includeLevels(original()),
    };
    if (this.type === 'candles' && this.hasBars) {
      const up = css('--series');
      const down = css('--down');
      this.series = this.chart.addSeries(CandlestickSeries, {
        ...common,
        upColor: up, wickUpColor: up, downColor: down, wickDownColor: down, borderVisible: false,
      });
    } else {
      const visible = this.hasBars;
      this.series = this.chart.addSeries(LineSeries, {
        ...common,
        color: visible ? css('--series') : 'rgba(0,0,0,0)',
        lineWidth: 2,
        lastValueVisible: visible,
        crosshairMarkerVisible: visible,
        crosshairMarkerRadius: 4,
      });
    }
    const line = (color, lineWidth, lineStyle, title) =>
      this.series.createPriceLine({ price: 0, lineVisible: false, axisLabelVisible: false, color, lineWidth, lineStyle, title });
    this.lines = {
      open: line(css('--text-3'), 1, LineStyle.Dashed, 'Open'),
      so: line(css('--so'), 2, LineStyle.Dashed, 'Stop-out'),
      target: line(css('--target'), 2, LineStyle.Solid, 'Target ↕'),
      mc: line(css('--mc'), 2, LineStyle.Solid, 'Margin call ↕'),
    };
    this.series.attachPrimitive(this.zones);
    this.setData();
    this.drawLevels();
    this.renderLegend(null);
  }

  setData() {
    if (!this.series) return;
    if (this.hasBars) {
      this.series.setData(
        this.type === 'candles'
          ? this.bars.map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }))
          : this.bars.map((b) => ({ time: b[0], value: b[4] })),
      );
      return;
    }
    // No history: an invisible flat line at the open price gives the chart a
    // price scale, so the lines can still be drawn and dragged.
    const p = this.levels.open;
    const now = Date.now();
    this.series.setData(finite(p) && p > 0 ? [{ time: isoDate(now - 90 * DAY), value: p }, { time: isoDate(now), value: p }] : []);
  }

  drawLevels() {
    if (!this.series) return;
    for (const [name, line] of Object.entries(this.lines)) {
      const price = this.levels[name];
      const visible = finite(price) && price > 0;
      line.applyOptions({ price: visible ? price : 0, lineVisible: visible, axisLabelVisible: visible });
    }
    this.zones.set(zonesFor(this.levels));
  }

  /** Autoscale so that all lines stay on screen, not just the price history. */
  includeLevels(res) {
    const { open, mc, so, target } = this.levels;
    const ls = [open, mc, so, target].filter((v) => finite(v) && v > 0);
    if (!ls.length) return res;
    const lo = Math.min(...ls);
    const hi = Math.max(...ls);
    if (!res?.priceRange) return { priceRange: { minValue: lo * 0.98, maxValue: hi * 1.02 } };
    return {
      ...res,
      priceRange: {
        minValue: Math.min(res.priceRange.minValue, lo),
        maxValue: Math.max(res.priceRange.maxValue, hi),
      },
    };
  }

  paneHeight() {
    return this.chart.paneSize(0).height;
  }

  // ----- legend & "drag me" tip -----

  renderLegend(point) {
    const el = this.legendEl;
    el.hidden = !this.hasBars;
    if (!this.hasBars) return;
    let t, o, h, l, c;
    if (point) {
      t = timeToIso(point.time);
      c = point.value ?? point.close;
      ({ open: o, high: h, low: l } = point);
    } else {
      [t, o, h, l, c] = this.bars.at(-1);
    }
    const parts = [['b', this.label], ` ${fmtDate(t)}  `];
    if (this.type === 'candles' && finite(o)) {
      parts.push(`O ${fmtPrice(o)}  H ${fmtPrice(h)}  L ${fmtPrice(l)}  C `, ['b', fmtPrice(c)]);
    } else {
      parts.push(['b', fmtPrice(c)]);
    }
    fill(el, parts);
  }

  scheduleTip() {
    if (!this.tipFrame) this.tipFrame = requestAnimationFrame(() => this.positionTip());
  }

  positionTip() {
    this.tipFrame = 0;
    const mc = this.levels.mc;
    const y = this.series && mc > 0 ? this.series.priceToCoordinate(mc) : null;
    const show = !this.tipSeen && !this.drag.active && y != null && y > 12 && y < this.paneHeight() - 12;
    this.tipEl.hidden = !show;
    if (show) this.tipEl.style.top = `${y}px`;
  }

  // ----- dragging -----

  /** Which draggable line (if any) is within `tolerance` px of the pointer. */
  lineAt(clientX, clientY, tolerance) {
    if (!this.series) return null;
    const rect = this.el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || x > rect.width || y < 0 || y > this.paneHeight()) return null;
    let best = null;
    let bestDist = Infinity;
    for (const name of DRAGGABLE) {
      const price = this.levels[name];
      if (!(price > 0)) continue;
      const lineY = this.series.priceToCoordinate(price);
      const dist = lineY == null ? Infinity : Math.abs(y - lineY);
      if (dist <= tolerance && dist < bestDist) {
        best = name;
        bestDist = dist;
      }
    }
    return best;
  }

  refreshLineWidths() {
    for (const name of DRAGGABLE) {
      const thick = this.drag.active === name || this.drag.hover === name;
      this.lines[name]?.applyOptions({ lineWidth: thick ? 3 : 2 });
    }
  }

  setHover(name) {
    if (this.drag.hover === name) return;
    this.drag.hover = name;
    this.el.classList.toggle('near-line', !!name);
    this.refreshLineWidths();
  }

  startDrag(name) {
    this.drag.active = name;
    this.el.classList.add('dragging');
    this.refreshLineWidths();
    // Freeze the price scale so the chart doesn't rescale under the pointer.
    this.chart.priceScale('right').applyOptions({ autoScale: false });
    if (name === 'mc' && !this.tipSeen) {
      this.tipSeen = true;
      this.onTipSeen?.();
    }
    this.scheduleTip();
  }

  moveDrag(clientY) {
    const price = this.series.coordinateToPrice(clientY - this.el.getBoundingClientRect().top);
    if (price != null) this.onDrag(this.drag.active, price);
  }

  endDrag() {
    const name = this.drag.active;
    if (!name) return;
    this.drag.active = null;
    this.el.classList.remove('dragging');
    this.refreshLineWidths();
    // Rescale only if the line ended up (nearly) outside the visible area.
    const price = this.levels[name];
    const y = price > 0 ? this.series.priceToCoordinate(price) : null;
    const h = this.paneHeight();
    if (y == null || y < h * 0.04 || y > h * 0.96) this.autoScale();
    this.scheduleTip();
    this.onDragEnd?.(name);
  }

  bindPointer() {
    const el = this.el;
    // Capture phase on the container runs before the chart's own handlers, so a
    // press on a line never starts panning the chart.
    el.addEventListener('mousemove', (e) => !this.drag.active && this.setHover(this.lineAt(e.clientX, e.clientY, 10)), true);
    el.addEventListener('mouseleave', () => !this.drag.active && this.setHover(null));
    el.addEventListener(
      'mousedown',
      (e) => {
        const name = e.button === 0 ? this.lineAt(e.clientX, e.clientY, 10) : null;
        if (!name) return;
        e.preventDefault();
        e.stopPropagation();
        this.startDrag(name);
        const move = (ev) => this.moveDrag(ev.clientY);
        const up = () => {
          window.removeEventListener('mousemove', move);
          this.endDrag();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up, { once: true });
      },
      true,
    );

    // Touch: bigger hit area, and no page scrolling while dragging.
    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        const name = this.lineAt(e.touches[0].clientX, e.touches[0].clientY, 24);
        if (!name) return;
        e.preventDefault();
        e.stopPropagation();
        this.startDrag(name);
      },
      { capture: true, passive: false },
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        if (!this.drag.active) return;
        e.preventDefault();
        e.stopPropagation();
        this.moveDrag(e.touches[0].clientY);
      },
      { capture: true, passive: false },
    );
    for (const type of ['touchend', 'touchcancel']) {
      el.addEventListener(
        type,
        (e) => {
          if (!this.drag.active) return;
          e.stopPropagation();
          this.endDrag();
        },
        true,
      );
    }
  }
}
