/**
 * Clerk `user.created` — an invitation join hands the new user a seat in an
 * EXISTING tenant, so it must rest on an email address Clerk reports as
 * verified. The email-fallback lookup (no `public_metadata.invitation_id`)
 * matches any pending invitation for the address; without the verified gate
 * an account created with an invited, unverified address would land in the
 * inviting tenant. The id lookup's email sanity check has the same
 * dependency.
 *
 * An unverified (or missing-verification) primary address skips the join
 * and falls through to the bootstrap path — the same safe outcome the
 * handler already takes for a stale or mismatched invitation id.
 *
 * Payloads are real-shaped (primary_email_address_id + email_addresses[]
 * with verification), see test/support/clerk-user-created.ts.
 */
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { createWebhookRouter } from '../../src/webhooks/routes';
import type { AppConfig } from '../../src/shared/config';
import { TenantRepository, Tenant } from '../../src/auth/clerk';
import { PendingInvitation, PendingInvitationRepository } from '../../src/users/pending-invitation';
import { clerkUserCreatedEvent } from '../support/clerk-user-created';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ=';
const INVITING_TENANT = '11111111-1111-4111-8111-111111111111';

function sign(rawBody: string, svixId: string, svixTimestamp: string) {
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto
    .createHmac('sha256', secretBytes)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

class FakeTenantRepo implements TenantRepository {
  created: Array<{ ownerId: string; ownerEmail: string }> = [];
  private byOwner = new Map<string, Tenant>();
  async findByOwner(ownerId: string) {
    return this.byOwner.get(ownerId) ?? null;
  }
  async findById() {
    return null;
  }
  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    this.created.push({ ownerId: data.ownerId, ownerEmail: data.ownerEmail });
    const t: Tenant = {
      id: `tenant-${this.byOwner.size + 1}`,
      ownerId: data.ownerId,
      ownerEmail: data.ownerEmail,
      name: data.name,
      createdAt: new Date(),
    };
    this.byOwner.set(data.ownerId, t);
    return t;
  }
}

function invitation(email: string): PendingInvitation {
  return {
    id: 'inv-1',
    tenantId: INVITING_TENANT,
    email,
    role: 'technician',
    clerkInvitationId: null,
    invitedBy: 'owner-1',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
  };
}

