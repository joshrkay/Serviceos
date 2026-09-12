/**
 * #1072 — resolution order and refusal cases for the inbound-webhook
 * credential resolver.
 *
 * These are the decision branches, exercised against a stubbed pool. The
 * QUERIES themselves (the real `provider_data->>'phoneE164'`,
 * `subaccount_sid` and `auth_token_primary_enc` columns, and the
 * `app.system_lookup` GUC migration 074's read policy gates on) are pinned at
 * real Postgres by
 * `test/integration/telephony-tenant-credential-binding.test.ts` — CLAUDE.md:
 * a mocked Pool is never the only proof a query works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { createTwilioWebhookCredentialResolver } from '../../src/telephony/twilio-webhook-credential';
import { encrypt } from '../../src/integrations/crypto';

const ENC_KEY = 'b'.repeat(64);
const A_TENANT = '11111111-1111-4111-8111-111111111111';
const B_TENANT = '22222222-2222-4222-8222-222222222222';
const A_SUBACCOUNT = 'ACaaaa1072aaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'ACbbbb1072bbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-token';
const B_TOKEN = 'tenant-b-token';
const DEPLOYMENT_TOKEN = 'deployment-token';
const DEPLOYMENT_ACCOUNT_SID = 'AC00001072000000000000000000000000';
const A_DID = '+15125550101';
const B_DID = '+15125550102';

interface Row {
  tenant_id: string;
  subaccount_sid: string | null;
  auth_token_primary_enc: string | null;
}

/**
 * Stub pool that answers the resolver's three lookups from a fixture table,
 * and records every statement so the GUC discipline can be asserted.
 */
function stubPool(rows: Row[], opts: { failOn?: RegExp } = {}) {
  const statements: string[] = [];
  const released: boolean[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (opts.failOn?.test(sql)) throw new Error('connection reset by peer');
      if (/provider_data->>'phoneE164'/.test(sql)) {
        const did = values?.[0] as string;
        const map: Record<string, string> = { [A_DID]: A_TENANT, [B_DID]: B_TENANT };
        const tenant = map[did];
        return { rows: rows.filter((r) => r.tenant_id === tenant).slice(0, 1) };
      }
      if (/AND tenant_id = \$1/.test(sql)) {
        return { rows: rows.filter((r) => r.tenant_id === values?.[0]).slice(0, 1) };
      }
      if (/AND subaccount_sid = \$1/.test(sql)) {
        return { rows: rows.filter((r) => r.subaccount_sid === values?.[0]).slice(0, 1) };
      }
      return { rows: [] };
    },
    release: () => released.push(true),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, statements, released };
}

const tenantRow = (tenantId: string, subaccountSid: string | null, token: string | null): Row => ({
  tenant_id: tenantId,
  subaccount_sid: subaccountSid,
  auth_token_primary_enc: token ? encrypt(token, ENC_KEY) : null,
});

const ROWS = [
  tenantRow(A_TENANT, A_SUBACCOUNT, A_TOKEN),
  tenantRow(B_TENANT, B_SUBACCOUNT, B_TOKEN),
];

const baseEnv = (): NodeJS.ProcessEnv =>
  ({
    TWILIO_AUTH_TOKEN: DEPLOYMENT_TOKEN,
    TWILIO_ACCOUNT_SID: DEPLOYMENT_ACCOUNT_SID,
    TENANT_ENCRYPTION_KEY: ENC_KEY,
  }) as NodeJS.ProcessEnv;

