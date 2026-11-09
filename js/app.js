import {
  KARATS, TROY_OUNCE_G, NISAB_GRAMS, parseNum, gramPrice24, karatPrice, analyzeInvoice,
  pricePieces, sellGold, zakat, convertKarat,
} from './calc.js';
import { CURRENCIES, fetchSpot, fetchFx, fetchDay } from './prices.js';
import { load, save, DEFAULT_SETTINGS, uid } from './store.js';

export const BUILD = '2026.11.09-2';

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

const cur = () => CURRENCIES[S.settings.currency] || CURRENCIES.BHD;
const defK = () => S.settings.defaultKarat;

function fxRate() {
  const c = cur();
  if (c.peg) return c.peg;
  return S.fx[S.settings.currency]?.rate || c.approx;
}

// Market 24K gram price (with the user's adjustment) — never the manual one.
function marketP24(usd = S.price?.usd) {
  return gramPrice24(usd, fxRate(), S.settings.adjustPct);
}

function p24() {
  const st = S.settings;
  if (st.priceMode === 'manual') {
    const v = parseNum(st.manualPrice);
    if (v > 0) return (v * 24) / st.manualKarat;
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
const fmt = (n, dec = 2) => (Number.isFinite(n) ? nf(dec, dec).format(n) : '—');
const fmtW = (n) => (Number.isFinite(n) ? nf(0, 3).format(n) : '—');
const fmtPct = (x, dec = 1) => (Number.isFinite(x) ? `${nf(dec, dec).format(x * 100)}${S.settings.digits === 'arab' ? '٪' : '%'}` : '—');
const num = (s) => `<span class="num">${s}</span>`;
const money = (n, cls = '') => `<span class="money ${cls}">${num(fmt(n, cur().dec))}<span class="cur">${cur().sym}</span></span>`;
const grams = (n) => `<span class="money">${num(fmtW(n))}<span class="cur">غ</span></span>`;

function dateFmt(ts, opts = { day: 'numeric', month: 'long' }) {
  const nu = S.settings.digits === 'arab' ? 'arab' : 'latn';
  return new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${nu}`, opts).format(new Date(ts));
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'الآن';
  if (s < 60) return `قبل ${fmt(s, 0)} ث`;
  const m = Math.round(s / 60);
  if (m < 60) return `قبل ${fmt(m, 0)} د`;
  const h = Math.round(m / 60);
  if (h < 24) return `قبل ${fmt(h, 0)} س`;
  return dateFmt(ts, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const LEVELS = [
  { label: 'منخفضة', cls: 'lv0' },
  { label: 'معقولة', cls: 'lv1' },
  { label: 'مرتفعة', cls: 'lv2' },
  { label: 'مرتفعة جدًا', cls: 'lv3' },
];
const SELL_LEVELS = [
  { label: 'عرض ممتاز', cls: 'lv0' },
  { label: 'عرض معقول', cls: 'lv1' },
  { label: 'خصم مرتفع', cls: 'lv2' },
  { label: 'خصم مرتفع جدًا', cls: 'lv3' },
];
const KARAT_FINENESS = { 24: '999', 22: '916', 21: '875', 18: '750' };

/* ======================================================================
   Icons (inline, stroke = currentColor)
   ====================================================================== */

const I = {
  prices: '<path d="M4 17l5-5 4 4 7-8"/><path d="M15 8h5v5"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"/>',
  vault: '<path d="M6 10h12l2 9H4z"/><path d="M8.5 10l1-5h5l1 5"/>',
  tools: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  share: '<path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  save: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  chevron: '<path d="M15 6l-6 6 6 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  gem: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 16 3-16"/>',
};
const icon = (name, size = 22) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;

/* ======================================================================
   Prices: fetch, cache, poll
   ====================================================================== */

const POLL_MS = 30000;
const FX_TTL = 6 * 3600e3;
let pollTimer = null;
let inflight = null;

async function refresh({ userAsked = false } = {}) {
  if (inflight) return inflight;
  S.loading = true;
  paintStatus();
  inflight = (async () => {
    try {
      const r = await fetchSpot();
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
      if (userAsked) toast('تعذّر الاتصال — يُعرض آخر سعر محفوظ');
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
  }, POLL_MS);
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
    return { cls: 'manual', text: `سعر يدوي · عيار ${st.manualKarat}` };
  }
  const p = S.price;
  if (!p) return { cls: S.loading ? 'loading' : 'off', text: S.loading ? 'جارٍ جلب السعر…' : 'لا يوجد اتصال بعد' };
  if (S.offline) return { cls: 'off', text: `غير متصل · آخر سعر ${ago(p.fetchedAt || p.ts)}` };
  if (p.status === 'closed') return { cls: 'closed', text: `السوق مغلق · آخر تداول ${dateFmt(p.ts, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}` };
  if (p.status === 'daily') return { cls: 'closed', text: 'سعر مرجعي يومي · المصادر المباشرة لا تستجيب' };
  const n = p.sources?.length || 1;
  const src = n === 2 ? 'مصدران متطابقان' : n > 2 ? `${fmt(n, 0)} مصادر متطابقة` : 'مصدر واحد';
  return { cls: 'live', text: `مباشر · ${ago(p.fetchedAt || p.ts)} · ${src}` };
}

function paintStatus() {
  const info = statusInfo();
  document.querySelectorAll('[data-status]').forEach((el) => {
    el.className = `status ${info.cls}`;
    el.querySelector('.status-text').textContent = info.text;
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
  document.querySelectorAll('[data-live-chip]').forEach((el) => { el.innerHTML = chipHTML(); });
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
  let ozLocal;
  if (c.peg) ozLocal = rec.usd * c.peg;
  else ozLocal = rec[code.toLowerCase()] || rec.usd * fxRate();
  return (ozLocal / TROY_OUNCE_G) * (1 + (S.settings.adjustPct || 0) / 100);
}

function chartPoints(k) {
  const r = RANGES.find((x) => x.days === S.range) || RANGES[1];
  const pts = rangeDates(r.days, r.step)
    .filter((d) => S.hist[d])
    .map((d) => ({ t: Date.parse(`${d}T00:00:00Z`), v: karatPrice(dayP24(S.hist[d]), k) }));
  const live = marketP24();
  if (live) pts.push({ t: S.price.ts || Date.now(), v: karatPrice(live, k), live: true });
  return pts;
}

// Shared by drawing and hit-testing. The right edge is reserved for the
// value labels so they never sit on top of the line.
function chartGeom(pts, w, h) {
  const padT = 16, padB = 22, padL = 4, padR = 46;
  const vs = pts.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo) * 0.12 || hi * 0.01;
  lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  return { padT, padB, padL, padR, lo, hi, t0, t1, x, y };
}

function chartSVG(pts, w, h) {
  const { padT, padB, padL: padX, padR, lo, hi, t0, t1, x, y } = chartGeom(pts, w, h);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(t1).toFixed(1)},${h - padB}L${x(t0).toFixed(1)},${h - padB}Z`;
  const last = pts[pts.length - 1];
  const ticks = [lo + (hi - lo) * 0.2, lo + (hi - lo) * 0.8];
  const dec = cur().dec > 2 ? 2 : 0;
  return `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="chart-svg" role="img" aria-label="منحنى السعر">
      <defs><linearGradient id="gfill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="var(--gold)" stop-opacity=".22"/><stop offset="1" stop-color="var(--gold)" stop-opacity="0"/>
      </linearGradient></defs>
      ${ticks.map((v) => `<line x1="0" x2="${w - padR + 4}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${w - 2}" y="${y(v) + 4}" class="axis" text-anchor="end">${fmt(v, dec)}</text>`).join('')}
      <path d="${area}" fill="url(#gfill)"/>
      <path d="${line}" class="line"/>
      <circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" class="end"/>
      <text x="${padX}" y="${h - 6}" class="axis">${dateFmt(t0, { day: 'numeric', month: 'short' })}</text>
      <text x="${w - padR}" y="${h - 6}" class="axis" text-anchor="end">${last.live ? 'الآن' : dateFmt(t1, { day: 'numeric', month: 'short' })}</text>
      <g class="cross" style="display:none"><line y1="${padT - 6}" y2="${h - padB}"/><circle r="5"/></g>
    </svg>`;
}

function paintChart() {
  const box = document.getElementById('chart');
  if (!box) return;
  const k = S.heroK || defK();
  const pts = chartPoints(k);
  const head = document.getElementById('chart-head');
  if (head) {
    const first = pts[0], last = pts[pts.length - 1];
    if (pts.length > 1) {
      const d = last.v - first.v;
      const cls = d >= 0 ? 'up' : 'down';
      head.innerHTML = `<span class="delta ${cls}">${d >= 0 ? '▲' : '▼'} ${num(fmt(Math.abs(d), cur().dec))} <span class="muted">(${num(fmtPct(Math.abs(d / first.v), 2))})</span></span>`;
    } else head.innerHTML = '';
  }
  if (pts.length < 2) {
    box.innerHTML = `<div class="chart-empty">${histLoading ? '<span class="shimmer"></span>جارٍ تحميل السجل…' : 'لا تتوفر بيانات تاريخية حاليًا'}</div>`;
    return;
  }
  const w = Math.max(260, Math.round(box.clientWidth || 320));
  const h = 168;
  box.innerHTML = `${chartSVG(pts, w, h)}<div class="tip" hidden></div>`;
  const svg = box.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const tip = box.querySelector('.tip');
  const { x: X, y: Y } = chartGeom(pts, w, h);
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
    tip.hidden = false;
    tip.innerHTML = `<b>${money(best.v)}</b><span>${best.live ? 'الآن' : dateFmt(best.t, { weekday: 'short', day: 'numeric', month: 'short' })}</span>`;
    const tw = tip.offsetWidth;
    const left = Math.min(Math.max((cx / w) * rect.width - tw / 2, 0), rect.width - tw);
    tip.style.left = `${left}px`;
  };
  const leave = () => { cross.style.display = 'none'; tip.hidden = true; };
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
      ${icon(t.icon, 24)}<span>${t.label}</span>
    </a>`).join('');
}

function go() {
  const id = (location.hash || '#prices').slice(1);
  S.tab = TABS.some((t) => t.id === id) ? id : 'prices';
  renderTabbar();
  view.classList.remove('enter');
  void view.offsetWidth;
  view.classList.add('enter');
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

let sheetCleanup = null;
function openSheet(html, onMount) {
  closeSheet(true);
  const root = document.getElementById('sheet-root');
  root.innerHTML = `<div class="backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="grabber"></div>
      <button class="icon-btn sheet-x" data-close aria-label="إغلاق">${icon('x', 20)}</button>
      ${html}
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
  else setTimeout(() => { if (!root.classList.contains('open')) root.innerHTML = ''; }, 260);
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

const header = (title, extra = '') => `
  <header class="top">
    <div class="top-row">
      <h1>${title}</h1>
      ${extra}
    </div>
  </header>`;

const statusLine = () => `<div class="status" data-status><i class="dot"></i><span class="status-text"></span></div>`;

function chipHTML() {
  const p = p24();
  const k = calcK();
  return p ? `<span class="muted">عيار ${num(k)}</span> ${money(karatPrice(p, k))}` : '<span class="muted">لا يوجد سعر</span>';
}

const karatSeg = (name, value, extra = '') => `
  <div class="karats" role="radiogroup" aria-label="العيار" ${extra}>
    ${KARATS.map((k) => `<button type="button" role="radio" aria-checked="${k === value}" data-${name}="${k}">${num(k)}</button>`).join('')}
  </div>`;

const seg = (name, options, value) => `
  <div class="seg" role="tablist">
    ${options.map(([v, label]) => `<button type="button" role="tab" aria-selected="${String(v) === String(value)}" data-${name}="${v}">${label}</button>`).join('')}
  </div>`;

/* ======================================================================
   Prices tab
   ====================================================================== */

function renderPrices() {
  const k = S.heroK || defK();
  view.innerHTML = `
    ${header('<span class="brand"><span class="brand-mark">◆</span> عيار</span>', `<button class="icon-btn" data-action="refresh" aria-label="تحديث">${icon('refresh', 20)}</button>`)}
    <section class="hero" id="px-hero"></section>
    <section class="card">
      <div class="card-head"><h2>كل العيارات</h2><span class="muted small">للغرام الواحد</span></div>
      <div class="karat-list" id="px-list"></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>حركة السعر · عيار ${num(k)}</h2><div id="chart-head"></div></div>
      ${seg('range', RANGES.map((r) => [r.days, r.label]), S.range)}
      <div class="chart" id="chart" dir="ltr"></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>وحدات أخرى</h2></div>
      <div class="units" id="px-units"></div>
    </section>
    <section class="card subtle" id="px-meta"></section>`;
  paintPricesLive(0);
  ensureHistory();

  view.onclick = (e) => {
    const t = e.target.closest('button, [data-k]');
    if (!t) return;
    if (t.dataset.action === 'refresh') refresh({ userAsked: true });
    else if (t.dataset.hk) { S.heroK = Number(t.dataset.hk); renderPrices(); }
    else if (t.dataset.range) { S.range = Number(t.dataset.range); save('range', S.range); renderPrices(); }
    else if (t.dataset.action === 'go-settings') { location.hash = '#tools'; setTimeout(() => document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth' }), 60); }
  };
}

function paintPricesLive(dir) {
  const hero = document.getElementById('px-hero');
  if (!hero) return;
  const k = S.heroK || defK();
  const p = p24();
  const c = cur();
  let change = '';
  const daily = S.price?.daily;
  const manual = S.settings.priceMode === 'manual' && parseNum(S.settings.manualPrice) > 0;
  if (!manual && daily?.usd && S.price?.usd) {
    const now = karatPrice(marketP24(), k);
    const then = karatPrice(marketP24(daily.usd), k);
    const d = now - then;
    const cls = d >= 0 ? 'up' : 'down';
    const when = daily.date === isoDay(new Date()) ? 'اليوم' : 'منذ أمس';
    change = `<div class="hero-change ${cls}">${d >= 0 ? '▲' : '▼'} ${num(fmt(Math.abs(d), c.dec))} <span>(${num(fmtPct(Math.abs(d / then), 2))})</span> <span class="when">${when}</span></div>`;
  }
  hero.innerHTML = `
    <div class="hero-eyebrow">سعر غرام الذهب عيار ${num(k)} · ${c.country}</div>
    <div class="hero-price ${dir > 0 ? 'tick-up' : dir < 0 ? 'tick-down' : ''}">
      ${p ? `${num(fmt(karatPrice(p, k), c.dec))}<span class="cur">${c.sym}</span>` : '<span class="shimmer wide"></span>'}
    </div>
    ${change}
    <div class="hero-karats">
      ${KARATS.map((x) => `<button type="button" data-hk="${x}" aria-pressed="${x === k}">${num(x)}</button>`).join('')}
    </div>
    ${statusLine()}`;

  const list = document.getElementById('px-list');
  list.innerHTML = KARATS.map((x) => `
    <button type="button" class="karat-row ${x === k ? 'on' : ''}" data-hk="${x}">
      <span class="kbadge">${num(x)}</span>
      <span class="kname">عيار ${num(x)} <span class="muted small">${num(KARAT_FINENESS[x])}</span></span>
      <span class="kprice">${p ? money(karatPrice(p, x)) : '—'}</span>
    </button>`).join('');

  const units = [
    ['أونصة', TROY_OUNCE_G, 24],
    ['تولة', 11.6638, 24],
    ['جنيه ذهب', 7.988, 22],
    ['سبيكة 10 غ', 10, 24],
    ['كيلو', 1000, 24],
  ];
  document.getElementById('px-units').innerHTML = units.map(([n, g, kk]) => `
    <div class="unit-row"><span>${n} <span class="muted small">${num(fmtW(g))} غ · ${num(kk)}</span></span><b>${p ? money(karatPrice(p, kk) * g) : '—'}</b></div>`).join('');

  const st = S.settings;
  const fx = fxRate();
  const fxKind = c.peg ? 'سعر ربط رسمي ثابت' : S.fx[st.currency] ? `سعر السوق · ${ago(S.fx[st.currency].ts)}` : 'سعر تقريبي';
  document.getElementById('px-meta').innerHTML = `
    <div class="meta-row"><span>الأونصة عالميًا</span><b dir="ltr">${S.price ? `$${num(fmt(S.price.usd, 2))}` : '—'}</b></div>
    ${st.currency !== 'USD' ? `<div class="meta-row"><span>سعر الصرف</span><b>${num(`1$ = ${fmt(fx, 4)}`)} ${c.sym} <span class="muted small">· ${fxKind}</span></b></div>` : ''}
    ${S.price?.sources?.length ? `<div class="meta-row"><span>المصادر</span><b class="small">${S.price.sources.map(esc).join(' · ')}</b></div>` : ''}
    ${st.adjustPct ? `<div class="meta-row"><span>تعديل السعر</span><b>${num(`${st.adjustPct > 0 ? '+' : ''}${fmt(st.adjustPct, 2)}٪`)}</b></div>` : ''}
    ${manual ? `<p class="note">تستخدم سعرًا يدويًا: ${money(parseNum(st.manualPrice))} لغرام عيار ${num(st.manualKarat)}.</p>` : ''}
    <button class="link" data-action="go-settings">تغيير العملة أو مصدر السعر ←</button>`;
  paintStatus();
  paintChart();
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
  ['perGram', 'لكل غرام'],
  ['total', 'مبلغ كلي'],
  ['percent', 'نسبة ٪'],
];

const calcK = () => S.calc.items.find((i) => i.k)?.k || defK();
const persistCalc = () => save('calc', S.calc);

function calcP24() {
  const o = parseNum(S.calc.override);
  if (o > 0) return (o * 24) / calcK();
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
  const vatLabel = `${fmt(S.settings.vatRate * 100, 0)}٪`;
  const mLabel = C.makingMode === 'percent' ? 'المصنعية ٪' : C.makingMode === 'total' ? 'المصنعية الكلية' : 'المصنعية / غ';
  const mUnit = C.makingMode === 'percent' ? '٪' : c.sym;

  view.innerHTML = `
    ${header('الحاسبة', `<div class="chip" data-live-chip>${chipHTML()}</div>`)}
    ${seg('mode', MODES, C.mode)}
    <p class="lead">${{
      analyze: 'أدخل وزن القطعة والمبلغ المكتوب في الفاتورة، وتعرف كم دفعت مصنعية.',
      price: 'أدخل الوزن والمصنعية التي يطلبها المحل، وتعرف السعر النهائي قبل الدفع.',
      sell: 'تعرف قيمة ذهبك بسعر السوق، وكم يخصم المحل من عرضه.',
    }[C.mode]}</p>

    <section class="card">
      <div id="items">
        ${C.items.map((it, i) => `
          <div class="item" data-i="${i}">
            <div class="item-head">
              <span class="item-n">${C.items.length > 1 ? `القطعة ${num(i + 1)}` : 'القطعة'}</span>
              ${C.items.length > 1 ? `<button class="icon-btn sm" data-rm="${i}" aria-label="حذف القطعة">${icon('x', 16)}</button>` : ''}
            </div>
            <div class="row2">
              <label class="field">
                <span class="label">الوزن</span>
                <span class="input"><input inputmode="decimal" autocomplete="off" placeholder="0.00" data-f="w" value="${esc(it.w)}"><span class="unit">غ</span></span>
              </label>
              ${C.mode === 'price' ? `
              <label class="field">
                <span class="label">${mLabel}</span>
                <span class="input"><input inputmode="decimal" autocomplete="off" placeholder="0" data-f="m" value="${esc(it.m)}"><span class="unit">${mUnit}</span></span>
              </label>` : ''}
            </div>
            ${karatSeg('k', it.k)}
          </div>`).join('')}
      </div>
      <div class="btn-row spread">
        <button class="add" data-action="add">${icon('plus', 18)} إضافة قطعة أخرى</button>
        <button class="add muted" data-action="clear">مسح الكل</button>
      </div>
    </section>

    <section class="card">
      ${C.mode === 'analyze' ? `
        <label class="field">
          <span class="label">المبلغ الإجمالي في الفاتورة</span>
          <span class="input big"><input inputmode="decimal" autocomplete="off" placeholder="0.00" data-g="total" value="${esc(C.total)}"><span class="unit">${c.sym}</span></span>
        </label>
        ${vatOn() ? `<label class="switch"><input type="checkbox" data-g="vatIncluded" ${C.vatIncluded ? 'checked' : ''}><span class="track"></span><span>المبلغ شامل ضريبة ${vatLabel}</span></label>` : ''}
      ` : ''}
      ${C.mode === 'price' ? `
        <span class="label">طريقة حساب المصنعية</span>
        ${seg('mm', MAKING_MODES, C.makingMode)}
      ` : ''}
      ${C.mode === 'sell' ? `
        <label class="field">
          <span class="label">المبلغ الذي عرضه المحل <span class="muted">(اختياري)</span></span>
          <span class="input big"><input inputmode="decimal" autocomplete="off" placeholder="0.00" data-g="offer" value="${esc(C.offer)}"><span class="unit">${c.sym}</span></span>
        </label>
      ` : ''}
      <details class="override" ${C.override ? 'open' : ''}>
        <summary>المحل يستخدم سعر ذهب مختلف؟</summary>
        <label class="field">
          <span class="label">سعر غرام عيار ${num(calcK())} عند المحل</span>
          <span class="input"><input inputmode="decimal" autocomplete="off" placeholder="${p24() ? fmt(karatPrice(p24(), calcK()), c.dec) : ''}" data-g="override" value="${esc(C.override)}"><span class="unit">${c.sym}</span></span>
        </label>
      </details>
    </section>

    <section class="result" id="result" aria-live="polite"></section>

    <div class="actions">
      <button class="btn primary" data-action="save">${icon('save', 18)} حفظ</button>
      <button class="btn" data-action="share">${icon('share', 18)} صورة</button>
      <button class="btn" data-action="copy">${icon('copy', 18)} نسخ</button>
    </div>`;
  paintCalcResult();

  view.oninput = (e) => {
    const t = e.target;
    const row = t.closest('.item');
    if (row && t.dataset.f) C.items[row.dataset.i][t.dataset.f] = t.value;
    else if (t.dataset.g === 'vatIncluded') C.vatIncluded = t.checked;
    else if (t.dataset.g) C[t.dataset.g] = t.value;
    persistCalc();
    paintCalcResult();
  };
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const row = b.closest('.item');
    if (b.dataset.mode) { C.mode = b.dataset.mode; persistCalc(); renderCalc(); }
    else if (b.dataset.mm) { C.makingMode = b.dataset.mm; persistCalc(); renderCalc(); }
    else if (b.dataset.k && row) {
      C.items[row.dataset.i].k = Number(b.dataset.k);
      persistCalc();
      row.querySelectorAll('[data-k]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      const ov = view.querySelector('.override .label');
      if (ov) ov.innerHTML = `سعر غرام عيار ${num(calcK())} عند المحل`;
      view.querySelector('[data-live-chip]').innerHTML = chipHTML();
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
  const base = { items: C.items, p24: calcP24() };
  if (C.mode === 'analyze') return analyzeInvoice({ ...base, total: C.total, vatRate: st.vatRate, vatIncluded: C.vatIncluded, vatBasis: st.vatBasis });
  if (C.mode === 'price') return pricePieces({ ...base, vatRate: st.vatRate, vatBasis: st.vatBasis, makingMode: C.makingMode });
  return sellGold({ ...base, offer: C.offer });
}

function gauge(pct, max = 0.25) {
  const pos = Math.min(Math.max(pct / max, 0), 1) * 100;
  return `<div class="gauge" aria-hidden="true"><span class="g0"></span><span class="g1"></span><span class="g2"></span><span class="g3"></span><i style="inset-inline-start:${pos}%"></i></div>`;
}

function resultHTML(mode, r, P, override) {
  const c = cur(), st = S.settings;
  const k = r.rows?.[0]?.k;
  const rows = (pairs) => `<dl class="rows">${pairs.filter(Boolean).map(([a, b, cls = '']) => `<div class="${cls}"><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl>`;
  const goldLine = ['قيمة الذهب', money(r.gold)];
  const wLine = ['الوزن', `${grams(r.weight)} <span class="muted small">· صافي ${num(fmtW(r.pure))} غ عيار 24</span>`];
  const vatName = `الضريبة ${fmt(st.vatRate * 100, 0)}٪${st.vatBasis === 'making' ? ' (على المصنعية)' : ''}`;
  const src = override ? '<p class="note">محسوب على سعر المحل الذي أدخلته.</p>' : '';

  if (mode === 'analyze') {
    if (r.belowGold) {
      return `<div class="res-hero warn"><div class="res-label">المبلغ أقل من قيمة الذهب</div>
        <p>المبلغ المدخل أقل من قيمة ${grams(r.weight)} بسعر اليوم (${money(r.gold)}). تأكد من العيار والوزن، أو أن الفاتورة قديمة.</p></div>${rows([wLine, goldLine])}`;
    }
    const lv = LEVELS[r.level];
    return `
      <div class="res-hero">
        <div class="res-label">دفعت مصنعية لكل غرام</div>
        <div class="res-big">${money(r.makingPerGram)}</div>
        <div class="pill ${lv.cls}">${lv.label} · ${num(fmtPct(r.makingPct))} من قيمة الذهب</div>
        ${gauge(r.makingPct)}
      </div>
      ${rows([
        wLine, goldLine,
        ['المصنعية الكلية', money(r.making), 'em'],
        vatOn() && [vatName, money(r.vat)],
        ['الإجمالي', money(r.paid), 'total'],
      ])}${src}`;
  }
  if (mode === 'price') {
    const multi = r.rows.length > 1;
    return `
      <div class="res-hero">
        <div class="res-label">السعر النهائي${vatOn() ? ' شامل الضريبة' : ''}</div>
        <div class="res-big">${money(r.total)}</div>
        ${r.making > 0 ? `<div class="pill ${LEVELS[r.level].cls}">مصنعية ${LEVELS[r.level].label} · ${num(fmtPct(r.makingPct))}</div>${gauge(r.makingPct)}` : ''}
      </div>
      ${multi ? `<div class="pieces">${r.rows.map((x, i) => `<div><span>القطعة ${num(i + 1)} · ${num(fmtW(x.w))} غ · عيار ${num(x.k)}</span><b>${money(x.subtotal)}</b></div>`).join('')}</div>` : ''}
      ${rows([
        wLine, goldLine,
        ['المصنعية', `${money(r.making)}${r.weight ? ` <span class="muted small">(${num(fmt(r.makingPerGram, c.dec))}/غ)</span>` : ''}`, 'em'],
        vatOn() && [vatName, money(r.vat)],
        ['الإجمالي', money(r.total), 'total'],
      ])}${src}`;
  }
  // sell
  if (r.offer == null) {
    return `
      <div class="res-hero">
        <div class="res-label">قيمة ذهبك بسعر السوق الآن</div>
        <div class="res-big">${money(r.gold)}</div>
        <div class="muted small">أدخل عرض المحل لتعرف كم يخصم</div>
      </div>
      ${rows([wLine, ['متوسط سعر الغرام', money(r.gold / r.weight)]])}${src}`;
  }
  const lv = SELL_LEVELS[Math.max(r.level, 0)];
  const neg = r.deduction < 0;
  return `
    <div class="res-hero">
      <div class="res-label">${neg ? 'العرض أعلى من سعر السوق' : 'المحل يخصم لكل غرام'}</div>
      <div class="res-big">${money(Math.abs(r.deductionPerGram))}</div>
      ${neg ? '<div class="pill lv0">عرض ممتاز</div>' : `<div class="pill ${lv.cls}">${lv.label} · ${num(fmtPct(r.deductionPct))}</div>`}
    </div>
    ${rows([
      wLine, ['قيمة الذهب بسعر السوق', money(r.gold)],
      ['عرض المحل', money(r.offer)],
      ['الفرق', money(Math.abs(r.deduction)), 'em'],
    ])}${src}`;
}

function paintCalcResult() {
  const box = document.getElementById('result');
  if (!box) return;
  const C = S.calc;
  const P = calcP24();
  if (!P) {
    box.innerHTML = `<div class="empty">لا يتوفر سعر للذهب بعد. تحقق من الاتصال أو أدخل سعرًا يدويًا من «أدوات».</div>`;
    return;
  }
  const r = calcResult();
  if (!r) {
    box.innerHTML = `<div class="empty">${C.mode === 'analyze' ? 'أدخل الوزن والمبلغ لتظهر المصنعية هنا' : 'أدخل الوزن لتظهر النتيجة هنا'}</div>`;
    return;
  }
  box.innerHTML = resultHTML(C.mode, r, P, parseNum(C.override) > 0);
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
    pieces: items.map((it) => `${fmtW(parseNum(it.w))} غ · عيار ${it.k}`),
    hero: null,
    rows: [['قيمة الذهب', m(r.gold)]],
    foot: `سعر غرام عيار ${k}: ${m(karatPrice(e.p24, k))} · ${dateFmt(e.ts || Date.now(), { day: 'numeric', month: 'long', year: 'numeric' })}`,
  };
  if (e.mode === 'analyze' && !r.belowGold) {
    out.hero = ['المصنعية لكل غرام', m(r.makingPerGram), `${LEVELS[r.level].label} · ${fmtPct(r.makingPct)} من قيمة الذهب`];
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
  const lines = [`${s.title}${s.shop ? ` — ${s.shop}` : ''}`];
  s.pieces.forEach((p) => lines.push(`• ${p}`));
  if (s.hero) lines.push(`${s.hero[0]}: ${s.hero[1]}${s.hero[2] ? ` (${s.hero[2]})` : ''}`);
  s.rows.forEach(([a, b]) => lines.push(`${a}: ${b}`));
  lines.push(s.foot, '— عيار · حاسبة الذهب');
  return lines.join('\n');
}

// Draws the result as a "display case" card, 2x for crisp text on phones.
async function shareImage(e) {
  const s = summary(e);
  const FONT = "'IBM Plex Sans Arabic', sans-serif";
  try {
    await Promise.all(['400', '600'].map((w) => document.fonts.load(`${w} 20px ${FONT}`, 'عيار 0123')));
  } catch { /* fall back to system font */ }
  const W = 720, PAD = 48, rowH = 58;
  const H = 230 + (s.hero ? 170 : 0) + s.rows.length * rowH + 110;
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  const x = c.getContext('2d');
  x.scale(2, 2);
  x.direction = 'rtl';
  const font = (size, w = 400) => { x.font = `${w} ${size}px ${FONT}`; };
  const text = (t, px, py, color, size, w = 400, align = 'right') => { font(size, w); x.fillStyle = color; x.textAlign = align; x.fillText(t, px, py); };
  const rr = (px, py, w, h, r) => { x.beginPath(); x.roundRect(px, py, w, h, r); };

  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2b2720'); g.addColorStop(1, '#16140f');
  x.beginPath(); x.rect(0, 0, W, H); x.fillStyle = g; x.fill(); // square: chat apps paint transparent corners black
  const glow = x.createRadialGradient(W, 0, 0, W, 0, W * 0.9);
  glow.addColorStop(0, 'rgba(226,181,82,0.22)'); glow.addColorStop(1, 'rgba(226,181,82,0)');
  x.fillStyle = glow; x.fill();

  let y = 78;
  text('◆ عيار', W - PAD, y, '#e2b552', 26, 600);
  text(dateFmt(e.ts || Date.now(), { day: 'numeric', month: 'long', year: 'numeric' }), PAD, y, '#b8af9d', 18, 400, 'left');
  y += 56;
  text(s.title + (s.shop ? ` · ${s.shop}` : ''), W - PAD, y, '#f5efe2', 30, 600);
  y += 40;
  text(s.pieces.join('  ·  '), W - PAD, y, '#b8af9d', 20);
  y += 34;

  if (s.hero) {
    rr(PAD, y, W - PAD * 2, 140, 24); x.fillStyle = 'rgba(255,255,255,0.06)'; x.fill();
    text(s.hero[0], W / 2, y + 40, '#b8af9d', 20, 400, 'center');
    text(s.hero[1], W / 2, y + 96, '#e2b552', 50, 600, 'center');
    if (s.hero[2]) text(s.hero[2], W / 2, y + 128, '#b8af9d', 17, 400, 'center');
    y += 170;
  }
  s.rows.forEach(([a, b], i) => {
    const last = i === s.rows.length - 1;
    text(a, W - PAD, y + 34, last ? '#f5efe2' : '#b8af9d', 21, last ? 600 : 400);
    text(b, PAD, y + 34, '#f5efe2', 23, 600, 'left');
    if (!last) { x.fillStyle = 'rgba(255,255,255,0.08)'; x.fillRect(PAD, y + rowH - 1, W - PAD * 2, 1); }
    y += rowH;
  });
  y += 40;
  text(s.foot, W / 2, y, '#8f8778', 16, 400, 'center');
  text('الأسعار استرشادية', W / 2, y + 28, '#6f6a5f', 14, 400, 'center');

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
  openSheet(`
    <h2 class="sheet-title">${existing ? 'تعديل' : 'حفظ في السجل'}</h2>
    <label class="field"><span class="label">اسم المحل</span><span class="input"><input data-s="shop" maxlength="60" placeholder="مثال: مجوهرات دلمون" value="${esc(existing?.shop || '')}"></span></label>
    <label class="field"><span class="label">ملاحظة</span><span class="input"><input data-s="note" maxlength="120" placeholder="خاتم، سلسلة، طقم…" value="${esc(existing?.note || '')}"></span></label>
    ${mode !== 'sell' ? `<label class="switch"><input type="checkbox" data-s="owned" ${ownedDefault ? 'checked' : ''}><span class="track"></span><span>اشتريتها — أضفها إلى مجوهراتي</span></label>` : ''}
    <button class="btn primary block" data-action="confirm-save">${icon('check', 18)} ${existing ? 'حفظ التعديل' : 'حفظ'}</button>`,
  (sheet) => {
    sheet.querySelector('[data-s="shop"]').focus({ preventScroll: true });
    sheet.querySelector('[data-action="confirm-save"]').onclick = () => {
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
          currency: S.settings.currency, p24: calcP24(), result: r,
        });
      }
      save('entries', S.entries);
      closeSheet();
      toast(existing ? 'تم التعديل' : 'تم الحفظ في السجل');
      if (S.tab === 'vault') renderVault();
    };
  });
}

/* ======================================================================
   Vault tab — saved entries + "my jewellery"
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
  return { owned, byK, weight, pure, paid, paidPure: paidWeight };
}

function renderVault() {
  view.innerHTML = `
    ${header('مجوهراتي')}
    <section id="vault-sum"></section>
    ${seg('vf', [['all', 'الكل'], ['owned', 'أملكها'], ['analyze', 'فواتير'], ['price', 'تسعير'], ['sell', 'بيع']], S.vaultFilter)}
    <section id="vault-list" class="list"></section>`;
  paintVault();
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.vf) { S.vaultFilter = b.dataset.vf; renderVault(); }
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
    const value = P ? h.pure * P : null;
    const paidNowValue = P ? h.paidPure * P : null;
    const diff = paidNowValue != null && h.paid ? paidNowValue - h.paid : null;
    sum.innerHTML = `
      <div class="hero vault-hero">
        <div class="hero-eyebrow">قيمة ذهبك الآن (سعر الذهب فقط)</div>
        <div class="hero-price">${value != null ? `${num(fmt(value, cur().dec))}<span class="cur">${cur().sym}</span>` : '—'}</div>
        <div class="hero-sub">${num(fmtW(h.weight))} غ · ${num(fmt(h.owned.length, 0))} ${h.owned.length > 2 && h.owned.length < 11 ? 'قطع' : 'قطعة'} · صافي ${num(fmtW(h.pure))} غ عيار 24</div>
        <div class="karat-tags">${Object.entries(h.byK).sort((a, b) => b[0] - a[0]).map(([k, w]) => `<span>عيار ${num(k)}: ${num(fmtW(w))} غ</span>`).join('')}</div>
        ${diff != null ? `
        <div class="vault-cmp">
          <div><span>دفعت</span><b>${money(h.paid)}</b></div>
          <div><span>${diff >= 0 ? 'ربح الذهب' : 'الفرق'}</span><b class="${diff >= 0 ? 'up' : 'down'}"><span class="money">${num(`${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff), cur().dec)}`)}<span class="cur">${cur().sym}</span></span></b></div>
        </div>
        <p class="hero-foot">ما دفعته يشمل المصنعية والضريبة، أما القيمة الحالية فهي للذهب فقط — أي ما قد تحصل عليه تقريبًا عند البيع.</p>` : ''}
      </div>`;
  } else {
    sum.innerHTML = '';
  }

  const f = S.vaultFilter;
  const list = S.entries.filter((e) => f === 'all' || (f === 'owned' ? e.owned : e.mode === f));
  const box = document.getElementById('vault-list');
  if (!list.length) {
    box.innerHTML = `
      <div class="empty big">
        ${icon('gem', 36)}
        <p>${S.entries.length ? 'لا توجد عناصر في هذا التصنيف' : 'لم تحفظ أي حساب بعد. احسب مصنعية قطعة ثم اضغط «حفظ» لتظهر هنا، وتتابع قيمة ذهبك مع تغيّر السعر.'}</p>
        ${S.entries.length ? '' : '<button class="btn primary" data-action="to-calc">افتح الحاسبة</button>'}
      </div>`;
    return;
  }
  box.innerHTML = list.map((e) => {
    const c = CURRENCIES[e.currency] || cur();
    const r = e.result || {};
    const w = e.items.reduce((s, it) => s + it.w, 0);
    const ks = [...new Set(e.items.map((it) => it.k))].join('/');
    let key = '', keyLabel = '';
    if (e.mode === 'analyze' && !r.belowGold) { key = r.makingPerGram; keyLabel = 'مصنعية/غ'; }
    else if (e.mode === 'price') { key = r.total; keyLabel = 'الإجمالي'; }
    else if (e.mode === 'sell') { key = r.offer ?? r.gold; keyLabel = r.offer != null ? 'العرض' : 'القيمة'; }
    return `
      <button class="entry" data-entry="${e.id}">
        <span class="entry-icon m-${e.mode}">${MODE_NAME[e.mode]}</span>
        <span class="entry-main">
          <b>${esc(e.shop || e.note || MODE_NAME[e.mode])}${e.owned ? ' <span class="own">أملكها</span>' : ''}</b>
          <span class="muted small">${num(fmtW(w))} غ · عيار ${num(ks)} · ${dateFmt(e.ts, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        </span>
        <span class="entry-val">
          <b>${Number.isFinite(key) ? `${num(fmt(key, c.dec))} <span class="cur">${c.sym}</span>` : '—'}</b>
          <span class="muted small">${keyLabel}</span>
        </span>
      </button>`;
  }).join('');
}

function openEntry(id) {
  const e = S.entries.find((x) => x.id === id);
  if (!e) return;
  const sameCur = e.currency === S.settings.currency;
  const P = p24();
  const pure = e.items.reduce((s, it) => s + (it.w * it.k) / 24, 0);
  const nowVal = P ? pure * P : null;
  const prevCur = S.settings.currency;
  // Render the stored result in the currency it was saved in.
  S.settings.currency = e.currency;
  const body = resultHTML(e.mode, e.result, e.p24, false);
  S.settings.currency = prevCur;
  openSheet(`
    <h2 class="sheet-title">${esc(e.shop || MODE_NAME[e.mode])}</h2>
    <p class="muted small">${MODE_NAME[e.mode]} · ${dateFmt(e.ts, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${e.note ? ` · ${esc(e.note)}` : ''}</p>
    <div class="result in-sheet">${body}</div>
    <div class="meta-row"><span>سعر عيار 24 وقتها</span><b>${num(fmt(e.p24, (CURRENCIES[e.currency] || cur()).dec))} ${(CURRENCIES[e.currency] || cur()).sym}</b></div>
    ${nowVal != null && sameCur ? `<div class="meta-row"><span>قيمة الذهب اليوم</span><b>${money(nowVal)}</b></div>` : ''}
    <div class="sheet-actions">
      <button class="btn" data-a="load">${icon('calc', 18)} افتح في الحاسبة</button>
      <button class="btn" data-a="share">${icon('share', 18)} صورة</button>
      <button class="btn" data-a="copy">${icon('copy', 18)} نسخ</button>
      <button class="btn" data-a="edit">${icon('edit', 18)} تعديل</button>
      <button class="btn danger" data-a="del">${icon('trash', 18)} حذف</button>
    </div>`,
  (sheet) => {
    sheet.onclick = (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a;
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
        const btn = ev.target.closest('[data-a]');
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1';
          btn.innerHTML = `${icon('trash', 18)} تأكيد الحذف`;
          return;
        }
        S.entries = S.entries.filter((x) => x.id !== e.id);
        save('entries', S.entries);
        closeSheet();
        toast('تم الحذف');
        paintVault();
      }
    };
  });
}

/* ======================================================================
   Tools tab — zakat, karat converter, settings, backup
   ====================================================================== */

function renderTools() {
  const st = S.settings;
  S.zakatItems.forEach((it) => { if (!it.k) it.k = defK(); });
  const currencyOpts = Object.entries(CURRENCIES).map(([code, c]) => `<option value="${code}" ${code === st.currency ? 'selected' : ''}>${c.country} — ${c.name} (${c.sym})</option>`).join('');
  view.innerHTML = `
    ${header('أدوات')}

    <section class="card">
      <div class="card-head"><h2>زكاة الذهب</h2><span class="muted small">النصاب ${num(NISAB_GRAMS)} غ عيار 24</span></div>
      <div id="zk-items">
        ${S.zakatItems.map((it, i) => `
          <div class="item compact" data-zi="${i}">
            <label class="field">
              <span class="input"><input inputmode="decimal" autocomplete="off" placeholder="الوزن" aria-label="الوزن" data-zf="w" value="${esc(it.w)}"><span class="unit">غ</span></span>
            </label>
            ${karatSeg('zk', it.k)}
            ${S.zakatItems.length > 1 ? `<button class="icon-btn sm" data-zrm="${i}" aria-label="حذف">${icon('x', 16)}</button>` : ''}
          </div>`).join('')}
      </div>
      <div class="btn-row">
        <button class="add" data-action="zadd">${icon('plus', 18)} عيار آخر</button>
        ${holdings().owned.length ? `<button class="add" data-action="zfill">${icon('vault', 18)} من مجوهراتي</button>` : ''}
      </div>
      <div id="zk-res"></div>
      <p class="note">إذا بلغ ذهبك النصاب وحال عليه الحول، فالزكاة ربع العشر (2.5٪). في حُلي الاستعمال خلاف بين العلماء، فاستشر من تثق بعلمه.</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>محوّل العيارات</h2></div>
      <label class="field"><span class="label">الوزن</span><span class="input"><input inputmode="decimal" autocomplete="off" placeholder="0.00" data-cv="w" value="${esc(S.conv.w)}"><span class="unit">غ</span></span></label>
      <div class="conv-grid">
        <div><span class="label">من عيار</span>${karatSeg('cf', S.conv.from)}</div>
        <div><span class="label">إلى عيار</span>${karatSeg('ct', S.conv.to)}</div>
      </div>
      <div id="cv-res"></div>
    </section>

    <section class="card" id="settings">
      <div class="card-head"><h2>الإعدادات</h2></div>

      <label class="field"><span class="label">الدولة والعملة</span>
        <span class="input select"><select data-set="currency">${currencyOpts}</select></span></label>

      <div class="row2">
        <label class="field"><span class="label">نسبة الضريبة</span>
          <span class="input"><input inputmode="decimal" data-set="vatRate" value="${Math.round(st.vatRate * 1000) / 10}"><span class="unit">٪</span></span></label>
        <label class="field"><span class="label">تُطبّق على</span>
          <span class="input select"><select data-set="vatBasis">
            <option value="full" ${st.vatBasis === 'full' ? 'selected' : ''}>كامل السعر</option>
            <option value="making" ${st.vatBasis === 'making' ? 'selected' : ''}>المصنعية فقط</option>
            <option value="none" ${st.vatBasis === 'none' ? 'selected' : ''}>لا توجد ضريبة</option>
          </select></span></label>
      </div>

      <span class="label">العيار الافتراضي</span>
      ${karatSeg('dk', st.defaultKarat)}

      <span class="label">مصدر السعر</span>
      ${seg('pm', [['auto', 'تلقائي مباشر'], ['manual', 'يدوي']], st.priceMode)}
      ${st.priceMode === 'manual' ? `
        <div class="manual-box">
          <span class="label">السعر المعلن عند المحل لغرام عيار</span>
          ${karatSeg('mk', st.manualKarat)}
          <span class="input"><input inputmode="decimal" data-set="manualPrice" placeholder="0.00" value="${esc(st.manualPrice)}"><span class="unit">${cur().sym}</span></span>
          <p class="note">بقية العيارات تُحسب تلقائيًا من هذا السعر.</p>
        </div>` : `
        <label class="field"><span class="label">تعديل على السعر العالمي <span class="muted">(اختياري)</span></span>
          <span class="input"><input inputmode="decimal" data-set="adjustPct" placeholder="0" value="${st.adjustPct || ''}"><span class="unit">٪</span></span></label>
        <p class="note">لو كانت أسعار السوق المحلي أعلى أو أقل قليلًا من السعر العالمي، اكتب الفرق كنسبة (مثل 0.5 أو ‎-0.3).</p>`}

      <span class="label">الأرقام</span>
      ${seg('dg', [['latn', '123'], ['arab', '١٢٣']], st.digits)}

      <span class="label">المظهر</span>
      ${seg('th', [['system', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']], st.theme)}
    </section>

    <section class="card">
      <div class="card-head"><h2>النسخ الاحتياطي</h2></div>
      <p class="note">بياناتك محفوظة على هذا الجهاز فقط. صدّر نسخة واحفظها في الملفات لتنقلها لجهاز آخر.</p>
      <div class="btn-row">
        <button class="btn" data-action="export">تصدير</button>
        <label class="btn">استيراد<input type="file" accept="application/json,.json" data-action="import" hidden></label>
      </div>
    </section>

    <section class="card subtle about">
      <p><b>عيار</b> · حاسبة الذهب والمصنعية</p>
      <p class="muted small">الأسعار من عدة مصادر عالمية (Gold API وAwesomeAPI ومرجع يومي) ويؤخذ الوسيط بينها لاستبعاد أي سعر شاذ. الأسعار استرشادية وقد تختلف قليلًا عن أسعار المحلات.</p>
      <p class="muted small">الإصدار ${num(BUILD)}</p>
    </section>`;
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
      const row = b.closest('[data-zi]');
      S.zakatItems[row.dataset.zi].k = Number(d.zk);
      row.querySelectorAll('[data-zk]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      save('zakat', S.zakatItems); paintZakat();
    } else if (d.zrm) { S.zakatItems.splice(Number(d.zrm), 1); save('zakat', S.zakatItems); renderTools(); }
    else if (d.action === 'zadd') { S.zakatItems.push({ w: '', k: defK() }); save('zakat', S.zakatItems); renderTools(); }
    else if (d.action === 'zfill') {
      S.zakatItems = Object.entries(holdings().byK).map(([k, w]) => ({ w: String(+w.toFixed(3)), k: Number(k) }));
      save('zakat', S.zakatItems); renderTools();
    }
    else if (d.cf || d.ct) {
      if (d.cf) S.conv.from = Number(d.cf); else S.conv.to = Number(d.ct);
      b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      paintConv();
    }
    else if (d.dk) setSetting('defaultKarat', Number(d.dk), true);
    else if (d.mk) setSetting('manualKarat', Number(d.mk), true);
    else if (d.pm) setSetting('priceMode', d.pm, true);
    else if (d.dg) setSetting('digits', d.dg, true);
    else if (d.th) setSetting('theme', d.th, true);
    else if (d.action === 'export') exportBackup();
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
  const z = zakat({ items: S.zakatItems, p24: P });
  if (!(z.weight > 0)) { box.innerHTML = ''; return; }
  const prog = Math.min(z.pure / z.nisab, 1) * 100;
  box.innerHTML = `
    <div class="zk">
      <div class="zk-bar"><i style="width:${prog}%"></i></div>
      <div class="zk-meta"><span>صافي ذهبك ${num(fmtW(z.pure))} غ</span><span>النصاب ${num(z.nisab)} غ${z.nisabValue ? ` ≈ ${money(z.nisabValue)}` : ''}</span></div>
      ${z.due ? `
        <div class="res-hero compact">
          <div class="res-label">الزكاة الواجبة</div>
          <div class="res-big">${P ? money(z.zakatValue) : '—'}</div>
          <div class="muted small">أو ${num(fmtW(z.zakatPure))} غ ذهب صافٍ (عيار 24)</div>
        </div>` : `
        <div class="pill lv1">لم يبلغ النصاب · باقي ${num(fmtW(z.remaining))} غ صافٍ</div>`}
    </div>`;
}

function paintConv() {
  const box = document.getElementById('cv-res');
  if (!box) return;
  const w = parseNum(S.conv.w);
  if (!(w > 0)) { box.innerHTML = ''; return; }
  const out = convertKarat(w, S.conv.from, S.conv.to);
  const P = p24();
  box.innerHTML = `
    <div class="conv-out">
      <div>${grams(w)} <span class="muted">عيار ${num(S.conv.from)}</span></div>
      <span class="eq">=</span>
      <div><b>${grams(out)}</b> <span class="muted">عيار ${num(S.conv.to)}</span></div>
    </div>
    <p class="note">تحتوي على ${num(fmtW((w * S.conv.from) / 24))} غ ذهب صافٍ${P ? ` · قيمتها ${money(karatPrice(P, S.conv.from) * w)}` : ''}.</p>`;
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
  document.querySelector('meta[name="theme-color"]:not([media])')?.setAttribute('content', dark ? '#12110e' : '#f6f3ec');
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
