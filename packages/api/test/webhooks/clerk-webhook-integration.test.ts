/**
 * Integration test for the Clerk webhook → tenant bootstrap flow.
 *
 * Covers the failure mode that silently breaks new signups: the Clerk
 * `user.created` webhook fires, but something in the route is misconfigured
 * (secret mismatch, header shape, etc.), so the tenant is never created.
 * The user ends up with a valid Clerk session but no backend tenant row,
 * and every API call 403s.
 *
 * This test posts a properly signed Svix-style payload to the live route
 * and asserts the TenantRepository got a matching create() call.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { Tenant, TenantRepository } from '../../src/auth/clerk';
import type { AppConfig } from '../../src/shared/config';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryQueue } from '../../src/queues/queue';
import { PROVISION_TWILIO_JOB_TYPE } from '../../src/workers/provision-twilio';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

function buildTestApp(
  tenantRepo?: TenantRepository,
  secret: string = WEBHOOK_SECRET,
  extras: {
    provisioningQueue?: { send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string> };
    auditRepo?: InMemoryAuditRepository;
  } = {}
) {
  const app = express();
  app.use(express.json());
  const config = { CLERK_WEBHOOK_SECRET: secret, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
  app.use('/webhooks', createWebhookRouter(config, { tenantRepo, ...extras }));
  return app;
}

/**
 * Mirrors the PRODUCTION mount: express.raw() for /webhooks/clerk BEFORE the
 * global express.json(), so the handler verifies over the exact signed bytes.
 */
function buildRawMountedApp(tenantRepo?: TenantRepository, secret: string = WEBHOOK_SECRET) {
  const app = express();
  app.use('/webhooks/clerk', express.raw({ type: 'application/json' }));
  app.use(express.json());
  const config = { CLERK_WEBHOOK_SECRET: secret, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
  app.use('/webhooks', createWebhookRouter(config, { tenantRepo }));
  return app;
}

class FakeTenantRepository implements TenantRepository {
  public created: Array<{ ownerId: string; ownerEmail: string; name: string }> = [];
  private byOwner = new Map<string, Tenant>();

  async findByOwner(ownerId: string): Promise<Tenant | null> {
    return this.byOwner.get(ownerId) ?? null;
  }

  async findById(id: string): Promise<Tenant | null> {
    for (const t of this.byOwner.values()) {
      if (t.id === id) return t;
    }
    return null;
  }

  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    this.created.push(data);
    const tenant: Tenant = {
      id: `tenant-${this.byOwner.size + 1}`,
      ownerId: data.ownerId,
      ownerEmail: data.ownerEmail,
      name: data.name,
      createdAt: new Date(),
    };
    this.byOwner.set(data.ownerId, tenant);
    return tenant;
  }
}

function signSvixPayload(body: object, svixId: string, svixTimestamp: string, secret: string) {
  const rawBody = JSON.stringify(body);
  // The route reconstructs the signed content as `${svixId}.${svixTimestamp}.${rawBody}`,
  // decodes the secret from base64 (stripping the `whsec_` prefix), and passes the
  // hex string of the decoded bytes as the HMAC key. Mirror that here so the test
  // signature round-trips through verifyWebhookSignature exactly.
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');
  return { rawBody, signature: `v1,${sig}` };
}

function userCreatedPayload(userId: string, email: string) {
  return {
    type: 'user.created',
    data: {
      id: userId,
      email_addresses: [{ email_address: email }],
    },
  };
}

