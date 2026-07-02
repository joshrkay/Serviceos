/**
 * Pins the PR 319 (P2) guard in the Clerk `user.created` invitee-join path:
 * when a pending invitation matches but `deps.pool` is not wired, the join must
 * NOT consume the invitation (no markAccepted) and must NOT bootstrap a
 * separate ("rogue") tenant for an invitee. Instead the handler fails the
 * webhook with 500 so Clerk retries once the pool is configured (see
 * 04a98f5 "fix(webhooks): fail invitee-join errors instead of bootstrapping a
 * rogue tenant"), leaving the invitation intact for a clean retry.
 */
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWebhookRouter } from '../../src/webhooks/routes';
import type { AppConfig } from '../../src/config';
import { TenantRepository, Tenant } from '../../src/auth/clerk';
import { PendingInvitation, PendingInvitationRepository } from '../../src/users/pending-invitation';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ=';

function signSvixPayload(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return { rawBody, signature: `v1,${sig}` };
}

class FakeTenantRepo implements TenantRepository {
  created: Array<{ ownerId: string }> = [];
  private byOwner = new Map<string, Tenant>();
  async findByOwner(ownerId: string) {
    return this.byOwner.get(ownerId) ?? null;
  }
  async findById() {
    return null;
  }
  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    this.created.push({ ownerId: data.ownerId });
    const t: Tenant = { id: `tenant-${this.byOwner.size + 1}`, ownerId: data.ownerId, ownerEmail: data.ownerEmail, name: data.name, createdAt: new Date() };
    this.byOwner.set(data.ownerId, t);
    return t;
  }
}

function makeInvitation(email: string): PendingInvitation {
  return {
    id: 'inv-1',
    tenantId: '11111111-1111-1111-1111-111111111111',
    email,
    role: 'staff',
    invitedBy: 'owner-1',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  } as PendingInvitation;
}

describe('Clerk user.created — invitee join with pool not wired (PR 319 P2)', () => {
  let markAccepted: ReturnType<typeof vi.fn>;
  let tenantRepo: FakeTenantRepo;
  let app: express.Express;

  beforeEach(() => {
    markAccepted = vi.fn(async () => undefined);
    tenantRepo = new FakeTenantRepo();
    const pendingInvitationRepo = {
      findPendingByEmail: vi.fn(async (email: string) => makeInvitation(email)),
      markAccepted,
    } as unknown as PendingInvitationRepository;

    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app = express();
    app.use(express.json());
    app.use(
      '/webhooks',
      createWebhookRouter(config, {
        tenantRepo,
        pendingInvitationRepo,
        // pool intentionally omitted → the invitee-join branch must bail safely.
      }),
    );
  });

  it('does not mark the invitation accepted and fails the webhook for Clerk retry', async () => {
    const payload = {
      type: 'user.created',
      data: { id: 'user_new', email_addresses: [{ email_address: 'invitee@example.com' }] },
    };
    const svixId = 'evt_pool_null';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .set('content-type', 'application/json')
      .send(payload);

    // The join failed (no pool) → the webhook fails so Clerk retries, rather
    // than bootstrapping a rogue tenant for the invitee.
    expect(res.status).toBe(500);
    // Critical invariant: the invitation was NOT consumed.
    expect(markAccepted).not.toHaveBeenCalled();
    // And NO separate tenant was bootstrapped for the invitee.
    expect(tenantRepo.created).toHaveLength(0);
  });
});
