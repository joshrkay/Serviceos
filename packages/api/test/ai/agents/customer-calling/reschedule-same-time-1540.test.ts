/**
 * #1540 §1 (owner decision 2026-10-01) — "reschedule my appointment from
 * Tuesday to Wednesday at the same time": "same time" is relative to the
 * REFERENCED appointment, so once that appointment is resolved its
 * tenant-local time-of-day (and length) lands on the new day as
 * newScheduledStart / newScheduledEnd — the reschedule payload's fields.
 *
 * Seam: resolveSchedulingEntities (the live-turn resolution both voice legs
 * run) with a fake EntityResolver and the referenced appointment's window
 * supplied through the new `appointmentWindow` lookup.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveSchedulingEntities } from '../../../../src/ai/agents/customer-calling/entity-resolution';
import type { EntityResolver } from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 't-1540-same-time';
const APPT = '00000000-0000-4000-8000-000015401001';
const JANE = '00000000-0000-4000-8000-000015401002';

const resolver: EntityResolver = {
  resolve: vi.fn(async (input) =>
    input.kind === 'appointment'
      ? {
          kind: 'resolved' as const,
          candidate: { id: APPT, kind: 'appointment' as const, label: 'Jane Smith — Tuesday 2:00 PM', score: 1 },
        }
      : { kind: 'not_found' as const, reference: input.reference },
  ),
};

describe('#1540 §1 — reschedule "at the same time" keeps the referenced appointment\'s clock time', () => {
  it('Tuesday 2–4pm moved to "Wednesday at the same time" is Wednesday 2–4pm', async () => {
    const result = await resolveSchedulingEntities(
      resolver,
      TENANT,
      'reschedule_appointment',
      {
        customerId: JANE,
        appointmentReference: 'my appointment on Tuesday',
        newDateTimeDescription: 'Wednesday at the same time',
      },
      undefined,
      {
        timezone: 'America/Los_Angeles',
        now: new Date('2026-05-01T12:00:00.000Z'),
        appointmentWindow: async (appointmentId) =>
          appointmentId === APPT
            ? { startUtc: '2026-05-05T21:00:00.000Z', endUtc: '2026-05-05T23:00:00.000Z' }
            : undefined,
      },
    );

    expect(result.refs.appointmentId).toBe(APPT);
    expect(result.refs.newScheduledStart).toBe('2026-05-06T21:00:00.000Z');
    expect(result.refs.newScheduledEnd).toBe('2026-05-06T23:00:00.000Z');
  });
});
