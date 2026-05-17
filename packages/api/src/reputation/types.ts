/**
 * P7-026 — Shared domain types for the reputation (Google Business Profile)
 * module. Kept separate from the data-access / API-client / classifier
 * modules so circular-import hazards stay impossible.
 *
 * Money is integer cents per CLAUDE.md; timestamps are UTC `Date`s
 * (callers render in tenant timezone when surfacing in the UI).
 */

export type ReviewClassification =
  | 'praise'
  | 'specific_complaint'
  | 'vague_complaint'
  | 'wrong_business';

export type MatchConfidence = 'high' | 'low' | 'none';

export type ConnectionStatus = 'active' | 'expired' | 'revoked';

/**
 * Per-tenant OAuth connection to a Google Business Profile location.
 * Tokens are stored encrypted at rest; this in-memory shape carries the
 * *decrypted* values during a poll cycle and must never be logged or
 * persisted as JSON.
 */
export interface GoogleBusinessConnection {
  id: string;
  tenantId: string;
  locationId: string;
  accountId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accessTokenExpiresAt: Date;
  externalAccountEmail?: string;
  status: ConnectionStatus;
  lastPolledAt?: Date;
  backoffUntil?: Date;
  backoffAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The minimal Google review shape we persist. Mirrors the
 * `google_reviews` table from migration 102. Fields beyond `id` /
 * `tenantId` / IDs / rating / text / postedAt are populated by
 * subsequent passes (classifier in PR-b, matcher in PR-b,
 * proposal builder in PR-c).
 */
export interface GoogleReview {
  id: string;
  tenantId: string;
  connectionId: string;
  googleReviewId: string;
  reviewerName: string;
  rating: number;
  commentText: string;
  postedAt: Date;
  classification?: ReviewClassification;
  matchedCustomerId?: string;
  matchConfidence?: MatchConfidence;
  proposalId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The wire shape returned by the Google Business Profile API for a
 * single review. We translate this into our internal `GoogleReview`
 * before persisting — Google's payload includes fields we never
 * surface (the reviewer's profilePhotoUrl, etc.) and we do not want
 * those joining our schema by accident.
 */
export interface GoogleReviewApiPayload {
  reviewId: string;
  reviewer: { displayName: string };
  starRating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  createTime: string; // ISO-8601 (UTC)
  updateTime?: string;
}

/**
 * Service-credit suggestion tier surfaced by the credit-tier calculator
 * (PR-c, migration 103). Kept here so PR-c's contract schema can import
 * the union without re-declaring it.
 */
export type ServiceCreditTier = 0 | 2500 | 5000 | 10000;

/** Maximum lifetime credit, in cents, per customer in any 12-month window. */
export const SERVICE_CREDIT_12MO_CAP_CENTS = 10000;

/** Star-rating to numeric (1-5) helper used in two places — kept central. */
export function starRatingToInt(s: GoogleReviewApiPayload['starRating']): number {
  switch (s) {
    case 'ONE':
      return 1;
    case 'TWO':
      return 2;
    case 'THREE':
      return 3;
    case 'FOUR':
      return 4;
    case 'FIVE':
      return 5;
  }
}
