import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryProposalRepository,
  createProposal,
  missingFieldsFor,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { resolveProposalEntity } from '../../src/proposals/resolve-entity';
import {
  createRedraftHandlerFactory,
  type RedraftHandlerFactory,
} from '../../src/proposals/redraft-handler-factory';
import type { TaskHandler, TaskContext } from '../../src/ai/tasks/task-handlers';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../src/shared/errors';
import { InMemoryTransactionRunner, type TenantTransactionRunner } from '../../src/db/tenant-transaction';
import type { EntityAliasCandidateCapture } from '../../src/learning/entity-aliases/candidate-service';
import { editProposal } from '../../src/proposals/actions';

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
      { proposalRepo: repo, auditRepo, transactionRunner: new InMemoryTransactionRunner() },
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

  // A3-2 — the first read refuses a row that already left review with the
  // SAME 409 and plain message as the row lock inside the transaction (the
  // A-R3 race), not a 400 that names the status. Both mean the same thing to
  // the owner: someone already decided this card.
  it.each(['approved', 'rejected', 'executed', 'expired'] as const)(
    'refuses a pick on a row that is already %s with the same 409 the row lock gives',
    async (status) => {
      await repo.create(ambiguousEntityProposal({ status }));
      const err = await call('cust-a').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).statusCode).toBe(409);
      expect((err as ConflictError).message).toBe('This was already handled, so that choice was not saved.');
      expect((err as ConflictError).details).toEqual({ status });
      // Untouched.
      const after = await repo.findById(TENANT, PROPOSAL);
      expect(after?.status).toBe(status);
      expect((after?.payload as Record<string, unknown>).entityCandidates).toBeDefined();
    },
  );

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

  it('captures a grounded picker alias only after a successful manual selection', async () => {
    await repo.create(ambiguousEntityProposal());
    const captures: unknown[] = [];

    const result = await resolveProposalEntity(
      {
        tenantId: TENANT,
        proposalId: PROPOSAL,
        candidateId: 'cust-b',
        actorId: OWNER,
        actorRole: 'owner',
      },
      {
        proposalRepo: repo,
        auditRepo,
        transactionRunner: new InMemoryTransactionRunner(),
        entityAliasCandidateCapture: {
          capture: async (input) => {
            captures.push(input);
            return [];
          },
        },
      },
    );

    expect(result.status).toBe('ready_for_review');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      source: 'entity_picker',
      tenantId: TENANT,
      actorId: OWNER,
      selectedEntityId: 'cust-b',
      groundingProposal: { id: PROPOSAL },
    });
  });

  it('swallows candidate capture failure without changing the resolved source result', async () => {
    await repo.create(ambiguousEntityProposal());

    const result = await resolveProposalEntity(
      {
        tenantId: TENANT,
        proposalId: PROPOSAL,
        candidateId: 'cust-a',
        actorId: OWNER,
        actorRole: 'owner',
      },
      {
        proposalRepo: repo,
        auditRepo,
        transactionRunner: new InMemoryTransactionRunner(),
        entityAliasCandidateCapture: {
          capture: async () => {
            throw new Error('candidate capture unavailable');
          },
        },
      },
    );

    expect(result.status).toBe('ready_for_review');
    expect(result.payload.customerId).toBe('cust-a');
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
      { proposalRepo: repo, auditRepo, transactionRunner: new InMemoryTransactionRunner(), redraftHandlerFactory: factory },
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

  // B3 — the row's payload is now the RE-DRAFT run's output, so the row must
  // name that run (proposals.ai_run_id) and carry its confidence factors and
  // explanation, not the clarification's.
  it('the re-draft links the row to the run that authored the re-drafted payload', async () => {
    await repo.create(ambiguousWithIntent({ aiRunId: 'run-clarification' }));
    const update = vi.spyOn(repo, 'update');
    const factors = { catalogMatch: 0.9 } as unknown as Proposal['confidenceFactors'];
    const handler: TaskHandler = {
      taskType: 'draft_invoice',
      handle: async (ctx) => ({
        taskType: 'draft_invoice',
        proposal: createProposal({
          tenantId: ctx.tenantId,
          proposalType: 'draft_invoice',
          payload: {
            customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
            lineItems: [{ description: 'Water heater', quantity: 1, unitPrice: 45000 }],
          },
          summary: 'Invoice Bob Jones for the water heater',
          explanation: 'Billed the water heater install',
          confidenceScore: 0.88,
          confidenceFactors: factors,
          aiRunId: 'run-redraft',
          createdBy: ctx.userId,
        }),
      }),
    };

    const result = await call(CUST_B, factoryOf(handler));

    expect(result.aiRunId).toBe('run-redraft');
    expect(result.confidenceFactors).toEqual(factors);
    expect(result.explanation).toBe('Billed the water heater install');
    expect(update.mock.calls.at(-1)?.[2]).toMatchObject({
      aiRunId: 'run-redraft',
      confidenceFactors: factors,
      explanation: 'Billed the water heater install',
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

  it('does NOT throw on an incomplete-but-typed re-draft — a customer-only draft_invoice has no gaps (B6: jobId is optional)', async () => {
    await repo.create(ambiguousWithIntent());
    // B6 — draft_invoice requires only customerId + ≥1 lineItem; jobId is
    // optional on the schema (CreateInvoiceExecutionHandler auto-opens a job
    // at execution when absent, mirroring draft_estimate). The resolved
    // customer rides existingEntities; the handler drafts it with no job
    // (the customer-name ambiguity carried no job reference). The canonical
    // path persists this — it must NOT 400 and must NOT gate on jobId.
    const { handler } = mockHandler('draft_invoice', (ctx) => ({
      customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
      lineItems: [{ description: 'Water heater', quantity: 1, unitPrice: 45000 }],
    }));

    const result = await call(CUST_A, factoryOf(handler));

    // The type transitioned (not a throw) and surfaced for review.
    expect(result.proposalType).toBe('draft_invoice');
    expect(result.status).toBe('ready_for_review');
    // jobId is no longer required — nothing gates approval on it.
    expect(missingFieldsFor(result)).not.toContain('jobId');
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
      { proposalRepo: repo, auditRepo, transactionRunner: new InMemoryTransactionRunner() }, // no redraftHandlerFactory
    );
    expect(result.proposalType).toBe('voice_clarification');
    expect((result.payload as Record<string, unknown>).customerId).toBe(CUST_A);
    expect(result.status).toBe('ready_for_review');
  });
});

// ── P8/U-multi — multi-ambiguity clarification loop ─────────────────────────
//
// "invoice Bob for the Rodriguez job" can be ambiguous on BOTH the customer
// name AND the job reference. The producer (voice-action-router's
// emitClarification) surfaces the first ambiguity and queues the rest on
// `sourceContext.pendingEntityAmbiguities`, promising the operator "1 more
// reference will need picking after this." These tests pin that promise:
// resolving the first pick must surface the SECOND picker (not silently
// drop it or guess), and only once every queued ambiguity is resolved does
// the real redraft happen — with every resolved entity applied, not just
// the last one.
describe('U8/U1 — resolveProposalEntity multi-ambiguity chain (P8/U-multi)', () => {
  const CUST_A = '11111111-1111-1111-1111-111111111111';
  const CUST_B = '22222222-2222-2222-2222-222222222222';
  const JOB_A = '33333333-3333-3333-3333-333333333333';
  const JOB_B = '44444444-4444-4444-4444-444444444444';

  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  /**
   * A clarification surfacing the FIRST of two ambiguous references
   * ("Bob" — customer), with the second ("Rodriguez job" — job) queued on
   * `pendingEntityAmbiguities` exactly as emitClarification persists it.
   */
  function twoAmbiguityProposal(overrides: Partial<Proposal> = {}): Proposal {
    return {
      id: PROPOSAL,
      tenantId: TENANT,
      proposalType: 'voice_clarification',
      status: 'draft',
      summary: 'Which customer? "Bob" matched 2 records',
      explanation:
        'Heard the request, but "Bob" matches more than one customer. Tap the right one below. (1 more reference will need picking after this.)',
      createdBy: OWNER,
      createdAt: new Date(),
      updatedAt: new Date(),
      payload: {
        transcript: 'invoice Bob for the Rodriguez job',
        reason: 'ambiguous_entity',
        entityReference: 'Bob',
        entityCandidates: [
          { id: CUST_A, label: 'Bob Smith', score: 0.82 },
          { id: CUST_B, label: 'Bob Jones', score: 0.81 },
        ],
      },
      sourceContext: {
        source: 'voice',
        transcript: 'invoice Bob for the Rodriguez job',
        conversationId: 'conv-multi-1',
        entityKind: 'customer',
        entityReference: 'Bob',
        entityCandidates: [
          { id: CUST_A, kind: 'customer', label: 'Bob Smith', score: 0.82 },
          { id: CUST_B, kind: 'customer', label: 'Bob Jones', score: 0.81 },
        ],
        originalIntent: {
          intentType: 'create_invoice',
          extractedEntities: { customerName: 'Bob', jobReference: 'Rodriguez job' },
        },
        pendingEntityAmbiguities: [
          {
            entityKind: 'job',
            reference: 'Rodriguez job',
            candidates: [
              { id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 },
              { id: JOB_B, kind: 'job', label: 'Rodriguez — bath', score: 0.79 },
            ],
          },
        ],
      },
      ...overrides,
    } as Proposal;
  }

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

  const call = (candidateId: string, factory: RedraftHandlerFactory) =>
    resolveProposalEntity(
      { tenantId: TENANT, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole: 'owner' },
      { proposalRepo: repo, auditRepo, transactionRunner: new InMemoryTransactionRunner(), redraftHandlerFactory: factory },
    );

  it('first pick surfaces a NEW voice_clarification for the second ambiguity — no redraft yet', async () => {
    await repo.create(twoAmbiguityProposal());
    const { handler } = mockHandler('draft_invoice', () => ({}));

    const result = await call(CUST_B, factoryOf(handler));

    // Still a clarification — the promised second picker, not the real action.
    expect(result.proposalType).toBe('voice_clarification');
    expect(handler.handle).not.toHaveBeenCalled();

    // The picker now shows the JOB candidates, not the customer ones.
    const payload = result.payload as Record<string, unknown>;
    expect(payload.entityReference).toBe('Rodriguez job');
    expect(payload.entityCandidates).toEqual([
      { id: JOB_A, label: 'Rodriguez — kitchen', score: 0.8 },
      { id: JOB_B, label: 'Rodriguez — bath', score: 0.79 },
    ]);

    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.entityKind).toBe('job');
    expect(ctx.entityReference).toBe('Rodriguez job');
    // The queue is drained — nothing left pending behind this one.
    expect(ctx.pendingEntityAmbiguities).toBeUndefined();
    // The customer pick is preserved for the eventual redraft.
    expect(ctx.resolvedEntities).toEqual([
      { id: CUST_B, field: 'customerId', kind: 'customer', label: 'Bob Jones', offeredIds: [CUST_A, CUST_B] },
    ]);
    // originalIntent must survive — the final redraft still needs it.
    expect(ctx.originalIntent).toBeDefined();

    // Not resolved yet — still awaiting a pick, so no ready_for_review promotion.
    expect(result.status).toBe('draft');

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    const ev = audits.find((a) => a.eventType === 'proposal.entity_resolved');
    expect(ev).toBeDefined();
    expect(ev!.metadata).toMatchObject({
      candidateId: CUST_B,
      entityKind: 'customer',
      movedToReview: false,
      nextEntityKind: 'job',
      remainingAmbiguities: 0,
    });
  });

  it('second pick (after the first) redrafts with BOTH entities resolved; audit covers both steps', async () => {
    await repo.create(twoAmbiguityProposal());
    const { handler, calls } = mockHandler('draft_invoice', (ctx) => ({
      customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
      jobId: (ctx.existingEntities as Record<string, unknown>).jobId,
      lineItems: [{ description: 'Water heater', quantity: 1, unitPrice: 45000 }],
    }));

    await call(CUST_B, factoryOf(handler)); // first pick — advances to the job picker
    const result = await call(JOB_B, factoryOf(handler)); // second pick — resolves the chain

    // NOW the real redraft happened.
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect((calls[0].existingEntities as Record<string, unknown>).customerId).toBe(CUST_B);
    expect((calls[0].existingEntities as Record<string, unknown>).jobId).toBe(JOB_B);
    // Both competing free-text references were dropped.
    expect((calls[0].existingEntities as Record<string, unknown>).customerName).toBeUndefined();
    expect((calls[0].existingEntities as Record<string, unknown>).jobReference).toBeUndefined();

    expect(result.proposalType).toBe('draft_invoice');
    expect((result.payload as Record<string, unknown>).customerId).toBe(CUST_B);
    expect((result.payload as Record<string, unknown>).jobId).toBe(JOB_B);
    expect(result.status).toBe('ready_for_review');
    expect(result.status).not.toBe('approved');

    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.entityCandidates).toBeUndefined();
    expect(ctx.pendingEntityAmbiguities).toBeUndefined();
    expect(ctx.resolvedEntities).toEqual([
      { id: CUST_B, field: 'customerId', kind: 'customer', label: 'Bob Jones', offeredIds: [CUST_A, CUST_B] },
      { id: JOB_B, field: 'jobId', kind: 'job', label: 'Rodriguez — bath', offeredIds: [JOB_A, JOB_B] },
    ]);

    // Audit trail covers BOTH steps: the intermediate advance and the final redraft.
    const audits = (await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL)).filter(
      (a) => a.eventType === 'proposal.entity_resolved',
    );
    expect(audits).toHaveLength(2);
    expect(audits[0].metadata).toMatchObject({ candidateId: CUST_B, movedToReview: false });
    expect(audits[1].metadata).toMatchObject({
      candidateId: JOB_B,
      movedToReview: true,
      toProposalType: 'draft_invoice',
      resolvedCount: 2,
    });
  });

  it('single-ambiguity flow is unchanged: one pick redrafts immediately, no extra clarification', async () => {
    // Same fixture, minus the queued job ambiguity.
    const single = twoAmbiguityProposal();
    const singleSourceContext = { ...(single.sourceContext as Record<string, unknown>) };
    delete singleSourceContext.pendingEntityAmbiguities;
    await repo.create({ ...single, sourceContext: singleSourceContext });

    const { handler, calls } = mockHandler('draft_invoice', (ctx) => ({
      customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
      jobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    }));

    const result = await call(CUST_B, factoryOf(handler));

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(result.proposalType).toBe('draft_invoice');
    expect(result.status).toBe('ready_for_review');
    expect((calls[0].existingEntities as Record<string, unknown>).customerId).toBe(CUST_B);

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    expect(audits.filter((a) => a.eventType === 'proposal.entity_resolved')).toHaveLength(1);
  });

  it('double-tap on the first pick does not create two different second-pickers', async () => {
    await repo.create(twoAmbiguityProposal());
    const { handler } = mockHandler('draft_invoice', () => ({}));

    const first = await call(CUST_B, factoryOf(handler));
    const second = await call(CUST_B, factoryOf(handler)); // retried/double-tapped

    // Same row, same second-picker state both times — never redrafted, never
    // a second distinct "which job?" clarification spawned.
    expect(second.id).toBe(first.id);
    expect(second.proposalType).toBe('voice_clarification');
    expect((second.payload as Record<string, unknown>).entityReference).toBe('Rodriguez job');
    expect(second.payload).toEqual(first.payload);
    expect(second.sourceContext).toEqual(first.sourceContext);
    expect(handler.handle).not.toHaveBeenCalled();

    // The retry was a no-op — only ONE entity_resolved audit event, not two.
    const audits = (await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL)).filter(
      (a) => a.eventType === 'proposal.entity_resolved',
    );
    expect(audits).toHaveLength(1);

    // The job picker still resolves normally afterward.
    const { handler: finalHandler } = mockHandler('draft_invoice', (ctx) => ({
      customerId: (ctx.existingEntities as Record<string, unknown>).customerId,
      jobId: (ctx.existingEntities as Record<string, unknown>).jobId,
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    }));
    const final = await call(JOB_A, factoryOf(finalHandler));
    expect(final.proposalType).toBe('draft_invoice');
    expect((final.payload as Record<string, unknown>).jobId).toBe(JOB_A);
  });
});

