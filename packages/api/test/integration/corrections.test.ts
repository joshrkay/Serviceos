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
import { computeCorrections, type Correction } from '../../src/proposals/corrections/correction';

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

  // WS22 — pins the real window-function SQL shape (ROW_NUMBER() over
  // (intent, field) partitions, ordered by created_at). A mocked Pool proves
  // nothing about whether Postgres actually accepts this query.
  it('countRepeatsInWindow: PARTITION BY (intent, field) ranks chronologically; a repeat earlier than the window still counts', async () => {
    const t = await createTestTenant(pool);
    const proposalId = crypto.randomUUID();

    function row(over: Partial<Correction>): Correction {
      return {
        id: crypto.randomUUID(),
        tenantId: t.tenantId,
        proposalId,
        intent: 'create_estimate',
        field: 'laborRate',
        beforeValue: 100,
        afterValue: 120,
        actorId: t.userId,
        createdAt: new Date(),
        ...over,
      };
    }

    const from = new Date('2026-07-01T00:00:00Z');
    const to = new Date('2026-07-08T00:00:00Z');

    await repo.recordMany([
      // Establishes (create_estimate, laborRate) BEFORE the window — the
      // window-scoped repeat still has to see it via the full-table ranking.
      row({ createdAt: new Date('2026-06-20T00:00:00Z') }),
      // In-window repeat of the same pair.
      row({ createdAt: new Date('2026-07-02T00:00:00Z') }),
      // In-window, first-ever occurrence of a DIFFERENT field — not a repeat.
      row({ field: 'scope', beforeValue: 'a', afterValue: 'b', createdAt: new Date('2026-07-03T00:00:00Z') }),
      // Outside the window (after `to`) — must not be counted in total.
      row({ createdAt: new Date('2026-07-09T00:00:00Z') }),
    ]);

    const result = await repo.countRepeatsInWindow!(t.tenantId, from, to);
    expect(result).toEqual({ total: 2, repeats: 1 });
  });

  it('countRepeatsInWindow: FORCE RLS isolates the count across tenants', async () => {
    const t = await createTestTenant(pool);
    const other = await createTestTenant(pool);
    const from = new Date('2026-07-01T00:00:00Z');
    const to = new Date('2026-07-08T00:00:00Z');

    function row(tenantId: string): Correction {
      return {
        id: crypto.randomUUID(),
        tenantId,
        proposalId: crypto.randomUUID(),
        intent: 'create_estimate',
        field: 'laborRate',
        beforeValue: 100,
        afterValue: 120,
        actorId: t.userId,
        createdAt: new Date('2026-07-02T00:00:00Z'),
      };
    }

    await repo.recordMany([row(t.tenantId)]);
    expect(await repo.countRepeatsInWindow!(other.tenantId, from, to)).toEqual({ total: 0, repeats: 0 });
    expect(await repo.countRepeatsInWindow!(t.tenantId, from, to)).toEqual({ total: 1, repeats: 0 });
  });
});
