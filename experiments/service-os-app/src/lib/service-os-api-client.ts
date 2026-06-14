import { auth } from '@clerk/nextjs/server';

function apiBase(): string {
  const base = process.env.SERVICE_OS_API_URL ?? process.env.NEXT_PUBLIC_SERVICE_OS_API_URL;
  if (!base) {
    return 'http://localhost:3000';
  }
  return base.replace(/\/$/, '');
}

/**
 * Server-side fetch to the canonical Express API (packages/api).
 * Forwards the Clerk session JWT as Bearer — same contract as packages/web apiFetch.
 */
export async function serviceOsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(url, { ...init, headers });
}
