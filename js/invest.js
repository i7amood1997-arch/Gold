// Investment tracking: what the gold you bought is worth now, the profit or
// loss if you sold today, and the price you need to break even.
// Pure functions only, tested in tests/invest.test.mjs.

import { parseNum, karatPrice, STANDARD_RATIOS } from './calc.js';

// A purchase can be entered as a total paid or as a price per gram;
// return both, or null if the input is incomplete.
export function purchaseCost({ w, mode, amount }) {
  const W = parseNum(w), A = parseNum(amount);
  if (!(W > 0) || !(A > 0)) return null;
  return mode === 'perGram' ? { total: A * W, perGram: A } : { total: A, perGram: A / W };
}

// holdings: [{ w, k, total }]; p24: today's 24K gram price; discountPct:
// how much below market the shop pays when it buys gold back.
export function portfolio({ holdings, p24, ratios = STANDARD_RATIOS, discountPct = 0 }) {
  const keep = 1 - Math.min(Math.max(discountPct || 0, 0), 50) / 100;
  let cost = 0, market = 0, units24 = 0;
  const rows = holdings.map((h) => {
    const ratio = ratios[h.k] ?? h.k / 24;
    const m = p24 > 0 ? h.w * karatPrice(p24, h.k, ratios) : NaN;
    const sell = m * keep;
    cost += h.total;
    market += m;
    units24 += h.w * ratio;
    return {
      ...h,
      market: m,
      sell,
      pl: sell - h.total,
      plPct: (sell - h.total) / h.total,
      // gram price of this karat at which selling returns exactly what was paid
      breakEven: h.total / (h.w * keep),
    };
  });
  const sell = market * keep;
  return {
    rows,
    cost,
    market,
    sell,
    pl: sell - cost,
    plPct: cost ? (sell - cost) / cost : 0,
    // 24K gram price at which the whole portfolio breaks even
    breakEven24: units24 ? cost / (units24 * keep) : NaN,
  };
}

// Share of past days whose price was higher than today's: 0.8 means today is
// cheaper than 80% of the period. Information, not a signal.
export function cheaperThan(pastPrices, now) {
  const xs = pastPrices.filter((x) => x > 0);
  if (xs.length < 20 || !(now > 0)) return null;
  return xs.filter((x) => x > now).length / xs.length;
}

// Target: sell when the price rises to it, or buy when it falls to it.
export function targetStatus({ side, price }, now) {
  if (!(price > 0) || !(now > 0)) return null;
  const reached = side === 'buy' ? now <= price : now >= price;
  return { reached, gapPct: (price - now) / now };
}
