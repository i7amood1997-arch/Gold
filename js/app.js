import {
  KARATS, TROY_OUNCE_G, NISAB_GRAMS, parseNum, karatPrice, analyzeInvoice,
  pricePieces, sellGold, zakat, convertKarat,
} from './calc.js';
import { CURRENCIES, PROFILES, fetchSpot, fetchFx, fetchDay } from './prices.js';
import { load, save, DEFAULT_SETTINGS, uid } from './store.js';
import { ICONS } from './icons.js';

export const BUILD = '2026.11.10-4';

/* ======================================================================
   State
   ====================================================================== */

const S = {
  settings: { ...DEFAULT_SETTINGS, ...load('settings', {}) },
  price: load('price', null), // { usd, ts, status, sources, daily, fetchedAt }
  fx: load('fx', {}),          // { KWD: { rate, ts, kind } }
  hist: load('hist', {}),      // { 'YYYY-MM-DD': { usd, kwd, egp } }
  entries: load('entries', []),
  calc: {
    mode: 'analyze',
    items: [{ w: '', k: null, m: '' }],
    total: '',
    vatIncluded: true,
    makingMode: 'perGram',
    offer: '',
    override: '',
    ...load('calc', {}),
  },
  zakatItems: load('zakat', [{ w: '', k: null }]),
  conv: { w: '', from: 18, to: 24 },
  heroK: null,
  range: load('range', 30),
  loading: false,
  offline: false,
  tab: 'prices',
  vaultFilter: 'all',
};

// Settings saved before pricing profiles existed: switch to the Delmon
// formula and drop any manual % that was calibrated against the old one.
(() => {
  const saved = load('settings', null);
  if (saved && !('profile' in saved)) {
    S.settings.adjustPct = 0;
    save('settings', S.settings);
  }
})();

const cur = () => CURRENCIES[S.settings.currency] || CURRENCIES.BHD;
const defK = () => S.settings.defaultKarat;

function fxRate() {
  const c = cur();
  if (c.peg) return c.peg;
  return S.fx[S.settings.currency]?.rate || c.approx;
}

// The active pricing formula. A dealer profile only applies in its own currency.
function profile() {
  const p = PROFILES[S.settings.profile];
  return p && (!p.currency || p.currency === S.settings.currency) ? p : PROFILES.standard;
}
const ratios = () => profile().ratios;
const kp = (p, k) => karatPrice(p, k, ratios());

// 24K gram price from the formula alone, before the user's adjustment.
function rawP24(usd = S.price?.usd, fx = fxRate()) {
  return usd > 0 && fx > 0 ? profile().p24(usd, fx) : null;
}

// Market 24K gram price (with the user's adjustment), never the manual one.
function marketP24(usd = S.price?.usd) {
  const raw = rawP24(usd);
  return raw ? raw * (1 + (S.settings.adjustPct || 0) / 100) : null;
}

function p24() {
  const st = S.settings;
  if (st.priceMode === 'manual') {
    const v = parseNum(st.manualPrice);
    if (v > 0) return v / (ratios()[st.manualKarat] ?? st.manualKarat / 24);
  }
  return marketP24();
}

/* ======================================================================
   Formatting
   ====================================================================== */

const nfCache = new Map();
function nf(min, max) {
  const loc = S.settings.digits === 'arab' ? 'ar-SA-u-nu-arab' : 'en-US';
  const key = `${loc}|${min}|${max}`;
  if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat(loc, { minimumFractionDigits: min, maximumFractionDigits: max }));
  return nfCache.get(key);
}
const fmt = (n, dec = 2) => (Number.isFinite(n) ? nf(dec, dec).format(n) : '-');
const fmtW = (n) => (Number.isFinite(n) ? nf(0, 3).format(n) : '-');
const pctSign = () => (S.settings.digits === 'arab' ? '٪' : '%');
const fmtPct = (x, dec = 1) => (Number.isFinite(x) ? `${nf(dec, dec).format(x * 100)}${pctSign()}` : '-');
const signed = (n, dec) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n), dec)}`;
const num = (s) => `<span class="num">${s}</span>`;
const money = (n, dec = cur().dec) => `<span class="money">${num(fmt(n, dec))} <span class="cur">${cur().sym}</span></span>`;
const grams = (n) => `<span class="money">${num(fmtW(n))} <span class="cur">غ</span></span>`;

function dateFmt(ts, opts = { day: 'numeric', month: 'long' }) {
  const nu = S.settings.digits === 'arab' ? 'arab' : 'latn';
  return new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${nu}`, opts).format(new Date(ts));
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'الآن';
  if (s < 60) return `قبل ${fmt(s, 0)} ثانية`;
  const m = Math.round(s / 60);
  if (m < 60) return `قبل ${fmt(m, 0)} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return `قبل ${fmt(h, 0)} ساعة`;
  return dateFmt(ts, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Verdict wording. Colour carries the same meaning as the words, never alone.
const LEVELS = [
  { label: 'منخفضة', cls: 'good' },
  { label: 'معقولة', cls: 'neutral' },
  { label: 'مرتفعة', cls: 'warn' },
  { label: 'مرتفعة جدًا', cls: 'bad' },
];
const SELL_LEVELS = [
  { label: 'عرض ممتاز', cls: 'good' },
  { label: 'عرض معقول', cls: 'neutral' },
  { label: 'خصم مرتفع', cls: 'warn' },
  { label: 'خصم مرتفع جدًا', cls: 'bad' },
];
const KARAT_FINENESS = { 24: '999', 22: '916', 21: '875', 18: '750' };

/* ======================================================================
   UI kit: native iOS patterns (grouped lists, segmented controls)
   ====================================================================== */

const icon = (name, size = 22, filled = false) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[filled && ICONS[`${name}Fill`] ? `${name}Fill` : name]}</svg>`;

const navBar = (title, trailing = '') => `
  <header class="nav">
    <h1>${title}</h1>
    ${trailing ? `<div class="nav-trailing">${trailing}</div>` : ''}
  </header>`;

// A grouped list section: optional header above, footer below.
const group = (body, { head = '', foot = '', id = '', cls = '' } = {}) => `
  <section class="group ${cls}" ${id ? `id="${id}"` : ''}>
    ${head ? `<h2 class="group-head">${head}</h2>` : ''}
    <div class="list">${body}</div>
    ${foot ? `<p class="group-foot">${foot}</p>` : ''}
  </section>`;

// Label at the start, value at the end.
const row = (label, value = '', { sub = '', cls = '', attrs = '' } = {}) => `
  <div class="row ${cls}" ${attrs}>
    <span class="row-label"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</span>
    ${value !== '' ? `<span class="row-value"><span>${value}</span></span>` : ''}
  </div>`;

// Label above, full-width control below (for segmented controls in a cell).
const stackRow = (label, control, attrs = '') => `
  <div class="row stack" ${attrs}>
    ${label ? `<span class="row-label">${label}</span>` : ''}
    ${control}
  </div>`;

const inputRow = (label, attrs, unit = '', { sub = '', placeholder = '0' } = {}) => `
  <label class="row field">
    <span class="row-label"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</span>
    <span class="row-input"><input inputmode="decimal" autocomplete="off" placeholder="${placeholder}" ${attrs}>${unit ? `<span class="unit">${unit}</span>` : ''}</span>
  </label>`;

const switchRow = (label, attrs, checked) => `
  <label class="row">
    <span class="row-label"><span>${label}</span></span>
    <span class="switch"><input type="checkbox" role="switch" ${attrs} ${checked ? 'checked' : ''}><span class="track"></span></span>
  </label>`;

const actionRow = (label, attrs, { ic = '', cls = '' } = {}) => `
  <button type="button" class="row action ${cls}" ${attrs}>
    ${ic ? icon(ic, 20) : ''}<span>${label}</span>
  </button>`;

const linkRow = (label, value, attrs) => `
  <button type="button" class="row link" ${attrs}>
    <span class="row-label"><span>${label}</span></span>
    <span class="row-value"><span>${value}</span></span>
    ${icon('chevron', 16)}
  </button>`;

const seg = (name, options, value, cls = '') => `
  <div class="segmented ${cls}" role="radiogroup">
    ${options.map(([v, label]) => `<button type="button" role="radio" aria-checked="${String(v) === String(value)}" data-${name}="${v}">${label}</button>`).join('')}
  </div>`;

const karatSeg = (name, value, cls = '') => seg(name, KARATS.map((k) => [k, num(k)]), value, cls);

// Updates a segmented control in place, without re-rendering the page.
function selectSeg(btn) {
  btn.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === btn)));
}

/* ======================================================================
   Prices: fetch, cache, poll
   ====================================================================== */

