/**
 * #1401 (QA §6) — the customers directory's service-type chips (HVAC /
 * Plumbing / Painting) never matched and the header read "0 locations":
 * CustomersPage reads `locations[].serviceTypes` off each list row, but the
 * list API returned bare customers (no `locations`) and the add-customer
 * sheet's chosen service types were never persisted anywhere.
 *
 * The shared contract (customerLocationSummarySchema) and the web model
 * (ServiceLocation.serviceTypes) both put service types on the service
 * location, so that is where they are persisted (service_locations
 * .service_types). At real Postgres through the real customers + locations
 * routers:
 *   - POST /api/locations round-trips `serviceTypes`;
 *   - GET /api/customers rows carry their live locations' summaries;
 *   - `?serviceType=HVAC` filters server-side, so paginated data and total
 *     agree (a client-side filter only ever saw the loaded page);
 *   - tenant B's HVAC location never leaks into tenant A's list.
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

describe('Postgres integration — customer list service-type chips (#1401)', () => {
  let pool: Pool;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function appFor(tenant: TestTenant): Express {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        sessionId: 'sess-1401',
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
    return app;
  }

  async function customerWithLocation(
    app: Express,
    firstName: string,
    serviceTypes: string[] | undefined
  ): Promise<{ customerId: string; locationBody: Record<string, unknown> }> {
    const c = await request(app).post('/api/customers').send({ firstName, lastName: 'Chip' });
    expect(c.status).toBe(201);
    const loc = await request(app)
      .post('/api/locations')
      .send({
        customerId: c.body.id,
        label: 'Home',
        street1: '1 Main St',
        city: 'Phoenix',
        state: 'AZ',
        postalCode: '85001',
        isPrimary: true,
        ...(serviceTypes ? { serviceTypes } : {}),
      });
    expect(loc.status).toBe(201);
    return { customerId: c.body.id as string, locationBody: loc.body };
  }

  it('persists location serviceTypes, embeds location summaries in list rows, and filters by serviceType server-side', async () => {
    const a = appFor(tenantA);
    const b = appFor(tenantB);

    const hvac = await customerWithLocation(a, 'Hvacia', ['HVAC']);
    const plumb = await customerWithLocation(a, 'Plumbo', ['Plumbing', 'Painting']);
    const bare = await customerWithLocation(a, 'Nochip', undefined);
    await customerWithLocation(b, 'Othertenant', ['HVAC']);

    // POST /api/locations round-trips the chosen service types.
    expect(hvac.locationBody.serviceTypes).toEqual(['HVAC']);
    expect(bare.locationBody.serviceTypes).toEqual([]);

    // Unfiltered list rows carry their live locations (drives the header's
    // location count and each row's chips).
    const all = await request(a).get('/api/customers?paginated=true');
    expect(all.status).toBe(200);
    const byId = new Map(
      (all.body.data as Array<{ id: string; locations?: unknown[] }>).map((r) => [r.id, r])
    );
    expect(byId.get(plumb.customerId)?.locations).toEqual([
      expect.objectContaining({ street1: '1 Main St', city: 'Phoenix', state: 'AZ', serviceTypes: ['Plumbing', 'Painting'] }),
    ]);
    expect(byId.get(bare.customerId)?.locations).toEqual([
      expect.objectContaining({ serviceTypes: [] }),
    ]);

    // Server-side filter: only tenant A's HVAC customer; data and total agree.
    const filtered = await request(a).get('/api/customers?paginated=true&serviceType=HVAC');
    expect(filtered.status).toBe(200);
    expect(filtered.body.total).toBe(1);
    expect((filtered.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual([hvac.customerId]);

    const painting = await request(a).get('/api/customers?serviceType=Painting');
    expect(painting.status).toBe(200);
    expect((painting.body as Array<{ id: string }>).map((r) => r.id)).toEqual([plumb.customerId]);
  });

  // #1473 item 3 — the add-customer sheet stores 'HVAC' / 'Plumbing', but a
  // direct POST /api/locations stored 'plumbing', so the Plumbing chip
  // returned 0 rows.
  it('normalises service types on write to the canonical chip label', async () => {
    const c = appFor(await createTestTenant(pool));
    const loc = await customerWithLocation(c, 'Lowercase', ['plumbing', ' hvac ', 'PLUMBING']);
    expect(loc.locationBody.serviceTypes).toEqual(['Plumbing', 'HVAC']);

    const filtered = await request(c).get('/api/customers?serviceType=Plumbing');
    expect((filtered.body as Array<{ id: string }>).map((r) => r.id)).toEqual([loc.customerId]);
  });

  it('filters case-insensitively, so rows stored before normalisation still match their chip', async () => {
    const tenant = await createTestTenant(pool);
    const c = appFor(tenant);
    const cust = await request(c).post('/api/customers').send({ firstName: 'Legacy', lastName: 'Case' });
    expect(cust.status).toBe(201);
    // A row written before #1473 kept the caller's casing.
    await new PgLocationRepository(pool).create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      customerId: cust.body.id,
      street1: '2 Main St',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'US',
      isPrimary: true,
      addressType: 'service',
      serviceTypes: ['plumbing'],
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(c).get('/api/customers?paginated=true&serviceType=Plumbing');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect((res.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual([cust.body.id]);
  });
});