// ── U8/U1 re-draft with the REAL factory (the proof) ────────────────────────
//
// The mock-handler tests above hand-roll a handler that always returns a
// schema-valid payload — which MASKS the real failure: the production
// InvoiceTaskHandler/CreateJobVoiceTaskHandler emit incomplete-but-typed
// drafts (draft_invoice with no jobId; create_job with no customerId). The
// prior code called assertValidProposalPayload and 400'd exactly those common
// cases. These tests wire createRedraftHandlerFactory with a mocked LLM gateway
// (no fabricated handler) so the regression cannot hide.
// See docs/solutions/test-failures/mocked-client-shape-masks-server-schema-rejection.md
describe('U8/U1 — resolveProposalEntity re-draft via REAL handler factory', () => {
  // QA-2026-07-28 — these MUST be real v4-shaped uuids, not the
  // 'NNNNNNNN-NNNN-NNNN-NNNN-…' pattern used in the mock-handler blocks above.
  // The variant nibble there is not [89abAB], so `z.string().uuid()` REJECTS
  // them, so `draftInvoicePayloadSchema.customerId` never accepted them
  // either — which nothing noticed while InvoiceTaskHandler skipped
  // `assertValidProposalPayload`. Adding that gate (and authoring customerId
  // from the resolved pick rather than the model) surfaced it here: the
  // "complete case" below asserts a payload with NO gaps, which is only
  // meaningful if the operator's chosen id is one the contract can hold.
  const CUST_A = '11111111-1111-4111-8111-111111111111';
  const CUST_B = '22222222-2222-4222-8222-222222222222';
  const JOB_A = '33333333-3333-4333-8333-333333333333';
  const JOB_B = '44444444-4444-4444-8444-444444444444';
  const REAL_JOB = '66666666-6666-4666-8666-666666666666';

  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  /** A mocked LLM gateway returning fixed JSON for draft_invoice/draft_estimate. */
  function gatewayReturning(content: string): LLMGateway {
    return {
      complete: vi.fn().mockResolvedValue({
        content,
        model: 'test-model',
        provider: 'test-provider',
        tokenUsage: { input: 10, output: 20, total: 30 },
        latencyMs: 1,
      } as LLMResponse),
    } as unknown as LLMGateway;
  }

  function clarification(
    payload: Record<string, unknown>,
    sourceContext: Record<string, unknown>,
  ): Proposal {
    return {
      id: PROPOSAL,
      tenantId: TENANT,
      proposalType: 'voice_clarification',
      status: 'draft',
      summary: 'Which one?',
      createdBy: OWNER,
      createdAt: new Date(),
      updatedAt: new Date(),
      payload,
      sourceContext,
    } as Proposal;
  }

  const callReal = (candidateId: string, factory: RedraftHandlerFactory) =>
    resolveProposalEntity(
      { tenantId: TENANT, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole: 'owner' },
      { proposalRepo: repo, auditRepo, transactionRunner: new InMemoryTransactionRunner(), redraftHandlerFactory: factory },
    );

  it('customer-name ambiguity → real draft_invoice (no jobId): no 400, ready_for_review, no jobId gate (B6)', async () => {
    // The grounded LLM drafts a customer + line item but no job (the ambiguity
    // was a customer name, not a job) — the common case the old code 400'd.
    const gateway = gatewayReturning(
      JSON.stringify({
        customerId: CUST_B,
        lineItems: [{ description: 'Water heater service', quantity: 1, unitPrice: 45000, category: 'labor' }],
      }),
    );
    const factory = createRedraftHandlerFactory({ gateway });

    await repo.create(
      clarification(
        {
          transcript: 'invoice Bob for the water heater',
          reason: 'ambiguous_entity',
          entityReference: 'Bob',
          entityCandidates: [
            { id: CUST_A, label: 'Bob Smith', score: 0.82 },
            { id: CUST_B, label: 'Bob Jones', score: 0.81 },
          ],
        },
        {
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
        },
      ),
    );

    // The whole bug: this used to throw → HTTP 400. It must not.
    const result = await callReal(CUST_B, factory);

    expect(result.proposalType).toBe('draft_invoice');
    expect(result.status).toBe('ready_for_review');
    expect(result.status).not.toBe('approved');
    // B6 — jobId is optional on the schema (job auto-opens at execution),
    // so an absent job reference no longer gates approval.
    expect(missingFieldsFor(result)).not.toContain('jobId');
    expect(result.targetEntityId).toBe(CUST_B);
    expect(result.targetEntityType).toBe('customer');
  });

  it('create_job resolved → real create_job typed proposal; missingFields has the unstamped customerId; no throw', async () => {
    // CreateJobVoiceTaskHandler never stamps customerId — it always lists it as
    // missing. No LLM call is made for this handler.
    const factory = createRedraftHandlerFactory({ gateway: gatewayReturning('{}') });

    await repo.create(
      clarification(
        {
          transcript: 'open a job for the Rodriguez kitchen',
          reason: 'ambiguous_entity',
          entityReference: 'Rodriguez',
          entityCandidates: [
            { id: JOB_A, label: 'Rodriguez — kitchen', score: 0.8 },
            { id: JOB_B, label: 'Rodriguez — bath', score: 0.79 },
          ],
        },
        {
          source: 'voice',
          transcript: 'open a job for the Rodriguez kitchen',
          entityKind: 'job',
          entityReference: 'Rodriguez',
          entityCandidates: [
            { id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 },
            { id: JOB_B, kind: 'job', label: 'Rodriguez — bath', score: 0.79 },
          ],
          originalIntent: {
            intentType: 'create_job',
            extractedEntities: { jobReference: 'Rodriguez', jobTitle: 'Kitchen remodel' },
          },
        },
      ),
    );

    const result = await callReal(JOB_B, factory);

    expect(result.proposalType).toBe('create_job');
    expect(result.status).toBe('ready_for_review');
    // create_job requires a resolved customerId; the handler never stamps one.
    expect(missingFieldsFor(result)).toContain('customerId');
  });

  it('complete case → typed proposal with NO missingFields, ready_for_review, approvable & routes to a real execution handler', async () => {
    // The grounded LLM drafts BOTH the resolved customer and a real job id → a
    // fully-valid draft_invoice with no gaps.
    const gateway = gatewayReturning(
      JSON.stringify({
        customerId: CUST_A,
        jobId: REAL_JOB,
        lineItems: [{ description: 'Drain clearing', quantity: 1, unitPrice: 18000, category: 'labor' }],
      }),
    );
    const factory = createRedraftHandlerFactory({ gateway });

    await repo.create(
      clarification(
        {
          transcript: 'invoice Bob 180 for drain clearing',
          reason: 'ambiguous_entity',
          entityReference: 'Bob',
          entityCandidates: [
            { id: CUST_A, label: 'Bob Smith', score: 0.9 },
            { id: CUST_B, label: 'Bob Jones', score: 0.6 },
          ],
        },
        {
          source: 'voice',
          transcript: 'invoice Bob 180 for drain clearing',
          entityKind: 'customer',
          entityReference: 'Bob',
          entityCandidates: [
            { id: CUST_A, kind: 'customer', label: 'Bob Smith', score: 0.9 },
            { id: CUST_B, kind: 'customer', label: 'Bob Jones', score: 0.6 },
          ],
          originalIntent: {
            intentType: 'create_invoice',
            extractedEntities: { customerName: 'Bob', jobReference: 'drain clearing' },
          },
        },
      ),
    );

    const result = await callReal(CUST_A, factory);

    expect(result.proposalType).toBe('draft_invoice');
    expect(result.status).toBe('ready_for_review');
    expect(missingFieldsFor(result)).toHaveLength(0);

    // The resolved type has a real execution handler (no HANDLER_NOT_FOUND).
    const registry = createExecutionHandlerRegistry();
    expect(registry.has(result.proposalType)).toBe(true);
  });
});

