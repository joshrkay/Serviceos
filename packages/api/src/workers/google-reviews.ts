/**
 * P7-026 PR a — Google Business reviews polling worker.
 *
 * Cross-tenant sweep modelled on `overdue-invoice-worker.ts`: a single
 * setInterval driver in app.ts calls `runGoogleReviewsSweep` every 15
 * minutes. For each tenant with an active `google_business`
 * integration, we:
 *
 *   1. Read per-tenant poll state. Skip if currently throttled
 *      (`now < backoff_until`).
 *   2. Resolve OAuth + provider data via `CredentialResolver`.
 *   3. Page through `listReviews` accumulating only reviews newer
 *      than the persisted cursor.
 *   4. Upsert each (idempotent on `(tenant_id, external_review_id)`).
 *   5. Persist the new cursor + reset 429 state on success.
 *   6. On 429 (`GoogleBusinessQuotaError`) record the quota error so
 *      the next sweep skips the tenant until the exponential window
 *      lifts.
 *
 * One tenant's failure NEVER stops the loop — try/catch per tenant.
 * When `pool` is unset (dev with no DB) the sweep no-ops cleanly,
 * mirroring `runOverdueInvoiceSweep`.
 *
 * PR b/c add: PII redaction before persist, NLU classification, and
 * proposal emission. Those run downstream of the persisted row, not
 * inline here.
 */
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logging/logger';
import { decrypt } from '../integrations/crypto';
import {
  CredentialResolver,
  CredentialRow,
} from '../integrations/credentials';
import {
  GoogleBusinessQuotaError,
  GoogleFetch,
  GoogleReviewPayload,
  listReviews,
  parseStarRating,
} from '../reputation/google-business-client';
import {
  ReviewRepository,
  Review,
} from '../reputation/review';
import {
  ReviewPollStateRepository,
  isThrottled,
} from '../reputation/poll-state';

/** Hard cap on pages walked per tenant per tick — defense against runaway pagination. */
const MAX_PAGES_PER_TENANT = 20;

export interface GoogleReviewsWorkerDeps {
  reviewRepo: ReviewRepository;
  pollStateRepo: ReviewPollStateRepository;
  credentialResolver: CredentialResolver | null;
  /** Returns tenants that may have a `google_business` integration. */
  listTenantIds: () => Promise<string[]>;
  /**
   * Optional pre-filter: when supplied, the worker assumes the caller
   * has already narrowed to tenants with an active integration. When
   * absent, every tenant is probed via `credentialResolver` and
   * tenants without a row are silently skipped.
   */
  fetchFn?: GoogleFetch;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * When falsy, the sweep no-ops (returns all-zero). Mirrors the
   * `if (!pool)` guard the overdue-invoice worker uses indirectly via
   * `listTenantIds`. Surfaced as an explicit dep here because the
   * credentialResolver itself is the DB-dependent piece.
   */
  enabled?: boolean;
}

export interface GoogleReviewsSweepResult {
  tenants: number;
  fetched: number;
  persisted: number;
  throttled: number;
  failed: number;
}

/**
 * `provider_data` shape on the `tenant_integrations` row.
 * Tokens are encrypted column-side on the same row; we decrypt
 * `credentials.accessToken` here using `TENANT_ENCRYPTION_KEY`.
 */
interface GoogleBusinessProviderData {
  accountId?: string;
  locationId?: string;
}

interface GoogleBusinessCredentials {
  accessToken?: string;
  // Refresh token handling lives outside PR a: the assumption per the
  // spec is the row already holds a current access token. PR b/c may
  // wire in `getValidAccessToken`-style refresh.
}

