// Scheduled US releases that move gold the most. Times are US Eastern.
// Sources: Federal Reserve FOMC calendar (federalreserve.gov/monetarypolicy/
// fomccalendars.htm) and the BLS release schedules for the Consumer Price
// Index and the Employment Situation. Dates can move (e.g. a government
// shutdown); update this list when the agencies publish 2028.

const FOMC = ['2026-12-09', '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27'];
const CPI = ['2026-12-10', '2027-01-13', '2027-02-11', '2027-03-10', '2027-04-13', '2027-05-12', '2027-06-10',
  '2027-07-14', '2027-08-11', '2027-09-14', '2027-10-14', '2027-11-10', '2027-12-10'];
const NFP = ['2026-12-04', '2027-01-08', '2027-02-05', '2027-03-05', '2027-04-02', '2027-05-07', '2027-06-04',
  '2027-07-02', '2027-08-06', '2027-09-03', '2027-10-08', '2027-11-05', '2027-12-03'];

export const EVENTS_UNTIL = '2027-12-31';

export const KINDS = {
  fomc: { title: 'قرار الفائدة الأمريكية', sub: 'الاحتياطي الفيدرالي' },
  cpi: { title: 'التضخم الأمريكي', sub: 'مؤشر أسعار المستهلك' },
  nfp: { title: 'الوظائف الأمريكية', sub: 'تقرير التوظيف الشهري' },
};

// US Eastern -> UTC. DST runs from the 2nd Sunday of March to the 1st Sunday of November.
export function easternToUtc(dateStr, hh, mm) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  const dstStart = Date.UTC(y, 2, nthSunday(3, 2), 7);  // 2:00 EST = 07:00 UTC
  const dstEnd = Date.UTC(y, 10, nthSunday(11, 1), 6);  // 2:00 EDT = 06:00 UTC
  const asEst = Date.UTC(y, mo - 1, d, hh + 5, mm);
  const dst = asEst - 3600e3 >= dstStart && asEst - 3600e3 < dstEnd;
  return dst ? asEst - 3600e3 : asEst;
}

export const EVENTS = [
  ...FOMC.map((d) => ({ kind: 'fomc', at: easternToUtc(d, 14, 0) })),
  ...CPI.map((d) => ({ kind: 'cpi', at: easternToUtc(d, 8, 30) })),
  ...NFP.map((d) => ({ kind: 'nfp', at: easternToUtc(d, 8, 30) })),
].sort((a, b) => a.at - b.at);