// Delmon's own page refreshes every 10 s; follow it closely when matching it.
const pollMs = () => (profile() === PROFILES.delmon ? 15000 : 30000);
const FX_TTL = 6 * 3600e3;
let pollTimer = null;
let inflight = null;

async function refresh({ userAsked = false } = {}) {
  if (inflight) return inflight;
  S.loading = true;
  paintStatus();
  inflight = (async () => {
    try {
      const r = await fetchSpot({ dealer: S.settings.priceMode === 'auto' && profile() === PROFILES.delmon ? 'delmon' : null });
      const prev = S.price?.usd;
      S.price = { ...r, fetchedAt: Date.now() };
      S.offline = false;
      save('price', S.price);
      const code = S.settings.currency;
      if (!CURRENCIES[code].peg && (!S.fx[code] || Date.now() - S.fx[code].ts > FX_TTL)) {
        try {
          S.fx[code] = await fetchFx(code, r.daily?.rates);
          save('fx', S.fx);
        } catch { /* keep cached / approximate rate */ }
      }
      onPrice(prev);
      if (userAsked) toast('تم تحديث السعر');
    } catch {
      S.offline = true;
      if (userAsked) toast('تعذّر الاتصال، يُعرض آخر سعر محفوظ');
    } finally {
      S.loading = false;
      inflight = null;
      paintStatus();
    }
  })();
  return inflight;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, pollMs());
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!S.price || Date.now() - (S.price.fetchedAt || 0) > 15000) refresh();
    startPolling();
  } else {
    stopPolling();
  }
});
addEventListener('online', () => refresh());
addEventListener('offline', () => { S.offline = true; paintStatus(); });

function statusInfo() {
  const st = S.settings;
  if (st.priceMode === 'manual' && parseNum(st.manualPrice) > 0) {
    return { cls: '', text: `سعر يدوي لعيار ${num(st.manualKarat)}` };
  }
  const p = S.price;
  if (!p) return { cls: S.loading ? '' : 'bad', text: S.loading ? 'جارٍ جلب السعر' : 'لا يوجد اتصال' };
  if (S.offline) return { cls: 'bad', text: `غير متصل. آخر سعر ${ago(p.fetchedAt || p.ts)}` };
  if (p.status === 'closed') return { cls: '', text: `السوق مغلق. آخر تداول ${dateFmt(p.ts, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}` };
  if (p.status === 'daily') return { cls: 'warn', text: 'سعر مرجعي يومي، المصادر المباشرة لا تستجيب' };
  return { cls: '', text: `محدث ${ago(p.fetchedAt || p.ts)}` };
}

function paintStatus() {
  const info = statusInfo();
  document.querySelectorAll('[data-status]').forEach((el) => {
    el.className = `status ${info.cls}`;
    el.innerHTML = info.text;
  });
  document.querySelectorAll('[data-action="refresh"]').forEach((b) => b.classList.toggle('spin', S.loading));
}
setInterval(paintStatus, 5000);

// Called after every successful fetch.
function onPrice(prevUsd) {
  const dir = prevUsd && S.price ? Math.sign(S.price.usd - prevUsd) : 0;
  if (S.tab === 'prices') {
    paintPricesLive(dir);
    if (S.price?.daily) ensureHistory();
  }
  if (S.tab === 'calc') paintCalcResult();
  if (S.tab === 'vault') paintVault();
  if (S.tab === 'tools') { paintZakat(); paintConv(); }
}

/* ======================================================================
   History (chart)
   ====================================================================== */

const RANGES = [
  { days: 7, step: 1, label: 'أسبوع' },
  { days: 30, step: 1, label: 'شهر' },
  { days: 90, step: 3, label: '3 أشهر' },
  { days: 365, step: 12, label: 'سنة' },
];

const isoDay = (d) => d.toISOString().slice(0, 10);

function rangeDates(days, step) {
  const out = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  for (let i = days; i >= 1; i -= step) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(isoDay(d));
  }
  return out;
}

let histLoading = false;
async function ensureHistory() {
  const r = RANGES.find((x) => x.days === S.range) || RANGES[1];
  const missing = rangeDates(r.days, r.step).filter((d) => !S.hist[d] && !histMiss.has(d));
  if (!missing.length || histLoading) return;
  histLoading = true;
  paintChart();
  for (let i = 0; i < missing.length; i += 6) {
    const batch = missing.slice(i, i + 6);
    const got = await Promise.allSettled(batch.map((d) => fetchDay(d)));
    got.forEach((g, j) => {
      if (g.status === 'fulfilled') {
        const { usd, rates } = g.value;
        S.hist[batch[j]] = { usd, kwd: rates?.kwd, egp: rates?.egp };
      } else histMiss.add(batch[j]);
    });
  }
  // Keep the cache bounded to ~400 days.
  const keys = Object.keys(S.hist).sort();
  if (keys.length > 420) keys.slice(0, keys.length - 420).forEach((k) => delete S.hist[k]);
  save('hist', S.hist);
  histLoading = false;
  paintChart();
}
const histMiss = new Set();

function dayP24(rec) {
  const code = S.settings.currency;
  const c = CURRENCIES[code];
  // That day's exchange rate for floating currencies, if the record has it.
  const fx = c.peg || (rec[code.toLowerCase()] ? rec[code.toLowerCase()] / rec.usd : fxRate());
  return rawP24(rec.usd, fx) * (1 + (S.settings.adjustPct || 0) / 100);
}

function chartPoints(k) {
  const r = RANGES.find((x) => x.days === S.range) || RANGES[1];
  const pts = rangeDates(r.days, r.step)
    .filter((d) => S.hist[d])
    .map((d) => ({ t: Date.parse(`${d}T00:00:00Z`), v: kp(dayP24(S.hist[d]), k) }));
  const live = marketP24();
  if (live) pts.push({ t: S.price.ts || Date.now(), v: kp(live, k), live: true });
  return pts;
}

// Shared by drawing and hit-testing. The end edge is reserved for the
// value labels so they never sit on top of the line.
function chartGeom(pts, w, h) {
  const padT = 12, padB = 24, padL = 2, padR = 44;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo) * 0.1 || hi * 0.01;
  lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  return { padT, padB, padL, padR, lo, hi, t0, t1, x, y };
}

