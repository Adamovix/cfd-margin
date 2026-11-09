// Number/date parsing and formatting. No DOM, so it can be unit-tested with `node --test`.

export const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Accepts "12 345,6", "12345.6", "12_345" … Empty or garbage gives NaN. */
export function parseNum(s) {
  const t = String(s).replace(/[\s_ ']/g, '').replace(',', '.');
  return t === '' ? NaN : Number(t);
}

export const decimalsFor = (p) => (finite(p) && Math.abs(p) < 1 ? 4 : 2);
export const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');

export const fmtPrice = (p) =>
  finite(p)
    ? p.toLocaleString(undefined, { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) })
    : '—';
export const fmtMoney = (v) =>
  finite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }) : '—';
export const fmtPct = (v) => (finite(v) ? `${sign(v)}${Math.abs(v).toFixed(1)} %` : '—');
/** Plain number for an <input>: no grouping, no float noise. */
export const fmtInput = (v) => (finite(v) ? String(Math.round(v * 1e6) / 1e6) : '');

export const roundMoney = (v) => (v >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
export const roundPrice = (p) => Math.round(p * 10 ** decimalsFor(p)) / 10 ** decimalsFor(p);

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
export const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Chart time (string, unix seconds or {year, month, day}) -> 'YYYY-MM-DD'. */
export function timeToIso(t) {
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return isoDate(t * 1000);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

export function rgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