describe('EXP-3 — Clerk webhook → tenant bootstrap integration', () => {
  let tenantRepo: FakeTenantRepository;
  let app: express.Express;

  beforeEach(() => {
    tenantRepo = new FakeTenantRepository();
    app = buildTestApp(tenantRepo);
  });

  it('happy path — valid user.created webhook bootstraps a tenant', async () => {
    const svixId = 'evt_happy_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload('user_new_1', 'new@example.com');
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(tenantRepo.created).toHaveLength(1);
    expect(tenantRepo.created[0]).toMatchObject({
      ownerId: 'user_new_1',
      ownerEmail: 'new@example.com',
    });
  });

  it('raw-mounted (production) path — verifies over the exact signed bytes', async () => {
    const rawApp = buildRawMountedApp(tenantRepo);
    const svixId = 'evt_raw_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload('user_raw_1', 'raw@example.com');
    const { rawBody, signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);

    const res = await request(rawApp)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .set('content-type', 'application/json')
      .send(rawBody); // exact signed bytes

    expect(res.status).toBe(200);
    expect(tenantRepo.created).toHaveLength(1);
  });

  it('raw-mounted path verifies bytes that JSON.stringify would NOT reproduce', async () => {
    // The regression: the old handler verified over JSON.stringify(req.body),
    // so a body with non-canonical key order / extra whitespace (exactly what
    // svix signs but V8 re-serialization changes) would be rejected. Sign and
    // send such bytes; the raw-bytes path must accept them.
    const rawApp = buildRawMountedApp(tenantRepo);
    const svixId = 'evt_raw_2';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    // Keys out of insertion order + spaces: re-serialization would differ.
    const rawBody =
      '{ "data": {"email_addresses": [{"email_address": "noncanon@example.com"}], "id": "user_raw_2"}, "type": "user.created" }';
    const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
    const sig = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    const res = await request(rawApp)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', `v1,${sig}`)
      .set('content-type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(tenantRepo.created[0]).toMatchObject({ ownerId: 'user_raw_2', ownerEmail: 'noncanon@example.com' });
  });

  it('idempotency — replaying the same svix-id does not double-bootstrap', async () => {
    const svixId = 'evt_dup_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload('user_new_2', 'dup@example.com');
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);

    const first = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    // Exactly one create, regardless of retries.
    expect(tenantRepo.created).toHaveLength(1);
  });

  it('validation — rejects invalid signature with 401 and does not bootstrap', async () => {
    const svixId = 'evt_bad_sig';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload('user_never', 'never@example.com');

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', 'v1,deadbeef')
      .send(payload);

    expect(res.status).toBe(401);
    expect(tenantRepo.created).toHaveLength(0);
  });

  it('validation — rejects missing svix headers with 400', async () => {
    const payload = userCreatedPayload('user_never_2', 'never2@example.com');

    const res = await request(app).post('/webhooks/clerk').send(payload);

    expect(res.status).toBe(400);
    expect(tenantRepo.created).toHaveLength(0);
  });

  it('configuration — 500 when CLERK_WEBHOOK_SECRET is not set', async () => {
    const appNoSecret = buildTestApp(tenantRepo, '');

    const res = await request(appNoSecret)
      .post('/webhooks/clerk')
      .set('svix-id', 'evt_no_secret')
      .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('svix-signature', 'v1,whatever')
      .send(userCreatedPayload('user_noop', 'noop@example.com'));

    expect(res.status).toBe(500);
    expect(tenantRepo.created).toHaveLength(0);
  });

  it('idempotency — bootstrapTenant is not called again for an existing owner', async () => {
    // Pre-seed a tenant for this owner.
    await tenantRepo.create({
      ownerId: 'user_existing',
      ownerEmail: 'existing@example.com',
      name: 'Existing Org',
    });
    expect(tenantRepo.created).toHaveLength(1);

    const svixId = 'evt_existing';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload('user_existing', 'existing@example.com');
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);

    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);

    expect(res.status).toBe(200);
    // Still only the pre-seeded create; the webhook path hit findByOwner short-circuit.
    expect(tenantRepo.created).toHaveLength(1);
  });

  // ───────────────────────────────────────────────────────────────────────
  // QUALITY-2026-07-12 WS4 — svix-timestamp replay-window enforcement.
  // ───────────────────────────────────────────────────────────────────────
  describe('WS4 — replay tolerance', () => {
    it('rejects a stale timestamp (> 5 min old) with 400 and does not bootstrap', async () => {
      const svixId = 'evt_stale';
      const staleTs = String(Math.floor(Date.now() / 1000) - 400); // 6m40s old
      const payload = userCreatedPayload('user_stale', 'stale@example.com');
      // Correctly signed for the stale timestamp — proves we reject on the
      // timestamp window BEFORE (and independent of) signature validity.
      const { signature } = signSvixPayload(payload, svixId, staleTs, WEBHOOK_SECRET);

      const res = await request(app)
        .post('/webhooks/clerk')
        .set('svix-id', svixId)
        .set('svix-timestamp', staleTs)
        .set('svix-signature', signature)
        .send(payload);

      expect(res.status).toBe(400);
      expect(tenantRepo.created).toHaveLength(0);
    });

    it('rejects a future-skewed timestamp (> 5 min ahead) with 400', async () => {
      const svixId = 'evt_future';
      const futureTs = String(Math.floor(Date.now() / 1000) + 400);
      const payload = userCreatedPayload('user_future', 'future@example.com');
      const { signature } = signSvixPayload(payload, svixId, futureTs, WEBHOOK_SECRET);

      const res = await request(app)
        .post('/webhooks/clerk')
        .set('svix-id', svixId)
        .set('svix-timestamp', futureTs)
        .set('svix-signature', signature)
        .send(payload);

      expect(res.status).toBe(400);
      expect(tenantRepo.created).toHaveLength(0);
    });

    it('rejects a malformed (non-numeric) timestamp with 400', async () => {
      const svixId = 'evt_malformed';
      const payload = userCreatedPayload('user_malformed', 'malformed@example.com');
      const { signature } = signSvixPayload(payload, svixId, 'not-a-number', WEBHOOK_SECRET);

      const res = await request(app)
        .post('/webhooks/clerk')
        .set('svix-id', svixId)
        .set('svix-timestamp', 'not-a-number')
        .set('svix-signature', signature)
        .send(payload);

      expect(res.status).toBe(400);
      expect(tenantRepo.created).toHaveLength(0);
    });

    it('accepts a fresh timestamp within tolerance (bootstraps normally)', async () => {
      const svixId = 'evt_fresh';
      const freshTs = String(Math.floor(Date.now() / 1000) - 30); // well inside 5m
      const payload = userCreatedPayload('user_fresh', 'fresh@example.com');
      const { signature } = signSvixPayload(payload, svixId, freshTs, WEBHOOK_SECRET);

      const res = await request(app)
        .post('/webhooks/clerk')
        .set('svix-id', svixId)
        .set('svix-timestamp', freshTs)
        .set('svix-signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(tenantRepo.created).toHaveLength(1);
    });

    it('event-id idempotency survives replay with a DIFFERENT fresh timestamp', async () => {
      // The durable event-id dedup (source, idempotency_key = svix-id) must
      // still catch a replay even when the attacker re-stamps a fresh, in-
      // tolerance timestamp (so the replay-window check passes). Same svix-id,
      // new timestamp+signature → deduped, exactly one bootstrap.
      const svixId = 'evt_replay_fresh_ts';
      const ts1 = String(Math.floor(Date.now() / 1000) - 60);
      const payload = userCreatedPayload('user_replay_fresh', 'replayfresh@example.com');
      const first = signSvixPayload(payload, svixId, ts1, WEBHOOK_SECRET);

      const r1 = await request(app)
        .post('/webhooks/clerk')
        .set('svix-id', svixId)
        .set('svix-timestamp', ts1)
        .set('svix-signature', first.signature)
        .send(payload);
      expect(r1.status).toBe(200);

      // Replay: same event id, a fresh (different but in-tolerance) timestamp,
      // re-signed so signature verification also passes.
      const ts2 = String(Math.floor(Date.now() / 1000)); // different, still fresh
      const second = signSvixPayload(payload, svixId, ts2, WEBHOOK_SECRET);
      const r2 = await request(app)
        .post('/webhooks/clerk')
        .set('svix-id', svixId)
        .set('svix-timestamp', ts2)
        .set('svix-signature', second.signature)
        .send(payload);
      expect(r2.status).toBe(200);
      expect(r2.body).toEqual({ received: true, duplicate: true });

      // Exactly one bootstrap despite the fresh-timestamp replay.
      expect(tenantRepo.created).toHaveLength(1);
    });
  });

  it('awaits the durable provisioning enqueue (not downstream worker processing) before responding', async () => {
    // The webhook now waits for provisioningQueue.send() — a single durable
    // write, same contract as PgQueue.send()/InMemoryQueue.send() — because
    // its failure must be able to fail the response (see the "root
    // provisioning enqueue" describe block below). It must NOT wait for a
    // worker to later receive/process the message: no worker runs in this
    // test at all, proving the wait is bounded to the durable write itself.
    const auditRepo = new InMemoryAuditRepository();
    const order: string[] = [];
    const provisioningQueue = {
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('enqueue-settled');
        return 'msg-tenant-provisioning-1';
      },
    };
    const appWithQueue = buildTestApp(tenantRepo, WEBHOOK_SECRET, { provisioningQueue, auditRepo });

    const svixId = 'evt_async_queue_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload('user_async_1', 'async@example.com');
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);

    const res = await request(appWithQueue)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);
    order.push('response-received');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // The response arrived only AFTER the durable send() resolved.
    expect(order).toEqual(['enqueue-settled', 'response-received']);

    const bootstrapEvents = auditRepo.getAll().filter((e) => e.eventType === 'tenant.signup.bootstrap.completed');
    expect(bootstrapEvents).toHaveLength(1);
    expect(bootstrapEvents[0].correlationId).toBe(`signup:${svixId}`);

    // Already present by the time the response returns — no manual flush
    // needed, since the enqueue (and its audit event) is awaited in-request.
    const queuedEvent = auditRepo.getAll().find((e) => e.eventType === 'tenant.signup.provisioning.enqueued');
    expect(queuedEvent).toBeTruthy();
    expect(queuedEvent?.correlationId).toBe(`signup:${svixId}`);
    expect(queuedEvent?.metadata?.queueMessageId).toBe('msg-tenant-provisioning-1');
  });
});

