/**
 * D-045 — the owner's own text wording, pinned against the real
 * customer_text_wording table (migration 330): one row per text, saving again
 * replaces it, reset removes it, and RLS keeps each business's wording its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerTextWordingRepository } from '../../src/notifications/customer-text-wording';

describe('Postgres integration — customer text wording (D-045)', () => {
  let pool: Pool;
  let repo: PgCustomerTextWordingRepository;
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCustomerTextWordingRepository(pool);
    ({ tenantId: tenantA, userId } = await createTestTenant(pool));
    ({ tenantId: tenantB } = await createTestTenant(pool));
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('saves, replaces, lists in order, and resets', async () => {
    await repo.save(tenantA, 'thank_you_text', 'Thanks!', userId);
    await repo.save(tenantA, 'estimate_text', 'Quote: {{link}}', userId);
    const replaced = await repo.save(tenantA, 'thank_you_text', 'Thanks again!', userId);

    expect(replaced).toMatchObject({ purpose: 'thank_you_text', body: 'Thanks again!', updatedBy: userId });
    expect(replaced.updatedAt).toBeInstanceOf(Date);
    expect((await repo.list(tenantA)).map((w) => [w.purpose, w.body])).toEqual([
      ['estimate_text', 'Quote: {{link}}'],
      ['thank_you_text', 'Thanks again!'],
    ]);
    expect(await repo.find(tenantA, 'invoice_text')).toBeNull();

    expect(await repo.remove(tenantA, 'thank_you_text')).toBe(true);
    expect(await repo.remove(tenantA, 'thank_you_text')).toBe(false);
    expect(await repo.find(tenantA, 'thank_you_text')).toBeNull();
  });

  it("one business never sees another's wording", async () => {
    await repo.save(tenantA, 'portal_link_text', 'A only {{link}}', userId);

    expect(await repo.find(tenantB, 'portal_link_text')).toBeNull();
    expect(await repo.list(tenantB)).toEqual([]);
    expect(await repo.remove(tenantB, 'portal_link_text')).toBe(false);
    expect(await repo.find(tenantA, 'portal_link_text')).not.toBeNull();
  });

  it('the table refuses a text it does not know and an over-long body', async () => {
    await expect(repo.save(tenantA, 'marketing' as never, 'x', userId)).rejects.toThrow(/check constraint/);
    await expect(repo.save(tenantA, 'thank_you_text', 'x'.repeat(481), userId)).rejects.toThrow(/check constraint/);
  });
});
