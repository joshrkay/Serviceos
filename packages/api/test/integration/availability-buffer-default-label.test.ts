/**
 * #1158 — 3.3 "hours, buffer and timezone are each labelled as defaults":
 * the BUFFER half, for a REAL onboarded tenant.
 *
 * `tenant_settings.job_buffer_minutes` was `INT NOT NULL DEFAULT 30`
 * (migration 098) and every signup writes a settings row
 * (`bootstrapTenant` → `ensureTenantSettings`), so a tenant that never chose
 * a buffer read back a stored 30 and `findBookableSlotsDetailed` labelled it
 * `bufferSource: 'tenant'` — the owner was told they configured a 30-minute
 * buffer they never set. Only a hand-built tenant with no settings row at all
 * (dispatch-availability-stale-defaults.integration.test.ts) ever saw
 * 'default'.
 *
 * Drives, at real Postgres and through the real routes:
 *   1. signup bootstrap (`bootstrapTenant` with PgTenantRepository +
 *      PgSettingsRepository — what the Clerk `user.created` webhook calls);
 *   2. GET /api/dispatch/availability (`createSchedulingRouter`);
 *   3. PUT /api/onboarding/identity (`createOnboardingRouter`) with a buffer.
 *
 * Slot generation must be unchanged: the unset buffer still applies the
 * 30-minute default, so the slots before the identity write (buffer NULL,
 * labelled 'default') equal the slots after it (buffer 30, labelled
 * 'tenant').
 *
 * T2 — tenant B, a neighbour onboarded the same way with a DIVERGENT buffer
 * (0) and the same busy visit, gets its own 'tenant' label and its own
 * (different) slots; tenant A's writes never touch B and vice versa.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { bootstrapTenant } from '../../src/auth/clerk';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { createSchedulingRouter } from '../../src/scheduling/routes';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';

/** Far-future Monday so default business hours (08:00–17:00) are open and never in the past. */
const DAY = '2099-06-15';
// The tenant has no timezone yet, so the route falls back to America/New_York
// (EDT in June, UTC-4). The busy visit is 09:00–10:00 local.
const BUSY_START = `${DAY}T13:00:00.000Z`;
const BUSY_END = `${DAY}T14:00:00.000Z`;

