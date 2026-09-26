/**
 * Postgres integration — #1032: invitation expiry must be enforced on the
 * Clerk `user.created` webhook join path.
 *
 * `pending_invitations.expires_at` was written at create time but neither
 * webhook lookup (`findPendingByEmail`, `findById` in
 * `src/users/pg-pending-invitation.ts`) filtered on it, so a still-pending
 * but EXPIRED invitation would join the invitee to the inviting tenant.
 *
 * This drives the real `/webhooks/clerk` route (both the id-based lookup —
 * public_metadata.invitation_id — and the email-fallback lookup) against a
 * real Postgres and proves:
 *   - an expired invitation is refused: no `users` row is created under the
 *     inviting tenant, the invitation is never marked accepted, and the
 *     webhook instead bootstraps the invitee their OWN (separate) tenant
 *     (the safe fallback the join code already takes when no invitation
 *     matches — see webhooks/routes.ts).
 *   - an in-date invitation still joins normally (control).
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

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

function signSvixPayload(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

function postClerkWebhook(app: express.Express, payload: object) {
  const svixId = `evt_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app)
    .post('/webhooks/clerk')
    .set('svix-id', svixId)
    .set('svix-timestamp', ts)
    .set('svix-signature', signSvixPayload(payload, svixId, ts))
    .send(payload);
}

describe('Postgres integration — #1032 Clerk invitation join enforces expiry', () => {
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

  it('refuses an EXPIRED invitation matched by id (public_metadata.invitation_id): no join, not accepted, invitee bootstraps their own tenant', async () => {
    const inviter = await createTestTenant(pool);
    const invitee = `user_invitee_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;

    const invitation = await pendingInvitationRepo.create({
      tenantId: inviter.tenantId,
      email,
      role: 'technician',
      invitedBy: inviter.userId,
      expiresAt: new Date(Date.now() - 60_000), // expired a minute ago
    });

    const payload = {
      type: 'user.created',
      data: {
        id: invitee,
        email_addresses: [{ email_address: email }],
        public_metadata: { invitation_id: invitation.id },
      },
    };
    const res = await postClerkWebhook(app, payload);
    expect(res.status).toBe(200);

    // Not joined to the inviter's tenant.
    const joinedRow = await pool.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [inviter.tenantId, invitee],
    );
    expect(joinedRow.rowCount).toBe(0);

    // The invitation was never consumed.
    const invitationRow = await pool.query(
      `SELECT accepted_at FROM pending_invitations WHERE id = $1`,
      [invitation.id],
    );
    expect(invitationRow.rows[0].accepted_at).toBeNull();

    // Safe fallback: the invitee bootstrapped their own separate tenant.
    const ownTenant = await pool.query(`SELECT id FROM tenants WHERE owner_id = $1`, [invitee]);
    expect(ownTenant.rowCount).toBe(1);
    expect(ownTenant.rows[0].id).not.toBe(inviter.tenantId);
  });

  it('refuses an EXPIRED invitation matched by email fallback (no invitation_id): no join, invitee bootstraps their own tenant', async () => {
    const inviter = await createTestTenant(pool);
    const invitee = `user_invitee_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;

    const invitation = await pendingInvitationRepo.create({
      tenantId: inviter.tenantId,
      email,
      role: 'dispatcher',
      invitedBy: inviter.userId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const payload = {
      type: 'user.created',
      data: { id: invitee, email_addresses: [{ email_address: email }] },
    };
    const res = await postClerkWebhook(app, payload);
    expect(res.status).toBe(200);

    const joinedRow = await pool.query(
      `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [inviter.tenantId, invitee],
    );
    expect(joinedRow.rowCount).toBe(0);

    const invitationRow = await pool.query(
      `SELECT accepted_at FROM pending_invitations WHERE id = $1`,
      [invitation.id],
    );
    expect(invitationRow.rows[0].accepted_at).toBeNull();

    const ownTenant = await pool.query(`SELECT id FROM tenants WHERE owner_id = $1`, [invitee]);
    expect(ownTenant.rowCount).toBe(1);
  });

  it('an IN-DATE invitation still joins normally (control)', async () => {
    const inviter = await createTestTenant(pool);
    const invitee = `user_invitee_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.com`;

    const invitation = await pendingInvitationRepo.create({
      tenantId: inviter.tenantId,
      email,
      role: 'technician',
      invitedBy: inviter.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const payload = {
      type: 'user.created',
      data: {
        id: invitee,
        email_addresses: [{ email_address: email }],
        public_metadata: { invitation_id: invitation.id },
      },
    };
    const res = await postClerkWebhook(app, payload);
    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(inviter.tenantId);

    const joinedRow = await pool.query(
      `SELECT role FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [inviter.tenantId, invitee],
    );
    expect(joinedRow.rowCount).toBe(1);
    expect(joinedRow.rows[0].role).toBe('technician');

    const invitationRow = await pool.query(
      `SELECT accepted_at FROM pending_invitations WHERE id = $1`,
      [invitation.id],
    );
    expect(invitationRow.rows[0].accepted_at).not.toBeNull();
  });
});
