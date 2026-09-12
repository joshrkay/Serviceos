/**
 * Postgres integration — 3.3 "told when the offered times are just defaults."
 *
 * `availability-route.test.ts` already pins the config-provenance response
 * shape (V18/V17) against fully mocked deps (`vi.fn()` stubs for
 * appointmentRepo/assignmentRepo, an inline settingsRepo object) — no real
 * pool, no real tenant_settings row. This file drives the SAME
 * `createSchedulingRouter` GET /availability route through supertest against
 * REAL Postgres repositories (PgAppointmentRepository, PgAssignmentRepository,
 * PgSettingsRepository), so "no settings row" and "a settings row with hours
 * configured" are genuine database states, not stubbed return values.
 *
 * This route is explicitly read-only ("Read-only — no audit event", routes.ts
 * comment above the handler) — there is no mutation here for an audit event
 * to attach to, so this row's real-Postgres proof is the config-provenance
 * disclosure itself plus tenant isolation (T1), not an audit read-back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createSchedulingRouter } from '../../src/scheduling/routes';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';

function fakeAuth(tenantId: string) {
  return (req: any, _res: any, next: any) => {
    req.auth = { tenantId, userId: 'u-1', role: 'dispatcher' };
    next();
  };
}

/** Far-future so business-hours slots are unambiguously in the future. */
const FUTURE_DAY = '2099-06-15';

describe('Postgres integration — dispatch availability discloses DEFAULT config sources (3.3)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function makeApp(tenantId: string): Express {
    const deps: FeasibilityDependencies = {
      appointmentRepo,
      assignmentRepo,
      jobRepo: {} as any,
      locationRepo: {} as any,
      workingHoursRepo: { findByTechnician: async () => [] } as any,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: {} as any,
      skillMatcher: {} as any,
    };
    const userRepo = { findById: async () => null } as any;
    const app = express();
    app.use(express.json());
    app.use(fakeAuth(tenantId));
    app.use('/api/dispatch', createSchedulingRouter(deps, userRepo, settingsRepo));
    return app;
  }

  it('a COLD tenant — a REAL tenant with no tenant_settings row at all — is told its offered times are DEFAULTS', async () => {
    const { tenantId } = await createTestTenant(pool);
    // No tenant_settings row is inserted — the real absence, not a stubbed null.

    const res = await request(makeApp(tenantId))
      .get('/api/dispatch/availability')
      .query({ from: FUTURE_DAY, to: FUTURE_DAY });

    expect(res.status).toBe(200);
    expect(res.body.config.timezoneSource).toBe('default');
    expect(res.body.config.businessHoursSource).toBe('default');
    expect(res.body.config.bufferSource).toBe('default');
    expect(res.body.config.notes.length).toBeGreaterThanOrEqual(3);
    expect(res.body.config.notes.join(' ')).toMatch(/not configured/i);
  });

  it('T1 — a tenant with its OWN configured hours is told the times are ITS OWN, and a neighbour cold tenant sees its own defaults, not the configured tenant\'s', async () => {
    const configured = await createTestTenant(pool);
    await ensureTenantSettings(configured.tenantId, settingsRepo);
    await settingsRepo.update(configured.tenantId, {
      timezone: 'America/Chicago',
      businessHours: { mon: { open: '09:00', close: '15:00' } },
      jobBufferMinutes: 45,
    });

    const cold = await createTestTenant(pool);

    const configuredRes = await request(makeApp(configured.tenantId))
      .get('/api/dispatch/availability')
      .query({ from: FUTURE_DAY, to: FUTURE_DAY });
    expect(configuredRes.status).toBe(200);
    expect(configuredRes.body.config.timezoneSource).toBe('tenant');
    expect(configuredRes.body.config.businessHoursSource).toBe('tenant');
    expect(configuredRes.body.config.bufferSource).toBe('tenant');
    expect(configuredRes.body.config.bufferMinutes).toBe(45);
    expect(configuredRes.body.timezone).toBe('America/Chicago');

    // cross-tenant isolation: the neighbour cold tenant (another tenant) is a
    // SEPARATE real tenant, queried in the SAME run — its response must show
    // ITS OWN defaults, not leak the configured tenant's timezone/hours/buffer.
    const coldRes = await request(makeApp(cold.tenantId))
      .get('/api/dispatch/availability')
      .query({ from: FUTURE_DAY, to: FUTURE_DAY });
    expect(coldRes.status).toBe(200);
    expect(coldRes.body.config.timezoneSource).toBe('default');
    expect(coldRes.body.config.businessHoursSource).toBe('default');
    expect(coldRes.body.config.bufferSource).toBe('default');
    expect(coldRes.body.timezone).not.toBe(configuredRes.body.timezone);
  });
});