/**
 * QUALITY-2026-07-12 WS4 (PR #669 review) — owner membership creation must
 * fail the webhook. Previously an owner users-row insert failure was logged
 * and the event was marked processed (200): Clerk never retried, and with
 * DB-authoritative authorization the freshly-bootstrapped owner was locked
 * out of /api until manual repair. Now the failure rethrows → 500 → the event
 * row is marked 'failed' → Clerk's retry re-executes and the idempotent
 * insert re-attempts. All `result.created`-gated side effects run BEFORE the
 * insert, so the retry (created=false) never repeats or skips them.
 */
describe('owner membership insert — webhook failure semantics', () => {
  // The route's owner-insert block only fires for UUID tenant ids (RLS
  // set_config requires one), so this repo mints real UUIDs.
  class UuidTenantRepository extends FakeTenantRepository {
    async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
      const tenant = await super.create(data);
      tenant.id = `550e8400-e29b-41d4-a716-44665544${String(this.created.length).padStart(4, '0')}`;
      return tenant;
    }
  }

  interface FakeClient {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }

  function makeFakePool(behavior: { failInsert: boolean }) {
    const queries: string[] = [];
    const client: FakeClient = {
      query: vi.fn(async (sql: string) => {
        queries.push(typeof sql === 'string' ? sql : String(sql));
        if (behavior.failInsert && typeof sql === 'string' && sql.includes('INSERT INTO users')) {
          throw new Error('transient insert failure');
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    return { pool, client, queries };
  }

  function signedRequest(app: express.Express, svixId: string, userId: string, email: string) {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload(userId, email);
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);
    return request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);
  }

  it('a users-row insert failure fails the webhook (500), and the retry succeeds', async () => {
    const tenantRepo = new UuidTenantRepository();
    const behavior = { failInsert: true };
    const { pool, queries } = makeFakePool(behavior);
    const app = express();
    app.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app.use('/webhooks', createWebhookRouter(config, {
      tenantRepo,
      pool: pool as never,
    }));

    // Attempt 1: insert fails → 500 (Clerk will retry), tenant already bootstrapped.
    const first = await signedRequest(app, 'svix_owner_fail_1', 'user_owner_1', 'owner1@example.com');
    expect(first.status).toBe(500);
    expect(tenantRepo.created).toHaveLength(1);
    expect(queries.some((q) => q.includes('ROLLBACK'))).toBe(true);

    // Attempt 2 (Clerk retry, same event id): the in-memory webhook repo lets a
    // 'failed' event re-execute; the insert now succeeds → 200.
    behavior.failInsert = false;
    const second = await signedRequest(app, 'svix_owner_fail_1', 'user_owner_1', 'owner1@example.com');
    expect(second.status).toBe(200);
    // bootstrapTenant is idempotent — no second tenant.
    expect(tenantRepo.created).toHaveLength(1);
    expect(queries.filter((q) => q.includes('INSERT INTO users'))).toHaveLength(2);
    expect(queries.filter((q) => q.includes('COMMIT'))).toHaveLength(1);
  });

  it('a successful insert commits within the tenant RLS context and returns 200', async () => {
    const tenantRepo = new UuidTenantRepository();
    const { pool, client, queries } = makeFakePool({ failInsert: false });
    const app = express();
    app.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app.use('/webhooks', createWebhookRouter(config, {
      tenantRepo,
      pool: pool as never,
    }));

    const res = await signedRequest(app, 'svix_owner_ok_1', 'user_owner_2', 'owner2@example.com');
    expect(res.status).toBe(200);
    expect(queries.some((q) => q.includes("set_config('app.current_tenant_id'"))).toBe(true);
    expect(queries.filter((q) => q.includes('COMMIT'))).toHaveLength(1);
    expect(client.release).toHaveBeenCalled();
  });
});

/**
 * Provisioning recovery — the root-provisioning enqueue (deps.provisioningQueue)
 * is now AWAITED (the durable `send()` write, not worker completion) and no
 * longer gated on `result.created`, so:
 *   1. A standalone enqueue failure (nothing else on the request fails) now
 *      fails the webhook (500) instead of silently swallowing the error and
 *      returning 200 with no durable trace of the attempt.
 *   2. bootstrapTenant's idempotent re-check makes `result.created` false on
 *      any retry (own-enqueue-triggered or forced by a later failure, e.g.
 *      the owner-insert) — the enqueue must still re-attempt, since gating on
 *      `created` would permanently skip a tenant whose first send never
 *      landed.
 *   3. The queue's per-tenant idempotency key (`tenant-provisioning:${tenantId}`)
 *      makes re-sending on retry safe: a successful prior send no-ops via
 *      ON CONFLICT DO NOTHING, so a retry never produces a second message.
 */
describe('root provisioning enqueue — durable, awaited, and retry-safe', () => {
  class UuidTenantRepository extends FakeTenantRepository {
    async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
      const tenant = await super.create(data);
      tenant.id = `650e8400-e29b-41d4-a716-44665544${String(this.created.length).padStart(4, '0')}`;
      return tenant;
    }
  }

  function makeFakePool(behavior: { failInsert: boolean }) {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(typeof sql === 'string' ? sql : String(sql));
        if (behavior.failInsert && typeof sql === 'string' && sql.includes('INSERT INTO users')) {
          throw new Error('transient insert failure');
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    return { pool, queries };
  }

  function signedRequest(app: express.Express, svixId: string, userId: string, email: string) {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload(userId, email);
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);
    return request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);
  }

  it('a standalone enqueue failure (nothing else fails) still fails the webhook, and the retry lands the job', async () => {
    // Owner-insert never fails in this test — isolates the enqueue as the
    // ONLY failing step, reproducing the exact gap flagged in
    // docs/plans/2026-09-08-provisioning-recovery.md ("A provisioning-only
    // failure still can't self-heal"): pre-fix, this returned 200 and the
    // tenant never got a root-provisioning message, with no way to recover
    // since the event would be marked 'processed' and never retry again.
    const tenantRepo = new UuidTenantRepository();
    const { pool, queries } = makeFakePool({ failInsert: false });

    const sendCalls: Array<{ idempotencyKey?: string }> = [];
    const provisioningQueue = {
      send: async <T>(_type: string, _payload: T, idempotencyKey?: string) => {
        sendCalls.push({ idempotencyKey });
        if (sendCalls.length === 1) {
          throw new Error('queue unavailable');
        }
        return 'msg-provisioning-retry-1';
      },
    };

    const app = express();
    app.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app.use('/webhooks', createWebhookRouter(config, {
      tenantRepo,
      pool: pool as never,
      provisioningQueue,
    }));

    // Attempt 1: tenant bootstraps (created=true); the enqueue is AWAITED and
    // rejects — that alone must fail the webhook so Clerk retries. Nothing
    // downstream of the enqueue (the owner-insert) runs on this attempt: the
    // rejection is synchronous with the response, not a detached rejection
    // that needs a tick to settle.
    const first = await signedRequest(
      app, 'svix_provisioning_only_1', 'user_provisioning_only_1', 'provisiononly@example.com',
    );
    expect(first.status).toBe(500);
    expect(sendCalls).toHaveLength(1);
    expect(tenantRepo.created).toHaveLength(1); // tenant already durably persisted
    expect(queries.some((q) => q.includes('INSERT INTO users'))).toBe(false); // short-circuited before owner-insert

    // Attempt 2 (Clerk retry, same svix-id): bootstrapTenant is idempotent so
    // result.created is false this time — the un-gated enqueue must still
    // re-attempt with the SAME idempotency key, and now succeeds.
    const second = await signedRequest(
      app, 'svix_provisioning_only_1', 'user_provisioning_only_1', 'provisiononly@example.com',
    );
    expect(second.status).toBe(200);
    expect(tenantRepo.created).toHaveLength(1); // idempotent — no second tenant
    expect(queries.some((q) => q.includes('INSERT INTO users'))).toBe(true); // owner-insert now reached and runs

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0].idempotencyKey).toBe(sendCalls[1].idempotencyKey);
  });

  it('a successful enqueue is deduped, not duplicated, when a later failure forces a retry', async () => {
    // Uses the REAL InMemoryQueue (same ON CONFLICT (idempotency_key) DO
    // NOTHING contract as PgQueue — see src/queues/queue.ts) instead of a
    // call-counting mock, so the dedupe assertion below exercises the actual
    // queue contract, not a restatement of it.
    const tenantRepo = new UuidTenantRepository();
    const behavior = { failInsert: true };
    const { pool } = makeFakePool(behavior);
    const provisioningQueue = new InMemoryQueue();

    const app = express();
    app.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app.use('/webhooks', createWebhookRouter(config, {
      tenantRepo,
      pool: pool as never,
      provisioningQueue,
    }));

    // Attempt 1: enqueue succeeds and durably lands; owner-insert then fails,
    // forcing a Clerk retry of the same event.
    const first = await signedRequest(
      app, 'svix_provisioning_dedupe_1', 'user_provisioning_dedupe_1', 'dedupe@example.com',
    );
    expect(first.status).toBe(500);
    expect(provisioningQueue.size()).toBe(1);

    // Attempt 2 (Clerk retry, same svix-id): owner-insert now succeeds;
    // bootstrapTenant is idempotent (created=false), so the un-gated enqueue
    // re-attempts send() with the SAME idempotency key. The queue must dedupe
    // it — no second message, even though send() is called again and
    // "succeeds" (returns a fresh id per the ON CONFLICT DO NOTHING contract).
    behavior.failInsert = false;
    const second = await signedRequest(
      app, 'svix_provisioning_dedupe_1', 'user_provisioning_dedupe_1', 'dedupe@example.com',
    );
    expect(second.status).toBe(200);
    expect(provisioningQueue.size()).toBe(1); // still exactly one — deduped, not duplicated
  });
});

