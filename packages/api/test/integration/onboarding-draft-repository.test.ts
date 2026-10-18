import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import {
  PgOnboardingDraftRepository,
  DraftVersionConflictError,
  DraftAlreadyApprovedError,
  DraftNotFoundError,
} from '../../src/onboarding/draft/repository';
import { assembleTypicalShop } from '../../src/onboarding/choices/assemble';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';

describe('onboarding_drafts repository', () => {
  let pool: Pool;
  let repo: PgOnboardingDraftRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgOnboardingDraftRepository(pool);
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function freshAssembled() {
    return assembleTypicalShop(new PgRegionalPriceTierRepository(pool), {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
    });
  }

  it('has the expected columns, one draft per tenant, and RLS enabled and forced', async () => {
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'onboarding_drafts' ORDER BY ordinal_position`,
    );
    const cols = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    expect(cols).toMatchObject({
      id: 'uuid',
      tenant_id: 'uuid',
      pack_id: 'text',
      trade: 'text',
      metro_code: 'text',
      metro_name: 'text',
      business_name: 'text',
      owner_first_name: 'text',
      client_timezone: 'text',
      assembled: 'jsonb',
      choices: 'jsonb',
      status: 'text',
      version: 'integer',
      proposal_ids: 'jsonb',
      created_at: 'timestamp with time zone',
      updated_at: 'timestamp with time zone',
      approved_at: 'timestamp with time zone',
    });
    const rls = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'onboarding_drafts'`,
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const uniq = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'onboarding_drafts'`,
    );
    expect(uniq.rows.some((r) => /UNIQUE/.test(r.indexdef) && /tenant_id/.test(r.indexdef))).toBe(true);
  });

  it('creates a draft at version 1 with the assembled shop and no choices, and is idempotent per tenant', async () => {
    const assembled = await freshAssembled();
    const created = await repo.create(tenant.tenantId, {
      packId: 'plumbing',
      trade: 'plumbing',
      metroCode: 'CLE',
      metroName: 'Cleveland',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      clientTimezone: 'America/New_York',
      assembled,
    });
    expect(created.version).toBe(1);
    expect(created.status).toBe('draft');
    expect(created.choices).toEqual({});
    expect(created.assembled.choices.length).toBe(assembled.choices.length);

    const again = await repo.create(tenant.tenantId, {
      packId: 'hvac',
      trade: 'hvac',
      metroCode: null,
      metroName: null,
      businessName: 'Should Not Replace',
      ownerFirstName: null,
      clientTimezone: null,
      assembled,
    });
    expect(again.id).toBe(created.id);
    expect(again.businessName).toBe('Walsh Plumbing');
    expect(await repo.getForTenant(tenant.tenantId)).toMatchObject({ id: created.id, packId: 'plumbing' });
  });

  it('stages a choice with compare-and-swap on version', async () => {
    const assembled = await freshAssembled();
    const d = await repo.create(tenant.tenantId, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', clientTimezone: null, assembled });

    const v2 = await repo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, d.version);
    expect(v2.version).toBe(2);
    expect(v2.choices.greeting).toEqual({ option: 'b' });

    const v3 = await repo.stageChoice(
      tenant.tenantId,
      'trip_fee_and_rate',
      { override: { label: '$120 to come out, then $175 an hour', writes: {}, prices: { tripFeeCents: 12000, hourlyRateCents: 17500 } } },
      v2.version,
    );
    expect(v3.version).toBe(3);
    expect(v3.choices.greeting).toEqual({ option: 'b' });
    expect(v3.choices.trip_fee_and_rate).toMatchObject({ override: { prices: { tripFeeCents: 12000, hourlyRateCents: 17500 } } });

    await expect(repo.stageChoice(tenant.tenantId, 'greeting', { option: 'a' }, 2)).rejects.toBeInstanceOf(DraftVersionConflictError);
    expect((await repo.getForTenant(tenant.tenantId))!.choices.greeting).toEqual({ option: 'b' });
  });

  it('rejects staging on a tenant without a draft, and on an approved draft', async () => {
    await expect(repo.stageChoice(tenant.tenantId, 'greeting', { option: 'a' }, 1)).rejects.toBeInstanceOf(DraftNotFoundError);
    const assembled = await freshAssembled();
    const d = await repo.create(tenant.tenantId, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', clientTimezone: null, assembled });
    const approved = await repo.markApproved(tenant.tenantId, ['11111111-1111-1111-1111-111111111111']);
    expect(approved.status).toBe('approved');
    expect(approved.proposalIds).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(approved.approvedAt).toBeInstanceOf(Date);
    await expect(repo.stageChoice(tenant.tenantId, 'greeting', { option: 'a' }, approved.version)).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    // Approving twice is a no-op that returns the same row.
    const twice = await repo.markApproved(tenant.tenantId, ['22222222-2222-2222-2222-222222222222']);
    expect(twice.proposalIds).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(twice.version).toBe(approved.version);
    void d;
  });

  it('does not leak drafts across tenants', async () => {
    const other = await createTestTenant(pool);
    const assembled = await freshAssembled();
    await repo.create(tenant.tenantId, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: null, clientTimezone: null, assembled });
    expect(await repo.getForTenant(other.tenantId)).toBeNull();
    await expect(repo.stageChoice(other.tenantId, 'greeting', { option: 'a' }, 1)).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it('rejects a staged choice that fails the contract before it touches the table', async () => {
    const assembled = await freshAssembled();
    const d = await repo.create(tenant.tenantId, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: null, clientTimezone: null, assembled });
    await expect(
      repo.stageChoice(tenant.tenantId, 'greeting', { option: 'c' } as unknown as { option: 'a' }, d.version),
    ).rejects.toThrow();
    await expect(
      repo.stageChoice(tenant.tenantId, 'nope' as 'greeting', { option: 'a' }, d.version),
    ).rejects.toThrow();
    expect((await repo.getForTenant(tenant.tenantId))!.version).toBe(1);
  });
});
