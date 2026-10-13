/**
 * Test doubles for "the provider never answers".
 *
 * `hangingFetch` behaves like a blackholed socket: a request it hangs on only
 * settles when its AbortSignal fires (rejecting with `signal.reason`, as the
 * platform fetch does). A request sent with no signal hangs forever.
 *
 * `settleWithin` drives the fake clock: it lets the code under test reach its
 * provider call, advances `ms`, and reports whether the call settled.
 * Use it under `useProviderClock()` (fakes setTimeout only, so the real
 * setImmediate can still flush pending async work).
 */
import { vi } from 'vitest';

export type Settled<T> =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export interface FakeResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export function fakeJson(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Matcher = (url: string, init?: RequestInit) => boolean;
type Responder = (url: string, init?: RequestInit) => FakeResponse;

/**
 * A fetch that hangs on requests matching `hangOn` and answers the rest with
 * `respond`. Calls are recorded on the returned mock.
 */
export function hangingFetch(hangOn: Matcher = () => true, respond: Responder = () => fakeJson({})) {
  return vi.fn((input: string | URL | Request, init?: RequestInit): Promise<FakeResponse> => {
    const url = String(input);
    if (!hangOn(url, init)) return Promise.resolve(respond(url, init));
    return new Promise<FakeResponse>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no bound: hangs forever
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
}

/** Fake setTimeout only; the real setImmediate keeps flushing async work. */
export function useProviderClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let settled: Settled<T> = { status: 'pending' };
  promise.then(
    (value) => {
      settled = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      settled = { status: 'rejected', reason };
    },
  );
  await flushAsync();
  await vi.advanceTimersByTimeAsync(ms);
  await flushAsync();
  return settled;
}

/**
 * Like `settleWithin`, for code that also needs real I/O turns (an HTTP
 * request through supertest): advances the fake clock in `stepMs` steps,
 * yielding to the real event loop between steps.
 */
export async function settleWithinIo<T>(promise: Promise<T>, ms: number, stepMs = 250): Promise<Settled<T>> {
  let settled: Settled<T> = { status: 'pending' };
  promise.then(
    (value) => {
      settled = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      settled = { status: 'rejected', reason };
    },
  );
  for (let elapsed = 0; settled.status === 'pending' && elapsed <= ms; elapsed += stepMs) {
    for (let i = 0; i < 5; i += 1) await flushAsync();
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  for (let i = 0; i < 5; i += 1) await flushAsync();
  return settled;
}

/** Watch a promise's outcome while the test drives the fake clock with `advance`. */
export function track<T>(promise: Promise<T>): { readonly state: Settled<T> } {
  let state: Settled<T> = { status: 'pending' };
  promise.then(
    (value) => {
      state = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      state = { status: 'rejected', reason };
    },
  );
  return {
    get state() {
      return state;
    },
  };
}

export async function advance(ms: number): Promise<void> {
  await flushAsync();
  await vi.advanceTimersByTimeAsync(ms);
  await flushAsync();
}
