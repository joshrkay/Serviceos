/**
 * P2-035 — Batch proposal approval (APPROVE ALL).
 *
 * Unit-level coverage of `approveProposalsBatch` — partial-success
 * semantics, per-proposal RBAC, audit-event fan-out, and cross-tenant
 * isolation. HTTP route shape is covered in
 * test/routes/proposals-approve-batch.route.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  createProposal,
  InMemoryProposalRepository,
  type CreateProposalInput,
} from '../../src/proposals/proposal';
import { approveProposalsBatch } from '../../src/proposals/actions';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const tenantId = 'tenant-batch';
const actorId = 'user-owner';

const baseInput: CreateProposalInput = {
  tenantId,
  proposalType: 'create_customer',
  payload: { name: 'Jane Customer' },
  summary: 'Create customer from voice call',
  createdBy: actorId,
};

async function seedReady(
  repo: InMemoryProposalRepository,
  overrides: Partial<CreateProposalInput> = {},
): Promise<string> {
  const p = createProposal({ ...baseInput, ...overrides });
  await repo.create(p);
  await repo.updateStatus(tenantId, p.id, 'ready_for_review');
  return p.id;
}

describe('P2-035 — approveProposalsBatch', () => {
  it('happy path — 5 proposals, all approved, 5 audit events', async () => {
    const repo = new InMemoryProposalRepository();
    const audit = new InMemoryAuditRepository();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedReady(repo, { summary: `P${i}` }));

    const result = await approveProposalsBatch(repo, tenantId, ids, actorId, 'owner', audit);

    expect(result.approved.sort()).toEqual([...ids].sort());
    expect(result.failed).toEqual([]);
    expect(audit.getAll().filter((e) => e.eventType === 'proposal.approved')).toHaveLength(5);
    for (const id of ids) {
      const fresh = await repo.findById(tenantId, id);
      expect(fresh?.status).toBe('approved');
    }
  });

  it('partial failure — wrong-status ID is reported, the rest succeed', async () => {
    const repo = new InMemoryProposalRepository();
    const audit = new InMemoryAuditRepository();
    const good1 = await seedReady(repo, { summary: 'good1' });
    const good2 = await seedReady(repo, { summary: 'good2' });

    // A draft proposal cannot be approved — left in 'draft' on purpose.
    const draft = createProposal({ ...baseInput, summary: 'draft-only' });
    await repo.create(draft);

    const result = await approveProposalsBatch(
      repo, tenantId, [good1, draft.id, good2], actorId, 'owner', audit,
    );

    expect(result.approved.sort()).toEqual([good1, good2].sort());
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(draft.id);
    expect(result.failed[0].reason).toBeTruthy();
    expect(audit.getAll().filter((e) => e.eventType === 'proposal.approved')).toHaveLength(2);
  });

  it('non-owner role is rejected per-proposal (RBAC) — technician approves 0', async () => {
    const repo = new InMemoryProposalRepository();
    const audit = new InMemoryAuditRepository();
    const ids = [await seedReady(repo), await seedReady(repo, { summary: 'second' })];

    const result = await approveProposalsBatch(
      repo, tenantId, ids, actorId, 'technician', audit,
    );

    expect(result.approved).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.every((f) => /forbidden|permission|not.allowed/i.test(f.reason))).toBe(true);
    expect(audit.getAll().filter((e) => e.eventType === 'proposal.approved')).toHaveLength(0);
  });

  it('cross-tenant ID in the batch returns failed with reason ~ not_found (does NOT throw)', async () => {
    const repo = new InMemoryProposalRepository();
    const audit = new InMemoryAuditRepository();
    const mine = await seedReady(repo);

    // Seed a proposal belonging to a DIFFERENT tenant.
    const other = createProposal({ ...baseInput, tenantId: 'tenant-other' });
    await repo.create(other);
    await repo.updateStatus('tenant-other', other.id, 'ready_for_review');

    const result = await approveProposalsBatch(
      repo, tenantId, [mine, other.id], actorId, 'owner', audit,
    );

    expect(result.approved).toEqual([mine]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(other.id);
    expect(result.failed[0].reason).toMatch(/not.?found/i);
  });

  it('reuses approveProposal — emits one audit event per approved proposal (not collapsed)', async () => {
    const repo = new InMemoryProposalRepository();
    const audit = new InMemoryAuditRepository();
    const ids = [await seedReady(repo), await seedReady(repo, { summary: 'second' })];

    await approveProposalsBatch(repo, tenantId, ids, actorId, 'owner', audit);

    const approvedEvents = audit
      .getAll()
      .filter((e) => e.eventType === 'proposal.approved');
    expect(approvedEvents).toHaveLength(2);
    expect(approvedEvents.map((e) => e.entityId).sort()).toEqual([...ids].sort());
  });
});
