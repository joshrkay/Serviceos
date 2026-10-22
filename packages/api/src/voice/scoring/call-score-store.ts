/**
 * #1736 — call-score store seam: scores (migration 338), the per-tenant
 * opt-in flag (`tenant_settings.call_scoring_enabled`, default OFF) and the
 * owner's corrections (migration 339).
 *
 * The transcript itself is NOT read here — the scorer loads it through
 * #1602's `VoiceSessionGradeStore.loadSession`, which already applies the
 * consent gate (recording disclosure played, not revoked), the billable rule
 * and the stored-transcript read. This store only answers "which eligible
 * calls have no score yet" (same eligibility predicate as #1602's sampler) and
 * persists what the scorer and the owner produce.
 */
import type { CallScore } from './call-score';

export const CORRECTION_KINDS = [
  'should_have_booked',
  'should_have_escalated',
  'should_not_have_escalated',
  'wrong_price',
  'other',
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export interface CallCorrection {
  id: string;
  tenantId: string;
  sessionId: string;
  kind: CorrectionKind;
  /** 0-based CALLER turn the owner pointed at; null = the call as a whole. */
  turnIndex: number | null;
  /** Owner-authored, <= 500 chars. */
  note: string;
  createdBy: string;
  createdAt: Date;
  /** Set once an operator exported it into the voice-quality corpus. */
  exportedAt: Date | null;
  corpusScriptId: string | null;
}

export interface CatalogPrice {
  name: string;
  unitPriceCents: number;
}

export interface UnscoredWindow {
  endedSince: Date;
  endedBefore: Date;
  limit: number;
}

export interface CallScoreStore {
  isEnabled(tenantId: string): Promise<boolean>;
  setEnabled(tenantId: string, enabled: boolean): Promise<void>;
  /** The tenant's live (non-archived) catalog, bounded — the price-grounding reference. */
  listCatalogPrices(tenantId: string, limit: number): Promise<CatalogPrice[]>;
  /** Eligible (ended, inbound, disclosed, billable, non-empty) calls with no score yet, newest first. */
  listUnscoredCandidates(tenantId: string, window: UnscoredWindow): Promise<string[]>;
  findScore(tenantId: string, sessionId: string): Promise<CallScore | null>;
  /** Upsert on (tenant, session): a re-score replaces the earlier one. */
  saveScore(score: CallScore): Promise<void>;
  /** Newest call first. */
  listScores(tenantId: string, limit: number): Promise<CallScore[]>;
  /** Upsert on (tenant, session): replaces the earlier correction and re-queues it for export. */
  saveCorrection(correction: CallCorrection): Promise<CallCorrection>;
  findCorrection(tenantId: string, sessionId: string): Promise<CallCorrection | null>;
  /** Corrections for the given calls (the review list marks which are already corrected). */
  listCorrectionsForSessions(tenantId: string, sessionIds: readonly string[]): Promise<CallCorrection[]>;
  /** Not yet exported, oldest first — what the export CLI drains. */
  listPendingExport(tenantId: string): Promise<CallCorrection[]>;
  markExported(tenantId: string, correctionId: string, corpusScriptId: string, at: Date): Promise<void>;
}

/** In-memory store for unit tests and in-memory dev boots. */
export class InMemoryCallScoreStore implements CallScoreStore {
  private readonly enabled = new Set<string>();
  private readonly scores = new Map<string, CallScore>();
  private readonly corrections = new Map<string, CallCorrection>();
  private readonly catalogs = new Map<string, CatalogPrice[]>();
  private readonly eligible = new Map<string, Array<{ sessionId: string; endedAt: Date }>>();

  seedCatalog(tenantId: string, prices: CatalogPrice[]): void {
    this.catalogs.set(tenantId, prices);
  }

  seedEligibleCall(tenantId: string, sessionId: string, endedAt: Date): void {
    this.eligible.set(tenantId, [...(this.eligible.get(tenantId) ?? []), { sessionId, endedAt }]);
  }

  async isEnabled(tenantId: string): Promise<boolean> {
    return this.enabled.has(tenantId);
  }

  async setEnabled(tenantId: string, enabled: boolean): Promise<void> {
    if (enabled) this.enabled.add(tenantId);
    else this.enabled.delete(tenantId);
  }

  async listCatalogPrices(tenantId: string, limit: number): Promise<CatalogPrice[]> {
    return (this.catalogs.get(tenantId) ?? []).slice(0, limit);
  }

  async listUnscoredCandidates(tenantId: string, w: UnscoredWindow): Promise<string[]> {
    return (this.eligible.get(tenantId) ?? [])
      .filter((c) => c.endedAt >= w.endedSince && c.endedAt < w.endedBefore)
      .filter((c) => !this.scores.has(key(tenantId, c.sessionId)))
      .sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime())
      .slice(0, w.limit)
      .map((c) => c.sessionId);
  }

  async findScore(tenantId: string, sessionId: string): Promise<CallScore | null> {
    return this.scores.get(key(tenantId, sessionId)) ?? null;
  }

  async saveScore(score: CallScore): Promise<void> {
    this.scores.set(key(score.tenantId, score.sessionId), { ...score });
  }

  async listScores(tenantId: string, limit: number): Promise<CallScore[]> {
    return [...this.scores.values()]
      .filter((s) => s.tenantId === tenantId)
      .sort((a, b) => b.callEndedAt.getTime() - a.callEndedAt.getTime())
      .slice(0, limit);
  }

  async saveCorrection(correction: CallCorrection): Promise<CallCorrection> {
    const existing = this.corrections.get(key(correction.tenantId, correction.sessionId));
    const saved: CallCorrection = {
      ...correction,
      id: existing?.id ?? correction.id,
      exportedAt: null,
      corpusScriptId: null,
    };
    this.corrections.set(key(saved.tenantId, saved.sessionId), saved);
    return saved;
  }

  async findCorrection(tenantId: string, sessionId: string): Promise<CallCorrection | null> {
    return this.corrections.get(key(tenantId, sessionId)) ?? null;
  }

  async listCorrectionsForSessions(
    tenantId: string,
    sessionIds: readonly string[],
  ): Promise<CallCorrection[]> {
    return sessionIds
      .map((id) => this.corrections.get(key(tenantId, id)))
      .filter((c): c is CallCorrection => c !== undefined);
  }

  async listPendingExport(tenantId: string): Promise<CallCorrection[]> {
    return [...this.corrections.values()]
      .filter((c) => c.tenantId === tenantId && c.exportedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async markExported(tenantId: string, correctionId: string, corpusScriptId: string, at: Date): Promise<void> {
    for (const [k, c] of this.corrections) {
      if (c.tenantId === tenantId && c.id === correctionId) {
        this.corrections.set(k, { ...c, exportedAt: at, corpusScriptId });
      }
    }
  }
}

function key(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}
