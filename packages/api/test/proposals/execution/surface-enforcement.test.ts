import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import {
  createProposal,
  InMemoryProposalRepository,
  Proposal,
  ProposalType,
} from '../../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../../src/proposals/execution/idempotency';
import { IdempotencyLockProvider } from '../../../src/proposals/execution/idempotency-lock';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  ExecutionContext,
  ExecutionHandler,
  ExecutionResult,
} from '../../../src/proposals/execution/handlers';
import {
  S1_ALLOWED_PROPOSAL_TYPES,
  isProposalTypeAllowedOnSurface,
  resolveSurface,
} from '../../../src/proposals/surface';

/**
 * RIVET P4 — surface enforcement at the EXECUTION boundary (invariant I6).
 *
 * The gate's highest-severity invariant: no S1 (inbound, unauthenticated
 * caller) session may ever execute an S2-only operation, "under any transcript
 * content." This proves the boundary check refuses an S1-stamped S2 proposal
 * even after it has been approved — the caller controls the transcript, so the
 * approval-queue human backstop is not the guarantee; the execution boundary
 * is.
 */

class NoopLockProvider implements IdempotencyLockProvider {
  async withLock<T>(
    _tenantId: string,
    _idempotencyKey: string,
    fn: (client?: PoolClient) => Promise<T>,
  ): Promise<T> {
    return fn(undefined);
  }
}

class RecordingHandler implements ExecutionHandler {
  constructor(public proposalType: ProposalType) {}
  public invocations = 0;
  async execute(): Promise<ExecutionResult> {
    this.invocations += 1;
    return { success: true, resultEntityId: 'entity-1' };
  }
}

function makeApproved(
  tenantId: string,
  proposalType: ProposalType,
  surface: 'S1' | 'S2' | undefined,
): Proposal {
  let proposal = createProposal({
    tenantId,
    proposalType,
    payload: { name: 'Surface Test' },
    summary: 'surface',
    createdBy: 'user-1',
    idempotencyKey: `surface-${randomUUID()}`,
    sourceContext: surface
      ? { source: 'calling-agent', channel: 'telephony', surface }
      : undefined,
  });
  proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
  proposal = transitionProposal(proposal, 'approved', 'user-1');
  return { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
}

async function run(
  proposalType: ProposalType,
  surface: 'S1' | 'S2' | undefined,
): Promise<{ result: Awaited<ReturnType<ProposalExecutor['execute']>> | null; error?: unknown; handler: RecordingHandler }> {
  const tenantId = randomUUID();
  const repo = new InMemoryProposalRepository();
  const executionRepo = new InMemoryProposalExecutionRepository();
  const guard = new IdempotencyGuard(executionRepo, repo, new NoopLockProvider());
  const handler = new RecordingHandler(proposalType);
  const executor = new ProposalExecutor(
    new Map<ProposalType, ExecutionHandler>([[proposalType, handler]]),
    repo,
    guard,
    new InMemoryAuditRepository(),
    { executionRepo },
  );
  const proposal = makeApproved(tenantId, proposalType, surface);
  await repo.create(proposal);
  const ctx: ExecutionContext = { tenantId, executedBy: 'user-1' };
  try {
    const result = await executor.execute(proposal, ctx);
    return { result, handler };
  } catch (error) {
    return { result: null, error, handler };
  }
}

describe('ProposalExecutor — RIVET P4 surface enforcement (I6)', () => {
  it('BLOCKS an S1-stamped S2-only op (send_invoice) even when approved', async () => {
    const { result, error, handler } = await run('send_invoice', 'S1');
    expect(result).toBeNull();
    expect(handler.invocations).toBe(0);
    expect((error as { code?: string })?.code).toBe('SURFACE_VIOLATION');
    expect((error as { statusCode?: number })?.statusCode).toBe(403);
  });

  it('BLOCKS an S1-stamped money op (record_payment)', async () => {
    const { result, handler } = await run('record_payment', 'S1');
    expect(result).toBeNull();
    expect(handler.invocations).toBe(0);
  });

  it('ALLOWS an S1-stamped allowlisted op (create_customer, self-signup)', async () => {
    const { result, handler } = await run('create_customer', 'S1');
    expect(result?.proposal.status).toBe('executed');
    expect(handler.invocations).toBe(1);
  });

  it('ALLOWS an S1-stamped allowlisted booking op (create_appointment)', async () => {
    const { result, handler } = await run('create_appointment', 'S1');
    expect(result?.proposal.status).toBe('executed');
    expect(handler.invocations).toBe(1);
  });

  it('ALLOWS the same S2-only op when the surface is S2 (operator)', async () => {
    const { result, handler } = await run('send_invoice', 'S2');
    expect(result?.proposal.status).toBe('executed');
    expect(handler.invocations).toBe(1);
  });

  it('ALLOWS when no surface is stamped (backward compatible — trusted)', async () => {
    const { result, handler } = await run('send_invoice', undefined);
    expect(result?.proposal.status).toBe('executed');
    expect(handler.invocations).toBe(1);
  });
});

describe('S1 allowlist (RIVET spec §2) — allowlist, not denylist', () => {
  it('permits only the enumerated inbound-caller proposal types on S1', () => {
    // Money movement / external sends are never on the allowlist.
    for (const op of ['send_invoice', 'record_payment', 'send_estimate', 'refund'] as ProposalType[]) {
      expect(isProposalTypeAllowedOnSurface('S1', op)).toBe(false);
    }
    // The enumerated set is permitted.
    for (const op of S1_ALLOWED_PROPOSAL_TYPES) {
      expect(isProposalTypeAllowedOnSurface('S1', op)).toBe(true);
    }
  });

  it('does not restrict S2 / S3 / unstamped surfaces', () => {
    expect(isProposalTypeAllowedOnSurface('S2', 'send_invoice')).toBe(true);
    expect(isProposalTypeAllowedOnSurface('S3', 'send_invoice')).toBe(true);
    expect(isProposalTypeAllowedOnSurface(undefined, 'send_invoice')).toBe(true);
  });
});

describe('resolveSurface — fail-safe inference (Codex: no unstamped-inbound trust)', () => {
  it('honors an explicit surface stamp over any inference', () => {
    expect(resolveSurface({ surface: 'S2', channel: 'telephony' })).toBe('S2');
    expect(resolveSurface({ surface: 'S1', channel: 'inapp' })).toBe('S1');
  });

  it('infers S1 from an inbound-telephony channel for a non-system (caller) author', () => {
    for (const channel of ['telephony', 'telephony_voice', 'voice_inbound', 'media_streams']) {
      expect(resolveSurface({ source: 'calling-agent', channel }, 'calling-agent')).toBe('S1');
      expect(resolveSurface({ source: 'calling-agent', channel }, 'cust-123')).toBe('S1');
    }
  });

  it('does NOT infer S1 for a SYSTEM-authored telephony proposal (server-generated during a call)', () => {
    // e.g. the vulnerability-triage update_customer: channel telephony, but
    // authored by system:vulnerability-triage and owner-approved — trusted.
    expect(
      resolveSurface(
        { source: 'calling-agent', channel: 'telephony', reason: 'vulnerability_triage' },
        'system:vulnerability-triage',
      ),
    ).toBeUndefined();
  });

  it('does NOT infer S1 for in-app or non-telephony proposals (unrestricted)', () => {
    expect(resolveSurface({ source: 'calling-agent', channel: 'inapp' }, 'cust-1')).toBeUndefined();
    expect(resolveSurface({ channel: 'sms' }, 'cust-1')).toBeUndefined();
    expect(resolveSurface(undefined, undefined)).toBeUndefined();
  });
});
