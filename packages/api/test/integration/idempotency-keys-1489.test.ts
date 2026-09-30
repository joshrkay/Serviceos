/**
 * #1489 — concurrent identical create POSTs created duplicate records.
 * `Idempotency-Key` support on the create routes: same tenant + user + key +
 * body replays the stored response instead of creating a second record.
 *
 * Real Postgres, through the same request stack production runs: auth →
 * request-scoped tenant transaction → idempotency → the real routers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { createCustomerRouter } from '../../src/routes/customers';
import { createPaymentRouter } from '../../src/routes/payments';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { mountIdempotentCreateRoutes } from '../../src/idempotency/idempotency-middleware';
import { PgIdempotencyStore } from '../../src/idempotency/pg-idempotency-store';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('Postgres integration — Idempotency-Key on create routes (#1489)', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let app: Express;
  let invoiceId: string;
  let store: PgIdempotencyStore;

  /** customer → location → job → open $200.00 invoice, via the repos. */
  async function seedOpenInvoice(): Promise<string> {
    const customerId = crypto.randomUUID();
    const now = new Date();
    await new PgCustomerRepository(pool).create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Pay', lastName: 'Seed1489',
      displayName: 'Pay Seed1489', preferredChannel: 'phone', smsConsent: false,
      isArchived: false, createdBy: tenant.userId, createdAt: now, updatedAt: now,
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId, tenantId: tenant.tenantId, customerId, street1: '1 Key St',
      city: 'Phoenix', state: 'AZ', postalCode: '85001', country: 'USA', isPrimary: true,
      addressType: 'service', isArchived: false, createdAt: now, updatedAt: now,
    });
    const jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId, jobNumber: 'JOB-1489',
      summary: 'Idempotency job', status: 'scheduled', priority: 'normal',
      createdBy: tenant.userId, createdAt: now, updatedAt: now,
    });
    const id = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 20000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await new PgInvoiceRepository(pool).create({
      id, tenantId: tenant.tenantId, jobId, invoiceNumber: 'INV-1489', status: 'open',
      lineItems, totals, amountPaidCents: 0, amountDueCents: totals.totalCents,
      createdBy: tenant.userId, createdAt: now, updatedAt: now,
    });
    return id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: (req.header('x-test-user') as string | undefined) ?? tenant.userId,
        sessionId: 'sess-1489',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    store = new PgIdempotencyStore(pool, { waitMs: 300 });
    mountIdempotentCreateRoutes(app, store);
    // Test-only: hold a claimed request open, to observe an in-flight duplicate.
    app.post('/api/customers', (req: Request, _res: Response, next: NextFunction) => {
      if (req.header('x-test-slow')) setTimeout(next, 1_500);
      else next();
    });
    const audit = new PgAuditRepository(pool);
    app.use('/api/customers', createCustomerRouter(new PgCustomerRepository(pool), audit));
    app.use(
      '/api/payments',
      createPaymentRouter(new PgPaymentRepository(pool), new PgInvoiceRepository(pool)),
    );
    invoiceId = await seedOpenInvoice();
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  const customersNamed = async (lastName: string): Promise<Array<{ id: string }>> => {
    const res = await request(app).get(`/api/customers?search=${encodeURIComponent(lastName)}`);
    expect(res.status).toBe(200);
    return res.body as Array<{ id: string }>;
  };

  it('a retried create with the same key replays the first response and creates no second record', async () => {
    const body = { firstName: 'Replay', lastName: 'Rivera1489' };
    const first = await request(app).post('/api/customers').set('Idempotency-Key', 'k-replay-1').send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/customers').set('Idempotency-Key', 'k-replay-1').send(body);
    expect(second.status).toBe(201);
    expect(second.text).toBe(first.text);
    expect(await customersNamed('Rivera1489')).toHaveLength(1);
  });

  it('two concurrent creates with the same key produce exactly one record and the same response', async () => {
    const body = { firstName: 'Race', lastName: 'Okafor1489' };
    const [a, b] = await Promise.all([
      request(app).post('/api/customers').set('Idempotency-Key', 'k-race-1').send(body),
      request(app).post('/api/customers').set('Idempotency-Key', 'k-race-1').send(body),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await customersNamed('Okafor1489')).toHaveLength(1);
  });

  it('reusing a key with a different body is rejected 422 IDEMPOTENCY_KEY_REUSED and creates nothing', async () => {
    const first = await request(app)
      .post('/api/customers')
      .set('Idempotency-Key', 'k-reuse-1')
      .send({ firstName: 'Reuse', lastName: 'Nakamura1489' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/customers')
      .set('Idempotency-Key', 'k-reuse-1')
      .send({ firstName: 'Other', lastName: 'Nakamura1489' });
    expect(second.status).toBe(422);
    expect(second.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await customersNamed('Nakamura1489')).toHaveLength(1);
  });

  it('a duplicate that arrives while the first is still in flight gets 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const body = { firstName: 'Slow', lastName: 'Haddad1489' };
    const slow = request(app)
      .post('/api/customers')
      .set('Idempotency-Key', 'k-inflight-1')
      .set('x-test-slow', '1')
      .send(body)
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    const dup = await request(app).post('/api/customers').set('Idempotency-Key', 'k-inflight-1').send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect((await slow).status).toBe(201);
    expect(await customersNamed('Haddad1489')).toHaveLength(1);
  });

  it('two concurrent record-payment POSTs with the same key record the payment once', async () => {
    const body = { invoiceId, amountCents: 5000, method: 'cash' };
    const [a, b] = await Promise.all([
      request(app).post('/api/payments').set('Idempotency-Key', 'k-pay-1').send(body),
      request(app).post('/api/payments').set('Idempotency-Key', 'k-pay-1').send(body),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const payments = await request(app).get(`/api/payments?invoiceId=${invoiceId}`);
    expect(payments.status).toBe(200);
    expect(payments.body).toHaveLength(1);
    expect(payments.body[0].amountCents).toBe(5000);
  });

  it('without the header, creates behave exactly as before (each POST creates a record)', async () => {
    const body = { firstName: 'Plain', lastName: 'Lindqvist1489' };
    expect((await request(app).post('/api/customers').send(body)).status).toBe(201);
    expect((await request(app).post('/api/customers').send(body)).status).toBe(201);
    expect(await customersNamed('Lindqvist1489')).toHaveLength(2);
  });

  it('keys are scoped per user: another user reusing the key gets their own record, not a replay', async () => {
    const otherUserId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [otherUserId, tenant.tenantId, otherUserId, 'second@example.com', 'owner'],
    );
    const body = { firstName: 'Scoped', lastName: 'Mensah1489' };
    const mine = await request(app).post('/api/customers').set('Idempotency-Key', 'k-shared').send(body);
    const theirs = await request(app)
      .post('/api/customers')
      .set('Idempotency-Key', 'k-shared')
      .set('x-test-user', otherUserId)
      .send(body);
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
  });

  it('pruning expired keys frees them: the key then starts a fresh request instead of 422', async () => {
    const first = await request(app)
      .post('/api/customers')
      .set('Idempotency-Key', 'k-ttl-1')
      .send({ firstName: 'Ttl', lastName: 'Varga1489' });
    expect(first.status).toBe(201);

    // Everything created before a cutoff one minute from now counts as expired.
    const pruned = await store.pruneExpired(tenant.tenantId, new Date(Date.now() + 60_000));
    expect(pruned).toBeGreaterThanOrEqual(1);

    const again = await request(app)
      .post('/api/customers')
      .set('Idempotency-Key', 'k-ttl-1')
      .send({ firstName: 'Ttl2', lastName: 'Varga1489' });
    expect(again.status).toBe(201);
    expect(await customersNamed('Varga1489')).toHaveLength(2);
  });
});
