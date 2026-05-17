/**
 * P7-026 — Google Business Profile review polling worker.
 *
 * Cross-tenant sweep that mirrors the `overdue-invoice-worker.ts` pattern:
 *   - Iterate active connections (system-level query — bypasses tenant
 *     scoping because there's no ambient tenant context here).
 *   - For each connection, call the Google Business client once.
 *   - On 429, escalate the connection's backoff schedule
 *     (1m → 5m → 15m → 1h, max 1h, with jitter). Never tight-loop.
 *   - On success, persist new reviews via ON CONFLICT-idempotent upsert,
 *     clear backoff state, and reset the attempt counter.
 *
 * The sweep cadence is owned by `app.ts` (a setInterval driver, same
 * shape as the overdue-invoice sweep). PR-a does NOT modify `app.ts`
 * per the dispatch addendum — wiring is a later concern. The function
 * is exercised directly by the worker's unit tests.
 *
 * The worker registers itself in `worker-registry.ts` via the additive
 * `googleReviewsSweepHandle` export below, so the wiring story can
 * plug it into the registry without touching this file.
 *
 * Classification is wired through a `ReviewClassifier` dependency
 * — PR-a uses `HeuristicReviewClassifier` (the stub); PR-b swaps in the
 * real LLM-backed classifier with no worker change.
 */

import { Logger } from '../logging/logger';
import { v4 as uuidv4 } from 'uuid';
import {
  GoogleBusinessClient,
  GoogleBusinessRateLimitedError,
} from '../reputation/google-business-client';
import type { GoogleBusinessConnectionRepository } from '../reputation/connection-repository';
import type { GoogleReviewRepository } from '../reputation/review-repository';
import type { ReviewClassifier } from '../reputation/classifier-stub';
import {
  starRatingToInt,
  type GoogleReview,
  type GoogleReviewApiPayload,
} from '../reputation/types';

/**
 * Backoff bucket schedule, in milliseconds. The worker bumps the
 * connection's `backoffAttempts` after a 429 and selects the next
 * bucket; if attempts exceed the array length, the worker stays at
 * the last (max) bucket — never gives up entirely (Google quotas
 * eventually reset).
 */
export const BACKOFF_BUCKETS_MS: readonly number[] = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  15 * 60_000, // 15 minutes
  60 * 60_000, // 1 hour
];

/** Jitter applied to each backoff bucket (multiplier 0.8..1.2). */
function jitter(base: number, rng: () => number = Math.random): number {
  const factor = 0.8 + rng() * 0.4;
  return Math.round(base * factor);
}

export interface GoogleReviewsWorkerDeps {
  connectionRepo: GoogleBusinessConnectionRepository;
  reviewRepo: GoogleReviewRepository;
  client: GoogleBusinessClient;
  classifier: ReviewClassifier;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable RNG for backoff jitter — defaults to `Math.random`. */
  rng?: () => number;
  /**
   * Decrypt a connection's stored access token. Injected so the worker
   * doesn't depend on the crypto helper directly (tests pass an
   * identity decryptor). Production wires `decryptAccessToken` from
   * `integrations/calendar-integration.ts` or the equivalent shared
   * helper once the connection-management UI is built.
   */
  decryptAccessToken: (encrypted: string) => string;
}

export interface GoogleReviewsSweepResult {
  connections: number;
  newReviews: number;
  rateLimited: number;
  failed: number;
  skippedBackoff: number;
}

