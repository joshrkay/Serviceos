/**
 * Typed wrappers for the `/api/me` endpoints — ported verbatim from
 * `packages/web/src/api/me.ts`. They accept a `fetch`-shaped client (from
 * `useApiClient`) so the Clerk JWT is attached automatically; they call no
 * hooks themselves.
 */
export type { Mode, MeResponse } from '@ai-service-os/shared';
import type { Mode, MeResponse } from '@ai-service-os/shared';

export type AuthedFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** GET /api/me — the authenticated user + tenant settings. */
export async function fetchMe(client: AuthedFetch): Promise<MeResponse> {
  const res = await client('/api/me');
  if (!res.ok) {
    throw new Error(`fetchMe: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MeResponse;
}

/**
 * POST /api/me/mode — change the authenticated user's current mode. Resolves on
 * the 204, throws on 400 (invalid mode), 403 (lacks `can_field_serve` for
 * `tech`/`both`), or 5xx — surfacing the server's message when present.
 */
export async function postModeSwitch(client: AuthedFetch, mode: Mode): Promise<void> {
  const res = await client('/api/me/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });

  if (res.status === 204) return;

  let detail = '';
  try {
    const body = (await res.json()) as { message?: unknown };
    detail = typeof body?.message === 'string' ? body.message : JSON.stringify(body);
  } catch {
    /* non-JSON body */
  }

  throw new Error(
    `postModeSwitch (${mode}): ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`,
  );
}
