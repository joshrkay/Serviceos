/**
 * P7-026 PR a — Typed Review model + repository contract.
 *
 * Reviews are an external, system-of-record-elsewhere entity: each row is
 * authored by an end user inside Google Business Profile, and we mirror
 * them locally so PR b/c can run PII redaction, NLU, and the proposal
 * pipeline against them without re-hitting the upstream API on every
 * read.
 *
 * Storage rules:
 *   - `external_review_id` is the upstream Google resource path
 *     (`accounts/{a}/locations/{l}/reviews/{r}`). We treat the upstream
 *     id as authoritative and dedupe inserts on
 *     `(tenant_id, external_review_id)` — a re-fetch of an existing
 *     review must be a no-op.
 *   - Times stored UTC, rendered in tenant tz at the edge.
 *   - `rating` is the star count (1..5). Google's enum
 *     ("STAR_RATING_ONE" .. "FIVE") is normalized at the client edge.
 *
 * The repo interface is intentionally minimal: the worker calls `upsert`,
 * and PR b/c will add list/filter methods as needed.
 */

export interface Review {
  id: string;
  tenantId: string;
  /** Upstream Google resource path — globally unique per location. */
  externalReviewId: string;
  /** `accounts/{a}/locations/{l}` portion — denormalized for fast filtering. */
  locationId: string;
  reviewerDisplayName: string | null;
  reviewerProfileUrl: string | null;
  /** Star rating 1..5. */
  rating: number;
  /** Raw comment text — PR b adds PII redaction before any downstream use. */
  commentText: string | null;
  createTime: Date;
  updateTime: Date | null;
  /**
   * Moment we FIRST persisted this review (i.e. first sweep that saw
   * the upstream id). Immutable after insert — admin "when did we
   * discover this?" view reads this column.
   */
  firstFetchedAt: Date;
  /**
   * Moment we last confirmed this review via a Google API response.
   * Advances on every upsert, even when no fields changed. Ops
   * monitoring ("are we still successfully reaching Google?") reads
   * this column.
   */
  lastFetchedAt: Date;
}

export interface ReviewUpsertResult {
  review: Review;
  /** True when the row was newly inserted; false when an existing row was updated. */
  inserted: boolean;
}

export interface ReviewRepository {
  /**
   * Idempotent upsert by `(tenantId, externalReviewId)`. Returns
   * `inserted: true` only on the first insert; subsequent calls update
   * the mutable fields (rating, comment_text, update_time, reviewer
   * metadata) without changing inserted-state.
   */
  upsert(review: Review): Promise<ReviewUpsertResult>;

  /** Read-back used by tests and PR b/c. */
  findByExternalId(
    tenantId: string,
    externalReviewId: string,
  ): Promise<Review | null>;
}

/**
 * Test double — keyed by `(tenantId, externalReviewId)` so we can verify
 * worker idempotency without standing up Postgres.
 */
export class InMemoryReviewRepository implements ReviewRepository {
  private readonly store = new Map<string, Review>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private key(tenantId: string, externalReviewId: string): string {
    return `${tenantId}::${externalReviewId}`;
  }

  async upsert(review: Review): Promise<ReviewUpsertResult> {
    const k = this.key(review.tenantId, review.externalReviewId);
    const existing = this.store.get(k);
    if (existing) {
      // Preserve original id + firstFetchedAt so the row's "first seen"
      // moment is stable across re-polls. Mutate upstream-owned fields
      // and advance lastFetchedAt on every confirmation.
      const updated: Review = {
        ...existing,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewerProfileUrl: review.reviewerProfileUrl,
        rating: review.rating,
        commentText: review.commentText,
        updateTime: review.updateTime,
        lastFetchedAt: this.now(),
      };
      this.store.set(k, updated);
      return { review: updated, inserted: false };
    }
    this.store.set(k, review);
    return { review, inserted: true };
  }

  async findByExternalId(
    tenantId: string,
    externalReviewId: string,
  ): Promise<Review | null> {
    return this.store.get(this.key(tenantId, externalReviewId)) ?? null;
  }

  /** Test-only helper. */
  size(): number {
    return this.store.size;
  }
}
