import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, decodeSettings, encodeSettings } from '../js/settings.js';
import { parseNum, fmtInput, roundMoney, roundPrice, timeToIso } from '../js/format.js';

test('settings survive a round trip through the URL', () => {
  const settings = { ...DEFAULTS, instrument: 'VX', accountCcy: 'EUR', deposit: 1234.5, target: 25.5, manualFx: 0.91, locked: 'investment' };
  assert.deepEqual(decodeSettings(encodeSettings(settings)), Object.fromEntries(
    Object.entries(settings).filter(([, v]) => v != null),
  ));
});

test('empty values are left out of the URL', () => {
  const str = encodeSettings({ ...DEFAULTS, manualPrice: null, target: NaN });
  assert.ok(!str.includes('price='));
  assert.ok(!str.includes('tgt='));
});

test('bad values in a link are ignored', () => {
  assert.deepEqual(decodeSettings('dir=sideways&lev=abc&i=<script>&lock=deposit&chart=pie'), { locked: 'deposit' });
});

test('numbers can be typed the Polish or English way', () => {
  assert.equal(parseNum('12 345,5'), 12345.5);
  assert.equal(parseNum('12345.5'), 12345.5);
  assert.equal(parseNum('1 000'), 1000);
  assert.ok(Number.isNaN(parseNum('')));
  assert.ok(Number.isNaN(parseNum('abc')));
});

test('rounding and input formatting', () => {
  assert.equal(fmtInput(0.1 + 0.2), '0.3');
  assert.equal(fmtInput(NaN), '');
  assert.equal(roundMoney(1234.56), 1235);
  assert.equal(roundMoney(12.345), 12.35);
  assert.equal(roundPrice(23.6945), 23.69);
  assert.equal(roundPrice(0.123456), 0.1235);
});

test('chart times become ISO dates', () => {
  assert.equal(timeToIso('2026-11-09'), '2026-11-09');
  assert.equal(timeToIso({ year: 2026, month: 1, day: 5 }), '2026-01-05');
  assert.equal(timeToIso(Date.UTC(2026, 10, 9) / 1000), '2026-11-09');
});
