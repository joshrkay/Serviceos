/**
 * Postgres integration — the two per-tenant credential readers in
 * integrations/credentials.ts read tenant_integrations under the RLS runtime
 * role.
 *
 * - `getTenantTwilioCreds` (every per-tenant SMS send, outbound calls) opened a
 *   transaction and set only the tenant GUC, never the role.
 * - `createCredentialResolver().getCredential` (Google Business review
 *   replies and the reviews worker) ran a bare `pool.query`: no GUC, no role.
 *
 * Both reads therefore ran as the privileged connection principal with the
 * tenant_integrations policy inert. The suite forces RLS_RUNTIME_ROLE on and asks
 * Postgres (statement-role-probe) which role and tenant each read ran under,
 * and checks that a tenant only ever resolves its own row.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles, type StatementRoleProbe } from './statement-role-probe';
import {
  createCredentialResolver,
  getTenantTwilioCreds,
  type CredentialResolver,
} from '../../src/integrations/credentials';
import { encrypt } from '../../src/integrations/crypto';

const ENCRYPTION_KEY = 'b'.repeat(64);
const ORIGINAL_ENV = {
  RLS_RUNTIME_ROLE: process.env.RLS_RUNTIME_ROLE,
  TENANT_ENCRYPTION_KEY: process.env.TENANT_ENCRYPTION_KEY,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
};

let pool: Pool;
let probe: StatementRoleProbe;

function restore(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A tenant with a ready Twilio integration whose subaccount and token are unique to it. */
async function seedTwilioTenant(): Promise<{ tenantId: string; subaccountSid: string; authToken: string }> {
  const { tenantId } = await createTestTenant(pool);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const subaccountSid = `AC${suffix}`;
  const authToken = `token-${suffix}`;
  await pool.query(
    `INSERT INTO tenant_integrations
       (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc, credential_version, credentials)
     VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4, 3, $5::jsonb)`,
    [
      tenantId,
      JSON.stringify({ phoneE164: `+1512${String(Date.now()).slice(-7)}`, messagingServiceSid: `MG${suffix}` }),
      subaccountSid,
      encrypt(authToken, ENCRYPTION_KEY),
      JSON.stringify({ marker: suffix }),
    ],
  );
  return { tenantId, subaccountSid, authToken };
}

function expectRuntimeRoleFor(tenantId: string): void {
  expect(probe.seen).toHaveLength(1);
  expect(probe.seen[0]).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  process.env.TENANT_ENCRYPTION_KEY = ENCRYPTION_KEY;
  // The dev/test fallback for a tenant without an integration returns these.
  process.env.TWILIO_ACCOUNT_SID = 'AC_global_fallback';
  probe = probeStatementRoles(pool, /FROM tenant_integrations/);
});

afterEach(() => {
  restore('RLS_RUNTIME_ROLE');
  restore('TENANT_ENCRYPTION_KEY');
  restore('TWILIO_ACCOUNT_SID');
});

afterAll(async () => {
  await closeSharedTestDb();
});

describe('getTenantTwilioCreds (real Postgres)', () => {
  it("resolves the tenant's own subaccount, read as rls_app_runtime", async () => {
    const a = await seedTwilioTenant();
    await seedTwilioTenant(); // a neighbour with its own row

    const creds = await getTenantTwilioCreds(a.tenantId, probe.pool);

    expect(creds).toMatchObject({ accountSid: a.subaccountSid, authToken: a.authToken, credentialVersion: 3 });
    expectRuntimeRoleFor(a.tenantId);
  });

  it("a tenant without an integration never resolves another tenant's row", async () => {
    await seedTwilioTenant();
    const { tenantId: bare } = await createTestTenant(pool);

    const creds = await getTenantTwilioCreds(bare, probe.pool);

    expect(creds).toMatchObject({ accountSid: 'AC_global_fallback', credentialVersion: 0 });
    expectRuntimeRoleFor(bare);
  });
});

describe('createCredentialResolver().getCredential (real Postgres)', () => {
  let resolver: CredentialResolver;

  beforeEach(() => {
    resolver = createCredentialResolver({ pool: probe.pool });
  });

  afterEach(async () => {
    await resolver.close();
  });

  it("returns the tenant's own row, read as rls_app_runtime", async () => {
    const a = await seedTwilioTenant();
    await seedTwilioTenant();

    const row = await resolver.getCredential(a.tenantId, 'twilio');

    expect(row).toMatchObject({ tenant_id: a.tenantId, provider: 'twilio', credential_version: 3 });
    expectRuntimeRoleFor(a.tenantId);
  });

  it("returns null for a tenant without that provider, never another tenant's row", async () => {
    await seedTwilioTenant();
    const { tenantId: bare } = await createTestTenant(pool);

    expect(await resolver.getCredential(bare, 'twilio')).toBeNull();
    expectRuntimeRoleFor(bare);
  });
});
