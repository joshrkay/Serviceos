/**
 * #1480 item 4 — approveProposal's linked-step gate for money / comms chain
 * steps. It refuses a tap that would promise a step whose parent has not even
 * been approved (a lone step-2 tap), but it must NOT refuse a chain-atomic
 * approval where the parent is already approved: the executor orders the two
 * (resolveChainReferences waits for the parent). That second case is the D-019
 * owner one-tap close (autonomous-close-execution.ts): approveChainSet
 * approves the draft_estimate head, then the owner approves the linked
 * send_estimate before the head has executed.
 */
import { describe, it, expect } from 'vitest';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { applyChainMetadata } from '../../src/proposals/chain';
import { buildProposal } from '../factories/proposal.factory';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';

/** Step 1 (`parentType`, in `parentStatus`) and step 2 (`childType`) linked through `kind`. */
async function twoStepChain(opts: {
  parentType: Proposal['proposalType'];
  parentStatus: Proposal['status'];
  childType: Proposal['proposalType'];
  kind: 'estimateId' | 'invoiceId';
}) {
  const repo = new InMemoryProposalRepository();
  const parent = buildProposal({
    tenantId: TENANT,
    proposalType: opts.parentType,
    status: opts.parentStatus,
    payload: { customerId: '44444444-4444-4444-8444-444444444444', lineItems: [] },
    sourceContext: {},
    expiresAt: undefined,
  });
  applyChainMetadata(parent, { chainId: CHAIN, chainIndex: 0, chainLength: 2, dependsOnChainIndices: [], chainRefs: [] });
  parent.status = opts.parentStatus;
  const child = buildProposal({
    tenantId: TENANT,
    proposalType: opts.childType,
    status: 'ready_for_review',
    payload: { channel: 'sms' },
    sourceContext: {},
    expiresAt: undefined,
  });
  applyChainMetadata(child, {
    chainId: CHAIN,
    chainIndex: 1,
    chainLength: 2,
    dependsOnChainIndices: [0],
    chainRefs: [{ payloadPath: opts.kind, parentChainIndex: 0, entityKind: opts.kind }],
  });
  child.status = 'ready_for_review';
  await repo.create(parent);
  await repo.create(child);
  return { repo, parent, child };
}

describe('approveProposal — linked money/comms step', () => {
  it('a lone tap on step 2 while step 1 is still unapproved is refused', async () => {
    const { repo, child } = await twoStepChain({
      parentType: 'draft_estimate',
      parentStatus: 'ready_for_review',
      childType: 'send_estimate',
      kind: 'estimateId',
    });
    await expect(approveProposal(repo, TENANT, child.id, OWNER, 'owner')).rejects.toThrow(/approve step 1 first/i);
  });

  it('with step 1 already approved (one-tap close), step 2 approves — the executor runs them in order', async () => {
    const { repo, child } = await twoStepChain({
      parentType: 'draft_estimate',
      parentStatus: 'approved',
      childType: 'send_estimate',
      kind: 'estimateId',
    });
    const approved = await approveProposal(repo, TENANT, child.id, OWNER, 'owner');
    expect(approved.status).toBe('approved');
  });

  // D-023: a drafted invoice is born a DRAFT, and a draft cannot be sent —
  // approving step 1 does not make the send executable; issuing it does.
  it('a send_invoice linked to an approved-but-not-yet-run draft_invoice stays refused', async () => {
    const { repo, child } = await twoStepChain({
      parentType: 'draft_invoice',
      parentStatus: 'approved',
      childType: 'send_invoice',
      kind: 'invoiceId',
    });
    await expect(approveProposal(repo, TENANT, child.id, OWNER, 'owner')).rejects.toThrow(/issue/i);
  });
});
