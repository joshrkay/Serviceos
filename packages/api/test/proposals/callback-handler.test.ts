/**
 * Task 14 (2026-08-07 tradesperson plan) — `callback` execution handler.
 *
 * `callback` proposals route a caller/customer to a human — they mutate
 * nothing (see proposal.ts's actionClassForProposalType doc comment and
 * surface.ts's S1 allowlist comment: "routes the caller to a human — never
 * a mutation"). Historically `callback` had NO execution handler registered
 * at all: an approved callback reached ProposalExecutor, found nothing in
 * the handler map, and threw `HANDLER_NOT_FOUND`. The execution sweep
 * (workers/execution-worker.ts) catches that per-proposal throw and moves
 * on, leaving the row claimed ('executing'); resetStaleExecuting then
 * retries it up to 3 times (10-minute stale window each) before landing it
 * in terminal 'execution_failed' — no audit trail explains why, and the
 * caller's callback request dead-ends there.
 *
 * The fix: a deliberately dep-free acknowledgement handler, registered
 * UNCONDITIONALLY in handlers.ts (there is nothing to wire — see the class
 * doc comment on CallbackExecutionHandler for why a no-op is the correct
 * semantic here, not a gap).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Proposal,
  InMemoryProposalRepository,
  createProposal,
} from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';
import { CallbackExecutionHandler } from '../../src/proposals/execution/callback-handler';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { InMemoryAuditRepository, AuditRepository } from '../../src/audit/audit';

const TENANT = 't-1';
const CALLBACK_PAYLOAD = { callerPhone: '+15555550100', callbackMessage: 'wants a quote' };

function makeProposal(
  payload: Record<string, unknown>,
  overrides: Partial<Proposal> = {},
): Proposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'callback',
    status: 'approved',
    payload,
    summary: 'After-hours callback request',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('createExecutionHandlerRegistry — callback registration', () => {
  it('registers a callback handler with NO deps wired at all', () => {
    const registry = createExecutionHandlerRegistry({});
    expect(registry.get('callback')).toBeDefined();
  });

  it('the registered callback handler reports isFullyWired() === true (deliberately dep-free)', () => {
    const registry = createExecutionHandlerRegistry({});
    expect(registry.get('callback')!.isFullyWired?.()).toBe(true);
  });
});

describe('CallbackExecutionHandler', () => {
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  it('is fully wired with zero dependencies', () => {
    expect(new CallbackExecutionHandler().isFullyWired()).toBe(true);
  });

  it('acknowledges an approved callback proposal and succeeds without throwing', async () => {
    const handler = new CallbackExecutionHandler();
    const result = await handler.execute(makeProposal(CALLBACK_PAYLOAD), ctx);
    expect(result).toEqual({ success: true, resultEntityId: 'prop-1' });
  });

  it('succeeds even on a minimal/empty payload — the callback contract is an all-optional passthrough', async () => {
    const handler = new CallbackExecutionHandler();
    const result = await handler.execute(makeProposal({}), ctx);
    expect(result.success).toBe(true);
  });

  it('emits a failure-soft callback.acknowledged audit event when an audit repo is wired', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CallbackExecutionHandler(auditRepo);
    const proposal = makeProposal(CALLBACK_PAYLOAD);

    const result = await handler.execute(proposal, ctx);
    expect(result.success).toBe(true);

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('callback.acknowledged');
    expect(events[0].entityType).toBe('proposal');
    expect(events[0].entityId).toBe(proposal.id);
    expect(events[0].metadata).toMatchObject({
      proposalId: proposal.id,
      proposalType: 'callback',
    });
  });

  it('does not emit any audit event when no audit repo is wired', async () => {
    const handler = new CallbackExecutionHandler();
    const result = await handler.execute(makeProposal(CALLBACK_PAYLOAD), ctx);
    expect(result.success).toBe(true);
  });

  it('a throwing audit repo does NOT break execution — failure-soft, matching the LogExpense family', async () => {
    const throwingAuditRepo: AuditRepository = {
      create: vi.fn(async () => {
        throw new Error('audit sink down');
      }),
      findByEntity: vi.fn(async () => []),
      findByCorrelation: vi.fn(async () => []),
    };
    const handler = new CallbackExecutionHandler(throwingAuditRepo);
    const result = await handler.execute(makeProposal(CALLBACK_PAYLOAD), ctx);
    expect(result).toEqual({ success: true, resultEntityId: 'prop-1' });
    expect(throwingAuditRepo.create).toHaveBeenCalledTimes(1);
  });
});

describe('regression: an approved callback proposal no longer HANDLER_NOT_FOUND', () => {
  function approvedCallbackProposal(): Proposal {
    // Bypass the 5-second undo window by stamping approvedAt > 5s ago.
    const past = new Date(Date.now() - 6_000);
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'callback',
      payload: CALLBACK_PAYLOAD,
      summary: 'After-hours callback request',
      createdBy: 'system:text-mode',
    });
    let p = transitionProposal(proposal, 'ready_for_review', 'system:text-mode');
    p = transitionProposal(p, 'approved', 'u-1');
    p.approvedAt = past;
    return p;
  }

  it('executes successfully end-to-end through ProposalExecutor with a registry built from NO deps', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const auditRepo = new InMemoryAuditRepository();
    const registry = createExecutionHandlerRegistry({}); // no deps at all — production-shape gap
    const executor = new ProposalExecutor(
      registry,
      proposalRepo,
      new IdempotencyGuard(executionRepo, proposalRepo),
      auditRepo,
    );

    const proposal = approvedCallbackProposal();
    await proposalRepo.create(proposal);

    const { proposal: updated, result } = await executor.execute(proposal, {
      tenantId: TENANT,
      executedBy: 'u-1',
    });

    expect(result.success).toBe(true);
    expect(updated.status).toBe('executed');

    // The executor's own WS11 outcome audit event fired proposal.executed,
    // not proposal.execution_failed — proving the old HANDLER_NOT_FOUND path
    // is gone (that path never reaches the executeAudited call at all: it
    // throws before any status transition).
    const proposalEvents = await auditRepo.findByEntity(TENANT, 'proposal', proposal.id);
    expect(proposalEvents.some((e) => e.eventType === 'proposal.executed')).toBe(true);
    expect(proposalEvents.some((e) => e.eventType === 'proposal.execution_failed')).toBe(false);
  });
});
