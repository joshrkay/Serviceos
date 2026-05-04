/**
 * P12-002 — typed wrappers for the `/api/me` endpoints introduced by P12-001.
 *
 * These functions accept a `fetch`-shaped client (from `useApiClient`) so
 * the Clerk JWT is attached automatically. They do not call hooks
 * themselves — the calling hook (`useMe`) owns the auth wiring.
 */

export type Mode = 'supervisor' | 'tech' | 'both';

export interface MeResponse {
  user_id: string;
  tenant_id: string;
  role: string;
  can_field_serve: boolean;
  current_mode: Mode;
  mode_changed_at: string | null;
  permissions: string[];
  backup_supervisor_user_id: string | null;
  unsupervised_proposal_routing:
    | 'queue_and_sms'
    | 'queue_only'
    | 'escalate_to_oncall';
}

export type AuthedFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** GET /api/me — returns the authenticated user + tenant settings shape. */
export async function fetchMe(client: AuthedFetch): Promise<MeResponse> {
  const res = await client('/api/me');
  if (!res.ok) {
    throw new Error(`fetchMe: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MeResponse;
}

/**
 * POST /api/me/mode — changes the authenticated user's current mode.
 *
 * Returns nothing on success (the API responds 204). Throws on:
 *  - 400 invalid mode value (caller validated upstream — should not happen)
 *  - 403 user lacks `can_field_serve` for `tech` / `both`
 *  - any 5xx
 *
 * Caller should refetch `me` after a successful switch (the server-side
 * 60s middleware cache means the new mode is authoritative immediately
 * for THIS process; other instances see the new value within 60s).
 */
export async function postModeSwitch(
  client: AuthedFetch,
  mode: Mode,
): Promise<void> {
  const res = await client('/api/me/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });

  if (res.status === 204) return;

  // Try to surface the server's error code/body for the caller to
  // render. Failure-soft if the body isn't JSON.
  let detail = '';
  try {
    const body = await res.json();
    detail =
      typeof body?.message === 'string'
        ? body.message
        : JSON.stringify(body);
  } catch {
    /* ignore non-JSON body */
  }

  throw new Error(
    `postModeSwitch (${mode}): ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`,
  );
}
