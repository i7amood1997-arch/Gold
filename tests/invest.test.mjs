import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchaseCost, portfolio, cheaperThan, targetStatus } from '../js/invest.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('purchase from a total or from a gram price', () => {
  assert.deepEqual(purchaseCost({ w: '5', mode: 'total', amount: '250' }), { total: 250, perGram: 50 });
  assert.deepEqual(purchaseCost({ w: '5', mode: 'perGram', amount: '50' }), { total: 250, perGram: 50 });
  assert.deepEqual(purchaseCost({ w: '٥', mode: 'total', amount: '٢٥٠' }), { total: 250, perGram: 50 });
  assert.equal(purchaseCost({ w: '', mode: 'total', amount: '250' }), null);
  assert.equal(purchaseCost({ w: '5', mode: 'total', amount: '0' }), null);
});

test('profit and break-even without a shop discount', () => {
  const p = portfolio({ holdings: [{ w: 5, k: 24, total: 250 }], p24: 52 });
  near(p.market, 260);
  near(p.pl, 10);
  near(p.plPct, 0.04);
  near(p.rows[0].breakEven, 50);
  near(p.breakEven24, 50);
});

test('shop discount lowers the sell value and raises break-even', () => {
  const p = portfolio({ holdings: [{ w: 5, k: 24, total: 250 }], p24: 52, discountPct: 2 });
  near(p.sell, 260 * 0.98);
  near(p.pl, 260 * 0.98 - 250);
  near(p.rows[0].breakEven, 250 / (5 * 0.98));
});

test('mixed karats use price ratios, break-even is in 24K', () => {
  const ratios = { 24: 1, 22: 0.916, 21: 0.875, 18: 0.75 };
  const p = portfolio({ holdings: [{ w: 10, k: 21, total: 420 }, { w: 5, k: 24, total: 250 }], p24: 50, ratios });
  near(p.market, 10 * 0.875 * 50 + 5 * 50);
  near(p.breakEven24, 670 / (10 * 0.875 + 5));
  near(p.rows[0].breakEven, 42); // 21K gram price that returns 420 for 10 g
});

test('price position and targets', () => {
  const past = Array.from({ length: 100 }, (_, i) => 40 + i * 0.1); // 40.0 .. 49.9
  near(cheaperThan(past, 45), 0.49);
  assert.equal(cheaperThan(past.slice(0, 5), 45), null);
  assert.deepEqual(targetStatus({ side: 'sell', price: 52 }, 52), { reached: true, gapPct: 0 });
  near(targetStatus({ side: 'sell', price: 52 }, 50).gapPct, 0.04);
  assert.equal(targetStatus({ side: 'sell', price: 52 }, 50).reached, false);
  assert.equal(targetStatus({ side: 'buy', price: 48 }, 47).reached, true);
});