export async function runGoogleReviewsSweep(
  deps: GoogleReviewsWorkerDeps,
): Promise<GoogleReviewsSweepResult> {
  const now = deps.now ?? (() => new Date());
  const enabled = deps.enabled ?? true;

  if (!enabled || !deps.credentialResolver) {
    return { tenants: 0, fetched: 0, persisted: 0, throttled: 0, failed: 0 };
  }

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Google reviews sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, fetched: 0, persisted: 0, throttled: 0, failed: 0 };
  }

  let fetched = 0;
  let persisted = 0;
  let throttled = 0;
  let failed = 0;

  const fetchFn = deps.fetchFn ?? fetch;
  const encKey = process.env.TENANT_ENCRYPTION_KEY;

  for (const tenantId of tenantIds) {
    try {
      const state = await deps.pollStateRepo.getPollState(tenantId);
      if (isThrottled(state, now())) {
        throttled++;
        deps.logger.debug('Google reviews sweep: tenant throttled', {
          tenantId,
          backoffUntil: state?.backoffUntil?.toISOString(),
        });
        continue;
      }

      const credRow = await deps.credentialResolver.getCredential(
        tenantId,
        'google_business',
      );
      if (!credRow) {
        // No integration — silently skip. We don't count this as
        // failed because listTenantIds is a coarse filter; many
        // tenants legitimately have no GBP connected.
        continue;
      }

      const tokens = resolveAccessToken(credRow, encKey);
      if (!tokens) {
        deps.logger.warn('Google reviews sweep: missing access token', {
          tenantId,
        });
        failed++;
        continue;
      }

      const { accountId, locationId } = resolveLocation(credRow);
      if (!accountId || !locationId) {
        deps.logger.warn('Google reviews sweep: missing accountId/locationId', {
          tenantId,
        });
        failed++;
        continue;
      }

      const cursor = state?.cursor ?? null;
      const cursorDate = parseCursorDate(cursor);

      let pageToken: string | null = null;
      let pages = 0;
      let newestUpdateTime: Date = cursorDate ?? new Date(0);
      let tenantFetched = 0;
      let tenantPersisted = 0;
      let stopPaginating = false;

      do {
        pages++;
        const page = await listReviews(
          tokens,
          accountId,
          locationId,
          pageToken,
          fetchFn,
        );

        for (const payload of page.reviews) {
          tenantFetched++;
          const review = toReview(tenantId, locationId, accountId, payload, now());
          // Google sorts reviews descending by updateTime — once we
          // hit a row strictly older than the cursor, the rest of
          // this page (and all later pages) are guaranteed older too.
          // We still upsert rows AT the cursor to capture in-place
          // edits at the watermark.
          if (cursorDate && review.updateTime && review.updateTime < cursorDate) {
            stopPaginating = true;
            break;
          }
          const { inserted } = await deps.reviewRepo.upsert(review);
          if (inserted) tenantPersisted++;
          if (review.updateTime && review.updateTime > newestUpdateTime) {
            newestUpdateTime = review.updateTime;
          } else if (!review.updateTime && review.createTime > newestUpdateTime) {
            newestUpdateTime = review.createTime;
          }
        }

        pageToken = stopPaginating ? null : page.nextPageToken;
      } while (pageToken && pages < MAX_PAGES_PER_TENANT);

      // Persist the new cursor (ISO timestamp of the newest review
      // we touched). Falls back to the previous cursor when no
      // reviews were seen, so the watermark never goes backwards.
      const newCursor =
        newestUpdateTime.getTime() > 0
          ? newestUpdateTime.toISOString()
          : cursor ?? now().toISOString();
      await deps.pollStateRepo.recordSuccess(tenantId, newCursor);

      fetched += tenantFetched;
      persisted += tenantPersisted;
    } catch (err) {
      if (err instanceof GoogleBusinessQuotaError) {
        await deps.pollStateRepo
          .recordQuotaError(tenantId, err.retryAfterSeconds)
          .catch((recordErr) => {
            deps.logger.error(
              'Google reviews sweep: failed to record quota error',
              {
                tenantId,
                error:
                  recordErr instanceof Error
                    ? recordErr.message
                    : String(recordErr),
              },
            );
          });
        throttled++;
        deps.logger.warn('Google reviews sweep: 429 quota error', {
          tenantId,
          retryAfterSeconds: err.retryAfterSeconds,
        });
        continue;
      }
      // Mirror overdue-invoice-worker: log + swallow per tenant.
      failed++;
      deps.logger.warn('Google reviews sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Google reviews sweep completed', {
    tenants: tenantIds.length,
    fetched,
    persisted,
    throttled,
    failed,
  });

  return {
    tenants: tenantIds.length,
    fetched,
    persisted,
    throttled,
    failed,
  };
}

/**
 * Pull the access token out of a credential row. Supports two shapes:
 *   1. Plaintext `accessToken` in `credentials` JSON (dev/test).
 *   2. `accessTokenEnc` encrypted with TENANT_ENCRYPTION_KEY (prod).
 * Returns null on missing key/cipher (caller treats as failed).
 */
function resolveAccessToken(
  credRow: CredentialRow,
  encKey: string | undefined,
): string | null {
  const creds = (credRow.credentials ?? {}) as GoogleBusinessCredentials & {
    accessTokenEnc?: string;
  };
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

function resolveLocation(credRow: CredentialRow): GoogleBusinessProviderData {
  // Provider data may be nested under `credentials.providerData` or
  // hoisted as top-level credential keys. Accept both for
  // forward-compat — onboarding lands in PR b/c.
  const creds = (credRow.credentials ?? {}) as Record<string, unknown> & {
    providerData?: GoogleBusinessProviderData;
    accountId?: string;
    locationId?: string;
  };
  if (creds.providerData) return creds.providerData;
  return {
    ...(creds.accountId !== undefined ? { accountId: creds.accountId } : {}),
    ...(creds.locationId !== undefined ? { locationId: creds.locationId } : {}),
  };
}

/**
 * Cursor is the ISO timestamp of the newest review.updateTime we've
 * persisted. Returns null when no cursor (first poll) or unparseable.
 */
function parseCursorDate(cursor: string | null): Date | null {
  if (!cursor) return null;
  const d = new Date(cursor);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Adapter: Google payload → our typed Review. */
function toReview(
  tenantId: string,
  locationId: string,
  accountId: string,
  payload: GoogleReviewPayload,
  fetchedAt: Date,
): Review {
  const createTime = payload.createTime
    ? new Date(payload.createTime)
    : new Date(0);
  const updateTime = payload.updateTime ? new Date(payload.updateTime) : null;
  return {
    id: uuidv4(),
    tenantId,
    externalReviewId: payload.name,
    // Persist the joined account+location path so multi-location
    // tenants can filter without re-parsing externalReviewId.
    locationId: `accounts/${accountId}/locations/${locationId}`,
    reviewerDisplayName: payload.reviewer?.displayName ?? null,
    reviewerProfileUrl: payload.reviewer?.profilePhotoUrl ?? null,
    rating: parseStarRating(payload.starRating),
    commentText: payload.comment ?? null,
    createTime,
    updateTime,
    // On INSERT both columns get this moment; ON CONFLICT the repo
    // preserves first_fetched_at and advances last_fetched_at to the
    // value passed here.
    firstFetchedAt: fetchedAt,
    lastFetchedAt: fetchedAt,
  };
}
