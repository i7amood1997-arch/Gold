// عيار: ودجت سعر الذهب لتطبيق Scriptable
// Lock screen (rectangular, inline, circular) and home screen (small, medium).
// Widget parameter: the karat to show, e.g. 21 (default), 22, 24 or 18.
// Prices use Delmon Bars' formula and ounce feed, same as the web app.

const APP_URL = 'https://i7amood1997-arch.github.io/Gold/';
const KARAT = [24, 22, 21, 18].includes(Number(args.widgetParameter)) ? Number(args.widgetParameter) : 21;
const RATIO = { 24: 1, 22: 0.916, 21: 116.64 / 132.2, 18: 0.75 };
const p24 = (usd) => (usd * 1.417) / 116.64;          // Delmon: BHD per gram, 24K
const gram = (usd) => p24(usd) * RATIO[KARAT];

const fm = FileManager.local();
const CACHE = fm.joinPath(fm.documentsDirectory(), 'iyar-widget.json');

async function getJSON(url) {
  const r = new Request(url);
  r.timeoutInterval = 10;
  return r.loadJSON();
}

// Ounce price in USD: Delmon's feed first, Gold API as a fallback.
async function spot() {
  try {
    const d = await getJSON(`https://delmonbars.com/prices-proxy.php?t=${Date.now()}`);
    if (d.gold > 200) return { usd: d.gold, src: 'دلمون' };
  } catch (e) {}
  const g = await getJSON('https://api.gold-api.com/price/XAU');
  if (g.price > 200) return { usd: g.price, src: 'عالمي' };
  throw new Error('no price');
}

// Start-of-day reference (same daily reference the app uses for "today").
async function dayRef() {
  try {
    const d = await getJSON('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.min.json');
    return d?.xau?.usd > 200 ? d.xau.usd : null;
  } catch (e) { return null; }
}

async function load() {
  try {
    const [s, ref] = await Promise.all([spot(), dayRef()]);
    const data = { usd: s.usd, ref, src: s.src, at: Date.now() };
    fm.writeString(CACHE, JSON.stringify(data));
    return { ...data, stale: false };
  } catch (e) {
    if (fm.fileExists(CACHE)) return { ...JSON.parse(fm.readString(CACHE)), stale: true };
    return null;
  }
}

const fmt = (n, d = 3) => n.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const time = (ts) => { const f = new DateFormatter(); f.dateFormat = 'HH:mm'; return f.string(new Date(ts)); };

function build(data) {
  const w = new ListWidget();
  w.url = APP_URL;
  // A request, not a schedule: iOS decides when widgets actually refresh
  // (budget, how often the screen is viewed, Low Power Mode). 5 min is the
  // shortest interval iOS will consider.
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  const family = config.widgetFamily || 'accessoryRectangular';

  if (!data) {
    const t = w.addText(family === 'accessoryCircular' ? '-' : 'لا يوجد اتصال');
    t.font = Font.systemFont(12);
    return w;
  }

  const price = gram(data.usd);
  const pct = data.ref ? (data.usd - data.ref) / data.ref * 100 : null;
  const delta = data.ref ? price - gram(data.ref) : null;
  const arrow = pct == null ? '' : pct >= 0 ? '▲' : '▼';
  const chg = pct == null ? '' : `${arrow} ${Math.abs(pct).toFixed(2)}%`;

  if (family === 'accessoryInline') {
    w.addText(`ذهب ${KARAT}: ${fmt(price)} ${chg}`);
    return w;
  }

  if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const k = w.addText(`${KARAT}`);
    k.font = Font.mediumSystemFont(10); k.centerAlignText();
    const p = w.addText(fmt(price, 2));
    p.font = Font.boldSystemFont(14); p.minimumScaleFactor = 0.6; p.centerAlignText();
    if (pct != null) { const c = w.addText(arrow); c.font = Font.systemFont(9); c.centerAlignText(); }
    return w;
  }

  if (family === 'accessoryRectangular') {
    // Three lines sized to the ~72pt-tall slot: label, price, change + time.
    const head = w.addText(`عيار ${KARAT}${data.stale ? '، قديم' : ''}`);
    head.font = Font.semiboldSystemFont(12); head.textOpacity = 0.8;
    w.addSpacer(1);
    const row = w.addStack();
    row.layoutHorizontally();
    row.bottomAlignContent();
    const p = row.addText(fmt(price));
    p.font = Font.boldSystemFont(26); p.minimumScaleFactor = 0.7; p.lineLimit = 1;
    row.addSpacer(4);
    const c = row.addText('د.ب');
    c.font = Font.semiboldSystemFont(13); c.textOpacity = 0.8;
    w.addSpacer(1);
    const foot = w.addText(`${chg}  ${time(data.at)}`.trim());
    foot.font = Font.mediumSystemFont(12); foot.textOpacity = 0.8;
    return w;
  }

  // Home screen (small / medium / large): white on Apple-style yellow.
  const g = new LinearGradient();
  g.colors = [new Color('#FFD84D'), new Color('#F7B500')];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 14, 14, 14);
  const ink = new Color('#3D2A00');
  const head = w.addText(`عيار ${KARAT}`);
  head.font = Font.semiboldSystemFont(14); head.textColor = ink;
  w.addSpacer();
  const p = w.addText(fmt(price));
  p.font = Font.boldSystemFont(30); p.textColor = Color.white(); p.minimumScaleFactor = 0.6;
  const cur = w.addText('دينار للغرام');
  cur.font = Font.mediumSystemFont(12); cur.textColor = ink;
  w.addSpacer(6);
  if (delta != null) {
    const c = w.addText(`${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}  ${chg}`);
    c.font = Font.semiboldSystemFont(12); c.textColor = ink;
  }
  const t = w.addText(`${time(data.at)}${data.stale ? '، غير متصل' : ''}`);
  t.font = Font.systemFont(11); t.textColor = ink; t.textOpacity = 0.7;
  return w;
}

const widget = build(await load());
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall();
Script.complete();
