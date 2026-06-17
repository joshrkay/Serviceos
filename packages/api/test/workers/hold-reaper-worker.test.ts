import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLogger } from '../../src/logging/logger';
import { runHoldReaperSweep } from '../../src/workers/hold-reaper-worker';

const TENANT = 'tenant-reaper';
const NOW = new Date('2026-06-15T18:00:00Z');
const logger = createLogger({ service: 'test', environment: 'test' });

function appt(over: Partial<Appointment>): Appointment {
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT,
    jobId: 'job-1',
    scheduledStart: new Date('2026-06-15T20:00:00Z'),
    scheduledEnd: new Date('2026-06-15T21:00:00Z'),
    timezone: 'America/New_York',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'system',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('U6 — runHoldReaperSweep', () => {
  let repo: InMemoryAppointmentRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  const deps = () => ({
    appointmentRepo: repo,
    auditRepo,
    listTenantIds: async () => [TENANT],
    logger,
    now: () => NOW,
  });

  it('cancels an expired hold, clears the flag, and emits an audit', async () => {
    const expired = await repo.create(
      appt({ holdPendingApproval: true, holdExpiryAt: new Date('2026-06-15T17:00:00Z') }),
    );

    const result = await runHoldReaperSweep(deps());

    expect(result).toEqual({ tenants: 1, reaped: 1, failed: 0 });
    const after = await repo.findById(TENANT, expired.id);
    expect(after?.status).toBe('canceled');
    expect(after?.holdPendingApproval).toBe(false);

    const audits = await auditRepo.findByEntity(TENANT, 'appointment', expired.id);
    expect(audits.some((a) => a.eventType === 'appointment.hold_expired')).toBe(true);
  });

  it('leaves a live hold and a normal appointment untouched', async () => {
    const liveHold = await repo.create(
      appt({ holdPendingApproval: true, holdExpiryAt: new Date('2026-06-15T19:00:00Z') }),
    );
    const normal = await repo.create(appt({ status: 'confirmed' }));

    const result = await runHoldReaperSweep(deps());

    expect(result.reaped).toBe(0);
    expect((await repo.findById(TENANT, liveHold.id))?.status).toBe('scheduled');
    expect((await repo.findById(TENANT, liveHold.id))?.holdPendingApproval).toBe(true);
    expect((await repo.findById(TENANT, normal.id))?.status).toBe('confirmed');
  });

  it('is idempotent — a second sweep is a no-op', async () => {
    await repo.create(
      appt({ holdPendingApproval: true, holdExpiryAt: new Date('2026-06-15T17:00:00Z') }),
    );

    const first = await runHoldReaperSweep(deps());
    const second = await runHoldReaperSweep(deps());

    expect(first.reaped).toBe(1);
    expect(second.reaped).toBe(0);
  });

  it('isolates a tenant failure and keeps sweeping', async () => {
    const boomRepo = {
      findExpiredHolds: async (t: string) => {
        if (t === 'bad') throw new Error('db down');
        return [];
      },
      update: async () => null,
    } as unknown as InMemoryAppointmentRepository;

    const result = await runHoldReaperSweep({
      appointmentRepo: boomRepo,
      auditRepo,
      listTenantIds: async () => ['bad', 'good'],
      logger,
      now: () => NOW,
    });

    expect(result).toEqual({ tenants: 2, reaped: 0, failed: 1 });
  });
});
