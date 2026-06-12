/**
 * RV-072 — pendingProposals candidate source.
 *
 * Resolution among reviewable proposals (draft / ready_for_review) by
 * customer name, proposal-type words, and amount mentions; ordinal
 * references resolve against a session-provided ordered list; τ_ent=0.80
 * with the one-clarification (ambiguous) rule; tenant isolation via the
 * tenant-scoped repo methods.
 */
import { describe, it, expect } from 'vitest';
import {
  createProposal,
  InMemoryProposalRepository,
  type CreateProposalInput,
  type Proposal,
} from '../../../src/proposals/proposal';
import {
  PendingProposalResolver,
  resolvePendingProposalReference,
  parseOrdinalReference,
  parseAmountMention,
} from '../../../src/ai/resolution/pending-proposal-resolver';

const TENANT = 't-resolve';

function makeProposal(overrides: Partial<CreateProposalInput> = {}): Proposal {
  return createProposal({
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: { customerName: 'Henderson', lineItems: [], total: 45000 },
    summary: 'Estimate for Henderson — water heater replacement, $450.00',
    createdBy: 'voice',
    ...overrides,
  });
}

async function seed(
  repo: InMemoryProposalRepository,
  proposal: Proposal,
  status: 'draft' | 'ready_for_review' | 'approved' = 'ready_for_review',
): Promise<Proposal> {
  await repo.create(proposal);
  if (status !== 'draft') {
    await repo.updateStatus(proposal.tenantId, proposal.id, 'ready_for_review');
    if (status === 'approved') {
      await repo.updateStatus(proposal.tenantId, proposal.id, 'approved');
    }
  }
  return (await repo.findById(proposal.tenantId, proposal.id))!;
}

describe('RV-072 — unique resolution', () => {
  it('resolves "the Henderson estimate" to the only matching pending proposal', async () => {
    const repo = new InMemoryProposalRepository();
    const henderson = await seed(repo, makeProposal());
    await seed(
      repo,
      makeProposal({
        proposalType: 'draft_invoice',
        payload: { customerName: 'Acme Corp', lineItems: [], total: 120000 },
        summary: 'Invoice for Acme Corp — $1,200.00',
      }),
    );

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the Henderson estimate',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe(henderson.id);
      expect(result.candidate.kind).toBe('pending_proposal');
    }
  });

  it('a name+type reference does NOT resolve to a proposal matching only the name', async () => {
    const repo = new InMemoryProposalRepository();
    // Henderson INVOICE only — the owner asked for the Henderson ESTIMATE.
    await seed(
      repo,
      makeProposal({
        proposalType: 'draft_invoice',
        summary: 'Invoice for Henderson — $450.00',
      }),
    );

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the Henderson estimate',
    });

    // 1 of 2 signals matched → 0.5 < τ_ent → not_found, never a guess.
    expect(result.kind).toBe('not_found');
  });

  it('amount mentions match the payload money fields (integer cents)', async () => {
    const repo = new InMemoryProposalRepository();
    const fourFifty = await seed(repo, makeProposal());
    await seed(
      repo,
      makeProposal({
        payload: { customerName: 'Henderson', lineItems: [], total: 99000 },
        summary: 'Estimate for Henderson — $990.00',
      }),
    );

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the 450 dollar Henderson estimate',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.candidate.id).toBe(fourFifty.id);
  });

  it('excludes already-handled proposals (approved is not reviewable)', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, makeProposal(), 'approved');

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the Henderson estimate',
    });

    expect(result.kind).toBe('not_found');
  });

  it('includes drafts (directly reviewable from the inbox)', async () => {
    const repo = new InMemoryProposalRepository();
    const draft = await seed(repo, makeProposal(), 'draft');

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the Henderson estimate',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.candidate.id).toBe(draft.id);
  });
});

describe('RV-072 — ambiguity (one-clarification rule)', () => {
  it('two matching pending proposals → ambiguous with both candidates', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, makeProposal({ summary: 'Estimate for Henderson — kitchen' }));
    await seed(repo, makeProposal({ summary: 'Estimate for Henderson — bathroom' }));

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the Henderson estimate',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      for (const c of result.candidates) {
        expect(c.kind).toBe('pending_proposal');
        expect(c.score).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it('type-only reference with several pending of that type → ambiguous', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, makeProposal({ summary: 'Estimate for Henderson' }));
    await seed(
      repo,
      makeProposal({
        payload: { customerName: 'Lopez', lineItems: [], total: 20000 },
        summary: 'Estimate for Lopez',
      }),
    );

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the estimate',
    });

    expect(result.kind).toBe('ambiguous');
  });
});

