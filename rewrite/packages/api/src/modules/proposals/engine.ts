import { z } from 'zod';
import type { ProposalResponse } from '@rivet/contracts';
import {
  PROPOSAL_SOURCES,
  PROPOSAL_TYPES,
  proposalPayloadSchemas,
} from '@rivet/contracts';
import { CommandError, defineCommand } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';

interface ProposalRow {
  id: string;
  type: ProposalResponse['type'];
  status: ProposalResponse['status'];
  source: ProposalResponse['source'];
  short_code: number;
  summary: string;
  payload: Record<string, unknown>;
  confidence_bps: number | null;
  undo_deadline_at: Date | null;
  error: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export function toProposalResponse(row: ProposalRow): ProposalResponse {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    source: row.source,
    shortCode: row.short_code,
    summary: row.summary,
    payload: row.payload,
    confidenceBps: row.confidence_bps,
    undoDeadlineAt: row.undo_deadline_at ? row.undo_deadline_at.toISOString() : null,
    error: row.error,
    result: row.result,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const PROPOSAL_COLUMNS = `id, type, status, source, short_code, summary, payload,
  confidence_bps, undo_deadline_at, error, result, created_at, updated_at`;

export const createProposalCommand = defineCommand({
  name: 'proposals.create',
  input: z.object({
    type: z.enum(PROPOSAL_TYPES),
    source: z.enum(PROPOSAL_SOURCES),
    payload: z.record(z.unknown()),
    summary: z.string().min(1).max(500),
    confidenceBps: z.number().int().min(0).max(10_000).optional(),
    idempotencyKey: z.string().max(200).optional(),
  }),
  async run(ctx, input): Promise<ProposalResponse> {
    // The payload gate: AI output must satisfy the typed contract before a
    // proposal can exist.
    const payloadSchema = proposalPayloadSchemas[input.type];
    const payload = payloadSchema.parse(input.payload);

    if (input.idempotencyKey) {
      const existing = await ctx.client.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE tenant_id = $1 AND idempotency_key = $2`,
        [ctx.tenantId, input.idempotencyKey],
      );
      if (existing.rows[0]) return toProposalResponse(existing.rows[0]);
    }

    const { rows } = await ctx.client.query<ProposalRow>(
      `INSERT INTO proposals (tenant_id, type, source, short_code, summary, payload,
                              confidence_bps, correlation_id, idempotency_key)
       VALUES ($1, $2, $3,
               (SELECT COALESCE(MAX(short_code), 0) + 1 FROM proposals WHERE tenant_id = $1),
               $4, $5, $6, $7, $8)
       RETURNING ${PROPOSAL_COLUMNS}`,
      [
        ctx.tenantId,
        input.type,
        input.source,
        input.summary,
        JSON.stringify(payload),
        input.confidenceBps ?? null,
        ctx.correlationId,
        input.idempotencyKey ?? null,
      ],
    );
    const proposal = toProposalResponse(rows[0]!);
    ctx.emit({
      eventType: 'proposal.created',
      entityType: 'proposal',
      entityId: proposal.id,
      payload: { type: proposal.type, source: proposal.source, shortCode: proposal.shortCode },
    });
    ctx.enqueue({
      topic: 'comms.proposal-notify',
      payload: { proposalId: proposal.id },
      dedupeKey: `proposal-notify:${proposal.id}`,
    });
    return proposal;
  },
});

export function makeApproveProposalCommand(undoWindowSeconds: number) {
  return defineCommand({
    name: 'proposals.approve',
    input: z.object({
      proposalId: z.string().uuid().optional(),
      shortCode: z.number().int().optional(),
    }),
    async run(ctx, input): Promise<ProposalResponse> {
      if (!input.proposalId && input.shortCode === undefined) {
        throw new CommandError('invalid', 'proposalId or shortCode required');
      }
      const { rows } = await ctx.client.query<ProposalRow>(
        `UPDATE proposals SET
           status = 'approved',
           approved_by = $4,
           approved_at = now(),
           undo_deadline_at = now() + make_interval(secs => $3),
           updated_at = now()
         WHERE tenant_id = $1
           AND (id = $2::uuid OR ($2::uuid IS NULL AND short_code = $5))
           AND status = 'ready_for_review'
         RETURNING ${PROPOSAL_COLUMNS}`,
        [
          ctx.tenantId,
          input.proposalId ?? null,
          undoWindowSeconds,
          ctx.actor.type === 'user' ? ctx.actor.id : null,
          input.shortCode ?? null,
        ],
      );
      const row = rows[0];
      if (!row) throw new CommandError('conflict', 'proposal not found or not awaiting review');
      ctx.emit({
        eventType: 'proposal.approved',
        entityType: 'proposal',
        entityId: row.id,
        payload: { undoWindowSeconds },
      });
      ctx.enqueue({
        topic: 'proposals.execute',
        payload: { proposalId: row.id },
        dedupeKey: `proposal-execute:${row.id}`,
        notBefore: row.undo_deadline_at ?? undefined,
      });
      return toProposalResponse(row);
    },
  });
}

export const rejectProposalCommand = defineCommand({
  name: 'proposals.reject',
  input: z.object({
    proposalId: z.string().uuid().optional(),
    shortCode: z.number().int().optional(),
    reason: z.string().max(500).optional(),
  }),
  async run(ctx, input): Promise<ProposalResponse> {
    if (!input.proposalId && input.shortCode === undefined) {
      throw new CommandError('invalid', 'proposalId or shortCode required');
    }
    const { rows } = await ctx.client.query<ProposalRow>(
      `UPDATE proposals SET status = 'rejected', updated_at = now()
       WHERE tenant_id = $1
         AND (id = $2::uuid OR ($2::uuid IS NULL AND short_code = $3))
         AND status = 'ready_for_review'
       RETURNING ${PROPOSAL_COLUMNS}`,
      [ctx.tenantId, input.proposalId ?? null, input.shortCode ?? null],
    );
    const row = rows[0];
    if (!row) throw new CommandError('conflict', 'proposal not found or not awaiting review');
    ctx.emit({
      eventType: 'proposal.rejected',
      entityType: 'proposal',
      entityId: row.id,
      payload: { reason: input.reason ?? null },
    });
    return toProposalResponse(row);
  },
});

/** Undo is only possible between approval and the undo deadline. */
export const undoProposalCommand = defineCommand({
  name: 'proposals.undo',
  input: z.object({ proposalId: z.string().uuid() }),
  async run(ctx, input): Promise<ProposalResponse> {
    const { rows } = await ctx.client.query<ProposalRow>(
      `UPDATE proposals SET status = 'undone', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'approved' AND undo_deadline_at > now()
       RETURNING ${PROPOSAL_COLUMNS}`,
      [ctx.tenantId, input.proposalId],
    );
    const row = rows[0];
    if (!row) throw new CommandError('conflict', 'undo window has passed or proposal is not approved');
    ctx.emit({ eventType: 'proposal.undone', entityType: 'proposal', entityId: row.id });
    return toProposalResponse(row);
  },
});

/**
 * Atomic claim for execution: only one worker can move approved -> executing,
 * and only after the undo deadline. Returns null when the job is a duplicate
 * delivery or the proposal was undone — executor treats that as a no-op.
 */
export const claimProposalForExecutionCommand = defineCommand({
  name: 'proposals.claim_for_execution',
  input: z.object({ proposalId: z.string().uuid() }),
  async run(ctx, input): Promise<ProposalResponse | null> {
    const { rows } = await ctx.client.query<ProposalRow>(
      `UPDATE proposals SET status = 'executing', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'approved' AND undo_deadline_at <= now()
       RETURNING ${PROPOSAL_COLUMNS}`,
      [ctx.tenantId, input.proposalId],
    );
    return rows[0] ? toProposalResponse(rows[0]) : null;
  },
});

export const completeProposalCommand = defineCommand({
  name: 'proposals.complete',
  input: z.object({
    proposalId: z.string().uuid(),
    result: z.record(z.unknown()),
  }),
  async run(ctx, input): Promise<void> {
    await ctx.client.query(
      `UPDATE proposals SET status = 'executed', executed_at = now(), result = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'executing'`,
      [ctx.tenantId, input.proposalId, JSON.stringify(input.result)],
    );
    ctx.emit({
      eventType: 'proposal.executed',
      entityType: 'proposal',
      entityId: input.proposalId,
      payload: input.result,
    });
  },
});

export const failProposalCommand = defineCommand({
  name: 'proposals.fail',
  input: z.object({
    proposalId: z.string().uuid(),
    error: z.string().max(2000),
  }),
  async run(ctx, input): Promise<void> {
    await ctx.client.query(
      `UPDATE proposals SET status = 'execution_failed', error = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'executing'`,
      [ctx.tenantId, input.proposalId, input.error],
    );
    ctx.emit({
      eventType: 'proposal.execution_failed',
      entityType: 'proposal',
      entityId: input.proposalId,
      payload: { error: input.error },
    });
  },
});

export async function listProposals(
  db: Db,
  tenantId: string,
  status?: string,
): Promise<ProposalResponse[]> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals
       WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT 100`,
      [tenantId, status ?? null],
    );
    return rows.map(toProposalResponse);
  });
}
