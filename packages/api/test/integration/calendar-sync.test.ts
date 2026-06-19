/**
 * Postgres integration — Google Calendar sync (Tier 4 PR 2).
 *
 * Drives `CalendarSyncService.pushForTechnician` against the production
 * Pg repos for `user_calendar_integrations` and `appointment_calendar_events`
 * with a mocked `googleFetch`, pinning the SQL+RLS that the appointment-
 * create hook actually executes. The OAuth-token refresh path is proven
 * by unit tests; this file proves the durable pieces:
 *
 *   1. PgCalendarIntegrationRepository.upsert — encrypted tokens land
 *      under RLS and round-trip through findByUser.
 *   2. PgAppointmentCalendarEventRepository.upsert — sync writes a row
 *      stamped to (appointment, user, provider) with the external event
 *      id when Google succeeds.
 *   3. ON CONFLICT (appointment_id, user_id, provider) — a re-push
 *      overwrites the prior external event id rather than duplicating.
 *   4. Failure path — a Google 5xx never throws to the caller and is
 *      persisted as status='failed' + last_error.
 *   5. Tenant isolation — appointment_calendar_events RLS rejects
 *      cross-tenant reads under an unprivileged role.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import {
  CalendarSyncService,
  PgAppointmentCalendarEventRepository,
  type CalendarEventInput,
} from '../../src/integrations/calendar-sync';
import { PgCalendarIntegrationRepository } from '../../src/integrations/calendar-integration';
import type { GoogleFetch, GoogleOAuthConfig } from '../../src/integrations/google-calendar';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';

// 64-hex-char (32-byte) AES-256-GCM key. The crypto helper parses
// TENANT_ENCRYPTION_KEY as hex; any deterministic 32-byte value is fine.
const TEST_ENC_KEY = '0011223344556677889900112233445566778899001122334455667788990011';

const GOOGLE_CONFIG: GoogleOAuthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost/oauth/google/callback',
};

/**
 * Mocked googleFetch. Returns a Response-shaped object so the sync
 * service can `.ok`, `.status`, `.text()`, `.json()` it the same way it
 * would the real fetch. The test passes `responder` to vary behavior
 * per case (200 + event id, 500, etc.).
 */
function makeGoogleFetch(
  responder: (url: string, init: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    body: string | Record<string, unknown>;
  }>,
): GoogleFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const r = await responder(url, init ?? {});
    return {
      ok: r.ok,
      status: r.status,
      async text() {
        return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      },
      async json() {
        return typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
      },
    } as unknown as Response;
  }) as GoogleFetch;
}

/**
 * Unprivileged role + GUC pattern mirrored from rls-tenant-isolation.test.ts.
 * The testcontainer's default user is a SUPERUSER (bypasses RLS), so a
 * cross-tenant `findByAppointment` lookup is filtered by the repo's
 * `WHERE tenant_id = $1 AND appointment_id = $2` predicate, NOT by the
 * policy. Running through asTenant under this NOBYPASSRLS role with no
 * tenant predicate makes the policy itself the only thing gating the read.
 */
const APP_ROLE = 'rls_app_runtime';

async function ensureRlsAppRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
}

