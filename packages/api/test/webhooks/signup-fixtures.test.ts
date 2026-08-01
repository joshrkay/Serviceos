/**
 * Feature 1 — Signup → account creation. Exercises the three signup fixture
 * paths named in the launch inventory (email, Google OAuth, duplicate email)
 * against the live Clerk webhook → tenant-bootstrap route, asserting the
 * tenant is created and `signup_completed` fires. Complements the deeper
 * coverage in clerk-webhook-integration.test.ts.
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const recordFunnelEventMock = vi.fn();
vi.mock('../../src/analytics/posthog', () => ({
  recordFunnelEvent: (...args: unknown[]) => recordFunnelEventMock(...args),
}));

import { createWebhookRouter } from '../../src/webhooks/routes';
import { Tenant, TenantRepository } from '../../src/auth/clerk';
import type { AppConfig } from '../../src/shared/config';

const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

class FakeTenantRepository implements TenantRepository {
  public created: Array<{ ownerId: string; ownerEmail: string; name: string }> = [];
  private byOwner = new Map<string, Tenant>();
  async findByOwner(ownerId: string): Promise<Tenant | null> {
    return this.byOwner.get(ownerId) ?? null;
  }
  async findById(id: string): Promise<Tenant | null> {
    for (const t of this.byOwner.values()) if (t.id === id) return t;
    return null;
  }
  async create(data: { ownerId: string; ownerEmail: string; name: string }): Promise<Tenant> {
    this.created.push(data);
    const tenant: Tenant = { id: `tenant-${this.byOwner.size + 1}`, ownerId: data.ownerId, ownerEmail: data.ownerEmail, name: data.name, createdAt: new Date() };
    this.byOwner.set(data.ownerId, tenant);
    return tenant;
  }
}

function buildApp(tenantRepo: TenantRepository) {
  const app = express();
  app.use(express.json());
  const config = { CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig;
  app.use('/webhooks', createWebhookRouter(config, { tenantRepo }));
  return app;
}

function sign(body: object, svixId: string, svixTimestamp: string) {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

function post(app: express.Express, payload: object, svixId: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app)
    .post('/webhooks/clerk')
    .set('svix-id', svixId)
    .set('svix-timestamp', ts)
    .set('svix-signature', sign(payload, svixId, ts))
    .send(payload);
}

function emailSignup(userId: string, email: string) {
  return { type: 'user.created', data: { id: userId, email_addresses: [{ email_address: email }] } };
}
function googleSignup(userId: string, email: string) {
  return {
    type: 'user.created',
    data: {
      id: userId,
      email_addresses: [{ email_address: email }],
      external_accounts: [{ provider: 'oauth_google', email_address: email }],
    },
  };
}

describe('Feature 1 — signup fixture paths', () => {
  let tenantRepo: FakeTenantRepository;
  let app: express.Express;
  beforeEach(() => {
    recordFunnelEventMock.mockClear();
    tenantRepo = new FakeTenantRepository();
    app = buildApp(tenantRepo);
  });

  it('email signup → creates a tenant and fires signup_completed', async () => {
    const res = await post(app, emailSignup('user_email_1', 'email@example.com'), 'evt_email_1');
    expect(res.status).toBe(200);
    expect(tenantRepo.created).toHaveLength(1);
    expect(tenantRepo.created[0]).toMatchObject({ ownerId: 'user_email_1', ownerEmail: 'email@example.com' });
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'signup_completed' }),
    );
  });

  it('Google OAuth signup → creates a tenant and fires signup_completed', async () => {
    const res = await post(app, googleSignup('user_google_1', 'google@example.com'), 'evt_google_1');
    expect(res.status).toBe(200);
    expect(tenantRepo.created).toHaveLength(1);
    expect(tenantRepo.created[0]).toMatchObject({ ownerId: 'user_google_1', ownerEmail: 'google@example.com' });
    expect(recordFunnelEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'signup_completed' }),
    );
  });

  it('duplicate email (edge case) — handled gracefully without crashing', async () => {
    const first = await post(app, emailSignup('user_dup_1', 'dup@example.com'), 'evt_dup_a');
    expect(first.status).toBe(200);
    // A second, distinct signup re-using the same email still returns 200 (the
    // route keys bootstrap on the Clerk user id; it must not 500 on the dupe).
    const second = await post(app, emailSignup('user_dup_2', 'dup@example.com'), 'evt_dup_b');
    expect(second.status).toBe(200);
  });
});
