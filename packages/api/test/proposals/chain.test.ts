import { describe, it, expect } from 'vitest';
import {
  buildChainRefToken,
  parseChainRefToken,
  isChainRefToken,
  chainMetaFor,
  isChained,
  payloadPathFor,
  applyChainMetadata,
  payloadForValidation,
} from '../../src/proposals/chain';
import { createProposal, Proposal } from '../../src/proposals/proposal';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: 't1',
      proposalType: 'draft_estimate',
      payload: { customerId: '', lineItems: [] },
      summary: 'test',
      createdBy: 'u1',
    }),
    ...overrides,
  };
}

describe('chain ref tokens', () => {
  it('round-trips a token', () => {
    const token = buildChainRefToken(0, 'customerId');
    expect(token).toBe('$ref:chain[0].customerId');
    expect(parseChainRefToken(token)).toEqual({
      parentChainIndex: 0,
      entityKind: 'customerId',
    });
    expect(isChainRefToken(token)).toBe(true);
  });

  it('returns null for non-tokens', () => {
    expect(parseChainRefToken('a-real-uuid')).toBeNull();
    expect(parseChainRefToken(undefined)).toBeNull();
    expect(parseChainRefToken(42)).toBeNull();
    expect(parseChainRefToken('$ref:chain[0].notAKind')).toBeNull();
    expect(parseChainRefToken('$ref:chain[].customerId')).toBeNull();
    expect(isChainRefToken('plain')).toBe(false);
  });
});

describe('payloadPathFor', () => {
  it('maps known (type, kind) pairs', () => {
    expect(payloadPathFor('create_job', 'customerId')).toBe('customerId');
    expect(payloadPathFor('create_appointment', 'jobId')).toBe('jobId');
    expect(payloadPathFor('draft_estimate', 'customerId')).toBe('customerId');
  });

  it('returns undefined for unconsumable pairs', () => {
    // an appointment cannot consume a customerId directly (needs a job)
    expect(payloadPathFor('create_appointment', 'customerId')).toBeUndefined();
    expect(payloadPathFor('create_customer', 'customerId')).toBeUndefined();
  });
});

describe('chainMetaFor / isChained', () => {
  it('returns undefined for a non-chained proposal', () => {
    const p = makeProposal();
    expect(chainMetaFor(p)).toBeUndefined();
    expect(isChained(p)).toBe(false);
  });

  it('reads chain metadata from sourceContext', () => {
    const p = makeProposal({
      chainId: 'chain-1',
      sourceContext: {
        chainId: 'chain-1',
        chainIndex: 1,
        chainLength: 3,
        dependsOnChainIndices: [0],
        chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
      },
    });
    const meta = chainMetaFor(p);
    expect(meta).toBeDefined();
    expect(meta!.chainId).toBe('chain-1');
    expect(meta!.chainIndex).toBe(1);
    expect(meta!.chainLength).toBe(3);
    expect(meta!.chainRefs).toHaveLength(1);
    expect(isChained(p)).toBe(true);
  });
});

describe('payloadForValidation', () => {
  it('swaps unresolved chain-ref tokens for a placeholder uuid', () => {
    const out = payloadForValidation({ customerId: '$ref:chain[0].customerId', title: 'Job' });
    expect(out.customerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.title).toBe('Job');
  });

  it('returns the same object reference when there are no tokens (no allocation)', () => {
    const payload = { customerId: 'real-uuid', title: 'Job' };
    expect(payloadForValidation(payload)).toBe(payload);
  });
});

describe('applyChainMetadata', () => {
  it('stamps metadata on a parent (no refs) without forcing draft', () => {
    const p = makeProposal({ status: 'approved' });
    applyChainMetadata(p, {
      chainId: 'c',
      chainIndex: 0,
      chainLength: 2,
      dependsOnChainIndices: [],
      chainRefs: [],
    });
    expect(p.chainId).toBe('c');
    expect((p.sourceContext as Record<string, unknown>).chainIndex).toBe(0);
    // Parent keeps its status — no unresolved refs.
    expect(p.status).toBe('approved');
  });

  it('writes ref tokens and forces a dependent to draft without marking missing fields', () => {
    const p = makeProposal({ status: 'approved', approvedAt: new Date() });
    applyChainMetadata(p, {
      chainId: 'c',
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
    });
    expect(p.payload.customerId).toBe('$ref:chain[0].customerId');
    const ctx = p.sourceContext as Record<string, unknown>;
    // Chain refs resolve at execution time, so they are NOT operator-
    // facing missing fields — leaving them out keeps the dependent
    // approvable from the inbox.
    expect(ctx.missingFields).toBeUndefined();
    // Dependent with unresolved refs can never race ahead of its parent.
    expect(p.status).toBe('draft');
    expect(p.approvedAt).toBeUndefined();
  });

  it('does NOT clobber a concrete value the handler already extracted', () => {
    const p = makeProposal({ status: 'approved', payload: { jobId: 'real-job-4821', lineItems: [] } });
    applyChainMetadata(p, {
      chainId: 'c',
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'jobId', parentChainIndex: 0, entityKind: 'jobId' }],
    });
    // Concrete value wins; the ref is not wired and not recorded.
    expect(p.payload.jobId).toBe('real-job-4821');
    expect((p.sourceContext as Record<string, unknown>).chainRefs).toEqual([]);
    // It still declared a dependency, so it is forced to draft.
    expect(p.status).toBe('draft');
  });

  it('forces a dependent to draft even when no ref could be wired (unmapped type)', () => {
    // dependsOn is non-empty but chainRefs is empty (e.g. the dependent's
    // type/entityKind isn't in ENTITY_KIND_TO_PAYLOAD_PATH). It must still
    // not auto-approve ahead of its parent.
    const p = makeProposal({ status: 'approved', approvedAt: new Date() });
    applyChainMetadata(p, {
      chainId: 'c',
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [],
    });
    expect(p.status).toBe('draft');
    expect(p.approvedAt).toBeUndefined();
  });
});