// ── B2 — reference→candidates lights up the picker on TYPED money proposals ─
//
// SendInvoiceTaskHandler/InvoiceEditTaskHandler/EstimateEditTaskHandler gate a
// free-text reference via a flat `sourceContext.missingFields` entry and,
// when candidatesForReference found matches, ALSO stamp
// `sourceContext.entityCandidates`/`entityKind`/`entityReference` — never
// `originalIntent` (they are typed proposals from the start, not
// clarifications awaiting a re-draft). Picking a candidate here must hit the
// annotate-only path (no redraftHandlerFactory needed, no originalIntent to
// find), clear ONLY the satisfied gate entry (B1's clear-on-fill), and
// promote draft→ready_for_review ONLY once nothing is left gated.
describe('B2 — resolveProposalEntity on a typed money proposal (gate + candidates, no redraft)', () => {
  const INV_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const INV_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  /** A gated send_invoice exactly as SendInvoiceTaskHandler drafts it once
   *  candidatesForReference found matches for "Henderson". */
  function gatedSendInvoice(overrides: {
    payload?: Record<string, unknown>;
    sourceContext?: Record<string, unknown>;
    status?: Proposal['status'];
  } = {}): Proposal {
    return {
      id: PROPOSAL,
      tenantId: TENANT,
      proposalType: 'send_invoice',
      status: overrides.status ?? 'draft',
      summary: 'send the Henderson invoice',
      createdBy: OWNER,
      createdAt: new Date(),
      updatedAt: new Date(),
      payload: {
        channel: 'email',
        invoiceReference: 'Henderson',
        ...overrides.payload,
      },
      sourceContext: {
        source: 'voice',
        missingFields: ['invoiceId'],
        entityCandidates: [
          { id: INV_A, kind: 'invoice', label: 'INV-0042', hint: 'open', score: 1 },
          { id: INV_B, kind: 'invoice', label: 'INV-0043', hint: 'draft', score: 1 },
        ],
        entityKind: 'invoice',
        entityReference: 'Henderson',
        ...overrides.sourceContext,
      },
    } as Proposal;
  }

  const call = (candidateId: string) =>
    resolveProposalEntity(
      { tenantId: TENANT, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole: 'owner' },
      { proposalRepo: repo, auditRepo, transactionRunner: new InMemoryTransactionRunner() }, // no redraftHandlerFactory — money proposals never carry originalIntent
    );

  it('picking a candidate stamps payload.invoiceId, clears the invoiceId gate, promotes to ready_for_review, and audits', async () => {
    await repo.create(gatedSendInvoice());

    const result = await call(INV_A);

    // Stamped onto the field its kind fills — never redrafted (still the
    // same typed proposal, not re-run through a task handler).
    expect(result.proposalType).toBe('send_invoice');
    expect((result.payload as Record<string, unknown>).invoiceId).toBe(INV_A);
    expect(result.targetEntityId).toBe(INV_A);
    expect(result.targetEntityType).toBe('invoice');

    // The gate is satisfied and cleared — nothing left blocking approval.
    const ctx = result.sourceContext as Record<string, unknown>;
    expect(ctx.missingFields).toBeUndefined();
    expect(ctx.entityCandidates).toBeUndefined();

    // Promoted for review — never auto-approved (D-004).
    expect(result.status).toBe('ready_for_review');
    expect(result.status).not.toBe('approved');

    const audits = await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL);
    const ev = audits.find((a) => a.eventType === 'proposal.entity_resolved');
    expect(ev).toBeDefined();
    expect(ev!.metadata).toMatchObject({ candidateId: INV_A, entityKind: 'invoice', movedToReview: true });
  });

  it('idempotent double-tap: resolving the same candidate twice is a successful no-op the second time', async () => {
    await repo.create(gatedSendInvoice());

    const first = await call(INV_A);
    const second = await call(INV_A);

    expect(second).toEqual(first);
    expect(second.status).toBe('ready_for_review');
    expect((second.payload as Record<string, unknown>).invoiceId).toBe(INV_A);

    // Only ONE entity_resolved audit — the retry short-circuited on the
    // already-resolved check rather than re-mutating the row.
    const audits = (await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL)).filter(
      (a) => a.eventType === 'proposal.entity_resolved',
    );
    expect(audits).toHaveLength(1);
  });

  it('a proposal with OTHER remaining gates stays in draft after one pick', async () => {
    await repo.create(
      gatedSendInvoice({
        sourceContext: { missingFields: ['invoiceId', 'recipient'] },
      }),
    );

    const result = await call(INV_A);

    expect((result.payload as Record<string, unknown>).invoiceId).toBe(INV_A);
    const ctx = result.sourceContext as Record<string, unknown>;
    // Only the satisfied entry is cleared — the unrelated gate survives.
    expect(ctx.missingFields).toEqual(['recipient']);
    expect(result.status).toBe('draft');
  });

  it('back-compat: a proposal already in ready_for_review with a gate cleared stays in ready_for_review', async () => {
    await repo.create(gatedSendInvoice({ status: 'ready_for_review' }));

    const result = await call(INV_A);

    expect(result.status).toBe('ready_for_review');
    expect((result.payload as Record<string, unknown>).invoiceId).toBe(INV_A);
  });
});

