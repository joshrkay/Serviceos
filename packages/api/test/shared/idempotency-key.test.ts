import { describe, expect, it } from 'vitest';
import { deterministicIdempotencyKey } from '../../src/shared/idempotency-key';

describe('deterministicIdempotencyKey', () => {
  const params = new URLSearchParams({ email: 'o@x.com', 'metadata[tenant_id]': 't-1' });
  const at = (iso: string) => Date.parse(iso);

  it('the same create inside one 10-minute window gets the same key', () => {
    expect(deterministicIdempotencyKey('customer:t-1:subscription', params, at('2026-10-13T12:00:05Z'))).toBe(
      deterministicIdempotencyKey('customer:t-1:subscription', params, at('2026-10-13T12:09:55Z')),
    );
  });

  it('the next window gets a new key, so a cached Stripe error cannot outlive it', () => {
    expect(deterministicIdempotencyKey('customer:t-1:subscription', params, at('2026-10-13T12:09:55Z'))).not.toBe(
      deterministicIdempotencyKey('customer:t-1:subscription', params, at('2026-10-13T12:10:05Z')),
    );
  });
});
