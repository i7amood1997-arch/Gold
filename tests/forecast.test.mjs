import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekRange, dailyVariance, tradingCloses, sessionsBetween, MODEL } from '../js/forecast.js';
import { easternToUtc, EVENTS, KINDS } from '../js/events.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// Synthetic archive: every calendar day, price moves only on trading closes
// (snapshots dated Tue..Sat) by a fixed +-1% alternating, so daily sigma ~= 1%.
function synthHist(days = 400) {
  const hist = {};
  let p = 4000, sign = 1;
  const start = Date.UTC(2025, 0, 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 864e5);
    if ([2, 3, 4, 5, 6].includes(d.getUTCDay())) { p *= Math.exp(sign * 0.01); sign = -sign; }
    hist[d.toISOString().slice(0, 10)] = { usd: p };
  }
  return { hist, end: start + (days - 1) * 864e5 };
}

test('trading closes skip the weekend repeats', () => {
  const { hist } = synthHist(14);
  const c = tradingCloses(hist);
  assert.ok(c.every((x) => [2, 3, 4, 5, 6].includes(new Date(x.date + 'T00:00:00Z').getUTCDay())));
});

test('variance estimate recovers a known 1% daily move', () => {
  const { hist } = synthHist();
  near(Math.sqrt(dailyVariance(tradingCloses(hist))), 0.01, 1e-6);
  assert.equal(dailyVariance(tradingCloses(synthHist(60).hist)), null); // not enough history
});

test('sessions counted Mon..Fri only', () => {
  const thu = Date.UTC(2026, 10, 19, 10); // Thursday
  assert.equal(sessionsBetween(thu, thu + 7 * 864e5), 5);
  const sat = Date.UTC(2026, 10, 21, 10);
  assert.equal(sessionsBetween(sat, sat + 2 * 864e5), 1); // only Monday
});

test('7-day band = exp(+-K sigma sqrt(sessions)), widened by events', () => {
  const { hist, end } = synthHist();
  const now = end + 3600e3;
  const r = weekRange({ hist, now });
  const s = 0.01 * Math.sqrt(sessionsBetween(now, now + 7 * 864e5));
  near(r.high, Math.exp(MODEL.k * s), 1e-9);
  near(r.low, Math.exp(-MODEL.k * s), 1e-9);
  assert.equal(r.path.length, 7);
  assert.ok(r.path.every((p, i) => i === 0 || p.high >= r.path[i - 1].high)); // cone never narrows
  const withEv = weekRange({ hist, now, events: [{ at: now + 2 * 864e5 }, { at: now + 30 * 864e5 }] });
  assert.equal(withEv.events, 1); // only the one inside the window counts
  assert.ok(withEv.high > r.high);
});

test('US Eastern times convert with daylight saving', () => {
  // Winter (EST, UTC-5): FOMC 9 Dec 2026 14:00 ET = 19:00 UTC = 22:00 Bahrain
  assert.equal(new Date(easternToUtc('2026-12-09', 14, 0)).toISOString(), '2026-12-09T19:00:00.000Z');
  // Summer (EDT, UTC-4): CPI 10 Jun 2027 08:30 ET = 12:30 UTC
  assert.equal(new Date(easternToUtc('2027-06-10', 8, 30)).toISOString(), '2027-06-10T12:30:00.000Z');
  // Around the switch: 2 Apr 2027 is after DST start (14 Mar 2027)
  assert.equal(new Date(easternToUtc('2027-04-02', 8, 30)).toISOString(), '2027-04-02T12:30:00.000Z');
  // 3 Dec 2027 is after DST end (7 Nov 2027)
  assert.equal(new Date(easternToUtc('2027-12-03', 8, 30)).toISOString(), '2027-12-03T13:30:00.000Z');
});

test('event list is sorted and typed', () => {
  assert.ok(EVENTS.length > 30);
  assert.ok(EVENTS.every((e, i) => i === 0 || e.at >= EVENTS[i - 1].at));
  assert.ok(EVENTS.every((e) => KINDS[e.kind]));
});
