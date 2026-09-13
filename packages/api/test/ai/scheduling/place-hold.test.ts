/**
 * WS18b — shared appointment-hold placement (extracted from the recorded-voice
 * task; also drives the live-call close). Ownership guard + hold write +
 * resolve-then-place.
 */
import { describe, it, expect } from 'vitest';
import {
  placeAppointmentHold,
  resolveAndPlaceAppointmentHold,
  DEFAULT_HOLD_WINDOW_MS,
} from '../../../src/ai/scheduling/place-hold';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { JobRepository } from '../../../src/jobs/job';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function futureDates() {
  const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

function jobRepoOwnedBy(customerId: string): JobRepository {
  return {
    findById: async (_t: string, id: string) => (id === JOB_ID ? ({ id, customerId } as never) : null),
  } as unknown as JobRepository;
}

describe('placeAppointmentHold', () => {
  it('places a 24h tentative hold when no jobRepo is wired', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const before = Date.now();
    const result = await placeAppointmentHold(
      { appointmentRepo: repo },
      { tenantId: 't1', jobId: JOB_ID, scheduledStart: start, scheduledEnd: end, timezone: 'America/New_York', createdBy: 'sys' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const appt = await repo.findById('t1', result.appointmentId);
    expect(appt!.holdPendingApproval).toBe(true);
    expect(result.holdExpiryAt.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_HOLD_WINDOW_MS - 5000);
  });

  it('passes the ownership guard for a job the caller owns', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const result = await placeAppointmentHold(
      { appointmentRepo: repo, jobRepo: jobRepoOwnedBy('cust-1') },
      { tenantId: 't1', jobId: JOB_ID, customerId: 'cust-1', scheduledStart: start, scheduledEnd: end, timezone: 'America/New_York', createdBy: 'sys' },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a job owned by someone else (job_not_owned)', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const result = await placeAppointmentHold(
      { appointmentRepo: repo, jobRepo: jobRepoOwnedBy('other-cust') },
      { tenantId: 't1', jobId: JOB_ID, customerId: 'cust-1', scheduledStart: start, scheduledEnd: end, timezone: 'America/New_York', createdBy: 'sys' },
    );
    expect(result).toEqual({ ok: false, failed: 'job_not_owned' });
  });

  it('rejects a malformed jobId when a jobRepo is wired (job_not_owned)', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const result = await placeAppointmentHold(
      { appointmentRepo: repo, jobRepo: jobRepoOwnedBy('cust-1') },
      { tenantId: 't1', jobId: 'not-a-uuid', customerId: 'cust-1', scheduledStart: start, scheduledEnd: end, timezone: 'America/New_York', createdBy: 'sys' },
    );
    expect(result).toEqual({ ok: false, failed: 'job_not_owned' });
  });

  it('degrades to hold_write_failed on a validation error (inverted range)', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const result = await placeAppointmentHold(
      { appointmentRepo: repo },
      // end before start → validateAppointmentTimes error → createAppointment throws.
      { tenantId: 't1', jobId: JOB_ID, scheduledStart: end, scheduledEnd: start, timezone: 'America/New_York', createdBy: 'sys' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('hold_write_failed');
  });
});

describe('resolveAndPlaceAppointmentHold', () => {
  it('resolves a spoken phrase and places the hold, returning the resolved window', async () => {
    const repo = new InMemoryAppointmentRepository();
    const now = new Date('2026-08-03T16:00:00Z'); // a Monday
    const result = await resolveAndPlaceAppointmentHold(
      { appointmentRepo: repo },
      { tenantId: 't1', jobId: JOB_ID, dateTimeDescription: 'next Tuesday at 2pm', timezone: 'America/New_York', now, createdBy: 'sys' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.scheduledStart).toBe('string');
    const appt = await repo.findById('t1', result.appointmentId);
    expect(appt!.holdPendingApproval).toBe(true);
  });

  it('returns unresolved_datetime for an unparseable phrase', async () => {
    const repo = new InMemoryAppointmentRepository();
    const result = await resolveAndPlaceAppointmentHold(
      { appointmentRepo: repo },
      { tenantId: 't1', jobId: JOB_ID, dateTimeDescription: 'whenever works', timezone: 'America/New_York', now: new Date(), createdBy: 'sys' },
    );
    expect(result).toEqual({ ok: false, failed: 'unresolved_datetime' });
  });

  /**
   * The live-call close both WRITES a held appointment and SPEAKS the time
   * back to the caller. It used to fall through to a product-default
   * America/New_York when the tenant had no zone, so an America/Phoenix
   * business held the wrong slot and confirmed the wrong hour out loud.
   * There is no default any more: no zone, no hold.
   */
  it('refuses to hold when the tenant has no timezone rather than guessing US-Eastern', async () => {
    const repo = new InMemoryAppointmentRepository();
    const result = await resolveAndPlaceAppointmentHold(
      { appointmentRepo: repo },
      {
        tenantId: 't1',
        jobId: JOB_ID,
        dateTimeDescription: 'next Tuesday at 2pm',
        // no timezone — the "never chose one" state
        now: new Date(),
        createdBy: 'sys',
      },
    );
    expect(result).toEqual({ ok: false, failed: 'timezone_unconfigured' });
  });

  it('refuses to hold on a timezone the runtime does not recognize', async () => {
    const repo = new InMemoryAppointmentRepository();
    const result = await resolveAndPlaceAppointmentHold(
      { appointmentRepo: repo },
      {
        tenantId: 't1',
        jobId: JOB_ID,
        dateTimeDescription: 'next Tuesday at 2pm',
        timezone: 'Foo/Bar',
        now: new Date(),
        createdBy: 'sys',
      },
    );
    // Garbage takes the same chute as absent — resolveDateTime would
    // otherwise silently fall back to the product default one layer down.
    expect(result).toEqual({ ok: false, failed: 'timezone_unconfigured' });
  });

  it('still holds normally for a non-Eastern tenant that HAS a zone', async () => {
    const repo = new InMemoryAppointmentRepository();
    const result = await resolveAndPlaceAppointmentHold(
      { appointmentRepo: repo },
      {
        tenantId: 't1',
        jobId: JOB_ID,
        dateTimeDescription: 'next Tuesday at 2pm',
        timezone: 'America/Phoenix',
        now: new Date('2026-07-27T12:00:00.000Z'),
        createdBy: 'sys',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "next Tuesday" from Mon Jul 27 is Aug 4 (chrono skips to the following
    // week, not tomorrow). 2pm Phoenix is UTC-7 in August as in January —
    // Arizona has no DST — so this is 21:00Z. An Eastern default would have
    // produced 18:00Z, and a DST-applying "fix" 20:00Z.
    expect(result.scheduledStart).toBe('2026-08-04T21:00:00.000Z');
    expect(result.timezone).toBe('America/Phoenix');
  });
});
