import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { resolveProposalEntity } from '../../src/proposals/resolve-entity';
import type { RedraftHandlerFactory } from '../../src/proposals/redraft-handler-factory';
import type { TaskHandler, TaskContext } from '../../src/ai/tasks/task-handlers';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
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

// ── U1 (E9) re-draft: resolving makes the proposal EXECUTABLE ───────────────
//
// Producer persists sourceContext.originalIntent; the consumer re-runs the
// original task handler with the chosen id and REPLACES the voice_clarification
// with the drafted, executable typed proposal. Handler-level with a mocked
// handler (no real LLM) per the CLAUDE.md voice/AI rule.
describe('U8/U1 — resolveProposalEntity re-draft', () => {
  // The draft_invoice / draft_estimate Zod contracts require UUID customerId/
  // jobId, so candidates use real UUIDs here (the grounded re-draft validates
  // the transitioned payload).
  const CUST_A = '11111111-1111-1111-1111-111111111111';
  const CUST_B = '22222222-2222-2222-2222-222222222222';
  const JOB_A = '33333333-3333-3333-3333-333333333333';
  const JOB_B = '44444444-4444-4444-4444-444444444444';
  const JOB_REF = '55555555-5555-5555-5555-555555555555';

  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  /** A clarification that DID persist the original intent (the U1 producer). */
  function ambiguousWithIntent(
    overrides: Partial<Proposal> = {},
    intentOverrides: Record<string, unknown> = {},
  ): Proposal {
    return {
      id: PROPOSAL,
      tenantId: TENANT,
      proposalType: 'voice_clarification',
      status: 'draft',
      summary: 'Which customer? "Bob" matched 2 records',
      createdBy: OWNER,
      createdAt: new Date(),
      updatedAt: new Date(),
      payload: {
        transcript: 'invoice Bob for the water heater',
        reason: 'ambiguous_entity',
        entityReference: 'Bob',
        entityCandidates: [
          { id: CUST_A, label: 'Bob Smith', score: 0.82 },
          { id: CUST_B, label: 'Bob Jones', score: 0.81 },
        ],
      },
      sourceContext: {
        source: 'voice',
        transcript: 'invoice Bob for the water heater',
        conversationId: 'conv-1',
        entityKind: 'customer',
        entityReference: 'Bob',
        entityCandidates: [
          { id: CUST_A, kind: 'customer', label: 'Bob Smith', score: 0.82 },
          { id: CUST_B, kind: 'customer', label: 'Bob Jones', score: 0.81 },
        ],
        originalIntent: {
          intentType: 'create_invoice',
          extractedEntities: { customerName: 'Bob', jobReference: 'water heater' },
        },
        ...intentOverrides,
      },
      ...overrides,
    } as Proposal;
  }

  /**
   * A mock re-draft handler that captures the TaskContext and returns a typed
   * proposal of `taskType`. Mirrors what a real handler produces (createProposal
   * lands it in 'draft').
   */
  function mockHandler(
    taskType: Proposal['proposalType'],
    buildPayload: (ctx: TaskContext) => Record<string, unknown>,
  ): { handler: TaskHandler; calls: TaskContext[] } {
    const calls: TaskContext[] = [];
    const handler: TaskHandler = {
      taskType,
      handle: vi.fn(async (ctx: TaskContext) => {
        calls.push(ctx);
        const proposal = createProposal({
          tenantId: ctx.tenantId,
          proposalType: taskType,
          payload: buildPayload(ctx),
          summary: `Drafted ${taskType}`,
          createdBy: ctx.userId,
          ...(ctx.conversationId ? { sourceContext: { conversationId: ctx.conversationId } } : {}),
        });
        return { proposal, taskType };
      }),
    };
    return { handler, calls };
  }

  const factoryOf = (handler: TaskHandler): RedraftHandlerFactory => () => handler;

  const call = (
    candidateId: string,
    factory: RedraftHandlerFactory,
    actorRole: 'owner' | 'technician' = 'owner',
  ) =>
    resolveProposalEntity(
      { tenantId: TENANT, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole },
      { proposalRepo: repo, auditRepo, redraftHandlerFactory: factory },
    );

  it('re-drafts an ambiguous draft_invoice to a real draft_invoice carrying the resolved customerId, capped at ready_for_review', async () => {
    await repo.create(ambiguousWithIntent());
    const { handler, calls } = mockHandler('draft_invoice', (ctx) => ({
      customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
      jobId: JOB_REF,
      lineItems: [{ description: 'Water heater', quantity: 1, unitPrice: 45000 }],
    }));

    const result = await call(CUST_B, factoryOf(handler));

    // Type transitioned away from the non-executable clarification.
    expect(result.proposalType).toBe('draft_invoice');
    expect(result.proposalType).not.toBe('voice_clarification');

    // Resolved id rode into the handler's existingEntities under customerId and
    // landed on the drafted payload + targetEntityId.
    expect((calls[0].existingEntities as Record<string, unknown>).customerId).toBe(CUST_B);
    // The resolved free-text reference is dropped so it can't compete.
    expect((calls[0].existingEntities as Record<string, unknown>).customerName).toBeUndefined();
    expect((result.payload as Record<string, unknown>).customerId).toBe(CUST_B);
    expect(result.targetEntityId).toBe(CUST_B);
    expect(result.targetEntityType).toBe('customer');

    // D-004: surfaced for review, NEVER approved/executed.
    expect(result.status).toBe('ready_for_review');
    expect(result.status).not.toBe('approved');
    expect(result.executedAt).toBeUndefined();

    // Re-drafted against the stored transcript, not the clarification summary.
    expect(calls[0].message).toBe('invoice Bob for the water heater');

    // Ambiguity markers cleared; audit records the type transition.
    expect((result.payload as Record<string, unknown>).entityCandidates).toBeUndefined();
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.entityCandidates).toBeUndefined();
    expect(ctx.originalIntent).toBeUndefined();
    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    const ev = audits.find((a) => a.eventType === 'proposal.entity_resolved');
    expect(ev).toBeDefined();
    expect(ev!.metadata).toMatchObject({
      fromProposalType: 'voice_clarification',
      toProposalType: 'draft_invoice',
    });
  });

  it('per-kind: a create_customer original intent re-drafts to create_customer (resolved id in the right field)', async () => {
    await repo.create(ambiguousWithIntent({}, {
      originalIntent: { intentType: 'create_customer', extractedEntities: { name: 'Bob' } },
    }));
    const { handler, calls } = mockHandler('create_customer', (ctx) => ({
      // create_customer requires `name`; the resolved id rides existingEntities.
      name: 'Bob',
      ...(((ctx.existingEntities as Record<string, unknown>).customerId)
        ? { resolvedCustomerId: (ctx.existingEntities as Record<string, unknown>).customerId }
        : {}),
    }));

    const result = await call(CUST_A, factoryOf(handler));

    expect(result.proposalType).toBe('create_customer');
    // The resolved id was injected into existingEntities under customerId
    // (its kind's field) for the handler to consume.
    expect((calls[0].existingEntities as Record<string, unknown>).customerId).toBe(CUST_A);
    expect(result.targetEntityId).toBe(CUST_A);
    expect(result.status).toBe('ready_for_review');
  });

  it('per-kind: a create_job original intent (job ambiguity) re-drafts to create_job with the resolved jobId', async () => {
    await repo.create(
      ambiguousWithIntent(
        {
          payload: {
            transcript: 'invoice for the Rodriguez job',
            reason: 'ambiguous_entity',
            entityReference: 'Rodriguez job',
            entityCandidates: [
              { id: JOB_A, label: 'Rodriguez — kitchen', score: 0.8 },
              { id: JOB_B, label: 'Rodriguez — bath', score: 0.79 },
            ],
          },
        },
        {
          entityKind: 'job',
          entityReference: 'Rodriguez job',
          entityCandidates: [
            { id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 },
            { id: JOB_B, kind: 'job', label: 'Rodriguez — bath', score: 0.79 },
          ],
          originalIntent: {
            intentType: 'create_job',
            extractedEntities: { jobReference: 'Rodriguez job', customerName: 'Rodriguez' },
          },
        },
      ),
    );
    const { handler, calls } = mockHandler('create_job', (ctx) => ({
      // create_job requires customerId + title; the resolved jobId rides
      // existingEntities under jobId (its kind's field).
      customerId: CUST_A,
      title: 'Rodriguez',
      resolvedJobId: (ctx.existingEntities as Record<string, unknown>).jobId,
    }));

    const result = await call(JOB_B, factoryOf(handler));

    expect(result.proposalType).toBe('create_job');
    expect((calls[0].existingEntities as Record<string, unknown>).jobId).toBe(JOB_B);
    // The ambiguous job reference is dropped from existingEntities.
    expect((calls[0].existingEntities as Record<string, unknown>).jobReference).toBeUndefined();
    expect(result.targetEntityType).toBe('job');
    expect(result.status).toBe('ready_for_review');
  });

  it('never auto-executes even if the drafted handler returns an approved proposal (D-004)', async () => {
    await repo.create(ambiguousWithIntent());
    // A rogue handler that tries to auto-approve — resolution must cap it.
    const handler: TaskHandler = {
      taskType: 'draft_invoice',
      handle: async (ctx) => {
        const proposal = createProposal({
          tenantId: ctx.tenantId,
          proposalType: 'draft_invoice',
          payload: {
            customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
            jobId: '22222222-2222-2222-2222-222222222222',
            lineItems: [{ description: 'x', quantity: 1, unitPrice: 100 }],
          },
          summary: 'rogue',
          createdBy: ctx.userId,
        });
        return { proposal: { ...proposal, status: 'approved' }, taskType: 'draft_invoice' };
      },
    };

    const result = await call(CUST_A, factoryOf(handler));
    expect(result.status).toBe('ready_for_review');
    expect(result.status).not.toBe('approved');
  });

  it('grounding gate still rejects an off-list candidate — no re-draft, handler never called', async () => {
    await repo.create(ambiguousWithIntent());
    const { handler } = mockHandler('draft_invoice', () => ({}));

    await expect(call('cust-not-a-candidate', factoryOf(handler))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(handler.handle).not.toHaveBeenCalled();
    const after = await repo.findById(TENANT, PROPOSAL);
    expect(after?.proposalType).toBe('voice_clarification');
  });

  it('rejects an invalid re-drafted payload for the new type (Zod gate)', async () => {
    await repo.create(ambiguousWithIntent());
    // draft_invoice requires lineItems / customerId — omit them.
    const { handler } = mockHandler('draft_invoice', () => ({ bogus: true }));

    await expect(call(CUST_A, factoryOf(handler))).rejects.toBeInstanceOf(ValidationError);
    // The clarification is untouched — the type didn't transition.
    const after = await repo.findById(TENANT, PROPOSAL);
    expect(after?.proposalType).toBe('voice_clarification');
  });

  it('preserves chainId when the clarification was a chain member', async () => {
    await repo.create(ambiguousWithIntent({ chainId: 'chain-xyz' }));
    const { handler } = mockHandler('draft_invoice', (ctx) => ({
      customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
      jobId: '22222222-2222-2222-2222-222222222222',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    }));

    const result = await call(CUST_A, factoryOf(handler));
    expect(result.chainId).toBe('chain-xyz');
  });

  it('REGRESSION: the re-drafted proposal type has a real execution handler (no HANDLER_NOT_FOUND)', async () => {
    await repo.create(ambiguousWithIntent());
    const { handler } = mockHandler('draft_invoice', (ctx) => ({
      customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
      jobId: '22222222-2222-2222-2222-222222222222',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    }));

    const result = await call(CUST_A, factoryOf(handler));

    // The whole point of U1: the transitioned type is executable, whereas
    // 'voice_clarification' is NOT registered (would throw HANDLER_NOT_FOUND).
    const registry = createExecutionHandlerRegistry();
    expect(registry.has(result.proposalType)).toBe(true);
    expect(registry.has('voice_clarification')).toBe(false);
  });

  it('falls back to annotate-only when no factory is wired (back-compat, even with originalIntent persisted)', async () => {
    await repo.create(ambiguousWithIntent());
    const result = await resolveProposalEntity(
      { tenantId: TENANT, proposalId: PROPOSAL, candidateId: CUST_A, actorId: OWNER, actorRole: 'owner' },
      { proposalRepo: repo, auditRepo }, // no redraftHandlerFactory
    );
    expect(result.proposalType).toBe('voice_clarification');
    expect((result.payload as Record<string, unknown>).customerId).toBe(CUST_A);
    expect(result.status).toBe('ready_for_review');
  });
});