// Exercise failed enqueue recovery and queued-message deduplication on replay.
// Provider purchases and real PostgreSQL behavior require separate integration evidence.
describe('Twilio subaccount provisioning enqueue — retry recovers a failed send', () => {
  function signedRequest(app: express.Express, svixId: string, userId: string, email: string) {
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload(userId, email);
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);
    return request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);
  }

  it('a standalone Twilio enqueue failure still fails the webhook, and the retry lands the job (not permanently skipped)', async () => {
    const tenantRepo = new FakeTenantRepository();

    const sendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
    const queue = {
      send: async <T>(type: string, _payload: T, idempotencyKey?: string) => {
        sendCalls.push({ type, idempotencyKey });
        if (sendCalls.length === 1) {
          throw new Error('twilio queue unavailable');
        }
        return 'msg-twilio-retry';
      },
    };

    const app = express();
    app.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app.use('/webhooks', createWebhookRouter(config, { tenantRepo, queue: queue as never }));

    // Attempt 1: tenant bootstraps (created=true); the Twilio enqueue is
    // awaited and rejects — the webhook must fail (500) so Clerk retries,
    // and the tenant is already durably persisted.
    const first = await signedRequest(
      app, 'svix_twilio_retry_1', 'user_twilio_retry_1', 'twilioretry@example.com',
    );
    expect(first.status).toBe(500);
    expect(tenantRepo.created).toHaveLength(1); // tenant durably persisted despite the failed enqueue
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].type).toBe(PROVISION_TWILIO_JOB_TYPE);

    // Attempt 2 (Clerk retry, same svix-id): bootstrapTenant is idempotent,
    // so result.created is false this time. The Twilio enqueue must still
    // re-attempt (not permanently skipped) — same tenant, single tenant row.
    const second = await signedRequest(
      app, 'svix_twilio_retry_1', 'user_twilio_retry_1', 'twilioretry@example.com',
    );
    expect(second.status).toBe(200);
    expect(tenantRepo.created).toHaveLength(1); // still a single tenant — no duplicate created
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1].type).toBe(PROVISION_TWILIO_JOB_TYPE);
    expect(sendCalls[1].idempotencyKey).toBe(sendCalls[0].idempotencyKey);
  });

  it('a successful Twilio enqueue is deduped, not duplicated, when a later failure forces a retry', async () => {
    // Uses the REAL InMemoryQueue so the dedupe assertion exercises the
    // in-memory deduplication contract. This does not exercise provider purchases.
    class UuidTenantRepository extends FakeTenantRepository {
      async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
        const tenant = await super.create(data);
        tenant.id = `750e8400-e29b-41d4-a716-44665544${String(this.created.length).padStart(4, '0')}`;
        return tenant;
      }
    }

    const tenantRepo = new UuidTenantRepository();
    const behavior = { failInsert: true };
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(typeof sql === 'string' ? sql : String(sql));
        if (behavior.failInsert && typeof sql === 'string' && sql.includes('INSERT INTO users')) {
          throw new Error('transient insert failure');
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const queue = new InMemoryQueue();

    const app = express();
    app.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app.use('/webhooks', createWebhookRouter(config, {
      tenantRepo,
      pool: pool as never,
      queue,
    }));

    // Attempt 1: Twilio enqueue succeeds and durably lands; owner-insert then
    // fails, forcing a Clerk retry of the same event.
    const first = await signedRequest(
      app, 'svix_twilio_dedupe_1', 'user_twilio_dedupe_1', 'twiliodedupe@example.com',
    );
    expect(first.status).toBe(500);
    const sizeAfterFirst = queue.size();
    expect(sizeAfterFirst).toBeGreaterThanOrEqual(1); // at least the Twilio provisioning job landed

    // Attempt 2 (Clerk retry, same svix-id): owner-insert now succeeds;
    // bootstrapTenant is idempotent (created=false), so the un-gated Twilio
    // enqueue re-attempts send() with the SAME idempotency key
    // (`provision-twilio-${tenantId}`). The queue must dedupe it — no second
    // Twilio provisioning message remains queued.
    behavior.failInsert = false;
    const second = await signedRequest(
      app, 'svix_twilio_dedupe_1', 'user_twilio_dedupe_1', 'twiliodedupe@example.com',
    );
    expect(second.status).toBe(200);
    expect(queue.size()).toBe(sizeAfterFirst); // no growth — deduped, not duplicated
  });
});
