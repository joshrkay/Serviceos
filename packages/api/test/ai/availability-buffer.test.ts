import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DefaultAvailabilityFinder,
  DEFAULT_BUFFER_MS,
} from '../../src/ai/tasks/availability-finder';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';

const tenantA = '00000000-0000-4000-8000-00000000000a';
const HOUR = 60 * 60 * 1000;

function appt(overrides: Partial<Appointment>): Appointment {
  return {
    id: overrides.id ?? `appt-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: tenantA,
    jobId: 'job-1',
    scheduledStart: overrides.scheduledStart ?? new Date('2026-06-01T17:00:00Z'),
    scheduledEnd: overrides.scheduledEnd ?? new Date('2026-06-01T18:00:00Z'),
    timezone: 'UTC',
    status: overrides.status ?? 'scheduled',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    holdPendingApproval: overrides.holdPendingApproval ?? false,
    holdExpiryAt: overrides.holdExpiryAt,
  };
}

describe('buffer-aware availability', () => {
  let repo: InMemoryAppointmentRepository;
  let finder: DefaultAvailabilityFinder;

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
    finder = new DefaultAvailabilityFinder({ appointmentRepo: repo });
    // Pin "now" so the finder's expired-hold check is deterministic.
    // The hold-expiry fixtures below straddle this instant: an expiry
    // before it is expired, an expiry after it is still live.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T18:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports a positive DEFAULT_BUFFER_MS', () => {
    expect(DEFAULT_BUFFER_MS).toBeGreaterThan(0);
  });

  it('does not offer a slot that starts within bufferMs of a busy appointment', async () => {
    // Busy 17:00–18:00. Without buffer, 18:00 is free. With a 30-min
    // buffer, the earliest offered slot must start at or after 18:30.
    await repo.create(appt({
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
    }));

    const result = await finder.find({
      tenantId: tenantA,
      searchFrom: new Date('2026-06-01T18:00:00Z'),
      searchTo: new Date('2026-06-01T22:00:00Z'),
      durationMs: HOUR,
      bufferMs: 30 * 60 * 1000,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots[0].start.getTime()).toBeGreaterThanOrEqual(
        new Date('2026-06-01T18:30:00Z').getTime(),
      );
    }
  });

  it('treats an expired hold as free', async () => {
    // A held appointment 19:00–20:00 whose hold expired yesterday must
    // NOT block the 19:00 slot.
    await repo.create(appt({
      scheduledStart: new Date('2026-06-01T19:00:00Z'),
      scheduledEnd: new Date('2026-06-01T20:00:00Z'),
      holdPendingApproval: true,
      holdExpiryAt: new Date('2026-05-31T00:00:00Z'),
    }));

    const result = await finder.find({
      tenantId: tenantA,
      searchFrom: new Date('2026-06-01T19:00:00Z'),
      searchTo: new Date('2026-06-01T21:00:00Z'),
      durationMs: HOUR,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots[0].start.getTime()).toBe(
        new Date('2026-06-01T19:00:00Z').getTime(),
      );
    }
  });

  it('treats a non-expired hold as busy', async () => {
    // Same as above but the hold is still live — 19:00 must be blocked.
    await repo.create(appt({
      scheduledStart: new Date('2026-06-01T19:00:00Z'),
      scheduledEnd: new Date('2026-06-01T20:00:00Z'),
      holdPendingApproval: true,
      holdExpiryAt: new Date('2099-01-01T00:00:00Z'),
    }));

    const result = await finder.find({
      tenantId: tenantA,
      searchFrom: new Date('2026-06-01T19:00:00Z'),
      searchTo: new Date('2026-06-01T21:00:00Z'),
      durationMs: HOUR,
      count: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots[0].start.getTime()).toBe(
        new Date('2026-06-01T20:00:00Z').getTime(),
      );
    }
  });
});
