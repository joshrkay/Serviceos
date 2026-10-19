/**
 * LCR-04 — the webhook credential resolver must survive a short database
 * brownout at REAL Postgres.
 *
 * Every /api/telephony webhook is signature-checked before its route runs,
 * and the check reads `tenant_integrations` (`provider_data->>'phoneE164'`,
 * `subaccount_sid`, `auth_token_primary_enc`). A throw there answered 500 at
 * the middleware — a 5xx Twilio never retries — so a brownout dropped every
 * live call before any route-level voicemail could run. The resolver now
 * keeps the last successful lookup per key and answers from it ONLY when the
 * lookup throws.
 *
 * The unit test (test/telephony/twilio-webhook-credential.test.ts) proves the
 * cache over a mocked Pool; CLAUDE.md says a mocked Pool is never the only
 * proof a query works, so this file pins the real columns on the success
 * path and then cuts the connection to prove the cached answer.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts \
 *     test/integration/telephony-credential-outage-cache.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { encrypt } from '../../src/integrations/crypto';
import { createTwilioWebhookCredentialResolver } from '../../src/telephony/twilio-webhook-credential';

const ENCRYPTION_KEY = 'b'.repeat(64);
const RUN = crypto.randomInt(100000, 999999);
const A_DID = `+1737${RUN}1`;
const B_DID = `+1737${RUN}2`;
const A_SUBACCOUNT = `AClcr04a${RUN}aaaaaaaaaaaaaaaaaaaaaa`;
const B_SUBACCOUNT = `AClcr04b${RUN}bbbbbbbbbbbbbbbbbbbbbb`;
const A_TOKEN = 'tenant-a-twilio-auth-token-lcr04';
const B_TOKEN = 'tenant-b-twilio-auth-token-lcr04';

const env = () => ({
  TENANT_ENCRYPTION_KEY: ENCRYPTION_KEY,
  TWILIO_AUTH_TOKEN: 'deployment-token-lcr04',
  TWILIO_ACCOUNT_SID: 'AClcr04deployment000000000000000000',
}) as NodeJS.ProcessEnv;

/** A pool whose checkouts fail while `down` is set — a connection-timeout brownout. */
function brownoutPool(real: Pool): { pool: Pool; state: { down: boolean } } {
  const state = { down: false };
  const pool = {
    connect: () =>
      state.down
        ? Promise.reject(new Error('timeout exceeded when trying to connect'))
        : real.connect(),
  } as unknown as Pool;
  return { pool, state };
}

describe('LCR-04 — credential resolver outage cache at real Postgres', () => {
  let real: Pool;
  let tenantA: string;
  let tenantB: string;

  async function provision(did: string, subaccountSid: string, token: string): Promise<string> {
    const { tenantId } = await createTestTenant(real);
    const client = await real.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO tenant_integrations
           (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
         VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
        [tenantId, JSON.stringify({ phoneE164: did }), subaccountSid, encrypt(token, ENCRYPTION_KEY)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return tenantId;
  }

  beforeAll(async () => {
    real = await getSharedTestDb();
    tenantA = await provision(A_DID, A_SUBACCOUNT, A_TOKEN);
    tenantB = await provision(B_DID, B_SUBACCOUNT, B_TOKEN);
  });

  it('a DID verified before the brownout keeps verifying with its own tenant credential while checkouts fail', async () => {
    const { pool, state } = brownoutPool(real);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env });

    // Real columns, real rows: the DID → credential lookup works.
    expect(await resolve({ accountSid: A_SUBACCOUNT, to: A_DID })).toEqual({
      outcome: 'verify',
      authToken: A_TOKEN,
      path: 'tenant_integration',
      tenantId: tenantA,
    });

    state.down = true;
    // The cached row answers; the binding still holds on it.
    expect(await resolve({ accountSid: A_SUBACCOUNT, to: A_DID })).toEqual({
      outcome: 'verify',
      authToken: A_TOKEN,
      path: 'tenant_integration',
      tenantId: tenantA,
    });
    expect(await resolve({ accountSid: B_SUBACCOUNT, to: A_DID })).toMatchObject({
      outcome: 'refuse',
      reason: 'account_sid_not_owned_by_dialled_number_tenant',
    });
    // The DID lookup primed the tenant key: the call's mid-call callbacks
    // (verified on the session's tenant) keep verifying too.
    expect(await resolve({ tenantId: tenantA, accountSid: A_SUBACCOUNT })).toEqual({
      outcome: 'verify',
      authToken: A_TOKEN,
      path: 'tenant_integration',
      tenantId: tenantA,
    });
    // A DID never looked up before the brownout still fails closed.
    expect(await resolve({ to: B_DID })).toEqual({
      outcome: 'misconfigured',
      reason: 'credential_lookup_failed',
    });

    state.down = false;
    expect(await resolve({ to: B_DID })).toMatchObject({ outcome: 'verify', authToken: B_TOKEN, tenantId: tenantB });
  });

  it('the session-tenant and subaccount keys are cached the same way', async () => {
    const { pool, state } = brownoutPool(real);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env });
    expect(await resolve({ tenantId: tenantB, accountSid: B_SUBACCOUNT })).toMatchObject({
      outcome: 'verify',
      authToken: B_TOKEN,
      path: 'tenant_integration',
    });
    expect(await resolve({ accountSid: A_SUBACCOUNT })).toMatchObject({
      outcome: 'verify',
      authToken: A_TOKEN,
      path: 'subaccount_lookup',
    });

    state.down = true;
    expect(await resolve({ tenantId: tenantB, accountSid: B_SUBACCOUNT })).toMatchObject({
      outcome: 'verify',
      authToken: B_TOKEN,
      tenantId: tenantB,
    });
    expect(await resolve({ accountSid: A_SUBACCOUNT })).toMatchObject({
      outcome: 'verify',
      authToken: A_TOKEN,
      path: 'subaccount_lookup',
      tenantId: tenantA,
    });
  });

  it('a working lookup always wins over the cache: a rotated token is picked up on the next request', async () => {
    const { pool } = brownoutPool(real);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env });
    await resolve({ to: A_DID });
    const client = await real.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantA]);
      await client.query(
        `UPDATE tenant_integrations SET auth_token_primary_enc = $2
          WHERE tenant_id = $1 AND provider = 'twilio'`,
        [tenantA, encrypt('rotated-token-lcr04', ENCRYPTION_KEY)],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await resolve({ to: A_DID })).toMatchObject({ authToken: 'rotated-token-lcr04' });
  });
});
