/**
 * Postgres integration — migration 306 signup-attribution columns on tenants
 * and PgTenantRepository.setSignupAttribution's write-once guard. Pins the
 * real column names/types the Clerk user.created webhook writes (the
 * handler-level test mocks the repository).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { getSharedTestDb } from './shared';

async function readAttribution(pool: Pool, tenantId: string) {
  const { rows } = await pool.query(
    `SELECT signup_utm_source, signup_utm_medium, signup_utm_campaign, signup_utm_content,
            signup_utm_term, signup_referrer, signup_landing_path,
            to_char(signup_first_touch_at, 'YYYY-MM-DD') AS signup_first_touch_at
       FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return rows[0];
}

describe('Postgres tenant signup attribution', () => {
  let pool: Pool;
  let repo: PgTenantRepository;
  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgTenantRepository(pool);
  });

  async function newTenant() {
    const ownerId = `user_attr_${randomUUID()}`;
    return repo.create({ ownerId, ownerEmail: `${ownerId}@example.com`, name: 'Attr Org' });
  }

  it('new tenants start with every attribution column NULL', async () => {
    const tenant = await newTenant();
    expect(await readAttribution(pool, tenant.id)).toEqual({
      signup_utm_source: null,
      signup_utm_medium: null,
      signup_utm_campaign: null,
      signup_utm_content: null,
      signup_utm_term: null,
      signup_referrer: null,
      signup_landing_path: null,
      signup_first_touch_at: null,
    });
  });

  it('writes every field into its column (first-touch as a DATE)', async () => {
    const tenant = await newTenant();
    const wrote = await repo.setSignupAttribution(tenant.id, {
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'spring',
      utmContent: 'ad1',
      utmTerm: 'hvac software',
      ref: 'https://www.google.com/search',
      landing: '/pricing',
      firstTouchAt: '2026-10-01',
    });
    expect(wrote).toBe(true);
    expect(await readAttribution(pool, tenant.id)).toEqual({
      signup_utm_source: 'google',
      signup_utm_medium: 'cpc',
      signup_utm_campaign: 'spring',
      signup_utm_content: 'ad1',
      signup_utm_term: 'hvac software',
      signup_referrer: 'https://www.google.com/search',
      signup_landing_path: '/pricing',
      signup_first_touch_at: '2026-10-01',
    });
  });

  it('is write-once: a second call (webhook redelivery) never overwrites the first touch', async () => {
    const tenant = await newTenant();
    expect(await repo.setSignupAttribution(tenant.id, { landing: '/blog' })).toBe(true);
    expect(await repo.setSignupAttribution(tenant.id, { utmSource: 'bing', landing: '/other' })).toBe(false);
    const row = await readAttribution(pool, tenant.id);
    expect(row.signup_landing_path).toBe('/blog');
    expect(row.signup_utm_source).toBeNull();
  });

  it('returns false for an unknown tenant', async () => {
    expect(await repo.setSignupAttribution(randomUUID(), { utmSource: 'x' })).toBe(false);
  });
});
