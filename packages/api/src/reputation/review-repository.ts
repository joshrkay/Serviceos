/**
 * P7-026 — Review repository for `google_reviews` (migration 102).
 *
 * Mirrors the canonical repository shape; tenantId is always first.
 *
 * Idempotency: `create` MUST behave like ON CONFLICT (tenant_id,
 * google_review_id) DO NOTHING so a re-poll never duplicates rows.
 * The in-memory implementation enforces this by tenant + googleReviewId
 * key; the Postgres implementation uses an upsert with `ON CONFLICT`.
 *
 * The PG-backed implementation is intentionally NOT written in PR-a —
 * connection wiring (app.ts) is forbidden by the dispatch addendum and
 * the in-memory impl is sufficient for the worker's unit tests. A
 * later wiring story (Wave 1C-style) will register the real repository.
 */

import type {
  GoogleReview,
  MatchConfidence,
  ReviewClassification,
} from './types';

export interface ReviewUpdate {
  classification?: ReviewClassification;
  matchedCustomerId?: string | null;
  matchConfidence?: MatchConfidence;
  proposalId?: string;
}

export interface GoogleReviewRepository {
  /**
   * Insert-or-skip on (tenantId, googleReviewId). Returns the *existing*
   * row when the review was previously persisted, or the freshly-inserted
   * row otherwise — callers use the `inserted` flag to know which.
   */
  upsert(
    review: GoogleReview,
  ): Promise<{ review: GoogleReview; inserted: boolean }>;
  findById(tenantId: string, id: string): Promise<GoogleReview | null>;
  findByTenant(tenantId: string): Promise<GoogleReview[]>;
  findByGoogleId(
    tenantId: string,
    googleReviewId: string,
  ): Promise<GoogleReview | null>;
  /**
   * Reviews that have been polled but not yet classified. Used by PR-b's
   * classifier sweep (the worker can both classify inline AND a separate
   * pass can backfill any rows that landed before the classifier was
   * deployed).
   */
  findUnclassified(tenantId: string): Promise<GoogleReview[]>;
  update(
    tenantId: string,
    id: string,
    updates: ReviewUpdate,
  ): Promise<GoogleReview | null>;
}

export class InMemoryGoogleReviewRepository implements GoogleReviewRepository {
  private byId: Map<string, GoogleReview> = new Map();
  private byGoogleKey: Map<string, string> = new Map(); // `${tenantId}:${googleReviewId}` -> id

  async upsert(
    review: GoogleReview,
  ): Promise<{ review: GoogleReview; inserted: boolean }> {
    const key = `${review.tenantId}:${review.googleReviewId}`;
    const existingId = this.byGoogleKey.get(key);
    if (existingId) {
      const existing = this.byId.get(existingId);
      // existing is guaranteed by the index but TS doesn't know that.
      if (existing) return { review: { ...existing }, inserted: false };
    }
    this.byId.set(review.id, { ...review });
    this.byGoogleKey.set(key, review.id);
    return { review: { ...review }, inserted: true };
  }

  async findById(tenantId: string, id: string): Promise<GoogleReview | null> {
    const r = this.byId.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async findByTenant(tenantId: string): Promise<GoogleReview[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenantId === tenantId)
      .map((r) => ({ ...r }));
  }

  async findByGoogleId(
    tenantId: string,
    googleReviewId: string,
  ): Promise<GoogleReview | null> {
    const id = this.byGoogleKey.get(`${tenantId}:${googleReviewId}`);
    if (!id) return null;
    const r = this.byId.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async findUnclassified(tenantId: string): Promise<GoogleReview[]> {
    return Array.from(this.byId.values())
      .filter((r) => r.tenantId === tenantId && !r.classification)
      .map((r) => ({ ...r }));
  }

  async update(
    tenantId: string,
    id: string,
    updates: ReviewUpdate,
  ): Promise<GoogleReview | null> {
    const r = this.byId.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const next: GoogleReview = {
      ...r,
      ...(updates.classification !== undefined && {
        classification: updates.classification,
      }),
      ...(updates.matchedCustomerId !== undefined && {
        matchedCustomerId: updates.matchedCustomerId === null
          ? undefined
          : updates.matchedCustomerId,
      }),
      ...(updates.matchConfidence !== undefined && {
        matchConfidence: updates.matchConfidence,
      }),
      ...(updates.proposalId !== undefined && {
        proposalId: updates.proposalId,
      }),
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return { ...next };
  }
}
