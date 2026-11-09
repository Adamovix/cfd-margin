import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerPrice, solveForTarget, snapshot, shareOfDaysReaching } from '../js/margin.js';

const base = { deposit: 2000, investment: 2000, leverage: 5, openPrice: 20, level: 0.7 };
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

for (const direction of ['long', 'short']) {
  test(`${direction}: margin level equals the trigger level at the trigger price`, () => {
    const p = { ...base, direction };
    const P = triggerPrice(p);
    const s = snapshot({ ...p, price: P });
    close(s.marginLevel, p.level);
  });

  test(`${direction}: solving for investment round-trips`, () => {
    const p = { ...base, direction };
    const target = direction === 'long' ? 15 : 26;
    const r = solveForTarget({ ...p, solveFor: 'investment', target });
    assert.equal(r.clamped, false);
    close(triggerPrice({ ...p, investment: r.value }), target);
  });

  test(`${direction}: solving for deposit round-trips`, () => {
    const p = { ...base, direction };
    const target = direction === 'long' ? 12 : 30;
    const r = solveForTarget({ ...p, solveFor: 'deposit', target });
    assert.equal(r.clamped, false);
    close(triggerPrice({ ...p, deposit: r.value }), target);
  });

  test(`${direction}: line cannot be dragged past the zero-deposit level`, () => {
    const p = { ...base, direction };
    const target = direction === 'long' ? 19.9 : 20.1; // almost at the open price
    const r = solveForTarget({ ...p, solveFor: 'deposit', target });
    assert.equal(r.clamped, true);
    assert.equal(r.value, 0);
    close(triggerPrice({ ...p, deposit: 0 }), r.target);
  });
}

test('worked example: long 1:5, margin call 70 %', () => {
  // balance 4000, units = 2000*5/20 = 500, margin call when
  // 4000 + 500(P-20) = 0.7 * 500 * P / 5  ->  P = 12 / 0.86
  close(triggerPrice({ ...base, direction: 'long' }), 12 / 0.86);
});

test('worked example: short 1:5, margin call 70 %', () => {
  // 4000 + 500(20-P) = 70P  ->  P = 14000 / 570
  close(triggerPrice({ ...base, direction: 'short' }), 14000 / 570);
});

test('long fully funded position is never margin called', () => {
  // deposit >= investment * (leverage - 1) means balance >= notional
  assert.equal(triggerPrice({ ...base, deposit: 8000, direction: 'long' }), 0);
});

test('more deposit moves the line further away', () => {
  const lo = triggerPrice({ ...base, direction: 'long' });
  const lo2 = triggerPrice({ ...base, deposit: 3000, direction: 'long' });
  assert.ok(lo2 < lo);
  const sh = triggerPrice({ ...base, direction: 'short' });
  const sh2 = triggerPrice({ ...base, deposit: 3000, direction: 'short' });
  assert.ok(sh2 > sh);
});

test('stop-out is further away than the margin call', () => {
  const mc = triggerPrice({ ...base, direction: 'short' });
  const so = triggerPrice({ ...base, direction: 'short', level: 0.5 });
  assert.ok(so > mc);
});

test('no solution for investment when deposit is 0 and locked', () => {
  assert.equal(solveForTarget({ ...base, deposit: 0, direction: 'long', solveFor: 'investment', target: 10 }), null);
});

test('invalid input gives NaN', () => {
  assert.ok(Number.isNaN(triggerPrice({ ...base, investment: 0, direction: 'long' })));
  assert.ok(Number.isNaN(triggerPrice({ ...base, openPrice: NaN, direction: 'long' })));
});

test('share of days reaching a level uses intraday low/high', () => {
  const bars = [
    ['2020-01-01', 10, 12, 9, 11],
    ['2020-01-02', 11, 30, 10, 12],
    ['2020-01-03', 12, 13, 11, 12],
  ];
  assert.equal(shareOfDaysReaching(bars, 25, 'short').hits, 1);
  assert.equal(shareOfDaysReaching(bars, 9.5, 'long').hits, 1);
});
