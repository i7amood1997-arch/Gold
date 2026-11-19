// 7-day price range: how far gold usually moves in a week, not where it
// will go. No drift, no prediction of direction.
//
// Model (backtested on daily closes 2024-03 .. 2026-11, 802 forecasts):
//  - daily variance from trading-day log returns: EWMA (lambda 0.94) blended
//    30% with the 120-day average, so a short calm spell can't shrink it;
//  - horizon variance = daily variance x (trading sessions in the next 7
//    days + 0.4 x scheduled market-moving events in that window). Fed rate
//    decisions and US jobs reports carried ~30-45% extra variance;
//  - band = price x exp(+-K x sigma), K = 1.75 so ~90% of past weeks ended
//    inside it (90.3% overall, 91.3% / 89.3% in each half).

export const MODEL = { lambda: 0.94, blend: 0.3, longDays: 120, eventBump: 0.4, k: 1.75, coverage: 0.903, tested: 802 };

const DAY = 864e5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

// The archive snapshot dated D is taken around 00:00 UTC, so it holds the
// close of the trading session on D-1. Sessions run Mon..Fri, so trading
// closes are the snapshots dated Tue..Sat.
const isCloseSnapshot = (dateStr) => [2, 3, 4, 5, 6].includes(new Date(`${dateStr}T00:00:00Z`).getUTCDay());

// hist: { 'YYYY-MM-DD': { usd } } -> sorted trading-day closes
export function tradingCloses(hist) {
  return Object.keys(hist)
    .filter((d) => hist[d]?.usd > 0 && isCloseSnapshot(d))
    .sort()
    .map((d) => ({ date: d, usd: hist[d].usd }));
}

// Daily variance forecast (log returns) from trading closes.
export function dailyVariance(closes, m = MODEL) {
  if (closes.length < m.longDays + 31) return null;
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i].usd / closes[i - 1].usd));
  let v = r.slice(0, 30).reduce((s, x) => s + x * x, 0) / 30;
  for (let i = 30; i < r.length; i++) v = m.lambda * v + (1 - m.lambda) * r[i] * r[i];
  const tail = r.slice(-m.longDays);
  const long = tail.reduce((s, x) => s + x * x, 0) / tail.length;
  return (1 - m.blend) * v + m.blend * long;
}

// Trading sessions (Mon..Fri) that close after `from` and on or before `to`.
export function sessionsBetween(from, to) {
  let n = 0;
  for (let t = Math.floor(from / DAY) * DAY + DAY; t <= to; t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd >= 1 && wd <= 5) n++;
  }
  return n;
}

// Range for each of the next `days` days, as multipliers on today's price.
// events: [{ at: ms }] scheduled releases; each one inside the window widens it.
export function weekRange({ hist, now = Date.now(), events = [], days = 7, m = MODEL }) {
  const v = dailyVariance(tradingCloses(hist), m);
  if (!v) return null;
  const path = [];
  for (let d = 1; d <= days; d++) {
    const end = now + d * DAY;
    const sessions = sessionsBetween(now, end);
    const ev = events.filter((e) => e.at > now && e.at <= end).length;
    const sigma = Math.sqrt(v * (sessions + m.eventBump * ev));
    path.push({ date: iso(end), at: end, low: Math.exp(-m.k * sigma), high: Math.exp(m.k * sigma), sessions, events: ev });
  }
  const last = path[path.length - 1];
  return { low: last.low, high: last.high, path, dailySigma: Math.sqrt(v), events: last.events };
}

// Calendar days of history the model needs: 120 sessions + 31 warm-up
// = 151 trading closes, about 212 calendar days; 240 leaves room for gaps.
export const HISTORY_DAYS = 240;
