/**
 * #1402 (QA §8) — the jobs list filters a dispatcher needs, server-side and
 * combinable: status (existed), scheduled-date range, assigned technician.
 *
 * Driven through the real GET /api/jobs over real Postgres:
 *   - `scheduledFrom` (inclusive) / `scheduledTo` (exclusive) keep jobs with a
 *     live (non-canceled) appointment starting in the window — a job's
 *     schedule lives on its appointments, not the job row;
 *   - `technicianId` + date + status combine (AND);
 *   - a neighbour tenant's job in the same window never appears (T1).
 *
 * Run:
 *   cd packages/api && EXTERNAL_TEST_DB_URL=... RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts test/integration/job-list-filters-1402.test.ts
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createJobRouter } from '../../src/routes/jobs';
import { InMemoryQueue } from '../../src/queues/queue';
import { NoopFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('Postgres integration — job list filters (#1402 §8)', () => {
  let pool: Pool;
  let app: express.Express;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const job: Record<string, string> = {};
  const tech: Record<string, string> = {};

  async function makeTechnician(t: TestTenant, first: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'technician', $5, 'Tech')`,
      [id, t.tenantId, `clerk_${id}`, `tech_${id}@example.com`, first],
    );
    return id;
  }

  async function makeJob(
    t: TestTenant,
    key: string,
    opts: { status?: 'new' | 'scheduled' | 'completed'; technicianId?: string; starts?: Array<{ at: string; status?: 'scheduled' | 'canceled' }> },
  ) {
    const customerId = randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId, tenantId: t.tenantId, firstName: key, lastName: 'Filter', displayName: `${key} Filter`,
      preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: t.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId, tenantId: t.tenantId, customerId, street1: '1 Main St', city: 'Phoenix', state: 'AZ',
      postalCode: '85001', country: 'USA', isPrimary: true, isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId, tenantId: t.tenantId, customerId, locationId, jobNumber: `JOB-${key}`,
      summary: `${key} work`, status: opts.status ?? 'scheduled', priority: 'normal',
      assignedTechnicianId: opts.technicianId,
      createdBy: t.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    for (const s of opts.starts ?? []) {
      const start = new Date(s.at);
      await new PgAppointmentRepository(pool).create({
        id: randomUUID(), tenantId: t.tenantId, jobId, scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000), timezone: 'UTC',
        status: s.status ?? 'scheduled', holdPendingApproval: false,
        createdBy: t.userId, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    job[key] = jobId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    tech.maya = await makeTechnician(tenantA, 'Maya');
    tech.diego = await makeTechnician(tenantA, 'Diego');

    // Window under test: 2026-10-05 (inclusive) → 2026-10-12 (exclusive).
    await makeJob(tenantA, 'inWindowMaya', { technicianId: tech.maya, starts: [{ at: '2026-10-06T15:00:00Z' }] });
    await makeJob(tenantA, 'inWindowDiego', { technicianId: tech.diego, starts: [{ at: '2026-10-11T23:30:00Z' }] });
    await makeJob(tenantA, 'inWindowMayaDone', { status: 'completed', technicianId: tech.maya, starts: [{ at: '2026-10-07T15:00:00Z' }] });
    await makeJob(tenantA, 'boundaryEnd', { technicianId: tech.maya, starts: [{ at: '2026-10-12T00:00:00Z' }] });
    await makeJob(tenantA, 'before', { technicianId: tech.maya, starts: [{ at: '2026-10-04T23:59:00Z' }] });
    await makeJob(tenantA, 'canceledInWindow', { technicianId: tech.maya, starts: [{ at: '2026-10-08T15:00:00Z', status: 'canceled' }] });
    await makeJob(tenantA, 'unscheduled', { status: 'new' });
    await makeJob(tenantB, 'otherTenant', { starts: [{ at: '2026-10-06T15:00:00Z' }] });

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenantA.userId, sessionId: `sess_${tenantA.userId}`, tenantId: tenantA.tenantId, role: 'owner',
      };
      next();
    });
    app.use(
      '/api/jobs',
      createJobRouter(
        new PgJobRepository(pool),
        new PgJobTimelineRepository(pool),
        new PgAuditRepository(pool),
        permissiveTenantOwnership(),
        new InMemoryQueue(),
        new NoopFeedbackDispatcher(),
      ),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  const idsOf = (body: { data: Array<{ id: string }> }) => body.data.map((r) => r.id).sort();
  const WINDOW = 'scheduledFrom=2026-10-05T00:00:00.000Z&scheduledTo=2026-10-12T00:00:00.000Z';

  it('scheduledFrom/scheduledTo keep jobs with a live appointment starting in the window (to is exclusive)', async () => {
    const res = await request(app).get(`/api/jobs?paginated=true&${WINDOW}`);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([job.inWindowMaya, job.inWindowDiego, job.inWindowMayaDone].sort());
    expect(res.body.total).toBe(3);
  });

  it('technician + date window + status combine (AND)', async () => {
    const byTech = await request(app).get(`/api/jobs?paginated=true&${WINDOW}&technicianId=${tech.maya}`);
    expect(idsOf(byTech.body)).toEqual([job.inWindowMaya, job.inWindowMayaDone].sort());

    const byAll = await request(app).get(`/api/jobs?paginated=true&${WINDOW}&technicianId=${tech.maya}&status=scheduled`);
    expect(idsOf(byAll.body)).toEqual([job.inWindowMaya]);
    expect(byAll.body.total).toBe(1);
  });

  it('a non-uuid technicianId is a 400, not a database error', async () => {
    const res = await request(app).get('/api/jobs?paginated=true&technicianId=maya');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('a malformed date bound is a 400, not an unfiltered list', async () => {
    const res = await request(app).get('/api/jobs?paginated=true&scheduledFrom=next-tuesday');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
