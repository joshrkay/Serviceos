/**
 * P8-015 — production RecoveryRateLimiter: binds the generic PhoneRateLimiter
 * (shared/rate-limit) to the recovery scope/limit/window the handler defines.
 *
 * The binding lives here (not in shared/rate-limit/) because "one recovery
 * SMS per caller per 5 minutes" is recovery-domain knowledge — the shared
 * limiter stays deliberately ignorant of phone/SMS semantics.
 *
 * Mapping is the load-bearing part (P0-036):
 *   - check  → PhoneRateLimiter.check   (non-consuming — records NOTHING)
 *   - record → PhoneRateLimiter.tryConsume (post-send, consumes one token)
 * Inverting it (check→tryConsume) would burn the caller's single token on
 * every suppressed or failed attempt and strand rows as `rate_limited`.
 */
import type { Logger } from '../../logging/logger';
import type { PhoneRateLimiter } from '../../shared/rate-limit/phone-rate-limit';
import {
  RECOVERY_RATE_LIMIT_MAX,
  RECOVERY_RATE_LIMIT_SCOPE,
  RECOVERY_RATE_LIMIT_WINDOW_MS,
  type RecoveryRateLimiter,
} from './dropped-call-handler';

export function createRecoveryRateLimiter(
  limiter: PhoneRateLimiter,
  logger: Logger,
): RecoveryRateLimiter {
  return {
    async check(tenantId: string, callerE164: string): Promise<boolean> {
      return limiter.check(
        tenantId,
        RECOVERY_RATE_LIMIT_SCOPE,
        callerE164,
        RECOVERY_RATE_LIMIT_MAX,
        RECOVERY_RATE_LIMIT_WINDOW_MS,
      );
    },
    async record(tenantId: string, callerE164: string): Promise<void> {
      const consumed = await limiter.tryConsume(
        tenantId,
        RECOVERY_RATE_LIMIT_SCOPE,
        callerE164,
        RECOVERY_RATE_LIMIT_MAX,
        RECOVERY_RATE_LIMIT_WINDOW_MS,
      );
      if (!consumed) {
        // Benign check↔consume race (documented in phone-rate-limit.ts): the
        // SMS already went out, so there is nothing to roll back — log for
        // observability, never throw back into the handler's send path.
        logger.warn('recovery rate-limit record hit the cap post-send', {
          tenantId,
          callerE164,
        });
      }
    },
  };
}
