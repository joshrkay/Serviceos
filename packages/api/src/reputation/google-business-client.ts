/**
 * P7-026 PR a — Google Business Profile OAuth + reviews API wrapper.
 *
 * Mirrors `integrations/google-calendar.ts` for OAuth shape — same
 * Google authorization & token endpoints — but with the
 * `business.manage` scope and the deprecated-but-still-active
 * `mybusiness.googleapis.com/v4` reviews endpoint (Google's
 * replacement REST API for reviews is still in restricted preview as
 * of this PR; v4 remains the documented surface for partners).
 *
 * The reviews list call throws `GoogleBusinessQuotaError` on HTTP 429
 * so the worker can branch on it (per-tenant exponential backoff lives
 * in `poll-state.ts`, not here — this module stays oblivious to retry
 * policy). Schema violations throw `GoogleBusinessApiError` — distinct
 * so the worker doesn't mistake them for throttling.
 *
 * `fetchFn` is injectable so tests can stub HTTP without nock.
 */
import { z } from 'zod';

export interface GoogleBusinessOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type GoogleFetch = typeof fetch;

/** OAuth scope required for read access to GBP locations + reviews. */
export const GOOGLE_BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * v4 is the documented reviews endpoint for partners. The newer
 * Business Profile APIs (mybusinessaccountmanagement,
 * mybusinessbusinessinformation, mybusinessnotifications) split the
 * surface but reviews remain on v4. Keep this constant so a future
 * migration is a one-line change.
 */
export const GOOGLE_BUSINESS_REVIEWS_HOST = 'https://mybusiness.googleapis.com';

/**
 * Thrown on HTTP 429 from any GBP API call. The worker catches this
 * specifically and updates the per-tenant backoff window; all other
 * errors propagate normally and are logged + counted as failures.
 */
export class GoogleBusinessQuotaError extends Error {
  readonly status = 429;
  /** Retry-After header value in seconds, if present. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'GoogleBusinessQuotaError';
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

/**
 * Thrown when Google's response is a 2xx but does not match the
 * documented schema (missing required fields, unexpected enum values,
 * etc.). Distinct from {@link GoogleBusinessQuotaError} because this
 * is NOT a throttle signal — the worker should log + count as failed
 * (not extend the backoff window). The original Zod error is attached
 * via `cause` for diagnostic logging.
 */
export class GoogleBusinessApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GoogleBusinessApiError';
  }
}

/**
 * Thrown on HTTP 401 from any GBP API call, and on a failed
 * refresh-token grant. Google access tokens expire after ~1h, so this
 * is the signal the worker (and reply resolver) branch on to run the
 * refresh-and-retry-once path in
 * `reputation/google-business-integration.ts`. When the refresh itself
 * fails (revoked grant), the same class propagates and the worker
 * records the failure into the poll-state backoff so the tenant
 * surface degrades visibly.
 */
export class GoogleBusinessAuthError extends Error {
  readonly status = 401;

  constructor(message: string) {
    super(message);
    this.name = 'GoogleBusinessAuthError';
  }
}

/** Shared 401 branch for every GBP call site in this module. */
async function throwIfUnauthorized(res: Response, op: string): Promise<void> {
  if (res.status !== 401) return;
  const body = await res.text().catch(() => '');
  throw new GoogleBusinessAuthError(
    `Google Business ${op} unauthorized (401)${body ? `: ${body.slice(0, 200)}` : ''}`,
  );
}

export function buildGoogleBusinessAuthUrl(
  config: GoogleBusinessOAuthConfig,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_BUSINESS_SCOPE,
    state,
    // Same rationale as google-calendar.ts: prompt=consent is required
    // to receive a refresh_token reliably when the user has previously
    // authorized any Google OAuth client under this project.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface ExchangedBusinessTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function exchangeAuthorizationCode(
  config: GoogleBusinessOAuthConfig,
  code: string,
  fetchFn: GoogleFetch = fetch,
): Promise<ExchangedBusinessTokens> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Google business token exchange failed (${res.status}): ${body}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Google did not return access + refresh tokens');
  }
  const expiresIn = json.expires_in ?? 3600;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export interface RefreshedBusinessTokens {
  accessToken: string;
  expiresAt: Date;
}

/**
 * Refresh-token grant (RFC 6749 §6). Google rotates only the access
 * token — the refresh token stays valid until the user revokes access,
 * so callers persist just the rotated access token + expiry.
 *
 * Every failure mode throws {@link GoogleBusinessAuthError}: a non-2xx
 * (typically `invalid_grant` after the operator revoked access in
 * their Google account) and a 2xx missing `access_token` both mean
 * "these credentials cannot be made to work without the operator
 * reconnecting", which is exactly the branch callers take on 401.
 */