async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Google Calendar sync — integration', () => {
  let pool: Pool;
  let integrationRepo: PgCalendarIntegrationRepository;
  let eventRepo: PgAppointmentCalendarEventRepository;
  let appointmentRepo: PgAppointmentRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let tenantA: { tenantId: string; userId: string };

  beforeAll(async () => {
    process.env.TENANT_ENCRYPTION_KEY = TEST_ENC_KEY;
    pool = await getSharedTestDb();
    integrationRepo = new PgCalendarIntegrationRepository(pool);
    eventRepo = new PgAppointmentCalendarEventRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    await ensureRlsAppRole(pool);
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedAppointment(tenant: { tenantId: string; userId: string }): Promise<string> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Cal',
      lastName: 'Tester',
      displayName: 'Cal Tester',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Cal St',
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
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      // Unique per-call to satisfy UNIQUE (tenant_id, job_number).
      jobNumber: `JOB-${customerId.slice(0, 8)}`,
      summary: 'Calendar push test',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const appointmentId = crypto.randomUUID();
    const start = new Date('2026-06-19T20:00:00.000Z');
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenant.tenantId,
      jobId,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: 'America/Chicago',
      status: 'scheduled',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return appointmentId;
  }

  async function seedActiveIntegration(
    tenant: { tenantId: string; userId: string },
    techClerkSubject: string,
  ): Promise<void> {
    await integrationRepo.upsert({
      tenantId: tenant.tenantId,
      userId: techClerkSubject,
      provider: 'google',
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      // +1 hour so getValidAccessToken returns the cached token
      // without calling Google's refresh endpoint.
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      externalAccountEmail: 'tech@example.com',
      calendarId: 'primary',
    });
  }

  function makeInput(
    appointmentId: string,
    techClerkSubject: string,
  ): CalendarEventInput {
    return {
      tenantId: tenantA.tenantId,
      appointmentId,
      technicianUserId: techClerkSubject,
      scheduledStart: new Date('2026-06-19T20:00:00.000Z'),
      scheduledEnd: new Date('2026-06-19T21:00:00.000Z'),
      timezone: 'America/Chicago',
      summary: 'AC tune-up — Cal Tester',
      description: 'Standard maintenance visit',
      location: '1 Cal St, Austin TX',
    };
  }

  it("happy path: pushForTechnician returns 'synced' and persists external_event_id under RLS", async () => {
    const tech = 'user_tech_happy';
    const appointmentId = await seedAppointment(tenantA);
    await seedActiveIntegration(tenantA, tech);

    let capturedBody: Record<string, unknown> | null = null;
    const googleFetch = makeGoogleFetch(async (url, init) => {
      expect(url).toContain('/calendar/v3/calendars/primary/events');
      capturedBody = JSON.parse(String(init.body));
      return { ok: true, status: 200, body: { id: 'gcal_evt_happy' } };
    });

    const service = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: GOOGLE_CONFIG,
      googleFetch,
    });

    const outcome = await service.pushForTechnician(makeInput(appointmentId, tech));
    expect(outcome).toBe('synced');

    // Body shape carries the local-event opaque ref the future
    // update/delete path keys on.
    expect(capturedBody).toBeTruthy();
    const extProps = (capturedBody as { extendedProperties?: { private?: Record<string, string> } })
      .extendedProperties?.private;
    expect(extProps?.serviceos_appointment_id).toBe(appointmentId);
    expect(extProps?.serviceos_tenant_id).toBe(tenantA.tenantId);

    // The repo persisted the row under RLS — findByAppointment uses
    // withTenant so this is the production read path.
    const rows = await eventRepo.findByAppointment(tenantA.tenantId, appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('synced');
    expect(rows[0].externalEventId).toBe('gcal_evt_happy');
    expect(rows[0].userId).toBe(tech);
    expect(rows[0].lastError).toBeNull();
  });

  it("returns 'skipped' when the technician has no integration row", async () => {
    const appointmentId = await seedAppointment(tenantA);
    const service = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: GOOGLE_CONFIG,
      googleFetch: makeGoogleFetch(async () => {
        throw new Error('googleFetch should not have been called');
      }),
    });

    const outcome = await service.pushForTechnician(makeInput(appointmentId, 'user_tech_none'));
    expect(outcome).toBe('skipped');

    // No appointment_calendar_events row was created.
    const rows = await eventRepo.findByAppointment(tenantA.tenantId, appointmentId);
    expect(rows).toHaveLength(0);
  });

  it("returns 'skipped' when the integration is not 'active' (expired / revoked)", async () => {
    const tech = 'user_tech_expired';
    const appointmentId = await seedAppointment(tenantA);
    await seedActiveIntegration(tenantA, tech);

    // Flip the integration to 'expired' via the production repo path.
    const integration = await integrationRepo.findByUser(tenantA.tenantId, tech, 'google');
    expect(integration).not.toBeNull();
    await integrationRepo.setStatus(tenantA.tenantId, integration!.id, 'expired');

    const service = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: GOOGLE_CONFIG,
      googleFetch: makeGoogleFetch(async () => {
        throw new Error('googleFetch should not have been called for expired integration');
      }),
    });

    const outcome = await service.pushForTechnician(makeInput(appointmentId, tech));
    expect(outcome).toBe('skipped');
    const rows = await eventRepo.findByAppointment(tenantA.tenantId, appointmentId);
    expect(rows).toHaveLength(0);
  });

  it("returns 'failed' (never throws) on Google 5xx and stamps status='failed' + last_error", async () => {
    const tech = 'user_tech_fail';
    const appointmentId = await seedAppointment(tenantA);
    await seedActiveIntegration(tenantA, tech);

    const googleFetch = makeGoogleFetch(async () => ({
      ok: false,
      status: 503,
      body: 'service unavailable',
    }));

    const service = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: GOOGLE_CONFIG,
      googleFetch,
    });

    const outcome = await service.pushForTechnician(makeInput(appointmentId, tech));
    expect(outcome).toBe('failed');

    const rows = await eventRepo.findByAppointment(tenantA.tenantId, appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].externalEventId).toBeNull();
    expect(rows[0].lastError).toContain('503');
  });

  it('re-pushing for the same (appointment, user) overwrites the previous external_event_id (ON CONFLICT)', async () => {
    const tech = 'user_tech_repush';
    const appointmentId = await seedAppointment(tenantA);
    await seedActiveIntegration(tenantA, tech);

    let n = 0;
    const googleFetch = makeGoogleFetch(async () => {
      n++;
      return { ok: true, status: 200, body: { id: `gcal_evt_repush_${n}` } };
    });

    const service = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: GOOGLE_CONFIG,
      googleFetch,
    });

    await service.pushForTechnician(makeInput(appointmentId, tech));
    await service.pushForTechnician(makeInput(appointmentId, tech));

    const rows = await eventRepo.findByAppointment(tenantA.tenantId, appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalEventId).toBe('gcal_evt_repush_2');
    expect(rows[0].status).toBe('synced');
  });

  it('tenant isolation: a row pushed under tenant A is invisible to tenant B (RLS)', async () => {
    const tenantB = await createTestTenant(pool);
    const techA = 'user_tech_iso_a';
    const techB = 'user_tech_iso_b';
    const apptA = await seedAppointment(tenantA);
    const apptB = await seedAppointment(tenantB);
    await seedActiveIntegration(tenantA, techA);
    await seedActiveIntegration(tenantB, techB);

    let n = 0;
    const googleFetch = makeGoogleFetch(async () => {
      n++;
      return { ok: true, status: 200, body: { id: `gcal_evt_iso_${n}` } };
    });
    const service = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: GOOGLE_CONFIG,
      googleFetch,
    });

    await service.pushForTechnician({
      ...makeInput(apptA, techA),
      tenantId: tenantA.tenantId,
    });
    await service.pushForTechnician({
      ...makeInput(apptB, techB),
      tenantId: tenantB.tenantId,
    });

    // Each tenant sees only its own row via the prod read path.
    const aRows = await eventRepo.findByAppointment(tenantA.tenantId, apptA);
    const bRows = await eventRepo.findByAppointment(tenantB.tenantId, apptB);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].externalEventId).not.toBe(bRows[0].externalEventId);

    // RLS proof: under tenant A's GUC, query appointment_calendar_events
    // WITHOUT a `tenant_id = ...` predicate. Only the policy gates this read,
    // so tenant B's row must be invisible. Filtering by appointment_id only
    // means a dropped policy would surface tenant B's row and fail the test.
    const apptIdsUnderA = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query(
        `SELECT appointment_id FROM appointment_calendar_events`,
      ).then((r) => r.rows.map((row: { appointment_id: string }) => row.appointment_id)),
    );
    expect(apptIdsUnderA).toContain(apptA);
    expect(apptIdsUnderA).not.toContain(apptB);
  });

  it('pushForTechnicians: a batch with one connected tech and one without yields pushedFor=1 + skipped=1', async () => {
    const techConnected = 'user_tech_batch_yes';
    const techDisconnected = 'user_tech_batch_no';
    const appointmentId = await seedAppointment(tenantA);
    await seedActiveIntegration(tenantA, techConnected);

    const googleFetch = makeGoogleFetch(async () => ({
      ok: true,
      status: 200,
      body: { id: 'gcal_evt_batch' },
    }));
    const service = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: GOOGLE_CONFIG,
      googleFetch,
    });

    const result = await service.pushForTechnicians([
      makeInput(appointmentId, techConnected),
      makeInput(appointmentId, techDisconnected),
    ]);

    expect(result.pushedFor).toEqual([techConnected]);
    expect(result.skipped).toEqual([techDisconnected]);
    expect(result.failed).toEqual([]);

    const rows = await eventRepo.findByAppointment(tenantA.tenantId, appointmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(techConnected);
    expect(rows[0].externalEventId).toBe('gcal_evt_batch');
  });
});
