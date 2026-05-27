/**
 * Postgres integration — leads (PgLeadRepository).
 *
 * pg-lead.ts was previously exercised only by the in-memory repository's unit
 * tests; the real SQL (generated phone_normalized column, jsonb attribution,
 * BIGINT money coercion, pagination cap, tenant-scoped predicates) had no
 * coverage. This runs the repository against a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { MAX_LIST_LIMIT, type Lead } from '../../src/leads/lead';

function makeLead(tenantId: string, createdBy: string, overrides: Partial<Lead> = {}): Lead {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    source: 'web_form',
    stage: 'new',
    createdBy,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Postgres integration — leads', () => {
  let pool: Pool;
  let repo: PgLeadRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgLeadRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('create / findById', () => {
    it('round-trips a lead with attribution, utm and money fields', async () => {
      const created = await repo.create(
        makeLead(tenant.tenantId, tenant.userId, {
          email: 'ada@example.com',
          estimatedValueCents: 1_250_00,
          utmSource: 'google',
          utmMedium: 'cpc',
          utmCampaign: 'spring',
          attribution: { gclid: 'abc123', landing: '/pricing' },
        }),
      );

      const found = await repo.findById(tenant.tenantId, created.id);
      expect(found).not.toBeNull();
      expect(found!.email).toBe('ada@example.com');
      // BIGINT comes back as a string from node-pg; repo must coerce to number.
      expect(found!.estimatedValueCents).toBe(1_250_00);
      expect(typeof found!.estimatedValueCents).toBe('number');
      expect(found!.utmCampaign).toBe('spring');
      expect(found!.attribution).toEqual({ gclid: 'abc123', landing: '/pricing' });
    });

    it('drops an empty attribution object back to undefined', async () => {
      const created = await repo.create(makeLead(tenant.tenantId, tenant.userId));
      const found = await repo.findById(tenant.tenantId, created.id);
      expect(found!.attribution).toBeUndefined();
    });

    it('does not leak a lead across tenants (tenant-scoped predicate)', async () => {
      const created = await repo.create(makeLead(tenant.tenantId, tenant.userId));
      const leaked = await repo.findById(other.tenantId, created.id);
      expect(leaked).toBeNull();
    });
  });

  describe('findByPhoneNormalized', () => {
    it('matches on the generated phone_normalized column', async () => {
      await repo.create(
        makeLead(tenant.tenantId, tenant.userId, { primaryPhone: '+1 (415) 555-9090' }),
      );
      // Generated column strips non-digits and a leading country-code 1.
      const found = await repo.findByPhoneNormalized(tenant.tenantId, '4155559090');
      expect(found).not.toBeNull();
      expect(found!.primaryPhone).toBe('+1 (415) 555-9090');
    });

    it('returns null for an empty phone without querying', async () => {
      expect(await repo.findByPhoneNormalized(tenant.tenantId, '')).toBeNull();
    });
  });

  describe('findByTenant / listWithMeta', () => {
    let filterTenant: { tenantId: string; userId: string };

    beforeAll(async () => {
      filterTenant = await createTestTenant(pool);
      await repo.create(makeLead(filterTenant.tenantId, filterTenant.userId, { stage: 'new', source: 'referral' }));
      await repo.create(makeLead(filterTenant.tenantId, filterTenant.userId, { stage: 'won', source: 'web_form' }));
      await repo.create(makeLead(filterTenant.tenantId, filterTenant.userId, { stage: 'won', source: 'phone_call' }));
    });

    it('filters by stage and source', async () => {
      const won = await repo.findByTenant(filterTenant.tenantId, { stage: 'won' });
      expect(won).toHaveLength(2);
      const referrals = await repo.findByTenant(filterTenant.tenantId, { source: 'referral' });
      expect(referrals).toHaveLength(1);
    });

    it('caps the page size at MAX_LIST_LIMIT', async () => {
      const page = await repo.findByTenant(filterTenant.tenantId, { limit: MAX_LIST_LIMIT + 500 });
      expect(page.length).toBeLessThanOrEqual(MAX_LIST_LIMIT);
    });

    it('listWithMeta returns total independent of the page window', async () => {
      const result = await repo.listWithMeta(filterTenant.tenantId, { limit: 1 });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(3);
    });
  });

  describe('update', () => {
    it('applies a partial update and rewrites jsonb attribution', async () => {
      const created = await repo.create(makeLead(tenant.tenantId, tenant.userId));
      const updated = await repo.update(tenant.tenantId, created.id, {
        stage: 'qualified',
        attribution: { ref: 'newsletter' },
      });
      expect(updated!.stage).toBe('qualified');
      expect(updated!.attribution).toEqual({ ref: 'newsletter' });
      expect(updated!.firstName).toBe('Ada');
    });

    it('returns the current row unchanged when there are no mapped fields', async () => {
      const created = await repo.create(makeLead(tenant.tenantId, tenant.userId));
      const result = await repo.update(tenant.tenantId, created.id, {} as Partial<Lead>);
      expect(result!.id).toBe(created.id);
    });

    it('returns null when the lead does not exist for the tenant', async () => {
      expect(await repo.update(tenant.tenantId, crypto.randomUUID(), { stage: 'lost' })).toBeNull();
    });

    it('cannot update another tenant lead', async () => {
      const created = await repo.create(makeLead(tenant.tenantId, tenant.userId));
      const result = await repo.update(other.tenantId, created.id, { stage: 'lost' });
      expect(result).toBeNull();
    });
  });
});
