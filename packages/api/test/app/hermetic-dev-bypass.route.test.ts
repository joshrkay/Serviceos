/**
 * Hermetic createApp() boot with DEV_AUTH_BYPASS — pins the local-demo
 * behaviors that previously failed without Postgres / a real LLM key:
 *   - GET /api/settings → 200 (seeded tenant_settings)
 *   - GET /api/users/me/phone → 200 (seeded users row)
 *   - GET /api/me → internal_user_id UUID (technician Today)
 *   - GET /api/onboarding/status → 200 with voiceAgentLive boolean
 *   - POST /api/assistant/chat → create_customer proposal (hermetic mock)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

describe('Hermetic DEV_AUTH_BYPASS boot', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  const auth = `Bearer ${unsignedJwt({
    sub: 'hermetic_dev_owner',
    sid: 'hermetic-session',
    role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;

  beforeAll(async () => {
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      DATABASE_URL: process.env.DATABASE_URL,
      AI_PROVIDER_API_KEY: process.env.AI_PROVIDER_API_KEY,
      CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    delete process.env.DATABASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    resetConfig();
    app = createApp();
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('GET /api/me returns an internal_user_id UUID', async () => {
    const res = await request(app).get('/api/me').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('hermetic_dev_owner');
    expect(res.body.internal_user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(res.body.can_field_serve).toBe(true);
  });

  it('GET /api/settings returns a seeded settings document', async () => {
    const res = await request(app).get('/api/settings').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(typeof res.body.businessName).toBe('string');
    expect(res.body.businessName.length).toBeGreaterThan(0);
  });

  it('GET /api/users/me/phone resolves the seeded owner (not 404)', async () => {
    const res = await request(app).get('/api/users/me/phone').set('Authorization', auth);
    expect(res.status).toBe(200);
    // mobile may be null until the operator sets it — presence of the
    // user row is what previously 404'd.
    expect(res.body).toHaveProperty('mobileNumber');
  });

  it('GET /api/onboarding/status returns soft status without a pool', async () => {
    const res = await request(app).get('/api/onboarding/status').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(typeof res.body.voiceAgentLive).toBe('boolean');
    expect(res.body.voiceAgentLive).toBe(false);
    // CRM unlock contract: seeded settings ⇒ identity done so hermetic
    // journeys are not redirected to /onboarding (ProtectedRoute gate).
    const identity = (res.body.steps as Array<{ id: string; status: string }>).find(
      (s) => s.id === 'identity',
    );
    expect(identity?.status).toBe('done');
  });

  it('POST /api/assistant/chat creates a create_customer proposal', async () => {
    const res = await request(app)
      .post('/api/assistant/chat')
      .set('Authorization', auth)
      .send({
        messages: [{ role: 'user', content: 'Create a customer named Hermetic Test Co' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.degraded).not.toBe(true);
    expect(res.body.message?.proposal).toBeTruthy();
    expect(res.body.message.proposal.type).toBe('Customer');
    expect(res.body.message.proposal.title).toMatch(/Hermetic/i);
  });
});
