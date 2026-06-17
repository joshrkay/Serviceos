/**
 * Onboarding session repository.
 *
 * Persistence layer for the conversational FSM at
 * `src/ai/agents/onboarding/`. One row per onboarding session per
 * tenant; the row holds the full transcript, FSM state, pending
 * clarifications, and accumulating extraction context so a
 * conversation resumes after a browser close.
 *
 * RLS: migration 195 enables + forces RLS with a tenant_isolation
 * policy; PgBaseRepository.withTenant sets `app.current_tenant_id`
 * GUC. No direct cross-tenant reads possible.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from './pg-base';
import type {
  OnboardingState,
  TranscriptTurn,
  ExtractionState,
} from '../ai/agents/onboarding/types';
import type { OnboardingExtraction } from '../ai/tasks/onboarding/types';

export interface OnboardingSession {
  id: string;
  tenantId: string;
  fsmState: OnboardingState;
  transcriptTurns: TranscriptTurn[];
  pendingClarifications: string[];
  clarificationCountByState: Partial<Record<ExtractionState, number>>;
  extractions: Partial<OnboardingExtraction>;
  turnCount: number;
  proposalBatchIds: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface OnboardingSessionRepository {
  create(tenantId: string): Promise<OnboardingSession>;
  findById(tenantId: string, id: string): Promise<OnboardingSession | null>;
  update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<OnboardingSession, 'id' | 'tenantId' | 'createdAt'>>,
  ): Promise<OnboardingSession | null>;
}

// ─── In-memory implementation ───────────────────────────────────────────────

export class InMemoryOnboardingSessionRepository implements OnboardingSessionRepository {
  private sessions = new Map<string, OnboardingSession>();

  async create(tenantId: string): Promise<OnboardingSession> {
    const now = new Date();
    const session: OnboardingSession = {
      id: uuidv4(),
      tenantId,
      fsmState: 'profile_capture',
      transcriptTurns: [],
      pendingClarifications: [],
      clarificationCountByState: {},
      extractions: {},
      turnCount: 0,
      proposalBatchIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, { ...session });
    return { ...session };
  }

  async findById(tenantId: string, id: string): Promise<OnboardingSession | null> {
    const s = this.sessions.get(id);
    if (!s || s.tenantId !== tenantId) return null;
    return { ...s };
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<OnboardingSession, 'id' | 'tenantId' | 'createdAt'>>,
  ): Promise<OnboardingSession | null> {
    const s = this.sessions.get(id);
    if (!s || s.tenantId !== tenantId) return null;
    const updated: OnboardingSession = { ...s, ...updates, updatedAt: new Date() };
    this.sessions.set(id, updated);
    return { ...updated };
  }
}

// ─── Postgres implementation ────────────────────────────────────────────────

interface OnboardingSessionRow {
  id: string;
  tenant_id: string;
  fsm_state: string;
  transcript_turns: TranscriptTurn[] | null;
  pending_clarifications: string[] | null;
  clarification_count_by_state: Partial<Record<ExtractionState, number>> | null;
  extraction_state: Partial<OnboardingExtraction> | null;
  turn_count: number;
  proposal_batch_ids: string[] | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapRow(row: OnboardingSessionRow): OnboardingSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fsmState: row.fsm_state as OnboardingState,
    transcriptTurns: row.transcript_turns ?? [],
    pendingClarifications: row.pending_clarifications ?? [],
    clarificationCountByState: row.clarification_count_by_state ?? {},
    extractions: row.extraction_state ?? {},
    turnCount: row.turn_count,
    proposalBatchIds: row.proposal_batch_ids ?? [],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
  };
}

export class PgOnboardingSessionRepository
  extends PgBaseRepository
  implements OnboardingSessionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(tenantId: string): Promise<OnboardingSession> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO onboarding_session (tenant_id)
         VALUES ($1)
         RETURNING *`,
        [tenantId],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<OnboardingSession | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(`SELECT * FROM onboarding_session WHERE id = $1`, [id]);
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<Omit<OnboardingSession, 'id' | 'tenantId' | 'createdAt'>>,
  ): Promise<OnboardingSession | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        fsmState: 'fsm_state',
        transcriptTurns: 'transcript_turns',
        pendingClarifications: 'pending_clarifications',
        clarificationCountByState: 'clarification_count_by_state',
        extractions: 'extraction_state',
        turnCount: 'turn_count',
        proposalBatchIds: 'proposal_batch_ids',
        completedAt: 'completed_at',
      };
      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;
      for (const [key, value] of Object.entries(updates)) {
        const column = fieldMap[key];
        if (!column) continue;
        // JSONB columns need a JSON.stringify; TIMESTAMPTZ and TEXT pass through.
        const isJsonb =
          column === 'transcript_turns' ||
          column === 'pending_clarifications' ||
          column === 'clarification_count_by_state' ||
          column === 'extraction_state' ||
          column === 'proposal_batch_ids';
        setClauses.push(`${column} = $${paramIndex}${isJsonb ? '::jsonb' : ''}`);
        params.push(isJsonb ? JSON.stringify(value ?? null) : (value ?? null));
        paramIndex++;
      }
      setClauses.push(`updated_at = NOW()`);
      if (setClauses.length === 1) {
        // Only updated_at; no-op early-exit.
        return this.findById(tenantId, id);
      }
      params.push(id);
      const result = await client.query(
        `UPDATE onboarding_session
            SET ${setClauses.join(', ')}
          WHERE id = $${paramIndex}
          RETURNING *`,
        params,
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