export async function refreshAccessToken(
  config: GoogleBusinessOAuthConfig,
  refreshToken: string,
  fetchFn: GoogleFetch = fetch,
): Promise<RefreshedBusinessTokens> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GoogleBusinessAuthError(
      `Google business token refresh failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new GoogleBusinessAuthError(
      'Google token refresh returned no access token',
    );
  }
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
  };
}

/**
 * Google's review JSON shape (subset we persist). All fields except
 * `name` may be absent — reviewer profile is omitted for anonymous
 * star-only reviews, and Google occasionally returns `starRating`
 * without `comment` (no text body).
 */
export interface GoogleReviewPayload {
  /** Full resource path, e.g. `accounts/{a}/locations/{l}/reviews/{r}`. */
  name: string;
  reviewer?: {
    displayName?: string;
    profilePhotoUrl?: string;
  };
  /** Google enum: `STAR_RATING_UNSPECIFIED` | `ONE` | `TWO` | `THREE` | `FOUR` | `FIVE`. */
  starRating?: GoogleStarRating;
  comment?: string;
  createTime?: string;
  updateTime?: string;
}

export type GoogleStarRating =
  | 'STAR_RATING_UNSPECIFIED'
  | 'ONE'
  | 'TWO'
  | 'THREE'
  | 'FOUR'
  | 'FIVE';

const STAR_RATING_MAP: Record<GoogleStarRating, number> = {
  STAR_RATING_UNSPECIFIED: 0,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

/**
 * Schema for a single review in Google's list response. Only `name`
 * is required (the upstream resource path — without it we can't
 * dedupe). `reviewer.profilePhotoUrl` is the upstream field name; we
 * map it to `reviewerProfileUrl` at the worker edge. Unknown fields
 * pass through — Google adds fields over time and we shouldn't reject
 * future additions.
 */
const reviewerSchema = z
  .object({
    displayName: z.string().optional(),
    profilePhotoUrl: z.string().optional(),
  })
  .passthrough();

const starRatingSchema = z.enum([
  'STAR_RATING_UNSPECIFIED',
  'ONE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
]);

const reviewPayloadSchema = z
  .object({
    name: z.string().min(1),
    reviewer: reviewerSchema.optional(),
    starRating: starRatingSchema.optional(),
    comment: z.string().optional(),
    createTime: z.string().optional(),
    updateTime: z.string().optional(),
  })
  .passthrough();

const listReviewsResponseSchema = z
  .object({
    reviews: z.array(reviewPayloadSchema).optional(),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

/** Public helper — exported so PR b/c can re-use the normalization. */
export function parseStarRating(raw?: GoogleStarRating): number {
  if (!raw) return 0;
  return STAR_RATING_MAP[raw] ?? 0;
}

export interface ListReviewsPage {
  reviews: GoogleReviewPayload[];
  nextPageToken: string | null;
}

/**
 * Fetch a single page of reviews. The worker drives pagination
 * itself by re-calling with the returned `nextPageToken`. Pagination
 * is bounded by the worker; this function never loops.
 */
export async function listReviews(
  accessToken: string,
  accountId: string,
  locationId: string,
  pageToken: string | null = null,
  fetchFn: GoogleFetch = fetch,
): Promise<ListReviewsPage> {
  const url = new URL(
    `${GOOGLE_BUSINESS_REVIEWS_HOST}/v4/accounts/${accountId}/locations/${locationId}/reviews`,
  );
  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  const res = await fetchFn(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (res.status === 429) {
    const retryAfterRaw = res.headers.get('Retry-After');
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
    const body = await res.text().catch(() => '');
    throw new GoogleBusinessQuotaError(
      `Google Business Profile quota exceeded${body ? `: ${body.slice(0, 200)}` : ''}`,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }

  await throwIfUnauthorized(res, 'listReviews');

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Google Business listReviews failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }

  // Parse through Zod so a schema drift on Google's side becomes an
  // explicit error instead of silent data loss (the previous `as` cast
  // + `?? []` fallback would have silently advanced the cursor on a
  // shape change, dropping every review on the page).
  const raw: unknown = await res.json();
  const parsed = listReviewsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleBusinessApiError(
      'Google Business listReviews response failed schema validation',
      { cause: parsed.error },
    );
  }
  return {
    reviews: parsed.data.reviews ?? [],
    nextPageToken: parsed.data.nextPageToken ?? null,
  };
}

// ─── P7-026 PR c — reply API ────────────────────────────────────────────

export interface ReplyToReviewResult {
  /** The reply comment text Google echoed back. */
  comment: string;
  /** ISO timestamp when Google recorded the reply. */
  updateTime: string;
}

const replyToReviewResponseSchema = z.object({
  comment: z.string(),
  updateTime: z.string(),
});

/**
 * PUT a reply to a Google Business Profile review.
 *
 * Per Google's v4 spec, `PUT
 * /v4/accounts/{accountId}/locations/{locationId}/reviews/{reviewId}/reply`
 * with `{ comment: <text> }` is an UPSERT — calling it twice with the
 * same text is idempotent (the second call returns the same
 * `updateTime` as the first). PR c's execution handler relies on this
 * idempotency rather than maintaining a local "did we already post?"
 * flag.
 *
 * 429s throw `GoogleBusinessQuotaError` (same as `listReviews`). 4xx/5xx
 * other than 429 throw the same shape `Error` as `listReviews` for
 * consistent log handling at the call site.
 */
export async function replyToReview(
  accessToken: string,
  accountId: string,
  locationId: string,
  reviewId: string,
  comment: string,
  fetchFn: GoogleFetch = fetch,
): Promise<ReplyToReviewResult> {
  const url = `${GOOGLE_BUSINESS_REVIEWS_HOST}/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`;
  const res = await fetchFn(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment }),
  });

  if (res.status === 429) {
    const retryAfterRaw = res.headers.get('Retry-After');
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
    const body = await res.text().catch(() => '');
    throw new GoogleBusinessQuotaError(
      `Google Business Profile quota exceeded${body ? `: ${body.slice(0, 200)}` : ''}`,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }

  await throwIfUnauthorized(res, 'replyToReview');

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Google Business replyToReview failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }

  const raw: unknown = await res.json();
  const parsed = replyToReviewResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleBusinessApiError(
      'Google Business replyToReview response failed schema validation',
      { cause: parsed.error },
    );
  }
  return { comment: parsed.data.comment, updateTime: parsed.data.updateTime };
}

// ─── Connect-flow discovery (accounts + locations) ─────────────────────────
//
// The OAuth callback only receives tokens; the poll worker additionally
// needs the tenant's GBP `accountId` + `locationId`. These two minimal
// v4 listings let the connect flow auto-discover them (SMB tenants
// overwhelmingly have exactly one of each). Same error taxonomy as the
// review calls: 429 → quota, 401 → auth, schema drift → api error.

const namedResourceSchema = z.object({ name: z.string().min(1) }).passthrough();

const listAccountsResponseSchema = z
  .object({ accounts: z.array(namedResourceSchema).optional() })
  .passthrough();

const listLocationsResponseSchema = z
  .object({ locations: z.array(namedResourceSchema).optional() })
  .passthrough();

async function getNamedResources(
  url: string,
  accessToken: string,
  op: string,
  schema: typeof listAccountsResponseSchema | typeof listLocationsResponseSchema,
  key: 'accounts' | 'locations',
  fetchFn: GoogleFetch,
): Promise<string[]> {
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 429) {
    const retryAfterRaw = res.headers.get('Retry-After');
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
    const body = await res.text().catch(() => '');
    throw new GoogleBusinessQuotaError(
      `Google Business Profile quota exceeded${body ? `: ${body.slice(0, 200)}` : ''}`,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  await throwIfUnauthorized(res, op);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Google Business ${op} failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }
  const raw: unknown = await res.json();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleBusinessApiError(
      `Google Business ${op} response failed schema validation`,
      { cause: parsed.error },
    );
  }
  const rows = (parsed.data as Record<string, { name: string }[] | undefined>)[key];
  return (rows ?? []).map((r) => r.name);
}

/** List account resource names (`accounts/{id}`) visible to the token. */
export async function listAccounts(
  accessToken: string,
  fetchFn: GoogleFetch = fetch,
): Promise<string[]> {
  return getNamedResources(
    `${GOOGLE_BUSINESS_REVIEWS_HOST}/v4/accounts`,
    accessToken,
    'listAccounts',
    listAccountsResponseSchema,
    'accounts',
    fetchFn,
  );
}

/** List location resource names (`accounts/{a}/locations/{l}`) under an account. */
export async function listLocations(
  accessToken: string,
  accountId: string,
  fetchFn: GoogleFetch = fetch,
): Promise<string[]> {
  return getNamedResources(
    `${GOOGLE_BUSINESS_REVIEWS_HOST}/v4/accounts/${accountId}/locations`,
    accessToken,
    'listLocations',
    listLocationsResponseSchema,
    'locations',
    fetchFn,
  );
}
