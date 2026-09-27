/**
 * #1079 / PRD 4.7 — the board's lateness adapter. The wired happy path is
 * pinned at real Postgres through GET /api/dispatch/board
 * (test/integration/lateness-from-truck-location-4-7.test.ts); these pin the
 * cases where the board must show NO lateness rather than a guessed one.
 */
import { describe, it, expect } from 'vitest';
import { createAppointmentLatenessResolver } from '../../src/dispatch/lateness-resolver';
import type { Appointment } from '../../src/appointments/appointment';

const TENANT = 'tenant-1';
const now = new Date('2026-09-26T18:00:00Z');

function appointment(status: Appointment['status']): Appointment {
  return {
    id: 'appt-1',
    tenantId: TENANT,
    jobId: 'job-1',
    scheduledStart: new Date('2026-09-26T17:00:00Z'),
    scheduledEnd: new Date('2026-09-26T18:00:00Z'),
    timezone: 'UTC',
    status,
    holdPendingApproval: false,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  } as Appointment;
}

function resolver(opts: { pings?: number; coords?: boolean }) {
  return createAppointmentLatenessResolver(TENANT, {
    pingRepo: {
      listByAppointment: async () =>
        Array.from({ length: opts.pings ?? 0 }, (_, i) => ({
          id: `p${i}`,
          tenantId: TENANT,
          technicianId: 'tech-1',
          clientPingId: `c${i}`,
          appointmentId: 'appt-1',
          lat: 33.4484,
          lng: -112.074,
          accuracyMeters: 8,
          recordedAt: new Date(now.getTime() - (6 - i) * 5 * 60 * 1000),
          source: 'mobile',
        })),
    },
    jobRepo: { findById: async () => ({ id: 'job-1', locationId: 'loc-1' }) as never },
    locationRepo: {
      findById: async () =>
        (opts.coords === false ? { id: 'loc-1' } : { id: 'loc-1', latitude: 33.4484, longitude: -112.074 }) as never,
    },
    now: () => now,
  });
}

describe('createAppointmentLatenessResolver (#1079)', () => {
  it('no pings for the appointment → no lateness on the board', async () => {
    expect(await resolver({ pings: 0 })(appointment('scheduled'), 'tech-1')).toBeUndefined();
  });

  it('a service location without coordinates → no lateness (no geofence to measure against)', async () => {
    expect(await resolver({ pings: 6, coords: false })(appointment('scheduled'), 'tech-1')).toBeUndefined();
  });

  it('a completed appointment → no lateness, even with pings', async () => {
    expect(await resolver({ pings: 6 })(appointment('completed'), 'tech-1')).toBeUndefined();
  });

  it('pings dwelling on the site → an at_site evaluation', async () => {
    const result = await resolver({ pings: 6 })(appointment('in_progress'), 'tech-1');
    expect(result?.progressState).toBe('at_site');
  });
});
