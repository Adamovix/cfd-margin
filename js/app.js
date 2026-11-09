// Page logic: settings, data loading, the calculation and the side panel.
// Chart drawing/dragging lives in chart.js, the math in margin.js.
import { PriceChart } from './chart.js';
import { $, fill, setOptions, storage } from './dom.js';
import {
  finite, parseNum, fmtPrice, fmtMoney, fmtPct, fmtInput, fmtDate, roundMoney, roundPrice, sign,
} from './format.js';
import { triggerPrice, solveForTarget, snapshot, pctChange, shareOfDaysReaching, directionFor } from './margin.js';
import { DEFAULTS, CURRENCIES, decodeSettings, encodeSettings } from './settings.js';

const DATA_URL = 'data/';
const REFRESH_MS = 2 * 60 * 1000;
const STORAGE_KEY = 'cfd-margin';

const CUSTOM = {
  id: 'CUSTOM',
  name: 'Other (type the price)',
  leverage: 5,
  currency: 'USD',
  note: 'No chart data for this one: type the price (in USD) into "Open price" and the lines show where the margin call and stop-out are.',
};

const state = { ...DEFAULTS };
let instruments = [CUSTOM];
let current = { meta: CUSTOM, bars: [], price: null }; // selected instrument + its data
let fxData = null; // ECB reference rates, EUR based
let loadError = false;
let dragError = '';

const chart = new PriceChart($('chart'), {
  legendEl: $('legend'),
  tipEl: $('drag-tip'),
  tipSeen: storage.get(`${STORAGE_KEY}-dragged`) === '1',
  onTipSeen: () => storage.set(`${STORAGE_KEY}-dragged`, '1'),
  onDrag: dragLine,
  onDragEnd: () => renderFieldStates(),
});

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

const livePrice = () => current.price;
const openPrice = () => state.manualPrice ?? livePrice() ?? NaN;
const hasTarget = () => finite(state.target) && state.target > 0;

// Money is in the account currency (e.g. PLN), prices in the instrument's (USD).
const instCcy = () => current.meta.currency ?? 'USD';
const sameCcy = () => state.accountCcy === instCcy();
/** ECB rate: account currency per 1 unit of instrument currency. */
function ecbRate() {
  if (sameCcy()) return 1;
  const r = fxData?.rates ?? {};
  return r[state.accountCcy] > 0 && r[instCcy()] > 0 ? r[state.accountCcy] / r[instCcy()] : NaN;
}
const fxRate = () => (sameCcy() ? 1 : state.manualFx ?? ecbRate());
const fmtAcct = (v) => `${fmtMoney(v)} ${state.accountCcy}`;
const fmtSignedAcct = (v) => (finite(v) ? `${sign(v)}${fmtAcct(Math.abs(v))}` : '—');

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

/** Returns {fieldKey: message} for every invalid field. */
function validate() {
  const errors = {};
  const lev = state.leverage;
  const belowLeverage = (pct) => !finite(lev) || pct < lev * 100;
  if (!(finite(lev) && lev >= 1)) errors.leverage = 'Leverage must be 1 or more (1:5 → 5).';
  if (!(finite(state.mcPct) && state.mcPct > 0 && belowLeverage(state.mcPct))) errors.mc = 'Margin call % must be above 0.';
  if (!(finite(state.soPct) && state.soPct >= 0 && belowLeverage(state.soPct))) errors.so = 'Stop-out % must be 0 (off) or more.';
  if (!(finite(state.deposit) && state.deposit >= 0)) errors.deposit = 'Deposit must be 0 or more.';
  if (!(finite(state.investment) && state.investment > 0)) errors.investment = 'Investment must be above 0.';
  const p = openPrice();
  if (!(finite(p) && p > 0)) errors.price = 'Type the open price.';
  const fx = fxRate();
  if (!(finite(fx) && fx > 0)) errors.fx = `Type the ${instCcy()} → ${state.accountCcy} exchange rate.`;
  return errors;
}

// ---------------------------------------------------------------------------
// Update cycle: state -> calculation -> chart + panel
// ---------------------------------------------------------------------------

function update({ keepScale = false } = {}) {
  // Target above the open price = long, below = short.
  state.direction = directionFor(openPrice(), state.target, state.direction);
  const errors = validate();
  const ok = Object.keys(errors).length === 0;
  const p = positionParams();
  const mc = ok ? triggerPrice(p) : NaN;
  const so = ok && state.soPct > 0 ? triggerPrice({ ...p, level: state.soPct / 100 }) : NaN;

  chart.setLevels(
    {
      open: p.openPrice,
      mc,
      so,
      target: hasTarget() ? state.target : NaN,
      direction: state.direction,
    },
    { keepScale },
  );
  renderResults(p, mc, so, errors);
  renderFieldStates(errors);
  scheduleSave();
}

