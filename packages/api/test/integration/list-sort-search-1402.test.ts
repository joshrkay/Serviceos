/**
 * #1402 (QA §4/§5/§6) — one shared list-sort pattern for the estimates,
 * invoices and customers lists, plus server-side invoice search.
 *
 * Driven through the real list routes over real Postgres repositories:
 *   - `?sortBy=<field>&sort=asc|desc` orders the page server-side (so a
 *     paginated page is the right slice, not a client-side re-sort of one
 *     page), against an allowlist of fields — anything else is a 400;
 *   - `/api/invoices?search=` matches the invoice number AND the customer's
 *     name (same widening #1400 gave estimates);
 *   - a neighbour tenant's rows never appear (T1).
 *
 * Run:
 *   cd packages/api && EXTERNAL_TEST_DB_URL=... RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts test/integration/list-sort-search-1402.test.ts
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { createEstimateRouter } from '../../src/routes/estimates';
import { createInvoiceRouter } from '../../src/routes/invoices';
import { createCustomerRouter } from '../../src/routes/customers';
import { createEstimate } from '../../src/estimates/estimate';
import { createInvoice } from '../../src/invoices/invoice';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { TenantOwnership } from '../../src/shared/tenant-ownership';
import type { LineItem } from '../../src/shared/billing-engine';

describe('Postgres integration — list sort + invoice search (#1402)', () => {
  let pool: Pool;
  let app: express.Express;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let acting: TestTenant;
  const est: Record<string, string> = {};
  const inv: Record<string, string> = {};
  const cust: Record<string, string> = {};

  const line = (cents: number): LineItem[] => [
    { id: randomUUID(), description: 'Labor', quantity: 1, unitPriceCents: cents, totalCents: cents, sortOrder: 0, taxable: false },
  ];

  async function seedJob(t: TestTenant, firstName: string, lastName: string): Promise<string> {
    const customerId = randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId, tenantId: t.tenantId, firstName, lastName, displayName: `${firstName} ${lastName}`,
      preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: t.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    cust[`${t === tenantA ? 'A' : 'B'}:${firstName}`] = customerId;
    const locationId = randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId, tenantId: t.tenantId, customerId, street1: '1 Main St', city: 'Phoenix', state: 'AZ',
      postalCode: '85001', country: 'USA', isPrimary: true, isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId, tenantId: t.tenantId, customerId, locationId, jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Work', status: 'scheduled', priority: 'normal', createdBy: t.userId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return jobId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    acting = tenantA;

    const estimateRepo = new PgEstimateRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);

    // Tenant A: three customers, one estimate + one invoice each, with
    // totals / numbers / names that each order DIFFERENTLY so a sort on the
    // wrong column can't pass by coincidence.
    //   name     estimate            invoice
    //   Carla    EST-0002  $300      INV-0003  $100
    //   Anders   EST-0003  $100      INV-0001  $300
    //   Bea      EST-0001  $200      INV-0002  $200
    const carla = await seedJob(tenantA, 'Carla', 'Zed');
    const anders = await seedJob(tenantA, 'Anders', 'Young');
    const bea = await seedJob(tenantA, 'Bea', 'Xu');
    for (const [key, jobId, number, cents] of [
      ['carla', carla, 'EST-0002', 30000],
      ['anders', anders, 'EST-0003', 10000],
      ['bea', bea, 'EST-0001', 20000],
    ] as const) {
      const e = await createEstimate({ tenantId: tenantA.tenantId, jobId, estimateNumber: number, lineItems: line(cents), createdBy: tenantA.userId }, estimateRepo);
      est[key] = e.id;
    }
    for (const [key, jobId, number, cents, due] of [
      ['carla', carla, 'INV-0003', 10000, '2026-10-20'],
      ['anders', anders, 'INV-0001', 30000, '2026-10-10'],
      ['bea', bea, 'INV-0002', 20000, '2026-10-30'],
    ] as const) {
      const i = await createInvoice({ tenantId: tenantA.tenantId, jobId, invoiceNumber: number, lineItems: line(cents), dueDate: new Date(due), createdBy: tenantA.userId }, invoiceRepo);
      inv[key] = i.id;
    }

    // Tenant B: a same-named customer with the biggest documents — must never
    // show up in tenant A's lists or searches.
    const other = await seedJob(tenantB, 'Anders', 'Young');
    const eB = await createEstimate({ tenantId: tenantB.tenantId, jobId: other, estimateNumber: 'EST-0009', lineItems: line(99000), createdBy: tenantB.userId }, estimateRepo);
    est.B = eB.id;
    const iB = await createInvoice({ tenantId: tenantB.tenantId, jobId: other, invoiceNumber: 'INV-0009', lineItems: line(99000), createdBy: tenantB.userId }, invoiceRepo);
    inv.B = iB.id;

    const ownership = { requireExists: async () => undefined } as unknown as TenantOwnership;
    const settingsRepo = new PgSettingsRepository(pool);
    const audit = new PgAuditRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: acting.userId, sessionId: `sess_${acting.userId}`, tenantId: acting.tenantId, role: 'owner',
      };
      next();
    });
    app.use('/api/estimates', createEstimateRouter(estimateRepo, settingsRepo, audit, ownership));
    app.use('/api/invoices', createInvoiceRouter(invoiceRepo, settingsRepo, audit, ownership, undefined, undefined, jobRepo));
    app.use('/api/customers', createCustomerRouter(new PgCustomerRepository(pool), audit));
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  const ids = (body: { data: Array<{ id: string }> }) => body.data.map((r) => r.id);

  describe('estimates', () => {
    it('sortBy=total&sort=desc orders by the estimate total, largest first', async () => {
      const res = await request(app).get('/api/estimates?paginated=true&sortBy=total&sort=desc');
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([est.carla, est.bea, est.anders]);
    });

    it('sortBy=customer orders by the customer name A→Z by default (tenant B never leaks)', async () => {
      const res = await request(app).get('/api/estimates?paginated=true&sortBy=customer');
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([est.anders, est.bea, est.carla]);
    });

    it('rejects a sortBy outside the allowlist with a 400 (never reaches SQL)', async () => {
      const res = await request(app).get('/api/estimates?paginated=true&sortBy=tenant_id;drop');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('invoices', () => {
    it('sortBy=due orders by due date, soonest first by default', async () => {
      const res = await request(app).get('/api/invoices?paginated=true&sortBy=due');
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([inv.anders, inv.carla, inv.bea]);
    });

    it("search matches the customer's name (full, first or last) — tenant B's same-named customer never leaks", async () => {
      for (const q of ['Anders Young', 'anders', 'YOUNG']) {
        const res = await request(app).get(`/api/invoices?paginated=true&search=${encodeURIComponent(q)}`);
        expect(res.status).toBe(200);
        expect(ids(res.body), q).toEqual([inv.anders]);
        expect(res.body.total, q).toBe(1);
      }
    });

    it('sortBy=total&sort=asc orders by the invoice total, smallest first', async () => {
      const res = await request(app).get('/api/invoices?paginated=true&sortBy=total&sort=asc');
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([inv.carla, inv.bea, inv.anders]);
    });

    it('sortBy=customer&sort=desc orders by the customer name Z→A', async () => {
      const res = await request(app).get('/api/invoices?paginated=true&sortBy=customer&sort=desc');
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([inv.carla, inv.bea, inv.anders]);
    });

    it('search still matches the invoice number', async () => {
      const res = await request(app).get('/api/invoices?paginated=true&search=INV-0002');
      expect(ids(res.body)).toEqual([inv.bea]);
    });
  });

  describe('customers', () => {
    it('sortBy=created orders newest customer first; default stays name A→Z (tenant B never leaks)', async () => {
      const byCreated = await request(app).get('/api/customers?paginated=true&sortBy=created');
      expect(byCreated.status).toBe(200);
      expect(ids(byCreated.body)).toEqual([cust['A:Bea'], cust['A:Anders'], cust['A:Carla']]);

      const byName = await request(app).get('/api/customers?paginated=true');
      expect(ids(byName.body)).toEqual([cust['A:Anders'], cust['A:Bea'], cust['A:Carla']]);
    });
  });
});
