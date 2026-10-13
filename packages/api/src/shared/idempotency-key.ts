import { createHash, randomUUID } from 'crypto';

/**
 * Idempotency for provider creates whose response can be lost after the
 * provider acted (a timeout, a dropped socket, a double-click).
 *
 * Stripe caches a key's RESULT — success OR error — for at least 24 h and
 * replays it (`Idempotent-Replayed: true`) to every later request with that
 * key. A key that never changes would therefore pin one Stripe 500, or one
 * "complete your platform profile" 400, onto every retry for a day. So:
 *
 *   - the key is `<scope>:<parameter digest>:w<window>`. The scope names the
 *     tenant and purpose; the digest keeps it valid under Stripe's rule that a
 *     reused key must carry identical parameters; the window rotates it every
 *     IDEMPOTENCY_KEY_WINDOW_MS (UTC-aligned).
 *   - a replayed ERROR is Stripe's answer to an EARLIER attempt, so the
 *     request is sent once more under a fresh key: a lost-response retry or a
 *     double-click still gets the first object back, but a cached error never
 *     blocks the next real attempt. If Stripe did not flag the replay, the next
 *     window's key ends the block.
 *   - 409 means another request with the same key is still executing (the
 *     double-click): wait briefly and resend the same key, so the second click
 *     gets the first one's result.
 *
 * Exposure: a create that timed out but succeeded and is retried in a LATER
 * window gets a new key and Stripe creates a second object. Each call site
 * says how it absorbs that (conditional persist, pre-check, harmless orphan).
 */
export const IDEMPOTENCY_KEY_WINDOW_MS = 10 * 60_000;
const IN_PROGRESS_RETRY_DELAYS_MS = [500, 1_000];

export function deterministicIdempotencyKey(
  scope: string,
  params: URLSearchParams | string,
  now: number = Date.now(),
): string {
  const digest = createHash('sha256').update(String(params)).digest('hex').slice(0, 24);
  return `${scope}:${digest}:w${Math.floor(now / IDEMPOTENCY_KEY_WINDOW_MS)}`;
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
): Promise<R> {
  const key = deterministicIdempotencyKey(scope, params);
  let res = await send(key);
  for (const delayMs of IN_PROGRESS_RETRY_DELAYS_MS) {
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