// Stocks-style: the line is green when the range closed higher, red when lower.
function chartSVG(pts, w, h, trend) {
  const { padB, padL, padR, lo, hi, t0, t1, x, y } = chartGeom(pts, w, h);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(t1).toFixed(1)},${h - padB}L${x(t0).toFixed(1)},${h - padB}Z`;
  const ticks = [lo + (hi - lo) * 0.15, lo + (hi - lo) * 0.85];
  const dec = cur().dec > 2 ? 2 : 0;
  const last = pts[pts.length - 1];
  return `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="chart-svg ${trend}" role="img" aria-label="حركة السعر">
      <defs><linearGradient id="gfill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" class="fill-a"/><stop offset="1" class="fill-b"/>
      </linearGradient></defs>
      ${ticks.map((v) => `<line x1="0" x2="${w - padR + 6}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${w}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${fmt(v, dec)}</text>`).join('')}
      <path d="${area}" fill="url(#gfill)"/>
      <path d="${line}" class="line"/>
      <text x="${padL}" y="${h - 6}" class="axis">${dateFmt(t0, { day: 'numeric', month: 'short' })}</text>
      <text x="${w - padR}" y="${h - 6}" class="axis" text-anchor="end">${last.live ? 'الآن' : dateFmt(t1, { day: 'numeric', month: 'short' })}</text>
      <g class="cross" style="display:none"><line y1="0" y2="${h - padB}"/><circle r="4.5"/></g>
    </svg>`;
}

function paintChart() {
  const box = document.getElementById('chart');
  if (!box) return;
  const k = S.heroK || defK();
  const pts = chartPoints(k);
  const head = document.getElementById('chart-head');
  if (pts.length < 2) {
    if (head) head.innerHTML = '';
    box.innerHTML = `<div class="chart-empty">${histLoading ? 'جارٍ تحميل السجل' : 'لا تتوفر بيانات تاريخية حاليًا'}</div>`;
    return;
  }
  const first = pts[0], last = pts[pts.length - 1];
  const d = last.v - first.v;
  const trend = d >= 0 ? 'up' : 'down';
  const rangeLabel = (RANGES.find((r) => r.days === S.range) || RANGES[1]).label;
  const restHead = `<span class="${trend}">${num(signed(d, cur().dec))} (${num(fmtPct(Math.abs(d / first.v), 2))})</span> <span class="muted">خلال ${rangeLabel}</span>`;
  if (head) head.innerHTML = restHead;

  const w = Math.max(260, Math.round(box.clientWidth || 340));
  const h = 180;
  box.innerHTML = chartSVG(pts, w, h, trend);
  const svg = box.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const { x: X, y: Y } = chartGeom(pts, w, h);
  // Scrubbing shows the value in the header line, like the Stocks app.
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * w;
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p.t) - px) < Math.abs(X(best.t) - px)) best = p;
    const cx = X(best.t), cy = Y(best.v);
    cross.style.display = '';
    cross.querySelector('line').setAttribute('x1', cx);
    cross.querySelector('line').setAttribute('x2', cx);
    cross.querySelector('circle').setAttribute('cx', cx);
    cross.querySelector('circle').setAttribute('cy', cy);
    if (head) head.innerHTML = `${money(best.v)} <span class="muted">${best.live ? 'الآن' : dateFmt(best.t, { weekday: 'short', day: 'numeric', month: 'short' })}</span>`;
  };
  const leave = () => { cross.style.display = 'none'; if (head) head.innerHTML = restHead; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointercancel', leave);
}

/* ======================================================================
   Shell: tabs, sheets, toast
   ====================================================================== */

const TABS = [
  { id: 'prices', label: 'الأسعار', icon: 'prices' },
  { id: 'calc', label: 'الحاسبة', icon: 'calc' },
  { id: 'vault', label: 'مجوهراتي', icon: 'vault' },
  { id: 'tools', label: 'أدوات', icon: 'tools' },
];

const view = document.getElementById('view');

function renderTabbar() {
  const nav = document.getElementById('tabbar');
  nav.innerHTML = TABS.map((t) => `
    <a href="#${t.id}" class="tab" data-tab="${t.id}" ${S.tab === t.id ? 'aria-current="page"' : ''}>
      ${icon(t.icon, 26, S.tab === t.id)}<span>${t.label}</span>
    </a>`).join('');
}

function go() {
  const id = (location.hash || '#prices').slice(1);
  S.tab = TABS.some((t) => t.id === id) ? id : 'prices';
  renderTabbar();
  ({ prices: renderPrices, calc: renderCalc, vault: renderVault, tools: renderTools })[S.tab]();
  paintStatus();
  window.scrollTo(0, 0);
}
addEventListener('hashchange', go);

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

// iOS sheet: a nav bar with a leading cancel and an optional trailing action.
let sheetCleanup = null;
function openSheet({ title, done = '', body }, onMount) {
  closeSheet(true);
  const root = document.getElementById('sheet-root');
  root.innerHTML = `<div class="backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-bar">
        <button type="button" class="bar-btn" data-close>${done ? 'إلغاء' : 'إغلاق'}</button>
        <h2>${title}</h2>
        ${done ? `<button type="button" class="bar-btn strong" data-done>${done}</button>` : '<span class="bar-btn"></span>'}
      </div>
      <div class="sheet-body">${body}</div>
    </div>`;
  root.classList.add('open');
  const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
  addEventListener('keydown', onKey);
  root.onclick = (e) => { if (e.target.closest('[data-close]')) closeSheet(); };
  sheetCleanup = () => removeEventListener('keydown', onKey);
  onMount?.(root.querySelector('.sheet'));
}
function closeSheet(immediate = false) {
  const root = document.getElementById('sheet-root');
  sheetCleanup?.();
  sheetCleanup = null;
  if (!root.classList.contains('open')) return;
  root.classList.remove('open');
  if (immediate) root.innerHTML = '';
  else setTimeout(() => { if (!root.classList.contains('open')) root.innerHTML = ''; }, 300);
}

async function shareText(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('تم نسخ النتيجة');
  } catch {
    toast('تعذّرت المشاركة');
  }
}

const statusLine = () => '<p class="status" data-status></p>';

/* ======================================================================
   Prices tab
   ====================================================================== */

function renderPrices() {
  const manual = S.settings.priceMode === 'manual' && parseNum(S.settings.manualPrice) > 0;
  view.innerHTML = `
    ${navBar('عيار', `<button type="button" class="bar-icon" data-action="refresh" aria-label="تحديث">${icon('refresh', 22)}</button>`)}
    ${karatSeg('hk', S.heroK || defK(), 'hero-seg')}
    <section class="quote" id="px-quote" aria-live="polite"></section>
    <section class="chart-block">
      <p class="chart-head" id="chart-head"></p>
      <div class="chart" id="chart" dir="ltr"></div>
      ${seg('range', RANGES.map((r) => [r.days, r.label]), S.range, 'small')}
    </section>
    ${group('<div id="px-list"></div>', { head: 'سعر الغرام لكل عيار' })}
    ${group('<div id="px-units"></div>', { head: 'وحدات أخرى' })}
    ${group('<div id="px-meta"></div>', { head: 'المصدر', foot: manual ? '' : 'لو كان سعر المحل اللي تتعامل معه مختلف، اكتب السعر اللي تشوفه مرة وحدة والتطبيق يتطابق معه ويتابع السوق.' })}`;
  paintPricesLive(0);
  ensureHistory();

  view.onclick = (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.action === 'refresh') refresh({ userAsked: true });
    else if (d.hk) { S.heroK = Number(d.hk); selectSeg(t); paintPricesLive(0); }
    else if (d.range) { S.range = Number(d.range); save('range', S.range); selectSeg(t); paintChart(); ensureHistory(); }
    else if (d.action === 'calibrate') openCalibrate();
    else if (d.action === 'go-settings') { location.hash = '#tools'; setTimeout(() => document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth' }), 60); }
  };
}

function paintPricesLive(dir) {
  const quote = document.getElementById('px-quote');
  if (!quote) return;
  const k = S.heroK || defK();
  const p = p24();
  const c = cur();
  const st = S.settings;
  const manual = st.priceMode === 'manual' && parseNum(st.manualPrice) > 0;
  let change = '';
  const daily = S.price?.daily;
  if (!manual && daily?.usd && S.price?.usd) {
    const now = kp(marketP24(), k);
    const then = kp(marketP24(daily.usd), k);
    const d = now - then;
    const when = daily.date === isoDay(new Date()) ? 'اليوم' : 'منذ أمس';
    change = `<p class="quote-change"><span class="${d >= 0 ? 'up' : 'down'}">${num(signed(d, c.dec))}</span> <span class="pill ${d >= 0 ? 'up' : 'down'}">${num(`${d >= 0 ? '+' : '-'}${fmtPct(Math.abs(d / then), 2)}`)}</span> <span class="muted">${when}</span></p>`;
  }
  const source = manual ? 'سعر يدوي' : `${profile().name}${st.adjustPct ? `، معدّل ${num(`${st.adjustPct > 0 ? '+' : ''}${fmt(st.adjustPct, 2)}${pctSign()}`)}` : ''}`;
  quote.innerHTML = `
    <p class="quote-label">غرام عيار ${num(k)}، ${source}</p>
    <p class="quote-price ${dir > 0 ? 'tick-up' : dir < 0 ? 'tick-down' : ''}">${p ? `${num(fmt(kp(p, k), c.dec))}<span class="cur">${c.sym}</span>` : '<span class="skeleton"></span>'}</p>
    ${change}
    ${statusLine()}`;

  document.getElementById('px-list').innerHTML = KARATS.map((x) => row(
    `عيار ${num(x)}`,
    p ? money(kp(p, x)) : '-',
    { sub: `نقاوة ${num(KARAT_FINENESS[x])}`, cls: x === k ? 'current' : '' },
  )).join('');

  const units = [
    ['أونصة', TROY_OUNCE_G, 24],
    ['تولة', 11.6638, 24],
    ['جنيه ذهب', 7.988, 22],
    ['سبيكة 10 غرام', 10, 24],
    ['كيلو', 1000, 24],
  ];
  document.getElementById('px-units').innerHTML = units.map(([n, g, kk]) => row(
    n, p ? money(kp(p, kk) * g) : '-', { sub: `${num(fmtW(g))} غ عيار ${num(kk)}` },
  )).join('');

  const fx = fxRate();
  const fxKind = c.peg ? 'ربط رسمي ثابت' : S.fx[st.currency] ? `سعر السوق، ${ago(S.fx[st.currency].ts)}` : 'سعر تقريبي';
  const nSrc = S.price?.sources?.length || 0;
  document.getElementById('px-meta').innerHTML = [
    manual
      ? row('السعر اليدوي', money(parseNum(st.manualPrice)), { sub: `لغرام عيار ${num(st.manualKarat)}` })
      : linkRow('طريقة التسعير', profile().name, 'data-action="go-settings"'),
    row('الأونصة عالميًا', S.price ? `<span class="num">$${fmt(S.price.usd, 2)}</span>` : '-', { sub: nSrc ? (nSrc === 2 ? 'من مصدرين متطابقين' : nSrc > 2 ? `من ${fmt(nSrc, 0)} مصادر متطابقة` : 'من مصدر واحد') : '' }),
    st.currency !== 'USD' ? row('سعر الصرف', `${num(`1$ = ${fmt(fx, 4)}`)} ${c.sym}`, { sub: fxKind }) : '',
    manual ? '' : actionRow('مطابقة السعر مع محل', 'data-action="calibrate"', { ic: 'edit' }),
  ].join('');
  paintStatus();
  paintChart();
}

/* ======================================================================
   Calibrate: match a local shop / account price
   ====================================================================== */

// Local dealers quote the market price plus (or minus) their own margin.
// The user types one price they trust; we store the gap as a percentage so
// the app keeps following the live market with that same margin.
function openCalibrate() {
  const c = cur();
  let k = S.heroK || defK();
  const raw24 = () => rawP24();
  if (!raw24()) return toast('انتظر حتى يصل السعر المباشر أولًا');
  const had = S.settings.adjustPct;
  openSheet({
    title: 'مطابقة السعر',
    done: 'تطبيق',
    body: `
      <p class="sheet-intro">اكتب سعر الغرام كما تشوفه الآن في المحل أو الحساب اللي تثق فيه. التطبيق يحسب الفرق عن «${profile().name}» ويطبقه على كل العيارات.</p>
      ${group(`
        ${stackRow('العيار', karatSeg('ck', k))}
        ${inputRow(`سعر غرام عيار <span data-c="k">${num(k)}</span>`, 'data-c="v"', c.sym, { placeholder: fmt(kp(raw24(), k), c.dec) })}
      `)}
      ${group('<div data-c="out"></div>', { foot: '<span data-c="warn"></span>' })}
      ${had ? group(actionRow(`إلغاء التعديل الحالي (${num(`${had > 0 ? '+' : ''}${fmt(had, 2)}${pctSign()}`)})`, 'data-c="reset"', { cls: 'destructive' })) : ''}`,
  }, (sheet) => {
    const input = sheet.querySelector('[data-c="v"]');
    const out = sheet.querySelector('[data-c="out"]');
    const warn = sheet.querySelector('[data-c="warn"]');
    const pct = () => {
      const v = parseNum(input.value);
      return v > 0 ? (v / kp(raw24(), k) - 1) * 100 : NaN;
    };
    const paint = () => {
      const p = pct();
      out.innerHTML = row(`${profile().name} الآن`, money(kp(raw24(), k)))
        + row('الفرق', Number.isFinite(p) ? num(`${p > 0 ? '+' : ''}${fmt(p, 2)}${pctSign()}`) : '-', { cls: Number.isFinite(p) && Math.abs(p) > 5 ? 'bad' : '' });
      warn.textContent = Number.isFinite(p) && Math.abs(p) > 5 ? 'الفرق كبير. تأكد من العيار وإن السعر للغرام الواحد.' : '';
    };
    paint();
    input.focus({ preventScroll: true });
    input.oninput = paint;
    sheet.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.ck) {
        k = Number(b.dataset.ck);
        selectSeg(b);
        sheet.querySelector('[data-c="k"]').innerHTML = num(k);
        input.placeholder = fmt(kp(raw24(), k), c.dec);
        paint();
      } else if (b.dataset.done !== undefined) {
        const p = pct();
        if (!Number.isFinite(p)) return toast('اكتب السعر أولًا');
        if (Math.abs(p) > 20) return toast('الفرق أكبر من 20%، تأكد من السعر');
        setSetting('adjustPct', String(Math.round(p * 10000) / 10000), false);
        closeSheet();
        toast(`تمت المطابقة، الفرق ${p > 0 ? '+' : ''}${fmt(p, 2)}%`);
        rerenderCurrent();
      } else if (b.dataset.c === 'reset') {
        setSetting('adjustPct', '0', false);
        closeSheet();
        toast(`رجعنا لـ«${profile().name}»`);
        rerenderCurrent();
      }
    };
  });
}

function rerenderCurrent() {
  const y = window.scrollY;
  ({ prices: renderPrices, calc: renderCalc, vault: renderVault, tools: renderTools })[S.tab]();
  paintStatus();
  window.scrollTo(0, y);
}

/* ======================================================================
   Calculator tab
   ====================================================================== */

const MODES = [
  ['analyze', 'كم المصنعية؟'],
  ['price', 'كم السعر؟'],
  ['sell', 'بيع ذهب'],
];
const MAKING_MODES = [
  ['perGram', 'للغرام'],
  ['total', 'مبلغ كلي'],
  ['percent', 'نسبة'],
];

const calcK = () => S.calc.items.find((i) => i.k)?.k || defK();
const persistCalc = () => save('calc', S.calc);

function calcP24() {
  const o = parseNum(S.calc.override);
  if (o > 0) return o / (ratios()[calcK()] ?? calcK() / 24);
  return p24();
}

function vatOn() {
  const st = S.settings;
  return st.vatBasis !== 'none' && st.vatRate > 0;
}

function renderCalc() {
  const C = S.calc;
  C.items.forEach((it) => { if (!it.k) it.k = defK(); });
  const c = cur();
  const multi = C.items.length > 1;
  const mLabel = C.makingMode === 'percent' ? 'نسبة المصنعية' : C.makingMode === 'total' ? 'المصنعية الكلية' : 'المصنعية للغرام';
  const mUnit = C.makingMode === 'percent' ? pctSign() : c.sym;
  const P = p24();

  view.innerHTML = `
    ${navBar('الحاسبة', '<button type="button" class="bar-btn" data-action="clear">مسح</button>')}
    ${seg('mode', MODES, C.mode)}
    <p class="lead">${{
      analyze: 'من وزن القطعة والمبلغ المكتوب في الفاتورة، تعرف كم دفعت مصنعية.',
      price: 'من الوزن والمصنعية اللي يطلبها المحل، تعرف السعر النهائي قبل الدفع.',
      sell: 'تعرف قيمة ذهبك بسعر السوق، وكم يخصم المحل من عرضه.',
    }[C.mode]}</p>

    ${C.items.map((it, i) => group(`
      ${inputRow('الوزن', `data-f="w" value="${esc(it.w)}"`, 'غ', { placeholder: '0.00' })}
      ${stackRow('', karatSeg('k', it.k))}
      ${C.mode === 'price' ? inputRow(mLabel, `data-f="m" value="${esc(it.m)}"`, mUnit) : ''}
    `, {
      head: multi ? `<span>القطعة ${num(i + 1)}</span><button type="button" class="head-btn" data-rm="${i}">حذف</button>` : 'القطعة',
      cls: 'item',
      id: `item-${i}`,
    }).replace('class="group item', `data-i="${i}" class="group item`)).join('')}
    ${group(actionRow('إضافة قطعة', 'data-action="add"', { ic: 'plus' }))}

    ${group(`
      ${C.mode === 'analyze' ? inputRow('مبلغ الفاتورة', `data-g="total" value="${esc(C.total)}"`, c.sym, { placeholder: '0.00' }) : ''}
      ${C.mode === 'analyze' && vatOn() ? switchRow(`شامل الضريبة ${num(fmt(S.settings.vatRate * 100, 0) + pctSign())}`, 'data-g="vatIncluded"', C.vatIncluded) : ''}
      ${C.mode === 'price' ? stackRow('المصنعية محسوبة', seg('mm', MAKING_MODES, C.makingMode)) : ''}
      ${C.mode === 'sell' ? inputRow('عرض المحل', `data-g="offer" value="${esc(C.offer)}"`, c.sym, { sub: 'اختياري', placeholder: '0.00' }) : ''}
      ${inputRow(`سعر المحل لعيار <span data-ovk>${num(calcK())}</span>`, `data-g="override" value="${esc(C.override)}"`, c.sym, { sub: 'اختياري', placeholder: P ? fmt(kp(P, calcK()), c.dec) : '0.00' })}
    `, { foot: 'اترك سعر المحل فاضي ليُستخدم السعر الحالي.' })}

    <section class="result" id="result" aria-live="polite"></section>

    <div class="actions">
      <button type="button" class="btn filled" data-action="save">${icon('save', 20)} حفظ</button>
      <button type="button" class="btn tinted" data-action="share">${icon('image', 20)} صورة</button>
      <button type="button" class="btn tinted" data-action="copy">${icon('copy', 20)} نسخ</button>
    </div>`;
  paintCalcResult();

  view.oninput = (e) => {
    const t = e.target;
    const item = t.closest('[data-i]');
    if (item && t.dataset.f) C.items[item.dataset.i][t.dataset.f] = t.value;
    else if (t.dataset.g === 'vatIncluded') C.vatIncluded = t.checked;
    else if (t.dataset.g) C[t.dataset.g] = t.value;
    persistCalc();
    paintCalcResult();
  };
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const item = b.closest('[data-i]');
    if (b.dataset.mode) { C.mode = b.dataset.mode; persistCalc(); renderCalc(); }
    else if (b.dataset.mm) { C.makingMode = b.dataset.mm; persistCalc(); renderCalc(); }
    else if (b.dataset.k && item) {
      C.items[item.dataset.i].k = Number(b.dataset.k);
      persistCalc();
      selectSeg(b);
      view.querySelector('[data-ovk]').innerHTML = num(calcK());
      const P2 = p24();
      if (P2) view.querySelector('[data-g="override"]').placeholder = fmt(kp(P2, calcK()), cur().dec);
      paintCalcResult();
    }
    else if (b.dataset.rm) { C.items.splice(Number(b.dataset.rm), 1); persistCalc(); renderCalc(); }
    else if (b.dataset.action === 'add') {
      C.items.push({ w: '', k: C.items[C.items.length - 1]?.k || defK(), m: '' });
      persistCalc();
      renderCalc();
      const inputs = view.querySelectorAll('[data-f="w"]');
      inputs[inputs.length - 1]?.focus();
    }
    else if (b.dataset.action === 'clear') {
      Object.assign(C, { items: [{ w: '', k: defK(), m: '' }], total: '', offer: '', override: '' });
      persistCalc();
      renderCalc();
    }
    else if (b.dataset.action === 'share' || b.dataset.action === 'copy') {
      const r = calcResult();
      if (!r) return toast('أكمل البيانات أولًا');
      const e = { ...C, result: r, p24: calcP24(), currency: S.settings.currency, vatRate: S.settings.vatRate };
      if (b.dataset.action === 'copy') copyText(describe(e));
      else shareImage(e).catch(() => toast('تعذّر إنشاء الصورة'));
    }
    else if (b.dataset.action === 'save') openSaveSheet();
  };
}

function calcResult() {
  const C = S.calc, st = S.settings;
  const base = { items: C.items, p24: calcP24(), ratios: ratios() };
  if (C.mode === 'analyze') return analyzeInvoice({ ...base, total: C.total, vatRate: st.vatRate, vatIncluded: C.vatIncluded, vatBasis: st.vatBasis });
  if (C.mode === 'price') return pricePieces({ ...base, vatRate: st.vatRate, vatBasis: st.vatBasis, makingMode: C.makingMode });
  return sellGold({ ...base, offer: C.offer });
}

function resultHTML(mode, r, override) {
  const st = S.settings;
  const vatName = `الضريبة ${num(fmt(st.vatRate * 100, 0) + pctSign())}${st.vatBasis === 'making' ? ' على المصنعية' : ''}`;
  const wRow = row('الوزن', grams(r.weight), { sub: `فيه ${num(fmtW(r.pure))} غ ذهب صافي` });
  const goldRow = row('قيمة الذهب', money(r.gold));
  const foot = override ? 'محسوب على سعر المحل اللي كتبته.' : '';
  const headline = (label, value, verdict = '') => `
    <div class="result-head">
      <p class="result-label">${label}</p>
      <p class="result-value">${value}</p>
      ${verdict}
    </div>`;
  const verdictLine = (lv, text) => `<p class="verdict ${lv.cls}">${text}</p>`;

  if (mode === 'analyze') {
    if (r.belowGold) {
      return `${headline('المبلغ أقل من قيمة الذهب', money(r.gold), `<p class="verdict warn">قيمة ${grams(r.weight)} بسعر اليوم أعلى من المبلغ. تأكد من العيار والوزن، أو إن الفاتورة قديمة.</p>`)}
        ${group(wRow + goldRow)}`;
    }
    const lv = LEVELS[r.level];
    return `${headline('دفعت مصنعية للغرام', money(r.makingPerGram), verdictLine(lv, `مصنعية ${lv.label}، ${num(fmtPct(r.makingPct))} من قيمة الذهب`))}
      ${group([
        wRow, goldRow,
        row('المصنعية الكلية', money(r.making)),
        vatOn() ? row(vatName, money(r.vat)) : '',
        row('الإجمالي', money(r.paid), { cls: 'total' }),
      ].join(''), { foot })}`;
  }
  if (mode === 'price') {
    const lv = LEVELS[r.level];
    const pieces = r.rows.length > 1 ? group(r.rows.map((x, i) => row(`القطعة ${num(i + 1)}`, money(x.subtotal), { sub: `${num(fmtW(x.w))} غ عيار ${num(x.k)}` })).join(''), { head: 'القطع' }) : '';
    return `${headline(`السعر النهائي${vatOn() ? ' شامل الضريبة' : ''}`, money(r.total), r.making > 0 ? verdictLine(lv, `مصنعية ${lv.label}، ${num(fmtPct(r.makingPct))} من قيمة الذهب`) : '')}
      ${pieces}
      ${group([
        wRow, goldRow,
        row('المصنعية', money(r.making), { sub: r.weight ? `${num(fmt(r.makingPerGram, cur().dec))} للغرام` : '' }),
        vatOn() ? row(vatName, money(r.vat)) : '',
        row('الإجمالي', money(r.total), { cls: 'total' }),
      ].join(''), { foot })}`;
  }
  if (r.offer == null) {
    return `${headline('قيمة ذهبك بسعر السوق', money(r.gold), '<p class="verdict neutral">اكتب عرض المحل لتعرف كم يخصم.</p>')}
      ${group(wRow + row('متوسط سعر الغرام', money(r.gold / r.weight)), { foot })}`;
  }
  const neg = r.deduction < 0;
  const lv = neg ? SELL_LEVELS[0] : SELL_LEVELS[Math.max(r.level, 0)];
  return `${headline(neg ? 'العرض أعلى من سعر السوق للغرام' : 'المحل يخصم للغرام', money(Math.abs(r.deductionPerGram)), verdictLine(lv, neg ? 'عرض ممتاز' : `${lv.label}، ${num(fmtPct(r.deductionPct))} من قيمة الذهب`))}
    ${group([
      wRow,
      row('قيمة الذهب بسعر السوق', money(r.gold)),
      row('عرض المحل', money(r.offer)),
      row('الفرق', money(Math.abs(r.deduction)), { cls: 'total' }),
    ].join(''), { foot })}`;
}

function paintCalcResult() {
  const box = document.getElementById('result');
  if (!box) return;
  const C = S.calc;
  if (!calcP24()) {
    box.innerHTML = '<p class="empty-hint">لا يتوفر سعر للذهب بعد. تحقق من الاتصال، أو اكتب سعر المحل أعلاه.</p>';
    return;
  }
  const r = calcResult();
  if (!r) {
    box.innerHTML = `<p class="empty-hint">${C.mode === 'analyze' ? 'اكتب الوزن ومبلغ الفاتورة لتظهر المصنعية هنا.' : 'اكتب الوزن لتظهر النتيجة هنا.'}</p>`;
    return;
  }
  box.innerHTML = resultHTML(C.mode, r, parseNum(C.override) > 0);
}

// One summary feeds both the text and the image share.
function summary(e) {
  const c = CURRENCIES[e.currency] || cur();
  const m = (n) => `${fmt(n, c.dec)} ${c.sym}`;
  const r = e.result;
  const items = (e.items || []).filter((it) => parseNum(it.w) > 0);
  const k = items[0]?.k || 21;
  const vatName = `الضريبة ${fmt((e.vatRate ?? S.settings.vatRate) * 100, 0)}%`;
  const out = {
    title: { analyze: 'تحليل فاتورة ذهب', price: 'تسعير قطعة ذهب', sell: 'تقييم بيع ذهب' }[e.mode],
    shop: e.shop || '',
    pieces: items.map((it) => `${fmtW(parseNum(it.w))} غ عيار ${it.k}`),
    hero: null,
    rows: [['قيمة الذهب', m(r.gold)]],
    foot: `سعر غرام عيار ${k} وقتها: ${m(karatPrice(e.p24, k, e.ratios || ratios()))}`,
  };
  if (e.mode === 'analyze' && !r.belowGold) {
    out.hero = ['المصنعية للغرام', m(r.makingPerGram), `مصنعية ${LEVELS[r.level].label}، ${fmtPct(r.makingPct)} من قيمة الذهب`];
    out.rows.push(['المصنعية الكلية', m(r.making)]);
    if (r.vat) out.rows.push([vatName, m(r.vat)]);
    out.rows.push(['الإجمالي', m(r.paid)]);
  } else if (e.mode === 'analyze') {
    out.rows.push(['المبلغ المدفوع', m(parseNum(e.total))]);
  } else if (e.mode === 'price') {
    out.hero = ['السعر النهائي', m(r.total), r.making > 0 ? `مصنعية ${fmt(r.makingPerGram, c.dec)} ${c.sym} للغرام` : ''];
    out.rows.push(['المصنعية', m(r.making)]);
    if (r.vat) out.rows.push([vatName, m(r.vat)]);
  } else if (r.offer != null) {
    out.hero = ['خصم المحل لكل غرام', m(r.deductionPerGram), `${fmtPct(r.deductionPct)} من قيمة الذهب`];
    out.rows.push(['عرض المحل', m(r.offer)]);
  } else {
    out.hero = ['قيمة ذهبك بسعر السوق', m(r.gold), ''];
  }
  return out;
}

function describe(e) {
  const s = summary(e);
  const lines = [`${s.title}${s.shop ? `، ${s.shop}` : ''}`];
  s.pieces.forEach((p) => lines.push(`• ${p}`));
  if (s.hero) lines.push(`${s.hero[0]}: ${s.hero[1]}${s.hero[2] ? ` (${s.hero[2]})` : ''}`);
  s.rows.forEach(([a, b]) => lines.push(`${a}: ${b}`));
  lines.push(s.foot, 'عيار، حاسبة الذهب');
  return lines.join('\n');
}

// The shared image is a plain receipt: white, black type, hairlines.
async function shareImage(e) {
  const s = summary(e);
  const FONT = "-apple-system, 'SF Arabic', system-ui, 'Segoe UI', Tahoma, sans-serif";
  const W = 720, PAD = 56, rowH = 64;
  const H = 250 + (s.hero ? 204 : 0) + s.rows.length * rowH + 120;
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  const x = c.getContext('2d');
  x.scale(2, 2);
  x.direction = 'rtl';
  const text = (t, px, py, color, size, w = 400, align = 'right') => {
    x.font = `${w} ${size}px ${FONT}`; x.fillStyle = color; x.textAlign = align; x.fillText(t, px, py);
  };
  const hair = (py) => { x.fillStyle = '#e5e5ea'; x.fillRect(PAD, py, W - PAD * 2, 1); };

  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  let y = 84;
  text('عيار', W - PAD, y, '#000000', 30, 700);
  text(dateFmt(e.ts || Date.now(), { day: 'numeric', month: 'long', year: 'numeric' }), PAD, y, '#8e8e93', 20, 400, 'left');
  y += 62;
  text(s.title + (s.shop ? `، ${s.shop}` : ''), W - PAD, y, '#000000', 30, 600);
  y += 42;
  text(s.pieces.join('   '), W - PAD, y, '#8e8e93', 21);
  y += 36;
  if (s.hero) {
    hair(y); y += 58;
    text(s.hero[0], W - PAD, y, '#8e8e93', 22);
    y += 70;
    text(s.hero[1], W - PAD, y, '#000000', 58, 700);
    if (s.hero[2]) text(s.hero[2], W - PAD, y + 40, '#3c3c43', 20);
    y += s.hero[2] ? 76 : 40;
  }
  hair(y);
  s.rows.forEach(([a, b], i) => {
    const last = i === s.rows.length - 1;
    text(a, W - PAD, y + 42, last ? '#000000' : '#3c3c43', 23, last ? 600 : 400);
    text(b, PAD, y + 42, '#000000', 24, last ? 700 : 500, 'left');
    y += rowH;
    if (!last) hair(y);
  });
  y += 44;
  text(s.foot, W - PAD, y, '#8e8e93', 18);
  text('الأسعار استرشادية', W - PAD, y + 30, '#aeaeb2', 16);

  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('blob'))), 'image/png'));
  const file = new File([blob], 'iyar-gold.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (err) { if (err?.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('تم حفظ الصورة');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('تم النسخ'); } catch { shareText(text); }
}

function openSaveSheet(existing) {
  const C = S.calc;
  const r = existing ? existing.result : calcResult();
  if (!r) return toast('أكمل البيانات أولًا');
  const mode = existing ? existing.mode : C.mode;
  const ownedDefault = existing ? existing.owned : mode !== 'sell';
  openSheet({
    title: existing ? 'تعديل' : 'حفظ',
    done: 'حفظ',
    body: `${group(`
      <label class="row field text"><span class="row-label"><span>المحل</span></span><span class="row-input"><input data-s="shop" maxlength="60" placeholder="مثال: مجوهرات دلمون" value="${esc(existing?.shop || '')}"></span></label>
      <label class="row field text"><span class="row-label"><span>ملاحظة</span></span><span class="row-input"><input data-s="note" maxlength="120" placeholder="خاتم، سلسلة، طقم" value="${esc(existing?.note || '')}"></span></label>
    `)}
    ${mode !== 'sell' ? group(switchRow('أضفها إلى مجوهراتي', 'data-s="owned"', ownedDefault), { foot: 'القطع اللي تملكها تنحسب في قيمة ذهبك وفي الزكاة.' }) : ''}`,
  }, (sheet) => {
    sheet.querySelector('[data-s="shop"]').focus({ preventScroll: true });
    sheet.querySelector('[data-done]').onclick = () => {
      const shop = sheet.querySelector('[data-s="shop"]').value.trim();
      const note = sheet.querySelector('[data-s="note"]').value.trim();
      const owned = !!sheet.querySelector('[data-s="owned"]')?.checked;
      if (existing) {
        Object.assign(existing, { shop, note, owned });
      } else {
        S.entries.unshift({
          id: uid(), ts: Date.now(), mode, shop, note, owned,
          items: C.items.filter((it) => parseNum(it.w) > 0).map((it) => ({ w: parseNum(it.w), k: it.k, m: it.m })),
          total: C.total, offer: C.offer, vatIncluded: C.vatIncluded, makingMode: C.makingMode,
          vatRate: S.settings.vatRate, vatBasis: S.settings.vatBasis,
          currency: S.settings.currency, p24: calcP24(), ratios: { ...ratios() }, result: r,
        });
      }
      save('entries', S.entries);
      closeSheet();
      toast(existing ? 'تم التعديل' : 'تم الحفظ');
      if (S.tab === 'vault') renderVault();
    };
  });
}

/* ======================================================================
   Vault tab: saved entries + "my jewellery"
   ====================================================================== */

const MODE_NAME = { analyze: 'فاتورة', price: 'تسعير', sell: 'بيع' };

function entryPaid(e) {
  if (e.mode === 'analyze') return e.result?.paid;
  if (e.mode === 'price') return e.result?.total;
  return null;
}

function holdings() {
  const owned = S.entries.filter((e) => e.owned && e.mode !== 'sell');
  const byK = {};
  let weight = 0, pure = 0, paid = 0, paidWeight = 0;
  for (const e of owned) {
    for (const it of e.items) {
      byK[it.k] = (byK[it.k] || 0) + it.w;
      weight += it.w;
      pure += (it.w * it.k) / 24;
    }
    const p = entryPaid(e);
    if (e.currency === S.settings.currency && p > 0) {
      paid += p;
      paidWeight += e.items.reduce((s, it) => s + (it.w * it.k) / 24, 0);
    }
  }
  const valueOf = (P, filter) => owned
    .filter(filter || (() => true))
    .reduce((s, e) => s + e.items.reduce((t, it) => t + it.w * kp(P, it.k), 0), 0);
  return { owned, byK, weight, pure, paid, paidPure: paidWeight, valueOf };
}

function renderVault() {
  view.innerHTML = `
    ${navBar('مجوهراتي')}
    <section id="vault-sum"></section>
    ${S.entries.length ? seg('vf', [['all', 'الكل'], ['owned', 'أملكها'], ['sell', 'بيع']], S.vaultFilter) : ''}
    <section id="vault-list"></section>`;
  paintVault();
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.vf) { S.vaultFilter = b.dataset.vf; selectSeg(b); paintVault(); }
    else if (b.dataset.entry) openEntry(b.dataset.entry);
    else if (b.dataset.action === 'to-calc') location.hash = '#calc';
  };
}

function paintVault() {
  const sum = document.getElementById('vault-sum');
  if (!sum) return;
  const P = p24();
  const h = holdings();
  if (h.owned.length) {
    const value = P ? h.valueOf(P) : null;
    const paidNowValue = P ? h.valueOf(P, (e) => e.currency === S.settings.currency && entryPaid(e) > 0) : null;
    const diff = paidNowValue != null && h.paid ? paidNowValue - h.paid : null;
    const count = h.owned.length;
    sum.innerHTML = `
      <div class="quote">
        <p class="quote-label">قيمة ذهبك الآن</p>
        <p class="quote-price">${value != null ? `${num(fmt(value, cur().dec))}<span class="cur">${cur().sym}</span>` : '-'}</p>
        <p class="quote-change muted">${num(fmtW(h.weight))} غ في ${count === 1 ? 'قطعة واحدة' : count === 2 ? 'قطعتين' : `${num(fmt(count, 0))} ${count < 11 ? 'قطع' : 'قطعة'}`}</p>
      </div>
      ${group(Object.entries(h.byK).sort((a, b) => b[0] - a[0]).map(([k, w]) => row(`عيار ${num(k)}`, grams(w))).join(''), { head: 'حسب العيار' })}
      ${diff != null ? group(
        row('دفعت', money(h.paid))
        + row('قيمتها كذهب اليوم', money(paidNowValue))
        + row('الفرق', `<span class="${diff >= 0 ? 'up' : 'down'}">${num(signed(diff, cur().dec))} <span class="cur">${cur().sym}</span></span>`, { cls: 'total' }),
        { foot: 'المبلغ المدفوع يشمل المصنعية والضريبة، والقيمة اليوم للذهب فقط، يعني تقريبًا اللي تحصله لو بعت.' },
      ) : ''}`;
  } else {
    sum.innerHTML = '';
  }

  const f = S.vaultFilter;
  const list = S.entries.filter((e) => f === 'all' || (f === 'owned' ? e.owned : e.mode === f));
  const box = document.getElementById('vault-list');
  if (!list.length) {
    box.innerHTML = `
      <div class="empty">
        ${icon('vault', 44)}
        <h2>${S.entries.length ? 'لا يوجد شيء هنا' : 'لا توجد حسابات محفوظة'}</h2>
        <p>${S.entries.length ? 'جرّب تصنيف ثاني.' : 'احسب قطعة في الحاسبة واضغط «حفظ»، وتظهر هنا مع قيمتها اليوم.'}</p>
        ${S.entries.length ? '' : '<button type="button" class="btn filled" data-action="to-calc">افتح الحاسبة</button>'}
      </div>`;
    return;
  }
  box.innerHTML = group(list.map((e) => {
    const c = CURRENCIES[e.currency] || cur();
    const r = e.result || {};
    const w = e.items.reduce((s, it) => s + it.w, 0);
    const ks = [...new Set(e.items.map((it) => it.k))].join(' و ');
    let key = NaN, keyLabel = '';
    if (e.mode === 'analyze' && !r.belowGold) { key = r.makingPerGram; keyLabel = 'مصنعية للغرام'; }
    else if (e.mode === 'price') { key = r.total; keyLabel = 'الإجمالي'; }
    else if (e.mode === 'sell') { key = r.offer ?? r.gold; keyLabel = r.offer != null ? 'العرض' : 'القيمة'; }
    return `
      <button type="button" class="row entry" data-entry="${e.id}">
        <span class="row-label"><span>${esc(e.shop || e.note || MODE_NAME[e.mode])}</span><small>${MODE_NAME[e.mode]}، ${num(fmtW(w))} غ عيار ${num(ks)}، ${dateFmt(e.ts, { day: 'numeric', month: 'short' })}</small></span>
        <span class="row-value"><span>${Number.isFinite(key) ? `${num(fmt(key, c.dec))} <span class="cur">${c.sym}</span>` : '-'}</span><small>${keyLabel}</small></span>
        ${icon('chevron', 16)}
      </button>`;
  }).join(''), { head: f === 'owned' ? 'القطع اللي أملكها' : 'المحفوظات' });
}

function openEntry(id) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  const sameCur = e.currency === S.settings.currency;
  const P = p24();
  const nowVal = P ? e.items.reduce((s, it) => s + it.w * kp(P, it.k), 0) : null;
  const prevCur = S.settings.currency;
  // Render the stored result in the currency it was saved in.
  S.settings.currency = e.currency;
  const body = resultHTML(e.mode, e.result, false);
  const then24 = money(e.p24);
  S.settings.currency = prevCur;
  openSheet({
    title: esc(e.shop || MODE_NAME[e.mode]),
    body: `
      <p class="sheet-intro">${MODE_NAME[e.mode]}، ${dateFmt(e.ts, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${e.note ? `<br>${esc(e.note)}` : ''}</p>
      <div class="result in-sheet">${body}</div>
      ${group(row('سعر عيار 24 وقتها', then24) + (nowVal != null && sameCur ? row('قيمة الذهب اليوم', money(nowVal)) : ''))}
      ${group([
        actionRow('افتح في الحاسبة', 'data-a="load"', { ic: 'calc' }),
        actionRow('مشاركة كصورة', 'data-a="share"', { ic: 'image' }),
        actionRow('نسخ كنص', 'data-a="copy"', { ic: 'copy' }),
        actionRow('تعديل الاسم والملاحظة', 'data-a="edit"', { ic: 'edit' }),
      ].join(''))}
      ${group(actionRow('حذف', 'data-a="del"', { ic: 'trash', cls: 'destructive' }))}`,
  }, (sheet) => {
    sheet.onclick = (ev) => {
      const btn = ev.target.closest('[data-a]');
      const a = btn?.dataset.a;
      if (!a) return;
      if (a === 'share') shareImage(e).catch(() => toast('تعذّر إنشاء الصورة'));
      else if (a === 'copy') copyText(describe(e));
      else if (a === 'edit') openSaveSheet(e);
      else if (a === 'load') {
        Object.assign(S.calc, {
          mode: e.mode,
          items: e.items.map((it) => ({ w: String(it.w), k: it.k, m: it.m ?? '' })),
          total: e.total || '', offer: e.offer || '', vatIncluded: e.vatIncluded ?? true,
          makingMode: e.makingMode || 'perGram', override: '',
        });
        persistCalc();
        closeSheet();
        location.hash = '#calc';
        if (S.tab === 'calc') renderCalc();
      } else if (a === 'del') {
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1';
          btn.querySelector('span').textContent = 'اضغط مرة ثانية للتأكيد';
          return;
        }
        S.entries = S.entries.filter((x) => x.id !== e.id);
        save('entries', S.entries);
        closeSheet();
        toast('تم الحذف');
        renderVault();
      }
    };
  });
}

/* ======================================================================
   Tools tab: zakat, karat converter, settings, backup
   ====================================================================== */

function renderTools() {
  const st = S.settings;
  S.zakatItems.forEach((it) => { if (!it.k) it.k = defK(); });
  const currencyOpts = Object.entries(CURRENCIES).map(([code, c]) => `<option value="${code}" ${code === st.currency ? 'selected' : ''}>${c.country}، ${c.name}</option>`).join('');
  const select = (attrs, opts) => `<span class="row-input select"><select ${attrs}>${opts}</select></span>`;
  const auto = st.priceMode !== 'manual';
  view.innerHTML = `
    ${navBar('أدوات')}

    ${group(`
      ${S.zakatItems.map((it, i) => `
        <div class="zk-item" data-zi="${i}">
          ${inputRow(S.zakatItems.length > 1 ? `الوزن ${num(i + 1)}` : 'الوزن', `data-zf="w" value="${esc(it.w)}"`, 'غ', { placeholder: '0.00' })}
          ${stackRow('', `<div class="seg-line">${karatSeg('zk', it.k)}${S.zakatItems.length > 1 ? `<button type="button" class="head-btn" data-zrm="${i}">حذف</button>` : ''}</div>`)}
        </div>`).join('')}
      ${actionRow('إضافة عيار آخر', 'data-action="zadd"', { ic: 'plus' })}
      ${holdings().owned.length ? actionRow('استخدم أوزان مجوهراتي', 'data-action="zfill"', { ic: 'vault' }) : ''}
    `, { head: 'زكاة الذهب' })}
    <div id="zk-res"></div>

    ${group(`
      ${inputRow('الوزن', `data-cv="w" value="${esc(S.conv.w)}"`, 'غ', { placeholder: '0.00' })}
      ${stackRow('من عيار', karatSeg('cf', S.conv.from))}
      ${stackRow('إلى عيار', karatSeg('ct', S.conv.to))}
      <div id="cv-res"></div>
    `, { head: 'تحويل بين العيارات', id: 'conv' })}

    ${group(`
      <label class="row field"><span class="row-label">الدولة</span>${select('data-set="currency"', currencyOpts)}</label>
      ${stackRow('مصدر السعر', seg('pm', [['auto', 'مباشر'], ['manual', 'يدوي']], st.priceMode))}
      ${auto && st.currency === 'BHD' ? stackRow('التسعيرة', seg('pf', ['delmon', 'standard'].map((id) => [id, PROFILES[id].name]), profile() === PROFILES.standard ? 'standard' : st.profile)) : ''}
      ${auto ? inputRow('تعديل إضافي', `data-set="adjustPct" value="${st.adjustPct || ''}"`, pctSign(), { sub: 'اختياري' }) : ''}
      ${auto ? actionRow('مطابقة السعر مع محل', 'data-action="calibrate"', { ic: 'edit' }) : ''}
      ${!auto ? stackRow('السعر المعلن لغرام عيار', karatSeg('mk', st.manualKarat)) : ''}
      ${!auto ? inputRow('السعر', `data-set="manualPrice" value="${esc(st.manualPrice)}"`, cur().sym, { placeholder: '0.00' }) : ''}
    `, { head: 'السعر', id: 'settings', foot: auto ? (st.currency === 'BHD' ? profile().desc : 'السعر العالمي محوّل بسعر الصرف.') : 'بقية العيارات تنحسب تلقائيًا من هذا السعر.' })}

    ${group(`
      ${inputRow('نسبة الضريبة', `data-set="vatRate" value="${Math.round(st.vatRate * 1000) / 10}"`, pctSign())}
      <label class="row field"><span class="row-label">تنطبق على</span>${select('data-set="vatBasis"', `
        <option value="full" ${st.vatBasis === 'full' ? 'selected' : ''}>كامل السعر</option>
        <option value="making" ${st.vatBasis === 'making' ? 'selected' : ''}>المصنعية فقط</option>
        <option value="none" ${st.vatBasis === 'none' ? 'selected' : ''}>بدون ضريبة</option>`)}</label>
    `, { head: 'الضريبة' })}

    ${group(`
      ${stackRow('العيار الافتراضي', karatSeg('dk', st.defaultKarat))}
      ${stackRow('الأرقام', seg('dg', [['latn', '123'], ['arab', '١٢٣']], st.digits))}
      ${stackRow('المظهر', seg('th', [['system', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']], st.theme))}
    `, { head: 'العرض' })}

    ${group(`
      ${actionRow('تصدير نسخة احتياطية', 'data-action="export"', { ic: 'share' })}
      <label class="row action">${icon('save', 20)}<span>استيراد نسخة احتياطية</span><input type="file" accept="application/json,.json" data-action="import" hidden></label>
    `, { head: 'البيانات', foot: 'بياناتك محفوظة على هذا الجهاز فقط.' })}

    <p class="about">عيار، الإصدار ${num(BUILD.replace('-', '.'))}<br>الأسعار استرشادية وقد تختلف قليلًا عن المحلات.</p>`;
  paintZakat();
  paintConv();

  view.oninput = (e) => {
    const t = e.target;
    if (t.dataset.zf) { S.zakatItems[t.closest('[data-zi]').dataset.zi].w = t.value; save('zakat', S.zakatItems); paintZakat(); }
    else if (t.dataset.cv) { S.conv.w = t.value; paintConv(); }
    else if (t.dataset.set && t.tagName === 'INPUT') setSetting(t.dataset.set, t.value, false);
  };
  view.onchange = (e) => {
    const t = e.target;
    if (t.dataset.set && t.tagName === 'SELECT') setSetting(t.dataset.set, t.value, true);
    if (t.dataset.action === 'import') importBackup(t.files?.[0]);
  };
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.zk) {
      const it = b.closest('[data-zi]');
      S.zakatItems[it.dataset.zi].k = Number(d.zk);
      selectSeg(b);
      save('zakat', S.zakatItems); paintZakat();
    } else if (d.zrm) { S.zakatItems.splice(Number(d.zrm), 1); save('zakat', S.zakatItems); renderTools(); }
    else if (d.action === 'zadd') { S.zakatItems.push({ w: '', k: defK() }); save('zakat', S.zakatItems); renderTools(); }
    else if (d.action === 'zfill') {
      S.zakatItems = Object.entries(holdings().byK).map(([k, w]) => ({ w: String(+w.toFixed(3)), k: Number(k) }));
      save('zakat', S.zakatItems); renderTools();
    }
    else if (d.cf || d.ct) {
      if (d.cf) S.conv.from = Number(d.cf); else S.conv.to = Number(d.ct);
      selectSeg(b);
      paintConv();
    }
    else if (d.pf) {
      if (d.pf !== S.settings.profile) {
        S.settings.adjustPct = 0; // a % matched under one formula is wrong under another
        setSetting('profile', d.pf, true);
        refresh();
        startPolling();
        toast(`التسعيرة الآن: ${PROFILES[d.pf].name}`);
      }
    }
    else if (d.dk) setSetting('defaultKarat', Number(d.dk), true);
    else if (d.mk) setSetting('manualKarat', Number(d.mk), true);
    else if (d.pm) setSetting('priceMode', d.pm, true);
    else if (d.dg) setSetting('digits', d.dg, true);
    else if (d.th) setSetting('theme', d.th, true);
    else if (d.action === 'export') exportBackup();
    else if (d.action === 'calibrate') openCalibrate();
  };
}

function setSetting(key, raw, rerender) {
  const st = S.settings;
  if (key === 'vatRate') { const v = parseNum(raw); st.vatRate = Number.isFinite(v) ? Math.min(Math.max(v, 0), 100) / 100 : 0; }
  else if (key === 'adjustPct') { const v = parseNum(raw); st.adjustPct = Number.isFinite(v) ? Math.min(Math.max(v, -20), 20) : 0; }
  else if (key === 'currency') {
    st.currency = raw;
    st.vatRate = CURRENCIES[raw].vat;
    st.vatBasis = CURRENCIES[raw].basis;
    st.manualPrice = '';
  } else st[key] = raw;
  save('settings', st);
  if (key === 'theme') applyTheme();
  if (key === 'digits') nfCache.clear();
  if (key === 'currency') {
    S.calc.override = ''; persistCalc();
    refresh();
  }
  if (key === 'priceMode' && raw === 'auto') refresh();
  if (rerender) {
    const y = window.scrollY;
    renderTools();
    window.scrollTo(0, y);
  }
  paintZakat();
  paintConv();
}

function paintZakat() {
  const box = document.getElementById('zk-res');
  if (!box) return;
  const P = p24();
  const z = zakat({ items: S.zakatItems, p24: P, ratios: ratios() });
  if (!(z.weight > 0)) { box.innerHTML = ''; return; }
  box.innerHTML = z.due
    ? `<div class="result-head compact">
        <p class="result-label">الزكاة الواجبة</p>
        <p class="result-value">${P ? money(z.zakatValue) : '-'}</p>
        <p class="verdict neutral">أو ${num(fmtW(z.zakatPure))} غ ذهب صافي</p>
      </div>
      ${group(row('الذهب الصافي عندك', grams(z.pure)) + row('النصاب', grams(z.nisab), { sub: z.nisabValue ? `قيمته ${money(z.nisabValue)}` : '' }), { foot: 'إذا بلغ ذهبك النصاب وحال عليه الحول فالزكاة ربع العشر. في حُلي الاستعمال خلاف بين العلماء، فاسأل من تثق بعلمه.' })}`
    : group(row('الذهب الصافي عندك', grams(z.pure)) + row('النصاب', grams(z.nisab)) + row('الحالة', `<span class="muted">باقي ${num(fmtW(z.remaining))} غ</span>`), { foot: 'لم يبلغ ذهبك النصاب، فلا زكاة عليه.' });
}

function paintConv() {
  const box = document.getElementById('cv-res');
  if (!box) return;
  const w = parseNum(S.conv.w);
  if (!(w > 0)) { box.innerHTML = ''; return; }
  const out = convertKarat(w, S.conv.from, S.conv.to);
  const P = p24();
  box.innerHTML = row(`يساوي بعيار ${num(S.conv.to)}`, grams(out), { cls: 'total', sub: `فيه ${num(fmtW((w * S.conv.from) / 24))} غ ذهب صافي${P ? `، قيمته ${money(kp(P, S.conv.from) * w)}` : ''}` });
}

function exportBackup() {
  const data = { app: 'iyar', v: 1, at: new Date().toISOString(), settings: S.settings, entries: S.entries };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = `iyar-backup-${isoDay(new Date())}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'iyar' || !Array.isArray(data.entries)) throw new Error('bad');
    const have = new Set(S.entries.map((e) => e.id));
    const added = data.entries.filter((e) => e && e.id && Array.isArray(e.items) && !have.has(e.id));
    S.entries = [...S.entries, ...added].sort((a, b) => b.ts - a.ts);
    save('entries', S.entries);
    toast(`تم استيراد ${fmt(added.length, 0)} عنصر`);
  } catch {
    toast('الملف غير صالح');
  }
}

/* ======================================================================
   Theme & boot
   ====================================================================== */

function applyTheme() {
  const t = S.settings.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
}

let resizeT;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (S.tab === 'prices') paintChart(); }, 150);
});

applyTheme();
go();
refresh();
startPolling();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging from the console.
window.__iyar = { S, refresh };
