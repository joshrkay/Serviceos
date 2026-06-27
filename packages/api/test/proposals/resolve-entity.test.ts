import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryProposalRepository,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { resolveProposalEntity } from '../../src/proposals/resolve-entity';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/shared/errors';

const TENANT = 't-resolve-entity';
const PROPOSAL = 'p-resolve-entity';
const OWNER = 'owner-1';

/**
 * A voice_clarification raised because the reference "Bob" matched several
 * customers. Mirrors what emitClarification stamps: candidates on the payload
 * AND the structured re-draft context on sourceContext.
 */
function ambiguousEntityProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL,
    tenantId: TENANT,
    proposalType: 'voice_clarification',
    status: 'draft',
    summary: 'Which customer? "Bob" matched 2 records',
    createdBy: 'voice',
    createdAt: new Date(),
    updatedAt: new Date(),
    payload: {
      transcript: 'invoice Bob for the water heater',
      reason: 'ambiguous_entity',
      entityReference: 'Bob',
      entityCandidates: [
        { id: 'cust-a', label: 'Bob Smith', hint: '555-0100', score: 0.82 },
        { id: 'cust-b', label: 'Bob Jones', score: 0.81 },
      ],
    },
    sourceContext: {
      source: 'voice',
      transcript: 'invoice Bob for the water heater',
      entityKind: 'customer',
      entityReference: 'Bob',
      entityCandidates: [
        { id: 'cust-a', kind: 'customer', label: 'Bob Smith', hint: '555-0100', score: 0.82 },
        { id: 'cust-b', kind: 'customer', label: 'Bob Jones', score: 0.81 },
      ],
    },
    ...overrides,
  } as Proposal;
}

describe('U8 — resolveProposalEntity', () => {
  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  const call = (candidateId: string, actorRole: 'owner' | 'technician' = 'owner') =>
    resolveProposalEntity(
      { tenantId: TENANT, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole },
      { proposalRepo: repo, auditRepo },
    );

  it('re-drafts the original action with the chosen entity, moves to ready_for_review (never approves), clears candidates, audits', async () => {
    await repo.create(ambiguousEntityProposal());

    const result = await call('cust-b');

    // D-004: re-draft surfaces for review, never auto-approves/executes.
    expect(result.status).toBe('ready_for_review');
    expect(result.status).not.toBe('approved');

    // The resolved customer id is stamped onto the payload field its kind fills
    // and onto targetEntityId — the original intent is preserved, not discarded.
    expect((result.payload as Record<string, unknown>).customerId).toBe('cust-b');
    expect(result.targetEntityId).toBe('cust-b');
    expect(result.targetEntityType).toBe('customer');

    // The clarification is cleared so the card stops rendering a picker.
    expect((result.payload as Record<string, unknown>).entityCandidates).toBeUndefined();
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.entityCandidates).toBeUndefined();
    expect(ctx.entityReference).toBeUndefined();
    expect((ctx.resolvedEntity as Record<string, unknown>).id).toBe('cust-b');

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    expect(audits.some((a) => a.eventType === 'proposal.entity_resolved')).toBe(true);
  });

  it('rejects a candidateId that is not one of the proposal candidates (grounding invariant)', async () => {
    await repo.create(ambiguousEntityProposal());
    await expect(call('cust-not-a-candidate')).rejects.toBeInstanceOf(ValidationError);
    // Untouched — still draft, still ambiguous.
    const after = await repo.findById(TENANT, PROPOSAL);
    expect(after?.status).toBe('draft');
    expect((after?.payload as Record<string, unknown>).entityCandidates).toBeDefined();
  });

  it('rejects resolving an entity on an already-terminal proposal', async () => {
    await repo.create(ambiguousEntityProposal({ status: 'approved' }));
    await expect(call('cust-a')).rejects.toBeInstanceOf(ValidationError);
  });

  it('400s when the proposal carries no candidate set', async () => {
    await repo.create(
      ambiguousEntityProposal({
        payload: { transcript: 'do something', reason: 'unknown_intent' },
        sourceContext: { source: 'voice' },
      }),
    );
    await expect(call('cust-a')).rejects.toBeInstanceOf(ValidationError);
  });

  it('404s a missing proposal', async () => {
    await expect(call('cust-a')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('forbids a role without proposals:approve', async () => {
    await repo.create(ambiguousEntityProposal());
    await expect(call('cust-a', 'technician')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reads candidates from the payload when sourceContext lacks them (back-compat)', async () => {
    await repo.create(
      ambiguousEntityProposal({
        sourceContext: { source: 'voice', transcript: 'invoice Bob' }, // no candidates/kind here
      }),
    );
    const result = await call('cust-a');
    expect(result.status).toBe('ready_for_review');
    // No entityKind in sourceContext and candidate has no kind → generic field.
    expect((result.payload as Record<string, unknown>).resolvedEntityId).toBe('cust-a');
  });

  it('a proposal already in ready_for_review stays in ready_for_review (never auto-approves)', async () => {
    await repo.create(ambiguousEntityProposal({ status: 'ready_for_review' }));
    const result = await call('cust-a');
    expect(result.status).toBe('ready_for_review');
    expect((result.payload as Record<string, unknown>).customerId).toBe('cust-a');
  });
});
