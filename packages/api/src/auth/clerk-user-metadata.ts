/**
 * CLERK-META-2026-09-27 — shared Clerk Backend API client for a user's
 * public_metadata (the carrier of `tenant_id` / `role` into the JWT).
 *
 * Shared by the `user.created` webhook (webhooks/routes.ts), the
 * request-time recovery (middleware/tenant-context.ts), and the hourly
 * reconciliation sweep (workers/clerk-metadata-backfill-sweep.ts).
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

/**
 * One bounded call to the Clerk Backend API. GET and PATCH differ only in
 * method/body, so both public helpers ride on this.
 */
async function clerkApiCall(
  client: ClerkMetadataClient,
  clerkUserId: string,
  method: 'GET' | 'PATCH',
  body?: string,
): Promise<ClerkMetadataResult & { json?: unknown }> {
  const fetchFn = client.fetchFn ?? fetch;
  // GET leaves method/body unset (fetch defaults); PATCH sets both.
  const init: RequestInit = {
    ...(method === 'PATCH' ? { method, body } : {}),
    headers: {
      Authorization: `Bearer ${client.secretKey}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    // fetch has no default timeout; a stalled Clerk upstream would pin
    // the webhook handler or request that awaits this call.
    signal: AbortSignal.timeout(CLERK_API_TIMEOUT_MS),
  };
  try {
    const res = await fetchFn(
      `${CLERK_API_BASE_URL}/users/${encodeURIComponent(clerkUserId)}`,
      init,
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        errorBody: (await res.text()).slice(0, 500),
      };
    }
    return {
      ok: true,
      status: res.status,
      json: method === 'GET' ? await res.json() : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      transportError: err instanceof Error ? err.message : String(err),
    };
  }
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
  const result = await clerkApiCall(
    client,
    clerkUserId,
    'PATCH',
    JSON.stringify({ public_metadata: publicMetadata }),
  );
  delete result.json;
  return result;
}

/** GET a Clerk user and return their public_metadata. */
export async function readClerkUserMetadata(
  client: ClerkMetadataClient,
  clerkUserId: string,
): Promise<ClerkUserMetadataRead> {
  const { json, ...result } = await clerkApiCall(client, clerkUserId, 'GET');
  if (!result.ok) return result;
  const publicMetadata =
    (json as { public_metadata?: Record<string, unknown> } | null)
      ?.public_metadata ?? {};
  return { ...result, publicMetadata };
}

/** Human-readable one-liner for logs from a failed ClerkMetadataResult. */
export function describeClerkFailure(result: ClerkMetadataResult): string {
  if (result.transportError) return `transport error: ${result.transportError}`;
  return `HTTP ${result.status}${result.errorBody ? ` — ${result.errorBody}` : ''}`;
}
