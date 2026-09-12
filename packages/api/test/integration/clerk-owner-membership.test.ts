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
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { InMemoryWebhookRepository } from '../../src/webhooks/webhook-handler';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgPendingInvitationRepository } from '../../src/users/pg-pending-invitation';
import { PgUserRepository } from '../../src/users/pg-user';
import { createUsersRouter } from '../../src/routes/users';
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
      `SELECT tenant_id, role, email, clerk_user_id, status, first_name, last_name, deleted_at
       FROM users WHERE clerk_user_id = $1`,
      [tenantBClerkUserId],
    );
    expect(tenantBRow.rowCount).toBe(1);
    const tenantBId = tenantBRow.rows[0].tenant_id as string;
    // Full membership-row snapshot (not just count+role) — a regression
    // that mutates tenant B's email/clerk_user_id/status while leaving the
    // row count and role alone would otherwise slip past this test
    // (Codex review, PR #1074).
    const tenantBRowBefore = { ...tenantBRow.rows[0] };

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

    // Neighbour (tenant B) membership is untouched by tenant A's re-delivery
    // — compare the FULL row, not just count+role, so a regression that
    // mutates email/clerk_user_id/status while preserving the single owner
    // row would still be caught.
    const tenantBAfter = await pool.query(
      `SELECT tenant_id, role, email, clerk_user_id, status, first_name, last_name, deleted_at
       FROM users WHERE tenant_id = $1`,
      [tenantBId],
    );
    expect(tenantBAfter.rowCount).toBe(1);
    expect(tenantBAfter.rows[0]).toEqual(tenantBRowBefore);
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
    // enforced in webhooks/routes.ts BEFORE signature verification. The
    // signature is deliberately INVALID (not computed for this payload) —
    // if the handler were ever reordered to verify the signature first, an
    // invalid signature would 401 here instead of the timestamp-specific
    // 400, so this pins the check ORDER, not just that both reject
    // eventually (Codex review, PR #1074).
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', staleTs)
      .set('svix-signature', 'v1,not-a-real-signature')
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Timestamp outside tolerance');

    const rows = await pool.query(`SELECT count(*)::int AS n FROM users WHERE clerk_user_id = $1`, [
      clerkUserId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });
});

/**
 * Postgres integration — team invitations (Tier 4 PR 3) against real
 * Postgres: the local invitation row survives a Clerk outage, the last
 * owner can never be demoted, and invitations are tenant-isolated.
 * (§8.1/§8.9 row 1.11.)
 */
describe('Postgres integration — team invitations + last-owner guard', () => {
  let pool: Pool;
  let usersApp: express.Express;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    const userRepo = new PgUserRepository(pool);
    const pendingInvitationRepo = new PgPendingInvitationRepository(pool);
    const auditRepo = new PgAuditRepository(pool);

    usersApp = express();
    usersApp.use(express.json());
    usersApp.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      // Test harness picks the acting tenant via a header rather than a
      // real Clerk JWT — both tenants A and B are live simultaneously in
      // this suite, unlike the single-currentTenant pattern elsewhere.
      const asTenant = req.headers['x-test-tenant'] === 'B' ? tenantB : tenantA;
      (req as import('../../src/auth/clerk').AuthenticatedRequest).auth = {
        userId: asTenant.userId,
        sessionId: 'sess-test',
        tenantId: asTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    usersApp.use(
      '/api/users',
      createUsersRouter(
        userRepo,
        {
          pendingInvitationRepo,
          // Clerk IS configured (clerkSecretKey set) but the outbound call
          // always rejects — simulates a Clerk-down invite, per row 1.11's
          // "when Clerk is down" clause. Only this network call is stubbed;
          // the local invitation write below is the real production path.
          clerkSecretKey: 'sk_test_down',
          clerkFetch: (async () => {
            throw new Error('Clerk API unreachable (simulated outage)');
          }) as unknown as typeof fetch,
        },
        auditRepo,
      ),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('writes the local invitation row even when Clerk is down, and audits it', async () => {
    const auditRepo = new PgAuditRepository(pool);
    const email = `invitee-${crypto.randomUUID()}@example.com`;

    const res = await request(usersApp)
      .post('/api/users/invitations')
      .send({ email, role: 'technician' });

    expect(res.status).toBe(201);

    const row = await pool.query(
      `SELECT tenant_id, email, role, accepted_at FROM pending_invitations WHERE id = $1`,
      [res.body.id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].tenant_id).toBe(tenantA.tenantId);
    expect(row.rows[0].email).toBe(email.toLowerCase());
    expect(row.rows[0].accepted_at).toBeNull();

    const auditEvents = await auditRepo.findByEntity(
      tenantA.tenantId,
      'pending_invitation',
      res.body.id,
    );
    expect(auditEvents.some((e) => e.eventType === 'user.invited')).toBe(true);
  });

  it('the last owner cannot be demoted (real PgUserRepository guard)', async () => {
    // tenantA.userId is its ONLY owner (createTestTenant seeds exactly one).
    const res = await request(usersApp)
      .patch(`/api/users/${tenantA.userId}`)
      .send({ role: 'dispatcher' });
    expect(res.status).toBe(400);

    const row = await pool.query(`SELECT role FROM users WHERE id = $1`, [tenantA.userId]);
    expect(row.rows[0].role).toBe('owner');
  });

  it("tenant B's invitation never appears under tenant A", async () => {
    const email = `otherco-${crypto.randomUUID()}@example.com`;
    const invited = await request(usersApp)
      .post('/api/users/invitations')
      .set('x-test-tenant', 'B')
      .send({ email, role: 'technician' });
    expect(invited.status).toBe(201);

    const seenFromA = await request(usersApp).get('/api/users/invitations');
    expect(seenFromA.status).toBe(200);
    expect(
      (seenFromA.body.data as Array<{ email: string }>).some((inv) => inv.email === email),
    ).toBe(false);

    // Direct repository check — the tenant-scoped WHERE, not just the
    // route's response shape, is what isolates the row.
    const pendingInvitationRepo = new PgPendingInvitationRepository(pool);
    const fromA = await pendingInvitationRepo.findByTenant(tenantA.tenantId);
    expect(fromA.some((inv) => inv.email === email.toLowerCase())).toBe(false);
    const fromB = await pendingInvitationRepo.findByTenant(tenantB.tenantId);
    expect(fromB.some((inv) => inv.email === email.toLowerCase())).toBe(true);
  });
});
