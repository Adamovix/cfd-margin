import {
  createChart,
  ColorType,
  CrosshairMode,
  LineSeries,
  CandlestickSeries,
  LineStyle,
} from '../vendor/lightweight-charts.standalone.production.mjs';
import { triggerPrice, solveForTarget, snapshot, pctChange, shareOfDaysReaching, directionFor } from './margin.js';

// ---------------------------------------------------------------------------
// Settings & state
// ---------------------------------------------------------------------------

const DATA_URL = 'data/';
const REFRESH_MS = 2 * 60 * 1000;
const STORAGE_KEY = 'cfd-margin';
const DAY = 24 * 60 * 60 * 1000;

const CUSTOM = {
  id: 'CUSTOM',
  name: 'Other (type the price)',
  leverage: 5,
  currency: 'USD',
  note: 'No chart data for this one: type the price (in USD) into "Open price" and the lines show where the margin call and stop-out are.',
};

const DEFAULTS = {
  instrument: 'VIX',
  direction: 'long', // follows the target price; kept for when no target is set
  leverage: 5,
  mcPct: 70,
  soPct: 50,
  accountCcy: 'PLN',
  deposit: 2000, // account currency
  investment: 2000, // account currency
  locked: 'deposit',
  manualPrice: null, // null = follow the live price
  target: null,
  manualFx: null, // null = follow the ECB rate
  range: '1Y',
  chartType: 'line',
};
const CURRENCIES = ['PLN', 'EUR', 'USD', 'GBP', 'CHF', 'CZK', 'HUF'];
// Short keys for the URL hash, so a setup can be bookmarked or shared.
const URL_KEYS = {
  instrument: 'i', direction: 'dir', leverage: 'lev', mcPct: 'mc', soPct: 'so', accountCcy: 'ccy',
  deposit: 'dep', investment: 'inv', locked: 'lock', manualPrice: 'price', target: 'tgt', manualFx: 'fx',
  range: 'range', chartType: 'chart',
};
const NUMERIC = new Set(['leverage', 'mcPct', 'soPct', 'deposit', 'investment', 'manualPrice', 'target', 'manualFx']);
const ENUMS = {
  direction: ['long', 'short'],
  locked: ['deposit', 'investment'],
  range: ['1M', '3M', '6M', '1Y', '5Y', 'All'],
  chartType: ['line', 'candles'],
};

const state = { ...DEFAULTS }; // + saved settings, loaded in init()
let instruments = [CUSTOM];
let current = { meta: CUSTOM, bars: [], price: null }; // selected instrument + its data
let fxData = null; // ECB reference rates, EUR based
let loadError = false;
const levels = { open: NaN, mc: NaN, so: NaN, target: NaN }; // what's drawn right now

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

function parseNum(s) {
  const t = String(s).replace(/[\s_ ']/g, '').replace(',', '.');
  return t === '' ? NaN : Number(t);
}
const decimalsFor = (p) => (finite(p) && Math.abs(p) < 1 ? 4 : 2);
const fmtPrice = (p) =>
  finite(p)
    ? p.toLocaleString(undefined, { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) })
    : '—';
const fmtMoney = (v) =>
  finite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }) : '—';
const fmtPct = (v) => (finite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} %` : '—');
const fmtInput = (v) => (finite(v) ? String(Math.round(v * 1e6) / 1e6) : '');
const roundMoney = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
const roundPrice = (p) => Math.round(p * 10 ** decimalsFor(p)) / 10 ** decimalsFor(p);
const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');

function rgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function timeToIso(t) {
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return isoDate(t * 1000);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}
const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Builds DOM from ["text", ["b", "bold"], ...] so no data ever goes through innerHTML. */
function fill(el, parts) {
  el.replaceChildren(
    ...parts.filter((p) => p != null && p !== false).map((p) => {
      if (typeof p === 'string') return document.createTextNode(p);
      const [tag, text, cls] = p;
      const node = document.createElement(tag);
      node.textContent = text;
      if (cls) node.className = cls;
      return node;
    }),
  );
}

function storage(fn) {
  try {
    return fn(window.localStorage);
  } catch {
    return null; // private mode etc.
  }
}

// ---------------------------------------------------------------------------
// URL / localStorage state
// ---------------------------------------------------------------------------

function loadState() {
  const raw = location.hash.slice(1) || storage((s) => s.getItem(STORAGE_KEY)) || '';
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [key, short] of Object.entries(URL_KEYS)) {
    if (!params.has(short)) continue;
    const v = params.get(short);
    if (NUMERIC.has(key)) {
      const n = parseNum(v);
      if (finite(n)) out[key] = n;
    } else if (ENUMS[key]) {
      if (ENUMS[key].includes(v)) out[key] = v;
    } else if (/^[A-Z0-9_]{1,12}$/.test(v)) {
      out[key] = v;
    }
  }
  return out;
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const params = new URLSearchParams();
    for (const [key, short] of Object.entries(URL_KEYS)) {
      const v = state[key];
      if (v == null || (typeof v === 'number' && !finite(v))) continue;
      params.set(short, String(v));
    }
    const str = params.toString();
    history.replaceState(null, '', `#${str}`);
    storage((s) => s.setItem(STORAGE_KEY, str));
  }, 250);
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

