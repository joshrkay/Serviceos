import { createHash, randomUUID } from 'crypto';

/**
 * Idempotency for provider creates whose response can be lost after the
 * provider acted (a timeout, a dropped socket, a double-click).
 *
 * Stripe caches a key's RESULT — success OR error — for at least 24 h and
 * replays it (`Idempotent-Replayed: true`) to every later request with that
 * key. So:
 *
 *   - the key is `<scope>:<parameter digest>`. The scope names the tenant and
 *     purpose; the digest keeps it valid under Stripe's rule that a reused key
 *     must carry identical parameters. It never rotates on its own, so a
 *     lost-response retry gets the first object back however long it waits
 *     (within Stripe's 24 h).
 *   - a replayed ERROR is Stripe's answer to an EARLIER attempt, so the
 *     request is sent once more under a fresh key: a cached error never blocks
 *     the next real attempt. That includes a replayed 5xx, which Stripe calls
 *     indeterminate; accepted here because every call site absorbs a duplicate
 *     (conditional persist, a pre-read, or an object nobody uses).
 *   - 409 means another request with the same key is still executing (the
 *     double-click): wait briefly and resend the same key, so the second click
 *     gets the first one's result.
 */
const IN_PROGRESS_RETRY_DELAYS_MS = [500, 1_000];

export function deterministicIdempotencyKey(scope: string, params: URLSearchParams | string): string {
  const digest = createHash('sha256').update(String(params)).digest('hex').slice(0, 24);
  return `${scope}:${digest}`;
}

/** The parts of a fetch response the retry policy reads. */
interface ProviderResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Send a create with an Idempotency-Key from `deterministicIdempotencyKey`
 * and the replay/409 policy above. `send` performs the request with the key
 * it is given and returns the provider response untouched.
 */
export async function sendIdempotentCreate<R extends ProviderResponse>(
  scope: string,
  params: URLSearchParams | string,
  send: (idempotencyKey: string) => Promise<R>,
  /** Waits before resending on 409; a slow request (a charge) needs longer. */
  inProgressRetryDelaysMs: readonly number[] = IN_PROGRESS_RETRY_DELAYS_MS,
): Promise<R> {
  const key = deterministicIdempotencyKey(scope, params);
  let res = await send(key);
  for (const delayMs of inProgressRetryDelaysMs) {
    if (res.status !== 409) break;
    await pause(delayMs);
    res = await send(key);
  }
  const replayedError =
    !res.ok && res.status !== 409 && res.status !== 429 && res.headers?.get?.('Idempotent-Replayed') === 'true';
  if (replayedError) {
    res = await send(`${key}:${randomUUID()}`);
  }
  return res;
}
