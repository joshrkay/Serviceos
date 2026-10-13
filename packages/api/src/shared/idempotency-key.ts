import { createHash } from 'crypto';

/**
 * Deterministic `Idempotency-Key` for a provider create whose response can be
 * lost after the provider acted (a timeout, a dropped connection, a
 * double-click). The same request retried sends the same key, so Stripe
 * replays the first object instead of creating a second one.
 *
 * `scope` names the tenant and purpose (e.g. `connect-account:<tenantId>`).
 * The digest of the request parameters is appended because Stripe rejects a
 * reused key whose parameters differ (400 idempotency_error): a retry with
 * changed parameters (another owner's email) gets a fresh key instead.
 *
 * Stripe keeps a key's result for at least 24 h, INCLUDING an error result:
 * an identical retry inside that window replays the first answer.
 */
export function deterministicIdempotencyKey(scope: string, params: URLSearchParams | string): string {
  const digest = createHash('sha256').update(String(params)).digest('hex').slice(0, 24);
  return `${scope}:${digest}`;
}
