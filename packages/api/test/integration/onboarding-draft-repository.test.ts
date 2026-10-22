import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import {
  PgOnboardingDraftRepository,
  DraftVersionConflictError,
  DraftAlreadyApprovedError,
  DraftNotApprovedError,
  DraftNotFoundError,
} from '../../src/onboarding/draft/repository';
import { assembleTypicalShop } from '../../src/onboarding/choices/assemble';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { WritesNotAllowedError } from '../../src/onboarding/choices/schema';

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
    const approved = await repo.markApproved(tenant.tenantId, ['11111111-1111-1111-1111-111111111111'], d.version);
    expect(approved.status).toBe('approved');
    expect(approved.proposalIds).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(approved.approvedAt).toBeInstanceOf(Date);
    await expect(repo.stageChoice(tenant.tenantId, 'greeting', { option: 'a' }, approved.version)).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    // Approving twice is refused (never a silent no-op returning another row) and changes nothing.
    await expect(
      repo.markApproved(tenant.tenantId, ['22222222-2222-2222-2222-222222222222'], approved.version),
    ).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    const raw = await pool.query<{ proposal_ids: string[]; version: number }>(
      'SELECT proposal_ids, version FROM onboarding_drafts WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    expect(raw.rows[0]).toEqual({ proposal_ids: ['11111111-1111-1111-1111-111111111111'], version: approved.version });
  });

  it('setClientTimezone round-trips the column, bumps version, and is refused once approved', async () => {
    await expect(repo.setClientTimezone(tenant.tenantId, 'America/Phoenix')).rejects.toBeInstanceOf(DraftNotFoundError);
    const assembled = await freshAssembled();
    const d = await repo.create(tenant.tenantId, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: null, clientTimezone: null, assembled });
    expect(d.clientTimezone).toBeNull();

    const updated = await repo.setClientTimezone(tenant.tenantId, 'America/Phoenix');
    expect(updated.clientTimezone).toBe('America/Phoenix');
    expect(updated.version).toBe(d.version + 1);
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(d.updatedAt.getTime());
    const raw = await pool.query<{ client_timezone: string; version: number }>(
      'SELECT client_timezone, version FROM onboarding_drafts WHERE tenant_id = $1',
      [tenant.tenantId],
    );
    expect(raw.rows[0]).toEqual({ client_timezone: 'America/Phoenix', version: d.version + 1 });
    expect((await repo.getForTenant(tenant.tenantId))!.clientTimezone).toBe('America/Phoenix');

    await repo.markApproved(tenant.tenantId, ['11111111-1111-1111-1111-111111111111'], updated.version);
    await expect(repo.setClientTimezone(tenant.tenantId, 'America/Denver')).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    expect((await repo.getForTenant(tenant.tenantId))!.clientTimezone).toBe('America/Phoenix');
  });

  it('rejects an override carrying writes the choice does not own, or misplaced prices, without touching the row', async () => {
    const assembled = await freshAssembled();
    const d = await repo.create(tenant.tenantId, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: null, clientTimezone: null, assembled });
    await expect(
      repo.stageChoice(tenant.tenantId, 'greeting', { override: { label: 'x', writes: { autonomousBookingEnabled: true } } }, d.version),
    ).rejects.toBeInstanceOf(WritesNotAllowedError);
    await expect(
      repo.stageChoice(tenant.tenantId, 'trip_fee_and_rate', { override: { label: 'x', writes: {} } }, d.version),
    ).rejects.toBeInstanceOf(WritesNotAllowedError);
    await expect(
      repo.stageChoice(tenant.tenantId, 'greeting', { override: { label: 'x', writes: {}, prices: { tripFeeCents: 1, hourlyRateCents: 2 } } }, d.version),
    ).rejects.toBeInstanceOf(WritesNotAllowedError);
    const after = (await repo.getForTenant(tenant.tenantId))!;
    expect(after.version).toBe(d.version);
    expect(after.choices).toEqual({});
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
  const PID = '11111111-1111-1111-1111-111111111111';
  async function seedDraft() {
    const assembled = await freshAssembled();
    return repo.create(tenant.tenantId, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: null, clientTimezone: 'America/New_York', assembled });
  }
  type RawDraft = { status: string; version: number; proposal_ids: string[]; approved_at: Date | null };
  const rawDraft = async (): Promise<RawDraft> =>
    (await pool.query<RawDraft>('SELECT status, version, proposal_ids, approved_at FROM onboarding_drafts WHERE tenant_id = $1', [tenant.tenantId])).rows[0];

  it('markApproved writes status, proposal_ids, version + 1 and approved_at on the raw row', async () => {
    const d = await seedDraft();
    await repo.markApproved(tenant.tenantId, [PID], d.version);
    const raw = await rawDraft();
    expect(raw.status).toBe('approved');
    expect(raw.proposal_ids).toEqual([PID]);
    expect(raw.version).toBe(d.version + 1);
    expect(raw.approved_at).toBeInstanceOf(Date);
  });

  it('markApproved with a stale version rejects with DraftVersionConflictError and leaves the row untouched', async () => {
    const d = await seedDraft();
    const staged = await repo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, d.version);
    await expect(repo.markApproved(tenant.tenantId, [PID], d.version)).rejects.toMatchObject({
      name: 'DraftVersionConflictError',
      expected: d.version,
      actual: staged.version,
    });
    expect(await rawDraft()).toEqual({ status: 'draft', version: staged.version, proposal_ids: [], approved_at: null });
  });

  it('markApproved for a tenant with no draft rejects with DraftNotFoundError', async () => {
    await expect(repo.markApproved(tenant.tenantId, [PID], 1)).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  type RawRetryRow = RawDraft & { updated_at: Date };
  const rawRetryRow = async (): Promise<RawRetryRow> =>
    (await pool.query<RawRetryRow>('SELECT status, version, proposal_ids, approved_at, updated_at FROM onboarding_drafts WHERE tenant_id = $1', [tenant.tenantId])).rows[0];

  it('markRetried bumps version and updated_at of an approved draft on the raw row and changes nothing else', async () => {
    const d = await seedDraft();
    const approved = await repo.markApproved(tenant.tenantId, [PID], d.version);
    const before = await rawRetryRow();

    const retried = await repo.markRetried(tenant.tenantId, approved.version);

    const after = await rawRetryRow();
    expect(retried.version).toBe(approved.version + 1);
    expect(after.version).toBe(before.version + 1);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after).toEqual({ ...before, version: before.version + 1, updated_at: after.updated_at });
    expect(retried).toEqual(await repo.getForTenant(tenant.tenantId));
  });

  it('markRetried with a stale version rejects with DraftVersionConflictError and leaves the row untouched', async () => {
    const d = await seedDraft();
    const approved = await repo.markApproved(tenant.tenantId, [PID], d.version);
    const before = await rawRetryRow();
    for (const stale of [approved.version - 1, approved.version + 1]) {
      await expect(repo.markRetried(tenant.tenantId, stale)).rejects.toMatchObject({
        name: 'DraftVersionConflictError',
        expected: stale,
        actual: approved.version,
      });
    }
    expect(await rawRetryRow()).toEqual(before);
  });

  it('markRetried on a draft that was never approved rejects with DraftNotApprovedError and leaves the row untouched', async () => {
    const d = await seedDraft();
    const before = await rawRetryRow();
    await expect(repo.markRetried(tenant.tenantId, d.version)).rejects.toBeInstanceOf(DraftNotApprovedError);
    expect(await rawRetryRow()).toEqual(before);
  });

  it('markRetried for a tenant with no draft rejects with DraftNotFoundError, and never touches another tenant', async () => {
    await expect(repo.markRetried(tenant.tenantId, 1)).rejects.toBeInstanceOf(DraftNotFoundError);
    const other = await createTestTenant(pool);
    const otherDraft = await repo.create(other.tenantId, {
      packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Other Co', ownerFirstName: null, clientTimezone: 'America/New_York', assembled: await freshAssembled(),
    });
    const approvedOther = await repo.markApproved(other.tenantId, [PID], otherDraft.version);
    await expect(repo.markRetried(tenant.tenantId, approvedOther.version)).rejects.toBeInstanceOf(DraftNotFoundError);
    expect(await repo.getForTenant(other.tenantId)).toEqual(approvedOther);
  });

  it('getForTenantForUpdate refuses to run outside the request transaction', async () => {
    await seedDraft();
    await expect(repo.getForTenantForUpdate(tenant.tenantId)).rejects.toThrow(/requires the request transaction/);
  });

  it('getForTenantForUpdate inside a request transaction returns the same mapped row as getForTenant, and null for another tenant', async () => {
    const d = await seedDraft();
    const other = await createTestTenant(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, tenant.tenantId, { transactional: true });
      const locked = await tenantContextStore.run({ client, tenantId: tenant.tenantId }, () => repo.getForTenantForUpdate(tenant.tenantId));
      expect(locked).toEqual(await repo.getForTenant(tenant.tenantId));
      expect(locked!.id).toBe(d.id);
      // Another tenant's id inside this tenant's transaction: the guard refuses (ambient tenant differs).
      await expect(tenantContextStore.run({ client, tenantId: tenant.tenantId }, () => repo.getForTenantForUpdate(other.tenantId))).rejects.toThrow(/requires the request transaction/);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // RLS: the other tenant's own transaction sees no draft to lock.
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      await applyTenantContext(c2, other.tenantId, { transactional: true });
      expect(await tenantContextStore.run({ client: c2, tenantId: other.tenantId }, () => repo.getForTenantForUpdate(other.tenantId))).toBeNull();
      await c2.query('COMMIT');
    } finally {
      c2.release();
    }
  });
});
