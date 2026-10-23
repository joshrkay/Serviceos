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
 *
 * The skipped join is logged at warn only when the sign-up was an
 * invitation's — it carries an invitation id, or a pending invitation exists
 * for the address. Most unverified sign-ups are ordinary owners who
 * bootstrap; warning on every one of them would bury the invitee case.
 */
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const warn = vi.fn();
vi.mock('../../src/logging/logger', async (orig) => {
  const real = await orig<typeof import('../../src/logging/logger')>();
  return {
    ...real,
    createLogger: (opts: Parameters<typeof real.createLogger>[0]) => {
      const l = real.createLogger(opts);
      return { ...l, warn: (...a: unknown[]) => warn(...a) };
    },
  };
});

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
    warn.mockClear();
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

  /** The "join skipped" warns this handler logged, as [message, meta] pairs. */
  function joinSkippedWarns(): Array<[string, Record<string, unknown>]> {
    return (warn.mock.calls as Array<[string, Record<string, unknown>]>).filter(([message]) =>
      /not verified — invitation join skipped/.test(message),
    );
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
      expectBootstrappedNotJoined(res, `user_${status}`);
      // A pending invitation exists for the address, so the skip is warned.
      expect(joinSkippedWarns()).toEqual([[expect.any(String), { userId: `user_${status}` }]]);
    },
  );

  it('email fallback: a primary address with no verification object does not join', async () => {
    const res = await post(
      clerkUserCreatedEvent({
        userId: 'user_noverif',
        emails: [{ address: 'invitee@example.com', status: null }],
      }),
    );
    expectBootstrappedNotJoined(res, 'user_noverif');
  });

  it('email fallback: the legacy bare { email_address } shape does not join', async () => {
    const res = await post({
      type: 'user.created',
      data: { id: 'user_bare', email_addresses: [{ email_address: 'invitee@example.com' }] },
    });
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
    expect(joinSkippedWarns()).toEqual([
      [expect.any(String), { userId: 'user_id_unverified', invitationId: 'inv-1' }],
    ]);
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
    expect(joinSkippedWarns()).toEqual([]);
  });

  describe('the skipped-join warn', () => {
    it('is not logged for an unverified sign-up with no invitation id and no pending invitation', async () => {
      findPendingByEmail.mockResolvedValue(null);
      const res = await post(
        clerkUserCreatedEvent({
          userId: 'user_owner_unverified',
          emails: [{ address: 'new-owner@example.com', status: 'unverified' }],
        }),
      );
      expectBootstrappedNotJoined(res, 'user_owner_unverified');
      expect(findPendingByEmail).toHaveBeenCalledWith('new-owner@example.com');
      expect(joinSkippedWarns()).toEqual([]);
    });

    it('is not logged when the pending-invitation lookup fails (no evidence of an invitation)', async () => {
      findPendingByEmail.mockRejectedValue(new Error('db down'));
      const res = await post(
        clerkUserCreatedEvent({
          userId: 'user_lookup_down',
          emails: [{ address: 'invitee@example.com', status: 'unverified' }],
        }),
      );
      expectBootstrappedNotJoined(res, 'user_lookup_down');
      expect(joinSkippedWarns()).toEqual([]);
    });

    it('is logged once for an unverified sign-up whose address has a pending invitation', async () => {
      const res = await post(
        clerkUserCreatedEvent({
          userId: 'user_invited_unverified',
          emails: [{ address: 'invitee@example.com', status: 'unverified' }],
        }),
      );
      expectBootstrappedNotJoined(res, 'user_invited_unverified');
      expect(findPendingByEmail).toHaveBeenCalledTimes(1);
      expect(joinSkippedWarns()).toEqual([[expect.any(String), { userId: 'user_invited_unverified' }]]);
    });

    it('is not logged for a verified sign-up with no invitation', async () => {
      findPendingByEmail.mockResolvedValue(null);
      const res = await post(
        clerkUserCreatedEvent({
          userId: 'user_owner_verified',
          emails: [{ address: 'new-owner@example.com', status: 'verified' }],
        }),
      );
      expect(res.status).toBe(200);
      expect(joinSkippedWarns()).toEqual([]);
    });
  });
});
