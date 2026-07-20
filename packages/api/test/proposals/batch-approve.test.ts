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

    // An already-executed proposal cannot be approved (terminal status) —
    // a draft is now directly approvable, so we use a terminal-status row
    // to exercise the partial-failure path.
    const executed = createProposal({ ...baseInput, summary: 'already-executed' });
    await repo.create({ ...executed, status: 'executed' });

    const result = await approveProposalsBatch(
      repo, tenantId, [good1, executed.id, good2], actorId, 'owner', audit,
    );

    expect(result.approved.sort()).toEqual([good1, good2].sort());
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(executed.id);
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

  // U1 lane backstop — the batch lane must never sweep a non-capture proposal,
  // even if a (buggy or malicious) client puts one in the id list. The client
  // filter (isBatchEligible) is the first guard; this is the server truth.
  it('non-capture ids fail per-id with BATCH_NON_CAPTURE; capture ids still approve', async () => {
    const repo = new InMemoryProposalRepository();
    const audit = new InMemoryAuditRepository();
    const capture = await seedReady(repo); // create_customer (capture)
    const money = await seedReady(repo, {
      proposalType: 'record_payment',
      payload: { invoiceId: 'inv-1', amountCents: 12300 },
      summary: 'Record $123 payment',
    });
    const comms = await seedReady(repo, {
      proposalType: 'send_invoice',
      payload: { invoiceId: 'inv-1' },
      summary: 'Send invoice to Jane',
    });
    const irreversible = await seedReady(repo, {
      proposalType: 'cancel_appointment',
      payload: { appointmentId: 'appt-1' },
      summary: 'Cancel Tuesday visit',
    });

    const result = await approveProposalsBatch(
      repo, tenantId, [capture, money, comms, irreversible], actorId, 'owner', audit,
    );

    expect(result.approved).toEqual([capture]);
    expect(result.failed.map((f) => f.id).sort()).toEqual([money, comms, irreversible].sort());
    expect(result.failed.every((f) => f.reason === 'BATCH_NON_CAPTURE')).toBe(true);
    // The blocked proposals are untouched — still approvable individually.
    for (const id of [money, comms, irreversible]) {
      const fresh = await repo.findById(tenantId, id);
      expect(fresh?.status).toBe('ready_for_review');
    }
    // Exactly one audit event: only the capture approval ran.
    expect(audit.getAll().filter((e) => e.eventType === 'proposal.approved')).toHaveLength(1);
  });
});