export async function runGoogleReviewsSweep(
  deps: GoogleReviewsWorkerDeps,
): Promise<GoogleReviewsSweepResult> {
  const now = deps.now ?? (() => new Date());
  const rng = deps.rng ?? Math.random;
  const asOf = now();

  let candidates;
  try {
    candidates = await deps.connectionRepo.findPollCandidates(asOf);
  } catch (err) {
    deps.logger.error('Google reviews sweep: failed to list connections', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      connections: 0,
      newReviews: 0,
      rateLimited: 0,
      failed: 0,
      skippedBackoff: 0,
    };
  }

  let newReviews = 0;
  let rateLimited = 0;
  let failed = 0;
  let skippedBackoff = 0;

  for (const connection of candidates) {
    // findPollCandidates already filtered by backoff_until — this guard
    // is belt-and-suspenders for the cross-tenant path.
    if (connection.backoffUntil && connection.backoffUntil.getTime() > asOf.getTime()) {
      skippedBackoff++;
      continue;
    }

    try {
      const accessToken = deps.decryptAccessToken(connection.accessTokenEncrypted);
      const response = await deps.client.listReviews({
        accountId: connection.accountId,
        locationId: connection.locationId,
        accessToken,
      });

      const since = connection.lastPolledAt;
      for (const wireReview of response.reviews) {
        const postedAt = new Date(wireReview.createTime);
        // Skip already-seen reviews defensively. The DB unique index is
        // the authoritative gate (ON CONFLICT DO NOTHING) but filtering
        // here saves the upsert round-trip.
        if (since && postedAt.getTime() <= since.getTime()) continue;

        const draft = toGoogleReview({
          tenantId: connection.tenantId,
          connectionId: connection.id,
          wire: wireReview,
          createdAt: now(),
        });

        // Inline classification. Classifier failures must NOT crash the
        // poll — without classification the review still belongs in the
        // table; PR-b's backfill sweep will retry.
        try {
          draft.classification = await deps.classifier.classify({
            rating: draft.rating,
            commentText: draft.commentText,
          });
        } catch (clsErr) {
          deps.logger.warn('Google reviews sweep: classifier failed', {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            googleReviewId: draft.googleReviewId,
            error: clsErr instanceof Error ? clsErr.message : String(clsErr),
          });
        }

        const { inserted } = await deps.reviewRepo.upsert(draft);
        if (inserted) newReviews++;
      }

      // Reset backoff state on success.
      await deps.connectionRepo.update(connection.tenantId, connection.id, {
        lastPolledAt: now(),
        backoffUntil: null,
        backoffAttempts: 0,
      });
    } catch (err) {
      if (err instanceof GoogleBusinessRateLimitedError) {
        rateLimited++;
        const nextAttempt = Math.min(
          connection.backoffAttempts + 1,
          BACKOFF_BUCKETS_MS.length,
        );
        const bucket = BACKOFF_BUCKETS_MS[Math.min(connection.backoffAttempts, BACKOFF_BUCKETS_MS.length - 1)] ?? BACKOFF_BUCKETS_MS[BACKOFF_BUCKETS_MS.length - 1]!;
        const sleepMs = Math.max(
          jitter(bucket, rng),
          // Honor server-supplied Retry-After if it's longer.
          (err.retryAfterSeconds ?? 0) * 1000,
        );
        const backoffUntil = new Date(now().getTime() + sleepMs);
        // Telemetry per the dispatch addendum risk note: emit on every
        // backoff event so we detect quota pressure early.
        deps.logger.warn('Google reviews sweep: rate-limited, backing off', {
          tenantId: connection.tenantId,
          connectionId: connection.id,
          attempt: nextAttempt,
          sleepMs,
          backoffUntil: backoffUntil.toISOString(),
          serverRetryAfterSeconds: err.retryAfterSeconds,
        });
        try {
          await deps.connectionRepo.update(connection.tenantId, connection.id, {
            backoffUntil,
            backoffAttempts: nextAttempt,
          });
        } catch (updErr) {
          deps.logger.error('Google reviews sweep: failed to persist backoff', {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            error: updErr instanceof Error ? updErr.message : String(updErr),
          });
        }
      } else {
        failed++;
        deps.logger.warn('Google reviews sweep: connection failed', {
          tenantId: connection.tenantId,
          connectionId: connection.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  deps.logger.info('Google reviews sweep completed', {
    connections: candidates.length,
    newReviews,
    rateLimited,
    failed,
    skippedBackoff,
  });

  return {
    connections: candidates.length,
    newReviews,
    rateLimited,
    failed,
    skippedBackoff,
  };
}

function toGoogleReview(input: {
  tenantId: string;
  connectionId: string;
  wire: GoogleReviewApiPayload;
  createdAt: Date;
}): GoogleReview {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    googleReviewId: input.wire.reviewId,
    reviewerName: input.wire.reviewer.displayName,
    rating: starRatingToInt(input.wire.starRating),
    commentText: input.wire.comment ?? '',
    postedAt: new Date(input.wire.createTime),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/**
 * Worker-registry registration. The dispatch addendum says the new
 * worker registers itself via worker-registry.ts. The polling worker
 * is a cross-tenant interval sweep (not a queue-message-driven handler
 * like execution-worker), so the registry entry is a thin metadata
 * record that the wiring layer reads when constructing the setInterval
 * driver in app.ts. This shape mirrors the convention the
 * overdue-invoice / recurring-agreements workers will adopt when their
 * own registry entries land — at the moment the registry exposes only
 * `WorkerHandler` (queue messages); the new field below is additive
 * and consumed by app.ts's wiring layer, not by `WorkerRegistry`.
 */
export const GOOGLE_REVIEWS_SWEEP_INTERVAL_MS = 15 * 60_000;

export const googleReviewsSweepRegistration = {
  name: 'google-reviews-sweep',
  intervalMs: GOOGLE_REVIEWS_SWEEP_INTERVAL_MS,
  run: runGoogleReviewsSweep,
} as const;