/** Called while a line is dragged on the chart. */
function dragLine(line, rawPrice) {
  // Keep lines above 0 (a long margin call at 0 means "never" and would vanish mid-drag).
  const price = Math.max(rawPrice, openPrice() * 0.01);

  if (line === 'target') {
    state.target = roundPrice(price);
    $('target').value = fmtInput(state.target);
    update({ keepScale: true });
    return;
  }

  const solveFor = state.locked === 'deposit' ? 'investment' : 'deposit';
  const result = solveForTarget({ ...positionParams(), solveFor, target: price });
  if (result) {
    dragError = '';
    state[solveFor] = roundMoney(result.value);
    $(solveFor).value = fmtInput(state[solveFor]);
  } else {
    dragError =
      solveFor === 'investment'
        ? 'To drag the line, Deposit must be above 0 — or lock Investment instead.'
        : 'To drag the line, Investment must be above 0.';
  }
  update({ keepScale: true });
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const str = encodeSettings(state);
    history.replaceState(null, '', `#${str}`);
    storage.set(STORAGE_KEY, str);
  }, 250);
}

// ---------------------------------------------------------------------------
// Rendering the panel
// ---------------------------------------------------------------------------

function renderResults(p, mc, so, errors) {
  const errorList = Object.values(errors);
  const valid = !errorList.length;

  // Headline: margin call price
  const big = $('r-mc');
  const sub = $('r-mc-dist');
  big.classList.toggle('small', !(mc > 0));
  if (!valid) {
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
      `${fmtPct(pctChange(p.openPrice, mc))} from open price` + (fromNow ? ` · ${fmtPct(pctChange(live, mc))} from now` : '');
  }

  // Stop-out
  $('r-so-row').hidden = !(so > 0);
  if (so > 0) {
    $('r-so').textContent = fmtPrice(so);
    $('r-so-dist').textContent = `(${fmtPct(pctChange(p.openPrice, so))})`;
  }

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

  // Account figures
  const atOpen = valid ? snapshot({ ...p, price: p.openPrice }) : null;
  const now = valid ? snapshot({ ...p, price: finite(livePrice()) ? livePrice() : p.openPrice }) : null;
  const showTarget = valid && hasTarget() && state.target !== p.openPrice;
  const set = (id, text) => ($(id).textContent = valid ? text : '—');
  set('r-target', showTarget ? fmtSignedAcct(snapshot({ ...p, price: state.target }).pnl) : '—');
  $('r-target-move').textContent = showTarget ? `(${fmtPct(pctChange(p.openPrice, state.target))} move)` : '';
  set('r-pnl', now && fmtSignedAcct(now.pnl));
  set('r-loss', mc > 0 ? fmtAcct(atOpen?.units * Math.abs(p.openPrice - mc) * p.fx) : 'the whole position');
  set('r-level', now && `${Math.round(now.marginLevel * 100).toLocaleString()} %`);
  set('r-balance', atOpen && fmtAcct(atOpen.balance));
  set(
    'r-notional',
    atOpen &&
      `${fmtMoney(atOpen.notional)} ${instCcy()} (${atOpen.units.toLocaleString(undefined, { maximumFractionDigits: atOpen.units < 10 ? 3 : 1 })} units)`,
  );

  // How often has the price been there?
  const hist = $('r-hist');
  const share = current.bars.length && mc > 0 ? shareOfDaysReaching(current.bars, mc, state.direction) : null;
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
}

