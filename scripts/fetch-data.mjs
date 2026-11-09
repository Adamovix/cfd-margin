#!/usr/bin/env node
// Downloads delayed price data from CBOE and writes static JSON files for the site.
//
// Why a script and not a fetch() in the browser: CBOE's free data only allows
// browser requests coming from cboe.com (CORS), so a GitHub Pages site can't
// call it directly. A scheduled GitHub Action runs this script and publishes
// the JSON next to the page instead.
//
// Usage:  node scripts/fetch-data.mjs [outDir]          (default: data)
// Env:    PREVIOUS_DATA_URL  URL of the currently published data/ folder. Used as a
//                            fallback when CBOE can't be reached, so a failed fetch
//                            doesn't wipe the data from the live site.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'data';
const PREVIOUS = process.env.PREVIOUS_DATA_URL?.replace(/\/+$/, '');
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes';
const VX_CSV = (expiry) =>
  `https://cdn.cboe.com/data/us/futures/market_statistics/historical_data/VX/VX_${expiry}.csv`;
const DAY = 24 * 60 * 60 * 1000;
const HISTORY_FROM = '1990-01-01'; // keeps the files small; VIX history starts here anyway

// To add an instrument available on cboe.com delayed quotes (indices start with "_",
// e.g. _RUT; US stocks/ETFs use the plain ticker, e.g. SPY), add an entry here.
// Not every symbol has history there (e.g. _NDX doesn't).
const INSTRUMENTS = [
  {
    id: 'VIX',
    name: 'VIX index (spot)',
    source: { type: 'cboe', symbol: '_VIX' },
    leverage: 5,
    currency: 'USD',
    note:
      'Spot VIX index, 15 min delayed. XTB\'s "VIX" CFD follows VIX futures instead, which usually trade a few points away from spot — type your XTB price into "Open price".',
  },
  {
    id: 'VX',
    name: 'VIX futures (front month)',
    source: { type: 'vx-futures', rollDaysBeforeExpiry: 7 },
    leverage: 5,
    currency: 'USD',
    note:
      'Front-month VIX futures, daily settlement prices (end of day). This is what XTB\'s "VIX" CFD tracks. The chart switches to the next contract 7 days before expiry, so it jumps at each roll.',
  },
  {
    id: 'SPX',
    name: 'S&P 500 index',
    source: { type: 'cboe', symbol: '_SPX' },
    leverage: 20,
    currency: 'USD',
    note: 'Cash index, 15 min delayed. XTB: US500 (follows futures, may differ slightly).',
  },
];

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x) => Math.round(x * 1e4) / 1e4;
const isoDate = (d) => d.toISOString().slice(0, 10);

async function get(url, { text = false, optional = false, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'cfd-margin data fetcher (GitHub Actions)' },
      });
      // Missing files on CBOE's S3 bucket answer 403/404.
      if (optional && (res.status === 403 || res.status === 404)) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text ? await res.text() : await res.json();
    } catch (err) {
      if (attempt >= retries) throw new Error(`${url}: ${err.message}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** [date, open, high, low, close] with missing (0) values filled from close. */
function fixBar([date, o, h, l, c]) {
  o = o > 0 ? o : c;
  h = Math.max(h > 0 ? h : c, o, c);
  l = Math.min(l > 0 ? l : c, o, c);
  return [date, round(o), round(h), round(l), round(c)];
}

/** 'YYYY-MM-DDTHH:mm:ss' New York local time -> ISO UTC string. */
function newYorkToUtc(local) {
  const guess = new Date(`${local}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(guess)
      .map((p) => [p.type, Number(p.value)]),
  );
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(guess.getTime() - (shown - guess.getTime())).toISOString();
}

// ---------- CBOE indices / stocks ----------

async function fetchCboe({ symbol }) {
  const [hist, quote] = await Promise.all([
    get(`${CBOE}/charts/historical/${symbol}.json`),
    get(`${CBOE}/quotes/${symbol}.json`),
  ]);
  const bars = hist.data
    .map((r) => fixBar([r.date, +r.open, +r.high, +r.low, +r.close]))
    .filter((b) => b[4] > 0 && b[0] >= HISTORY_FROM);

  const q = quote.data;
  const price = +q.current_price;
  const tradeTime = q.last_trade_time; // New York time, no offset
  if (price > 0 && tradeTime) {
    const today = fixBar([tradeTime.slice(0, 10), +q.open, +q.high, +q.low, price]);
    const last = bars.at(-1);
    if (last?.[0] === today[0]) bars[bars.length - 1] = today;
    else if (!last || today[0] > last[0]) bars.push(today);
  }
  return {
    source: 'CBOE delayed quotes (15 min delay)',
    price: price > 0 ? round(price) : bars.at(-1)[4],
    priceTime: tradeTime ? newYorkToUtc(tradeTime) : null,
    endOfDay: false,
    bars,
  };
}

// ---------- VIX futures, continuous front month ----------

function thirdFriday(year, month) {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return new Date(Date.UTC(year, month, 1 + ((5 - firstDow + 7) % 7) + 14));
}

/** Monthly VX contracts expire 30 days before the 3rd Friday of the following month. */
function vxExpiry(year, month) {
  return new Date(thirdFriday(month === 11 ? year + 1 : year, (month + 1) % 12) - 30 * DAY);
}

