/**
 * P7-026 — Conservative customer matcher.
 *
 * Matches a reviewer name to an existing customer. Used by PR-c's
 * proposal builder to decide whether to draft a private apology
 * message in addition to the public response.
 *
 * Conservatism rules (per the dispatch addendum's risk note —
 * "Customer matching false positives"):
 *   - A HIGH-confidence match requires BOTH (a) reviewer name similarity
 *     above the Levenshtein threshold AND (b) a job/appointment in the
 *     ±7-day window around the review's posted-at.
 *   - A LOW-confidence match is reviewer name similarity alone (no
 *     recent visit). The proposal builder uses this to flag the match
 *     as unverified and OMIT the private draft.
 *   - "John Smith on Tuesday" must not match — short name with many
 *     bearers is not a high-confidence signal.
 *
 * The matcher is pure: it consumes pre-fetched candidate customers and
 * pre-fetched recent visits, so the worker can batch the data-fetch
 * outside the per-review loop.
 */

import type { MatchConfidence } from './types';

export interface CandidateCustomer {
  id: string;
  displayName: string;
  /** ISO display name (lowercased, trimmed) used for similarity. */
  firstName: string;
  lastName: string;
}

export interface RecentVisit {
  customerId: string;
  /** Scheduled or completed appointment start time. */
  visitAt: Date;
}

export interface MatchInput {
  reviewerName: string;
  reviewPostedAt: Date;
  candidates: readonly CandidateCustomer[];
  recentVisits: readonly RecentVisit[];
  /** Visit-window radius in days. Defaults to 7. */
  visitWindowDays?: number;
  /** Minimum name similarity to consider a candidate at all. */
  nameSimilarityThreshold?: number;
}

export interface MatchResult {
  customerId?: string;
  confidence: MatchConfidence;
  reason: string;
}

/** Default minimum normalized name similarity (0..1). */
const DEFAULT_NAME_SIMILARITY_THRESHOLD = 0.82;

/** Names too short to be a reliable identifier on their own. */
const MIN_RELIABLE_FULL_NAME_LENGTH = 6;

export function matchReviewerToCustomer(input: MatchInput): MatchResult {
  const reviewer = normalizeName(input.reviewerName);
  if (!reviewer) {
    return { confidence: 'none', reason: 'empty reviewer name' };
  }

  const threshold = input.nameSimilarityThreshold ?? DEFAULT_NAME_SIMILARITY_THRESHOLD;
  const windowDays = input.visitWindowDays ?? 7;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  // Build top candidate by name similarity.
  let bestCandidate: CandidateCustomer | undefined;
  let bestScore = 0;
  for (const candidate of input.candidates) {
    const fullCandidate = normalizeName(candidate.displayName);
    if (!fullCandidate) continue;
    const score = nameSimilarity(reviewer, fullCandidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate || bestScore < threshold) {
    return { confidence: 'none', reason: 'no candidate above name threshold' };
  }

  // Guard against short / common names ("Jo", "Sam") that yield a
  // perfect match on a candidate but are not a unique identifier. We
  // require the full name to clear MIN_RELIABLE_FULL_NAME_LENGTH —
  // a perfect-score short-name match is exactly the false-positive
  // we are trying to prevent.
  const fullLen = normalizeName(bestCandidate.displayName).length;
  if (fullLen < MIN_RELIABLE_FULL_NAME_LENGTH) {
    return { confidence: 'none', reason: 'name too short to be reliable' };
  }

  // Visit window check. Conservative: require a visit within ±N days.
  const matchedVisits = input.recentVisits.filter((v) => v.customerId === bestCandidate!.id);
  const reviewTs = input.reviewPostedAt.getTime();
  const hasRecentVisit = matchedVisits.some((v) => {
    const diff = Math.abs(v.visitAt.getTime() - reviewTs);
    return diff <= windowMs;
  });

  if (hasRecentVisit) {
    return {
      customerId: bestCandidate.id,
      confidence: 'high',
      reason: `name similarity ${bestScore.toFixed(2)} AND visit within ${windowDays}d`,
    };
  }

  return {
    customerId: bestCandidate.id,
    confidence: 'low',
    reason: `name similarity ${bestScore.toFixed(2)} but no visit within ${windowDays}d — unverified`,
  };
}

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Normalized similarity in [0, 1]. Uses Levenshtein distance on the
 * normalized strings; an exact match scores 1.0. Cheap enough to run
 * once per candidate per review.
 */
function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}
