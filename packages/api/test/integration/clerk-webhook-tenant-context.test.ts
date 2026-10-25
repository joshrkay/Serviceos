/**
 * Postgres integration — the Clerk `user.created` users INSERTs run under the
 * RLS runtime role (raw-pg audit 2026-10-23 §4 P2.2).
 *
 * The invitee's membership in the inviting tenant and the bootstrapped
 * owner's membership were each inserted on a raw client after BEGIN and a
 * GUC-only set_config: the connection stayed the privileged principal, so
 * the users policy (and its WITH CHECK) never applied. Each now runs in a
 * tenant session (withTenantSession). With RLS_RUNTIME_ROLE on, this suite
 * drives the real /webhooks/clerk route and proves:
 *
 *   1. both INSERTs report `rls_app_runtime` with the row's tenant as the
 *      GUC; the rows land, the invitation is marked accepted after the
 *      membership row exists, and the audit rows are written as before;
 *   2. the owner INSERT's WHERE NOT EXISTS, with its tenant pin widened to
 *      both tenants, still inserts the owner's row (RLS hides the subject's
 *      membership in another tenant); control: as the principal the widened
 *      guard sees that other membership and the owner is left with no row;
 *   3. an INSERT re-stamped with another tenant is refused by WITH CHECK —
 *      the webhook fails (500) for Clerk's retry and, for the invitee, the
 *      invitation stays pending; control: as the principal it lands;
 *   4. the role keeps INSERT and SELECT on users after migration 219;
 *   5. idempotency: a redelivered signup (new svix id) leaves one owner row;
 *   6. the cost is unchanged: user.created and user.updated through the
 *      route with every repository on the counted pool.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, TENANT_CONTEXT_WITH_ROLE_SQL } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { InMemoryWebhookRepository } from '../../src/webhooks/webhook-handler';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgPendingInvitationRepository } from '../../src/users/pg-pending-invitation';
import type { AppConfig } from '../../src/shared/config';
import { clerkUserCreatedEvent } from '../support/clerk-user-created';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const USERS_INSERT = /INSERT INTO users/;

let pool: Pool;
const tenantIds: string[] = [];
const clerkIds: string[] = [];

function sign(rawBody: string, svixId: string, ts: string): string {
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  return `v1,${crypto.createHmac('sha256', secretBytes).update(`${svixId}.${ts}.${rawBody}`).digest('base64')}`;
}

/** The /webhooks/clerk route with `usersPool` as `deps.pool` (the two INSERTs) and `reposPool` behind every repository. */
function buildApp(usersPool: Pool, reposPool: Pool = pool, opts: { pgWebhookRepo?: boolean } = {}) {
  const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
  const app = express();
  app.use(express.json());
  app.use(
    '/webhooks',
    createWebhookRouter(config, {
      tenantRepo: new PgTenantRepository(reposPool),
      pool: usersPool,
      webhookRepo: opts.pgWebhookRepo ? new PgWebhookRepository(reposPool) : new InMemoryWebhookRepository(),
      auditRepo: new PgAuditRepository(reposPool),
      pendingInvitationRepo: new PgPendingInvitationRepository(reposPool),
    }),
  );
  return app;
}

function post(app: express.Express, payload: object, svixId = `evt_${crypto.randomUUID()}`) {
  const rawBody = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app)
    .post('/webhooks/clerk')
    .set('svix-id', svixId)
    .set('svix-timestamp', ts)
    .set('svix-signature', sign(rawBody, svixId, ts))
    .set('content-type', 'application/json')
    .send(rawBody);
}

function newClerkUser(label: string): { clerk: string; email: string } {
  const clerk = `user_${label}_${crypto.randomUUID()}`;
  clerkIds.push(clerk);
  return { clerk, email: `${crypto.randomUUID()}@example.com` };
}

const signup = (clerk: string, email: string) =>
  clerkUserCreatedEvent({ userId: clerk, emails: [{ address: email, status: 'verified' }] });

