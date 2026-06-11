/**
 * P7-026 PR b — Conservative reviewer → customer matcher.
 *
 * Google review reviewers are identified only by a display name (often
 * just a first name + last initial, sometimes a pseudonym). We use this
 * weak signal plus the tenant's recent appointment history to make a
 * best-effort match — but the algorithm is intentionally
 * conservative: it would rather return `null` (no match) than draft a
 * personalized response addressed to the wrong customer.
 *
 * The downstream consequence of a false-positive match is severe:
 * PR c would insert the customer's name into a public LLM-drafted
 * reply, and we'd publicly contact the wrong person. False negatives
 * cost a draft-quality improvement; false positives cost trust. The
 * threshold logic reflects that asymmetry:
 *
 *   - top score must exceed 0.8 absolute, AND
 *   - the gap to the next candidate must exceed 0.1 (no near-ties),
 *     OR there's only one candidate.
 *
 * The 60-day visit window is enforced inside the loader's SQL — we
 * only consider customers with a scheduled appointment in that window
 * because review reviewers almost always reviewed a recent visit.
 */

import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { normalizeName } from '../customers/dedup';
import { Review } from './review';

export interface MatchedCustomer {
  customerId: string;
  firstName: string;
  lastName: string;
  /** The most recent appointment scheduled_start within the 60-day window. */
  lastVisitAt: Date;
  /** 0..1 — the normalized-name similarity score that won. */
  matchScore: number;
}

export interface CustomerCandidate {
  id: string;
  firstName: string;
  lastName: string;
  lastVisitAt: Date;
}

export interface CustomerLoader {
  /**
   * Return at most ~50 candidates from this tenant whose name shares
   * at least one token with `name` AND who had an appointment within
   * the last `sinceDays` days. The token-overlap pre-filter is a SQL
   * optimization; the JS scorer does the precision work.
   */
  findRecentCustomersWithName(
    tenantId: string,
    name: string,
    sinceDays: number,
  ): Promise<CustomerCandidate[]>;
}

export interface MatchReviewerDeps {
  customerLoader: CustomerLoader;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** Minimum absolute score for any match to be returned. */
export const MATCH_SCORE_THRESHOLD = 0.8;
/** Required margin between the top and the runner-up. */
export const MATCH_AMBIGUITY_MARGIN = 0.1;
/** Days back through which we consider appointments relevant. */
export const RECENT_VISIT_WINDOW_DAYS = 60;

/**
 * Score the similarity between two normalized names in [0, 1].
 *
 * Algorithm: token-Jaccard with full-string-equality bonus.
 *   - Tokenize each name on whitespace.
 *   - Jaccard = |intersection| / |union|.
 *   - If the full normalized strings are equal, return 1.0.
 *
 * This is conservative for nicknames ("Alice" vs "Alice Smith" → 0.5)
 * but high-precision for the common case (reviewer "Alice Smith"
 * matches customer "Alice Smith" → 1.0; reviewer "Alice S." matches
 * customer "Alice Smith" → 0.33 after normalization, below threshold).
 * False matches are the failure mode we're guarding against, so a
 * stingy scorer is the right default.
 */
export function scoreNameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;

  const tokensA = new Set(na.split(' ').filter((t) => t.length > 0));
  const tokensB = new Set(nb.split(' ').filter((t) => t.length > 0));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

/**
 * Attempt to match a Google review's reviewer to a customer in the
 * tenant's database.
 *
 * Returns `null` on any of:
 *   - missing/empty reviewer display name
 *   - no candidates returned by the loader
 *   - top candidate score < MATCH_SCORE_THRESHOLD
 *   - top candidate score within MATCH_AMBIGUITY_MARGIN of another
 *     candidate (multiple equally-plausible matches)
 */
export async function matchReviewerToCustomer(
  review: Review,
  deps: MatchReviewerDeps,
): Promise<MatchedCustomer | null> {
  const reviewerName = (review.reviewerDisplayName ?? '').trim();
  if (reviewerName.length === 0) return null;

  const candidates = await deps.customerLoader.findRecentCustomersWithName(
    review.tenantId,
    reviewerName,
    RECENT_VISIT_WINDOW_DAYS,
  );
  if (candidates.length === 0) return null;

  // Score every candidate; sort descending; apply threshold + margin.
  const scored = candidates
    .map((c) => ({
      candidate: c,
      score: scoreNameSimilarity(reviewerName, `${c.firstName} ${c.lastName}`),
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top.score < MATCH_SCORE_THRESHOLD) return null;

  // Ambiguity check: if a runner-up scores too close to the top, we
  // can't pick. Better to skip personalization than guess wrong.
  if (scored.length > 1) {
    const runnerUp = scored[1];
    if (top.score - runnerUp.score < MATCH_AMBIGUITY_MARGIN) return null;
  }

  return {
    customerId: top.candidate.id,
    firstName: top.candidate.firstName,
    lastName: top.candidate.lastName,
    lastVisitAt: top.candidate.lastVisitAt,
    matchScore: top.score,
  };
}

/**
 * Postgres-backed candidate loader. Joins customers → jobs →
 * appointments to surface recent visitors, then runs a coarse
 * SQL-level token-match prefilter to keep the candidate set small
 * before the JS scorer runs.
 *
 * The 60-day window is hard-coded into the SQL because passing it
 * through as a parameter doesn't compose with `INTERVAL`-style
 * predicates without string interpolation, and a static window keeps
 * the query plan stable.
 *
 * Note: appointments has no direct `customer_id` — the link is
 * `appointments.job_id → jobs.customer_id`. The query joins via jobs.
 */
interface CustomerRow {
  id: string;
  first_name: string;
  last_name: string;
  last_visit_at: string;
}

export class PgCustomerLoader
  extends PgBaseRepository
  implements CustomerLoader
{
  constructor(pool: Pool) {
    super(pool);
  }

  async findRecentCustomersWithName(
    tenantId: string,
    name: string,
    sinceDays: number,
  ): Promise<CustomerCandidate[]> {
    const normalized = normalizeName(name);
    if (normalized.length === 0) return [];

    // Coarse SQL prefilter: any token of the reviewer's name appears
    // as a prefix in first_name or last_name. We deliberately keep
    // the SQL match generous (LIKE 'token%') because the JS scorer
    // re-checks; this is just to cap the candidate set at ~50.
    const tokens = normalized.split(' ').filter((t) => t.length > 0);
    const tokenLikes = tokens.map((t) => `${t}%`);
    const fullLike = `${normalized}%`;

    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<CustomerRow>(
        `SELECT DISTINCT
           c.id,
           c.first_name,
           c.last_name,
           MAX(a.scheduled_start) AS last_visit_at
         FROM customers c
         JOIN jobs j ON j.customer_id = c.id
         JOIN appointments a ON a.job_id = j.id
         WHERE c.tenant_id = $1
           AND c.is_archived = false
           AND a.scheduled_start > NOW() - ($2::int * INTERVAL '1 day')
           AND (
             LOWER(c.first_name || ' ' || c.last_name) LIKE $3
             OR LOWER(c.first_name) = ANY($4::text[])
             OR LOWER(c.last_name) = ANY($4::text[])
             OR LOWER(c.first_name) LIKE ANY($5::text[])
             OR LOWER(c.last_name) LIKE ANY($5::text[])
           )
         GROUP BY c.id, c.first_name, c.last_name
         LIMIT 50`,
        [tenantId, sinceDays, fullLike, tokens, tokenLikes],
      );
      return result.rows.map((row) => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        lastVisitAt: new Date(row.last_visit_at),
      }));
    });
  }
}
