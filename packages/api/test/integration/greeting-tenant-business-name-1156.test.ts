/**
 * #1156 — the default voice greeting must say the CALLED tenant's own
 * `tenant_settings.business_name`, not the platform-wide
 * `TWILIO_BUSINESS_NAME` env value (or the literal `'our team'` fallback),
 * for every tenant that has a business name on file but never wrote a
 * custom `voice_greeting`.
 *
 * T2: two tenants, each on its own DID with its own Twilio credential and
 * its own `business_name`, neither with a custom `voice_greeting`. A signed
 * `POST /api/telephony/voice` for each DID must come back with a greeting
 * containing THAT tenant's own business name — not the env fallback, and
 * not the other tenant's name.
 *
 * Modeled on test/integration/telephony-tenant-credential-binding.test.ts's
 * provisioning + signing pattern (real `createApp()`, real Postgres, a real
 * HMAC-SHA1 Twilio signature) so the fix is proven at the actual webhook,
 * not just at the pure `buildTelephonyGreeting` helper.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import twilio from 'twilio';
import type { Express } from 'express';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { encrypt } from '../../src/integrations/crypto';

const ENCRYPTION_KEY = 'b'.repeat(64);
const PUBLIC_API_URL = 'http://127.0.0.1:3998';
const RUN = crypto.randomInt(100000, 999999);
const A_DID = `+1513${RUN}1`;
const B_DID = `+1513${RUN}2`;
const A_SUBACCOUNT = 'AC1156aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1156bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1156';
const B_TOKEN = 'tenant-b-twilio-auth-token-1156';
const A_BUSINESS_NAME = 'Aurora Plumbing Co';
const B_BUSINESS_NAME = 'Borealis HVAC Services';
const CALLER = '+15125557156';

describe('#1156 — default voice greeting uses the CALLED tenant\'s own business_name', () => {
  let pool: Pool;
  let app: Express;
  let gracefulDrain: ((reason: string) => Promise<void>) | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  async function provision(opts: {
    did: string;
    subaccountSid: string;
    authToken: string;
    businessName: string;
  }): Promise<{ tenantId: string }> {
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const email = `owner+${tenantId.slice(0, 8)}@example.com`;
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tenantId, userId, email, opts.businessName],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [userId, tenantId, userId, email],
    );
    // No voice_greeting — this is the "never wrote a custom greeting" case
    // row 2.1 is about. business_name IS set, from onboarding.
    await pool.query(
      `INSERT INTO tenant_settings
         (id, tenant_id, business_name, timezone, region, voice_agent_live_at, e1_reviewed_script)
       VALUES ($1, $2, $3, 'America/Chicago', 'TX', NOW(), 'Test-reviewed E1 script')`,
      [crypto.randomUUID(), tenantId, opts.businessName],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO tenant_integrations
           (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
         VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
        [
          tenantId,
          JSON.stringify({ phoneE164: opts.did }),
          opts.subaccountSid,
          encrypt(opts.authToken, ENCRYPTION_KEY),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { tenantId };
  }

  function signedPost(path: string, params: Record<string, string>, authToken: string) {
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      `${PUBLIC_API_URL}${path}`,
      params,
    );
    return request(app)
      .post(path)
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(params);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();

    await provision({ did: A_DID, subaccountSid: A_SUBACCOUNT, authToken: A_TOKEN, businessName: A_BUSINESS_NAME });
    await provision({ did: B_DID, subaccountSid: B_SUBACCOUNT, authToken: B_TOKEN, businessName: B_BUSINESS_NAME });

    setEnv('NODE_ENV', 'test');
    setEnv('DATABASE_URL', process.env.TEST_DB_URL!);
    setEnv('DB_SSL', 'false');
    setEnv('PROCESS_ROLE', 'web');
    setEnv('TENANT_ENCRYPTION_KEY', ENCRYPTION_KEY);
    setEnv('PUBLIC_API_URL', PUBLIC_API_URL);
    setEnv('TWILIO_ACCOUNT_SID', 'AC1156deploymentmasteraccount00000');
    setEnv('TWILIO_AUTH_TOKEN', 'deployment-master-twilio-auth-token-1156');
    setEnv('TWILIO_FROM_NUMBER', '+15125550001');
    setEnv('TWILIO_DEFAULT_TENANT_ID', '00000000-0000-4000-8000-000000000099');
    // Explicitly unset so the greeting's env fallback is the literal
    // 'our team' — if the fix regressed to the env value instead of the
    // tenant's own business_name, both tenants would say the SAME thing
    // instead of each saying its own.
    delete process.env.TWILIO_BUSINESS_NAME;
    setEnv('TWILIO_MEDIA_STREAMS_ENABLED', 'false');

    const { createApp } = await import('../../src/app');
    const built = createApp();
    app = built;
    gracefulDrain = built.gracefulDrain;
  });

  afterAll(async () => {
    await gracefulDrain?.('test-teardown').catch(() => undefined);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closeSharedTestDb();
  });

  it('T2 — tenant A hears its OWN business name, not the env fallback and not tenant B\'s name', async () => {
    const callSid = `CA-1156-a-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: A_DID },
      A_TOKEN,
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain(`Thank you for calling ${A_BUSINESS_NAME}.`);
    expect(res.text).not.toContain('our team');
    expect(res.text).not.toContain(B_BUSINESS_NAME);
  });

  it('T2 — tenant B hears its OWN business name, not the env fallback and not tenant A\'s name', async () => {
    const callSid = `CA-1156-b-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain(`Thank you for calling ${B_BUSINESS_NAME}.`);
    expect(res.text).not.toContain('our team');
    expect(res.text).not.toContain(A_BUSINESS_NAME);
  });
});
