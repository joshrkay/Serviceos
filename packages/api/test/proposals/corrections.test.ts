import { describe, it, expect } from 'vitest';
import {
  computeCorrections,
  InMemoryCorrectionRepository,
  type Correction,
} from '../../src/proposals/corrections/correction';
import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
} from '../../src/proposals/proposal';
import { editProposal } from '../../src/proposals/actions';

describe('Story 3.9 — computeCorrections (pure diff)', () => {
  const base = {
    tenantId: 'tenant-1',
    proposalId: 'prop-1',
    intent: 'create_customer',
    actorId: 'user-1',
    now: () => new Date('2026-06-21T00:00:00Z'),
  };
  let counter = 0;
  const idFactory = () => `id-${++counter}`;

  it('emits one row per changed field with before/after captured', () => {
    const rows = computeCorrections({
      ...base,
      idFactory,
      before: { name: 'John', phone: '111' },
      after: { name: 'Jane', phone: '999' },
      fields: ['name', 'phone'],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.field).sort()).toEqual(['name', 'phone']);
    const name = rows.find((r) => r.field === 'name')!;
    expect(name.beforeValue).toBe('John');
    expect(name.afterValue).toBe('Jane');
    expect(name.intent).toBe('create_customer');
    expect(name.tenantId).toBe('tenant-1');
    expect(name.proposalId).toBe('prop-1');
    expect(name.actorId).toBe('user-1');
  });

  it('skips fields whose value did not actually change (no-op edit)', () => {
    const rows = computeCorrections({
      ...base,
      before: { name: 'John', phone: '111' },
      after: { name: 'John', phone: '999' },
      fields: ['name', 'phone'],
    });
    expect(rows.map((r) => r.field)).toEqual(['phone']);
  });

  it('treats deep-equal objects/arrays as unchanged', () => {
    const rows = computeCorrections({
      ...base,
      before: { lineItems: [{ q: 1 }] },
      after: { lineItems: [{ q: 1 }] },
      fields: ['lineItems'],
    });
    expect(rows).toHaveLength(0);
  });

  it('captures null when a field was absent before or cleared after', () => {
    const rows = computeCorrections({
      ...base,
      before: { email: 'a@b.com' },
      after: { email: undefined, phone: '555' },
      fields: ['email', 'phone'],
    });
    const email = rows.find((r) => r.field === 'email')!;
    expect(email.beforeValue).toBe('a@b.com');
    expect(email.afterValue).toBeNull();
    const phone = rows.find((r) => r.field === 'phone')!;
    expect(phone.beforeValue).toBeNull();
    expect(phone.afterValue).toBe('555');
  });

  it('de-duplicates repeated field names', () => {
    const rows = computeCorrections({
      ...base,
      before: { name: 'John' },
      after: { name: 'Jane' },
      fields: ['name', 'name'],
    });
    expect(rows).toHaveLength(1);
  });
});

describe('Story 3.9 — InMemoryCorrectionRepository', () => {
  function row(over: Partial<Correction>): Correction {
    return {
      id: Math.random().toString(36).slice(2),
      tenantId: 'tenant-1',
      proposalId: 'prop-1',
      intent: 'create_customer',
      field: 'name',
      beforeValue: 'a',
      afterValue: 'b',
      actorId: 'user-1',
      createdAt: new Date(),
      ...over,
    };
  }

  it('recordMany is a no-op for an empty batch', async () => {
    const repo = new InMemoryCorrectionRepository();
    expect(await repo.recordMany([])).toEqual([]);
    expect(await repo.findByTenant('tenant-1')).toHaveLength(0);
  });

  it('is queryable per tenant and per intent', async () => {
    const repo = new InMemoryCorrectionRepository();
    await repo.recordMany([
      row({ intent: 'create_customer', createdAt: new Date('2026-06-21T01:00:00Z') }),
      row({ intent: 'create_invoice', createdAt: new Date('2026-06-21T02:00:00Z') }),
      row({ intent: 'create_invoice', createdAt: new Date('2026-06-21T03:00:00Z') }),
    ]);
    expect(await repo.findByTenant('tenant-1')).toHaveLength(3);
    expect(await repo.findByIntent('tenant-1', 'create_invoice')).toHaveLength(2);
    expect(await repo.findByIntent('tenant-1', 'create_customer')).toHaveLength(1);
    // Newest first.
    const invoices = await repo.findByIntent('tenant-1', 'create_invoice');
    expect(invoices[0].createdAt.getTime()).toBeGreaterThan(invoices[1].createdAt.getTime());
  });

  it('isolates rows across tenants', async () => {
    const repo = new InMemoryCorrectionRepository();
    await repo.recordMany([row({ tenantId: 'tenant-1' }), row({ tenantId: 'tenant-2' })]);
    expect(await repo.findByTenant('tenant-1')).toHaveLength(1);
    expect(await repo.findByIntent('tenant-2', 'create_customer')).toHaveLength(1);
    expect(await repo.findByIntent('tenant-1', 'create_customer')).toHaveLength(1);
  });
});

