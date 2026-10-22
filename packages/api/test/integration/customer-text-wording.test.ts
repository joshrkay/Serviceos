/**
 * D-045 — the owner's own text wording, pinned against the real
 * customer_text_wording table (migrations 330, 333): one row per text per
 * language, saving again replaces it, reset removes it, and RLS keeps each
 * business's wording its own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import {
  createCustomerTextWording,
  PgCustomerTextWordingRepository,
} from '../../src/notifications/customer-text-wording';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { applyTenantContext } from '../../src/db/rls-runtime-role';

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
    await repo.save(tenantA, 'thank_you_text', 'Thanks!', 'en', userId);
    await repo.save(tenantA, 'estimate_text', 'Quote: {{link}}', 'en', userId);
    const replaced = await repo.save(tenantA, 'thank_you_text', 'Thanks again!', 'en', userId);

    expect(replaced).toMatchObject({ purpose: 'thank_you_text', body: 'Thanks again!', updatedBy: userId });
    expect(replaced.updatedAt).toBeInstanceOf(Date);
    expect((await repo.list(tenantA)).map((w) => [w.purpose, w.body])).toEqual([
      ['estimate_text', 'Quote: {{link}}'],
      ['thank_you_text', 'Thanks again!'],
    ]);
    expect(await repo.find(tenantA, 'invoice_text', 'en')).toBeNull();

    expect(await repo.remove(tenantA, 'thank_you_text', 'en')).toBe(true);
    expect(await repo.remove(tenantA, 'thank_you_text', 'en')).toBe(false);
    expect(await repo.find(tenantA, 'thank_you_text', 'en')).toBeNull();
  });

  it("one business never sees another's wording", async () => {
    await repo.save(tenantA, 'portal_link_text', 'A only {{link}}', 'en', userId);

    expect(await repo.find(tenantB, 'portal_link_text', 'en')).toBeNull();
    expect(await repo.list(tenantB)).toEqual([]);
    expect(await repo.remove(tenantB, 'portal_link_text', 'en')).toBe(false);
    expect(await repo.find(tenantA, 'portal_link_text', 'en')).not.toBeNull();
  });

  it('keeps one wording per language, saved and reset apart', async () => {
    await repo.save(tenantA, 'invoice_text', 'Invoice {{link}}', 'en', userId);
    await repo.save(tenantA, 'invoice_text', 'Factura {{link}}', 'es', userId);
    await repo.save(tenantA, 'invoice_text', 'Su factura {{link}}', 'es', userId);

    expect(await repo.find(tenantA, 'invoice_text', 'en')).toMatchObject({ body: 'Invoice {{link}}', language: 'en' });
    expect(await repo.find(tenantA, 'invoice_text', 'es')).toMatchObject({ body: 'Su factura {{link}}', language: 'es' });
    expect(await repo.remove(tenantA, 'invoice_text', 'es')).toBe(true);
    expect(await repo.find(tenantA, 'invoice_text', 'es')).toBeNull();
    expect(await repo.find(tenantA, 'invoice_text', 'en')).not.toBeNull();
    await expect(repo.save(tenantA, 'invoice_text', 'x {{link}}', 'vi' as never, userId)).rejects.toThrow(/check constraint/);
  });

  it('the table refuses a text it does not know and an over-long body', async () => {
    await expect(repo.save(tenantA, 'marketing' as never, 'x', 'en', userId)).rejects.toThrow(/check constraint/);
    await expect(repo.save(tenantA, 'thank_you_text', 'x'.repeat(481), 'en', userId)).rejects.toThrow(/check constraint/);
  });

  it("a failed read on a send's own transaction falls back to ours and leaves the transaction usable", async () => {
    await repo.save(tenantA, 'invoice_text', 'Mine {{link}}', 'en', userId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, tenantA, { transactional: true });
      // A real Postgres error on the wording read (as a timeout or a not-yet-
      // migrated table would raise), on the request's shared client.
      const query = client.query.bind(client);
      vi.spyOn(client, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) =>
        typeof text === 'string' && text.includes('FROM customer_text_wording')
          ? query('SELECT 1/0')
          : (query as (...a: unknown[]) => unknown)(text, ...rest)) as typeof client.query);
      const warn = vi.fn();
      const wording = createCustomerTextWording({ repo, logger: { warn } });

      const text = await tenantContextStore.run({ client, tenantId: tenantA }, () =>
        wording.textFor({
          tenantId: tenantA,
          purpose: 'invoice_text',
          customerLanguage: 'en',
          values: { link: 'L' },
          builtIn: () => 'OURS',
        }),
      );

      expect(text).toBe('OURS');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read/), expect.anything());
      // The send's next statements still run in the same transaction.
      expect((await query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
      await query('COMMIT');
    } finally {
      vi.restoreAllMocks();
      client.release();
    }
  });
});
