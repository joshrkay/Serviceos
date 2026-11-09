/**
 * The public demo line's inbound caps.
 *
 * One real number is attached to a seeded demo tenant (scripts/attach-demo-number.ts)
 * and published, so anyone can dial it and every answered second costs money.
 * Three caps keep that bounded; all of them apply to demo tenants only, and a
 * real tenant's call never reaches any of this code's refusals:
 *
 *   - per caller: `DEMO_INBOUND_PER_CALLER_DAILY` calls per trailing 24 h,
 *     keyed on the Twilio `From` number;
 *   - in total:   `DEMO_INBOUND_DAILY_TOTAL` calls per trailing 24 h;
 *   - per call:   `DEMO_INBOUND_MAX_SECONDS`, enforced by the voice
 *     transports' own max-call-duration cap through
 *     {@link DemoInboundGuard.maxCallDurationMsFor}.
 *
 * The two counters are `phone_rate_limits` rows on the platform tenant — the
 * same place the outbound demo call spends its visitor allowance, for the same
 * reason: a demo tenant's reset empties every table the tenant owns, so a
 * counter on the demo tenant itself would be wiped by the next outbound lease.
 * The number is stored as an HMAC (`hashDemoPhone`), never in the clear.
 *
 * Deliberately NOT built on `call-budget.ts`: that table is the outbound demo
 * call's own per-UTC-day budget (cents-aware, paged to the operator, released
 * when a call provably never existed). Sharing it would let abuse of the
 * public number use up the outbound demo's budget, and the caps would come
 * from two sets of variables.
 *
 * Fails closed for the demo line (a counter that cannot be read refuses the
 * call), and open for everyone else (a demo check that cannot be read treats
 * the call as an ordinary one — the voice gate then blocks an unbilled demo
 * tenant anyway, so the failure can never grant the demo's gate bypass).
 */
import { normalizeE164 } from '../integrations/twilio/phone-number-repository';
import type { PhoneRateLimiter } from '../shared/rate-limit/phone-rate-limit';
import { DEFAULT_DEMO_INBOUND_MAX_SECONDS, type DemoInboundConfig } from './config';
import { DEMO_PLATFORM_TENANT_ID } from './platform-tenant';
import { hashDemoPhone } from './service';

export const DEMO_INBOUND_CALLER_SCOPE = 'demo_inbound_caller';
export const DEMO_INBOUND_TOTAL_SCOPE = 'demo_inbound_total';
/** The one key every demo call counts under for the line's daily total. */
const DEMO_INBOUND_TOTAL_KEY = 'all';
/** "Daily" is a trailing 24 h window, as the outbound demo's visitor allowance is. */
export const DEMO_INBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DemoInboundRefusal = 'caller_limit' | 'daily_total' | 'unavailable';

export type DemoInboundVerdict =
  | { demo: false }
  | { demo: true; allowed: true }
  | { demo: true; allowed: false; reason: DemoInboundRefusal };

export interface DemoInboundGuard {
  /** Decide an inbound call to `tenantId` from `from`; consumes the caps when it is a demo tenant's call. */
  check(input: { tenantId: string; from: string }): Promise<DemoInboundVerdict>;
  /** The per-call time limit for a demo tenant, else undefined (no override). Never throws. */
  maxCallDurationMsFor(tenantId: string): Promise<number | undefined>;
}

export interface DemoInboundGuardDeps {
  config: DemoInboundConfig;
  /** True for a demo-pool (or platform) tenant. May throw; see the module comment. */
  isDemoTenant: (tenantId: string) => Promise<boolean>;
  limiter: Pick<PhoneRateLimiter, 'tryConsume'>;
  /** HMAC key for the caller's number (the demo lease secret). */
  phoneKeySecret: string;
  logger?: { warn(msg: string, ctx?: Record<string, unknown>): void };
}

export function createDemoInboundGuard(deps: DemoInboundGuardDeps): DemoInboundGuard {
  const warn = (msg: string, ctx: Record<string, unknown>) => deps.logger?.warn(msg, ctx);

  /** null: could not tell. */
  async function demoOrNull(tenantId: string): Promise<boolean | null> {
    try {
      return await deps.isDemoTenant(tenantId);
    } catch (err) {
      warn('demo inbound: demo-tenant check failed — treating the call as an ordinary one', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return {
    async check({ tenantId, from }) {
      if ((await demoOrNull(tenantId)) !== true) return { demo: false };

      if (!deps.config.open) {
        warn('demo inbound: line closed by bad configuration — refusing the call', {
          tenantId,
          reason: deps.config.reason,
        });
        return { demo: true, allowed: false, reason: 'unavailable' };
      }
      const { perCallerDaily, dailyTotal } = deps.config.limits;

      try {
        // Per caller first: a number over its own limit must never spend the
        // shared total, or one number redialing could drain the whole day.
        // (The converse — a caller's allowance spent on a call the full total
        // then refuses — is accepted: nobody is answered until the window rolls.)
        const callerKey = hashDemoPhone(normalizeE164(from), deps.phoneKeySecret);
        const callerOk = await deps.limiter.tryConsume(
          DEMO_PLATFORM_TENANT_ID,
          DEMO_INBOUND_CALLER_SCOPE,
          callerKey,
          perCallerDaily,
          DEMO_INBOUND_WINDOW_MS,
        );
        if (!callerOk) return { demo: true, allowed: false, reason: 'caller_limit' };

        const totalOk = await deps.limiter.tryConsume(
          DEMO_PLATFORM_TENANT_ID,
          DEMO_INBOUND_TOTAL_SCOPE,
          DEMO_INBOUND_TOTAL_KEY,
          dailyTotal,
          DEMO_INBOUND_WINDOW_MS,
        );
        if (!totalOk) return { demo: true, allowed: false, reason: 'daily_total' };
      } catch (err) {
        warn('demo inbound: counters unavailable — refusing the call', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { demo: true, allowed: false, reason: 'unavailable' };
      }
      return { demo: true, allowed: true };
    },

    async maxCallDurationMsFor(tenantId) {
      if ((await demoOrNull(tenantId)) !== true) return undefined;
      const seconds = deps.config.open ? deps.config.limits.maxCallSeconds : DEFAULT_DEMO_INBOUND_MAX_SECONDS;
      return seconds * 1000;
    },
  };
}

/**
 * Spoken to a demo caller who is over a cap (or when the line is closed),
 * then the call ends. No apostrophes: the text goes into TwiML unescaped.
 */
export function demoLimitReachedTwiml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    '<Say voice="Polly.Joanna">Thanks for trying our demo line. ' +
    'This demo has reached its limit for now, so we are not able to take your call. ' +
    'Please visit our website to learn more, or try again tomorrow. Goodbye.</Say>' +
    '<Hangup/></Response>'
  );
}
