import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNum, gramPrice24, karatPrice, analyzeInvoice, pricePieces, sellGold, zakat,
  convertKarat, makingLevel, TROY_OUNCE_G,
} from '../js/calc.js';
import { aggregate, parseSwissquote, parseGoldApi, parseCurrencyApiXau } from '../js/prices.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('parseNum handles Arabic digits and separators', () => {
  assert.equal(parseNum('١٢٫٥'), 12.5);
  assert.equal(parseNum('۱۲'), 12);
  assert.equal(parseNum('12,5'), 12.5);
  assert.equal(parseNum('12,500'), 12500);
  assert.equal(parseNum('1,250.75'), 1250.75);
  assert.equal(parseNum(' 7 '), 7);
  assert.equal(parseNum('.5'), 0.5);
  assert.ok(Number.isNaN(parseNum('')));
  assert.ok(Number.isNaN(parseNum('abc')));
  assert.ok(Number.isNaN(parseNum('1.2.3')));
});

test('24K gram price from spot and peg', () => {
  const p = gramPrice24(3110.34768, 3.75);
  near(p, 375, 1e-6);
  near(gramPrice24(3110.34768, 3.75, 1), 378.75, 1e-6);
  assert.equal(gramPrice24(0, 3.75), null);
  near(karatPrice(480, 21), 420);
  near(karatPrice(480, 18), 360);
  near(TROY_OUNCE_G, 31.1034768);
});

test('invoice analysis, VAT on full price, included', () => {
  // 10 g of 21K at p24=480 -> gold 4200. Making 500 -> 4700 pre-VAT, 5405 with 15%.
  const r = analyzeInvoice({ items: [{ w: '10', k: 21 }], total: '5405', vatRate: 0.15, vatIncluded: true, vatBasis: 'full', p24: 480 });
  near(r.gold, 4200);
  near(r.making, 500);
  near(r.makingPerGram, 50);
  near(r.vat, 705);
  near(r.paid, 5405);
  assert.equal(r.level, 2); // 11.9%
});

test('invoice analysis, VAT on making only', () => {
  // gold 4200 + making 500 + 15% of 500 = 4775
  const r = analyzeInvoice({ items: [{ w: 10, k: 21 }], total: 4775, vatRate: 0.15, vatIncluded: true, vatBasis: 'making', p24: 480 });
  near(r.making, 500);
  near(r.vat, 75);
});

test('invoice analysis, VAT excluded and no VAT', () => {
  const a = analyzeInvoice({ items: [{ w: 10, k: 21 }], total: 4700, vatRate: 0.15, vatIncluded: false, vatBasis: 'full', p24: 480 });
  near(a.making, 500); near(a.paid, 5405);
  const b = analyzeInvoice({ items: [{ w: 10, k: 21 }], total: 4700, vatRate: 0, vatBasis: 'none', p24: 480 });
  near(b.making, 500); near(b.vat, 0);
});

test('invoice with several pieces of mixed karat', () => {
  const r = analyzeInvoice({ items: [{ w: 5, k: 21 }, { w: 4, k: 18 }, { w: '', k: 22 }], total: 4000, vatRate: 0, vatBasis: 'none', p24: 480 });
  near(r.weight, 9);
  near(r.gold, 2100 + 1440);
  near(r.making, 460);
});

test('below-gold invoice is flagged', () => {
  const r = analyzeInvoice({ items: [{ w: 10, k: 21 }], total: 4000, vatBasis: 'none', p24: 480 });
  assert.equal(r.belowGold, true);
});

test('pricing pieces with each making mode', () => {
  const base = { items: [{ w: 10, k: 21, m: 40 }], vatRate: 0.15, vatBasis: 'full', p24: 480 };
  const a = pricePieces(base);
  near(a.making, 400); near(a.total, 4600 * 1.15);
  const b = pricePieces({ ...base, makingMode: 'total' });
  near(b.making, 40);
  const c = pricePieces({ ...base, makingMode: 'percent', items: [{ w: 10, k: 21, m: 10 }] });
  near(c.making, 420);
  const d = pricePieces({ ...base, vatBasis: 'making' });
  near(d.vat, 60);
});

test('selling gold and implied deduction', () => {
  const r = sellGold({ items: [{ w: 10, k: 21 }], offer: 4116, p24: 480 });
  near(r.gold, 4200);
  near(r.deductionPerGram, 8.4);
  near(r.deductionPct, 0.02);
  assert.equal(r.level, 0);
  assert.equal(sellGold({ items: [{ w: 10, k: 21 }], p24: 480 }).offer, null);
});

test('zakat uses pure gold against the 85 g nisab', () => {
  const below = zakat({ items: [{ w: 90, k: 21 }], p24: 480 }); // 78.75 pure
  assert.equal(below.due, false);
  near(below.remaining, 6.25);
  const above = zakat({ items: [{ w: 100, k: 21 }], p24: 480 }); // 87.5 pure
  assert.equal(above.due, true);
  near(above.zakatPure, 2.1875);
  near(above.zakatValue, 100 * 420 * 0.025);
});

test('karat conversion and making levels', () => {
  near(convertKarat(10, 18, 24), 7.5);
  near(convertKarat('8', 21, 22), 8 * 21 / 22);
  assert.deepEqual([0.02, 0.07, 0.12, 0.3].map(makingLevel), [0, 1, 2, 3]);
});

test('aggregate takes the median of agreeing live feeds', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const r = aggregate([
    { name: 'A', kind: 'live', price: 4000, ts: now - 5000 },
    { name: 'B', kind: 'live', price: 4002, ts: now - 2000 },
    { name: 'C', kind: 'live', price: 4400, ts: now }, // bad feed, >1% off
    { name: 'D', kind: 'daily', price: 3990, ts: now - 3600e3 },
  ], { now });
  near(r.usd, 4001);
  assert.equal(r.status, 'live');
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.sources, ['A', 'B']);
});

test('aggregate falls back to daily, detects closed market, breaks ties with ref', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const d = aggregate([{ name: 'D', kind: 'daily', price: 3990, ts: now }], { now });
  assert.equal(d.status, 'daily');
  const closed = aggregate([{ name: 'A', kind: 'live', price: 4000, ts: now - 36 * 3600e3 }], { now });
  assert.equal(closed.status, 'closed');
  const split = aggregate([
    { name: 'A', kind: 'live', price: 4000, ts: now },
    { name: 'B', kind: 'live', price: 4200, ts: now },
  ], { now, ref: 4010 });
  assert.deepEqual(split.sources, ['A']);
  assert.equal(aggregate([{ name: 'X', kind: 'live', price: NaN, ts: now }]), null);
});

test('source parsers', () => {
  const g = parseGoldApi({ price: 4012.5, updatedAt: '2026-11-09T11:59:00Z' });
  assert.equal(g.price, 4012.5);
  const s = parseSwissquote([
    { ts: 1, spreadProfilePrices: [{ spreadProfile: 'standard', bid: 3990, ask: 4010 }, { spreadProfile: 'prime', bid: 3999, ask: 4001 }] },
    { ts: 2, spreadProfilePrices: [{ spreadProfile: 'prime', bid: 4001, ask: 4003 }] },
  ]);
  near(s.price, 4001);
  assert.equal(s.ts, 2);
  const c = parseCurrencyApiXau({ date: '2026-11-09', xau: { usd: 4000, kwd: 1228, sar: 15000 } });
  assert.equal(c.price, 4000);
  assert.equal(c.rates.kwd, 1228);
  assert.equal(c.rates.sar, undefined);
});