async function fetchVxContract(year, month) {
  const expiry = vxExpiry(year, month);
  // Exchange holidays move the expiry to an earlier business day.
  for (let back = 0; back <= 2; back++) {
    const date = isoDate(new Date(expiry - back * DAY));
    const csv = await get(VX_CSV(date), { text: true, optional: true });
    if (csv) return { expiry: date, csv };
  }
  return null;
}

function parseVxCsv(csv) {
  // Trade Date,Futures,Open,High,Low,Close,Settle,Change,Total Volume,EFP,Open Interest
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(','))
    .filter((c) => c.length >= 7 && +c[6] > 0)
    .map((c) => ({ label: c[1], bar: fixBar([c[0], +c[2], +c[3], +c[4], +c[6]]) }));
}

async function fetchVxFutures({ rollDaysBeforeExpiry }) {
  const now = new Date();
  const months = [];
  for (let i = -30; i <= 2; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    months.push([d.getUTCFullYear(), d.getUTCMonth()]);
  }
  const contracts = (await Promise.all(months.map(([y, m]) => fetchVxContract(y, m))))
    .filter(Boolean)
    .map((c) => ({ expiry: c.expiry, rows: parseVxCsv(c.csv) }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (contracts.length < 3) throw new Error('too few VX contracts found');

  const rollDate = (expiry) => isoDate(new Date(new Date(expiry) - rollDaysBeforeExpiry * DAY));
  const bars = [];
  let front = null;
  // Each contract is "front month" from the previous contract's roll date until its own.
  for (let i = 1; i < contracts.length; i++) {
    const from = rollDate(contracts[i - 1].expiry);
    const to = rollDate(contracts[i].expiry);
    for (const row of contracts[i].rows) {
      const date = row.bar[0];
      if (date >= from && date < to) {
        bars.push(row.bar);
        front = { label: row.label, expiry: contracts[i].expiry, rollsOn: to };
      }
    }
  }
  bars.sort((a, b) => a[0].localeCompare(b[0]));
  const last = bars.at(-1);
  return {
    source: `CBOE futures settlement prices (end of day). Front month: ${front.label}, expires ${front.expiry}, chart rolls on ${front.rollsOn}.`,
    price: last[4],
    priceTime: newYorkToUtc(`${last[0]}T16:00:00`),
    endOfDay: true,
    bars,
  };
}

// ---------- exchange rates (ECB daily reference rates) ----------

const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

async function fetchFx() {
  const xml = await get(ECB_DAILY, { text: true });
  const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  const rates = { EUR: 1 };
  for (const [, ccy, rate] of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    rates[ccy] = Number(rate);
  }
  if (!date || !rates.USD) throw new Error('unexpected ECB response');
  return { source: 'ECB reference rates', date, base: 'EUR', rates };
}

// ---------- main ----------

const FETCHERS = { cboe: fetchCboe, 'vx-futures': fetchVxFutures };

async function build(inst) {
  const { source, ...meta } = inst;
  try {
    const data = await FETCHERS[source.type](source);
    return { ...meta, ...data, stale: false };
  } catch (err) {
    console.log(`::warning::${inst.id}: ${err.message}`);
    if (!PREVIOUS) return null;
    try {
      const prev = await get(`${PREVIOUS}/${inst.id}.json`, { retries: 1 });
      console.log(`${inst.id}: reusing previously published data`);
      return { ...prev, ...meta, stale: true };
    } catch (err2) {
      console.log(`::warning::${inst.id}: no fallback either (${err2.message})`);
      return null;
    }
  }
}

async function buildFx() {
  try {
    return { ...(await fetchFx()), stale: false };
  } catch (err) {
    console.log(`::warning::FX: ${err.message}`);
    if (!PREVIOUS) return null;
    try {
      return { ...(await get(`${PREVIOUS}/fx.json`, { retries: 1 })), stale: true };
    } catch {
      return null;
    }
  }
}

const [results, fx] = await Promise.all([
  Promise.all(INSTRUMENTS.map(build)).then((r) => r.filter(Boolean)),
  buildFx(),
]);
await mkdir(OUT, { recursive: true });
const fetchedAt = new Date().toISOString();
if (fx) {
  await writeFile(join(OUT, 'fx.json'), JSON.stringify({ ...fx, fetchedAt }));
  console.log(`FX: ${fx.date}, 1 USD = ${(fx.rates.PLN / fx.rates.USD).toFixed(4)} PLN${fx.stale ? ' (stale)' : ''}`);
}
for (const r of results) {
  await writeFile(join(OUT, `${r.id}.json`), JSON.stringify({ ...r, fetchedAt }));
  console.log(`${r.id}: ${r.bars.length} bars, last ${r.bars.at(-1)?.[0]}, price ${r.price}${r.stale ? ' (stale)' : ''}`);
}
const index = results.map(({ bars, ...rest }) => rest);
await writeFile(join(OUT, 'instruments.json'), JSON.stringify({ fetchedAt, instruments: index }, null, 1));
if (!results.length) console.log('::warning::No price data could be fetched; the site will run in manual-price mode.');
