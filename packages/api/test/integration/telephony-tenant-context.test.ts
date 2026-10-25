/**
 * Postgres integration — the telephony reads with a known tenant run under
 * the RLS runtime role (raw-pg audit 2026-10-23 §4 P1.3, P1.7).
 *
 * - `loadTenantBusinessHours` (tenant_settings) — the inbound /voice
 *   after-hours fork (dialled-number tenant) and /api/analytics/voice-roi.
 * - the credential resolver's tenant-keyed lookup (`findByTenant`,
 *   tenant_integrations) — the media-stream upgrade and mid-call callbacks,
 *   whose tenant is the trusted in-process session's. It ran under the
 *   cross-tenant `app.system_lookup` escape GUC as the principal although
 *   the tenant was already known.
 *
 * Both ran `WHERE tenant_id = $1` as the privileged principal. For each, with
 * RLS_RUNTIME_ROLE on: it answers for its own tenant against the real
 * columns, as rls_app_runtime with the calling tenant's GUC; with the tenant
 * pin widened to both seeded tenants RLS still keeps the other tenant out;
 * control: the widened statement as the principal reaches it; and the role
 * keeps the grants it needs after migration 219.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { isTenantAfterHours, loadTenantBusinessHours } from '../../src/telephony/business-hours-loader';
import { createTwilioWebhookCredentialResolver } from '../../src/telephony/twilio-webhook-credential';
import { encrypt } from '../../src/integrations/crypto';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const ENC_KEY = 'c'.repeat(64);
const DEPLOYMENT_TOKEN = 'deployment-token-tenant-context';
const RUN = crypto.randomInt(100000, 999999);

let pool: Pool;
const tenantIds: string[] = [];

async function seedTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  return tenantId;
}

/** A schedule open Monday only, in the given zone. */
function mondayOnly(open: string, close: string) {
  return { mon: { open, close } };
}

async function seedSettings(tenantId: string, hours: object, timezone: string): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, business_hours, timezone)
     VALUES (gen_random_uuid(), $1, 'Hours Shop', $2::jsonb, $3)`,
    [tenantId, JSON.stringify(hours), timezone],
  );
}

async function seedTwilio(tenantId: string, n: number, token: string): Promise<string> {
  const subaccount = `AC${String(RUN)}${String(n).padStart(26, '0')}`;
  await pool.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
     VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
    [tenantId, JSON.stringify({ phoneE164: `+1737${RUN}${n}` }), subaccount, encrypt(token, ENC_KEY)],
  );
  return subaccount;
}

const env = () =>
  ({ TWILIO_AUTH_TOKEN: DEPLOYMENT_TOKEN, TENANT_ENCRYPTION_KEY: ENC_KEY }) as unknown as NodeJS.ProcessEnv;

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    await pool.query('DELETE FROM tenant_integrations WHERE tenant_id = $1', [id]).catch(() => undefined);
    await pool.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [id]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [id]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('loadTenantBusinessHours — tenant_settings read under the RLS runtime role (real Postgres)', () => {
  let withHours: string;
  let otherWithHours: string;
  let withoutSettings: string;

  beforeAll(async () => {
    withHours = await seedTenant();
    otherWithHours = await seedTenant();
    withoutSettings = await seedTenant();
    await seedSettings(withHours, mondayOnly('08:00', '17:00'), 'America/Chicago');
    await seedSettings(otherWithHours, mondayOnly('06:00', '22:00'), 'America/Denver');
  });

  it("reads the calling tenant's business_hours and timezone, as rls_app_runtime for that tenant", async () => {
    const probe = probeStatementRoles(pool, /FROM tenant_settings/);

    expect(await loadTenantBusinessHours(probe.pool, withHours)).toEqual({
      timezone: 'America/Chicago',
      schedule: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }],
    });
    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: withHours })]);

    // A Sunday is outside a Monday-only schedule.
    expect(await isTenantAfterHours(pool, withHours, new Date('2026-10-25T18:00:00Z'))).toBe(true);
  });

  it("with the tenant pin widened to both tenants, RLS still keeps the other tenant's row out", async () => {
    const widened = widenTenantPredicates(pool, {
      target: /FROM tenant_settings/,
      tenants: [withoutSettings, otherWithHours],
    });

    expect(await loadTenantBusinessHours(widened.pool, withoutSettings)).toBeNull();
    expect(widened.rewritten).toHaveLength(1);
  });

  it("control: the same widened read run as the connection principal returns the other tenant's hours", async () => {
    const widened = widenTenantPredicates(pool, {
      target: /FROM tenant_settings/,
      tenants: [withoutSettings, otherWithHours],
      asPrincipal: true,
    });

    expect(await loadTenantBusinessHours(widened.pool, withoutSettings)).toMatchObject({ timezone: 'America/Denver' });
    expect(widened.rewritten).toHaveLength(1);
  });
});

describe("credential resolver's tenant-keyed lookup — tenant_integrations under the RLS runtime role (real Postgres)", () => {
  let owner: string;
  let ownerSubaccount: string;
  let other: string;
  let noIntegration: string;

  beforeAll(async () => {
    owner = await seedTenant();
    other = await seedTenant();
    noIntegration = await seedTenant();
    ownerSubaccount = await seedTwilio(owner, 1, 'owner-tenant-token');
    await seedTwilio(other, 2, 'other-tenant-token');
  });

  it("verifies a known-tenant callback with that tenant's own token, read as rls_app_runtime without system_lookup", async () => {
    const probe = probeStatementRoles(pool, /FROM tenant_integrations/);
    const resolve = createTwilioWebhookCredentialResolver({ pool: probe.pool, env });

    expect(await resolve({ tenantId: owner, accountSid: ownerSubaccount })).toEqual({
      outcome: 'verify',
      authToken: 'owner-tenant-token',
      path: 'tenant_integration',
      tenantId: owner,
    });
    expect(probe.seen).toEqual([expect.objectContaining({ role: 'rls_app_runtime', tenantGuc: owner })]);
  });

  it("with the tenant pin widened to both tenants, RLS still keeps the other tenant's credential out", async () => {
    const widened = widenTenantPredicates(pool, {
      target: /FROM tenant_integrations/,
      tenants: [noIntegration, other],
    });
    const resolve = createTwilioWebhookCredentialResolver({ pool: widened.pool, env });

    // No row of its own: the deployment token, bound to no tenant.
    expect(await resolve({ tenantId: noIntegration })).toEqual({
      outcome: 'verify',
      authToken: DEPLOYMENT_TOKEN,
      path: 'deployment_fallback',
    });
    expect(widened.rewritten).toHaveLength(1);
  });

  it("control: the same widened lookup run as the connection principal answers with the other tenant's credential", async () => {
    const widened = widenTenantPredicates(pool, {
      target: /FROM tenant_integrations/,
      tenants: [noIntegration, other],
      asPrincipal: true,
    });
    const resolve = createTwilioWebhookCredentialResolver({ pool: widened.pool, env });

    expect(await resolve({ tenantId: noIntegration })).toMatchObject({
      outcome: 'verify',
      authToken: 'other-tenant-token',
      tenantId: other,
    });
    expect(widened.rewritten).toHaveLength(1);
  });
});

describe('grants: rls_app_runtime keeps what these reads need after migration 219', () => {
  it('tenant_settings and tenant_integrations stay SELECT-able', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['tenant_settings', 'SELECT'],
        ['tenant_integrations', 'SELECT'],
      ]),
    ).toEqual([]);
  });
});
