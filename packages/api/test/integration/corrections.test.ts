/**
 * Story 3.9 — corrections capture integration (Docker-gated).
 *
 * Pins the REAL schema (a mocked Pool is not proof the columns exist):
 *   - corrections columns (intent / field / before_value / after_value) round-trip.
 *   - the table is queryable per tenant AND per intent (the AC).
 *   - FORCE RLS isolates rows across tenants on every read path.
 *
 * NOTE: Docker Hub pulls are rate-limited locally, so vitest globalSetup may
 * fail to start the testcontainer here — that's expected; this file is authored
 * for CI (test/integration runs in PR CI).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCorrectionRepository } from '../../src/proposals/corrections/pg-correction';
import { computeCorrections } from '../../src/proposals/corrections/correction';

describe('Postgres integration — corrections (migration 209)', () => {
  let pool: Pool;
  let repo: PgCorrectionRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCorrectionRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists per-field corrections with real columns and queries per intent', async () => {
    const proposalId = crypto.randomUUID();
    const rows = computeCorrections({
      tenantId: tenant.tenantId,
      proposalId,
      intent: 'create_invoice',
      actorId: tenant.userId,
      before: { amountCents: 10000, memo: 'old', lineItems: [{ q: 1 }] },
      after: { amountCents: 12500, memo: 'old', lineItems: [{ q: 2 }] },
      fields: ['amountCents', 'memo', 'lineItems'],
    });
    // memo unchanged → not captured.
    expect(rows.map((r) => r.field).sort()).toEqual(['amountCents', 'lineItems']);

    const stored = await repo.recordMany(rows);
    expect(stored).toHaveLength(2);

    // JSONB before/after round-trip losslessly (integer cents + nested array).
    const amount = stored.find((r) => r.field === 'amountCents')!;
    expect(amount.beforeValue).toBe(10000);
    expect(amount.afterValue).toBe(12500);
    expect(amount.intent).toBe('create_invoice');
    const items = stored.find((r) => r.field === 'lineItems')!;
    expect(items.afterValue).toEqual([{ q: 2 }]);

    // Queryable per tenant.
    const byTenant = await repo.findByTenant(tenant.tenantId);
    expect(byTenant.map((r) => r.field).sort()).toEqual(['amountCents', 'lineItems']);

    // Queryable per intent (the AC) — a different intent on the same tenant.
    const other = computeCorrections({
      tenantId: tenant.tenantId,
      proposalId: crypto.randomUUID(),
      intent: 'create_customer',
      actorId: tenant.userId,
      before: { name: 'A' },
      after: { name: 'B' },
      fields: ['name'],
    });
    await repo.recordMany(other);
    expect(await repo.findByIntent(tenant.tenantId, 'create_invoice')).toHaveLength(2);
    expect(await repo.findByIntent(tenant.tenantId, 'create_customer')).toHaveLength(1);

    // Queryable per proposal (drives the inbox "what changed" view).
    expect(await repo.findByProposal(tenant.tenantId, proposalId)).toHaveLength(2);
  });

  it('FORCE RLS isolates corrections across tenants', async () => {
    const proposalId = crypto.randomUUID();
    await repo.recordMany(
      computeCorrections({
        tenantId: tenant.tenantId,
        proposalId,
        intent: 'record_payment',
        actorId: tenant.userId,
        before: { amountCents: 5000 },
        after: { amountCents: 7500 },
        fields: ['amountCents'],
      }),
    );

    const other = await createTestTenant(pool);
    expect(await repo.findByIntent(other.tenantId, 'record_payment')).toHaveLength(0);
    expect(await repo.findByProposal(other.tenantId, proposalId)).toHaveLength(0);
    expect(await repo.findByTenant(other.tenantId)).toHaveLength(0);
  });
});
