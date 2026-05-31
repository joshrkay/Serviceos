import { describe, it, expect } from 'vitest';
import { InMemoryProposalRepository, createProposal, Proposal } from '../../src/proposals/proposal';
import { resolveChainReferences } from '../../src/proposals/execution/chain-resolution';
import { applyChainMetadata } from '../../src/proposals/chain';

const TENANT = 'tenant-1';

function makeChained(
  index: number,
  chainId: string,
  chainLength: number,
  refs: { payloadPath: string; parentChainIndex: number; entityKind: 'customerId' | 'jobId' }[],
  overrides: Partial<Proposal> = {}
): Proposal {
  const p = createProposal({
    tenantId: TENANT,
    proposalType: index === 0 ? 'create_customer' : 'draft_estimate',
    payload: index === 0 ? { name: 'Jane' } : { customerId: 'placeholder', lineItems: [] },
    summary: `segment ${index}`,
    createdBy: 'u1',
  });
  applyChainMetadata(p, {
    chainId,
    chainIndex: index,
    chainLength,
    dependsOnChainIndices: refs.map((r) => r.parentChainIndex),
    chainRefs: refs,
  });
  return { ...p, ...overrides };
}

describe('resolveChainReferences', () => {
  it('noop for a non-chained proposal', async () => {
    const repo = new InMemoryProposalRepository();
    const p = createProposal({
      tenantId: TENANT,
      proposalType: 'create_customer',
      payload: { name: 'Jane' },
      summary: 's',
      createdBy: 'u1',
    });
    const res = await resolveChainReferences(p, { proposalRepo: repo });
    expect(res.status).toBe('noop');
  });

  it('blocks (parent_pending) when the parent has not executed', async () => {
    const repo = new InMemoryProposalRepository();
    const parent = makeChained(0, 'c1', 2, []);
    const child = makeChained(1, 'c1', 2, [
      { payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' },
    ]);
    await repo.create(parent);
    await repo.create(child);

    const res = await resolveChainReferences(child, { proposalRepo: repo });
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') {
      expect(res.reason).toBe('parent_pending');
      expect(res.parentId).toBe(parent.id);
    }
  });

  it('resolves the token to the parent resultEntityId once executed', async () => {
    const repo = new InMemoryProposalRepository();
    const parent = makeChained(0, 'c1', 2, [], {
      status: 'executed',
      resultEntityId: 'cust-123',
    });
    const child = makeChained(1, 'c1', 2, [
      { payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' },
    ]);
    await repo.create(parent);
    await repo.create(child);

    const res = await resolveChainReferences(child, { proposalRepo: repo });
    expect(res.status).toBe('resolved');
    if (res.status === 'resolved') {
      expect(res.payload.customerId).toBe('cust-123');
    }
    // Original proposal payload is not mutated by a resolution.
    expect(child.payload.customerId).toBe('$ref:chain[0].customerId');
  });

  it('blocks (parent_failed) when the parent failed', async () => {
    const repo = new InMemoryProposalRepository();
    const parent = makeChained(0, 'c1', 2, [], { status: 'execution_failed' });
    const child = makeChained(1, 'c1', 2, [
      { payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' },
    ]);
    await repo.create(parent);
    await repo.create(child);

    const res = await resolveChainReferences(child, { proposalRepo: repo });
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') {
      expect(res.reason).toBe('parent_failed');
    }
  });

  it('cascade-fails (not retries) when the parent executed but has no resultEntityId', async () => {
    const repo = new InMemoryProposalRepository();
    // Executed parent that produced no entity to reference — would
    // otherwise loop forever on parent_pending.
    const parent = makeChained(0, 'c1', 2, [], { status: 'executed', resultEntityId: undefined });
    const child = makeChained(1, 'c1', 2, [
      { payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' },
    ]);
    await repo.create(parent);
    await repo.create(child);

    const res = await resolveChainReferences(child, { proposalRepo: repo });
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') {
      expect(res.reason).toBe('parent_failed');
    }
  });
});
