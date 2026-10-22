import { describe, expect, it } from 'vitest';
import { deterministicIdempotencyKey } from '../../src/shared/idempotency-key';

describe('deterministicIdempotencyKey', () => {
  const params = new URLSearchParams({ email: 'o@x.com', 'metadata[tenant_id]': 't-1' });

  it('the same create always gets the same key (a lost-response retry dedupes however late it comes)', () => {
    expect(deterministicIdempotencyKey('customer:t-1:subscription', params)).toBe(
      deterministicIdempotencyKey('customer:t-1:subscription', new URLSearchParams(params)),
    );
  });

  it('different parameters get a different key (Stripe rejects a reused key whose parameters changed)', () => {
    expect(deterministicIdempotencyKey('customer:t-1:subscription', params)).not.toBe(
      deterministicIdempotencyKey('customer:t-1:subscription', new URLSearchParams({ email: 'a@x.com', 'metadata[tenant_id]': 't-1' })),
    );
  });
});
