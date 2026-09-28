/**
 * CLERK-META-2026-09-27 — shared Clerk Backend API client for a user's
 * public_metadata (the carrier of `tenant_id` / `role` into the JWT).
 *
 * Three call sites share these semantics, so they live here instead of being
 * re-implemented inline:
 *  - webhooks/routes.ts `user.created` (owner bootstrap): a failed write
 *    FAILS the webhook (500 → Clerk retries) instead of logging and
 *    returning 200.
 *  - middleware/tenant-context.ts: self-service recovery — a valid session
 *    whose JWT lacks tenant_id gets the metadata backfilled from the DB.
 *  - workers/clerk-metadata-backfill-sweep.ts: periodic reconciliation for
 *    users whose metadata is still missing after webhook retries exhaust.
 *
 * Every call is bounded (AbortSignal.timeout) — a stalled Clerk upstream must
 * never pin a webhook handler or a request transaction.
 */
import type { Logger } from '../logging/logger';

export const CLERK_API_TIMEOUT_MS = 10_000;
const CLERK_API_BASE_URL = 'https://api.clerk.com/v1';

export interface ClerkMetadataClient {
  secretKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  logger: Logger;
}

export interface ClerkMetadataResult {
  ok: boolean;
  /** HTTP status when Clerk answered; 0 on transport failure. */
  status: number;
  /** Truncated Clerk error body when !ok and Clerk answered. */
  errorBody?: string;
  /** Network/timeout/abort failure — Clerk may never have seen the request. */
  transportError?: string;
}

/** public_metadata as Clerk returns it on GET /v1/users/:id. */
export interface ClerkUserMetadataRead extends ClerkMetadataResult {
  publicMetadata?: Record<string, unknown>;
}

function clerkUserUrl(clerkUserId: string): string {
  return `${CLERK_API_BASE_URL}/users/${encodeURIComponent(clerkUserId)}`;
}

function authHeaders(secretKey: string): Record<string, string> {
  return { Authorization: `Bearer ${secretKey}` };
}

/**
 * PATCH a Clerk user's public_metadata. Clerk merges the object with the
 * existing metadata (it does not replace unrelated keys).
 */
export async function writeClerkUserMetadata(
  client: ClerkMetadataClient,
  clerkUserId: string,
  publicMetadata: Record<string, unknown>,
): Promise<ClerkMetadataResult> {
  const fetchFn = client.fetchFn ?? fetch;
  try {
    const res = await fetchFn(clerkUserUrl(clerkUserId), {
      method: 'PATCH',
      headers: {
        ...authHeaders(client.secretKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ public_metadata: publicMetadata }),
      // fetch has no default timeout; a stalled Clerk upstream would pin
      // the webhook handler or request that awaits this write.
      signal: AbortSignal.timeout(CLERK_API_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, status: res.status };
    const errorBody = (await res.text()).slice(0, 500);
    return { ok: false, status: res.status, errorBody };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      transportError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** GET a Clerk user and return their public_metadata. */
export async function readClerkUserMetadata(
  client: ClerkMetadataClient,
  clerkUserId: string,
): Promise<ClerkUserMetadataRead> {
  const fetchFn = client.fetchFn ?? fetch;
  try {
    const res = await fetchFn(clerkUserUrl(clerkUserId), {
      headers: authHeaders(client.secretKey),
      signal: AbortSignal.timeout(CLERK_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errorBody = (await res.text()).slice(0, 500);
      return { ok: false, status: res.status, errorBody };
    }
    const body = (await res.json()) as {
      public_metadata?: Record<string, unknown>;
    };
    return {
      ok: true,
      status: res.status,
      publicMetadata: body.public_metadata ?? {},
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      transportError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Human-readable one-liner for logs from a failed ClerkMetadataResult. */
export function describeClerkFailure(result: ClerkMetadataResult): string {
  if (result.transportError) return `transport error: ${result.transportError}`;
  return `HTTP ${result.status}${result.errorBody ? ` — ${result.errorBody}` : ''}`;
}
