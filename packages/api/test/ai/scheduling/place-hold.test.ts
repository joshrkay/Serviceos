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

describe('placeAppointmentHold — idempotent replay at a different time', () => {
  // Value: protects=a repeated idempotency key never reports the NEW time while returning the OLD hold;
  //   fails_when=placeAppointmentHold trusts the requested window instead of the persisted row's;
  //   why_new=the live call's key is per session+job, so a second booking for the job hit the first hold; seam=none;
  //   no_claim=Postgres ON CONFLICT behaviour (in-memory repo mirrors it)
  it('refuses (hold_time_mismatch) when the key matches an existing hold at another time', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const first = await placeAppointmentHold(
      { appointmentRepo: repo },
      { tenantId: 't1', jobId: JOB_ID, scheduledStart: start, scheduledEnd: end, timezone: 'America/New_York', createdBy: 'sys', idempotencyKey: 'k-1' },
    );
    expect(first.ok).toBe(true);

    const later = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
    const again = await placeAppointmentHold(
      { appointmentRepo: repo },
      { tenantId: 't1', jobId: JOB_ID, scheduledStart: later, scheduledEnd: new Date(later.getTime() + 3600000), timezone: 'America/New_York', createdBy: 'sys', idempotencyKey: 'k-1' },
    );
    expect(again).toEqual({ ok: false, failed: 'hold_time_mismatch' });
  });

  it('a replay at the SAME time still returns the existing hold', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const args = { tenantId: 't1', jobId: JOB_ID, scheduledStart: start, scheduledEnd: end, timezone: 'America/New_York', createdBy: 'sys', idempotencyKey: 'k-2' };
    const first = await placeAppointmentHold({ appointmentRepo: repo }, args);
    const again = await placeAppointmentHold({ appointmentRepo: repo }, args);
    expect(first.ok && again.ok && again.appointmentId === first.appointmentId).toBe(true);
  });

  // Value: protects=a hold the owner already released (UNDO cancel) is never handed back as a live hold;
  //   fails_when=the idempotent create returns the canceled row and the hold reports ok;
  //   why_new=focused review of pass 3: a same-call rebook after an owner UNDO auto-booked a canceled appointment;
  //   seam=none; no_claim=which cancel path released it
  it('a replay whose hold was canceled is refused (hold_released), never handed back as live', async () => {
    const repo = new InMemoryAppointmentRepository();
    const { start, end } = futureDates();
    const args = { tenantId: 't1', jobId: JOB_ID, scheduledStart: start, scheduledEnd: end, timezone: 'America/New_York', createdBy: 'sys', idempotencyKey: 'k-3' };
    const first = await placeAppointmentHold({ appointmentRepo: repo }, args);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await repo.update('t1', first.appointmentId, { status: 'canceled', holdPendingApproval: false });

    const again = await placeAppointmentHold({ appointmentRepo: repo }, args);
    expect(again).toEqual({ ok: false, failed: 'hold_released' });
  });
});

describe('resolveAndPlaceAppointmentHold — slot-conflict check', () => {
  const now = new Date('2026-08-03T16:00:00Z');
  const base = { tenantId: 't1', jobId: JOB_ID, customerId: 'cust-1', dateTimeDescription: 'next Tuesday at 2pm', timezone: 'America/New_York', now, createdBy: 'sys' };

  // Value: protects=a slot the caller is already busy in is never held, and a hold says whether its slot was checked;
  //   fails_when=the conflict check is skipped, runs after the write, or conflictChecked is reported without a check;
  //   why_new=the live call held slots with no conflict check; seam=none; no_claim=the checker's own overlap rules
  it('a busy slot places no hold (slot_conflict)', async () => {
    const repo = new InMemoryAppointmentRepository();
    const result = await resolveAndPlaceAppointmentHold(
      { appointmentRepo: repo, slotConflictChecker: { check: async () => ({ ok: false, conflict: 'customer_busy', appointmentId: 'a-busy' }) } as never },
      base,
    );
    expect(result).toEqual({ ok: false, failed: 'slot_conflict' });
    expect(await repo.findByDateRange('t1', new Date(0), new Date('2100-01-01'))).toHaveLength(0);
  });

  it('a free slot is held and reports conflictChecked: true; no checker reports false', async () => {
    const checked = await resolveAndPlaceAppointmentHold(
      { appointmentRepo: new InMemoryAppointmentRepository(), slotConflictChecker: { check: async () => ({ ok: true }) } as never },
      base,
    );
    expect(checked.ok && checked.conflictChecked).toBe(true);
    const unchecked = await resolveAndPlaceAppointmentHold({ appointmentRepo: new InMemoryAppointmentRepository() }, base);
    expect(unchecked.ok && unchecked.conflictChecked === false).toBe(true);
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
