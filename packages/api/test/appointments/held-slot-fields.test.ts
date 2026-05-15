import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAppointment,
  updateAppointment,
} from '../../src/appointments/appointment';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';

const tenantA = '00000000-0000-4000-8000-00000000000a';

function baseInput() {
  return {
    tenantId: tenantA,
    jobId: '00000000-0000-4000-8000-0000000000j1',
    scheduledStart: new Date('2026-06-01T17:00:00Z'),
    scheduledEnd: new Date('2026-06-01T18:00:00Z'),
    timezone: 'America/Los_Angeles',
    createdBy: 'user-1',
  };
}

describe('held-slot appointment fields', () => {
  let repo: InMemoryAppointmentRepository;

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
  });

  it('defaults holdPendingApproval to false when not provided', async () => {
    const appt = await createAppointment(baseInput(), repo);
    expect(appt.holdPendingApproval).toBe(false);
    expect(appt.holdExpiryAt).toBeUndefined();
  });

  it('persists holdPendingApproval + holdExpiryAt when provided', async () => {
    const expiry = new Date('2026-06-02T17:00:00Z');
    const appt = await createAppointment(
      { ...baseInput(), holdPendingApproval: true, holdExpiryAt: expiry },
      repo,
    );
    expect(appt.holdPendingApproval).toBe(true);
    expect(appt.holdExpiryAt).toEqual(expiry);

    const found = await repo.findById(tenantA, appt.id);
    expect(found?.holdPendingApproval).toBe(true);
    expect(found?.holdExpiryAt).toEqual(expiry);
  });

  it('updateAppointment can clear the hold flag', async () => {
    const appt = await createAppointment(
      { ...baseInput(), holdPendingApproval: true, holdExpiryAt: new Date('2026-06-02T17:00:00Z') },
      repo,
    );
    const updated = await updateAppointment(
      tenantA,
      appt.id,
      { holdPendingApproval: false },
      repo,
    );
    expect(updated?.holdPendingApproval).toBe(false);
  });
});