async function seedTenant(): Promise<{ tenantId: string; userId: string }> {
  const t = await createTestTenant(pool);
  tenantIds.push(t.tenantId);
  return t;
}

/** A tenants row already owned by `clerk` (so bootstrap returns it, created=false) and no membership row yet. */
async function seedOwnedTenant(clerk: string, email: string): Promise<string> {
  const tenantId = crypto.randomUUID();
  tenantIds.push(tenantId);
  await pool.query(`INSERT INTO tenants (id, owner_id, owner_email, name) VALUES ($1, $2, $3, 'Owned Co')`, [tenantId, clerk, email]);
  return tenantId;
}

async function memberships(clerk: string): Promise<Array<{ tenant_id: string; role: string }>> {
  const { rows } = await pool.query<{ tenant_id: string; role: string }>(
    `SELECT tenant_id, role FROM users WHERE clerk_user_id = $1 ORDER BY created_at`,
    [clerk],
  );
  return rows;
}

async function invite(email: string): Promise<{ tenantId: string; invitationId: string }> {
  const inviter = await seedTenant();
  const invitation = await new PgPendingInvitationRepository(pool).create({
    tenantId: inviter.tenantId,
    email,
    role: 'dispatcher',
    invitedBy: inviter.userId,
  });
  return { tenantId: inviter.tenantId, invitationId: invitation.id };
}

async function acceptedAt(invitationId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ accepted_at: Date | null }>(`SELECT accepted_at FROM pending_invitations WHERE id = $1`, [invitationId]);
  return rows[0]?.accepted_at ?? null;
}

async function auditTypes(tenantId: string): Promise<string[]> {
  const { rows } = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM audit_events WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows.map((r) => r.event_type);
}

type QueryFn = (text: unknown, values?: unknown) => Promise<QueryResult>;

/**
 * Re-stamp the users INSERT's tenant column (`$1` in the VALUES / SELECT list,
 * still referenced) with `other`. Under the tenant role the policy's WITH
 * CHECK refuses the row; `asPrincipal` (RESET ROLE first) is the control.
 */
