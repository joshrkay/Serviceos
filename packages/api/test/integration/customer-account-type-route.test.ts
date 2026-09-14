/**
 * #1155 (row 2.12) — an owner can mark a customer as a business /
 * property-manager account through the real customers routes.
 *
 * `customers.account_type` (migrations 113/178) drives B2B recognition on a
 * call (`assembleB2bAccountContext`), but until #1155 no owner surface could
 * set it: `createCustomerSchema` did not declare `accountType` (Zod stripped
 * it on POST) and nothing validated it on PUT — so it was settable only by
 * direct SQL (e2e/telephony-capture-2-12.spec.ts had to seed it that way).
 *
 * At real Postgres through `createCustomerRouter` (PgCustomerRepository +
 * PgAuditRepository): POST and PUT round-trip the field, an out-of-enum value
 * is a 400 that writes nothing, the edit is audited like every other customer
 * field edit (`customer.updated` changes list), and tenant B's customer is
 * untouched and unreachable from tenant A.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { createCustomerRouter } from '../../src/routes/customers';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('Postgres integration — customers routes accept a validated accountType (#1155)', () => {
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
        sessionId: 'sess-1155',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/customers', createCustomerRouter(new PgCustomerRepository(pool), new PgAuditRepository(pool)));
    return app;
  }

  async function storedAccountType(customerId: string): Promise<string | null> {
    const { rows } = await pool.query('SELECT account_type FROM customers WHERE id = $1', [customerId]);
    expect(rows).toHaveLength(1);
    return rows[0].account_type;
  }

  it('POST + PUT round-trip accountType, reject an unknown value with 400, audit the edit; T1', async () => {
    const a = appFor(tenantA);
    const b = appFor(tenantB);

    // Tenant B's own residential customer — divergent data that must stay put.
    const bCreate = await request(b)
      .post('/api/customers')
      .send({ firstName: 'Bea', lastName: 'Neighbour', accountType: 'residential' });
    expect(bCreate.status).toBe(201);
    const bId = bCreate.body.id as string;

    // ── POST ────────────────────────────────────────────────────────────────
    const created = await request(a)
      .post('/api/customers')
      .send({ firstName: 'Portfolio', lastName: 'Manager', accountType: 'property_manager' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect({ response: created.body.accountType, stored: await storedAccountType(id) }).toEqual({
      response: 'property_manager',
      stored: 'property_manager',
    });

    // ── PUT ─────────────────────────────────────────────────────────────────
    const updated = await request(a).put(`/api/customers/${id}`).send({ accountType: 'b2b' });
    expect(updated.status).toBe(200);
    const fetched = await request(a).get(`/api/customers/${id}`);
    expect({
      response: updated.body.accountType,
      get: fetched.body.accountType,
      stored: await storedAccountType(id),
    }).toEqual({ response: 'b2b', get: 'b2b', stored: 'b2b' });

    const audit = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'customer.updated'
        ORDER BY created_at DESC LIMIT 1`,
      [tenantA.tenantId, id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.changes).toContain('accountType');

    // ── validation: out-of-enum is a 400 and writes nothing ────────────────
    const badPut = await request(a).put(`/api/customers/${id}`).send({ accountType: 'enterprise' });
    const badPost = await request(a)
      .post('/api/customers')
      .send({ firstName: 'Bad', lastName: 'Type', accountType: 'enterprise' });
    expect({ put: badPut.status, post: badPost.status, stored: await storedAccountType(id) }).toEqual({
      put: 400,
      post: 400,
      stored: 'b2b',
    });

    // ── T1: tenant A cannot reach B's customer; B's row is untouched ───────
    const crossPut = await request(a).put(`/api/customers/${bId}`).send({ accountType: 'property_manager' });
    expect(crossPut.status).toBe(404);
    expect(await storedAccountType(bId)).toBe('residential');
  });
});