describe('Clerk user.created — invitation join requires a verified primary email', () => {
  let tenantRepo: FakeTenantRepo;
  let findPendingByEmail: ReturnType<typeof vi.fn>;
  let findById: ReturnType<typeof vi.fn>;
  let markAccepted: ReturnType<typeof vi.fn>;
  let userInserts: unknown[][];
  let app: express.Express;

  beforeEach(() => {
    tenantRepo = new FakeTenantRepo();
    findPendingByEmail = vi.fn(async (email: string) => invitation(email));
    findById = vi.fn(async () => invitation('invitee@example.com'));
    markAccepted = vi.fn(async () => null);
    userInserts = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          if (/INSERT INTO users/.test(sql)) userInserts.push(params ?? []);
          return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
      }),
    } as unknown as Pool;
    const pendingInvitationRepo = {
      findPendingByEmail,
      findById,
      markAccepted,
    } as unknown as PendingInvitationRepository;
    const config = {
      CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CLERK_SECRET_KEY: undefined,
    } as unknown as AppConfig;
    app = express();
    app.use(express.json());
    app.use('/webhooks', createWebhookRouter(config, { tenantRepo, pendingInvitationRepo, pool }));
  });

  function post(payload: object) {
    const rawBody = JSON.stringify(payload);
    const svixId = `evt_${crypto.randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    return request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', sign(rawBody, svixId, ts))
      .set('content-type', 'application/json')
      .send(rawBody);
  }

  function expectBootstrappedNotJoined(res: request.Response, userId: string) {
    expect(res.status).toBe(200);
    expect(res.body.joined).toBeUndefined();
    expect(userInserts).toHaveLength(0);
    expect(markAccepted).not.toHaveBeenCalled();
    expect(tenantRepo.created.map((t) => t.ownerId)).toEqual([userId]);
  }

  it('email fallback: a verified primary address joins the inviting tenant', async () => {
    const res = await post(
      clerkUserCreatedEvent({
        userId: 'user_ok',
        emails: [{ address: 'invitee@example.com', status: 'verified' }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(INVITING_TENANT);
    expect(findPendingByEmail).toHaveBeenCalledWith('invitee@example.com');
    expect(userInserts).toHaveLength(1);
    expect(userInserts[0]).toEqual(
      expect.arrayContaining([INVITING_TENANT, 'user_ok', 'invitee@example.com', 'technician']),
    );
    expect(markAccepted).toHaveBeenCalledWith('inv-1');
    expect(tenantRepo.created).toHaveLength(0);
  });

  it.each(['unverified', 'expired', 'failed', 'transferable'] as const)(
    'email fallback: a primary address whose verification is %s does not join',
    async (status) => {
      const res = await post(
        clerkUserCreatedEvent({
          userId: `user_${status}`,
          emails: [{ address: 'invitee@example.com', status }],
        }),
      );
      expect(findPendingByEmail).not.toHaveBeenCalled();
      expectBootstrappedNotJoined(res, `user_${status}`);
    },
  );

  it('email fallback: a primary address with no verification object does not join', async () => {
    const res = await post(
      clerkUserCreatedEvent({
        userId: 'user_noverif',
        emails: [{ address: 'invitee@example.com', status: null }],
      }),
    );
    expect(findPendingByEmail).not.toHaveBeenCalled();
    expectBootstrappedNotJoined(res, 'user_noverif');
  });

  it('email fallback: the legacy bare { email_address } shape does not join', async () => {
    const res = await post({
      type: 'user.created',
      data: { id: 'user_bare', email_addresses: [{ email_address: 'invitee@example.com' }] },
    });
    expect(findPendingByEmail).not.toHaveBeenCalled();
    expectBootstrappedNotJoined(res, 'user_bare');
  });

  it('a verified secondary address does not stand in for an unverified primary', async () => {
    const res = await post(
      clerkUserCreatedEvent({
        userId: 'user_secondary',
        emails: [
          { address: 'invitee@example.com', status: 'verified' },
          { address: 'mine@example.com', status: 'unverified' },
        ],
        primaryIndex: 1,
      }),
    );
    expect(findPendingByEmail).not.toHaveBeenCalled();
    expectBootstrappedNotJoined(res, 'user_secondary');
  });

  it('looks the invitation up by the verified PRIMARY address, not the first entry', async () => {
    const res = await post(
      clerkUserCreatedEvent({
        userId: 'user_primary',
        emails: [
          { address: 'invitee@example.com', status: 'unverified' },
          { address: 'mine@example.com', status: 'verified' },
        ],
        primaryIndex: 1,
      }),
    );
    expect(res.status).toBe(200);
    expect(findPendingByEmail).toHaveBeenCalledTimes(1);
    expect(findPendingByEmail).toHaveBeenCalledWith('mine@example.com');
  });

  it('id lookup: an unverified primary address does not join even with a matching invitation id', async () => {
    const res = await post(
      clerkUserCreatedEvent({
        userId: 'user_id_unverified',
        emails: [{ address: 'invitee@example.com', status: 'unverified' }],
        publicMetadata: { invitation_id: 'inv-1' },
      }),
    );
    expect(findById).not.toHaveBeenCalled();
    expect(findPendingByEmail).not.toHaveBeenCalled();
    expectBootstrappedNotJoined(res, 'user_id_unverified');
  });

  it('id lookup: a verified primary address that matches the invitation joins', async () => {
    const res = await post(
      clerkUserCreatedEvent({
        userId: 'user_id_ok',
        emails: [{ address: 'invitee@example.com', status: 'verified', strategy: 'ticket' }],
        publicMetadata: { invitation_id: 'inv-1' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(INVITING_TENANT);
    expect(findById).toHaveBeenCalledWith('inv-1');
    expect(findPendingByEmail).not.toHaveBeenCalled();
    expect(userInserts).toHaveLength(1);
  });
});
