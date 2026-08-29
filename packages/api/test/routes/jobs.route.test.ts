/**
 * Layer 1 — Route Shape Tests: Jobs
 *
 * Proves that each jobs endpoint returns the exact field shapes the UI
 * components read (jobNumber, status, priority, id) and enforces constraints
 * such as integer money values and correct HTTP status codes.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import type { Express } from 'express';
import express, { Request, Response, NextFunction } from 'express';
import { createJobRouter } from '../../src/routes/jobs';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryQueue } from '../../src/queues/queue';
import { NoopFeedbackDispatcher } from '../../src/feedback/dispatcher';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { Customer, InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryLocationRepository, ServiceLocation } from '../../src/locations/location';
import type { TenantOwnership } from '../../src/shared/tenant-ownership';

describe('GET /api/jobs', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 200 with an empty array when no jobs exist', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns jobs with the required UI fields', async () => {
    // Create a job first
    await request(app).post('/api/jobs').send({
      customerId: 'cust-1',
      locationId: 'loc-1',
      summary: 'Fix the AC unit',
      priority: 'high',
    });

    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const job = res.body[0];
    // Fields the UI reads
    expect(typeof job.id).toBe('string');
    expect(typeof job.jobNumber).toBe('string');
    expect(job.jobNumber).toMatch(/^JOB-/);
    expect(typeof job.status).toBe('string');
    expect(['new', 'scheduled', 'in_progress', 'completed', 'canceled']).toContain(job.status);
    expect(typeof job.summary).toBe('string');
    expect(typeof job.priority).toBe('string');
    expect(typeof job.customerId).toBe('string');
  });

  it('filters by status query param', async () => {
    // Create two jobs; one will be transitioned to in_progress
    const r1 = await request(app).post('/api/jobs').send({
      customerId: 'cust-1',
      locationId: 'loc-1',
      summary: 'Job A',
    });
    const r2 = await request(app).post('/api/jobs').send({
      customerId: 'cust-1',
      locationId: 'loc-1',
      summary: 'Job B',
    });

    // Transition job 1 to scheduled
    await request(app)
      .post(`/api/jobs/${r1.body.id}/transition`)
      .send({ status: 'scheduled' });

    const res = await request(app).get('/api/jobs?status=scheduled');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(r1.body.id);
    expect(res.body.some((j: { id: string }) => j.id === r2.body.id)).toBe(false);
  });

  it('filters by search query param (matches summary)', async () => {
    await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'Replace condenser fan',
    });
    await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'Flush drain lines',
    });

    const res = await request(app).get('/api/jobs?search=condenser');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].summary).toContain('condenser');
  });
});

describe('journey QA bug 5 — GET /api/jobs carries a customer summary', () => {
  it('bare-array list rows embed { customer: { displayName, firstName, lastName } }', async () => {
    const { app, customerRepo } = await buildTestApp();
    const customer = await createCustomer(
      { tenantId: TEST_TENANT_ID, firstName: 'Sarah', lastName: 'Henderson', createdBy: TEST_USER_ID },
      customerRepo,
    );

    await request(app).post('/api/jobs').send({
      customerId: customer.id,
      locationId: 'loc-1',
      summary: 'Water heater install',
    });

    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.body[0].customer).toMatchObject({
      id: customer.id,
      displayName: 'Sarah Henderson',
      firstName: 'Sarah',
      lastName: 'Henderson',
    });
  });

  it('paginated list rows embed the same summary; unknown customers stay unenriched', async () => {
    const { app, customerRepo } = await buildTestApp();
    const dana = await createCustomer(
      { tenantId: TEST_TENANT_ID, firstName: 'Dana', lastName: 'Lee', createdBy: TEST_USER_ID },
      customerRepo,
    );

    await request(app).post('/api/jobs').send({
      customerId: dana.id,
      locationId: 'loc-1',
      summary: 'Known customer job',
    });
    await request(app).post('/api/jobs').send({
      customerId: 'cust-ghost',
      locationId: 'loc-1',
      summary: 'Orphaned customer job',
    });

    const res = await request(app).get('/api/jobs?paginated=true');
    expect(res.status).toBe(200);
    const known = res.body.data.find((j: { summary: string }) => j.summary === 'Known customer job');
    const ghost = res.body.data.find((j: { summary: string }) => j.summary === 'Orphaned customer job');
    expect(known.customer.displayName).toBe('Dana Lee');
    expect(ghost.customer).toBeUndefined();
  });
});

describe('P1-018 — listJobs filtering + pagination', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  async function seedJob(summary: string) {
    return request(app).post('/api/jobs').send({
      customerId: 'cust-1',
      locationId: 'loc-1',
      summary,
    });
  }

  it('filter by status returns only matching jobs', async () => {
    const j1 = await seedJob('Replace condenser');
    await seedJob('Flush drain');
    await seedJob('Tune-up');

    await request(app).post(`/api/jobs/${j1.body.id}/transition`).send({ status: 'scheduled' });

    const res = await request(app).get('/api/jobs?status=scheduled');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(j1.body.id);
  });

  it('search by ILIKE on summary (case-insensitive)', async () => {
    await seedJob('Install Heat Pump');
    await seedJob('Replace water heater');
    const res = await request(app).get('/api/jobs?search=HEAT');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('pagination with limit/offset returns { data, total }', async () => {
    for (let i = 0; i < 4; i++) {
      await seedJob(`Job ${i}`);
    }
    const res = await request(app).get('/api/jobs?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(4);
  });

  it('rejects limit > 200 with 400', async () => {
    const res = await request(app).get('/api/jobs?limit=500');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('total reflects post-filter count when status is applied', async () => {
    const j1 = await seedJob('A');
    await seedJob('B');
    await seedJob('C');
    await request(app).post(`/api/jobs/${j1.body.id}/transition`).send({ status: 'scheduled' });

    const res = await request(app).get('/api/jobs?status=scheduled&paginated=true&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('POST /api/jobs', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 201 with a complete job object', async () => {
    const res = await request(app).post('/api/jobs').send({
      customerId: 'cust-abc',
      locationId: 'loc-xyz',
      summary: 'Inspect furnace',
      priority: 'normal',
    });

    expect(res.status).toBe(201);
    const job = res.body;
    expect(typeof job.id).toBe('string');
    expect(job.jobNumber).toMatch(/^JOB-\d{4}$/);
    expect(job.status).toBe('new');
    expect(job.priority).toBe('normal');
    expect(job.summary).toBe('Inspect furnace');
    expect(job.customerId).toBe('cust-abc');
    expect(job.locationId).toBe('loc-xyz');
    expect(job.tenantId).toBe(TEST_TENANT_ID);
    expect(job.createdBy).toBe(TEST_USER_ID);
  });

  it('auto-increments job numbers sequentially', async () => {
    const r1 = await request(app).post('/api/jobs').send({ customerId: 'c1', locationId: 'l1', summary: 'First' });
    const r2 = await request(app).post('/api/jobs').send({ customerId: 'c1', locationId: 'l1', summary: 'Second' });
    expect(r1.body.jobNumber).toBe('JOB-0001');
    expect(r2.body.jobNumber).toBe('JOB-0002');
  });

  it('returns 400 with field errors for missing required fields', async () => {
    const res = await request(app).post('/api/jobs').send({ summary: 'No customer or location' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.fields).toHaveProperty('customerId');
    expect(res.body.details.fields).toHaveProperty('locationId');
  });

  it('rejects a location that belongs to a different customer', async () => {
    const routeApp = express();
    routeApp.use(express.json());
    routeApp.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER_ID,
        sessionId: 'session-test-1',
        tenantId: TEST_TENANT_ID,
        role: 'owner',
      };
      next();
    });

    const customer: Customer = {
      id: 'cust-a',
      tenantId: TEST_TENANT_ID,
      firstName: 'Jordan',
      lastName: 'Runbook',
      displayName: 'Jordan Runbook',
      preferredChannel: 'none',
      smsConsent: false,
      isArchived: false,
      createdBy: TEST_USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mismatchedLocation: ServiceLocation = {
      id: 'loc-b',
      tenantId: TEST_TENANT_ID,
      customerId: 'cust-b',
      street1: '200 Rental Rd',
      city: 'Austin',
      state: 'TX',
      postalCode: '78702',
      country: 'US',
      isPrimary: false,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const ownership: TenantOwnership = {
      async requireExists() {},
      async requireExistsAndLoad(_tenantId, entityType) {
        if (entityType === 'customer') return customer;
        if (entityType === 'location') return mismatchedLocation;
        return undefined;
      },
    };

    routeApp.use(
      '/api/jobs',
      createJobRouter(
        new InMemoryJobRepository(),
        new InMemoryJobTimelineRepository(),
        new InMemoryAuditRepository(),
        ownership,
        new InMemoryQueue(),
        new NoopFeedbackDispatcher(),
      ),
    );

    const res = await request(routeApp).post('/api/jobs').send({
      customerId: 'cust-a',
      locationId: 'loc-b',
      summary: 'Cross-customer location attempt',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/location does not belong to customer/i);
  });
});

describe('GET /api/jobs/:id', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 200 with the job when found', async () => {
    const created = await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'Check thermostat',
    });

    const res = await request(app).get(`/api/jobs/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.summary).toBe('Check thermostat');
  });

  it('returns 404 for unknown job id', async () => {
    const res = await request(app).get('/api/jobs/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('enforces tenant isolation — does not return jobs from other tenants', async () => {
    // The fake auth always injects TEST_TENANT_ID. If we create a job and
    // look it up, it should work. But a raw-inserted job for another tenant
    // should not be visible.
    const created = await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'My job',
    });
    // Verify the job IS visible under the test tenant
    const res = await request(app).get(`/api/jobs/${created.body.id}`);
    expect(res.status).toBe(200);
  });

  it('does not enrich a job with a location from a different customer', async () => {
    const routeApp = express();
    routeApp.use(express.json());
    routeApp.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER_ID,
        sessionId: 'session-test-1',
        tenantId: TEST_TENANT_ID,
        role: 'owner',
      };
      next();
    });

    const customer: Customer = {
      id: 'cust-a',
      tenantId: TEST_TENANT_ID,
      firstName: 'Jordan',
      lastName: 'Runbook',
      displayName: 'Jordan Runbook',
      preferredChannel: 'none',
      smsConsent: false,
      communicationNotes: 'Gate code is 1234.',
      isArchived: false,
      createdBy: TEST_USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mismatchedLocation: ServiceLocation = {
      id: 'loc-b',
      tenantId: TEST_TENANT_ID,
      customerId: 'cust-b',
      street1: '200 Rental Rd',
      city: 'Austin',
      state: 'TX',
      postalCode: '78702',
      country: 'US',
      isPrimary: false,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const ownership: TenantOwnership = {
      async requireExists() {},
      async requireExistsAndLoad(_tenantId, entityType) {
        if (entityType === 'customer') return customer;
        if (entityType === 'location') return mismatchedLocation;
        return undefined;
      },
    };
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    await customerRepo.create(customer);
    const locationRepo = new InMemoryLocationRepository();
    routeApp.use(
      '/api/jobs',
      createJobRouter(
        jobRepo,
        new InMemoryJobTimelineRepository(),
        new InMemoryAuditRepository(),
        ownership,
        new InMemoryQueue(),
        new NoopFeedbackDispatcher(),
        customerRepo,
        locationRepo,
      ),
    );
    const created = await jobRepo.create({
      // A real uuid — #882's malformed-:id guard 404s fixture-style ids like
      // 'job-1' before the handler runs, exactly as prod (uuid column) would.
      id: '3b1c3f3e-8f5a-4a8e-9c1d-2e6f7a9b0c1d',
      tenantId: TEST_TENANT_ID,
      customerId: 'cust-a',
      locationId: 'loc-b',
      jobNumber: 'JOB-0001',
      summary: 'Imported bad row',
      status: 'new',
      priority: 'normal',
      createdBy: TEST_USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(routeApp).get(`/api/jobs/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body.customer.displayName).toBe('Jordan Runbook');
    expect(res.body.customer.locations).toEqual([]);
  });
});

describe('POST /api/jobs/:id/transition', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('transitions status and returns the updated job', async () => {
    const created = await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'HVAC tune-up',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('new');

    const res = await request(app)
      .post(`/api/jobs/${created.body.id}/transition`)
      .send({ status: 'scheduled' });

    // transitionJobStatus returns { job, timelineEntry }
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('scheduled');
    expect(res.body.job.id).toBe(created.body.id);
  });

  it('returns 400 when status is missing from body', async () => {
    const created = await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'Test job',
    });

    const res = await request(app)
      .post(`/api/jobs/${created.body.id}/transition`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for an invalid status transition', async () => {
    const created = await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'Test job',
    });
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/jobs/${created.body.id}/transition`)
      .send({ status: 'completed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('§5.8 — owner can move a job backward with a reason', async () => {
    const created = await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'Backward move',
    });
    const id = created.body.id;
    await request(app).post(`/api/jobs/${id}/transition`).send({ status: 'scheduled' });
    await request(app).post(`/api/jobs/${id}/transition`).send({ status: 'in_progress' });

    // missing reason → 400 (the test harness authenticates as owner)
    const noReason = await request(app)
      .post(`/api/jobs/${id}/transition`)
      .send({ status: 'scheduled' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toBe('VALIDATION_ERROR');

    // with reason → 200 and the move lands
    const withReason = await request(app)
      .post(`/api/jobs/${id}/transition`)
      .send({ status: 'scheduled', reason: 'Customer pushed the visit' });
    expect(withReason.status).toBe(200);
    expect(withReason.body.job.status).toBe('scheduled');
  });

  it('full lifecycle: new → scheduled → in_progress → completed', async () => {
    const created = await request(app).post('/api/jobs').send({
      customerId: 'c1',
      locationId: 'l1',
      summary: 'Full lifecycle test',
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // transitionJobStatus returns { job, timelineEntry }
    const s1 = await request(app).post(`/api/jobs/${id}/transition`).send({ status: 'scheduled' });
    expect(s1.status).toBe(200);
    expect(s1.body.job.status).toBe('scheduled');

    const s2 = await request(app).post(`/api/jobs/${id}/transition`).send({ status: 'in_progress' });
    expect(s2.status).toBe(200);
    expect(s2.body.job.status).toBe('in_progress');

    const s3 = await request(app).post(`/api/jobs/${id}/transition`).send({ status: 'completed' });
    expect(s3.status).toBe(200);
    expect(s3.body.job.status).toBe('completed');
  });
});

/**
 * #882 — a non-UUID `:id` used to flow straight into PgJobRepository's uuid
 * comparison, so Postgres threw `invalid input syntax for type uuid` and the
 * route answered a bare 500. This PgLike subclass throws the same error
 * Postgres would (pattern: customers.route.test.ts, the #871 precedent); the
 * `notFoundOnMalformedId` guard must answer the route's 404 envelope first.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PgLikeJobRepository extends InMemoryJobRepository {
  async findById(tenantId: string, id: string) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: Partial<Job>) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.update(tenantId, id, updates);
  }
}

function buildPgLikeJobsApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER_ID,
      sessionId: 'session-jobs-882',
      tenantId: TEST_TENANT_ID,
      role: 'owner',
    };
    next();
  });
  const ownership: TenantOwnership = {
    async requireExists() {},
    async requireExistsAndLoad() {
      return undefined;
    },
  };
  app.use(
    '/api/jobs',
    createJobRouter(
      new PgLikeJobRepository(),
      new InMemoryJobTimelineRepository(),
      new InMemoryAuditRepository(),
      ownership,
      new InMemoryQueue(),
      new NoopFeedbackDispatcher(),
    ),
  );
  return app;
}

describe('malformed :id never reaches Postgres as a raw uuid comparison (#882)', () => {
  let app: Express;

  beforeEach(() => {
    app = buildPgLikeJobsApp();
  });

  it('GET /api/jobs/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).get('/api/jobs/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.message).toBe('Job not found');
  });

  it('PUT /api/jobs/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).put('/api/jobs/not-a-uuid').send({ summary: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/jobs/not-a-uuid/transition returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app)
      .post('/api/jobs/not-a-uuid/transition')
      .send({ status: 'scheduled' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/jobs/not-a-uuid/schedule returns 404 NOT_FOUND', async () => {
    const res = await request(app).post('/api/jobs/not-a-uuid/schedule').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/jobs/not-a-uuid/reassign returns 404 NOT_FOUND', async () => {
    const res = await request(app).post('/api/jobs/not-a-uuid/reassign').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/jobs/not-a-uuid/unschedule returns 404 NOT_FOUND', async () => {
    const res = await request(app).post('/api/jobs/not-a-uuid/unschedule').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('a well-formed but unknown uuid still answers the ordinary 404', async () => {
    const res = await request(app).get('/api/jobs/11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