describe('createTwilioWebhookCredentialResolver (#1072)', () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it('verifies with the credential of the tenant that owns the dialled number', async () => {
    const { pool } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    const decision = await resolve({ accountSid: B_SUBACCOUNT, to: B_DID });

    expect(decision).toEqual({
      outcome: 'verify',
      authToken: B_TOKEN,
      path: 'tenant_integration',
      tenantId: B_TENANT,
    });
  });

  it('THE ATTACK — refuses when the presented AccountSid is not the dialled number owner\'s', async () => {
    const { pool } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    // Tenant A's own subaccount, tenant B's DID.
    const decision = await resolve({ accountSid: A_SUBACCOUNT, to: B_DID });

    expect(decision).toMatchObject({
      outcome: 'refuse',
      reason: 'account_sid_not_owned_by_dialled_number_tenant',
      tenantId: B_TENANT,
    });
  });

  it('with no AccountSid at all, still answers with the DID owner\'s token (so a foreign signature cannot verify)', async () => {
    const { pool } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    const decision = await resolve({ to: B_DID });

    expect(decision).toMatchObject({ outcome: 'verify', authToken: B_TOKEN, tenantId: B_TENANT });
  });

  it('prefers an explicit tenantId (the media-stream upgrade\'s in-process session) over the payload', async () => {
    const { pool } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    const decision = await resolve({ accountSid: A_SUBACCOUNT, to: A_DID, tenantId: B_TENANT });

    // The session says tenant B; A's subaccount is therefore not admissible.
    expect(decision).toMatchObject({ outcome: 'refuse', tenantId: B_TENANT });
  });

  it('falls back to the deployment token for a number no tenant has provisioned', async () => {
    const { pool } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    const decision = await resolve({ to: '+15125559999' });

    expect(decision).toEqual({
      outcome: 'verify',
      authToken: DEPLOYMENT_TOKEN,
      path: 'deployment_fallback',
    });
  });

  it('uses the deployment token for an owning row that carries no credential of its own', async () => {
    // Single-account shape: the number is on the deployment's own Twilio
    // account, whose token lives in env.
    const { pool } = stubPool([tenantRow(B_TENANT, DEPLOYMENT_ACCOUNT_SID, null)]);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    const decision = await resolve({ accountSid: DEPLOYMENT_ACCOUNT_SID, to: B_DID });

    expect(decision).toEqual({
      outcome: 'verify',
      authToken: DEPLOYMENT_TOKEN,
      path: 'deployment_fallback',
      tenantId: B_TENANT,
    });
  });

  it('reports misconfiguration — never the master token — when an owning subaccount row has no stored credential', async () => {
    const { pool } = stubPool([tenantRow(B_TENANT, B_SUBACCOUNT, null)]);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    const decision = await resolve({ accountSid: B_SUBACCOUNT, to: B_DID });

    expect(decision).toMatchObject({
      outcome: 'misconfigured',
      reason: 'tenant_integration_has_no_credential',
    });
  });

  it('reports misconfiguration when the stored credential cannot be decrypted', async () => {
    const { pool } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({
      pool,
      env: () => ({ ...baseEnv(), TENANT_ENCRYPTION_KEY: undefined }) as NodeJS.ProcessEnv,
    });

    const decision = await resolve({ accountSid: B_SUBACCOUNT, to: B_DID });

    expect(decision).toMatchObject({
      outcome: 'misconfigured',
      reason: 'tenant_encryption_key_missing',
    });
  });

  it('fails closed when the lookup itself errors — never downgrades to a token that would accept the request', async () => {
    const { pool } = stubPool(ROWS, { failOn: /phoneE164/ });
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    const decision = await resolve({ accountSid: A_SUBACCOUNT, to: B_DID });

    expect(decision).toMatchObject({ outcome: 'misconfigured', reason: 'credential_lookup_failed' });
  });

  it('uses the legacy subaccount lookup only when the payload names no number we own', async () => {
    const { pool } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    // A status callback with no dialled number in it.
    const decision = await resolve({ accountSid: A_SUBACCOUNT });

    expect(decision).toEqual({
      outcome: 'verify',
      authToken: A_TOKEN,
      path: 'subaccount_lookup',
      tenantId: A_TENANT,
    });
  });

  it('scopes every lookup with the system_lookup GUC and always releases the client', async () => {
    const { pool, statements, released } = stubPool(ROWS);
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    await resolve({ accountSid: B_SUBACCOUNT, to: B_DID });

    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain("set_config('app.system_lookup', 'true', true)");
    expect(statements).toContain('COMMIT');
    expect(released).toEqual([true]);
  });

  it('rolls back and releases when a lookup throws', async () => {
    const { pool, statements, released } = stubPool(ROWS, { failOn: /phoneE164/ });
    const resolve = createTwilioWebhookCredentialResolver({ pool, env: baseEnv });

    await resolve({ to: B_DID });

    expect(statements).toContain('ROLLBACK');
    expect(released).toEqual([true]);
  });

  it('with no pool (dev boot without DATABASE_URL) answers with the deployment token', async () => {
    const resolve = createTwilioWebhookCredentialResolver({ env: baseEnv });

    expect(await resolve({ accountSid: A_SUBACCOUNT, to: A_DID })).toEqual({
      outcome: 'verify',
      authToken: DEPLOYMENT_TOKEN,
      path: 'deployment_fallback',
    });
  });

  it('fails closed when the deployment has no token to fall back to', async () => {
    const resolve = createTwilioWebhookCredentialResolver({
      env: () => ({}) as NodeJS.ProcessEnv,
    });

    expect(await resolve({ to: A_DID })).toMatchObject({
      outcome: 'misconfigured',
      reason: 'no_twilio_auth_token_configured',
    });
  });
});
