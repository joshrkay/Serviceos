import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  runHoldReaperSweep,
  HOLD_REAPER_ACTOR_ID,
} from '../../src/workers/hold-reaper-worker';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Appointment, AppointmentRepository } from '../../src/appointments/appointment';
import { createLogger } from '../../src/logging/logger';

const TENANT = 'tenant-reaper-1';
const NOW = new Date('2026-06-15T12:00:00Z');

const silentLogger = () =>
  createLogger({ service: 'test', environment: 'test', level: 'error' });

/** Build an appointment row directly (bypasses createAppointment so we can
 *  seed pre-expired holds and arbitrary statuses without the create-time
 *  validation forcing status='scheduled' / future timestamps). */
function appt(overrides: Partial<Appointment>): Appointment {
  const start = new Date('2026-06-15T09:00:00Z');
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId: uuidv4(),
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
    timezone: 'UTC',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u1',
    createdAt: new Date('2026-06-14T00:00:00Z'),
    updatedAt: new Date('2026-06-14T00:00:00Z'),
    ...overrides,
  };
}

async function seed(repo: InMemoryAppointmentRepository, a: Appointment): Promise<Appointment> {
  return repo.create(a);
}

describe('hold-reaper-worker', () => {
  it('cancels an expired hold and emits an appointment.hold_expired audit event', async () => {
    const repo = new InMemoryAppointmentRepository();
    const audit = new InMemoryAuditRepository();
    const expired = await seed(
      repo,
      appt({
        holdPendingApproval: true,
        holdExpiryAt: new Date(NOW.getTime() - 60 * 1000), // 1 min past
      }),
    );

    const result = await runHoldReaperSweep({
      appointmentRepo: repo,
      auditRepo: audit,
      listTenantIds: async () => [TENANT],
      logger: silentLogger(),
      now: () => NOW,
    });

    expect(result).toEqual({ tenants: 1, reaped: 1, failed: 0 });

    const after = await repo.findById(TENANT, expired.id);
    expect(after!.status).toBe('canceled');
    expect(after!.holdPendingApproval).toBe(false);
    expect(after!.holdExpiryAt).toBeUndefined();

    const events = await audit.findByEntity(TENANT, 'appointment', expired.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('appointment.hold_expired');
    expect(events[0].actorId).toBe(HOLD_REAPER_ACTOR_ID);
    expect(events[0].tenantId).toBe(TENANT);
  });

  it('leaves a LIVE hold (future expiry) untouched', async () => {
    const repo = new InMemoryAppointmentRepository();
    const audit = new InMemoryAuditRepository();
    const live = await seed(
      repo,
      appt({
        holdPendingApproval: true,
        holdExpiryAt: new Date(NOW.getTime() + 60 * 60 * 1000), // future
      }),
    );

    const result = await runHoldReaperSweep({
      appointmentRepo: repo,
      auditRepo: audit,
      listTenantIds: async () => [TENANT],
      logger: silentLogger(),
      now: () => NOW,
    });

    expect(result.reaped).toBe(0);
    const after = await repo.findById(TENANT, live.id);
    expect(after!.status).toBe('scheduled');
    expect(after!.holdPendingApproval).toBe(true);
    expect(await audit.getAll()).toHaveLength(0);
  });

  it('leaves a normal confirmed appointment untouched', async () => {
    const repo = new InMemoryAppointmentRepository();
    const audit = new InMemoryAuditRepository();
    const normal = await seed(
      repo,
      appt({ status: 'confirmed', holdPendingApproval: false }),
    );

    const result = await runHoldReaperSweep({
      appointmentRepo: repo,
      auditRepo: audit,
      listTenantIds: async () => [TENANT],
      logger: silentLogger(),
      now: () => NOW,
    });

    expect(result.reaped).toBe(0);
    const after = await repo.findById(TENANT, normal.id);
    expect(after!.status).toBe('confirmed');
    expect(await audit.getAll()).toHaveLength(0);
  });

  it('is idempotent — a second sweep over an already-reaped hold is a no-op', async () => {
    const repo = new InMemoryAppointmentRepository();
    const audit = new InMemoryAuditRepository();
    await seed(
      repo,
      appt({
        holdPendingApproval: true,
        holdExpiryAt: new Date(NOW.getTime() - 60 * 1000),
      }),
    );

    const first = await runHoldReaperSweep({
      appointmentRepo: repo,
      auditRepo: audit,
      listTenantIds: async () => [TENANT],
      logger: silentLogger(),
      now: () => NOW,
    });
    expect(first.reaped).toBe(1);

    const second = await runHoldReaperSweep({
      appointmentRepo: repo,
      auditRepo: audit,
      listTenantIds: async () => [TENANT],
      logger: silentLogger(),
      now: () => NOW,
    });
    expect(second.reaped).toBe(0);
    // No second audit event — the row is no longer a pending hold.
    expect(await audit.getAll()).toHaveLength(1);
  });

  it('isolates per-tenant errors — one failing tenant does not abort the others', async () => {
    const good = new InMemoryAppointmentRepository();
    const audit = new InMemoryAuditRepository();
    const expired = await seed(
      good,
      appt({
        holdPendingApproval: true,
        holdExpiryAt: new Date(NOW.getTime() - 60 * 1000),
      }),
    );

    const BAD_TENANT = 'tenant-reaper-bad';
    // A repo that throws for the bad tenant but delegates to the in-memory
    // repo for the good one — proves the sweep continues past a failure.
    const repo: AppointmentRepository = {
      create: good.create.bind(good),
      findById: good.findById.bind(good),
      findByJob: good.findByJob.bind(good),
      findByDateRange: good.findByDateRange.bind(good),
      update: good.update.bind(good),
      findExpiredHolds: async (tenantId: string, now: Date) => {
        if (tenantId === BAD_TENANT) throw new Error('boom');
        return good.findExpiredHolds(tenantId, now);
      },
    };

    const result = await runHoldReaperSweep({
      appointmentRepo: repo,
      auditRepo: audit,
      listTenantIds: async () => [BAD_TENANT, TENANT],
      logger: silentLogger(),
      now: () => NOW,
    });

    expect(result.failed).toBe(1);
    expect(result.reaped).toBe(1);
    const after = await good.findById(TENANT, expired.id);
    expect(after!.status).toBe('canceled');
  });
});
