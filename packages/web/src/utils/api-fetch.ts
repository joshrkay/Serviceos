/**
 * Auth-aware fetch wrapper.
 *
 * Reads the Clerk session token (when available) and attaches it as a
 * Bearer token on every outgoing API request.  Falls through gracefully
 * when Clerk isn't loaded (e.g. public pages).
 */

let getToken: (() => Promise<string | null>) | null = null;

/** Called once from ClerkProvider setup to wire the token getter. */
export function setTokenGetter(fn: () => Promise<string | null>) {
  getToken = fn;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = getToken ? await getToken() : null;

  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Only set Content-Type for non-FormData bodies
  if (init.body && !(init.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  return fetch(input, { ...init, headers });
}
