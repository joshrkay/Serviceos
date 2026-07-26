/**
 * Entity resolver — closes the "three Bobs" gap.
 *
 * The intent classifier extracts names from the transcript as free text
 * ("customerName: Bob"). Before the task handler drafts, the
 * voice-action-router resolves that text to a concrete tenant-scoped
 * entity ID via `annotateResolvedEntities`. Three outcomes matter:
 *
 *   - zero matches  → proposal is persisted with the raw name on
 *     `sourceContext.pendingReference`; the review UI prompts the
 *     operator to pick from the full list or create a new record.
 *   - one match     → the resolved ID is injected into the task context.
 *   - many matches  → the router emits a `voice_clarification` proposal
 *     (reason 'ambiguous_entity') with the candidate list instead of
 *     drafting. `EntityResolverResult.kind === 'ambiguous'` surfaces
 *     the candidates.
 *
 * The production implementation is `PgEntityResolver` (Postgres
 * pg_trgm), wired in app.ts. The dep is optional on the router —
 * pipelines without a resolver simply skip resolution.
 */

export type EntityKind =
  | 'customer'
  | 'job'
  | 'appointment'
  | 'invoice'
  | 'estimate'
  // RV-072 — a proposal awaiting review (status draft / ready_for_review),
  // resolved by the voice approval channel ("approve the Henderson estimate").
  | 'pending_proposal'
  // U1 (agent wave) — a tenant team member spoken by name ("give it to
  // Carlos"). Resolved against users (role technician/dispatcher/owner) so
  // reassign/add-crew/remove-crew proposals carry a verified technician id
  // instead of stalling in draft on a free-text name.
  | 'technician';

/**
 * Confidence threshold above which a match is considered "resolved"
 * (τ_ent). Shared by every candidate source: one score above → resolved;
 * several above → ambiguous (ONE clarification, never a silent guess);
 * none above → not_found.
 */
export const TAU_ENT = 0.8;

/**
 * Lower confidence band (τ_ent_confirm_low) for a "probably right, but
 * confirm before acting" middle ground between τ_ent and not_found. A real
 * caller phrase scored 0.70 against an obviously-correct match and was
 * rejected outright — one candidate in [τ_ent_confirm_low, τ_ent) now
 * triggers a one-tap voice confirmation turn instead of a hard not_found.
 *
 * Provisional/tunable: reasoned from a single real 0.70 data point, not a
 * calibrated study. Should be recalibrated from real call data later.
 */
export const TAU_ENT_CONFIRM_LOW = 0.6;

export interface EntityCandidate {
  id: string;
  kind: EntityKind;
  /** Human-readable label — "Bob Smith (555-0100)" or "INV-0042". */
  label: string;
  /** Optional ancillary info the UI can show in a disambiguation list. */
  hint?: string;
  /** Match score in [0,1]; higher is a closer match. */
  score: number;
}

export type EntityResolverResult =
  | { kind: 'resolved'; candidate: EntityCandidate }
  | { kind: 'ambiguous'; candidates: EntityCandidate[] }
  // One candidate in [τ_ent_confirm_low, τ_ent) — probably right, but not
  // confident enough to act without a one-tap voice confirmation.
  | { kind: 'low_confidence'; candidate: EntityCandidate }
  | { kind: 'not_found'; reference: string }
  | { kind: 'skipped' };

export interface EntityResolver {
  /**
   * Resolve a free-text reference ("Bob", "the Rodriguez job",
   * "INV-0042") against tenant-scoped records. Returns a single
   * resolution, a candidate list for disambiguation, not_found, or
   * skipped (no resolver configured / kind unsupported).
   */
  resolve(input: {
    tenantId: string;
    reference: string;
    kind: EntityKind;
  }): Promise<EntityResolverResult>;
}