describe('RV-072 — ordinal references', () => {
  it('parses ordinal words and numbered forms', () => {
    expect(parseOrdinalReference('the first one')).toBe(0);
    expect(parseOrdinalReference('approve the second one')).toBe(1);
    expect(parseOrdinalReference('number 3')).toBe(2);
    expect(parseOrdinalReference('the 2nd')).toBe(1);
    expect(parseOrdinalReference('the last one')).toBe('last');
    expect(parseOrdinalReference('the Henderson estimate')).toBeNull();
    // A money amount is not an ordinal.
    expect(parseOrdinalReference('the $450 invoice')).toBeNull();
  });

  // ITEM 3 — table-driven tests ensuring capture and validation agree.
  it.each<[string, number | 'last' | null]>([
    ['the 1st', 0],
    ['the 2nd', 1],
    ['the 3rd', 2],
    ['the 4th', 3],
    ['the 5th', 4],
    ['number 1', 0],
    ['number 3', 2],
    ['the first one', 0],
    ['the second one', 1],
    ['the third', 2],
    ['the last one', 'last'],
    // Ambiguity: bare "2" disagrees with anchored "3rd" → null (never guess).
    ['approve 2 of the 3rd', null],
    // Consistent: bare "3" agrees with "3rd" → index 2.
    ['approve 3 of the 3rd', 2],
    // "the 2nd of the 3" — anchored ordinal "2nd" + bare "3" disagree → null.
    ['the 2nd of the 3', null],
    // Bare integers without ordinal suffix or "number" prefix are NOT ordinals.
    ['approve 2 proposals', null],
    // Not ordinals at all.
    ['the Henderson estimate', null],
    ['the $450 invoice', null],
    ['', null],
  ])('parseOrdinalReference(%j) → %j', (input, expected) => {
    expect(parseOrdinalReference(input)).toBe(expected);
  });

  it('resolves "the second one" against the session-provided ordered list', async () => {
    const repo = new InMemoryProposalRepository();
    const a = await seed(repo, makeProposal({ summary: 'Estimate for Henderson' }));
    const b = await seed(repo, makeProposal({ summary: 'Estimate for Lopez', payload: { customerName: 'Lopez', lineItems: [], total: 100 } }));
    const c = await seed(repo, makeProposal({ summary: 'Estimate for Patel', payload: { customerName: 'Patel', lineItems: [], total: 200 } }));

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the second one',
      orderedIds: [a.id, b.id, c.id],
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.candidate.id).toBe(b.id);
  });

  it('resolves "the last one" to the final entry of the ordered list', async () => {
    const repo = new InMemoryProposalRepository();
    const a = await seed(repo, makeProposal({ summary: 'Estimate for Henderson' }));
    const b = await seed(repo, makeProposal({ summary: 'Estimate for Lopez', payload: { customerName: 'Lopez', lineItems: [], total: 100 } }));

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the last one',
      orderedIds: [a.id, b.id],
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') expect(result.candidate.id).toBe(b.id);
  });

  it('an ordinal with NO session list is not_found — never a positional guess', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, makeProposal());

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the second one',
    });

    expect(result.kind).toBe('not_found');
  });

  it('an ordinal pointing at a meanwhile-handled proposal is not_found', async () => {
    const repo = new InMemoryProposalRepository();
    const a = await seed(repo, makeProposal());
    const handled = await seed(repo, makeProposal({ summary: 'Estimate for Lopez' }), 'approved');

    const resolver = new PendingProposalResolver(repo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the second one',
      orderedIds: [a.id, handled.id],
    });

    expect(result.kind).toBe('not_found');
  });
});

describe('RV-072 — tenant isolation', () => {
  it('only queries the caller tenant and never sees the other tenant’s proposals', async () => {
    const repo = new InMemoryProposalRepository();
    // Other tenant has the only "Henderson estimate".
    await seed(
      repo,
      makeProposal({ tenantId: 'other-tenant' }),
    );

    const queriedTenants: string[] = [];
    const spyingRepo = {
      findByStatus: async (tenantId: string, status: Parameters<typeof repo.findByStatus>[1]) => {
        queriedTenants.push(tenantId);
        return repo.findByStatus(tenantId, status);
      },
    };

    const resolver = new PendingProposalResolver(spyingRepo);
    const { result } = await resolver.resolve({
      tenantId: TENANT,
      reference: 'the Henderson estimate',
    });

    expect(result.kind).toBe('not_found');
    expect(queriedTenants.length).toBeGreaterThan(0);
    expect(new Set(queriedTenants)).toEqual(new Set([TENANT]));
  });
});

describe('RV-072 — helpers', () => {
  it('parseAmountMention requires a money marker', () => {
    expect(parseAmountMention('the $450 invoice')).toBe(45000);
    expect(parseAmountMention('the 450 dollar estimate')).toBe(45000);
    expect(parseAmountMention('the 1,250.50 dollars invoice')).toBe(125050);
    // Bare numbers (times, ordinals) are not money.
    expect(parseAmountMention('the 2pm appointment')).toBeNull();
    expect(parseAmountMention('the Henderson estimate')).toBeNull();
  });

  it('empty reference is skipped', () => {
    expect(resolvePendingProposalReference([], '  ').kind).toBe('skipped');
  });
});
