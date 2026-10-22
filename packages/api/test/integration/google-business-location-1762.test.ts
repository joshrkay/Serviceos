/**
 * #1762 — pins the credentials JSONB shape the Google Business connect
 * flow stores (place ID, review link, location status) against the real
 * tenant_integrations table, and that settings.google_review_url is the
 * column the review-link fill writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgGoogleBusinessIntegrationRepository } from '../../src/reputation/google-business-integration';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

const TEST_KEY = '0'.repeat(64);

describe('Google Business location storage (#1762)', () => {
  let pool: Pool;
  let originalKey: string | undefined;

  beforeAll(async () => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = TEST_KEY;
    pool = await getSharedTestDb();
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
    await closeSharedTestDb();
  });

  const base = {
    accessToken: 'AT',
    refreshToken: 'RT',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  };

  it('stores placeId / reviewUrl under credentials.providerData and reads them back', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgGoogleBusinessIntegrationRepository(pool);
    await repo.upsert({
      ...base,
      tenantId,
      accountId: '123',
      locationId: '999',
      locationTitle: 'Acme HVAC',
      placeId: 'PID-999',
      reviewUrl: 'https://search.google.com/local/writereview?placeid=PID-999',
    });

    const raw = await pool.query(
      `SELECT credentials->'providerData' AS pd FROM tenant_integrations
        WHERE tenant_id = $1 AND provider = 'google_business'`,
      [tenantId],
    );
    expect(raw.rows[0].pd).toEqual({
      accountId: '123',
      locationId: '999',
      locationTitle: 'Acme HVAC',
      placeId: 'PID-999',
      reviewUrl: 'https://search.google.com/local/writereview?placeid=PID-999',
    });

    const summary = await repo.get(tenantId);
    expect(summary).toMatchObject({
      locationStatus: 'connected',
      placeId: 'PID-999',
      locationId: '999',
    });
  });

  it('needs_selection and no_location round-trip; setLocation resolves the pick and keeps tokens', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgGoogleBusinessIntegrationRepository(pool);
    await repo.upsert({ ...base, tenantId, accountId: '123', needsSelection: true });
    expect((await repo.get(tenantId))?.locationStatus).toBe('needs_selection');

    const picked = await repo.setLocation(tenantId, {
      accountId: '123',
      locationId: '1000',
      placeId: 'PID-1000',
      reviewUrl: 'https://example.test/review',
    });
    expect(picked?.locationStatus).toBe('connected');
    const raw = await pool.query(
      `SELECT credentials->'providerData' AS pd FROM tenant_integrations
        WHERE tenant_id = $1 AND provider = 'google_business'`,
      [tenantId],
    );
    expect(raw.rows[0].pd).not.toHaveProperty('locationStatus');
    expect((await repo.getAuth(tenantId))?.tokens.refreshToken).toBe('RT');

    const { tenantId: t2 } = await createTestTenant(pool);
    await repo.upsert({ ...base, tenantId: t2 });
    expect((await repo.get(t2))?.locationStatus).toBe('no_location');
    expect(await repo.setLocation('00000000-0000-4000-8000-000000000000', {
      accountId: '1',
      locationId: '2',
    })).toBeNull();
  });

  it('google_review_url is a real tenant_settings column the fill can write', async () => {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, business_hours, job_buffer_minutes, hourly_rate_cents, timezone, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days)
       VALUES (gen_random_uuid(), $1, 'Acme', '{}'::jsonb, 30, 12500, 'America/New_York', 'EST', 'INV', 1, 1, 30)`,
      [tenantId],
    );
    const settings = new PgSettingsRepository(pool);
    await settings.update(tenantId, { googleReviewUrl: 'https://example.test/review' });
    const row = await pool.query(`SELECT google_review_url FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
    expect(row.rows[0].google_review_url).toBe('https://example.test/review');
  });
});
