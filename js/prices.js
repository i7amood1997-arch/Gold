// Gold price engine.
//
// Accuracy strategy:
//  1. Ask every real-time source in parallel (each with its own timeout).
//     Only feeds that allow browser (CORS) access can be used from a phone:
//     Gold API is the primary; AwesomeAPI is a rate-limited backup.
//  2. Reject anything implausible, then take the median of the sources that
//     agree within 1% — one bad feed can't move the price.
//  3. If no real-time feed answers, fall back to the daily reference rate,
//     and if the network is gone, to the last good price (clearly labelled).
//  4. Gulf currencies pegged to the dollar use their official peg — exact,
//     no exchange-rate API needed. Floating currencies use the median of two
//     FX feeds, cached for a few hours.

import { median, TROY_OUNCE_G, STANDARD_RATIOS } from './calc.js';

// How a local price is built from the global ounce price (USD).
//  standard — ounce ÷ 31.1035 g × exchange rate, karats by fineness.
//  delmon   — Delmon Bars (Bahrain) dealer formula, read from their public
//             price page: 24K = oz × 1.417 ÷ 116.64, 21K = oz × 1.417 ÷ 132.2,
//             22K = 24K × 0.916, 18K = 24K × 0.750. If their page changes
//             these constants, update them here.
export const PROFILES = {
  standard: {
    name: 'السعر العالمي',
    desc: 'المعادلة القياسية: الأونصة ÷ 31.1035 × سعر الصرف، والعيارات حسب نقاوتها.',
    p24: (usd, fx) => (usd / TROY_OUNCE_G) * fx,
    ratios: STANDARD_RATIOS,
  },
  delmon: {
    name: 'دلمون للسبائك',
    desc: 'نفس معادلة موقع دلمون للسبائك في البحرين، وتشمل هامش التاجر.',
    currency: 'BHD',
    p24: (usd) => (usd * 1.417) / 116.64,
    ratios: Object.freeze({ 24: 1, 22: 0.916, 21: 116.64 / 132.2, 18: 0.75, 14: 14 / 24 }),
  },
};

export const CURRENCIES = {
  BHD: { name: 'دينار بحريني', sym: 'د.ب', dec: 3, vat: 0.1, basis: 'full', peg: 0.376, country: 'البحرين' },
  SAR: { name: 'ريال سعودي', sym: 'ر.س', dec: 2, vat: 0.15, basis: 'full', peg: 3.75, country: 'السعودية' },
  AED: { name: 'درهم إماراتي', sym: 'د.إ', dec: 2, vat: 0.05, basis: 'full', peg: 3.6725, country: 'الإمارات' },
  KWD: { name: 'دينار كويتي', sym: 'د.ك', dec: 3, vat: 0, basis: 'none', peg: null, approx: 0.307, country: 'الكويت' },
  QAR: { name: 'ريال قطري', sym: 'ر.ق', dec: 2, vat: 0, basis: 'none', peg: 3.64, country: 'قطر' },
  OMR: { name: 'ريال عماني', sym: 'ر.ع', dec: 3, vat: 0.05, basis: 'full', peg: 0.3845, country: 'عُمان' },
  JOD: { name: 'دينار أردني', sym: 'د.أ', dec: 3, vat: 0, basis: 'none', peg: 0.709, country: 'الأردن' },
  EGP: { name: 'جنيه مصري', sym: 'ج.م', dec: 2, vat: 0, basis: 'none', peg: null, approx: 48.5, country: 'مصر' },
  USD: { name: 'دولار أمريكي', sym: '$', dec: 2, vat: 0, basis: 'none', peg: 1, country: 'دولار' },
};

const TIMEOUT_MS = 8000;
const CURRENCY_API = [
  (tag, file) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/${file}.min.json`,
  (tag, file) => `https://${tag === 'latest' ? 'latest' : tag}.currency-api.pages.dev/v1/currencies/${file}.min.json`,
];