/** Draws the shaded "margin call" and "stop-out" zones behind the price. */
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

const chartEl = $('chart');
const chart = createChart(chartEl, { autoSize: true });
const zones = new ZonesPrimitive(() => scheduleTip());
let series = null;
const lines = {};

function applyTheme() {
  chart.applyOptions({
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

const hasBars = () => current.bars.length > 0;

function buildSeries() {
  if (series) chart.removeSeries(series);
  // Without history (custom instrument) the time axis and range buttons mean nothing.
  chart.applyOptions({ timeScale: { visible: hasBars() } });
  $('chart-tools').hidden = !hasBars();
  const common = {
    priceLineVisible: false,
    autoscaleInfoProvider: (original) => includeLevels(original()),
  };
  if (state.chartType === 'candles' && hasBars()) {
    const up = css('--series');
    const down = css('--down');
    series = chart.addSeries(CandlestickSeries, {
      ...common,
      upColor: up, wickUpColor: up, downColor: down, wickDownColor: down, borderVisible: false,
    });
  } else {
    const visible = hasBars();
    series = chart.addSeries(LineSeries, {
      ...common,
      color: visible ? css('--series') : 'rgba(0,0,0,0)',
      lineWidth: 2,
      lastValueVisible: visible,
      crosshairMarkerVisible: visible,
      crosshairMarkerRadius: 4,
    });
  }
  const hidden = { price: 0, lineVisible: false, axisLabelVisible: false };
  lines.open = series.createPriceLine({ ...hidden, color: css('--text-3'), lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'Open' });
  lines.so = series.createPriceLine({ ...hidden, color: css('--so'), lineWidth: 2, lineStyle: LineStyle.Dashed, title: 'Stop-out' });
  lines.target = series.createPriceLine({ ...hidden, color: css('--target'), lineWidth: 2, lineStyle: LineStyle.Solid, title: 'Target ↕' });
  lines.mc = series.createPriceLine({ ...hidden, color: css('--mc'), lineWidth: 2, lineStyle: LineStyle.Solid, title: 'Margin call ↕' });
  series.attachPrimitive(zones);
  setSeriesData();
}

function setSeriesData() {
  if (hasBars()) {
    series.setData(
      state.chartType === 'candles'
        ? current.bars.map((b) => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }))
        : current.bars.map((b) => ({ time: b[0], value: b[4] })),
    );
    return;
  }
  // No history (custom instrument): an invisible flat line at the open price gives
  // the chart a price scale so the margin lines can be drawn and dragged.
  const p = openPrice();
  const now = Date.now();
  series.setData(finite(p) && p > 0 ? [{ time: isoDate(now - 90 * DAY), value: p }, { time: isoDate(now), value: p }] : []);
}

/** Make sure the price scale always shows the open, margin call and stop-out lines. */
function includeLevels(res) {
  const ls = [levels.open, levels.mc, levels.so, levels.target].filter((v) => finite(v) && v > 0);
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

function autoScale() {
  chart.priceScale('right').applyOptions({ autoScale: true });
}

function applyRange() {
  const ts = chart.timeScale();
  const bars = current.bars;
  const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '5Y': 60 }[state.range];
  if (!bars.length || !months) {
    ts.fitContent();
  } else {
    const last = bars.at(-1)[0];
    const from = new Date(`${last}T00:00:00Z`);
    from.setUTCMonth(from.getUTCMonth() - months);
    const fromIso = isoDate(from);
    if (fromIso <= bars[0][0]) ts.fitContent();
    else ts.setVisibleRange({ from: fromIso, to: last });
  }
  autoScale();
  for (const b of document.querySelectorAll('#ranges button')) {
    b.setAttribute('aria-pressed', String(b.dataset.range === state.range));
  }
}

const paneHeight = () => chart.paneSize(0).height;

// ----- legend (crosshair readout) -----

function renderLegend(point) {
  const el = $('legend');
  if (!hasBars()) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  let t, o, h, l, c;
  if (point) {
    t = timeToIso(point.time);
    c = point.value ?? point.close;
    ({ open: o, high: h, low: l } = point);
  } else {
    [t, o, h, l, c] = current.bars.at(-1);
  }
  const parts = [['b', current.meta.id], ` ${fmtDate(t)}  `];
  if (state.chartType === 'candles' && finite(o)) {
    parts.push(`O ${fmtPrice(o)}  H ${fmtPrice(h)}  L ${fmtPrice(l)}  C `, ['b', fmtPrice(c)]);
  } else {
    parts.push(['b', fmtPrice(c)]);
  }
  fill(el, parts);
}
chart.subscribeCrosshairMove((param) => {
  const d = param.time && series ? param.seriesData.get(series) : null;
  renderLegend(d ? { time: param.time, ...d } : null);
});

// ----- "drag me" tip that sits on the margin call line until the first drag -----

let tipFrame = 0;
let everDragged = storage((s) => s.getItem(`${STORAGE_KEY}-dragged`)) === '1';
function scheduleTip() {
  if (!tipFrame) tipFrame = requestAnimationFrame(positionTip);
}
function positionTip() {
  tipFrame = 0;
  const tip = $('drag-tip');
  const y = series && levels.mc > 0 ? series.priceToCoordinate(levels.mc) : null;
  const show = !everDragged && !drag.active && y != null && y > 12 && y < paneHeight() - 12;
  tip.hidden = !show;
  if (show) tip.style.top = `${y}px`;
}

// ---------------------------------------------------------------------------
// Dragging the margin call line (changes deposit/investment) and the target line
// ---------------------------------------------------------------------------

const DRAGGABLE = ['mc', 'target'];
const drag = { active: null, hover: null }; // 'mc' | 'target' | null

/** Which draggable line (if any) is under the pointer. */
function lineAt(clientX, clientY, tolerance) {
  if (!series) return null;
  const rect = chartEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || x > rect.width || y < 0 || y > paneHeight()) return null;
  let best = null;
  let bestDist = Infinity;
  for (const name of DRAGGABLE) {
    if (!(levels[name] > 0)) continue;
    const lineY = series.priceToCoordinate(levels[name]);
    const dist = lineY == null ? Infinity : Math.abs(y - lineY);
    if (dist <= tolerance && dist < bestDist) {
      best = name;
      bestDist = dist;
    }
  }
  return best;
}

