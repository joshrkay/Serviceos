/**
 * createApp(overrides) — per-dependency substitution.
 *
 * This is the capability D-024 Stage 1 exists to deliver. Before it, the only
 * way to change what repositories the app used was the global `DATABASE_URL`
 * switch: unset it and EVERY repository flipped to in-memory, all-or-nothing.
 * There was no way to ask for this route with that fake.
 *
 * The assertion below is deliberately end-to-end rather than structural: it
 * boots the real app, drives a real HTTP route, and checks the response came
 * from the substituted repository. A test that only inspected the deps object
 * would pass even if createApp threaded the default through to the router.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';
import {
  InMemoryCustomerRepository,
  type Customer,
  type CustomerListResult,
} from '../../src/customers/customer';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

const SENTINEL_NAME = 'Substituted Repository Sentinel';

const sentinelCustomer = {
  id: '00000000-0000-4000-8000-00000000beef',
  tenantId: 'any-tenant',
  firstName: 'Substituted',
  lastName: 'Sentinel',
  displayName: SENTINEL_NAME,
  preferredChannel: 'sms',
  smsConsent: false,
  isArchived: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as Customer;

/**
 * Returns the sentinel regardless of tenant scoping, so the assertion proves
 * substitution rather than exercising the tenant filter.
 */
class SentinelCustomerRepository extends InMemoryCustomerRepository {
  async findByTenant(): Promise<Customer[]> {
    return [sentinelCustomer];
  }
  async listWithMeta(): Promise<CustomerListResult> {
    return { data: [sentinelCustomer], total: 1 };
  }
}

describe('createApp(overrides) — per-dependency substitution', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  const auth = `Bearer ${unsignedJwt({
    sub: 'hermetic_dev_owner',
    sid: 'hermetic-session',
    role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;

  beforeAll(() => {
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      DATABASE_URL: process.env.DATABASE_URL,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    delete process.env.DATABASE_URL;
    resetConfig();
    app = createApp({ customerRepo: new SentinelCustomerRepository() });
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('routes read from the substituted repository, not the default', async () => {
    const res = await request(app).get('/api/customers').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(SENTINEL_NAME);
  });

  it('an app booted WITHOUT the override does not see the sentinel', async () => {
    // Guards against the assertion above passing for an unrelated reason.
    const plain = createApp();
    try {
      const res = await request(plain).get('/api/customers').set('Authorization', auth);
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL_NAME);
    } finally {
      await plain.gracefulDrain('test-cleanup');
    }
  });
});
