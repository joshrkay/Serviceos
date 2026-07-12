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
import { describe, it, expect, beforeEach } from 'vitest';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { Tenant, TenantRepository } from '../../src/auth/clerk';
import type { AppConfig } from '../../src/shared/config';
import { InMemoryAuditRepository } from '../../src/audit/audit';

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

  it('returns signup response without waiting for downstream provisioning enqueue', async () => {
    const auditRepo = new InMemoryAuditRepository();
    let releaseEnqueue: (() => void) | undefined;
    const enqueueStarted = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const provisioningQueue = {
      send: async () => {
        await enqueueStarted;
        return 'msg-tenant-provisioning-1';
      },
    };
    const appWithQueue = buildTestApp(tenantRepo, WEBHOOK_SECRET, { provisioningQueue, auditRepo });

    const svixId = 'evt_async_queue_1';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const payload = userCreatedPayload('user_async_1', 'async@example.com');
    const { signature } = signSvixPayload(payload, svixId, svixTimestamp, WEBHOOK_SECRET);

    const responsePromise = request(appWithQueue)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signature)
      .send(payload);

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const bootstrapEvents = auditRepo.getAll().filter((e) => e.eventType === 'tenant.signup.bootstrap.completed');
    expect(bootstrapEvents).toHaveLength(1);
    expect(bootstrapEvents[0].correlationId).toBe(`signup:${svixId}`);

    // Unblock enqueue completion after HTTP response has already returned.
    releaseEnqueue?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const allEvents = auditRepo.getAll();
    const queuedEvent = allEvents.find((e) => e.eventType === 'tenant.signup.provisioning.enqueued');
    expect(queuedEvent).toBeTruthy();
    expect(queuedEvent?.correlationId).toBe(`signup:${svixId}`);
    expect(queuedEvent?.metadata?.queueMessageId).toBe('msg-tenant-provisioning-1');
  });
});
