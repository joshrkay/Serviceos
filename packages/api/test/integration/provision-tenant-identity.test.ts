/**
 * #1201 — `scripts/provision-tenant.ts` wrote `job_buffer_minutes = 30` with
 * no audit, so migration 277 later nulled those tenants while conversational
 * ones (which also wrote 30, with an audit) stayed labelled 'tenant'. The
 * provisioning CLI never asks for a buffer either: it must store NULL
 * ("not configured"; readers apply the 30-minute default) and must not
 * clobber a buffer a tenant already chose when re-run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { seedProvisionIdentity } from '../../scripts/provision-tenant-identity';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';

let pool: Pool;

beforeAll(async () => {
  pool = await getSharedTestDb();
});

afterAll(async () => {
  await closeSharedTestDb();
});

async function rawSettings(tenantId: string) {
  const { rows } = await pool.query<{
    business_name: string;
    job_buffer_minutes: number | null;
    hourly_rate_cents: number | null;
  }>(
    `SELECT business_name, job_buffer_minutes, hourly_rate_cents FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0];
}

describe('#1201 — provisioning CLI identity write', () => {
  it('stores NO job buffer on a fresh tenant (NULL = default), and readers still see the 30-minute default', async () => {
    const t = await createTestTenant(pool);
    await seedProvisionIdentity(pool, t.tenantId, 'Provisioned HVAC Co');

    expect(await rawSettings(t.tenantId)).toEqual({
      business_name: 'Provisioned HVAC Co',
      job_buffer_minutes: null,
      hourly_rate_cents: 12500,
    });
    const facts = await loadOnboardingFacts(
      { pool, settingsRepo: new PgSettingsRepository(pool) },
      t.tenantId,
    );
    expect(facts.identity.jobBufferMinutes).toBe(30);
  });

  it('a re-run keeps a buffer the tenant has since chosen', async () => {
    const t = await createTestTenant(pool);
    await seedProvisionIdentity(pool, t.tenantId, 'First Name Co');
    await pool.query(`UPDATE tenant_settings SET job_buffer_minutes = 45 WHERE tenant_id = $1`, [
      t.tenantId,
    ]);

    await seedProvisionIdentity(pool, t.tenantId, 'Renamed Co');

    expect(await rawSettings(t.tenantId)).toMatchObject({
      business_name: 'Renamed Co',
      job_buffer_minutes: 45,
    });
  });
});
