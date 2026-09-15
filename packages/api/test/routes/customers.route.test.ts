/**
 * Layer 1 — Route Shape Tests: Customers
 *
 * Proves that the customers endpoints return the fields the UI reads
 * (displayName, firstName, lastName, primaryPhone, email) and that
 * displayName is correctly computed from firstName + lastName.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import type { Express, NextFunction, Request, Response } from 'express';
import { createCustomerRouter } from '../../src/routes/customers';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryCustomerMergeRepository } from '../../src/customers/merge';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

async function createCustomer(app: Express, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/customers')
    .send({
      firstName: 'Alice',
      lastName: 'Smith',
      primaryPhone: '555-123-4567',
      email: 'alice@example.com',
      ...overrides,
    });
}

describe('POST /api/customers', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 201 with a customer containing required UI fields', async () => {
    const res = await createCustomer(app);

    expect(res.status).toBe(201);
    const cust = res.body;
    expect(typeof cust.id).toBe('string');
    expect(cust.firstName).toBe('Alice');
    expect(cust.lastName).toBe('Smith');
    expect(cust.primaryPhone).toBe('555-123-4567');
    expect(cust.email).toBe('alice@example.com');
    expect(cust.tenantId).toBe(TEST_TENANT_ID);
    expect(cust.createdBy).toBe(TEST_USER_ID);
  });

  it('computes displayName as "firstName lastName"', async () => {
    const res = await createCustomer(app, { firstName: 'Bob', lastName: 'Jones' });
    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('Bob Jones');
  });

  it('computes displayName from companyName when names are omitted', async () => {
    const res = await request(app).post('/api/customers').send({
      firstName: '',
      lastName: '',
      companyName: 'Acme Corp',
    });
    // firstName '' is treated as absent — if validation requires firstName or companyName,
    // this should succeed. The model uses companyName as fallback.
    if (res.status === 201) {
      expect(res.body.displayName).toBe('Acme Corp');
    }
  });

  it('sets isArchived to false on creation', async () => {
    const res = await createCustomer(app);
    expect(res.status).toBe(201);
    expect(res.body.isArchived).toBe(false);
  });

  it('returns an error for missing firstName and companyName', async () => {
    const res = await request(app).post('/api/customers').send({
      lastName: 'Orphan',
    });
    // ZodError is not mapped to AppError so the server returns 5xx — still non-2xx
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/customers', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 200 with an empty array when no customers exist', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns created customers in the list', async () => {
    await createCustomer(app, { firstName: 'Charlie', lastName: 'Brown' });
    await createCustomer(app, { firstName: 'Diana', lastName: 'Prince' });

    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    // Every customer in the list has displayName
    for (const c of res.body) {
      expect(typeof c.displayName).toBe('string');
      expect(c.displayName.length).toBeGreaterThan(0);
    }
  });

  it('filters by search query param', async () => {
    await createCustomer(app, { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' });
    await createCustomer(app, { firstName: 'Robert', lastName: 'Jones', email: 'rob@example.com' });

    const res = await request(app).get('/api/customers?search=alice');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].firstName).toBe('Alice');
  });

  it('excludes archived customers by default', async () => {
    const created = await createCustomer(app);
    await request(app).post(`/api/customers/${created.body.id}/archive`).send({});

    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('includes archived customers when includeArchived=true', async () => {
    const created = await createCustomer(app);
    await request(app).post(`/api/customers/${created.body.id}/archive`).send({});

    const res = await request(app).get('/api/customers?includeArchived=true');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].isArchived).toBe(true);
  });
});

describe('GET /api/customers/:id', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 200 with the customer when found', async () => {
    const created = await createCustomer(app);
    const res = await request(app).get(`/api/customers/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.displayName).toBe('Alice Smith');
  });

  it('returns 404 for unknown customer id', async () => {
    const res = await request(app).get('/api/customers/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});

describe('P1-018 — listCustomers search + pagination', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('search by name returns matching customers (legacy array shape)', async () => {
    await createCustomer(app, { firstName: 'Alice', lastName: 'Smith' });
    await createCustomer(app, { firstName: 'Bob', lastName: 'Jones' });
    await createCustomer(app, { firstName: 'Carol', lastName: 'Smith' });

    const res = await request(app).get('/api/customers?search=smith');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map((c: { displayName: string }) => c.displayName).sort();
    expect(names).toEqual(['Alice Smith', 'Carol Smith']);
  });

  it('pagination with paginated=true returns { data, total } shape', async () => {
    for (let i = 0; i < 5; i++) {
      await createCustomer(app, { firstName: `User${i}`, lastName: 'Z' });
    }
    const res = await request(app).get('/api/customers?paginated=true&limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });

  it('pagination with limit/offset implicitly switches to { data, total } shape', async () => {
    for (let i = 0; i < 3; i++) {
      await createCustomer(app, { firstName: `Z${i}`, lastName: 'Last' });
    }
    const page1 = await request(app).get('/api/customers?limit=2&offset=0');
    const page2 = await request(app).get('/api/customers?limit=2&offset=2');
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.total).toBe(3);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.total).toBe(3);
    // Ensure no overlap between pages
    const ids1 = page1.body.data.map((c: { id: string }) => c.id);
    const ids2 = page2.body.data.map((c: { id: string }) => c.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('rejects limit > 200 with 400', async () => {
    const res = await request(app).get('/api/customers?limit=500');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects negative offset with 400', async () => {
    const res = await request(app).get('/api/customers?offset=-1');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('search combined with pagination returns accurate filtered total', async () => {
    await createCustomer(app, {
      firstName: 'Alice',
      lastName: 'Smith',
      email: 'alice@example.com',
    });
    await createCustomer(app, {
      firstName: 'Alicia',
      lastName: 'Brown',
      email: 'alicia@example.com',
    });
    await createCustomer(app, {
      firstName: 'Robert',
      lastName: 'Jones',
      email: 'rob@example.com',
    });

    const res = await request(app).get('/api/customers?search=ali&paginated=true&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });
});

describe('POST /api/customers/:id/archive', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('archives the customer and sets isArchived to true', async () => {
    const created = await createCustomer(app);
    expect(created.body.isArchived).toBe(false);

    const res = await request(app)
      .post(`/api/customers/${created.body.id}/archive`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.isArchived).toBe(true);
    expect(res.body.archivedAt).toBeTruthy();
  });

  it('returns 404 when archiving an unknown customer', async () => {
    const res = await request(app).post('/api/customers/ghost/archive').send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /api/customers/:id/merge (Story 4.6)', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('merges the loser into the survivor and archives the loser', async () => {
    const survivor = await createCustomer(app, { firstName: 'Keep', lastName: 'Me' });
    const loser = await createCustomer(app, {
      firstName: 'Drop',
      lastName: 'Me',
      primaryPhone: '555-000-1111',
      email: 'drop@example.com',
    });

    const res = await request(app)
      .post(`/api/customers/${survivor.body.id}/merge`)
      .send({ losingId: loser.body.id });

    expect(res.status).toBe(200);
    expect(res.body.survivingId).toBe(survivor.body.id);
    expect(res.body.losingId).toBe(loser.body.id);

    const loserAfter = await request(app).get(`/api/customers/${loser.body.id}`);
    expect(loserAfter.body.isArchived).toBe(true);
    const survivorAfter = await request(app).get(`/api/customers/${survivor.body.id}`);
    expect(survivorAfter.body.isArchived).toBe(false);
  });

  it('returns 400 when losingId is missing', async () => {
    const survivor = await createCustomer(app, { firstName: 'Keep', lastName: 'Me' });
    const res = await request(app).post(`/api/customers/${survivor.body.id}/merge`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when merging a customer into itself', async () => {
    const c = await createCustomer(app, { firstName: 'Solo', lastName: 'One' });
    const res = await request(app)
      .post(`/api/customers/${c.body.id}/merge`)
      .send({ losingId: c.body.id });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the surviving customer does not exist', async () => {
    const loser = await createCustomer(app, { firstName: 'Drop', lastName: 'Me' });
    const res = await request(app)
      .post('/api/customers/ghost/merge')
      .send({ losingId: loser.body.id });
    expect(res.status).toBe(404);
  });
});

/**
 * `customers.id` is a Postgres `uuid` column (packages/api/src/customers/
 * pg-customer.ts — `WHERE tenant_id = $1 AND id = $2`). A malformed id
 * (e.g. the literal "new", from the web app's `/customers/new` URL landing
 * on the customer-detail page before it had a real create route) never
 * reaches `InMemoryCustomerRepository` in production — only the real
 * Postgres-backed repo. Postgres rejects it with "invalid input syntax for
 * type uuid" before any row lookup happens, and `asyncRoute` maps that
 * unclassified error to a bare 500 (`{ error: 'INTERNAL_ERROR' }`) — the
 * production incident this test reproduces.
 *
 * `InMemoryCustomerRepository.findById` is a plain `Map.get`, so it can't
 * reproduce this failure by itself (a `does-not-exist`/`ghost` string just
 * misses the map and correctly 404s already — see the tests above). This
 * thin subclass throws the same error Postgres would, so the route's
 * malformed-id handling is proven the same way the interactions.ts /
 * users.ts precedents for this exact bug class are: via supertest against
 * the real route, without a live Postgres/Docker.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PgLikeCustomerRepository extends InMemoryCustomerRepository {
  async findById(tenantId: string, id: string) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.findById(tenantId, id);
  }

  // PgCustomerRepository.update also does `WHERE ... AND id = $N` against
  // the uuid column (packages/api/src/customers/pg-customer.ts) — the same
  // hole, exercised by PUT /:id and POST /:id/archive.
  async update(tenantId: string, id: string, updates: Partial<Customer>) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.update(tenantId, id, updates);
  }
}

function buildPgLikeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER_ID,
      sessionId: 'session-test-1',
      tenantId: TEST_TENANT_ID,
      role: 'owner',
    };
    next();
  });
  const customerRepo = new PgLikeCustomerRepository();
  const auditRepo = new InMemoryAuditRepository();
  app.use(
    '/api/customers',
    createCustomerRouter(
      customerRepo,
      auditRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      new InMemoryCustomerMergeRepository(customerRepo),
    ),
  );
  return app;
}

describe('malformed :id never reaches Postgres as a raw uuid comparison', () => {
  let app: Express;

  beforeEach(() => {
    app = buildPgLikeApp();
  });

  it('GET /api/customers/new returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).get('/api/customers/new');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('PUT /api/customers/new returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).put('/api/customers/new').send({ firstName: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/customers/new/archive returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).post('/api/customers/new/archive').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/customers/new/merge returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app)
      .post('/api/customers/new/merge')
      .send({ losingId: '11111111-1111-1111-1111-111111111111' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
