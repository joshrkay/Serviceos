/**
 * A fake Stripe API that models idempotency the way Stripe documents it
 * (docs.stripe.com/api/idempotent_requests):
 *
 *   - the first request with a key executes, and its RESULT — success OR
 *     error — is cached per key; every later request with that key gets the
 *     cached result back with `Idempotent-Replayed: true`;
 *   - a request whose key is still executing gets 409 (idempotency_key_in_use);
 *   - execution finishes even when the client gave up (aborted): the effect
 *     lands and the result is cached, the client just never sees it;
 *   - a key reused with different parameters gets 400 idempotency_error.
 *
 * Not modelled: Stripe skips caching some errors (pre-execution validation,
 * 401, 429), scopes keys per Stripe-Account, and a real 500 may have acted.
 *
 * `answer` decides the outcome of each request that actually executes;
 * `executed` lists those requests (what Stripe really did).
 */
import { vi } from 'vitest';

export interface StripeCall {
  method: string;
  path: string;
  params: URLSearchParams;
  key?: string;
  account?: string;
}

export interface StripeOutcome {
  status?: number;
  body: unknown;
  /** Stripe takes this long to answer (fake setTimeout). */
  delayMs?: number;
}

function respond(status: number, body: unknown, replayed: boolean) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(replayed ? { 'Idempotent-Replayed': 'true' } : {}),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

export function fakeStripe(answer: (call: StripeCall) => StripeOutcome) {
  const cache = new Map<string, { status: number; body: unknown }>();
  const inFlight = new Set<string>();
  const executed: StripeCall[] = [];
  const paramsByKey = new Map<string, string>();

  const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: StripeCall = {
      method,
      path: url.pathname,
      params: new URLSearchParams(method === 'GET' ? url.search : String(init?.body ?? '')),
      key: headers['Idempotency-Key'],
      account: headers['Stripe-Account'],
    };
    const { key } = call;
    const firstParams = key ? paramsByKey.get(key) : undefined;
    if (key && firstParams !== undefined && firstParams !== String(call.params)) {
      const message = 'Keys for idempotent requests can only be used with the same parameters they were first used with.';
      return Promise.resolve(respond(400, { error: { type: 'idempotency_error', message } }, false));
    }
    if (key) paramsByKey.set(key, String(call.params));
    const cached = key ? cache.get(key) : undefined;
    if (cached) return Promise.resolve(respond(cached.status, cached.body, true));
    if (key && inFlight.has(key)) {
      return Promise.resolve(
        respond(409, { error: { type: 'idempotency_error', code: 'idempotency_key_in_use' } }, false),
      );
    }

    executed.push(call);
    const outcome = answer(call);
    const result = { status: outcome.status ?? 200, body: outcome.body };
    const finish = () => {
      if (!key) return;
      inFlight.delete(key);
      cache.set(key, result);
    };
    if (!outcome.delayMs) {
      finish();
      return Promise.resolve(respond(result.status, result.body, false));
    }
    if (key) inFlight.add(key);
    return new Promise<ReturnType<typeof respond>>((resolve, reject) => {
      setTimeout(() => {
        finish();
        resolve(respond(result.status, result.body, false));
      }, outcome.delayMs);
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });

  const executedOn = (method: string, path: string) =>
    executed.filter((c) => c.method === method && c.path === path);

  return { fetchFn, executed, executedOn };
}
