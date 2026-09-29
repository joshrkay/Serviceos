/**
 * #1481 item 2 (QA §16) — `GET /api/customers?page=1&pageSize=25` returned
 * the bare array of every customer: the route only understood the P1-018
 * `limit`/`offset`/`paginated` contract, so `page`/`pageSize` were ignored.
 *
 * (The issue's "89 of 110" came from the sweep log's "active customers
 * before=89" line; the same log shows the full list returned rows=110. The
 * first case below pins that nothing is silently dropped — customers with
 * and without service locations alike.)
 *
 * Real Postgres through the real customers + locations routers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { createCustomerRouter } from '../../src/routes/customers';
import { createLocationRouter } from '../../src/routes/locations';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TOTAL = 110;
const WITH_LOCATION = 60;

describe('Postgres integration — customer list paging (#1481)', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let app: Express;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        sessionId: 'sess-1481',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    const audit = new PgAuditRepository(pool);
    app.use('/api/customers', createCustomerRouter(new PgCustomerRepository(pool), audit));
    app.use(
      '/api/locations',
      createLocationRouter(new PgLocationRepository(pool), permissiveTenantOwnership(), audit)
    );

    // Zero-padded names so the default name-ASC order is predictable:
    // Pager 001 .. Pager 110. The first 60 get a service location; 50 have none.
    for (let i = 1; i <= TOTAL; i++) {
      const n = String(i).padStart(3, '0');
      const c = await request(app).post('/api/customers').send({ firstName: 'Pager', lastName: n });
      expect(c.status).toBe(201);
      if (i <= WITH_LOCATION) {
        const loc = await request(app).post('/api/locations').send({
          customerId: c.body.id,
          label: 'Home',
          street1: `${i} Main St`,
          city: 'Phoenix',
          state: 'AZ',
          postalCode: '85001',
          isPrimary: true,
        });
        expect(loc.status).toBe(201);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('the unpaged list returns every customer, with or without a location', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(110);
    const names = (res.body as Array<{ displayName: string }>).map((c) => c.displayName);
    expect(names[0]).toBe('Pager 001');
    expect(names[109]).toBe('Pager 110');
  });

  it('honours page/pageSize: page 2 of 25 is customers 26-50 with the full total', async () => {
    const res = await request(app).get('/api/customers?page=2&pageSize=25');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(110);
    const names = (res.body.data as Array<{ displayName: string }>).map((c) => c.displayName);
    expect(names).toHaveLength(25);
    expect(names[0]).toBe('Pager 026');
    expect(names[24]).toBe('Pager 050');
  });

  it('the last page holds the remainder, and an out-of-range pageSize is rejected', async () => {
    const last = await request(app).get('/api/customers?page=5&pageSize=25');
    expect(last.status).toBe(200);
    expect(last.body.total).toBe(110);
    expect(last.body.data).toHaveLength(10);

    const tooBig = await request(app).get('/api/customers?page=1&pageSize=500');
    expect(tooBig.status).toBe(400);
    const zeroPage = await request(app).get('/api/customers?page=0&pageSize=25');
    expect(zeroPage.status).toBe(400);
  });
});