function refreshLineWidths() {
  for (const name of DRAGGABLE) {
    lines[name]?.applyOptions({ lineWidth: drag.active === name || drag.hover === name ? 3 : 2 });
  }
}

function setHover(name) {
  if (drag.hover === name) return;
  drag.hover = name;
  chartEl.classList.toggle('near-line', !!name);
  refreshLineWidths();
}

function startDrag(name) {
  drag.active = name;
  chartEl.classList.add('dragging');
  refreshLineWidths();
  // Freeze the price scale so the chart doesn't rescale under the mouse.
  chart.priceScale('right').applyOptions({ autoScale: false });
  if (name === 'mc' && !everDragged) {
    everDragged = true;
    storage((s) => s.setItem(`${STORAGE_KEY}-dragged`, '1'));
  }
  scheduleTip();
}

function dragTo(clientY) {
  let price = series.coordinateToPrice(clientY - chartEl.getBoundingClientRect().top);
  if (price == null) return;
  // Keep lines above 0 (a long margin call at 0 means "never" and would vanish mid-drag).
  price = Math.max(price, openPrice() * 0.01);

  if (drag.active === 'target') {
    state.target = roundPrice(price);
    $('target').value = fmtInput(state.target);
    update({ keepScale: true });
    return;
  }

  const solveFor = state.locked === 'deposit' ? 'investment' : 'deposit';
  const result = solveForTarget({ ...positionParams(), solveFor, target: price });
  if (!result) {
    dragError =
      solveFor === 'investment'
        ? 'To drag the line, Deposit must be above 0 — or lock Investment instead.'
        : 'To drag the line, Investment must be above 0.';
    update({ keepScale: true });
    return;
  }
  dragError = '';
  state[solveFor] = roundMoney(result.value);
  $(solveFor).value = fmtInput(state[solveFor]);
  update({ keepScale: true });
}