function restampUsersInsert(real: Pool, other: string, opts: { asPrincipal?: boolean } = {}): { pool: Pool; rewritten: string[] } {
  const rewritten: string[] = [];
  const stamp = `(CASE WHEN $1::uuid IS NOT NULL THEN '${other}'::uuid END)`;
  const connect = async (): Promise<PoolClient> => {
    const client = await real.connect();
    const inner = client.query as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = async (text, values) => {
      const sql = typeof text === 'string' ? text : null;
      if (sql === null || !USERS_INSERT.test(sql)) return inner.call(client, text, values);
      const next = sql.replace(/gen_random_uuid\(\),\s*\$1,/, `gen_random_uuid(), ${stamp},`);
      rewritten.push(next);
      if (opts.asPrincipal) await inner.call(client, 'RESET ROLE');
      return inner.call(client, next, values);
    };
    const innerRelease = client.release;
    client.release = (err?: Error | boolean) => {
      delete (client as unknown as { query?: QueryFn }).query;
      return innerRelease(err);
    };
    return client;
  };
  const query = async (text: unknown, values?: unknown): Promise<QueryResult> => {
    const client = await connect();
    try {
      return await (client.query as unknown as QueryFn)(text, values);
    } finally {
      client.release();
    }
  };
  const proxied = new Proxy(real, {
    get(target, prop) {
      if (prop === 'connect') return connect;
      if (prop === 'query') return query;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { pool: proxied, rewritten };
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE owner_id = ANY($1::text[])`, [clerkIds]);
  for (const id of [...tenantIds, ...rows.map((r) => r.id)]) {
    for (const table of ['pending_invitations', 'audit_events', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('Clerk user.created — both users INSERTs under the RLS runtime role (real Postgres)', () => {
  it("the owner's membership INSERT runs as rls_app_runtime for the bootstrapped tenant; the row and the signup audit land", async () => {
    const { clerk, email } = newClerkUser('owner');
    const probe = probeStatementRoles(pool, USERS_INSERT);

    const res = await post(buildApp(probe.pool), signup(clerk, email));

    expect(res.status).toBe(200);
    const rows = await memberships(clerk);
    expect(rows).toEqual([{ tenant_id: expect.any(String), role: 'owner' }]);
    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: rows[0]!.tenant_id })]);
    expect(await auditTypes(rows[0]!.tenant_id)).toContain('tenant.signup.bootstrap.completed');
  });

  it("the invitee's membership INSERT runs as rls_app_runtime for the inviting tenant; the invitation is accepted after it, and audited", async () => {
    const { clerk, email } = newClerkUser('invitee');
    const inv = await invite(email);
    const probe = probeStatementRoles(pool, USERS_INSERT);

    const res = await post(buildApp(probe.pool), signup(clerk, email));

    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(inv.tenantId);
    expect(await memberships(clerk)).toEqual([{ tenant_id: inv.tenantId, role: 'dispatcher' }]);
    expect(await acceptedAt(inv.invitationId)).not.toBeNull();
    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: inv.tenantId })]);
    expect(await auditTypes(inv.tenantId)).toContain('tenant.invitation.accepted');
  });

  it('a redelivered signup (a new svix id) still leaves exactly one owner row', async () => {
    const { clerk, email } = newClerkUser('redelivered');
    const app = buildApp(pool);

    expect((await post(app, signup(clerk, email))).status).toBe(200);
    expect((await post(app, signup(clerk, email))).status).toBe(200);

    expect(await memberships(clerk)).toEqual([{ tenant_id: expect.any(String), role: 'owner' }]);
  });
});

describe("Clerk user.created — RLS alone keeps the owner INSERT's guard to its own tenant (real Postgres)", () => {
  /** The subject owns `owned` (no membership yet) and is already a member of `other`. */
  async function widenedOwnerInsert(asPrincipal: boolean) {
    const { clerk, email } = newClerkUser('widened');
    const owned = await seedOwnedTenant(clerk, email);
    const other = await seedTenant();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'technician')`,
      [crypto.randomUUID(), other.tenantId, clerk, email],
    );
    const widened = widenTenantPredicates(pool, { target: USERS_INSERT, tenants: [owned, other.tenantId], asPrincipal });

    const res = await post(buildApp(widened.pool), signup(clerk, email));

    expect(res.status).toBe(200);
    expect(widened.rewritten).toHaveLength(1);
    expect(widened.rewritten[0]).toMatch(/WHERE NOT EXISTS/);
    return { owned, other: other.tenantId, rows: await memberships(clerk) };
  }

  it("with the WHERE NOT EXISTS pin widened to both tenants, the subject's other membership stays hidden: the owner row is inserted", async () => {
    const r = await widenedOwnerInsert(false);
    expect(r.rows).toEqual([
      { tenant_id: r.other, role: 'technician' },
      { tenant_id: r.owned, role: 'owner' },
    ]);
  });

  it('control: the same widened guard run as the connection principal sees the other membership, and the owner gets no row', async () => {
    const r = await widenedOwnerInsert(true);
    expect(r.rows).toEqual([{ tenant_id: r.other, role: 'technician' }]);
  });
});

