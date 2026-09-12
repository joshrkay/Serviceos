/**
 * Postgres integration — owner membership row on signup
 * (QUALITY-2026-07-12 WS4).
 *
 * DB-authoritative authorization rejects a caller with no `users` row, so the
 * Clerk `user.created` → bootstrap path MUST now create the owner's membership
 * row (historically it created only the tenant + Clerk metadata). This drives
 * the REAL `/webhooks/clerk` route against a real Postgres and asserts the owner
 * row lands with role='owner', and that a replay does not duplicate it.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { InMemoryWebhookRepository } from '../../src/webhooks/webhook-handler';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AppConfig } from '../../src/shared/config';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

function signSvixPayload(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('Postgres integration — Clerk owner membership bootstrap', () => {
  let pool: Pool;
  let app: express.Express;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const config = {
      CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CLERK_SECRET_KEY: undefined,
    } as unknown as AppConfig;
    app = express();
    app.use(express.json());
    app.use(
      '/webhooks',
      createWebhookRouter(config, {
        tenantRepo: new PgTenantRepository(pool),
        pool,
        webhookRepo: new InMemoryWebhookRepository(),
        auditRepo: new PgAuditRepository(pool),
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates an owner users row (role=owner) and does not duplicate on replay', async () => {
    const clerkUserId = `user_owner_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;
    const payload = {
      type: 'user.created',
      data: { id: clerkUserId, email_addresses: [{ email_address: email }] },
    };
    const svixId = `evt_${crypto.randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signSvixPayload(payload, svixId, ts))
      .send(payload);
    expect(res.status).toBe(200);

    const rows = await pool.query(
      `SELECT role, status, deleted_at FROM users WHERE clerk_user_id = $1`,
      [clerkUserId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].role).toBe('owner');
    expect(rows.rows[0].status).toBe('active');
    expect(rows.rows[0].deleted_at).toBeNull();

    // Replay the SAME event id (fresh timestamp): event-id idempotency short-
    // circuits before bootstrap, and even if it didn't the WHERE NOT EXISTS
    // guard keeps exactly one owner row.
    const ts2 = String(Math.floor(Date.now() / 1000));
    const replay = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts2)
      .set('svix-signature', signSvixPayload(payload, svixId, ts2))
      .send(payload);
    expect(replay.status).toBe(200);

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM users WHERE clerk_user_id = $1`,
      [clerkUserId],
    );
    expect(after.rows[0].n).toBe(1);
  });

  it('a genuinely re-delivered signup (distinct svix ids, same Clerk user) still yields exactly one tenant, and a neighbour tenant is untouched', async () => {
    const auditRepo = new PgAuditRepository(pool);

    // Neighbour tenant, provisioned first — its own independent signup.
    // The tenantB assertions below prove tenant A's re-delivery never
    // touches it.
    const tenantBClerkUserId = `user_owner_${crypto.randomUUID()}`;
    const tenantBEmail = `${crypto.randomUUID()}@example.com`;
    const tenantBPayload = {
      type: 'user.created',
      data: { id: tenantBClerkUserId, email_addresses: [{ email_address: tenantBEmail }] },
    };
    const tenantBSvixId = `evt_${crypto.randomUUID()}`;
    const tenantBTs = String(Math.floor(Date.now() / 1000));
    const tenantBRes = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', tenantBSvixId)
      .set('svix-timestamp', tenantBTs)
      .set('svix-signature', signSvixPayload(tenantBPayload, tenantBSvixId, tenantBTs))
      .send(tenantBPayload);
    expect(tenantBRes.status).toBe(200);
    const tenantBRow = await pool.query(
      `SELECT tenant_id, role FROM users WHERE clerk_user_id = $1`,
      [tenantBClerkUserId],
    );
    expect(tenantBRow.rowCount).toBe(1);
    const tenantBId = tenantBRow.rows[0].tenant_id as string;
    const tenantBRoleBefore = tenantBRow.rows[0].role as string;

    // Tenant A: two SEPARATE deliveries (distinct svix ids, as a real Clerk
    // redelivery would use) of the same user.created event. bootstrapTenant's
    // findByOwner(userId) guard — not the event-id dedup — must be what
    // keeps this to exactly one tenant.
    const clerkUserId = `user_owner_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;
    const payload = {
      type: 'user.created',
      data: { id: clerkUserId, email_addresses: [{ email_address: email }] },
    };

    const svixId1 = `evt_${crypto.randomUUID()}`;
    const ts1 = String(Math.floor(Date.now() / 1000));
    const first = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId1)
      .set('svix-timestamp', ts1)
      .set('svix-signature', signSvixPayload(payload, svixId1, ts1))
      .send(payload);
    expect(first.status).toBe(200);

    const svixId2 = `evt_${crypto.randomUUID()}`;
    const ts2 = String(Math.floor(Date.now() / 1000));
    const second = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId2)
      .set('svix-timestamp', ts2)
      .set('svix-signature', signSvixPayload(payload, svixId2, ts2))
      .send(payload);
    expect(second.status).toBe(200);

    const tenantCount = await pool.query(
      `SELECT count(*)::int AS n FROM tenants WHERE owner_id = $1`,
      [clerkUserId],
    );
    expect(tenantCount.rows[0].n).toBe(1);

    const userCount = await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE role = 'owner')::int AS owners
       FROM users WHERE clerk_user_id = $1`,
      [clerkUserId],
    );
    expect(userCount.rows[0].n).toBe(1);
    expect(userCount.rows[0].owners).toBe(1);

    const tenantAId = (
      await pool.query(`SELECT id FROM tenants WHERE owner_id = $1`, [clerkUserId])
    ).rows[0].id as string;

    // Audit leg — the signup-bootstrap audit event is readable back
    // through the real repository, not just a raw SELECT.
    const auditEvents = await auditRepo.findByEntity(tenantAId, 'tenant', tenantAId);
    const bootstrapEvents = auditEvents.filter(
      (e) => e.eventType === 'tenant.signup.bootstrap.completed',
    );
    expect(bootstrapEvents.length).toBeGreaterThanOrEqual(1);

    // Neighbour (tenant B) membership is untouched by tenant A's re-delivery.
    const tenantBAfter = await pool.query(
      `SELECT count(*)::int AS n, role FROM users WHERE tenant_id = $1 GROUP BY role`,
      [tenantBId],
    );
    expect(tenantBAfter.rowCount).toBe(1);
    expect(tenantBAfter.rows[0].n).toBe(1);
    expect(tenantBAfter.rows[0].role).toBe(tenantBRoleBefore);
  });

  it('rejects a Clerk webhook whose svix-timestamp is outside the 5-minute replay window', async () => {
    const clerkUserId = `user_owner_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;
    const payload = {
      type: 'user.created',
      data: { id: clerkUserId, email_addresses: [{ email_address: email }] },
    };
    const svixId = `evt_${crypto.randomUUID()}`;
    // 10 minutes stale — outside the 300s SVIX_TOLERANCE_SECONDS tolerance
    // enforced in webhooks/routes.ts BEFORE signature verification.
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', staleTs)
      .set('svix-signature', signSvixPayload(payload, svixId, staleTs))
      .send(payload);
    expect(res.status).toBe(400);

    const rows = await pool.query(`SELECT count(*)::int AS n FROM users WHERE clerk_user_id = $1`, [
      clerkUserId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });
});
