/**
 * P7-026 final wiring — Postgres-backed `GoogleBusinessReplyResolver`.
 *
 * Adapts the persisted review row + the tenant's `google_business`
 * credential row into the shape the execution handler expects.
 *
 * Two lookups happen here:
 *
 *   1. `reviewRepo.findById(tenantId, reviewId)` — the persisted
 *      `google_reviews` row carries the upstream resource path under
 *      `externalReviewId`, e.g.
 *      `accounts/{accountId}/locations/{locationId}/reviews/{reviewExternalId}`.
 *      We parse the trailing `reviews/{id}` segment because Google's
 *      reply endpoint takes just the leaf id, not the full path.
 *
 *   2. `credentialResolver.getCredential(tenantId, 'google_business')`
 *      — surfaces the OAuth access token + accountId/locationId for
 *      the tenant. Mirrors the credential extraction logic used by the
 *      polling worker (`workers/google-reviews.ts`) so wiring stays
 *      consistent. Falls back to the persisted row's `locationId`
 *      when the credential row omits provider data, since the review
 *      itself records which location it belongs to.
 *
 * Returns `null` on any of:
 *   - review row not found (deleted between proposal creation + approval),
 *   - tenant has no `google_business` credential row,
 *   - credential row is present but missing the access token / location.
 *
 * The handler treats `null` as a hard failure for the public sub-action
 * (returns `ok: false` with an explicit error), so misconfiguration is
 * visible to the operator instead of silently swallowed.
 */
import type {
  GoogleBusinessReplyContext,
  GoogleBusinessReplyResolver,
} from '../proposals/execution/review-response-handler';
import type { CredentialResolver } from '../integrations/credentials';
import type { ReviewRepository } from './review';
import type {
  GoogleBusinessOAuthConfig,
  GoogleFetch,
} from './google-business-client';
import { refreshAccessToken } from './google-business-client';
import {
  GoogleBusinessCredentialStore,
  resolveGoogleBusinessLocation,
  resolveGoogleBusinessTokens,
} from './google-business-integration';

/**
 * Consider a token expired this many ms BEFORE its recorded expiry so
 * a reply started moments before the boundary doesn't race a mid-PUT
 * expiration.
 */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Parse the trailing `reviews/{id}` segment from the upstream resource
 * path. Google's `replyToReview` expects just the leaf id, so we cannot
 * pass the full path. Returns null when the path doesn't contain a
 * `reviews/` segment (defensive; the worker only ever persists rows
 * with the canonical shape).
 */
export function parseReviewExternalId(externalReviewId: string): string | null {
  const idx = externalReviewId.lastIndexOf('reviews/');
  if (idx === -1) return null;
  const tail = externalReviewId.slice(idx + 'reviews/'.length);
  return tail.length > 0 ? tail : null;
}

/**
 * Parse `accounts/{a}/locations/{l}` style paths and surface
 * `{accountId, locationId}`. Used as a fallback when the credential
 * row doesn't carry provider data — the review row itself records the
 * location it belongs to under `locationId`.
 */
export function parseLocationPath(
  locationPath: string,
): { accountId?: string; locationId?: string } {
  const accMatch = locationPath.match(/accounts\/([^/]+)/);
  const locMatch = locationPath.match(/locations\/([^/]+)/);
  return {
    ...(accMatch ? { accountId: accMatch[1] } : {}),
    ...(locMatch ? { locationId: locMatch[1] } : {}),
  };
}

/**
 * Optional refresh wiring (review-monitoring self-serve). When present,
 * `resolve()` proactively refreshes an EXPIRED access token (per the
 * stored `accessTokenExpiresAt`) before handing it to the execution
 * handler, persisting the rotation through `credentialStore` — the
 * same store the poll worker's 401-retry path writes. When refresh
 * fails, `resolve()` returns null and the handler surfaces an explicit
 * `ok:false` for the public sub-action (visible to the operator).
 */
export interface PgGoogleBusinessReplyResolverOptions {
  googleConfig?: GoogleBusinessOAuthConfig | null;
  credentialStore?: GoogleBusinessCredentialStore | null;
  fetchFn?: GoogleFetch;
  now?: () => Date;
}

export class PgGoogleBusinessReplyResolver implements GoogleBusinessReplyResolver {
  constructor(
    private readonly reviewRepo: ReviewRepository,
    private readonly credentialResolver: CredentialResolver,
    private readonly encKey: string | undefined = process.env.TENANT_ENCRYPTION_KEY,
    private readonly opts: PgGoogleBusinessReplyResolverOptions = {},
  ) {}

  async resolve(
    tenantId: string,
    reviewId: string,
  ): Promise<GoogleBusinessReplyContext | null> {
    const review = await this.reviewRepo.findById(tenantId, reviewId);
    if (!review) return null;

    const reviewExternalId = parseReviewExternalId(review.externalReviewId);
    if (!reviewExternalId) return null;

    const credRow = await this.credentialResolver.getCredential(
      tenantId,
      'google_business',
    );
    if (!credRow) return null;

    const tokens = resolveGoogleBusinessTokens(credRow, this.encKey);
    if (!tokens) return null;

    let accessToken = tokens.accessToken;

    // Proactive refresh: Google access tokens live ~1h, and approvals
    // routinely land later than the poll that minted the stored token.
    // Rows without a recorded expiry (hand-seeded) are used as-is.
    const now = (this.opts.now ?? (() => new Date()))();
    const expired =
      tokens.expiresAt !== null &&
      tokens.expiresAt.getTime() <= now.getTime() + TOKEN_EXPIRY_SKEW_MS;
    if (expired) {
      if (!tokens.refreshToken || !this.opts.googleConfig) return null;
      try {
        const rotated = await refreshAccessToken(
          this.opts.googleConfig,
          tokens.refreshToken,
          this.opts.fetchFn ?? fetch,
        );
        if (this.opts.credentialStore) {
          await this.opts.credentialStore.persistRotatedAccessToken(
            tenantId,
            rotated.accessToken,
            rotated.expiresAt,
          );
        }
        accessToken = rotated.accessToken;
      } catch {
        // Refresh grant is dead (operator revoked access). "No context"
        // is the visible-failure path at the handler.
        return null;
      }
    }

    // Prefer credential-row provider data; fall back to parsing the
    // review's `locationId`, which is `accounts/{a}/locations/{l}`.
    let { accountId, locationId } = resolveGoogleBusinessLocation(credRow);
    if (!accountId || !locationId) {
      const fromPath = parseLocationPath(review.locationId);
      accountId = accountId ?? fromPath.accountId;
      locationId = locationId ?? fromPath.locationId;
    }
    if (!accountId || !locationId) return null;

    return {
      accessToken,
      accountId,
      locationId,
      reviewExternalId,
    };
  }
}
