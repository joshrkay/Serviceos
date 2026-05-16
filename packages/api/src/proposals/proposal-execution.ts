/**
 * proposal_executions — captures the as-executed payload alongside the
 * immutable proposals.payload column.
 *
 * Why a separate table (and not an `executed_payload` column on
 * proposals): proposals are immutable per design — mutating a row that
 * may have been authored by an LLM is bad provenance. Executions, by
 * contrast, are explicit human acts (or worker-driven retries / undos)
 * and deserve their own audit row with `executed_by`, `executed_at`,
 * and an `idempotency_key`. Multiple rows per proposal are allowed for
 * retry → undo → redo.
 *
 * Phase 2 of the inbound-CSR training-data architecture: the
 * proposal-correction-worker (Phase 4a) will read the latest
 * `proposal_executions.executed_payload` for an executed proposal and
 * diff it against `proposals.payload`. A non-empty diff becomes a
 * "correction chunk" embedded into knowledge_chunks under
 * source_type='proposal_correction' — that's the highest-signal
 * training data we capture today (explicit ground truth on what the
 * AI got wrong).
 *
 * No caller in main writes this surface yet; the
 * CreateAppointmentExecutionHandler + the dispatcher approval flow
 * will start writing rows in Phase 4a.
 */

import { randomUUID } from 'crypto';

export type ProposalExecutionStatus = 'succeeded' | 'failed' | 'undone';

export interface ProposalExecution {
  id: string;
  tenantId: string;
  proposalId: string;
  /** The actual values executed against the entity (post-dispatcher edit). */
  executedPayload: Record<string, unknown>;
  executedBy: string;
  executedAt: Date;
  status: ProposalExecutionStatus;
  errorMessage?: string;
  /** Set by callers that want safe retry behaviour; partial unique index. */
  idempotencyKey?: string;
  createdAt: Date;
}

export interface RecordExecutionInput {
  tenantId: string;
  proposalId: string;
  executedPayload: Record<string, unknown>;
  executedBy: string;
  status: ProposalExecutionStatus;
  errorMessage?: string;
  /** When provided, an existing row with the same key returns instead of inserting again. */
  idempotencyKey?: string;
  /** Defaults to NOW() at the database. */
  executedAt?: Date;
}

export interface ProposalExecutionRepository {
  recordExecution(input: RecordExecutionInput): Promise<ProposalExecution>;
  /** Latest execution (by executed_at DESC) for a given proposal, if any. */
  findLatestByProposal(tenantId: string, proposalId: string): Promise<ProposalExecution | null>;
  listByProposal(tenantId: string, proposalId: string): Promise<ProposalExecution[]>;
  /**
   * Indexed lookup by (tenant_id, idempotency_key). Returns the latest
   * succeeded execution for the key, or null. Used by IdempotencyGuard
   * to short-circuit re-execution of a proposal whose side effect
   * already landed. Backed by partial unique index
   * `proposal_executions_tenant_idempotency_uniq` (migration 099).
   *
   * Only rows with status='succeeded' satisfy the guard — a failed or
   * undone execution does not block a retry.
   *
   * Callers must supply idempotency keys that are unique per tenant, not
   * merely per proposal — this lookup is not scoped by `proposalId`, so
   * two different proposals sharing the same key would be ambiguous (the
   * latest wins).
   */
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ProposalExecution | null>;
}

function validateInput(input: RecordExecutionInput): void {
  if (!input.tenantId) throw new Error('proposal_executions: tenantId is required');
  if (!input.proposalId) throw new Error('proposal_executions: proposalId is required');
  if (!input.executedBy) throw new Error('proposal_executions: executedBy is required');
  if (!['succeeded', 'failed', 'undone'].includes(input.status)) {
    throw new Error(`proposal_executions: invalid status ${input.status}`);
  }
  if (input.status === 'failed' && !input.errorMessage) {
    throw new Error('proposal_executions: errorMessage is required when status=failed');
  }
}

export class InMemoryProposalExecutionRepository implements ProposalExecutionRepository {
  private readonly rows: ProposalExecution[] = [];

  async recordExecution(input: RecordExecutionInput): Promise<ProposalExecution> {
    validateInput(input);

    // Honour the partial unique index on
    // (tenant_id, proposal_id, idempotency_key) WHERE idempotency_key IS NOT NULL.
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      const existing = this.rows.find(
        (r) =>
          r.tenantId === input.tenantId &&
          r.proposalId === input.proposalId &&
          r.idempotencyKey === input.idempotencyKey,
      );
      if (existing) return { ...existing };
    }

    const now = new Date();
    const row: ProposalExecution = {
      id: randomUUID(),
      tenantId: input.tenantId,
      proposalId: input.proposalId,
      executedPayload: { ...input.executedPayload },
      executedBy: input.executedBy,
      executedAt: input.executedAt ?? now,
      status: input.status,
      errorMessage: input.errorMessage,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async findLatestByProposal(
    tenantId: string,
    proposalId: string,
  ): Promise<ProposalExecution | null> {
    const matches = this.rows
      .filter((r) => r.tenantId === tenantId && r.proposalId === proposalId)
      .sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
    return matches.length > 0 ? { ...matches[0] } : null;
  }

  async listByProposal(
    tenantId: string,
    proposalId: string,
  ): Promise<ProposalExecution[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.proposalId === proposalId)
      .sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime())
      .map((r) => ({ ...r }));
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ProposalExecution | null> {
    const matches = this.rows
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.idempotencyKey === idempotencyKey &&
          r.status === 'succeeded',
      )
      .sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
    return matches.length > 0 ? { ...matches[0] } : null;
  }
}