async function getJSON(url, timeout = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function firstOk(urls) {
  let err;
  for (const u of urls) {
    try { return await getJSON(u); } catch (e) { err = e; }
  }
  throw err;
}

// ---- parsers (exported for tests) ---------------------------------------

export function parseGoldApi(j) {
  const price = Number(j?.price);
  const ts = Date.parse(j?.updatedAt) || Date.now();
  return { id: 'gold-api', name: 'Gold API', kind: 'live', price, ts };
}

// AwesomeAPI: { XAUUSD: { bid: "4138.1", ask: "4138.6", timestamp: "1794187079" } }
export function parseAwesome(j) {
  const q = j?.XAUUSD;
  const bid = Number(q?.bid), ask = Number(q?.ask);
  const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid;
  const ts = Number(q?.timestamp) * 1000 || Date.now();
  return { id: 'awesome', name: 'AwesomeAPI', kind: 'live', price, ts };
}

// fawazahmed0 currency-api: { date: 'YYYY-MM-DD', xau: { usd: 4012.3, sar: ... } }
export function parseCurrencyApiXau(j) {
  const price = Number(j?.xau?.usd);
  const ts = Date.parse(`${j?.date}T00:00:00Z`) || Date.now();
  // Keep only what the app uses: XAU in USD and in the floating currencies.
  const x = j?.xau || {};
  const rates = { usd: x.usd, kwd: x.kwd, egp: x.egp };
  return { id: 'daily', name: 'المرجع اليومي', kind: 'daily', price, ts, date: j?.date, rates };
}

// ---- aggregation ---------------------------------------------------------

const plausible = (q) => q && Number.isFinite(q.price) && q.price > 200 && q.price < 50000;

export function aggregate(quotes, { now = Date.now(), closedAfterMs = 30 * 60e3, ref = null } = {}) {
  const valid = quotes.filter(plausible);
  const live = valid.filter((q) => q.kind === 'live');
  const pool = live.length ? live : valid;
  if (!pool.length) return null;

  const mid = median(pool.map((q) => q.price));
  let agreed = pool.filter((q) => Math.abs(q.price - mid) / mid <= 0.01);
  if (!agreed.length) {
    // Two feeds that disagree by >2%: trust the one closer to the daily reference.
    const anchor = ref || mid;
    agreed = [pool.reduce((a, b) => (Math.abs(a.price - anchor) <= Math.abs(b.price - anchor) ? a : b))];
  }
  const prices = agreed.map((q) => q.price);
  const ts = Math.max(...agreed.map((q) => q.ts));
  const status = !live.length ? 'daily' : now - ts > closedAfterMs ? 'closed' : 'live';
  return {
    usd: median(prices),
    ts,
    status,
    sources: agreed.map((q) => q.name),
    rejected: pool.length - agreed.length,
    spreadPct: prices.length > 1 ? (Math.max(...prices) - Math.min(...prices)) / median(prices) : 0,
  };
}

// ---- public API ----------------------------------------------------------

export async function fetchSpot() {
  const jobs = [
    getJSON('https://api.gold-api.com/price/XAU').then(parseGoldApi),
    getJSON('https://economia.awesomeapi.com.br/json/last/XAU-USD').then(parseAwesome),
    firstOk(CURRENCY_API.map((f) => f('latest', 'xau'))).then(parseCurrencyApiXau),
  ];
  const settled = await Promise.allSettled(jobs);
  const quotes = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const daily = quotes.find((q) => q.kind === 'daily' && plausible(q)) || null;
  const agg = aggregate(quotes, { ref: daily?.price });
  if (!agg) throw new Error('no source answered');
  return { ...agg, daily: daily ? { date: daily.date, usd: daily.price, rates: daily.rates } : null };
}

// Exchange rate USD -> code. Pegged currencies never hit the network.
export async function fetchFx(code, dailyRates) {
  const c = CURRENCIES[code];
  if (c.peg) return { rate: c.peg, kind: 'peg', ts: Date.now() };
  const lower = code.toLowerCase();
  const jobs = [
    getJSON('https://open.er-api.com/v6/latest/USD').then((j) => Number(j?.rates?.[code])),
    firstOk(CURRENCY_API.map((f) => f('latest', 'usd'))).then((j) => Number(j?.usd?.[lower])),
  ];
  const vals = (await Promise.allSettled(jobs))
    .filter((s) => s.status === 'fulfilled' && s.value > 0)
    .map((s) => s.value);
  // The daily XAU table also implies a rate: (XAU in code) / (XAU in USD).
  if (dailyRates?.usd > 0 && dailyRates?.[lower] > 0) vals.push(dailyRates[lower] / dailyRates.usd);
  if (!vals.length) throw new Error('no fx');
  return { rate: median(vals), kind: 'market', ts: Date.now() };
}

// Daily XAU/USD closes for the chart. Past days never change, so callers cache them.
export async function fetchDay(date) {
  const j = await firstOk(CURRENCY_API.map((f) => f(date, 'xau')));
  const q = parseCurrencyApiXau(j);
  if (!plausible(q)) throw new Error('bad day');
  return { date, usd: q.price, rates: q.rates };
}