const LOCK_SVG = {
  locked:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  open:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.5-.8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

/** "Follows a live value until you type your own" fields: open price and exchange rate. */
function renderLiveField({ input, button, live, manual, label, liveTitle, manualTitle, decimals }) {
  const following = manual == null && finite(live);
  if (following && document.activeElement !== input) {
    input.value = fmtInput(decimals ? Math.round(live * 10 ** decimals) / 10 ** decimals : live);
  }
  button.hidden = !finite(live);
  button.setAttribute('aria-pressed', String(following));
  button.innerHTML = following ? `<span class="dot"></span>${label}` : `↺ ${label}`;
  button.title = following ? liveTitle : manualTitle;
  return following;
}

function renderFieldStates(errors = validate()) {
  for (const id of ['leverage', 'mc', 'so', 'deposit', 'investment', 'price', 'fx']) {
    $(id).classList.toggle('invalid', id in errors);
  }
  $('target').classList.toggle('invalid', state.target != null && !hasTarget());

  // Currency labels
  for (const el of document.querySelectorAll('.acct-ccy')) el.textContent = state.accountCcy;
  for (const el of document.querySelectorAll('.inst-ccy')) el.textContent = instCcy();
  $('fx-from').textContent = `1 ${instCcy()} =`;

  // Direction comes from the target price.
  const badge = $('dir-badge');
  const fromTarget = hasTarget() && state.target !== openPrice();
  badge.textContent = state.direction === 'long' ? 'Long ↑' : 'Short ↓';
  badge.classList.toggle('inferred', !fromTarget);
  badge.title = fromTarget
    ? `Target is ${state.direction === 'long' ? 'above' : 'below'} the open price, so this is a ${state.direction} position.`
    : `No target set, so the last direction (${state.direction}) is used. Above the open price = long, below = short.`;

  // Lock buttons: the unlocked money field is the one the margin call line moves.
  for (const btn of document.querySelectorAll('.lock')) {
    const name = btn.dataset.lock;
    const locked = state.locked === name;
    const label = name[0].toUpperCase() + name.slice(1);
    const other = name === 'deposit' ? 'Investment' : 'Deposit';
    btn.setAttribute('aria-pressed', String(locked));
    btn.innerHTML = `${locked ? LOCK_SVG.locked : LOCK_SVG.open}<span>${locked ? 'Locked' : 'Moves'}</span>`;
    btn.title = locked
      ? `${label} stays fixed when you drag the line. Click to lock ${other} instead.`
      : `${label} changes when you drag the line. Click to lock it.`;
    const field = btn.closest('.money');
    field.classList.toggle('moves', !locked);
    field.classList.toggle('flash', !locked && chart.dragging === 'mc');
  }

  renderLiveField({
    input: $('price'),
    button: $('price-live'),
    live: livePrice(),
    manual: state.manualPrice,
    label: 'Live',
    liveTitle: 'Following the market price. Type a price to use your own.',
    manualTitle: 'Go back to the market price',
  });

  $('fx-field').hidden = sameCcy();
  if (!sameCcy()) {
    const ecb = ecbRate();
    const following = renderLiveField({
      input: $('fx'),
      button: $('fx-live'),
      live: ecb,
      manual: state.manualFx,
      label: 'ECB',
      liveTitle: 'Using the ECB daily reference rate. Type a rate to use your broker\'s.',
      manualTitle: 'Go back to the ECB rate',
      decimals: 4,
    });
    $('fx-hint').textContent = following
      ? `ECB, ${fmtDate(fxData.date)}${fxData.stale ? ' (old)' : ''}`
      : finite(ecb)
        ? 'your own'
        : 'no live rate, type it';
  }
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
  const whenText = !when
    ? ''
    : sameDay
      ? when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  fill(el, [
    ['b', fmtPrice(price)],
    prev ? ` ${fmtPct(pctChange(prev, price))}` : '',
    ` · ${endOfDay ? 'settlement' : 'as of'} ${whenText}${endOfDay ? '' : ' (15 min delayed)'}`,
    stale ? ['span', ' · couldn\'t refresh, showing older data', 'warn'] : '',
  ]);
}

function renderToggles() {
  for (const b of document.querySelectorAll('#ranges button')) b.setAttribute('aria-pressed', String(b.dataset.range === state.range));
  for (const b of document.querySelectorAll('#types button')) b.setAttribute('aria-pressed', String(b.dataset.type === state.chartType));
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

async function loadFx() {
  try {
    fxData = await getJson(`${DATA_URL}fx.json`);
  } catch (err) {
    console.warn('No exchange rates available', err);
  }
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
  $('chart-tools').hidden = !current.bars.length; // no history: range buttons mean nothing
  chart.setInstrument({ label: current.meta.id, bars: current.bars, type: state.chartType });
  chart.setRange(state.range);
  renderQuote();
  update();
}

async function refresh() {
  if (document.hidden || chart.dragging) return;
  const fxBefore = fxData?.fetchedAt;
  await loadFx();
  if (fxData?.fetchedAt !== fxBefore && !chart.dragging) update({ keepScale: true });
  if (current.meta.id === 'CUSTOM') return;
  try {
    const next = await fetchInstrument(current.meta);
    if (next.meta.fetchedAt === current.meta.fetchedAt || next.meta.id !== current.meta.id || chart.dragging) return;
    current = next;
    chart.setBars(current.bars);
    renderQuote();
    update({ keepScale: true });
  } catch (err) {
    console.warn('refresh failed', err);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Two-way binding between a text input and a numeric state key. */
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
  Object.assign(state, decodeSettings(location.hash.slice(1) || storage.get(STORAGE_KEY) || ''));

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
  setOptions(ccy, ccyList.map((c) => [c, c]));
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
  $('price-live').addEventListener('click', () => {
    state.manualPrice = null;
    update();
  });
  for (const btn of document.querySelectorAll('.lock')) {
    btn.addEventListener('click', () => {
      state.locked = state.locked === 'deposit' ? 'investment' : 'deposit';
      dragError = '';
      update({ keepScale: true });
    });
  }
  $('form').addEventListener('submit', (e) => e.preventDefault());

  for (const btn of document.querySelectorAll('#ranges button')) {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      chart.setRange(state.range);
      renderToggles();
      scheduleSave();
    });
  }
  for (const btn of document.querySelectorAll('#types button')) {
    btn.addEventListener('click', () => {
      if (state.chartType === btn.dataset.type) return;
      state.chartType = btn.dataset.type;
      chart.setType(state.chartType);
      renderToggles();
      update({ keepScale: true });
    });
  }
  renderToggles();

  $('instrument').addEventListener('change', (e) => selectInstrument(e.target.value));

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    chart.setTheme();
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
  setOptions($('instrument'), instruments.map((i) => [i.id, i.name]));
  await selectInstrument(state.instrument, { initial: true });
}

main();
