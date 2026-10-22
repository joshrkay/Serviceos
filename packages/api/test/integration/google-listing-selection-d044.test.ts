/**
 * Docker-gated integration test for #1762 (D-044) — the Google listing the
 * owner chooses is stored in `tenant_integrations.credentials.providerData`
 * and the review link lands in `tenant_settings.google_review_url`.
 *
 * Pins the real JSONB merge in PgGoogleBusinessIntegrationRepository
 * (selectLocation keeps the tokens and locationCount, replaces the listing
 * fields), the token read the picker uses, and the settings write, against
 * a real Postgres under RLS. No Google calls.
 *
 * #1763 — also pins tenant_settings.get_found_online_dismissed_at (migration
 * 330), read and written by the home checklist's dismissal repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgGoogleBusinessIntegrationRepository } from '../../src/reputation/google-business-integration';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { applyDerivedGoogleReviewUrl } from '../../src/reputation/google-review-link';
import { PgGetFoundOnlineDismissalRepository } from '../../src/onboarding/get-found-online-dismissal';

const KEY = 'b'.repeat(64);

describe('D-044 Google listing selection (real Postgres)', () => {
  let pool: Pool;
  let originalKey: string | undefined;

  beforeAll(async () => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = KEY;
    pool = await getSharedTestDb();
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
    await closeSharedTestDb();
  });

  it('selectLocation merges the listing into providerData and keeps the tokens', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgGoogleBusinessIntegrationRepository(pool);

    const connected = await repo.upsert({
      tenantId,
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      accessTokenExpiresAt: new Date('2026-10-22T05:00:00Z'),
      locationCount: 2,
    });
    expect(connected).toMatchObject({ locationId: null, locationCount: 2 });

    const selected = await repo.selectLocation(tenantId, {
      accountId: '456',
      locationId: '555',
      placeId: 'ChIJnorth',
      reviewUrl: 'https://g.page/r/review-555',
      locationTitle: 'Acme North',
    });
    expect(selected).toMatchObject({
      accountId: '456',
      locationId: '555',
      placeId: 'ChIJnorth',
      reviewUrl: 'https://g.page/r/review-555',
      locationTitle: 'Acme North',
      locationCount: 2,
    });

    // The tokens survive the merge (the picker and the poll worker read them).
    expect(await repo.getTokens(tenantId)).toEqual({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresAt: new Date('2026-10-22T05:00:00.000Z'),
    });

    // Raw row: the worker's providerData keys are where it reads them.
    const { rows } = await pool.query(
      `SELECT credentials->'providerData' AS pd, credential_version
         FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'google_business'`,
      [tenantId],
    );
    expect(rows[0].pd).toMatchObject({ accountId: '456', locationId: '555', locationCount: 2 });
    expect(rows[0].credential_version).toBe(2);
  });

  it('selectLocation on a tenant with no connection returns null', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgGoogleBusinessIntegrationRepository(pool);
    expect(
      await repo.selectLocation(tenantId, {
        accountId: '1',
        locationId: '2',
        placeId: null,
        reviewUrl: null,
        locationTitle: null,
      }),
    ).toBeNull();
    expect(await repo.getTokens(tenantId)).toBeNull();
  });

  it('the derived review link is written to tenant_settings.google_review_url, never over a typed one', async () => {
    const { tenantId } = await createTestTenant(pool);
    const settingsRepo = new PgSettingsRepository(pool);
    await settingsRepo.upsertIdentityFields(tenantId, { businessName: 'Acme' });

    expect(
      await applyDerivedGoogleReviewUrl(settingsRepo, tenantId, null, 'https://g.page/r/review-999'),
    ).toBe(true);
    const read = async () =>
      (
        await pool.query(`SELECT google_review_url FROM tenant_settings WHERE tenant_id = $1`, [
          tenantId,
        ])
      ).rows[0].google_review_url;
    expect(await read()).toBe('https://g.page/r/review-999');

    await settingsRepo.update(tenantId, { googleReviewUrl: 'https://g.page/r/typed' });
    expect(
      await applyDerivedGoogleReviewUrl(
        settingsRepo,
        tenantId,
        'https://g.page/r/review-999',
        'https://g.page/r/review-555',
      ),
    ).toBe(false);
    expect(await read()).toBe('https://g.page/r/typed');
  });

  it('the checklist dismissal round-trips through tenant_settings.get_found_online_dismissed_at', async () => {
    const { tenantId } = await createTestTenant(pool);
    const repo = new PgGetFoundOnlineDismissalRepository(pool);
    // No settings row yet: nothing to record it on.
    expect(await repo.dismiss(tenantId, new Date())).toBe(false);

    await new PgSettingsRepository(pool).upsertIdentityFields(tenantId, { businessName: 'Acme' });
    expect(await repo.getDismissedAt(tenantId)).toBeNull();
    const at = new Date('2026-10-22T06:00:00.000Z');
    expect(await repo.dismiss(tenantId, at)).toBe(true);
    expect(await repo.getDismissedAt(tenantId)).toEqual(at);
  });
});
