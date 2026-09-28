/**
 * CLERK-META-2026-09-27 — the `user.created` webhook FAILS (500 → Clerk
 * retries) when the tenant_id metadata write to Clerk fails, instead of
 * logging and returning 200.
 *
 * A Clerk-side 404 (user deleted between signup and the write) is the one
 * exception: retrying would never succeed, so the webhook still 200s.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac, randomBytes } from 'crypto';
import { createWebhookRouter } from '../../src/webhooks/routes';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString('base64')}`;

const cfg: any = {
  CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET,
  CLERK_SECRET_KEY: 'sk_test',
};

function signedApp(clerkFetch: ReturnType<typeof vi.fn>, tenantRepoOverrides = {}) {
  const app = express();
  // Production mounts express.raw() before express.json() for this path so
  // the handler verifies over the exact signed bytes.
  app.use('/webhooks', express.raw({ type: '*/*' }));
  const tenantRepo = {
    findByOwner: vi.fn(async () => null),
    findById: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: TENANT_ID, ownerId: 'user_1', ownerEmail: 'owner@acme.com' })),
    ...tenantRepoOverrides,
  };
  app.use(
    '/webhooks',
    createWebhookRouter(cfg, { tenantRepo: tenantRepo as any }),
  );
  void clerkFetch;
  return { app, tenantRepo };
}

function signPayload(svixId: string, svixTimestamp: string, rawBody: string): string {
  const secret = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

function userCreatedBody() {
  return {
    type: 'user.created',
    data: {
      id: 'user_1',
      email_addresses: [{ email_address: 'owner@acme.com' }],
      first_name: 'Jane',
      last_name: 'Owner',
      public_metadata: {},
    },
  };
}

async function postUserCreated(app: express.Express) {
  const rawBody = JSON.stringify(userCreatedBody());
  const svixId = `msg_${Date.now()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  return request(app)
    .post('/webhooks/clerk')
    .set('svix-id', svixId)
    .set('svix-timestamp', svixTimestamp)
    .set('svix-signature', signPayload(svixId, svixTimestamp, rawBody))
    .set('Content-Type', 'application/json')
    .send(rawBody);
}

describe('user.created — Clerk metadata sync failure fails the webhook', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubClerk(status: number) {
    const clerkFetch = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (status === 200 ? '' : 'clerk exploded'),
      json: async () => ({}),
    }));
    globalThis.fetch = clerkFetch as unknown as typeof fetch;
    return clerkFetch;
  }

  it('returns 500 when the metadata PATCH fails, so Clerk retries', async () => {
    const clerkFetch = stubClerk(500);
    const { app, tenantRepo } = signedApp(clerkFetch);

    const r = await postUserCreated(app);
    expect(r.status).toBe(500);
    // The tenant WAS bootstrapped before the failing write…
    expect(tenantRepo.create).toHaveBeenCalledOnce();
    // …and the metadata write was attempted.
    expect(clerkFetch).toHaveBeenCalledOnce();
    const [url, init] = clerkFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.clerk.com/v1/users/user_1');
    expect(JSON.parse(init.body as string)).toEqual({
      public_metadata: { tenant_id: TENANT_ID, role: 'owner' },
    });
  });

  it('returns 500 when the Clerk call throws (transport failure)', async () => {
    const clerkFetch = vi.fn(async () => { throw new Error('socket hangup'); });
    globalThis.fetch = clerkFetch as unknown as typeof fetch;
    const { app } = signedApp(clerkFetch);

    const r = await postUserCreated(app);
    expect(r.status).toBe(500);
  });

  it('returns 200 when the metadata PATCH succeeds', async () => {
    stubClerk(200);
    const { app } = signedApp(vi.fn());

    const r = await postUserCreated(app);
    expect(r.status).toBe(200);
    expect(r.body.received).toBe(true);
  });

  it('returns 200 on a Clerk 404 (deleted user — retrying would never succeed)', async () => {
    stubClerk(404);
    const { app } = signedApp(vi.fn());

    const r = await postUserCreated(app);
    expect(r.status).toBe(200);
  });
});
