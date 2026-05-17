/**
 * P7-026 — Thin wrapper over the Google Business Profile reviews API.
 *
 * Scope (PR-a):
 *   - List reviews for a single (account, location) since a given
 *     timestamp.
 *   - Surface 429 (rate-limited) as a typed sentinel so the worker can
 *     escalate its backoff schedule instead of treating it like an
 *     ordinary transport error.
 *   - Never tight-loop: a single call per location per invocation.
 *
 * The OAuth refresh path will live in PR-c when the connection-management
 * layer lands; for PR-a we accept the access token from the caller.
 *
 * The HTTP transport is injected so tests can stub it. Production wires
 * the global `fetch`; tests pass a recorded-fixture fetch.
 */

import { AppError } from '../shared/errors';
import type { GoogleReviewApiPayload } from './types';

export type GoogleBusinessFetch = typeof fetch;

export const GOOGLE_BUSINESS_API_BASE =
  'https://mybusiness.googleapis.com/v4';

export interface ListReviewsRequest {
  accountId: string;
  locationId: string;
  accessToken: string;
  /** Optional cursor returned by a previous call. */
  pageToken?: string;
}

export interface ListReviewsResponse {
  reviews: GoogleReviewApiPayload[];
  nextPageToken?: string;
  totalReviewCount?: number;
}

/**
 * Typed 429 sentinel. The worker catches this and applies the
 * exponential-backoff schedule (1m → 5m → 15m → 1h with jitter, max 1h
 * per CLAUDE.md / the dispatch addendum's risk note). Distinct from a
 * transport failure so we never accidentally tight-loop the API.
 */
export class GoogleBusinessRateLimitedError extends Error {
  public readonly retryAfterSeconds?: number;

  constructor(retryAfterSeconds?: number) {
    super(`Google Business Profile API rate limited (HTTP 429)`);
    this.name = 'GoogleBusinessRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Wraps any non-2xx, non-429 HTTP response. Surfaced to the worker so a
 * per-tenant try/catch can record it without crashing the sweep.
 */
export class GoogleBusinessApiError extends AppError {
  constructor(status: number, body: string) {
    super(
      'GOOGLE_BUSINESS_API_ERROR',
      `Google Business Profile API request failed: ${status}`,
      502,
      { status, bodySnippet: body.slice(0, 200) },
    );
  }
}

export class GoogleBusinessClient {
  constructor(private readonly fetchImpl: GoogleBusinessFetch = fetch) {}

  /**
   * List reviews for one location. The Google API returns reviews in
   * reverse-chronological order, so the worker filters to those posted
   * since `connection.lastPolledAt` after the fact.
   */
  async listReviews(req: ListReviewsRequest): Promise<ListReviewsResponse> {
    if (!req.accessToken) {
      throw new AppError('MISSING_ACCESS_TOKEN', 'Access token is required', 401);
    }
    if (!req.accountId || !req.locationId) {
      throw new AppError(
        'MISSING_LOCATION',
        'accountId and locationId are required',
        400,
      );
    }

    const url = new URL(
      `${GOOGLE_BUSINESS_API_BASE}/accounts/${encodeURIComponent(
        req.accountId,
      )}/locations/${encodeURIComponent(req.locationId)}/reviews`,
    );
    if (req.pageToken) url.searchParams.set('pageToken', req.pageToken);
    url.searchParams.set('pageSize', '50');

    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${req.accessToken}`,
        Accept: 'application/json',
      },
    });

    if (response.status === 429) {
      // Honor Retry-After if Google supplies it; otherwise the worker
      // picks the next bucket from its own backoff schedule.
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader
        ? Number(retryAfterHeader)
        : undefined;
      throw new GoogleBusinessRateLimitedError(
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new GoogleBusinessApiError(response.status, body);
    }

    // Parse defensively — the API surface returns optional `reviews` when
    // the location has none.
    const json = (await response.json()) as {
      reviews?: GoogleReviewApiPayload[];
      nextPageToken?: string;
      totalReviewCount?: number;
    };

    return {
      reviews: Array.isArray(json.reviews) ? json.reviews : [],
      nextPageToken: json.nextPageToken,
      totalReviewCount: json.totalReviewCount,
    };
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