describe('Clerk user.created — a users row stamped for another tenant is refused by WITH CHECK (real Postgres)', () => {
  it('the owner INSERT re-stamped: refused, the webhook fails (500) for the retry, no row anywhere', async () => {
    const { clerk, email } = newClerkUser('restamp_owner');
    const other = await seedTenant();
    const restamped = restampUsersInsert(pool, other.tenantId);

    const res = await post(buildApp(restamped.pool), signup(clerk, email));

    expect(res.status).toBe(500);
    expect(restamped.rewritten).toHaveLength(1);
    expect(await memberships(clerk)).toEqual([]);
  });

  it('control: the same re-stamped owner INSERT as the connection principal lands in the other tenant', async () => {
    const { clerk, email } = newClerkUser('restamp_owner_principal');
    const other = await seedTenant();
    const restamped = restampUsersInsert(pool, other.tenantId, { asPrincipal: true });

    const res = await post(buildApp(restamped.pool), signup(clerk, email));

    expect(res.status).toBe(200);
    expect(await memberships(clerk)).toEqual([{ tenant_id: other.tenantId, role: 'owner' }]);
  });

  it('the invitee INSERT re-stamped: refused, the join fails (500) and the invitation stays pending', async () => {
    const { clerk, email } = newClerkUser('restamp_invitee');
    const inv = await invite(email);
    const other = await seedTenant();
    const restamped = restampUsersInsert(pool, other.tenantId);

    const res = await post(buildApp(restamped.pool), signup(clerk, email));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Invitee join failed' });
    expect(await memberships(clerk)).toEqual([]);
    expect(await acceptedAt(inv.invitationId)).toBeNull();
  });

  it('control: the same re-stamped invitee INSERT as the connection principal lands in the other tenant', async () => {
    const { clerk, email } = newClerkUser('restamp_invitee_principal');
    await invite(email);
    const other = await seedTenant();
    const restamped = restampUsersInsert(pool, other.tenantId, { asPrincipal: true });

    const res = await post(buildApp(restamped.pool), signup(clerk, email));

    expect(res.status).toBe(200);
    expect(await memberships(clerk)).toEqual([{ tenant_id: other.tenantId, role: 'dispatcher' }]);
  });
});

describe('grants: rls_app_runtime keeps what the Clerk users INSERTs need after migration 219', () => {
  it('users stays insertable and readable (the WHERE NOT EXISTS guard)', async () => {
    expect(await runtimeRoleGrantsMissingAfter219(pool, [['users', 'INSERT'], ['users', 'SELECT']])).toEqual([]);
  });
});

describe('Clerk webhook — cost through the route, every repository on the counted pool (real Postgres)', () => {
  const cost = (traffic: ReturnType<typeof countPoolTraffic>) => ({
    checkouts: traffic.checkouts(),
    statements: traffic.statements().length,
    maxOpen: traffic.maxOpen(),
  });

  it("user.created (owner signup): the membership INSERT is one session, BEGIN, GUC + role, INSERT, COMMIT — the same 1 / 4 as base's GUC-only block", async () => {
    const { clerk, email } = newClerkUser('cost_owner');
    const traffic = countPoolTraffic(pool);

    const res = await post(buildApp(traffic.pool, traffic.pool, { pgWebhookRepo: true }), signup(clerk, email));

    expect(res.status).toBe(200);
    const ran = traffic.statements();
    const insertAt = ran.findIndex((s) => USERS_INSERT.test(s));
    expect(ran.slice(insertAt - 2, insertAt + 2)).toEqual(['BEGIN', TENANT_CONTEXT_WITH_ROLE_SQL, ran[insertAt], 'COMMIT']);
    expect(cost(traffic)).toEqual({ checkouts: 8, statements: 16, maxOpen: 1 });
  });

  it('user.created (invitee join) and user.updated: unchanged from base', async () => {
    const { clerk, email } = newClerkUser('cost_invitee');
    await invite(email);
    const joined = countPoolTraffic(pool);
    expect((await post(buildApp(joined.pool, joined.pool, { pgWebhookRepo: true }), signup(clerk, email))).status).toBe(200);
    expect(cost(joined)).toEqual({ checkouts: 7, statements: 15, maxOpen: 1 });

    const updated = countPoolTraffic(pool);
    const res = await post(buildApp(updated.pool, updated.pool, { pgWebhookRepo: true }), {
      type: 'user.updated',
      data: { id: clerk },
    });
    expect(res.status).toBe(200);
    expect(cost(updated)).toEqual({ checkouts: 3, statements: 3, maxOpen: 1 });
  });
});
