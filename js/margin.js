// Pure margin math. No DOM, so it can be unit-tested with `node --test`.
//
// Model (how XTB and most CFD brokers work):
//   account balance  = deposit + investment
//   units            = investment * leverage / openPrice      (position size)
//   P/L at price P   = units * (P - openPrice)    for long
//                      units * (openPrice - P)    for short
//   equity(P)        = balance + P/L(P)
//   used margin(P)   = units * P / leverage                    (recalculated at the current price)
//   margin level(P)  = equity(P) / used margin(P)
//
// A margin call (or stop-out) happens when the margin level drops to `level`
// (e.g. 0.7 for 70 %).
//
// Currency: deposit and investment are in the account currency (e.g. PLN), prices
// in the instrument currency (e.g. USD). `fx` = account currency per 1 unit of
// instrument currency (e.g. 3.92 PLN per USD). Like the broker, P/L and margin are
// converted at the same rate, so with a constant rate the trigger prices depend
// only on the deposit/investment ratio and not on `fx` at all.

const LONG = 'long';

function valid({ deposit, investment, leverage, openPrice, level }) {
  return (
    Number.isFinite(deposit) && deposit >= 0 &&
    Number.isFinite(investment) && investment > 0 &&
    Number.isFinite(leverage) && leverage >= 1 &&
    Number.isFinite(openPrice) && openPrice > 0 &&
    Number.isFinite(level) && level > 0 && level < leverage
  );
}

/** Balance per unit of position: (deposit + investment) / units. */
function balancePerUnit({ deposit, investment, leverage, openPrice }) {
  return ((deposit + investment) * openPrice) / (investment * leverage);
}

/**
 * Price at which the margin level falls to `level`.
 * Returns NaN for invalid input and 0 for a long position that can never
 * reach that level (it is funded well enough to survive a drop to zero).
 */
export function triggerPrice(p) {
  if (!valid(p)) return NaN;
  const { direction, leverage: L, openPrice: P0, level: m } = p;
  const k = balancePerUnit(p);
  if (direction === LONG) {
    // balance + u(P - P0) = m*u*P/L  ->  P = (P0 - k) / (1 - m/L)
    return Math.max(0, (P0 - k) / (1 - m / L));
  }
  // balance + u(P0 - P) = m*u*P/L  ->  P = (k + P0) / (1 + m/L)
  return (k + P0) / (1 + m / L);
}

// Closest a trigger line can get to the open price when solving. When solving
// for the investment we stop at a margin level of 101 % at open (investment =
// 100 x deposit), otherwise the investment would grow to infinity.
const MIN_OPEN_LEVEL_FOR_INVESTMENT = 1.01;

/**
 * Inverse of triggerPrice: find the deposit or investment that puts the
 * trigger (margin call) exactly at `target`.
 *
 * @param {object} p   same fields as triggerPrice, plus:
 * @param {'deposit'|'investment'} p.solveFor  which value may change
 * @param {number} p.target                    wanted trigger price
 * @returns {{value:number, target:number, clamped:boolean} | null}
 *          `target` is the trigger price actually reached (after clamping),
 *          null when there is no solution (e.g. deposit is 0 and locked).
 */
export function solveForTarget(p) {
  const { direction, solveFor, deposit, investment, leverage: L, openPrice: P0, level: m } = p;
  let target = p.target;
  if (!(Number.isFinite(L) && L >= 1 && Number.isFinite(P0) && P0 > 0 && m > 0 && m < L)) return null;
  if (!Number.isFinite(target)) return null;

  // k = balance per unit. Margin level at open = k * L / P0, which must be >= 100 %
  // (deposit >= 0). k depends only on the target price:
  const kFromTarget = (t) => (direction === LONG ? P0 - t * (1 - m / L) : t * (1 + m / L) - P0);
  const targetFromK = (k) => (direction === LONG ? (P0 - k) / (1 - m / L) : (k + P0) / (1 + m / L));

  const minOpenLevel = solveFor === 'investment' ? MIN_OPEN_LEVEL_FOR_INVESTMENT : 1;
  const kMin = (minOpenLevel * P0) / L;
  let clamped = false;

  // Long: a lower line needs more money. A line at/below 0 means "never"; treat it as 0.
  if (direction === LONG && target < 0) {
    target = 0;
    clamped = true;
  }
  let k = kFromTarget(target);
  if (k < kMin) {
    k = kMin;
    target = targetFromK(k);
    clamped = true;
  }

  if (solveFor === 'investment') {
    if (!(Number.isFinite(deposit) && deposit > 0)) return null;
    // k = (D + I) * P0 / (I * L)  ->  I = D * P0 / (k*L - P0)
    return { value: (deposit * P0) / (k * L - P0), target, clamped };
  }
  if (!(Number.isFinite(investment) && investment > 0)) return null;
  // D = k * I * L / P0 - I
  return { value: Math.max(0, (k * investment * L) / P0 - investment), target, clamped };
}

/**
 * Account figures at a given market price.
 * Money values (balance, pnl, equity, margin) are in the account currency;
 * units and notional are in the instrument's terms (notional in its currency).
 */
export function snapshot({ direction, deposit, investment, leverage, openPrice, price, fx = 1 }) {
  const units = ((investment / fx) * leverage) / openPrice;
  const balance = deposit + investment;
  const pnl = (direction === LONG ? 1 : -1) * units * (price - openPrice) * fx;
  const equity = balance + pnl;
  const margin = ((units * price) / leverage) * fx;
  return {
    units,
    balance,
    notional: units * price,
    pnl,
    equity,
    margin,
    marginLevel: margin > 0 ? equity / margin : NaN,
  };
}

/** Long if the target is above the open price, short if below, otherwise `fallback`. */
export function directionFor(openPrice, targetPrice, fallback = LONG) {
  if (!(openPrice > 0 && targetPrice > 0) || targetPrice === openPrice) return fallback;
  return targetPrice > openPrice ? LONG : 'short';
}

/** Signed % change from `from` to `to`. */
export function pctChange(from, to) {
  return ((to - from) / from) * 100;
}

/**
 * Share of daily bars whose intraday range reached `level`.
 * bars: [date, open, high, low, close][]
 */
export function shareOfDaysReaching(bars, level, direction) {
  if (!bars?.length || !(level > 0)) return null;
  let hits = 0;
  for (const b of bars) {
    if (direction === LONG ? b[3] <= level : b[2] >= level) hits++;
  }
  return { hits, total: bars.length, pct: (hits / bars.length) * 100, since: bars[0][0] };
}
