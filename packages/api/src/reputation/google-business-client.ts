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