describe('WS22 — InMemoryCorrectionRepository.countRepeatsInWindow', () => {
  function row(over: Partial<Correction>): Correction {
    return {
      id: Math.random().toString(36).slice(2),
      tenantId: 'tenant-1',
      proposalId: 'prop-1',
      intent: 'create_customer',
      field: 'name',
      beforeValue: 'a',
      afterValue: 'b',
      actorId: 'user-1',
      createdAt: new Date(),
      ...over,
    };
  }

  const from = new Date('2026-06-15T00:00:00Z');
  const to = new Date('2026-06-22T00:00:00Z');

  it('total counts only corrections in [from, to); repeats requires a same (intent, field) row strictly earlier', async () => {
    const repo = new InMemoryCorrectionRepository();
    await repo.recordMany([
      // First-ever occurrence of (create_customer, name) — not a repeat, even though it's in-window.
      row({ intent: 'create_customer', field: 'name', createdAt: new Date('2026-06-16T00:00:00Z') }),
      // Second occurrence of the same pair, later in the window — a repeat.
      row({ intent: 'create_customer', field: 'name', createdAt: new Date('2026-06-17T00:00:00Z') }),
      // A different field — its own partition, first occurrence, not a repeat.
      row({ intent: 'create_customer', field: 'phone', createdAt: new Date('2026-06-18T00:00:00Z') }),
    ]);
    const result = await repo.countRepeatsInWindow!('tenant-1', from, to);
    expect(result).toEqual({ total: 3, repeats: 1 });
  });

  it('a repeat still counts when the EARLIER row of the pair is outside the window', async () => {
    const repo = new InMemoryCorrectionRepository();
    await repo.recordMany([
      // Outside the window (before `from`) — establishes the (intent, field) pair.
      row({ intent: 'create_customer', field: 'name', createdAt: new Date('2026-06-01T00:00:00Z') }),
      // Inside the window — repeats the pair first seen last week, outside the window.
      row({ intent: 'create_customer', field: 'name', createdAt: new Date('2026-06-16T00:00:00Z') }),
    ]);
    const result = await repo.countRepeatsInWindow!('tenant-1', from, to);
    // Only the in-window row is counted in `total`; it IS a repeat.
    expect(result).toEqual({ total: 1, repeats: 1 });
  });

  it('the window is [from, to) — the boundary at `to` is excluded', async () => {
    const repo = new InMemoryCorrectionRepository();
    await repo.recordMany([
      row({ intent: 'create_customer', field: 'name', createdAt: from }), // exactly `from` — included
      row({ intent: 'create_customer', field: 'name', createdAt: to }), // exactly `to` — excluded
    ]);
    const result = await repo.countRepeatsInWindow!('tenant-1', from, to);
    expect(result.total).toBe(1);
  });

  it('returns {total: 0, repeats: 0} for a tenant/window with no corrections', async () => {
    const repo = new InMemoryCorrectionRepository();
    const result = await repo.countRepeatsInWindow!('tenant-1', from, to);
    expect(result).toEqual({ total: 0, repeats: 0 });
  });

  it('isolates the count per tenant', async () => {
    const repo = new InMemoryCorrectionRepository();
    await repo.recordMany([
      row({ tenantId: 'tenant-1', intent: 'create_customer', field: 'name', createdAt: new Date('2026-06-01T00:00:00Z') }),
      row({ tenantId: 'tenant-1', intent: 'create_customer', field: 'name', createdAt: new Date('2026-06-16T00:00:00Z') }),
      // Same (intent, field) shape on a different tenant must not leak into tenant-1's repeat count.
      row({ tenantId: 'tenant-2', intent: 'create_customer', field: 'name', createdAt: new Date('2026-06-16T00:00:00Z') }),
    ]);
    expect(await repo.countRepeatsInWindow!('tenant-1', from, to)).toEqual({ total: 1, repeats: 1 });
    expect(await repo.countRepeatsInWindow!('tenant-2', from, to)).toEqual({ total: 1, repeats: 0 });
  });
});

describe('Story 3.9 — editProposal records corrections', () => {
  const tenantId = 'tenant-1';
  const actorId = 'user-1';
  const baseInput: CreateProposalInput = {
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: actorId,
  };

  it('writes one correction per changed field, keyed by intent (proposal type)', async () => {
    const repo = new InMemoryProposalRepository();
    const correctionRepo = new InMemoryCorrectionRepository();
    const proposal = createProposal(baseInput);
    await repo.create(proposal);

    await editProposal(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      { name: 'Jane Doe', phone: '555-9999' },
      undefined,
      correctionRepo,
    );

    const rows = await correctionRepo.findByProposal(tenantId, proposal.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.intent === 'create_customer')).toBe(true);
    const byIntent = await correctionRepo.findByIntent(tenantId, 'create_customer');
    expect(byIntent).toHaveLength(2);
    const name = rows.find((r) => r.field === 'name')!;
    expect(name.beforeValue).toBe('John Doe');
    expect(name.afterValue).toBe('Jane Doe');
  });

  it('records nothing for a no-op edit', async () => {
    const repo = new InMemoryProposalRepository();
    const correctionRepo = new InMemoryCorrectionRepository();
    const proposal = createProposal(baseInput);
    await repo.create(proposal);

    await editProposal(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      { name: 'John Doe' },
      undefined,
      correctionRepo,
    );

    expect(await correctionRepo.findByTenant(tenantId)).toHaveLength(0);
  });

  it('is failure-soft — a capture error never breaks the edit', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(baseInput);
    await repo.create(proposal);
    const throwingRepo = {
      recordMany: async () => {
        throw new Error('db down');
      },
      findByTenant: async () => [],
      findByIntent: async () => [],
      findByProposal: async () => [],
    };

    const { proposal: updated } = await editProposal(
      repo,
      tenantId,
      proposal.id,
      actorId,
      'owner',
      { name: 'Jane Doe' },
      undefined,
      throwingRepo,
    );
    // Edit still succeeded despite the capture failure.
    expect(updated.payload.name).toBe('Jane Doe');
  });
});
