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

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

function buildTestApp(tenantRepo?: TenantRepository, secret: string = WEBHOOK_SECRET) {
  const app = express();
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
  const hexKey = secretBytes.toString('hex');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto
    .createHmac('sha256', hexKey)
    .update(`${svixTimestamp}.${signedContent}`)
    .digest('hex');
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
});
