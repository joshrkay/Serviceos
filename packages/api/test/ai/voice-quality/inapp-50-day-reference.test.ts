/**
 * The in-app 50 harness seeds its catalog appointment on "next Tuesday" and
 * resolves spoken day phrases against the same clock. The two must name the
 * SAME calendar day on every day of the week, or the register's Tuesday cases
 * (resched-01, cancel-01, confirm-01) stop resolving on the one weekday the
 * seed and the phrase disagree — which turned main's Deploy red on Tuesday
 * 2026-09-15 with no product change.
 */
import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';

import { nextTuesdayAt14, referenceDayIso } from '../../../src/ai/voice-quality/inapp-50/world';

const ZONE = 'America/Phoenix';

describe('in-app 50 harness — a spoken weekday names the day the seed lands on', () => {
  // Monday 2026-09-14 … Sunday 2026-09-20, each at a morning and an evening
  // tenant-local hour (the evening one is after the 14:00 seed time).
  const runs = Array.from({ length: 7 }, (_, i) => i).flatMap((i) =>
    [8, 20].map((hour) => DateTime.fromObject({ year: 2026, month: 9, day: 14 + i, hour }, { zone: ZONE })),
  );

  for (const local of runs) {
    it(`on ${local.toFormat('cccc HH:mm')} "Tuesday appointment" names the seeded appointment's day`, () => {
      const now = local.toJSDate();
      const seededDay = DateTime.fromJSDate(nextTuesdayAt14(ZONE, now), { zone: ZONE }).toISODate();
      expect(referenceDayIso("Garcia's Tuesday appointment", ZONE, now)).toBe(seededDay);
    });
  }

  it('"today" and "tomorrow" still name today and tomorrow, including on a Tuesday', () => {
    const tuesday = DateTime.fromObject({ year: 2026, month: 9, day: 15, hour: 8 }, { zone: ZONE });
    expect(referenceDayIso('the appointment today', ZONE, tuesday.toJSDate())).toBe('2026-09-15');
    expect(referenceDayIso('tomorrow', ZONE, tuesday.toJSDate())).toBe('2026-09-16');
  });

  it('a phrase with no day in it is not a day reference', () => {
    expect(referenceDayIso('the Garcia job', ZONE, new Date('2026-09-15T15:00:00Z'))).toBeUndefined();
  });
});
