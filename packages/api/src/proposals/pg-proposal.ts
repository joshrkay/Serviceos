import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { ConflictError } from '../shared/errors';
import { PgBaseRepository } from '../db/pg-base';
import { Proposal, ProposalRepository, ProposalStatus, ProposalType } from './proposal';

function mapRow(row: Record<string, unknown>): Proposal {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    proposalType: row.proposal_type as Proposal['proposalType'],
    status: row.status as ProposalStatus,
    payload: row.payload as Record<string, unknown>,
    summary: row.summary as string,
    explanation: (row.explanation as string) ?? undefined,
    confidenceScore: row.confidence_score != null ? Number(row.confidence_score) : undefined,
    confidenceFactors: (row.confidence_factors as string[]) ?? undefined,
    sourceContext: (row.source_context as Record<string, unknown>) ?? undefined,
    aiRunId: (row.ai_run_id as string) ?? undefined,
    executionError: (row.execution_error as string) ?? undefined,
    promptVersionId: (row.prompt_version_id as string) ?? undefined,
    targetEntityType: (row.target_entity_type as string) ?? undefined,
    targetEntityId: (row.target_entity_id as string) ?? undefined,
    resultEntityId: (row.result_entity_id as string) ?? undefined,
    rejectionReason: (row.rejection_reason as string) ?? undefined,
    rejectionDetails: (row.rejection_details as string) ?? undefined,
    idempotencyKey: (row.idempotency_key as string) ?? undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
    approvedAt: row.approved_at ? new Date(row.approved_at as string) : undefined,
    executedAt: row.executed_at ? new Date(row.executed_at as string) : undefined,
    executedBy: (row.executed_by as string) ?? undefined,
    claimedBy: (row.claimed_by as string) ?? undefined,
    claimedAt: row.claimed_at ? new Date(row.claimed_at as string) : undefined,
    executionRetryCount:
      row.execution_retry_count != null ? Number(row.execution_retry_count) : undefined,
    undoneAt: row.undone_at ? new Date(row.undone_at as string) : undefined,
    undoneBy: (row.undone_by as string) ?? undefined,
    chainId: (row.chain_id as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgProposalRepository extends PgBaseRepository implements ProposalRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  /**
   * Insert one proposal on an existing client. Shared by `create` and
   * `createMany` so the SQL lives in one place and `createMany` can run
   * several inserts inside a single transaction.
   */
  private async insertOne(client: PoolClient, proposal: Proposal): Promise<Proposal> {
    // Idempotency is enforced by the unique index
    // idx_proposals_idempotency(tenant_id, idempotency_key). Using
    // ON CONFLICT DO NOTHING avoids the check-then-insert race where
    // two concurrent transactions would both pass a SELECT check,
    // then one INSERT would throw a raw duplicate-key error (SQLSTATE
    // 23505) that surfaces as a 500 instead of a 409 ConflictError.
    const conflictClause = proposal.idempotencyKey
      ? 'ON CONFLICT (tenant_id, idempotency_key) DO NOTHING'
      : '';

    const status: ProposalStatus = proposal.status ?? 'draft';
    const createdAt = proposal.createdAt ?? new Date();
    const updatedAt = proposal.updatedAt ?? createdAt;

    const result = await client.query(
      `INSERT INTO proposals (
        id, tenant_id, proposal_type, status, payload, summary, explanation,
        confidence_score, confidence_factors, source_context, ai_run_id, prompt_version_id,
        target_entity_type, target_entity_id, result_entity_id,
        rejection_reason, rejection_details, idempotency_key, expires_at,
        approved_at, executed_at, executed_by, undone_at, undone_by,
        chain_id,
        created_by, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, $22, $23, $24,
        $25,
        $26, $27, $28
      ) ${conflictClause} RETURNING *`,
      [
        proposal.id ?? uuidv4(),
        proposal.tenantId,
        proposal.proposalType,
        status,
        JSON.stringify(proposal.payload),
        proposal.summary,
        proposal.explanation ?? null,
        proposal.confidenceScore ?? null,
        proposal.confidenceFactors ? JSON.stringify(proposal.confidenceFactors) : null,
        proposal.sourceContext ? JSON.stringify(proposal.sourceContext) : null,
        proposal.aiRunId ?? null,
        proposal.promptVersionId ?? null,
        proposal.targetEntityType ?? null,
        proposal.targetEntityId ?? null,
        proposal.resultEntityId ?? null,
        proposal.rejectionReason ?? null,
        proposal.rejectionDetails ?? null,
        proposal.idempotencyKey ?? null,
        proposal.expiresAt ?? null,
        proposal.approvedAt ?? null,
        proposal.executedAt ?? null,
        proposal.executedBy ?? null,
        proposal.undoneAt ?? null,
        proposal.undoneBy ?? null,
        proposal.chainId ?? null,
        proposal.createdBy,
        createdAt,
        updatedAt,
      ]
    );
    if (result.rows.length === 0) {
      // ON CONFLICT DO NOTHING returned no row — another transaction
      // committed an insert with the same (tenant_id, idempotency_key)
      // while we were racing. Surface as ConflictError → 409.
      throw new ConflictError(
        `Proposal with idempotency key '${proposal.idempotencyKey}' already exists for this tenant`
      );
    }
    return mapRow(result.rows[0]);
  }

  async create(proposal: Proposal): Promise<Proposal> {
    return this.withTenantTransaction(proposal.tenantId, async (client) =>
      this.insertOne(client, proposal),
    );
  }

  async createMany(proposals: Proposal[]): Promise<Proposal[]> {
    if (proposals.length === 0) return [];
    // All members share a tenant (enforced by the caller); a single
    // withTenantTransaction wraps every insert so a failure on any
    // member rolls back the whole batch — no orphaned chain records.
    const tenantId = proposals[0].tenantId;
    return this.withTenantTransaction(tenantId, async (client) => {
      const created: Proposal[] = [];
      for (const proposal of proposals) {
        created.push(await this.insertOne(client, proposal));
      }
      return created;
    });
  }

  async findById(tenantId: string, id: string): Promise<Proposal | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM proposals WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM proposals WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByStatus(tenantId: string, status: ProposalStatus): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM proposals WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC',
        [tenantId, status]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByStatusSince(
    tenantId: string,
    status: ProposalStatus,
    since: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposals
           WHERE tenant_id = $1 AND status = $2 AND created_at >= $3
           ORDER BY created_at DESC
           ${typeof limit === 'number' ? 'LIMIT $4' : ''}`,
        typeof limit === 'number' ? [tenantId, status, since, limit] : [tenantId, status, since]
      );
      return result.rows.map(mapRow);
    });
  }

  async findConfidenceMarkedForDay(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposals
           WHERE tenant_id = $1
             AND created_at >= $2 AND created_at < $3
             AND payload->'_meta'->>'overallConfidence' IN ('low','very_low')
           ORDER BY created_at DESC
           ${typeof limit === 'number' ? 'LIMIT $4' : ''}`,
        typeof limit === 'number' ? [tenantId, from, to, limit] : [tenantId, from, to],
      );
      return result.rows.map(mapRow);
    });
  }

  async findAutonomousLaneApprovedForDay(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposals
           WHERE tenant_id = $1
             AND created_at >= $2 AND created_at < $3
             AND source_context->'autonomousLaneEvaluation'->>'eligible' = 'true'
           ORDER BY created_at DESC
           ${typeof limit === 'number' ? 'LIMIT $4' : ''}`,
        typeof limit === 'number' ? [tenantId, from, to, limit] : [tenantId, from, to],
      );
      return result.rows.map(mapRow);
    });
  }

  async findAppliedInstructionsForDay(
    tenantId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposals
           WHERE tenant_id = $1
             AND created_at >= $2 AND created_at < $3
             AND payload->'_meta' ? 'appliedStandingInstructions'
             AND jsonb_array_length(payload->'_meta'->'appliedStandingInstructions') > 0
           ORDER BY created_at DESC
           ${typeof limit === 'number' ? 'LIMIT $4' : ''}`,
        typeof limit === 'number' ? [tenantId, from, to, limit] : [tenantId, from, to],
      );
      return result.rows.map(mapRow);
    });
  }

  async findExpiredScheduleProposals(
    tenantId: string,
    proposalTypes: readonly ProposalType[],
    since: Date,
    limit: number,
  ): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposals
           WHERE tenant_id = $1
             AND status = 'expired'
             AND proposal_type = ANY($2::text[])
             AND expires_at >= $3
           ORDER BY expires_at DESC
           LIMIT $4`,
        [tenantId, proposalTypes as readonly string[], since, limit]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByAiRun(tenantId: string, aiRunId: string): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM proposals WHERE tenant_id = $1 AND ai_run_id = $2 ORDER BY created_at DESC',
        [tenantId, aiRunId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT *
           FROM proposals
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [tenantId, idempotencyKey],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByRecordingId(
    tenantId: string,
    recordingId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null> {
    return this.withTenant(tenantId, async (client) => {
      // Indexed dedup lookup: the idempotency_key branch uses the unique index
      // idx_proposals_idempotency(tenant_id, idempotency_key); the recordingId
      // branch uses idx_proposals_source_recording(tenant_id,
      // (source_context->>'recordingId')). Postgres BitmapOrs the two — no
      // tenant-wide scan. LIMIT 1: we only need to know one already exists.
      const result = await client.query(
        `SELECT * FROM proposals
         WHERE tenant_id = $1
           AND (idempotency_key = $2 OR source_context->>'recordingId' = $3)
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, idempotencyKey, recordingId]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByChain(tenantId: string, chainId: string): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposals
         WHERE tenant_id = $1 AND chain_id = $2
         ORDER BY (source_context->>'chainIndex')::int ASC NULLS LAST, created_at ASC`,
        [tenantId, chainId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByConversation(tenantId: string, conversationId: string): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      // Filter in SQL on source_context->>'conversationId' (same JSONB-extraction
      // pattern as findByRecordingId) so we never pull a tenant-wide proposal set
      // into app memory to count per-conversation state. Tenant-scoped by RLS +
      // the explicit tenant_id predicate.
      const result = await client.query(
        `SELECT * FROM proposals
         WHERE tenant_id = $1 AND source_context->>'conversationId' = $2
         ORDER BY created_at ASC`,
        [tenantId, conversationId]
      );
      return result.rows.map(mapRow);
    });
  }

  async findByCorrectionTarget(
    tenantId: string,
    proposalType: ProposalType,
    target: { kind: string; key: string },
    statuses?: readonly ProposalStatus[],
  ): Promise<Proposal[]> {
    return this.withTenant(tenantId, async (client) => {
      // JSONB-extract the WS20 correction-target stamp
      // (source_context.correctionTarget = { kind, key }); filter in SQL so a
      // tenant-wide proposal set is never pulled into memory. Optional status
      // filter via ANY($5). Tenant-scoped by RLS + the explicit predicate.
      const params: unknown[] = [tenantId, proposalType, target.kind, target.key];
      let statusClause = '';
      if (statuses && statuses.length > 0) {
        params.push([...statuses]);
        statusClause = ` AND status = ANY($5)`;
      }
      const result = await client.query(
        `SELECT * FROM proposals
         WHERE tenant_id = $1
           AND proposal_type = $2
           AND source_context->'correctionTarget'->>'kind' = $3
           AND source_context->'correctionTarget'->>'key' = $4${statusClause}
         ORDER BY created_at DESC`,
        params
      );
      return result.rows.map(mapRow);
    });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: ProposalStatus,
    updates?: Partial<
      Pick<
        Proposal,
        | 'rejectionReason'
        | 'rejectionDetails'
        | 'resultEntityId'
        | 'approvedAt'
        | 'executedAt'
        | 'executedBy'
        | 'executionError'
        | 'undoneAt'
        | 'undoneBy'
      >
    >
  ): Promise<Proposal | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const lock = await client.query(
        'SELECT id FROM proposals WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [tenantId, id]
      );
      if (lock.rows.length === 0) return null;

      const setClauses = ['status = $3', 'updated_at = NOW()'];
      const params: unknown[] = [tenantId, id, status];
      let p = 4;

      if (updates?.rejectionReason !== undefined) { setClauses.push(`rejection_reason = $${p++}`); params.push(updates.rejectionReason); }
      if (updates?.rejectionDetails !== undefined) { setClauses.push(`rejection_details = $${p++}`); params.push(updates.rejectionDetails); }
      if (updates?.resultEntityId !== undefined)   { setClauses.push(`result_entity_id = $${p++}`); params.push(updates.resultEntityId); }
      if (updates?.approvedAt !== undefined)        { setClauses.push(`approved_at = $${p++}`);      params.push(updates.approvedAt); }
      if (updates?.executedAt !== undefined)        { setClauses.push(`executed_at = $${p++}`);      params.push(updates.executedAt); }
      if (updates?.executedBy !== undefined)        { setClauses.push(`executed_by = $${p++}`);      params.push(updates.executedBy); }
      if (updates?.executionError !== undefined)    { setClauses.push(`execution_error = $${p++}`);  params.push(updates.executionError); }
      if (updates?.undoneAt !== undefined)          { setClauses.push(`undone_at = $${p++}`);        params.push(updates.undoneAt); }
      if (updates?.undoneBy !== undefined)          { setClauses.push(`undone_by = $${p++}`);        params.push(updates.undoneBy); }

      const result = await client.query(
        `UPDATE proposals SET ${setClauses.join(', ')}
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<Proposal, 'id' | 'tenantId' | 'createdBy' | 'createdAt'>>
  ): Promise<Proposal | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // Status transitions MUST go through updateStatus() which uses
      // SELECT ... FOR UPDATE. Excluded here so the generic path can't
      // race against concurrent status changes.
      const fieldMap: Record<string, string> = {
        proposalType: 'proposal_type',
        payload: 'payload',
        summary: 'summary',
        explanation: 'explanation',
        confidenceScore: 'confidence_score',
        confidenceFactors: 'confidence_factors',
        sourceContext: 'source_context',
        aiRunId: 'ai_run_id',
        promptVersionId: 'prompt_version_id',
        targetEntityType: 'target_entity_type',
        targetEntityId: 'target_entity_id',
        resultEntityId: 'result_entity_id',
        rejectionReason: 'rejection_reason',
        rejectionDetails: 'rejection_details',
        idempotencyKey: 'idempotency_key',
        expiresAt: 'expires_at',
        approvedAt: 'approved_at',
        executedAt: 'executed_at',
        executedBy: 'executed_by',
        undoneAt: 'undone_at',
        undoneBy: 'undone_by',
        // WS18 (D-018) — the live close flow retrofits an EXISTING drafted
        // estimate proposal as the head of the close chain, so the indexed
        // chain_id column must be writable post-create (findByChain queries
        // the column, not sourceContext).
        chainId: 'chain_id',
      };

      const setClauses: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [tenantId, id];
      let p = 3;

      for (const [key, column] of Object.entries(fieldMap)) {
        if (key in updates) {
          const val = (updates as Record<string, unknown>)[key];
          const serialized =
            key === 'payload' || key === 'confidenceFactors' || key === 'sourceContext'
              ? val != null ? JSON.stringify(val) : null
              : val ?? null;
          setClauses.push(`${column} = $${p++}`);
          params.push(serialized);
        }
      }

      if (setClauses.length === 1) return this.findById(tenantId, id);

      const result = await client.query(
        `UPDATE proposals SET ${setClauses.join(', ')}
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findReadyForExecution(windowMs: number): Promise<Proposal[]> {
    // Intentional cross-tenant sweep — withCrossTenantSweep() runs it under the
    // named, auditable rls_cross_tenant role when enforcement is on. withTenant()
    // would arm RLS and silently filter to a single tenant, causing the
    // auto-delivery worker to miss proposals from all others.
    return this.withCrossTenantSweep(async (client) => {
      const result = await client.query(
        `SELECT * FROM proposals
         WHERE status = 'approved'
           AND (
             approved_at IS NULL
             OR approved_at <= NOW() - ($1 || ' milliseconds')::INTERVAL
           )
         ORDER BY approved_at ASC NULLS FIRST`,
        [windowMs]
      );
      return result.rows.map(mapRow);
    });
  }

  async claimForExecution(proposalId: string, workerId: string): Promise<Proposal | null> {
    return this.withCrossTenantSweep(async (client) => {
      const result = await client.query(
        `UPDATE proposals
         SET status = 'executing', claimed_by = $2, claimed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'approved'
         RETURNING *`,
        [proposalId, workerId]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async resetStaleExecuting(
    staleMinutes: number,
    maxRetries: number
  ): Promise<{ resetToApproved: number; movedToFailed: number }> {
    return this.withCrossTenantSweep(async (client) => {
      const failed = await client.query(
        `UPDATE proposals
         SET status = 'execution_failed', updated_at = NOW()
         WHERE status = 'executing'
           AND claimed_at < NOW() - ($1 || ' minutes')::INTERVAL
           AND execution_retry_count >= $2`,
        [staleMinutes, maxRetries]
      );
      const reset = await client.query(
        `UPDATE proposals
         SET status = 'approved',
             claimed_by = NULL,
             claimed_at = NULL,
             execution_retry_count = execution_retry_count + 1,
             updated_at = NOW()
         WHERE status = 'executing'
           AND claimed_at < NOW() - ($1 || ' minutes')::INTERVAL
           AND execution_retry_count < $2`,
        [staleMinutes, maxRetries]
      );
      return { resetToApproved: reset.rowCount ?? 0, movedToFailed: failed.rowCount ?? 0 };
    });
  }
}
