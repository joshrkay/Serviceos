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
import type {
  CredentialResolver,
  CredentialRow,
} from '../integrations/credentials';
import { decrypt } from '../integrations/crypto';
import type { ReviewRepository } from './review';

interface GoogleBusinessCredentials {
  accessToken?: string;
  accessTokenEnc?: string;
  providerData?: { accountId?: string; locationId?: string };
  accountId?: string;
  locationId?: string;
}

/**
 * Pull the access token out of a credential row. Supports both
 * plaintext (`accessToken`) and encrypted-at-rest (`accessTokenEnc`)
 * shapes. Returns null when the row is missing both keys or the
 * decrypt fails — the resolver treats that as a "no context" outcome.
 *
 * Duplicated from `workers/google-reviews.ts` rather than extracted to
 * a shared helper so the two call sites can evolve independently —
 * the worker may eventually need refresh-token handling that the
 * handler doesn't (the handler's call is one-shot per approval).
 */
function resolveAccessToken(
  credRow: CredentialRow,
  encKey: string | undefined,
): string | null {
  const creds = (credRow.credentials ?? {}) as GoogleBusinessCredentials;
  if (creds.accessToken) return creds.accessToken;
  if (creds.accessTokenEnc && encKey) {
    try {
      return decrypt(creds.accessTokenEnc, encKey);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extract `{accountId, locationId}` from a credential row, accepting
 * both nested (`credentials.providerData.{accountId,locationId}`) and
 * hoisted top-level shapes for forward-compat with onboarding.
 */
function resolveLocation(
  credRow: CredentialRow,
): { accountId?: string; locationId?: string } {
  const creds = (credRow.credentials ?? {}) as GoogleBusinessCredentials;
  if (creds.providerData) {
    const { accountId, locationId } = creds.providerData;
    return {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(locationId !== undefined ? { locationId } : {}),
    };
  }
  return {
    ...(creds.accountId !== undefined ? { accountId: creds.accountId } : {}),
    ...(creds.locationId !== undefined ? { locationId: creds.locationId } : {}),
  };
}

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

export class PgGoogleBusinessReplyResolver implements GoogleBusinessReplyResolver {
  constructor(
    private readonly reviewRepo: ReviewRepository,
    private readonly credentialResolver: CredentialResolver,
    private readonly encKey: string | undefined = process.env.TENANT_ENCRYPTION_KEY,
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

    const accessToken = resolveAccessToken(credRow, this.encKey);
    if (!accessToken) return null;

    // Prefer credential-row provider data; fall back to parsing the
    // review's `locationId`, which is `accounts/{a}/locations/{l}`.
    let { accountId, locationId } = resolveLocation(credRow);
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
