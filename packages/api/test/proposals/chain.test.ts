import { describe, it, expect } from 'vitest';
import {
  buildChainRefToken,
  parseChainRefToken,
  isChainRefToken,
  chainMetaFor,
  isChained,
  payloadPathFor,
  applyChainMetadata,
  ENTITY_KIND_TO_PAYLOAD_PATH,
  type ChainEntityKind,
} from '../../src/proposals/chain';
import { createProposal, Proposal } from '../../src/proposals/proposal';
import { PROPOSAL_TYPE_SCHEMAS } from '../../src/proposals/contracts';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: 't1',
      proposalType: 'draft_estimate',
      payload: { customerId: 'x', lineItems: [] },
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

  // RV-220 — chain coverage for the comms/money follow-up types. These are
  // the segments the decomposer emits for "…and send her the estimate" /
  // "…then send the invoice" — without map entries the dependency edge was
  // silently dropped and the send executed against a free-text reference.
  it('maps the send/issue/record follow-up types to their id fields', () => {
    expect(payloadPathFor('send_estimate', 'estimateId')).toBe('estimateId');
    expect(payloadPathFor('send_invoice', 'invoiceId')).toBe('invoiceId');
    expect(payloadPathFor('issue_invoice', 'invoiceId')).toBe('invoiceId');
    expect(payloadPathFor('record_payment', 'invoiceId')).toBe('invoiceId');
  });

  it('follow-up types cannot consume unrelated entity kinds', () => {
    expect(payloadPathFor('send_estimate', 'invoiceId')).toBeUndefined();
    expect(payloadPathFor('send_invoice', 'estimateId')).toBeUndefined();
    expect(payloadPathFor('record_payment', 'customerId')).toBeUndefined();
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

  // RV-220 — the dependents-forced-draft invariant holds for every type in
  // ENTITY_KIND_TO_PAYLOAD_PATH, including the newly covered follow-up
  // types: a chained dependent with unresolved refs is ALWAYS forced to
  // 'draft' (never auto-approve ahead of its parent), with the ref token
  // written to the payload path the map declares.
  it('forces draft for every (type, entityKind) pair in the coverage map', () => {
    for (const [proposalType, kinds] of Object.entries(ENTITY_KIND_TO_PAYLOAD_PATH)) {
      for (const [entityKind, payloadPath] of Object.entries(kinds ?? {})) {
        const p = makeProposal({
          proposalType: proposalType as Proposal['proposalType'],
          status: 'approved',
          approvedAt: new Date(),
        });
        applyChainMetadata(p, {
          chainId: 'c',
          chainIndex: 1,
          chainLength: 2,
          dependsOnChainIndices: [0],
          chainRefs: [
            {
              payloadPath: payloadPath as string,
              parentChainIndex: 0,
              entityKind: entityKind as ChainEntityKind,
            },
          ],
        });
        expect(p.payload[payloadPath as string]).toBe(
          `$ref:chain[0].${entityKind}`,
        );
        expect(p.status).toBe('draft');
        expect(p.approvedAt).toBeUndefined();
      }
    }
  });

  it('every mapped payload path exists in that proposal type schema', () => {
    const unwrap = (schema: any): any => {
      let current = schema;
      while (current?._def?.schema || current?._def?.innerType) {
        current = current._def.schema ?? current._def.innerType;
      }
      return current;
    };
    for (const [proposalType, kinds] of Object.entries(ENTITY_KIND_TO_PAYLOAD_PATH)) {
      const objectSchema = unwrap(
        PROPOSAL_TYPE_SCHEMAS[proposalType as Proposal['proposalType']] as any,
      );
      const shape =
        typeof objectSchema?.shape === 'function' ? objectSchema.shape() : objectSchema?.shape;
      for (const payloadPath of Object.values(kinds ?? {})) {
        expect(shape, `${proposalType} schema should expose an object shape`).toBeDefined();
        expect(Object.keys(shape)).toContain(payloadPath);
      }
    }
  });

  it('writes add_note refs to targetId and sets targetKind for the parent entity', () => {
    const p = makeProposal({
      proposalType: 'add_note',
      payload: { body: 'Call back tomorrow', targetKind: 'customer', targetId: 'placeholder' },
      status: 'approved',
      approvedAt: new Date(),
    });
    applyChainMetadata(p, {
      chainId: 'c',
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'targetId', parentChainIndex: 0, entityKind: 'jobId' }],
    });

    expect(p.payload.targetId).toBe('$ref:chain[0].jobId');
    expect(p.payload.targetKind).toBe('job');
    expect(p.status).toBe('draft');
  });
});
