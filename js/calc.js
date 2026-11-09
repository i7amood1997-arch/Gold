// Pure gold math. No DOM, no network — everything here is unit-tested in
// tests/calc.test.mjs. Money values are kept at full precision and only
// rounded for display.

export const TROY_OUNCE_G = 31.1034768;
export const KARATS = [24, 22, 21, 18];
export const NISAB_GRAMS = 85; // pure (24K) gold
export const ZAKAT_RATE = 0.025;

export const purity = (k) => k / 24;

// 24K price per gram in local currency.
export function gramPrice24(spotUsdPerOz, fx, adjustPct = 0) {
  if (!(spotUsdPerOz > 0) || !(fx > 0)) return null;
  return (spotUsdPerOz / TROY_OUNCE_G) * fx * (1 + (adjustPct || 0) / 100);
}

export const karatPrice = (p24, k) => p24 * purity(k);

// Accepts Arabic-Indic / Persian digits, Arabic decimal separator and
// thousands separators. Returns NaN for empty or invalid input.
export function parseNum(raw) {
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === 'number') return raw;
  let s = String(raw).trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬\s'_]/g, '')
    .replace(/،/g, ',');
  if (!s) return NaN;
  if (s.includes(',')) {
    if (s.includes('.')) s = s.replace(/,/g, '');            // 1,250.5
    else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, ''); // 12,500
    else s = s.replace(',', '.');                              // 12,5
  }
  if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return NaN;
  return Number(s);
}

const pos = (n) => Number.isFinite(n) && n > 0;

function cleanItems(items) {
  return (items || [])
    .map((it) => ({ ...it, w: parseNum(it.w), k: Number(it.k) }))
    .filter((it) => pos(it.w) && KARATS.concat(14).includes(it.k));
}

function goldOf(items, p24) {
  let weight = 0, pure = 0, gold = 0;
  for (const it of items) {
    weight += it.w;
    pure += it.w * purity(it.k);
    gold += it.w * karatPrice(p24, it.k);
  }
  return { weight, pure, gold };
}

// "How much making charge did I pay?" — reverse an invoice total.
// vatBasis: 'full'   VAT on gold + making (KSA, UAE, Bahrain, Oman jewellery)
//           'making' VAT on the making charge only
//           'none'
export function analyzeInvoice({ items, total, vatRate = 0, vatIncluded = true, vatBasis = 'full', p24 }) {
  const list = cleanItems(items);
  const T = parseNum(total);
  if (!list.length || !pos(T) || !pos(p24)) return null;
  const { weight, pure, gold } = goldOf(list, p24);
  const v = vatBasis === 'none' ? 0 : vatRate || 0;
  let making, vat, paid;
  if (vatBasis === 'making') {
    making = vatIncluded ? (T - gold) / (1 + v) : T - gold;
    vat = Math.max(making, 0) * v;
    paid = vatIncluded ? T : T + vat;
  } else {
    const preVat = vatIncluded ? T / (1 + v) : T;
    making = preVat - gold;
    vat = preVat * v;
    paid = preVat + vat;
  }
  return {
    weight, pure, gold, making, vat, paid,
    makingPerGram: making / weight,
    makingPct: making / gold,
    level: makingLevel(making / gold),
    belowGold: making < 0,
  };
}

// "What should this piece cost?" — build a price from weight + making.
// makingMode: 'perGram' | 'total' | 'percent'
export function pricePieces({ items, vatRate = 0, vatBasis = 'full', p24, makingMode = 'perGram' }) {
  const list = cleanItems(items);
  if (!list.length || !pos(p24)) return null;
  let weight = 0, pure = 0, gold = 0, making = 0;
  const rows = list.map((it) => {
    const g = it.w * karatPrice(p24, it.k);
    const m = parseNum(it.m);
    let mk = 0;
    if (Number.isFinite(m) && m >= 0) {
      if (makingMode === 'total') mk = m;
      else if (makingMode === 'percent') mk = (g * m) / 100;
      else mk = m * it.w;
    }
    weight += it.w; pure += it.w * purity(it.k); gold += g; making += mk;
    return { w: it.w, k: it.k, gold: g, making: mk, subtotal: g + mk };
  });
  const v = vatBasis === 'none' ? 0 : vatRate || 0;
  const vat = (vatBasis === 'making' ? making : gold + making) * v;
  const preVat = gold + making;
  return {
    rows, weight, pure, gold, making, vat, preVat,
    total: preVat + vat,
    makingPerGram: making / weight,
    makingPct: gold ? making / gold : 0,
    level: makingLevel(gold ? making / gold : 0),
  };
}

// Selling old gold: market melt value, and — if the shop made an offer —
// how much it is deducting.
export function sellGold({ items, offer, p24 }) {
  const list = cleanItems(items);
  if (!list.length || !pos(p24)) return null;
  const { weight, pure, gold } = goldOf(list, p24);
  const O = parseNum(offer);
  const res = { weight, pure, gold, offer: null };
  if (pos(O)) {
    const ded = gold - O;
    res.offer = O;
    res.deduction = ded;
    res.deductionPerGram = ded / weight;
    res.deductionPct = ded / gold;
    res.level = ded / gold <= 0.02 ? 0 : ded / gold <= 0.04 ? 1 : ded / gold <= 0.07 ? 2 : 3;
  }
  return res;
}

export function zakat({ items, p24, nisab = NISAB_GRAMS, rate = ZAKAT_RATE }) {
  const list = cleanItems(items);
  const { weight, pure, gold } = goldOf(list, pos(p24) ? p24 : 0);
  const due = pure >= nisab;
  return {
    weight, pure, value: gold, nisab,
    nisabValue: pos(p24) ? nisab * p24 : null,
    due,
    remaining: Math.max(nisab - pure, 0),
    zakatPure: due ? pure * rate : 0,
    zakatValue: due ? gold * rate : 0,
  };
}

// w grams of karat a contain the same pure gold as w*a/b grams of karat b.
export const convertKarat = (w, from, to) => (parseNum(w) * from) / to;

// Rough guidance bands for making charge as a share of the gold value.
// 0 low · 1 fair · 2 high · 3 very high
export function makingLevel(pct) {
  if (!Number.isFinite(pct)) return null;
  if (pct < 0.05) return 0;
  if (pct < 0.1) return 1;
  if (pct < 0.18) return 2;
  return 3;
}

export const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
