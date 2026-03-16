import {
  isProposalExpired,
  hashSourceContext,
  checkProposalFreshness,
  expireStaleProposals,
  getExpirationTime,
  DEFAULT_EXPIRATION_CONFIG,
} from '../../src/ai/guardrails/expiration';
import type { ExpirationConfig } from '../../src/ai/guardrails/expiration';
import { createProposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { Proposal, ProposalStatus } from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const base = createProposal({
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'Test Customer' },
    summary: 'Create a new customer',
    createdBy: 'user-1',
  });
  return { ...base, ...overrides };
}

describe('P2-015 — Proposal expiration and stale-context handling', () => {
  it('happy path — non-expired proposal passes check', () => {
    const proposal = makeProposal({
      createdAt: new Date(), // just created
    });

    const expired = isProposalExpired(proposal);

    expect(expired).toBe(false);
  });

  it('happy path — expired proposal detected', () => {
    const proposal = makeProposal({
      createdAt: new Date(Date.now() - 86400000 - 1000), // 24h + 1s ago
    });

    const expired = isProposalExpired(proposal);

    expect(expired).toBe(true);
  });

  it('happy path — stale context detected via hash mismatch', () => {
    const originalContext = { customerId: '123', address: '456 Main St' };
    const currentContext = { customerId: '123', address: '789 Oak Ave' };

    const proposal = makeProposal({
      sourceContext: originalContext,
    });

    const result = checkProposalFreshness(proposal, currentContext);

    expect(result.fresh).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('context has changed');
  });

  it('happy path — fresh context passes check', () => {
    const context = { customerId: '123', address: '456 Main St' };

    const proposal = makeProposal({
      sourceContext: context,
    });

    const result = checkProposalFreshness(proposal, context);

    expect(result.fresh).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('happy path — batch expiration finds and expires stale proposals', async () => {
    const repo = new InMemoryProposalRepository();
    const tenantId = 'tenant-1';

    // Create an expired proposal in ready_for_review status
    const expiredProposal = makeProposal({
      tenantId,
      status: 'ready_for_review',
      createdAt: new Date(Date.now() - 86400000 - 1000), // 24h + 1s ago
    });
    await repo.create(expiredProposal);

    // Create a fresh proposal in ready_for_review status
    const freshProposal = makeProposal({
      tenantId,
      status: 'ready_for_review',
      createdAt: new Date(), // just created
    });
    await repo.create(freshProposal);

    const expired = await expireStaleProposals(repo, tenantId);

    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(expiredProposal.id);
    expect(expired[0].status).toBe('expired');

    // Verify fresh proposal was not expired
    const freshFromRepo = await repo.findById(tenantId, freshProposal.id);
    expect(freshFromRepo!.status).toBe('ready_for_review');
  });

  it('validation — expired proposal cannot be executed', () => {
    const proposal = makeProposal({
      status: 'expired',
    });

    // Expired is a terminal status — cannot transition to executed
    expect(() => {
      transitionProposal(proposal, 'executed', 'user-1');
    }).toThrow();
  });

  it('happy path — type-specific TTL respected', () => {
    // draft_estimate has 12h TTL
    const estimateProposal = makeProposal({
      proposalType: 'draft_estimate',
      createdAt: new Date(Date.now() - 43200000 - 1000), // 12h + 1s ago
    });

    expect(isProposalExpired(estimateProposal)).toBe(true);

    // Same age but create_customer has 24h TTL — should not be expired
    const customerProposal = makeProposal({
      proposalType: 'create_customer',
      createdAt: new Date(Date.now() - 43200000 - 1000), // 12h + 1s ago
    });

    expect(isProposalExpired(customerProposal)).toBe(false);

    // create_appointment has 4h TTL
    const appointmentProposal = makeProposal({
      proposalType: 'create_appointment',
      createdAt: new Date(Date.now() - 14400000 - 1000), // 4h + 1s ago
    });

    expect(isProposalExpired(appointmentProposal)).toBe(true);
  });

  it('idempotency — already expired proposal not re-expired', async () => {
    const repo = new InMemoryProposalRepository();
    const tenantId = 'tenant-1';

    // Create a proposal that is already in expired status
    const alreadyExpired = makeProposal({
      tenantId,
      status: 'expired',
      createdAt: new Date(Date.now() - 86400000 - 1000),
    });
    await repo.create(alreadyExpired);

    // expireStaleProposals only looks at ready_for_review proposals
    const expired = await expireStaleProposals(repo, tenantId);

    expect(expired).toHaveLength(0);

    // Verify the already-expired proposal is still expired and unchanged
    const fromRepo = await repo.findById(tenantId, alreadyExpired.id);
    expect(fromRepo!.status).toBe('expired');
  });

  it('invalid transition — only ready_for_review proposals can expire', () => {
    const draftProposal = makeProposal({
      status: 'draft',
    });

    // Cannot transition draft directly to expired
    expect(() => {
      transitionProposal(draftProposal, 'expired', 'system');
    }).toThrow();

    const approvedProposal = makeProposal({
      status: 'approved',
    });

    // Cannot transition approved directly to expired
    expect(() => {
      transitionProposal(approvedProposal, 'expired', 'system');
    }).toThrow();
  });
});
