import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchedulingRouter } from '../../src/scheduling/routes';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';

function fakeAuth(tenantId = 't-1') {
  return (req: any, _res: any, next: any) => {
    req.auth = { tenantId, userId: 'u-1', role: 'dispatcher' };
    next();
  };
}

/**
 * A far-future window so the business-hours slots are unambiguously in the
 * future regardless of the wall clock `findBookableSlots` reads — the finder
 * never offers slots in the past, so a near-now date would make assertions
 * flaky. 2099 keeps the whole day bookable forever.
 */
const FUTURE_DAY = '2099-06-15';

function makeApp(opts: {
  findByDateRange?: (tenantId: string, from: Date, to: Date) => Promise<Appointment[]>;
  findByAppointment?: (tenantId: string, apptId: string) => Promise<{ technicianId: string }[]>;
  timezone?: string | null;
  tenantId?: string;
  settings?: Record<string, unknown> | null;
}) {
  const findByDateRange = vi.fn(opts.findByDateRange ?? (async () => []));
  const findByAppointment = vi.fn(opts.findByAppointment ?? (async () => []));
  const deps: FeasibilityDependencies = {
    assignmentRepo: { findByAppointment } as any,
    appointmentRepo: { findByDateRange } as any,
    jobRepo: {} as any,
    locationRepo: {} as any,
    // The route threads these into findBookableSlotsDetailed when a
    // technicianId is supplied — they must be callable, not bare `{}`.
    workingHoursRepo: { findByTechnician: async () => [] } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: {} as any,
    skillMatcher: {} as any,
  };
  const userRepo = { findById: async () => null } as any;
  const settingsRepo =
    opts.timezone === undefined && opts.settings === undefined
      ? undefined
      : ({
          findByTenant: async () =>
            opts.settings !== undefined
              ? opts.settings
              : opts.timezone
                ? { timezone: opts.timezone }
                : null,
        } as any);
  const app = express();
  app.use(express.json());
  app.use(fakeAuth(opts.tenantId ?? 't-1'));
  app.use('/api/dispatch', createSchedulingRouter(deps, userRepo, settingsRepo));
  return { app, findByDateRange, findByAppointment };
}

describe('GET /api/dispatch/availability', () => {
  it('returns 200 with { timezone, durationMin, slots[] } in ISO shape', async () => {
    const { app } = makeApp({ timezone: 'America/New_York' });
    const res = await request(app)
      .get('/api/dispatch/availability')
      .query({ from: FUTURE_DAY, to: FUTURE_DAY, durationMin: 60 });

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/New_York');
    expect(res.body.durationMin).toBe(60);
    expect(Array.isArray(res.body.slots)).toBe(true);
    expect(res.body.slots.length).toBeGreaterThan(0);
    for (const slot of res.body.slots) {
      expect(typeof slot.start).toBe('string');
      expect(typeof slot.end).toBe('string');
      expect(Number.isNaN(new Date(slot.start).getTime())).toBe(false);
      expect(Number.isNaN(new Date(slot.end).getTime())).toBe(false);
    }
  });

  it('scopes the slot query to the authenticated tenant', async () => {
    const { app, findByDateRange } = makeApp({ timezone: 'UTC', tenantId: 'tenant-xyz' });
    await request(app).get('/api/dispatch/availability').query({ from: FUTURE_DAY, to: FUTURE_DAY });
    expect(findByDateRange).toHaveBeenCalled();
    expect(findByDateRange.mock.calls[0][0]).toBe('tenant-xyz');
  });

  it('falls back to the default timezone when no settings repo is wired', async () => {
    const { app } = makeApp({ timezone: undefined });
    const res = await request(app).get('/api/dispatch/availability').query({ from: FUTURE_DAY, to: FUTURE_DAY });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/New_York');
  });

  it('defaults durationMin to 60 when omitted', async () => {
    const { app } = makeApp({ timezone: 'UTC' });
    const res = await request(app).get('/api/dispatch/availability').query({ from: FUTURE_DAY, to: FUTURE_DAY });
    expect(res.status).toBe(200);
    expect(res.body.durationMin).toBe(60);
  });

  it('400s on a non-YYYY-MM-DD from', async () => {
    const { app } = makeApp({ timezone: 'UTC' });
    const res = await request(app).get('/api/dispatch/availability').query({ from: 'nope', to: FUTURE_DAY });
    expect(res.status).toBe(400);
  });

  it('400s on an out-of-range durationMin', async () => {
    const { app } = makeApp({ timezone: 'UTC' });
    const res = await request(app)
      .get('/api/dispatch/availability')
      .query({ from: FUTURE_DAY, to: FUTURE_DAY, durationMin: 5 });
    expect(res.status).toBe(400);
  });

  it('scopes to one technician calendar when technicianId is supplied', async () => {
    // The finder consults the assignment repo only when a tech is named.
    const { app, findByAppointment } = makeApp({
      timezone: 'UTC',
      findByDateRange: async () => [
        {
          id: 'a-1',
          scheduledStart: new Date(`${FUTURE_DAY}T15:00:00Z`),
          scheduledEnd: new Date(`${FUTURE_DAY}T16:00:00Z`),
          status: 'scheduled',
        } as any,
      ],
      findByAppointment: async () => [{ technicianId: '11111111-1111-1111-1111-111111111111' }],
    });
    const res = await request(app).get('/api/dispatch/availability').query({
      from: FUTURE_DAY,
      to: FUTURE_DAY,
      technicianId: '11111111-1111-1111-1111-111111111111',
    });
    expect(res.status).toBe(200);
    expect(findByAppointment).toHaveBeenCalled();
  });

  // V18 — a cold tenant must be able to SEE that defaults are in play, not
  // silently receive windows it never configured.
  it('flags default config sources and explains them for a cold tenant', async () => {
    const { app } = makeApp({ settings: null });
    const res = await request(app)
      .get('/api/dispatch/availability')
      .query({ from: FUTURE_DAY, to: FUTURE_DAY });
    expect(res.status).toBe(200);
    expect(res.body.config.timezoneSource).toBe('default');
    expect(res.body.config.businessHoursSource).toBe('default');
    expect(res.body.config.bufferSource).toBe('default');
    expect(res.body.config.notes.length).toBeGreaterThanOrEqual(3);
    expect(res.body.config.notes.join(' ')).toMatch(/not configured/i);
  });

  // V17 — the tenant's configured hours and buffer must be marked as the
  // source once set (the propagation itself is pinned in the unit and
  // integration suites; this pins the route-level provenance report).
  it('reports tenant config sources when settings carry hours and buffer', async () => {
    const { app } = makeApp({
      settings: {
        timezone: 'America/New_York',
        businessHours: { mon: { open: '09:00', close: '15:00' } },
        jobBufferMinutes: 45,
      },
    });
    const res = await request(app)
      .get('/api/dispatch/availability')
      .query({ from: FUTURE_DAY, to: FUTURE_DAY });
    expect(res.status).toBe(200);
    expect(res.body.config.timezoneSource).toBe('tenant');
    expect(res.body.config.businessHoursSource).toBe('tenant');
    expect(res.body.config.bufferSource).toBe('tenant');
    expect(res.body.config.bufferMinutes).toBe(45);
  });
});
