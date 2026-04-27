/**
 * Entity resolver — closes the "three Bobs" gap.
 *
 * Task handlers extract names from the transcript as free text
 * ("customerName: Bob"). Before the proposal is persisted we try to
 * resolve that text to a concrete tenant-scoped entity ID. Three
 * outcomes matter:
 *
 *   - zero matches  → proposal is persisted with the raw name on
 *     `sourceContext.pendingReference`; the review UI prompts the
 *     operator to pick from the full list or create a new record.
 *   - one match     → the resolved ID is injected into the payload.
 *   - many matches  → the caller should emit a `voice_clarification`
 *     proposal with the candidates instead of persisting the
 *     underlying mutation. `EntityResolverResult.kind === 'ambiguous'`
 *     surfaces the candidate list.
 *
 * This file defines the interface and a `NullEntityResolver` that is
 * the unwired default — it returns `kind: 'skipped'` so the existing
 * pipeline (which never resolved entities) behaves identically when
 * no concrete resolver is configured. The production implementation
 * (backed by Postgres ILIKE + trigram) lives in a follow-up slice; the
 * interface is stable so the router can be wired now.
 */

export type EntityKind = 'customer' | 'job' | 'appointment' | 'invoice' | 'estimate';

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

/**
 * Default resolver that always returns `skipped`. Keeps the pipeline
 * backward-compatible with the pre-resolver code path: the task
 * handler's raw reference string is passed through unchanged. Swap
 * this for the Postgres-backed resolver once the follow-up slice
 * lands.
 */
export class NullEntityResolver implements EntityResolver {
  async resolve(): Promise<EntityResolverResult> {
    return { kind: 'skipped' };
  }
}