// ── A1 — writes commit together, in a transaction opened AFTER the LLM call ─
//
// POST /api/proposals/:id/resolve-entity runs outside the request transaction
// (an LLM_LONG_CALL_ROUTE: the re-draft awaits the drafting handler's LLM
// call). Each path's writes therefore go through ONE run of the injected
// TenantTransactionRunner — and the handler (the LLM call) runs before it,
// never inside it. The alias capture is failure-soft, so it runs after the
// commit: inside the transaction a failed statement would poison the
// resolution's writes, and before it an alias review would exist for a pick
// whose writes rolled back.
describe('A1 — resolveProposalEntity commits each path in one short transaction', () => {
  const CUST_A = '11111111-1111-4111-8111-111111111111';
  const CUST_B = '22222222-2222-4222-8222-222222222222';
  const JOB_A = '33333333-3333-4333-8333-333333333333';
  const JOB_B = '44444444-4444-4444-8444-444444444444';
  const TENANT_UUID = '55555555-5555-4555-8555-555555555555';

  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let events: string[];
  let active: boolean;
  let runner: TenantTransactionRunner;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    events = [];
    active = false;
    runner = {
      async run(tenantId, fn) {
        events.push(`BEGIN ${tenantId}`);
        active = true;
        try {
          const result = await fn({ lock: async () => undefined, savepoint: (work) => work() });
          events.push('COMMIT');
          return result;
        } catch (err) {
          events.push('ROLLBACK');
          throw err;
        } finally {
          active = false;
        }
      },
    };
    // Every write records whether it ran inside the runner's transaction.
    for (const [name, target] of [
      ['findByIdsForUpdate', repo],
      ['update', repo],
      ['updateStatus', repo],
      ['create', auditRepo],
    ] as const) {
      const original = (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name].bind(target);
      vi.spyOn(target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, name).mockImplementation(
        async (...args: unknown[]) => {
          events.push(`${name}${active ? ' (in tx)' : ' (NO TX)'}`);
          return original(...args);
        },
      );
    }
  });

  function clarification(sourceContext: Record<string, unknown> = {}): Proposal {
    return {
      id: PROPOSAL,
      tenantId: TENANT_UUID,
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
        entityKind: 'customer',
        entityReference: 'Bob',
        entityCandidates: [
          { id: CUST_A, kind: 'customer', label: 'Bob Smith', score: 0.82 },
          { id: CUST_B, kind: 'customer', label: 'Bob Jones', score: 0.81 },
        ],
        ...sourceContext,
      },
    } as Proposal;
  }

  const ORIGINAL_INTENT = {
    originalIntent: { intentType: 'create_invoice', extractedEntities: { customerName: 'Bob' } },
  };

  /** A re-draft handler standing in for the LLM call: records whether a transaction was open. */
  function draftingHandler(): TaskHandler {
    return {
      taskType: 'draft_invoice',
      handle: vi.fn(async (ctx: TaskContext) => {
        events.push(`LLM${active ? ' (in tx)' : ' (no tx)'}`);
        return {
          taskType: 'draft_invoice',
          proposal: createProposal({
            tenantId: ctx.tenantId,
            proposalType: 'draft_invoice',
            payload: {
              customerId: CUST_B,
              lineItems: [{ description: 'Water heater service', quantity: 1, unitPriceCents: 45000 }],
            },
            summary: 'Invoice Bob Jones',
            createdBy: ctx.userId,
          }),
        };
      }),
    };
  }

  const capture = (): EntityAliasCandidateCapture => ({
    capture: vi.fn(async () => {
      events.push(`capture${active ? ' (in tx)' : ' (after commit)'}`);
      return [];
    }),
  });

  const resolve = (deps: Partial<Parameters<typeof resolveProposalEntity>[1]> = {}) =>
    resolveProposalEntity(
      { tenantId: TENANT_UUID, proposalId: PROPOSAL, candidateId: CUST_B, actorId: OWNER, actorRole: 'owner' },
      { proposalRepo: repo, auditRepo, transactionRunner: runner, ...deps },
    );

  it('re-draft: the LLM call runs with no transaction open; every write after it lands in ONE transaction', async () => {
    await repo.create(clarification(ORIGINAL_INTENT));
    const handler = draftingHandler();

    const result = await resolve({
      redraftHandlerFactory: () => handler,
      entityAliasCandidateCapture: capture(),
    });

    expect(result.proposalType).toBe('draft_invoice');
    expect(result.status).toBe('ready_for_review');
    expect(events).toEqual([
      'LLM (no tx)',
      `BEGIN ${TENANT_UUID}`,
      // A3-1 — the row lock first: the draft is only written over the row it
      // was built from.
      'findByIdsForUpdate (in tx)',
      'update (in tx)',
      'updateStatus (in tx)',
      'create (in tx)',
      'COMMIT',
      'capture (after commit)',
    ]);
  });

  it('re-draft: a failure in the second post-LLM write rolls the transaction back and skips the audit and capture', async () => {
    await repo.create(clarification(ORIGINAL_INTENT));
    vi.mocked(repo.updateStatus).mockImplementationOnce(async () => {
      events.push('updateStatus (in tx) -> fails');
      throw new Error('injected status-write failure');
    });
    const aliasCapture = capture();

    await expect(
      resolve({ redraftHandlerFactory: () => draftingHandler(), entityAliasCandidateCapture: aliasCapture }),
    ).rejects.toThrow('injected status-write failure');

    expect(events).toEqual([
      'LLM (no tx)',
      `BEGIN ${TENANT_UUID}`,
      'findByIdsForUpdate (in tx)',
      'update (in tx)',
      'updateStatus (in tx) -> fails',
      'ROLLBACK',
    ]);
    expect(aliasCapture.capture).not.toHaveBeenCalled();
  });

  it('annotate-only: the payload patch, the promotion and the audit commit together, capture after', async () => {
    await repo.create(clarification());

    const result = await resolve({ entityAliasCandidateCapture: capture() });

    expect((result.payload as Record<string, unknown>).customerId).toBe(CUST_B);
    expect(result.status).toBe('ready_for_review');
    expect(events).toEqual([
      `BEGIN ${TENANT_UUID}`,
      'findByIdsForUpdate (in tx)',
      'update (in tx)',
      'updateStatus (in tx)',
      'create (in tx)',
      'COMMIT',
      'capture (after commit)',
    ]);
  });

  it('next ambiguity: the advance and its audit commit together, and the alias capture moves after the commit', async () => {
    await repo.create(
      clarification({
        ...ORIGINAL_INTENT,
        pendingEntityAmbiguities: [
          {
            entityKind: 'job',
            reference: 'Rodriguez job',
            candidates: [
              { id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 },
              { id: JOB_B, kind: 'job', label: 'Rodriguez — bath', score: 0.79 },
            ],
          },
        ],
      }),
    );
    const handler = draftingHandler();

    const result = await resolve({
      redraftHandlerFactory: () => handler,
      entityAliasCandidateCapture: capture(),
    });

    expect(result.proposalType).toBe('voice_clarification');
    expect(handler.handle).not.toHaveBeenCalled();
    expect(events).toEqual([
      `BEGIN ${TENANT_UUID}`,
      'findByIdsForUpdate (in tx)',
      'update (in tx)',
      'create (in tx)',
      'COMMIT',
      'capture (after commit)',
    ]);
  });

  it('next ambiguity: a failed advance write leaves no alias review behind for the unapplied pick', async () => {
    await repo.create(
      clarification({
        pendingEntityAmbiguities: [
          {
            entityKind: 'job',
            reference: 'Rodriguez job',
            candidates: [{ id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 }],
          },
        ],
      }),
    );
    vi.mocked(auditRepo.create).mockImplementationOnce(async () => {
      throw new Error('injected audit failure');
    });
    const aliasCapture = capture();

    await expect(resolve({ entityAliasCandidateCapture: aliasCapture })).rejects.toThrow('injected audit failure');

    expect(events.at(-1)).toBe('ROLLBACK');
    expect(aliasCapture.capture).not.toHaveBeenCalled();
  });
  // A-R3 — the annotate-only and next-ambiguity paths write no status (or, for
  // a ready_for_review row, none at all), so nothing re-checked the status the
  // pick read before its transaction. Each now locks the row and re-checks it
  // first thing inside the transaction: an approve/reject that landed in the
  // gap wins, and the pick rolls back without writing.
  describe('A-R3 — a pick loses to an approve/reject that lands before its transaction', () => {
    /** The pick's read returns its snapshot; then `status` lands, as a
     *  concurrent request would (through the unspied repo method, so the
     *  pick's own event log stays its own). */
    function landsAfterTheRead(status: 'approved' | 'rejected' | 'ready_for_review') {
      const realFindById = repo.findById.bind(repo);
      vi.spyOn(repo, 'findById').mockImplementationOnce(async (tenantId, id) => {
        const snapshot = await realFindById(tenantId, id);
        await InMemoryProposalRepository.prototype.updateStatus.call(repo, tenantId, id, status, {});
        return snapshot;
      });
    }

    it.each(['approved', 'rejected'] as const)(
      'annotate-only on a ready_for_review row: %s wins, nothing is patched or audited',
      async (status) => {
        await repo.create({ ...clarification(), status: 'ready_for_review' });
        const before = await repo.findById(TENANT_UUID, PROPOSAL);
        landsAfterTheRead(status);
        const aliasCapture = capture();

        const err = await resolve({ entityAliasCandidateCapture: aliasCapture }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ConflictError);
        expect((err as Error).message).not.toMatch(/proposal|\bAI\b|agent/i);
        expect(events).toEqual([`BEGIN ${TENANT_UUID}`, 'findByIdsForUpdate (in tx)', 'ROLLBACK']);
        const after = await repo.findById(TENANT_UUID, PROPOSAL);
        expect(after!.status).toBe(status);
        expect(after!.payload).toEqual(before!.payload);
        expect(after!.sourceContext).toEqual(before!.sourceContext);
        expect(await auditRepo.findByEntity(TENANT_UUID, 'proposal', PROPOSAL)).toEqual([]);
        expect(aliasCapture.capture).not.toHaveBeenCalled();
      },
    );

    it('next ambiguity on a draft row: a reject wins and the row is not advanced', async () => {
      await repo.create(
        clarification({
          pendingEntityAmbiguities: [
            {
              entityKind: 'job',
              reference: 'Rodriguez job',
              candidates: [{ id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 }],
            },
          ],
        }),
      );
      const before = await repo.findById(TENANT_UUID, PROPOSAL);
      landsAfterTheRead('rejected');

      await expect(resolve()).rejects.toBeInstanceOf(ConflictError);

      expect(events).toEqual([`BEGIN ${TENANT_UUID}`, 'findByIdsForUpdate (in tx)', 'ROLLBACK']);
      const after = await repo.findById(TENANT_UUID, PROPOSAL);
      expect(after!.status).toBe('rejected');
      expect(after!.payload).toEqual(before!.payload);
      expect(after!.sourceContext).toEqual(before!.sourceContext);
    });

    it('a row that moved from draft to ready_for_review in the gap is still patched (both are open for a pick)', async () => {
      await repo.create(clarification());
      landsAfterTheRead('ready_for_review');

      const result = await resolve();

      expect(result.status).toBe('ready_for_review');
      expect((result.payload as Record<string, unknown>).customerId).toBe(CUST_B);
    });
  });

  // A3-1 — the pick built its patch from the row it read BEFORE its
  // transaction, and the lock only re-checked the status. A payload edit, a
  // resolve-line or a second pick that committed in that gap (the re-draft's
  // gap spans its LLM call) was silently overwritten with the stale copy.
  describe('A3-1 — a pick never overwrites a change that landed after its read', () => {
    const PENDING_JOB = {
      pendingEntityAmbiguities: [
        {
          entityKind: 'job',
          reference: 'Rodriguez job',
          candidates: [
            { id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 },
            { id: JOB_B, kind: 'job', label: 'Rodriguez — bath', score: 0.79 },
          ],
        },
      ],
    };

    /** The pick's read returns its snapshot, then `concurrent` commits (as
     *  another request would) before the pick goes on. The pick's own event
     *  log starts after it. */
    function afterTheRead(concurrent: () => Promise<unknown>) {
      const realFindById = repo.findById.bind(repo);
      vi.spyOn(repo, 'findById').mockImplementationOnce(async (tenantId, id) => {
        const snapshot = await realFindById(tenantId, id);
        await concurrent();
        events.length = 0;
        return snapshot;
      });
    }

    /** An owner edit of the payload (PUT /proposals/:id), through the
     *  unspied repo so it stays out of the pick's event log. */
    const anEditLands = () =>
      afterTheRead(async () => {
        const row = await InMemoryProposalRepository.prototype.findById.call(repo, TENANT_UUID, PROPOSAL);
        await InMemoryProposalRepository.prototype.update.call(repo, TENANT_UUID, PROPOSAL, {
          payload: { ...row!.payload, transcript: 'invoice Bob for the water heater and the filter' },
        });
      });

    /** A second pick of `candidateId`, from another tab, that commits first. */
    const anotherPickLands = (candidateId: string, deps: Partial<Parameters<typeof resolveProposalEntity>[1]> = {}) =>
      afterTheRead(() =>
        resolveProposalEntity(
          { tenantId: TENANT_UUID, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole: 'owner' },
          { proposalRepo: repo, auditRepo, transactionRunner: runner, ...deps },
        ),
      );

    const resolvedAuditCount = async () =>
      (await auditRepo.findByEntity(TENANT_UUID, 'proposal', PROPOSAL)).filter(
        (a) => a.eventType === 'proposal.entity_resolved',
      ).length;

    it('annotate-only: an edit that lands after the read is kept, and the pick lands on top of it', async () => {
      await repo.create(clarification());
      anEditLands();
      const aliasCapture = capture();

      const result = await resolve({ entityAliasCandidateCapture: aliasCapture });

      const payload = result.payload as Record<string, unknown>;
      expect(payload.transcript).toBe('invoice Bob for the water heater and the filter');
      expect(payload.customerId).toBe(CUST_B);
      expect(payload.entityCandidates).toBeUndefined();
      expect(result.status).toBe('ready_for_review');
      expect(events).toEqual([
        `BEGIN ${TENANT_UUID}`,
        'findByIdsForUpdate (in tx)',
        'update (in tx)',
        'updateStatus (in tx)',
        'create (in tx)',
        'COMMIT',
        'capture (after commit)',
      ]);
      // The alias is grounded in the row the patch was built from.
      expect(vi.mocked(aliasCapture.capture).mock.calls[0][0]).toMatchObject({
        groundingProposal: { payload: { transcript: 'invoice Bob for the water heater and the filter' } },
      });
    });

    it('annotate-only: a different pick that landed first wins; this one is refused and writes nothing', async () => {
      await repo.create(clarification());
      anotherPickLands(CUST_A);
      const aliasCapture = capture();

      const err = await resolve({ entityAliasCandidateCapture: aliasCapture }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as Error).message).toBe('This was already handled, so that choice was not saved.');
      expect(events).toEqual([`BEGIN ${TENANT_UUID}`, 'findByIdsForUpdate (in tx)', 'ROLLBACK']);
      const row = await repo.findById(TENANT_UUID, PROPOSAL);
      expect((row!.payload as Record<string, unknown>).customerId).toBe(CUST_A);
      expect(await resolvedAuditCount()).toBe(1);
      expect(aliasCapture.capture).not.toHaveBeenCalled();
    });

    it('annotate-only: a change that makes the choice take another path is refused with "try again"; nothing is written', async () => {
      await repo.create(clarification());
      // Another reference to settle lands on the card after the read, so the
      // locked row would advance to it rather than annotate.
      afterTheRead(async () => {
        const row = await InMemoryProposalRepository.prototype.findById.call(repo, TENANT_UUID, PROPOSAL);
        await InMemoryProposalRepository.prototype.update.call(repo, TENANT_UUID, PROPOSAL, {
          sourceContext: { ...row!.sourceContext, ...PENDING_JOB },
        });
      });
      const aliasCapture = capture();

      const err = await resolve({ entityAliasCandidateCapture: aliasCapture }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as Error).message).toBe('This changed while you were choosing. Please try again.');
      expect(events).toEqual([`BEGIN ${TENANT_UUID}`, 'findByIdsForUpdate (in tx)', 'ROLLBACK']);
      const row = await repo.findById(TENANT_UUID, PROPOSAL);
      expect((row!.payload as Record<string, unknown>).customerId).toBeUndefined();
      expect(await resolvedAuditCount()).toBe(0);
      expect(aliasCapture.capture).not.toHaveBeenCalled();
    });

    it('annotate-only: the same pick landing first (a double tap) is a no-op success, not a second write', async () => {
      await repo.create(clarification());
      anotherPickLands(CUST_B);

      const result = await resolve();

      expect((result.payload as Record<string, unknown>).customerId).toBe(CUST_B);
      expect(events.filter((e) => e.startsWith('update') || e.startsWith('create'))).toEqual([]);
      expect(await resolvedAuditCount()).toBe(1);
    });

    it('next ambiguity: an edit that lands after the read is kept, and the row advances on top of it', async () => {
      await repo.create(clarification(PENDING_JOB));
      anEditLands();

      const result = await resolve();

      const payload = result.payload as Record<string, unknown>;
      expect(payload.transcript).toBe('invoice Bob for the water heater and the filter');
      expect(payload.entityReference).toBe('Rodriguez job');
      expect((payload.entityCandidates as Array<{ id: string }>).map((c) => c.id)).toEqual([JOB_A, JOB_B]);
      expect((result.sourceContext as Record<string, unknown>).resolvedEntities).toEqual([
        { id: CUST_B, field: 'customerId', kind: 'customer', label: 'Bob Jones', offeredIds: [CUST_A, CUST_B] },
      ]);
      expect(result.status).toBe('draft');
    });

    it('next ambiguity: a different pick that landed first wins; this one is refused and the row is not advanced again', async () => {
      await repo.create(clarification(PENDING_JOB));
      anotherPickLands(CUST_A);

      await expect(resolve()).rejects.toBeInstanceOf(ConflictError);

      expect(events).toEqual([`BEGIN ${TENANT_UUID}`, 'findByIdsForUpdate (in tx)', 'ROLLBACK']);
      const row = await repo.findById(TENANT_UUID, PROPOSAL);
      expect((row!.sourceContext as Record<string, unknown>).resolvedEntities).toEqual([
        { id: CUST_A, field: 'customerId', kind: 'customer', label: 'Bob Smith', offeredIds: [CUST_A, CUST_B] },
      ]);
      expect(await resolvedAuditCount()).toBe(1);
    });

    it('re-draft: an edit that lands during the LLM call refuses the stale draft; nothing is written', async () => {
      await repo.create(clarification(ORIGINAL_INTENT));
      anEditLands();
      const aliasCapture = capture();

      const err = await resolve({
        redraftHandlerFactory: () => draftingHandler(),
        entityAliasCandidateCapture: aliasCapture,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      // The question is still open, so a retry works: say so, not "handled".
      expect((err as Error).message).toBe('This changed while you were choosing. Please try again.');
      expect(events).toEqual(['LLM (no tx)', `BEGIN ${TENANT_UUID}`, 'findByIdsForUpdate (in tx)', 'ROLLBACK']);
      const row = await repo.findById(TENANT_UUID, PROPOSAL);
      expect(row!.proposalType).toBe('voice_clarification');
      expect(row!.status).toBe('draft');
      expect((row!.payload as Record<string, unknown>).transcript).toBe(
        'invoice Bob for the water heater and the filter',
      );
      expect((row!.payload as Record<string, unknown>).customerId).toBeUndefined();
      expect(await resolvedAuditCount()).toBe(0);
      expect(aliasCapture.capture).not.toHaveBeenCalled();
    });

    it('re-draft: a different pick that re-drafted first wins; the stale draft is refused', async () => {
      await repo.create(clarification(ORIGINAL_INTENT));
      anotherPickLands(CUST_A, { redraftHandlerFactory: () => draftingHandler() });

      const err = await resolve({ redraftHandlerFactory: () => draftingHandler() }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      // The other pick answered the question: nothing is left to retry.
      expect((err as Error).message).toBe('This was already handled, so that choice was not saved.');
      expect(events).toEqual(['LLM (no tx)', `BEGIN ${TENANT_UUID}`, 'findByIdsForUpdate (in tx)', 'ROLLBACK']);
      const row = await repo.findById(TENANT_UUID, PROPOSAL);
      expect((row!.sourceContext as Record<string, unknown>).resolvedEntity).toMatchObject({ id: CUST_A });
      expect(await resolvedAuditCount()).toBe(1);
    });

    it('re-draft: the same pick re-drafting first (a double tap) is a no-op success with the draft that landed', async () => {
      await repo.create(clarification(ORIGINAL_INTENT));
      anotherPickLands(CUST_B, { redraftHandlerFactory: () => draftingHandler() });

      const result = await resolve({ redraftHandlerFactory: () => draftingHandler() });

      expect(result.proposalType).toBe('draft_invoice');
      expect(result.status).toBe('ready_for_review');
      expect(events.filter((e) => e.startsWith('update') || e.startsWith('create'))).toEqual([]);
      expect(await resolvedAuditCount()).toBe(1);
    });
  });

  // A4-5 — a pick on a question another pick already answered got a 409
  // ("already handled") when that pick landed while it waited on the row
  // lock, but a 400 ("nothing left to choose" / "not one of the options")
  // when it had landed before the first read: the same situation, two
  // answers, split by timing. Each resolution now records the choices its
  // question offered, so the first read can tell it too.
  describe('A4-5 — a pick on an already-answered question gets the same 409 at the first read as under the lock', () => {
    const PENDING_JOB = {
      pendingEntityAmbiguities: [
        {
          entityKind: 'job',
          reference: 'Rodriguez job',
          candidates: [
            { id: JOB_A, kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 },
            { id: JOB_B, kind: 'job', label: 'Rodriguez — bath', score: 0.79 },
          ],
        },
      ],
    };

    const pickOf = (candidateId: string, deps: Partial<Parameters<typeof resolveProposalEntity>[1]> = {}) =>
      resolveProposalEntity(
        { tenantId: TENANT_UUID, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole: 'owner' },
        { proposalRepo: repo, auditRepo, transactionRunner: runner, ...deps },
      );

    const resolvedAuditCount = async () =>
      (await auditRepo.findByEntity(TENANT_UUID, 'proposal', PROPOSAL)).filter(
        (a) => a.eventType === 'proposal.entity_resolved',
      ).length;

    /** What the owner sees: status, code and words. */
    const refusal = (err: unknown) => {
      expect(err).toBeInstanceOf(ConflictError);
      const e = err as ConflictError;
      return { statusCode: e.statusCode, code: e.code, message: e.message };
    };

    /** The same refusal under the row lock: the other pick lands after this one's first read (A3-1). */
    async function refusalUnderTheLock(seed: Proposal, deps: Partial<Parameters<typeof resolveProposalEntity>[1]> = {}) {
      await repo.create(seed);
      const realFindById = repo.findById.bind(repo);
      vi.spyOn(repo, 'findById').mockImplementationOnce(async (tenantId, id) => {
        const snapshot = await realFindById(tenantId, id);
        await pickOf(CUST_A, deps);
        return snapshot;
      });
      const err = await pickOf(CUST_B, deps).catch((e: unknown) => e);
      vi.mocked(repo.findById).mockRestore();
      return refusal(err);
    }

    it.each([
      ['annotate-only', {}, {}],
      ['next ambiguity', PENDING_JOB, {}],
      ['re-draft', ORIGINAL_INTENT, { redraftHandlerFactory: () => draftingHandler() }],
    ] as const)('%s: refused at the first read with the 409 the row lock gives; nothing is written', async (_path, ctx, deps) => {
      await repo.create(clarification(ctx));
      await pickOf(CUST_A, deps);
      const answered = await repo.findById(TENANT_UUID, PROPOSAL);
      events.length = 0;

      const err = await pickOf(CUST_B, deps).catch((e: unknown) => e);

      expect(refusal(err)).toEqual({
        statusCode: 409,
        code: 'CONFLICT',
        message: 'This was already handled, so that choice was not saved.',
      });
      expect((err as ConflictError).details).toEqual({ status: answered!.status });
      // Refused before any transaction: no lock, no write, no second audit.
      expect(events).toEqual([]);
      expect(await repo.findById(TENANT_UUID, PROPOSAL)).toEqual(answered);
      expect(await resolvedAuditCount()).toBe(1);

      // Word for word what the owner gets when the other pick lands while
      // this one waits on the row lock instead.
      repo = new InMemoryProposalRepository();
      auditRepo = new InMemoryAuditRepository();
      expect(refusal(err)).toEqual(await refusalUnderTheLock(clarification(ctx), deps));
    });

    it('each resolution records the choices its question offered', async () => {
      await repo.create(clarification(PENDING_JOB));
      const advanced = await pickOf(CUST_A);
      expect((advanced.sourceContext as Record<string, unknown>).resolvedEntities).toEqual([
        { id: CUST_A, field: 'customerId', kind: 'customer', label: 'Bob Smith', offeredIds: [CUST_A, CUST_B] },
      ]);
    });

    it('an id no question ever offered is still the 400 "not one of the options" (grounding), on an answered row too', async () => {
      await repo.create(clarification(PENDING_JOB));
      await pickOf(CUST_A);
      const err = await pickOf('99999999-9999-4999-8999-999999999999').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe('That choice is not one of the options.');
    });

    it('the same pick again (a double tap) is still a no-op success', async () => {
      await repo.create(clarification(PENDING_JOB));
      await pickOf(CUST_A);
      const again = await pickOf(CUST_A);
      expect((again.payload as Record<string, unknown>).entityReference).toBe('Rodriguez job');
      expect(await resolvedAuditCount()).toBe(1);
    });
  });
});

