/**
 * lookup_availability wired against the real DefaultAvailabilityFinder —
 * confirms the skill speaks open slots when the calendar has room and
 * degrades cleanly when it doesn't.
 */
import { describe, it, expect } from 'vitest';
import { lookupAvailability } from '../../../src/ai/skills/lookup-availability';
import { DefaultAvailabilityFinder } from '../../../src/ai/tasks/availability-finder';
import { InMemoryAppointmentRepository } from '../../../src/appointments/appointment';

const HOUR = 60 * 60 * 1000;

describe('lookupAvailability skill (wired)', () => {
  it('returns open slots from an empty calendar', async () => {
    const finder = new DefaultAvailabilityFinder({
      appointmentRepo: new InMemoryAppointmentRepository(),
    });
    const from = new Date('2026-06-01T15:00:00.000Z');
    const res = await lookupAvailability(
      {
        tenantId: 't-1',
        searchFrom: from,
        searchTo: new Date(from.getTime() + 7 * 24 * HOUR),
        durationMs: 2 * HOUR,
      },
      finder,
    );
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.slots.length).toBeGreaterThan(0);
      expect(res.message.length).toBeGreaterThan(0);
    }
  });

  it('reports an invalid window as unavailable', async () => {
    const finder = new DefaultAvailabilityFinder({
      appointmentRepo: new InMemoryAppointmentRepository(),
    });
    const from = new Date('2026-06-01T15:00:00.000Z');
    const res = await lookupAvailability(
      { tenantId: 't-1', searchFrom: from, searchTo: from, durationMs: -1 },
      finder,
    );
    expect(res.status).toBe('unavailable');
  });
});
