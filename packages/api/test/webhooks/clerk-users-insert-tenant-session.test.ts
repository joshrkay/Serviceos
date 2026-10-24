/**
 * Clerk `user.created` — the two users INSERTs (the invitee's membership in
 * the inviting tenant, the bootstrapped owner's membership) each run in a
 * tenant session (raw-pg audit 2026-10-23 §4 P2.2): BEGIN, the tenant GUC +
 * rls_app_runtime in one statement, the INSERT, COMMIT, on one checkout —
 * not the old BEGIN + GUC-only set_config, which left the INSERT on the
 * privileged principal. Ordering is unchanged: the invitee row commits
 * before the invitation is marked accepted; a failed owner insert rolls its
 * session back and fails the webhook for Clerk's retry; a tenant id that is
 * not a UUID never reaches a checkout. Fake tenant pool
 * (test/helpers/fake-tenant-pool.ts); real Postgres in
 * test/integration/clerk-webhook-tenant-context.test.ts.
 */
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookRouter } from '../../src/webhooks/routes';
import type { AppConfig } from '../../src/shared/config';
import type { Tenant, TenantRepository } from '../../src/auth/clerk';
import type { PendingInvitation, PendingInvitationRepository } from '../../src/users/pending-invitation';
import { clerkUserCreatedEvent } from '../support/clerk-user-created';
import { fakeTenantPool, type FakeTenantPool } from '../helpers/fake-tenant-pool';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ=';
const INVITING_TENANT = '11111111-1111-4111-8111-111111111111';
const BOOTSTRAP_TENANT = '22222222-2222-4222-8222-222222222222';
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const CONTEXT_WITH_ROLE = "SELECT set_config('app.current_tenant_id', $1, true), set_config('role', 'rls_app_runtime', true)";

function sign(rawBody: string, svixId: string, svixTimestamp: string) {
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', secretBytes).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

class FakeTenantRepo implements TenantRepository {
  created: string[] = [];
  constructor(private readonly id: string) {}
  async findByOwner() {
    return null;
  }
  async findById() {
    return null;
  }
  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    this.created.push(data.ownerId);
    return { id: this.id, ownerId: data.ownerId, ownerEmail: data.ownerEmail, name: data.name, createdAt: new Date() };
  }
}

function invitation(tenantId: string): PendingInvitation {
  return {
    id: 'inv-1',
    tenantId,
    email: 'invitee@example.com',
    role: 'technician',
    clerkInvitationId: null,
    invitedBy: 'owner-1',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
  };
}

const verb = (sql: string) => (sql === CONTEXT_WITH_ROLE ? 'CONTEXT' : sql.trim().split(/\s+/)[0]!);

function build(opts: { tenantId?: string; invitationTenant?: string; failInsert?: boolean }) {
  const order: string[] = [];
  const fake: FakeTenantPool = fakeTenantPool((sql) => {
    if (/INSERT INTO users/.test(sql)) {
      order.push('users INSERT');
      if (opts.failInsert) throw new Error('transient insert failure');
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*COMMIT/.test(sql)) order.push('COMMIT');
    return undefined;
  });
  const markAccepted = vi.fn(async () => {
    order.push('markAccepted');
    return null;
  });
  const pendingInvitationRepo = opts.invitationTenant
    ? ({ findPendingByEmail: vi.fn(async () => invitation(opts.invitationTenant!)), findById: vi.fn(), markAccepted } as unknown as PendingInvitationRepository)
    : undefined;
  const tenantRepo = new FakeTenantRepo(opts.tenantId ?? BOOTSTRAP_TENANT);
  const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
  const app = express();
  app.use(express.json());
  app.use('/webhooks', createWebhookRouter(config, { tenantRepo, pendingInvitationRepo, pool: fake.pool }));
  const post = (userId: string) => {
    const rawBody = JSON.stringify(
      clerkUserCreatedEvent({ userId, emails: [{ address: 'invitee@example.com', status: 'verified' }] }),
    );
    const svixId = `evt_${crypto.randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    return request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', sign(rawBody, svixId, ts))
      .set('content-type', 'application/json')
      .send(rawBody);
  };
  return { fake, order, markAccepted, tenantRepo, post };
}

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

describe('Clerk user.created — the owner membership INSERT', () => {
  it('is one tenant session for the bootstrapped tenant: BEGIN, GUC + role, INSERT, COMMIT', async () => {
    const t = build({});

    const res = await t.post('user_owner_session');

    expect(res.status).toBe(200);
    expect(t.fake.statements.map((s) => [s.checkout, verb(s.sql)])).toEqual([
      [0, 'BEGIN'],
      [0, 'CONTEXT'],
      [0, 'INSERT'],
      [0, 'COMMIT'],
    ]);
    expect(t.fake.statements[1]!.values).toEqual([BOOTSTRAP_TENANT]);
    expect(t.fake.statements[2]!.values?.slice(0, 3)).toEqual([BOOTSTRAP_TENANT, 'user_owner_session', 'invitee@example.com']);
    expect(t.fake.statements[2]!.sql).toMatch(/WHERE NOT EXISTS/);
    expect(t.fake.open()).toBe(0);
  });

  it('a failed INSERT rolls its session back and fails the webhook (500) for Clerk to retry', async () => {
    const t = build({ failInsert: true });

    const res = await t.post('user_owner_fail');

    expect(res.status).toBe(500);
    expect(t.fake.statements.map((s) => verb(s.sql))).toEqual(['BEGIN', 'CONTEXT', 'INSERT', 'ROLLBACK']);
    expect(t.fake.open()).toBe(0);
  });

  it('a bootstrapped tenant id that is not a UUID skips the insert without a checkout, as before', async () => {
    const t = build({ tenantId: 'tenant-1' });

    const res = await t.post('user_owner_legacy');

    expect(res.status).toBe(200);
    expect(t.fake.checkouts()).toBe(0);
  });
});

describe('Clerk user.created — the invitee membership INSERT', () => {
  it("is one tenant session for the invitation's tenant, committed before the invitation is marked accepted", async () => {
    const t = build({ invitationTenant: INVITING_TENANT });

    const res = await t.post('user_invitee_session');

    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(INVITING_TENANT);
    expect(t.fake.statements.map((s) => [s.checkout, verb(s.sql)])).toEqual([
      [0, 'BEGIN'],
      [0, 'CONTEXT'],
      [0, 'INSERT'],
      [0, 'COMMIT'],
    ]);
    expect(t.fake.statements[1]!.values).toEqual([INVITING_TENANT]);
    expect(t.fake.statements[2]!.sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(t.order).toEqual(['users INSERT', 'COMMIT', 'markAccepted']);
    expect(t.tenantRepo.created).toEqual([]);
  });

  it('a failed INSERT rolls back, never marks the invitation accepted, and fails the webhook', async () => {
    const t = build({ invitationTenant: INVITING_TENANT, failInsert: true });

    const res = await t.post('user_invitee_fail');

    expect(res.status).toBe(500);
    expect(t.fake.statements.map((s) => verb(s.sql))).toEqual(['BEGIN', 'CONTEXT', 'INSERT', 'ROLLBACK']);
    expect(t.markAccepted).not.toHaveBeenCalled();
  });

  it('an invitation whose tenant id is not a UUID fails the join before any checkout', async () => {
    const t = build({ invitationTenant: 'not-a-uuid' });

    const res = await t.post('user_invitee_bad_tenant');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Invitee join failed' });
    expect(t.fake.checkouts()).toBe(0);
    expect(t.markAccepted).not.toHaveBeenCalled();
  });
});
