/**
 * RV-120 — triage_events repository (migration 166).
 *
 * One row per `evaluateTriage` outcome: the vulnerability score, the urgency
 * tier it was weighed against, the fired signals (NON-PII evidence strings —
 * same discipline as the vulnerability_signals analytics table), and the
 * action the call actually took with the decision (patched owner / urgent
 * booking flagged / normal flow). Post-incident review can audit the matrix
 * per session without replaying the call.
 *
 * All queries carry an explicit `tenant_id = $n` predicate in addition to the
 * RLS GUC set by `withTenant()` — belt and braces, matching the repo-wide
 * convention (see pg-tenant-feature-flags.ts).
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../../db/pg-base';
import type { UrgencyTier, VulnerabilitySignal } from '@ai-service-os/shared';

export interface TriageEventInput {
  tenantId: string;
  voiceSessionId: string;
  /** Matched customer, when the caller was identified. */
  customerId?: string | null;
  /** Aggregate vulnerability score total (numeric, ≥ 0). */
  score: number;
  /** Urgency tier the score was weighed against. */
  tier: UrgencyTier;
  /** Fired signals (kind + NON-PII evidence + weight). */
  signals: ReadonlyArray<VulnerabilitySignal>;
  /** What the call did with the decision (e.g. 'patch_owner', 'normal'). */
  actionTaken?: string;
}

export interface TriageEventRow extends TriageEventInput {
  id: string;
  createdAt: Date;
}

export interface TriageEventRepository {
  record(input: TriageEventInput): Promise<TriageEventRow>;
  /** Tenant-scoped listing for review tooling / tests, newest first. */
  listBySession(tenantId: string, voiceSessionId: string): Promise<TriageEventRow[]>;
}

export class PgTriageEventRepository
  extends PgBaseRepository
  implements TriageEventRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async record(input: TriageEventInput): Promise<TriageEventRow> {
    return this.withTenant(input.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO triage_events
           (tenant_id, voice_session_id, customer_id, score, tier, signals, action_taken)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id, tenant_id, voice_session_id, customer_id, score, tier,
                   signals, action_taken, created_at`,
        [
          input.tenantId,
          input.voiceSessionId,
          input.customerId ?? null,
          input.score,
          input.tier,
          JSON.stringify(input.signals),
          input.actionTaken ?? null,
        ],
      );
      return mapRow(rows[0]);
    });
  }

  async listBySession(
    tenantId: string,
    voiceSessionId: string,
  ): Promise<TriageEventRow[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, voice_session_id, customer_id, score, tier,
                signals, action_taken, created_at
           FROM triage_events
          WHERE tenant_id = $1 AND voice_session_id = $2
          ORDER BY created_at DESC`,
        [tenantId, voiceSessionId],
      );
      return rows.map(mapRow);
    });
  }
}

/** In-memory implementation for unit tests / no-pool dev. */
export class InMemoryTriageEventRepository implements TriageEventRepository {
  public rows: TriageEventRow[] = [];
  private seq = 0;

  async record(input: TriageEventInput): Promise<TriageEventRow> {
    const row: TriageEventRow = {
      ...input,
      customerId: input.customerId ?? null,
      signals: [...input.signals],
      id: `triage_${++this.seq}`,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async listBySession(
    tenantId: string,
    voiceSessionId: string,
  ): Promise<TriageEventRow[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.voiceSessionId === voiceSessionId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }
}

function mapRow(row: Record<string, unknown>): TriageEventRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    voiceSessionId: String(row.voice_session_id),
    customerId: row.customer_id === null ? null : String(row.customer_id),
    score: Number(row.score),
    tier: String(row.tier) as UrgencyTier,
    signals: (Array.isArray(row.signals)
      ? row.signals
      : JSON.parse(String(row.signals ?? '[]'))) as VulnerabilitySignal[],
    actionTaken: (row.action_taken as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string),
  };
}