/**
 * Without a pool the in-memory findByIdsForUpdate is a plain copy and
 * InMemoryTransactionRunner locks nothing unless asked through scope.lock, so
 * the row can change between a pick's "locked" read and its write. Every path
 * writes a payload and sourceContext built from that read, so each write goes
 * through updateIfUnchanged against it: a pick whose row moved is refused with
 * the plain "try again" 409 and writes nothing (no status move, no audit, no
 * alias review), instead of erasing the change that landed first.
 */
describe('A4-6 — resolveProposalEntity when the row changes between its locked read and its write (no row lock)', () => {
  const PICK_CHANGED = 'This changed while you were choosing. Please try again.';
  const EDITED_TRANSCRIPT = 'invoice Bob for the water heater and the filter';
  let repo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  const PENDING_JOB = {
    pendingEntityAmbiguities: [
      {
        entityKind: 'job',
        reference: 'Rodriguez job',
        candidates: [
          { id: 'job-a', kind: 'job', label: 'Rodriguez — kitchen', score: 0.8 },
          { id: 'job-b', kind: 'job', label: 'Rodriguez — bath', score: 0.79 },
        ],
      },
    ],
  };
  const ORIGINAL_INTENT = {
    originalIntent: { intentType: 'create_invoice', extractedEntities: { customerName: 'Bob' } },
  };

  function clarification(extra: Record<string, unknown> = {}): Proposal {
    const base = ambiguousEntityProposal();
    return { ...base, sourceContext: { ...base.sourceContext, ...extra } };
  }

  /** Stands in for the re-draft's LLM call: a draft_invoice for whichever customer was picked. */
  const draftingHandler = (): TaskHandler => ({
    taskType: 'draft_invoice',
    handle: async (ctx: TaskContext) => ({
      taskType: 'draft_invoice',
      proposal: createProposal({
        tenantId: ctx.tenantId,
        proposalType: 'draft_invoice',
        payload: {
          customerId: ctx.existingEntities?.customerId,
          lineItems: [{ description: 'Water heater service', quantity: 1, unitPriceCents: 45000 }],
        },
        summary: 'Invoice Bob',
        createdBy: ctx.userId,
      }),
    }),
  });

  const PATHS = [
    { path: 'annotate-only', extra: {}, redraft: false },
    { path: 'next ambiguity', extra: PENDING_JOB, redraft: false },
    { path: 're-draft', extra: ORIGINAL_INTENT, redraft: true },
  ] as const;

  const pick = (candidateId: string, redraft: boolean, capture?: EntityAliasCandidateCapture) =>
    resolveProposalEntity(
      { tenantId: TENANT, proposalId: PROPOSAL, candidateId, actorId: OWNER, actorRole: 'owner' },
      {
        proposalRepo: repo,
        auditRepo,
        transactionRunner: new InMemoryTransactionRunner(),
        ...(redraft ? { redraftHandlerFactory: () => draftingHandler() } : {}),
        ...(capture ? { entityAliasCandidateCapture: capture } : {}),
      },
    );

  /** Every pick's locked read waits here until `count` picks have made it. */
  function lockedReadTogether(count: number): void {
    const realRead = repo.findByIdsForUpdate.bind(repo);
    let reads = 0;
    let allRead!: () => void;
    const together = new Promise<void>((resolve) => {
      allRead = resolve;
    });
    repo.findByIdsForUpdate = async (...args: Parameters<typeof realRead>) => {
      const rows = await realRead(...args);
      reads += 1;
      if (reads === count) allRead();
      await together;
      return rows;
    };
  }

  /** `then` commits after the next pick's locked read and before its write (once). */
  function afterLockedRead(then: () => Promise<unknown>): void {
    const realRead = repo.findByIdsForUpdate.bind(repo);
    repo.findByIdsForUpdate = async (...args: Parameters<typeof realRead>) => {
      repo.findByIdsForUpdate = realRead;
      const rows = await realRead(...args);
      await then();
      return rows;
    };
  }

  const resolvedAudits = async () =>
    (await auditRepo.findByEntity(TENANT, 'proposal', PROPOSAL)).filter((a) => a.eventType === 'proposal.entity_resolved');

  const aliasCapture = (): EntityAliasCandidateCapture => ({ capture: vi.fn(async () => []) });

  it.each(PATHS)(
    '$path: two picks that made the same locked read: one is saved, the other gets the plain 409 and writes nothing',
    async ({ extra, redraft }) => {
      await repo.create(clarification(extra));
      const before = (await repo.findById(TENANT, PROPOSAL))!;
      lockedReadTogether(2);
      const capture = aliasCapture();

      const [first, second] = await Promise.allSettled([
        pick('cust-a', redraft, capture),
        pick('cust-b', redraft, capture),
      ]);

      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('rejected');
      const err = (second as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe(PICK_CHANGED);

      // The first pick is the one on the row; the refused one left no trace.
      const stored = (await repo.findById(TENANT, PROPOSAL))!;
      expect((stored.sourceContext as Record<string, unknown>).resolvedEntities).toEqual([
        { id: 'cust-a', field: 'customerId', kind: 'customer', label: 'Bob Smith', offeredIds: ['cust-a', 'cust-b'] },
      ]);
      expect(stored.targetEntityId).toBe('cust-a');
      expect(stored.proposalType).toBe(redraft ? 'draft_invoice' : before.proposalType);
      expect((await resolvedAudits()).map((a) => a.metadata?.candidateId)).toEqual(['cust-a']);
      expect(vi.mocked(capture.capture).mock.calls.map((c) => c[0].selectedEntityId)).toEqual(['cust-a']);
    },
  );

  it.each(PATHS)(
    '$path: an edit that commits between the locked read and the write refuses the pick; the edit is kept',
    async ({ extra, redraft }) => {
      await repo.create(clarification(extra));
      afterLockedRead(() =>
        editProposal(repo, TENANT, PROPOSAL, OWNER, 'owner', { transcript: EDITED_TRANSCRIPT }, auditRepo),
      );
      const capture = aliasCapture();

      const err = await pick('cust-b', redraft, capture).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toBe(PICK_CHANGED);
      const stored = (await repo.findById(TENANT, PROPOSAL))!;
      expect(stored.proposalType).toBe('voice_clarification');
      expect(stored.status).toBe('draft');
      const payload = stored.payload as Record<string, unknown>;
      expect(payload.transcript).toBe(EDITED_TRANSCRIPT);
      expect(payload.entityReference).toBe('Bob');
      expect(payload.customerId).toBeUndefined();
      expect((stored.sourceContext as Record<string, unknown>).resolvedEntities).toBeUndefined();
      expect(await resolvedAudits()).toEqual([]);
      expect(capture.capture).not.toHaveBeenCalled();

      // A retry reads the row as it is now and goes through, on top of the edit.
      const retried = await pick('cust-b', redraft);
      expect((retried.sourceContext as Record<string, unknown>).resolvedEntities).toMatchObject([{ id: 'cust-b' }]);
    },
  );
});
