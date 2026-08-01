/**
 * The Clerk user.created webhook should enqueue the welcome onboarding email
 * for brand-new tenants (and only once per tenant, via the idempotency key).
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { Tenant, TenantRepository } from '../../src/auth/clerk';
import type { AppConfig } from '../../src/shared/config';
import { LIFECYCLE_EMAIL_JOB_TYPE } from '../../src/workers/lifecycle-email-worker';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

class FakeTenantRepository implements TenantRepository {
  private byOwner = new Map<string, Tenant>();
  async findByOwner(ownerId: string): Promise<Tenant | null> {
    return this.byOwner.get(ownerId) ?? null;
  }
  async findById(): Promise<Tenant | null> {
    return null;
  }
  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    const tenant: Tenant = {
      id: `11111111-1111-1111-1111-11111111111${this.byOwner.size + 1}`,
      ownerId: data.ownerId,
      ownerEmail: data.ownerEmail,
      name: data.name,
      createdAt: new Date(),
    };
    this.byOwner.set(data.ownerId, tenant);
    return tenant;
  }
}

interface SentJob {
  type: string;
  payload: unknown;
  idempotencyKey?: string;
}

function fakeQueue(sent: SentJob[]) {
  return {
    async send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string> {
      sent.push({ type, payload, idempotencyKey });
      return `job-${sent.length}`;
    },
  };
}

function signSvixPayload(body: object, svixId: string, svixTimestamp: string, secret: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');
  return { rawBody, signature: `v1,${sig}` };
}

describe('Clerk webhook → welcome email enqueue', () => {
  let sent: SentJob[];
  let app: express.Express;

  beforeEach(() => {
    sent = [];
    const app2 = express();
    app2.use(express.json());
    const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
    app2.use(
      '/webhooks',
      createWebhookRouter(config, { tenantRepo: new FakeTenantRepository(), queue: fakeQueue(sent) }),
    );
    app = app2;
  });

  async function postUserCreated(svixId: string, userId: string, email: string) {
    const body = {
      type: 'user.created',
      data: { id: userId, email_addresses: [{ email_address: email }] },
    };
    const ts = String(Math.floor(Date.now() / 1000));
    const { rawBody, signature } = signSvixPayload(body, svixId, ts, WEBHOOK_SECRET);
    return request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signature)
      .set('content-type', 'application/json')
      .send(rawBody);
  }

  it('enqueues a welcome lifecycle_email job for a new tenant', async () => {
    const res = await postUserCreated('msg_welcome_1', 'user_1', 'owner@shop.com');
    expect(res.status).toBe(200);

    const welcome = sent.find((j) => j.type === LIFECYCLE_EMAIL_JOB_TYPE);
    expect(welcome).toBeDefined();
    expect(welcome!.payload).toMatchObject({ ownerEmail: 'owner@shop.com', kind: 'welcome' });
    // Keyed per tenant so a webhook replay collapses to one send.
    expect(welcome!.idempotencyKey).toMatch(/^lifecycle-welcome-/);
  });
});
