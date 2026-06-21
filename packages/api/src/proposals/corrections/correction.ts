/**
 * Story 3.9 (correction capture) — raw, per-field proposal-edit log.
 *
 * Every field a user changes when editing a proposal writes one row capturing
 * (intent, field, before, after). `intent` is the proposal_type that was
 * corrected, so the log is queryable per tenant AND per intent — the training
 * signal that feeds prompt/routing improvement.
 *
 * This is deliberately SEPARATE from the correction-loop's `correction_lessons`
 * (src/learning/corrections): that captures conservative, cascading config
 * lessons (labor rate / SKU price / banned phrase / scope) only on succeeded
 * execution. This captures the unfiltered edit deltas at edit time. The repo
 * persists `corrections` (tenant_id + FORCE RLS, migration 204); a mocked Pool
 * is NOT proof the columns exist — the Docker-gated integration test pins them.
 */
import { randomUUID } from 'crypto';

export interface Correction {
  id: string;
  tenantId: string;
  /** Proposal whose payload was edited. */
  proposalId: string;
  /** The proposal_type that was corrected; maps to the intent taxonomy. */
  intent: string;
  /** The payload key that changed. */
  field: string;
  /** Prior value (null when the field was absent before). */
  beforeValue: unknown;
  /** New value (null when the field was cleared). */
  afterValue: unknown;
  actorId: string;
  createdAt: Date;
}

export interface ComputeCorrectionsInput {
  tenantId: string;
  proposalId: string;
  intent: string;
  actorId: string;
  /** Payload before the edit. */
  before: Record<string, unknown>;
  /** Payload after the edit (merged). */
  after: Record<string, unknown>;
  /** Candidate keys the user touched; only those that actually changed yield rows. */
  fields: string[];
  /** Injectable for deterministic tests. */
  idFactory?: () => string;
  now?: () => Date;
}

/** Structural equality via canonical JSON — sufficient for proposal payload values. */
function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Pure: build one Correction per field whose value actually changed. Re-filters
 * `fields` against before/after so a no-op key (same value) never logs a row —
 * "each edit" means a real change, not merely a key present in the edit object.
 */
export function computeCorrections(input: ComputeCorrectionsInput): Correction[] {
  const idFactory = input.idFactory ?? (() => randomUUID());
  const createdAt = input.now ? input.now() : new Date();
  const seen = new Set<string>();
  const rows: Correction[] = [];
  for (const field of input.fields) {
    if (seen.has(field)) continue;
    seen.add(field);
    const before = input.before[field];
    const after = input.after[field];
    if (valuesEqual(before, after)) continue;
    rows.push({
      id: idFactory(),
      tenantId: input.tenantId,
      proposalId: input.proposalId,
      intent: input.intent,
      field,
      beforeValue: before ?? null,
      afterValue: after ?? null,
      actorId: input.actorId,
      createdAt,
    });
  }
  return rows;
}

export interface CorrectionRepository {
  /** Persist a batch of correction rows (no-op for an empty array). */
  recordMany(corrections: Correction[]): Promise<Correction[]>;
  /** Most-recent corrections for a tenant. */
  findByTenant(tenantId: string, limit?: number): Promise<Correction[]>;
  /** Most-recent corrections for a tenant filtered to one intent (proposal type). */
  findByIntent(tenantId: string, intent: string, limit?: number): Promise<Correction[]>;
  /** Every correction recorded against a single proposal. */
  findByProposal(tenantId: string, proposalId: string): Promise<Correction[]>;
}

export class InMemoryCorrectionRepository implements CorrectionRepository {
  private corrections: Correction[] = [];

  async recordMany(corrections: Correction[]): Promise<Correction[]> {
    const stored = corrections.map((c) => structuredClone(c));
    this.corrections.push(...stored);
    return stored.map((c) => structuredClone(c));
  }

  async findByTenant(tenantId: string, limit = 100): Promise<Correction[]> {
    return this.sortedFor((c) => c.tenantId === tenantId).slice(0, limit);
  }

  async findByIntent(tenantId: string, intent: string, limit = 100): Promise<Correction[]> {
    return this.sortedFor((c) => c.tenantId === tenantId && c.intent === intent).slice(0, limit);
  }

  async findByProposal(tenantId: string, proposalId: string): Promise<Correction[]> {
    return this.sortedFor((c) => c.tenantId === tenantId && c.proposalId === proposalId);
  }

  private sortedFor(pred: (c: Correction) => boolean): Correction[] {
    return this.corrections
      .filter(pred)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((c) => structuredClone(c));
  }
}
