// The user's settings and how they are stored in the URL hash (so a setup can be
// bookmarked or shared) and in localStorage. No DOM, so it can be unit-tested.
import { finite, parseNum } from './format.js';

export const DEFAULTS = {
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

export const CURRENCIES = ['PLN', 'EUR', 'USD', 'GBP', 'CHF', 'CZK', 'HUF'];
export const RANGES = ['1M', '3M', '6M', '1Y', '5Y', 'All'];

// Short keys keep shared links readable.
const URL_KEYS = {
  instrument: 'i', direction: 'dir', leverage: 'lev', mcPct: 'mc', soPct: 'so', accountCcy: 'ccy',
  deposit: 'dep', investment: 'inv', locked: 'lock', manualPrice: 'price', target: 'tgt', manualFx: 'fx',
  range: 'range', chartType: 'chart',
};
const NUMERIC = new Set(['leverage', 'mcPct', 'soPct', 'deposit', 'investment', 'manualPrice', 'target', 'manualFx']);
const ENUMS = {
  direction: ['long', 'short'],
  locked: ['deposit', 'investment'],
  range: RANGES,
  chartType: ['line', 'candles'],
};

/** 'i=VIX&dep=2000&…' -> the valid settings it contains (unknown or bad values are dropped). */
export function decodeSettings(str) {
  const params = new URLSearchParams(str);
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
      out[key] = v; // instrument id, currency code
    }
  }
  return out;
}

/** Settings -> 'i=VIX&dep=2000&…' (empty and invalid values are left out). */
export function encodeSettings(settings) {
  const params = new URLSearchParams();
  for (const [key, short] of Object.entries(URL_KEYS)) {
    const v = settings[key];
    if (v == null || (typeof v === 'number' && !finite(v))) continue;
    params.set(short, String(v));
  }
  return params.toString();
}