describe('Postgres integration — an onboarded tenant that never set a buffer is told the buffer is a DEFAULT (#1158)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let appointmentRepo: PgAppointmentRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function makeApp(tenantId: string, userId: string): Express {
    const deps: FeasibilityDependencies = {
      appointmentRepo,
      assignmentRepo: new PgAssignmentRepository(pool),
      jobRepo: {} as any,
      locationRepo: {} as any,
      workingHoursRepo: { findByTechnician: async () => [] } as any,
      unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
      travelTimeProvider: {} as any,
      skillMatcher: {} as any,
    };
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId, sessionId: 'sess-1158', tenantId, role: 'owner' };
      next();
    });
    app.use('/api/dispatch', createSchedulingRouter(deps, { findById: async () => null } as any, settingsRepo));
    app.use(
      '/api/onboarding',
      createOnboardingRouter({
        settingsRepo,
        packActivationRepo: new PgPackActivationRepository(pool),
        auditRepo: new PgAuditRepository(pool),
        pool,
      }),
    );
    return app;
  }

  /** Real signup bootstrap — the tenant row + its seeded tenant_settings row. */
  async function signUp(label: string) {
    const userId = `user_1158_${label}_${crypto.randomUUID().replace(/-/g, '')}`;
    const boot = await bootstrapTenant(userId, `${label}-${Date.now()}@example.com`, new PgTenantRepository(pool), {
      settingsRepository: settingsRepo,
    });
    expect(boot.created).toBe(true);
    return { tenantId: boot.tenantId, userId, app: makeApp(boot.tenantId, userId) };
  }

  async function seedBusyVisit(tenantId: string, userId: string) {
    const customerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId,
      firstName: 'Buffer',
      lastName: 'Visit',
      displayName: 'Buffer Visit',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-1158-${jobId.slice(0, 6)}`,
      summary: 'Buffer adjacency visit',
      status: 'scheduled',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId,
      jobId,
      scheduledStart: new Date(BUSY_START),
      scheduledEnd: new Date(BUSY_END),
      timezone: 'America/New_York',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Parameters<typeof appointmentRepo.create>[0]);
  }

  async function availability(app: Express) {
    const res = await request(app).get('/api/dispatch/availability').query({ from: DAY, to: DAY });
    expect(res.status).toBe(200);
    return {
      bufferSource: res.body.config.bufferSource as string,
      bufferMinutes: res.body.config.bufferMinutes as number,
      bufferNote: (res.body.config.notes as string[]).some((n) => /Travel buffer not configured/.test(n)),
      slots: (res.body.slots as Array<{ start: string }>).map((s) => s.start),
    };
  }

  async function storedBuffer(tenantId: string): Promise<number | null> {
    const { rows } = await pool.query('SELECT job_buffer_minutes FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
    expect(rows).toHaveLength(1);
    return rows[0].job_buffer_minutes;
  }

  function identityWithBuffer(jobBufferMinutes: number) {
    // businessHours {} and no timezone keep hours/zone at their defaults, so
    // the ONLY thing this write changes for slot generation is the buffer.
    return {
      businessName: 'Buffer Label HVAC',
      businessHours: {},
      jobBufferMinutes,
      hourlyRateCents: 12500,
    };
  }

  it('fresh signup → buffer labelled default (30 min effective); PUT identity with a buffer → labelled tenant; slots unchanged; T2', async () => {
    const a = await signUp('a');
    const b = await signUp('b');
    await seedBusyVisit(a.tenantId, a.userId);
    await seedBusyVisit(b.tenantId, b.userId);

    // ── Tenant A never set a buffer. ────────────────────────────────────────
    const beforeA = await availability(a.app);
    expect({
      bufferSource: beforeA.bufferSource,
      bufferMinutes: beforeA.bufferMinutes,
      bufferNote: beforeA.bufferNote,
      storedBuffer: await storedBuffer(a.tenantId),
    }).toEqual({ bufferSource: 'default', bufferMinutes: 30, bufferNote: true, storedBuffer: null });
    // The 30-minute default is in force: no slot abuts the 09:00–10:00 visit.
    expect(beforeA.slots).not.toContain(`${DAY}T12:00:00.000Z`); // 08:00–09:00 local, 0-min gap
    expect(beforeA.slots).not.toContain(`${DAY}T14:00:00.000Z`); // 10:00 local, 0-min gap
    expect(beforeA.slots[0]).toBe(`${DAY}T14:30:00.000Z`); // first slot clears the visit by 30 min

    // ── Tenant B (neighbour) explicitly chooses a divergent 0-minute buffer. ─
    const putB = await request(b.app).put('/api/onboarding/identity').send(identityWithBuffer(0));
    expect(putB.status).toBe(200);

    // ── Tenant A now sets a buffer through the real identity route. ────────
    const putA = await request(a.app).put('/api/onboarding/identity').send(identityWithBuffer(30));
    expect(putA.status).toBe(200);

    const afterA = await availability(a.app);
    expect({
      bufferSource: afterA.bufferSource,
      bufferMinutes: afterA.bufferMinutes,
      bufferNote: afterA.bufferNote,
      storedBuffer: await storedBuffer(a.tenantId),
    }).toEqual({ bufferSource: 'tenant', bufferMinutes: 30, bufferNote: false, storedBuffer: 30 });
    // Slot generation unchanged by the labelling fix: default-30 === explicit-30.
    expect(afterA.slots).toEqual(beforeA.slots);

    // ── T2 — B sees ITS OWN configured buffer and its own slots. ───────────
    const afterB = await availability(b.app);
    expect({
      bufferSource: afterB.bufferSource,
      bufferMinutes: afterB.bufferMinutes,
      storedBuffer: await storedBuffer(b.tenantId),
    }).toEqual({ bufferSource: 'tenant', bufferMinutes: 0, storedBuffer: 0 });
    expect(afterB.slots).toContain(`${DAY}T12:00:00.000Z`); // back-to-back allowed at 0 min
    expect(afterB.slots).not.toEqual(afterA.slots);
    // A's identity write never touched B's row, and B's never touched A's.
    expect(await storedBuffer(a.tenantId)).toBe(30);
    expect(await storedBuffer(b.tenantId)).toBe(0);
  });
});
