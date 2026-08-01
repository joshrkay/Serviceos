import { describe, expect, it } from 'vitest';
import {
  formatAppointmentWindow,
  pickActiveAppointment,
  tenantLocalDate,
  technicianStatusLabel,
} from './technicianDay';

describe('technician day formatting', () => {
  it('derives the request date in the tenant timezone rather than UTC', () => {
    const instant = new Date('2026-07-15T02:30:00.000Z');
    expect(tenantLocalDate(instant, 'America/Los_Angeles')).toBe('2026-07-14');
    expect(tenantLocalDate(instant, 'Asia/Tokyo')).toBe('2026-07-15');
  });

  it('formats an appointment window in the tenant timezone', () => {
    expect(
      formatAppointmentWindow(
        '2026-07-15T16:00:00.000Z',
        '2026-07-15T17:30:00.000Z',
        'America/Los_Angeles',
      ),
    ).toBe('9:00 AM–10:30 AM');
  });

  it('turns wire statuses into compact display labels', () => {
    expect(technicianStatusLabel('in_progress')).toBe('In progress');
  });

  it('re-exports pickActiveAppointment for next-job GPS targeting', () => {
    expect(
      pickActiveAppointment(
        [
          {
            id: 'next',
            status: 'scheduled',
            scheduledStart: '2026-07-15T18:00:00.000Z',
            scheduledEnd: '2026-07-15T19:00:00.000Z',
          },
        ],
        Date.parse('2026-07-15T12:00:00.000Z'),
      )?.id,
    ).toBe('next');
  });
});
