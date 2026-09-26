/**
 * #1061 — the payload-alias DID → tenant callback app.ts wires
 * (`createDidTenantResolver`) resolves through the real
 * `PgPhoneNumberRepository` at real Postgres, and outside dev never answers
 * `TWILIO_DEFAULT_TENANT_ID` for a number no tenant owns.
 *
 * Replaces app.ts's `resolveTenantIdByPhoneNumber`, a second copy of the DID
 * SQL that answered the env default on a miss, on an empty `To` and on any DB
 * error — in every environment. CLAUDE.md: a mocked Pool is never the only
 * proof a query works, so the lookup is pinned here against the real
 * `tenant_integrations.provider_data->>'phoneE164'` column and the
 * `app.system_lookup` GUC migration 074's read policy gates on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { createDidTenantResolver } from '../../src/routes/telephony';
import { PgPhoneNumberRepository } from '../../src/integrations/twilio/phone-number-repository';

/** Per-run DID — migration 274 makes a DID unique across tenants in the shared DB. */
const RUN = crypto.randomInt(100000, 999999);
const OWNED_DID = `+1737${RUN}1`;
const UNOWNED_DID = `+1737${RUN}9`;

describe('#1061 — createDidTenantResolver at real Postgres', () => {
  let pool: Pool;
  let ownerTenantId: string;
  let defaultTenantId: string;
  const savedDefault = process.env.TWILIO_DEFAULT_TENANT_ID;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    ownerTenantId = (await createTestTenant(pool)).tenantId;
    defaultTenantId = (await createTestTenant(pool)).tenantId;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [ownerTenantId]);
      await client.query(
        `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
         VALUES ($1, 'twilio', 'full_readiness', $2::jsonb)`,
        [ownerTenantId, JSON.stringify({ phoneE164: OWNED_DID })],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    process.env.TWILIO_DEFAULT_TENANT_ID = defaultTenantId;
  });

  afterEach(() => {
    process.env.TWILIO_DEFAULT_TENANT_ID = defaultTenantId;
  });

  afterAll(async () => {
    if (savedDefault === undefined) delete process.env.TWILIO_DEFAULT_TENANT_ID;
    else process.env.TWILIO_DEFAULT_TENANT_ID = savedDefault;
    await closeSharedTestDb();
  });

  it('resolves an owned DID to its tenant through PgPhoneNumberRepository', async () => {
    const resolve = createDidTenantResolver({
      phoneNumberRepo: new PgPhoneNumberRepository(pool),
      nodeEnv: 'production',
    });
    expect(await resolve({ to: OWNED_DID, from: '' })).toBe(ownerTenantId);
  });

  it('production: an unowned DID and a missing To are undefined, NOT the env default', async () => {
    const resolve = createDidTenantResolver({
      phoneNumberRepo: new PgPhoneNumberRepository(pool),
      nodeEnv: 'production',
    });
    expect(await resolve({ to: UNOWNED_DID, from: '' })).toBeUndefined();
    expect(await resolve({ to: '', from: '' })).toBeUndefined();
  });

  it('development: an unowned DID falls back to the env default (dev seam)', async () => {
    const resolve = createDidTenantResolver({
      phoneNumberRepo: new PgPhoneNumberRepository(pool),
      nodeEnv: 'development',
    });
    expect(await resolve({ to: UNOWNED_DID, from: '' })).toBe(defaultTenantId);
  });
});
