/**
 * N-004 (P2-037) — supervisor_reviews repository (migration 242).
 *
 * One row per pre-dispatch review. `ai_run_id` FKs the single lightweight-tier
 * LLM run the review made (nullable + ON DELETE SET NULL for deterministic-only
 * reviews). Follows the FORCE-RLS shape of supervisor_policies (migration 167);
 * the PG repo runs every query inside the tenant RLS context.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { ReviewVerdict, SupervisorReview } from './types';

export interface CreateSupervisorReviewInput {
  tenantId: string;
  proposalId: string;
  aiRunId?: string | null;
  model: string;
  verdict: ReviewVerdict;
  critical: boolean;
  checks: Record<string, unknown>;
  flags: string[];
  latencyMs?: number | null;
  shadow: boolean;
}

export interface SupervisorReviewRepository {
  create(input: CreateSupervisorReviewInput): Promise<SupervisorReview>;
  findByProposal(tenantId: string, proposalId: string): Promise<SupervisorReview[]>;
  /**
   * WS6 — reviews created in [from, to), newest first, capped at `limit`.
   * Drives the digest "Checked: N proposals, M flagged" reflection line
   * (see digest/digest-service.ts DIGEST_MAX_REVIEWS). Mirrors
   * ProposalRepository.findConfidenceMarkedForDay's window shape exactly:
   * same Date-range args, same optional-method contract so partial test
   * doubles still satisfy the interface and the digest just omits the
   * section when it's absent.
   */
  findForDay?(tenantId: string, from: Date, to: Date, limit?: number): Promise<SupervisorReview[]>;
}

interface SupervisorReviewRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  ai_run_id: string | null;
  model: string;
  verdict: ReviewVerdict;
  critical: boolean;
  checks: Record<string, unknown>;
  flags: string[];
  latency_ms: number | null;
  shadow: boolean;
  created_at: string | Date;
}

function mapRow(row: SupervisorReviewRow): SupervisorReview {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposalId: row.proposal_id,
    aiRunId: row.ai_run_id,
    model: row.model,
    verdict: row.verdict,
    critical: row.critical,
    checks: row.checks ?? {},
    flags: Array.isArray(row.flags) ? row.flags : [],
    latencyMs: row.latency_ms,
    shadow: row.shadow,
    createdAt: new Date(row.created_at),
  };
}

export class PgSupervisorReviewRepository
  extends PgBaseRepository
  implements SupervisorReviewRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateSupervisorReviewInput): Promise<SupervisorReview> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO supervisor_reviews
           (tenant_id, proposal_id, ai_run_id, model, verdict, critical, checks, flags, latency_ms, shadow)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         RETURNING id, tenant_id, proposal_id, ai_run_id, model, verdict, critical,
                   checks, flags, latency_ms, shadow, created_at`,
        [
          input.tenantId,
          input.proposalId,
          input.aiRunId ?? null,
          input.model,
          input.verdict,
          input.critical,
          JSON.stringify(input.checks ?? {}),
          JSON.stringify(input.flags ?? []),
          input.latencyMs ?? null,
          input.shadow,
        ],
      );
      return mapRow(result.rows[0] as SupervisorReviewRow);
    });
  }

  async findByProposal(tenantId: string, proposalId: string): Promise<SupervisorReview[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, proposal_id, ai_run_id, model, verdict, critical,
                checks, flags, latency_ms, shadow, created_at
           FROM supervisor_reviews
          WHERE tenant_id = $1 AND proposal_id = $2
          ORDER BY created_at DESC`,
        [tenantId, proposalId],
      );
      return result.rows.map((r) => mapRow(r as SupervisorReviewRow));
    });
  }

  async findForDay(tenantId: string, from: Date, to: Date, limit?: number): Promise<SupervisorReview[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, proposal_id, ai_run_id, model, verdict, critical,
                checks, flags, latency_ms, shadow, created_at
           FROM supervisor_reviews
          WHERE tenant_id = $1
            AND created_at >= $2 AND created_at < $3
          ORDER BY created_at DESC
          ${typeof limit === 'number' ? 'LIMIT $4' : ''}`,
        typeof limit === 'number' ? [tenantId, from, to, limit] : [tenantId, from, to],
      );
      return result.rows.map((r) => mapRow(r as SupervisorReviewRow));
    });
  }
}

export class InMemorySupervisorReviewRepository implements SupervisorReviewRepository {
  private rows: SupervisorReview[] = [];
  private nextId = 1;

  async create(input: CreateSupervisorReviewInput): Promise<SupervisorReview> {
    const row: SupervisorReview = {
      id: `sr_${this.nextId++}`,
      tenantId: input.tenantId,
      proposalId: input.proposalId,
      aiRunId: input.aiRunId ?? null,
      model: input.model,
      verdict: input.verdict,
      critical: input.critical,
      checks: input.checks ?? {},
      flags: input.flags ?? [],
      latencyMs: input.latencyMs ?? null,
      shadow: input.shadow,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findByProposal(tenantId: string, proposalId: string): Promise<SupervisorReview[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.proposalId === proposalId)
      .map((r) => ({ ...r }));
  }

  async findForDay(tenantId: string, from: Date, to: Date, limit?: number): Promise<SupervisorReview[]> {
    const rows = this.rows
      .filter((r) => {
        if (r.tenantId !== tenantId) return false;
        const t = r.createdAt.getTime();
        return t >= from.getTime() && t < to.getTime();
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }
}
