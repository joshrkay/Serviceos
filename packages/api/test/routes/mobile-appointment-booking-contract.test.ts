import { describe, it, expect } from 'vitest';
import { createAppointmentSchema } from '../../src/shared/contracts';

/**
 * U7 / B1 — the mobile manual-booking client (packages/mobile/src/api/
 * appointments.ts `createAppointment`) POSTs to /api/appointments, which parses
 * the body with `createAppointmentSchema` BEFORE any handler code runs. A mocked
 * mobile fetch can only prove the client sends what its author expects — it
 * cannot prove the server accepts it. This pins the REAL schema as the oracle so
 * a dropped/renamed required field fails the build instead of shipping a silent
 * 400 (docs/solutions/test-failures/mocked-client-shape-masks-server-schema-rejection.md).
 */
describe('createAppointmentSchema — mobile manual-booking body', () => {
  // Exactly the shape createAppointment builds (jobId + ISO start/end + tenant tz).
  const validBody = {
    jobId: 'job-1',
    scheduledStart: '2026-06-22T13:00:00.000Z',
    scheduledEnd: '2026-06-22T14:00:00.000Z',
    timezone: 'America/New_York',
    notes: 'Front door',
  };

  it('accepts the booking body the mobile client sends', () => {
    expect(() => createAppointmentSchema.parse(validBody)).not.toThrow();
  });

  it('accepts the body without the optional notes field', () => {
    const { notes: _notes, ...noNotes } = validBody;
    expect(() => createAppointmentSchema.parse(noNotes)).not.toThrow();
  });

  it('rejects a body missing the required timezone (the field mobile must send)', () => {
    const { timezone: _tz, ...noTz } = validBody;
    expect(() => createAppointmentSchema.parse(noTz)).toThrow();
  });

  it('rejects a non-ISO scheduledStart', () => {
    expect(() => createAppointmentSchema.parse({ ...validBody, scheduledStart: 'June 22' })).toThrow();
  });
});
