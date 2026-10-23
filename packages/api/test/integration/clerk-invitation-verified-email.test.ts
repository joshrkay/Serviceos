/**
 * Postgres integration — the Clerk `user.created` invitation join only
 * accepts a primary email address Clerk reports as verified.
 *
 * Drives the real `/webhooks/clerk` route against real Postgres with the
 * real PgPendingInvitationRepository / PgTenantRepository, using
 * real-shaped Clerk payloads (test/support/clerk-user-created.ts):
 *   - an unverified address that matches a pending invitation (email
 *     fallback, and the id lookup) creates NO users row in the inviting
 *     tenant, leaves the invitation pending, and bootstraps the new user
 *     their own separate tenant;
 *   - a verified address still joins the inviting tenant (control).
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
import type { AppConfig } from '../../src/shared/config';
import { clerkUserCreatedEvent } from '../support/clerk-user-created';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

function postClerkWebhook(app: express.Express, payload: object) {
  const svixId = `evt_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto
    .createHmac('sha256', secretBytes)
    .update(`${svixId}.${ts}.${JSON.stringify(payload)}`)
    .digest('base64');
  return request(app)
    .post('/webhooks/clerk')
    .set('svix-id', svixId)
    .set('svix-timestamp', ts)
    .set('svix-signature', `v1,${sig}`)
    .send(payload);
}

describe('Postgres integration — Clerk invitation join requires a verified primary email', () => {
  let pool: Pool;
  let app: express.Express;
  let pendingInvitationRepo: PgPendingInvitationRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    pendingInvitationRepo = new PgPendingInvitationRepository(pool);
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
        pendingInvitationRepo,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function invite(role: 'technician' | 'dispatcher' = 'technician') {
    const inviter = await createTestTenant(pool);
    const email = `${crypto.randomUUID()}@example.com`;
    const invitation = await pendingInvitationRepo.create({
      tenantId: inviter.tenantId,
      email,
      role,
      invitedBy: inviter.userId,
    });
    return { inviter, email, invitation };
  }

  async function expectNotJoined(inviterTenantId: string, invitationId: string, clerkUserId: string) {
    const joined = await pool.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [inviterTenantId, clerkUserId],
    );
    expect(joined.rowCount).toBe(0);
    const inv = await pool.query(`SELECT accepted_at FROM pending_invitations WHERE id = $1`, [
      invitationId,
    ]);
    expect(inv.rows[0].accepted_at).toBeNull();
    const own = await pool.query(`SELECT id FROM tenants WHERE owner_id = $1`, [clerkUserId]);
    expect(own.rowCount).toBe(1);
    expect(own.rows[0].id).not.toBe(inviterTenantId);
  }

  it('email fallback: an UNVERIFIED invited address does not join the inviting tenant', async () => {
    const { inviter, email, invitation } = await invite();
    const clerkUserId = `user_unverified_${crypto.randomUUID()}`;

    const res = await postClerkWebhook(
      app,
      clerkUserCreatedEvent({ userId: clerkUserId, emails: [{ address: email, status: 'unverified' }] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.joined).toBeUndefined();
    await expectNotJoined(inviter.tenantId, invitation.id, clerkUserId);
  });

  it('id lookup: an UNVERIFIED address does not join even with the matching invitation id', async () => {
    const { inviter, email, invitation } = await invite('dispatcher');
    const clerkUserId = `user_unverified_id_${crypto.randomUUID()}`;

    const res = await postClerkWebhook(
      app,
      clerkUserCreatedEvent({
        userId: clerkUserId,
        emails: [{ address: email, status: null }],
        publicMetadata: { invitation_id: invitation.id },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.joined).toBeUndefined();
    await expectNotJoined(inviter.tenantId, invitation.id, clerkUserId);
  });

  it('a VERIFIED invited address still joins with the invited role (control)', async () => {
    const { inviter, email, invitation } = await invite('dispatcher');
    const clerkUserId = `user_verified_${crypto.randomUUID()}`;

    const res = await postClerkWebhook(
      app,
      clerkUserCreatedEvent({ userId: clerkUserId, emails: [{ address: email, status: 'verified' }] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(inviter.tenantId);

    const joined = await pool.query(
      `SELECT role FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [inviter.tenantId, clerkUserId],
    );
    expect(joined.rows.map((r) => r.role)).toEqual(['dispatcher']);
    const inv = await pool.query(`SELECT accepted_at FROM pending_invitations WHERE id = $1`, [
      invitation.id,
    ]);
    expect(inv.rows[0].accepted_at).not.toBeNull();
    const own = await pool.query(`SELECT id FROM tenants WHERE owner_id = $1`, [clerkUserId]);
    expect(own.rowCount).toBe(0);
  });
});
