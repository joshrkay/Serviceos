import { describe, expect, it } from 'vitest';
import { pickActiveAppointment, tenantLocalDate } from './technician-field.js';

function appt(
  id: string,
  status: string,
  start: string,
  end: string,
): { id: string; status: string; scheduledStart: string; scheduledEnd: string } {
  return { id, status, scheduledStart: start, scheduledEnd: end };
}

describe('pickActiveAppointment', () => {
  it('prefers an in_progress visit even when its start is in the past', () => {
    const now = Date.parse('2026-07-15T17:00:00.000Z');
    expect(
      pickActiveAppointment(
        [
          appt('past', 'in_progress', '2026-07-15T15:00:00.000Z', '2026-07-15T16:00:00.000Z'),
          appt('future', 'scheduled', '2026-07-15T18:00:00.000Z', '2026-07-15T19:00:00.000Z'),
        ],
        now,
      )?.id,
    ).toBe('past');
  });

  it('picks the visit currently inside its scheduled window', () => {
    const now = Date.parse('2026-07-15T16:30:00.000Z');
    expect(
      pickActiveAppointment(
        [
          appt('a', 'scheduled', '2026-07-15T16:00:00.000Z', '2026-07-15T17:00:00.000Z'),
          appt('b', 'confirmed', '2026-07-15T18:00:00.000Z', '2026-07-15T19:00:00.000Z'),
        ],
        now,
      )?.id,
    ).toBe('a');
  });

  it('falls forward to the next future start and skips terminal statuses', () => {
    const now = Date.parse('2026-07-15T12:00:00.000Z');
    expect(
      pickActiveAppointment(
        [
          appt('done', 'completed', '2026-07-15T10:00:00.000Z', '2026-07-15T11:00:00.000Z'),
          appt('canceled', 'canceled', '2026-07-15T13:00:00.000Z', '2026-07-15T14:00:00.000Z'),
          appt('next', 'scheduled', '2026-07-15T15:00:00.000Z', '2026-07-15T16:00:00.000Z'),
        ],
        now,
      )?.id,
    ).toBe('next');
  });

  it('keeps a late open visit when nothing is left later in the day', () => {
    const now = Date.parse('2026-07-15T20:00:00.000Z');
    expect(
      pickActiveAppointment(
        [appt('late', 'confirmed', '2026-07-15T16:00:00.000Z', '2026-07-15T17:00:00.000Z')],
        now,
      )?.id,
    ).toBe('late');
  });

  it('returns null when the day is empty or fully terminal', () => {
    expect(pickActiveAppointment([], Date.now())).toBeNull();
    expect(
      pickActiveAppointment(
        [appt('x', 'no_show', '2026-07-15T16:00:00.000Z', '2026-07-15T17:00:00.000Z')],
        Date.parse('2026-07-15T12:00:00.000Z'),
      ),
    ).toBeNull();
  });
});

describe('tenantLocalDate', () => {
  it('derives YYYY-MM-DD in the tenant timezone', () => {
    const instant = new Date('2026-07-15T02:30:00.000Z');
    expect(tenantLocalDate(instant, 'America/Los_Angeles')).toBe('2026-07-14');
    expect(tenantLocalDate(instant, 'Asia/Tokyo')).toBe('2026-07-15');
  });
});