function endDrag() {
  if (!drag.active) return;
  const price = levels[drag.active];
  drag.active = null;
  chartEl.classList.remove('dragging');
  refreshLineWidths();
  // Only rescale if the line ended up (nearly) outside the visible area.
  const y = price > 0 ? series.priceToCoordinate(price) : null;
  const h = paneHeight();
  if (y == null || y < h * 0.04 || y > h * 0.96) autoScale();
  scheduleTip();
  renderFieldStates();
}

// Mouse. Capture phase on the container runs before the chart's own handlers,
// so a press on the line never starts panning the chart.
chartEl.addEventListener(
  'mousemove',
  (e) => {
    if (!drag.active) setHover(lineAt(e.clientX, e.clientY, 10));
  },
  true,
);
chartEl.addEventListener('mouseleave', () => !drag.active && setHover(null));
chartEl.addEventListener(
  'mousedown',
  (e) => {
    const name = e.button === 0 ? lineAt(e.clientX, e.clientY, 10) : null;
    if (!name) return;
    e.preventDefault();
    e.stopPropagation();
    startDrag(name);
    const move = (ev) => dragTo(ev.clientY);
    const up = () => {
      window.removeEventListener('mousemove', move);
      endDrag();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up, { once: true });
  },
  true,
);

// Touch: bigger hit area, and stop the page from scrolling while dragging.
chartEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const name = lineAt(t.clientX, t.clientY, 24);
    if (!name) return;
    e.preventDefault();
    e.stopPropagation();
    startDrag(name);
  },
  { capture: true, passive: false },
);
chartEl.addEventListener(
  'touchmove',
  (e) => {
    if (!drag.active) return;
    e.preventDefault();
    e.stopPropagation();
    dragTo(e.touches[0].clientY);
  },
  { capture: true, passive: false },
);
for (const type of ['touchend', 'touchcancel']) {
  chartEl.addEventListener(
    type,
    (e) => {
      if (!drag.active) return;
      e.stopPropagation();
      endDrag();
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// Calculation + rendering
// ---------------------------------------------------------------------------

let dragError = '';

const livePrice = () => current.price;
const openPrice = () => state.manualPrice ?? livePrice() ?? NaN;

// Money is in the account currency (e.g. PLN), prices in the instrument's (USD).
const instCcy = () => current.meta.currency ?? 'USD';
const sameCcy = () => state.accountCcy === instCcy();
/** ECB rate: account currency per 1 unit of instrument currency. */
function autoFx() {
  if (sameCcy()) return 1;
  const r = fxData?.rates ?? {};
  return r[state.accountCcy] > 0 && r[instCcy()] > 0 ? r[state.accountCcy] / r[instCcy()] : NaN;
}
const fxRate = () => (sameCcy() ? 1 : state.manualFx ?? autoFx());
const fmtAcct = (v) => `${fmtMoney(v)} ${state.accountCcy}`;
const fmtSignedAcct = (v) => (finite(v) ? `${sign(v)}${fmtAcct(Math.abs(v))}` : '—');
const hasTarget = () => finite(state.target) && state.target > 0;

function positionParams() {
  return {
    direction: state.direction,
    deposit: state.deposit,
    investment: state.investment,
    leverage: state.leverage,
    openPrice: openPrice(),
    level: state.mcPct / 100,
    fx: fxRate(),
  };
}

/** Field-level validation; returns {fieldId: message} for invalid ones. */
function validate() {
  const errors = {};
  const lev = state.leverage;
  if (!(finite(lev) && lev >= 1)) errors.leverage = 'Leverage must be 1 or more (1:5 → 5).';
  if (!(finite(state.mcPct) && state.mcPct > 0 && (!finite(lev) || state.mcPct < lev * 100)))
    errors.mc = 'Margin call % must be above 0.';
  if (!(finite(state.soPct) && state.soPct >= 0 && (!finite(lev) || state.soPct < lev * 100)))
    errors.so = 'Stop-out % must be 0 (off) or more.';
  if (!(finite(state.deposit) && state.deposit >= 0)) errors.deposit = 'Deposit must be 0 or more.';
  if (!(finite(state.investment) && state.investment > 0)) errors.investment = 'Investment must be above 0.';
  const p = openPrice();
  if (!(finite(p) && p > 0)) errors.price = 'Type the open price.';
  const fx = fxRate();
  if (!(finite(fx) && fx > 0)) errors.fx = `Type the ${instCcy()} → ${state.accountCcy} exchange rate.`;
  return errors;
}

function computeZones(mc, so) {
  const warn = rgba(css('--mc'), 0.13);
  const danger = rgba(css('--so'), 0.13);
  const hasMc = mc > 0;
  const hasSo = so > 0;
  const zs = [];
  if (state.direction === 'long') {
    if (hasMc) zs.push({ top: mc, bottom: hasSo && so < mc ? so : -Infinity, color: warn });
    if (hasSo) zs.push({ top: hasMc ? Math.min(so, mc) : so, bottom: -Infinity, color: danger });
  } else {
    if (hasMc) zs.push({ bottom: mc, top: hasSo && so > mc ? so : Infinity, color: warn });
    if (hasSo) zs.push({ bottom: hasMc ? Math.max(so, mc) : so, top: Infinity, color: danger });
  }
  return zs;
}

function setLine(line, price, visible) {
  line.applyOptions({ price: visible ? price : 0, lineVisible: visible, axisLabelVisible: visible });
}

function update({ keepScale = false } = {}) {
  // Target above the open price = long, below = short.
  state.direction = directionFor(openPrice(), state.target, state.direction);
  const errors = validate();
  const ok = Object.keys(errors).length === 0;
  const p = positionParams();
  const mc = ok ? triggerPrice(p) : NaN;
  const so = ok && state.soPct > 0 ? triggerPrice({ ...p, level: state.soPct / 100 }) : NaN;
  levels.open = finite(p.openPrice) && p.openPrice > 0 ? p.openPrice : NaN;
  levels.mc = mc;
  levels.so = so;
  levels.target = hasTarget() ? state.target : NaN;

  if (series) {
    if (!hasBars()) setSeriesData();
    setLine(lines.open, levels.open, finite(levels.open));
    setLine(lines.target, levels.target, finite(levels.target));
    setLine(lines.mc, mc, mc > 0);
    setLine(lines.so, so, so > 0);
    zones.set(computeZones(mc, so));
    if (!keepScale && !drag.active) autoScale();
  }
  renderResults(p, mc, so, errors);
  renderFieldStates(errors);
  scheduleSave();
  scheduleTip();
}

function renderResults(p, mc, so, errors) {
  const big = $('r-mc');
  const sub = $('r-mc-dist');
  const errorList = Object.values(errors);
  big.classList.toggle('small', !(mc > 0));

  if (errorList.length) {
    big.textContent = '—';
    sub.textContent = errorList[0];
  } else if (mc <= 0) {
    big.textContent = 'Never';
    sub.textContent = 'Fully funded: even a drop to 0 would not trigger it.';
  } else {
    big.textContent = fmtPrice(mc);
    const live = livePrice();
    const fromNow = finite(live) && state.manualPrice != null && Math.abs(live - p.openPrice) > 1e-9;
    sub.textContent =
      `${fmtPct(pctChange(p.openPrice, mc))} from open price` +
      (fromNow ? ` · ${fmtPct(pctChange(live, mc))} from now` : '');
  }

  // Stop-out
  const soRow = $('r-so-row');
  soRow.hidden = !(so > 0);
  if (so > 0) {
    $('r-so').textContent = fmtPrice(so);
    $('r-so-dist').textContent = `(${fmtPct(pctChange(p.openPrice, so))})`;
  }

  // How often has the price been there?
  const hist = $('r-hist');
  const share = hasBars() && mc > 0 ? shareOfDaysReaching(current.bars, mc, state.direction) : null;
  hist.hidden = !share;
  if (share) {
    const since = fmtDate(share.since);
    fill(
      hist,
      share.hits === 0
        ? [`${current.meta.id} never reached this level (since ${since}).`]
        : [
            `${current.meta.id} reached this level on `,
            ['b', `${share.pct < 0.1 ? share.pct.toFixed(2) : share.pct.toFixed(1)} %`],
            ` of trading days since ${since} (${share.hits.toLocaleString()} days, intraday ${state.direction === 'long' ? 'low' : 'high'}).`,
          ],
    );
  }

  // Account figures
  const valid = !errorList.length;
  const atOpen = valid ? snapshot({ ...p, price: p.openPrice }) : null;
  const nowPrice = finite(livePrice()) ? livePrice() : p.openPrice;
  const now = valid ? snapshot({ ...p, price: nowPrice }) : null;
  $('r-balance').textContent = valid ? fmtAcct(atOpen.balance) : '—';
  $('r-notional').textContent = valid
    ? `${fmtMoney(atOpen.notional)} ${instCcy()} (${atOpen.units.toLocaleString(undefined, { maximumFractionDigits: atOpen.units < 10 ? 3 : 1 })} units)`
    : '—';
  $('r-loss').textContent = valid
    ? mc > 0
      ? fmtAcct(atOpen.units * Math.abs(p.openPrice - mc) * p.fx)
      : 'the whole position'
    : '—';
  $('r-level').textContent = valid ? `${Math.round(now.marginLevel * 100).toLocaleString()} %` : '—';
  $('r-pnl').textContent = valid ? fmtSignedAcct(now.pnl) : '—';
  const showTarget = valid && hasTarget() && state.target !== p.openPrice;
  $('r-target').textContent = showTarget ? fmtSignedAcct(snapshot({ ...p, price: state.target }).pnl) : '—';
  $('r-target-move').textContent = showTarget ? `(${fmtPct(pctChange(p.openPrice, state.target))} move)` : '';

  // What does dragging do?
  const hint = $('r-hint');
  const moving = state.locked === 'deposit' ? 'Investment' : 'Deposit';
  const fixed = state.locked === 'deposit' ? 'Deposit' : 'Investment';
  hint.classList.toggle('error', !!dragError);
  fill(
    hint,
    dragError
      ? [dragError]
      : mc === 0
        ? ['Fully funded, so there is no line to drag. Lower the ', ['b', 'Deposit'], ' or raise the ', ['b', 'Investment'], ' to bring it back.']
        : [
            '↕ Drag the orange line to change ', ['b', moving], ` (${fixed} is locked).`,
            hasTarget() ? ' The green line moves the target.' : ' Type a target to pick long or short.',
          ],
  );
}

const LOCK_SVG = {
  locked:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  open:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.5-.8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

function renderFieldStates(errors = validate()) {
  const fieldFor = { leverage: 'leverage', mc: 'mc', so: 'so', deposit: 'deposit', investment: 'investment', price: 'price', fx: 'fx' };
  for (const [key, id] of Object.entries(fieldFor)) $(id).classList.toggle('invalid', key in errors);
  $('target').classList.toggle('invalid', state.target != null && !hasTarget());

  // Currency labels
  for (const el of document.querySelectorAll('.acct-ccy')) el.textContent = state.accountCcy;
  for (const el of document.querySelectorAll('.inst-ccy')) el.textContent = instCcy();
  $('fx-from').textContent = `1 ${instCcy()} =`;

  // Direction comes from the target price.
  const badge = $('dir-badge');
  badge.textContent = state.direction === 'long' ? 'Long ↑' : 'Short ↓';
  const fromTarget = hasTarget() && state.target !== openPrice();
  badge.classList.toggle('inferred', !fromTarget);
  badge.title = fromTarget
    ? `Target is ${state.direction === 'long' ? 'above' : 'below'} the open price, so this is a ${state.direction} position.`
    : `No target set, so the last direction (${state.direction}) is used. Above the open price = long, below = short.`;

  for (const btn of document.querySelectorAll('.lock')) {
    const name = btn.dataset.lock;
    const locked = state.locked === name;
    const other = name === 'deposit' ? 'Investment' : 'Deposit';
    const label = name[0].toUpperCase() + name.slice(1);
    btn.setAttribute('aria-pressed', String(locked));
    btn.innerHTML = `${locked ? LOCK_SVG.locked : LOCK_SVG.open}<span>${locked ? 'Locked' : 'Moves'}</span>`;
    btn.title = locked
      ? `${label} stays fixed when you drag the line. Click to lock ${other} instead.`
      : `${label} changes when you drag the line. Click to lock it.`;
    btn.closest('.money').classList.toggle('moves', !locked);
  }
  for (const f of ['deposit', 'investment']) {
    $(f).closest('.money').classList.toggle('flash', drag.active === 'mc' && state.locked !== f);
  }

  // Open price: follows the market until you type your own.
  const live = livePrice();
  const following = state.manualPrice == null && finite(live);
  const priceEl = $('price');
  if (following && document.activeElement !== priceEl) priceEl.value = fmtInput(live);
  const liveBtn = $('price-live');
  liveBtn.hidden = !finite(live);
  liveBtn.setAttribute('aria-pressed', String(following));
  liveBtn.innerHTML = following ? '<span class="dot"></span>Live' : '↺ Live';
  liveBtn.title = following ? 'Following the market price. Type a price to use your own.' : 'Go back to the market price';

  // Exchange rate: follows the ECB rate until you type your own.
  $('fx-field').hidden = sameCcy();
  const ecb = autoFx();
  const fxFollowing = state.manualFx == null && finite(ecb);
  const fxEl = $('fx');
  if (fxFollowing && document.activeElement !== fxEl) fxEl.value = fmtInput(Math.round(ecb * 1e4) / 1e4);
  const fxBtn = $('fx-live');
  fxBtn.hidden = !finite(ecb);
  fxBtn.setAttribute('aria-pressed', String(fxFollowing));
  fxBtn.innerHTML = fxFollowing ? '<span class="dot"></span>ECB' : '↺ ECB';
  fxBtn.title = fxFollowing ? 'Using the ECB daily reference rate. Type a rate to use your own (e.g. from xStation).' : 'Go back to the ECB rate';
  $('fx-hint').textContent = sameCcy()
    ? ''
    : fxFollowing
    ? `ECB, ${fmtDate(fxData.date)}${fxData.stale ? ' (old)' : ''}`
    : finite(ecb)
      ? 'your own'
      : 'no live rate, type it';
}

function renderQuote() {
  const el = $('quote');
  if (current.meta.id === 'CUSTOM') {
    fill(el, loadError ? [['span', 'Couldn\'t load prices', 'warn'], ' — type the price yourself.'] : ['No chart data — using the price you type.']);
    return;
  }
  const { price, priceTime, endOfDay, stale } = current.meta;
  const bars = current.bars;
  const prev = bars.length > 1 ? bars.at(-2)[4] : null;
  const when = priceTime ? new Date(priceTime) : null;
  const sameDay = when && when.toDateString() === new Date().toDateString();
  const whenText = when
    ? sameDay
      ? when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  fill(el, [
    ['b', fmtPrice(price)],
    prev ? ` ${fmtPct(pctChange(prev, price))}` : '',
    ` · ${endOfDay ? 'settlement' : 'as of'} ${whenText}${endOfDay ? '' : ' (15 min delayed)'}`,
    stale ? ['span', ' · couldn\'t refresh, showing older data', 'warn'] : '',
  ]);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function fetchInstrument(meta) {
  if (meta.id === 'CUSTOM') return { meta, bars: [], price: null };
  const { bars, ...rest } = await getJson(`${DATA_URL}${meta.id}.json`);
  return { meta: { ...meta, ...rest }, bars, price: rest.price };
}

let loadToken = 0;
async function selectInstrument(id, { initial = false } = {}) {
  const meta = instruments.find((i) => i.id === id) ?? instruments[0];
  const token = ++loadToken;
  let next;
  try {
    next = await fetchInstrument(meta);
  } catch (err) {
    console.warn(err);
    loadError = true;
    next = { meta: CUSTOM, bars: [], price: null };
  }
  if (token !== loadToken) return; // a newer selection won

  const previousOpen = openPrice();
  current = next;
  state.instrument = current.meta.id;
  $('instrument').value = current.meta.id;
  if (!initial) {
    state.leverage = current.meta.leverage;
    $('leverage').value = fmtInput(state.leverage);
    state.target = null; // a VIX target makes no sense for the S&P 500
    $('target').value = '';
    state.manualPrice = finite(current.price) ? null : finite(previousOpen) ? previousOpen : 100;
  } else if (!finite(current.price) && state.manualPrice == null) {
    state.manualPrice = 100;
  }
  if (state.manualPrice != null) $('price').value = fmtInput(state.manualPrice);

  $('inst-note').textContent = current.meta.note ?? '';
  buildSeries();
  applyRange();
  renderQuote();
  renderLegend(null);
  update();
}

async function loadFx() {
  try {
    fxData = await getJson(`${DATA_URL}fx.json`);
  } catch (err) {
    console.warn('No exchange rates available', err);
  }
}

async function refresh() {
  if (document.hidden || drag.active) return;
  const fxBefore = fxData?.fetchedAt;
  await loadFx();
  if (fxData?.fetchedAt !== fxBefore && !drag.active) update({ keepScale: true });
  if (current.meta.id === 'CUSTOM') return;
  try {
    const next = await fetchInstrument(current.meta);
    if (next.meta.fetchedAt === current.meta.fetchedAt || next.meta.id !== current.meta.id || drag.active) return;
    current = next;
    setSeriesData();
    renderQuote();
    renderLegend(null);
    update({ keepScale: true });
  } catch (err) {
    console.warn('refresh failed', err);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function bindNumber(id, key, { emptyValue } = {}) {
  const el = $(id);
  el.value = state[key] == null ? '' : fmtInput(state[key]);
  el.addEventListener('input', () => {
    dragError = '';
    state[key] = el.value.trim() === '' && emptyValue !== undefined ? emptyValue : parseNum(el.value);
    update();
  });
  el.addEventListener('blur', () => {
    if (finite(state[key])) el.value = fmtInput(state[key]);
    renderFieldStates();
  });
}

function init() {
  Object.assign(state, loadState());
  applyTheme();

  bindNumber('leverage', 'leverage');
  bindNumber('mc', 'mcPct');
  bindNumber('so', 'soPct', { emptyValue: 0 });
  bindNumber('deposit', 'deposit');
  bindNumber('investment', 'investment');
  bindNumber('price', 'manualPrice', { emptyValue: null });
  bindNumber('target', 'target', { emptyValue: null });
  bindNumber('fx', 'manualFx', { emptyValue: null });
  if (state.soPct === 0) $('so').value = '';

  const ccy = $('ccy');
  const ccyList = CURRENCIES.includes(state.accountCcy) ? CURRENCIES : [state.accountCcy, ...CURRENCIES];
  ccy.replaceChildren(
    ...ccyList.map((c) => {
      const o = document.createElement('option');
      o.value = o.textContent = c;
      return o;
    }),
  );
  ccy.value = state.accountCcy;
  ccy.addEventListener('change', () => {
    state.accountCcy = ccy.value;
    state.manualFx = null;
    $('fx').value = '';
    update({ keepScale: true });
  });
  $('fx-live').addEventListener('click', () => {
    state.manualFx = null;
    update({ keepScale: true });
  });
  for (const btn of document.querySelectorAll('.lock')) {
    btn.addEventListener('click', () => {
      state.locked = state.locked === 'deposit' ? 'investment' : 'deposit';
      dragError = '';
      update({ keepScale: true });
    });
  }
  $('price-live').addEventListener('click', () => {
    state.manualPrice = null;
    update();
  });
  $('form').addEventListener('submit', (e) => e.preventDefault());

  for (const btn of document.querySelectorAll('#ranges button')) {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      applyRange();
      scheduleSave();
    });
  }
  const renderTypeButtons = () => {
    for (const b of document.querySelectorAll('#types button')) {
      b.setAttribute('aria-pressed', String(b.dataset.type === state.chartType));
    }
  };
  for (const btn of document.querySelectorAll('#types button')) {
    btn.addEventListener('click', () => {
      if (state.chartType === btn.dataset.type) return;
      state.chartType = btn.dataset.type;
      renderTypeButtons();
      buildSeries();
      renderLegend(null);
      update({ keepScale: true });
    });
  }
  renderTypeButtons();

  $('instrument').addEventListener('change', (e) => selectInstrument(e.target.value));

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme();
    buildSeries();
    update({ keepScale: true });
  });
  // A pasted link with different settings: start over from it.
  window.addEventListener('hashchange', () => location.reload());
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, REFRESH_MS);
}

async function main() {
  init();
  await loadFx();
  try {
    const index = await getJson(`${DATA_URL}instruments.json`);
    instruments = [...index.instruments, CUSTOM];
  } catch (err) {
    console.warn('No price data available', err);
    loadError = true;
  }
  const select = $('instrument');
  select.replaceChildren(
    ...instruments.map((i) => {
      const o = document.createElement('option');
      o.value = i.id;
      o.textContent = i.name;
      return o;
    }),
  );
  await selectInstrument(state.instrument, { initial: true });
}

main();
