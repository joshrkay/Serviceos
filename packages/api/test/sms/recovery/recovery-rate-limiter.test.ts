/**
 * P8-015 — RecoveryRateLimiter adapter binding.
 *
 * The one bug this adapter can introduce is inverting the check/consume
 * mapping (check→tryConsume would burn the caller's single token on every
 * suppressed/failed attempt). These tests pin the mapping and the exact
 * scope/limit/window constants against a stub PhoneRateLimiter; the real
 * Postgres semantics are pinned in test/integration/dropped-call-worker.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRecoveryRateLimiter } from '../../../src/sms/recovery/recovery-rate-limiter';
import {
  RECOVERY_RATE_LIMIT_MAX,
  RECOVERY_RATE_LIMIT_SCOPE,
  RECOVERY_RATE_LIMIT_WINDOW_MS,
} from '../../../src/sms/recovery/dropped-call-handler';
import type { PhoneRateLimiter } from '../../../src/shared/rate-limit/phone-rate-limit';
import { createLogger } from '../../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function makeStubLimiter(overrides: Partial<Record<'check' | 'tryConsume', unknown>> = {}) {
  return {
    check: vi.fn(async () => true),
    tryConsume: vi.fn(async () => true),
    ...overrides,
  } as unknown as PhoneRateLimiter & {
    check: ReturnType<typeof vi.fn>;
    tryConsume: ReturnType<typeof vi.fn>;
  };
}

describe('createRecoveryRateLimiter', () => {
  it('check delegates to the NON-consuming limiter.check with the recovery constants', async () => {
    const stub = makeStubLimiter();
    const adapter = createRecoveryRateLimiter(stub, logger);

    const allowed = await adapter.check('tenant-1', '+15551234567');

    expect(allowed).toBe(true);
    expect(stub.check).toHaveBeenCalledTimes(1);
    expect(stub.check).toHaveBeenCalledWith(
      'tenant-1',
      RECOVERY_RATE_LIMIT_SCOPE,
      '+15551234567',
      RECOVERY_RATE_LIMIT_MAX,
      RECOVERY_RATE_LIMIT_WINDOW_MS,
    );
    // The inversion bug: check must never consume.
    expect(stub.tryConsume).not.toHaveBeenCalled();
  });

  it('check propagates a false (over limit) verdict', async () => {
    const stub = makeStubLimiter({ check: vi.fn(async () => false) });
    const adapter = createRecoveryRateLimiter(stub, logger);
    expect(await adapter.check('tenant-1', '+15551234567')).toBe(false);
  });

  it('record delegates to tryConsume with the same constants', async () => {
    const stub = makeStubLimiter();
    const adapter = createRecoveryRateLimiter(stub, logger);

    await adapter.record('tenant-1', '+15551234567');

    expect(stub.tryConsume).toHaveBeenCalledTimes(1);
    expect(stub.tryConsume).toHaveBeenCalledWith(
      'tenant-1',
      RECOVERY_RATE_LIMIT_SCOPE,
      '+15551234567',
      RECOVERY_RATE_LIMIT_MAX,
      RECOVERY_RATE_LIMIT_WINDOW_MS,
    );
    expect(stub.check).not.toHaveBeenCalled();
  });

  it('record logs but does not throw when tryConsume reports the cap (post-send race)', async () => {
    const stub = makeStubLimiter({ tryConsume: vi.fn(async () => false) });
    const adapter = createRecoveryRateLimiter(stub, logger);
    await expect(adapter.record('tenant-1', '+15551234567')).resolves.toBeUndefined();
  });
});
