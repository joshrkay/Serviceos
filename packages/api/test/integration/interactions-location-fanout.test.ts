/**
 * Postgres integration — GET /api/interactions must return ONE row per voice
 * session regardless of how many service_locations the customer has.
 *
 * Regression for the gemini-code-assist review finding on PR #627: the list
 * query LEFT JOIN'd service_locations on customer_id, so a customer with N
 * addresses fanned each session into N rows — duplicating interactions and
 * breaking LIMIT/OFFSET pagination (it paginated the fanned rows while `total`
 * counted distinct sessions). A mocked pool can't catch a JOIN fan-out; this
 * pins it against real Postgres. The address shown must be the PRIMARY location.
 */
import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { createInteractionsRouter } from '../../src/routes/interactions';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';

let pool: Pool;

beforeAll(async () => {
  pool = await getSharedTestDb();
});
afterAll(async () => {
  await closeSharedTestDb();
});

function buildApp(tenantId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId,
      role: 'owner',
    };
    next();
  });
  app.use('/api/interactions', createInteractionsRouter({ pool, dispatchRepo: new InMemoryDispatchRepository() }));
  return app;
}

async function seedCustomer(tenantId: string, createdBy: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, 'Multi', 'Site', 'Multi Site', $3)`,
    [id, tenantId, createdBy],
  );
  return id;
}

async function addLocation(
  tenantId: string,
  customerId: string,
  street1: string,
  isPrimary: boolean,
  createdAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO service_locations
       (id, tenant_id, customer_id, street1, city, state, postal_code, is_primary, created_at)
     VALUES ($1, $2, $3, $4, 'Austin', 'TX', '78701', $5, $6)`,
    [crypto.randomUUID(), tenantId, customerId, street1, isPrimary, createdAt],
  );
}

async function addSession(tenantId: string, customerId: string | null, startedAt: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO voice_sessions (id, tenant_id, customer_id, channel, state, started_at)
     VALUES ($1, $2, $3, 'voice_inbound', 'completed', $4)`,
    [id, tenantId, customerId, startedAt],
  );
  return id;
}

describe('GET /api/interactions — service_locations fan-out (real Postgres)', () => {
  it('returns one row per session for a customer with multiple locations, using the primary address', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const customerId = await seedCustomer(tenantId, userId);
    // Two locations; the NON-primary is older, so a naive "first row" would pick it.
    await addLocation(tenantId, customerId, '200 Secondary Rd', false, '2026-01-01T00:00:00Z');
    await addLocation(tenantId, customerId, '100 Primary St', true, '2026-02-01T00:00:00Z');
    // Two sessions for that customer → the old LEFT JOIN would yield 2×2 = 4 rows.
    const s1 = await addSession(tenantId, customerId, '2026-03-01T10:00:00Z');
    const s2 = await addSession(tenantId, customerId, '2026-03-02T10:00:00Z');

    const res = await request(buildApp(tenantId)).get('/api/interactions');

    expect(res.status).toBe(200);
    // The session is scoped by tenant, so exactly the two we seeded — not four.
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
    const ids = res.body.data.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual([s1, s2].sort());
    // Each carries the PRIMARY address, not the older secondary one.
    for (const item of res.body.data) {
      expect(item.customer.address).toBe('100 Primary St');
    }
  });

  it('a customer with no locations still yields one row per session (address null)', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const customerId = await seedCustomer(tenantId, userId);
    const s = await addSession(tenantId, customerId, '2026-03-03T10:00:00Z');

    const res = await request(buildApp(tenantId)).get('/api/interactions');

    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(s);
    expect(res.body.data[0].customer.address).toBeNull();
  });

  it('detail route returns the primary address (no fan-out)', async () => {
    const { tenantId, userId } = await createTestTenant(pool);
    const customerId = await seedCustomer(tenantId, userId);
    await addLocation(tenantId, customerId, '200 Secondary Rd', false, '2026-01-01T00:00:00Z');
    await addLocation(tenantId, customerId, '100 Primary St', true, '2026-02-01T00:00:00Z');
    const s = await addSession(tenantId, customerId, '2026-03-04T10:00:00Z');

    const res = await request(buildApp(tenantId)).get(`/api/interactions/${s}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(s);
    expect(res.body.customer.address).toBe('100 Primary St');
  });
});
