/**
 * Per-tenant fairness: a concurrency semaphore + token bucket.
 *
 * Two failure modes are visible to callers:
 *   - TenantConcurrencyExceededError: the per-tenant in-flight cap is full.
 *   - TenantTokenBudgetExceededError: the rolling token bucket is empty.
 *
 * Tier-driven defaults; callers pass an estimated input+output token cost to
 * `acquire()`. After completion, `reconcile()` adjusts the bucket using the
 * actual token usage from the provider response.
 */
import {
  tenantConcurrencyInFlight,
  tenantConcurrencyRejectTotal,
  tenantTokenBudgetExceededTotal,
} from '../../monitoring/metrics';

export type TenantTier = 'free' | 'standard' | 'premium' | string;

export interface TenantQuotaTierConfig {
  /** Max concurrent in-flight requests per tenant. */
  maxConcurrency: number;
  /** Token bucket capacity (input+output tokens). */
  bucketCapacity: number;
  /** Token refill rate per second. */
  refillTokensPerSec: number;
  /** Hard upper bound — when total in-flight bytes/tokens exceed this, reject regardless. */
  hardUpperBoundTokens: number;
}

export const DEFAULT_TIER_CONFIG: Record<TenantTier, TenantQuotaTierConfig> = {
  free: {
    maxConcurrency: 2,
    bucketCapacity: 50_000,
    refillTokensPerSec: 100,
    hardUpperBoundTokens: 200_000,
  },
  standard: {
    maxConcurrency: 8,
    bucketCapacity: 250_000,
    refillTokensPerSec: 500,
    hardUpperBoundTokens: 1_000_000,
  },
  premium: {
    maxConcurrency: 32,
    bucketCapacity: 1_000_000,
    refillTokensPerSec: 2_000,
    hardUpperBoundTokens: 4_000_000,
  },
};

export class TenantConcurrencyExceededError extends Error {
  readonly code = 'TENANT_CONCURRENCY_EXCEEDED';
  readonly retryAfterMs = 1_000;
  constructor(public readonly tenantId: string) {
    super(`Per-tenant concurrency cap exceeded for tenant ${tenantId}`);
    this.name = 'TenantConcurrencyExceededError';
  }
}

export class TenantTokenBudgetExceededError extends Error {
  readonly code = 'TENANT_TOKEN_BUDGET_EXCEEDED';
  readonly retryAfterMs: number;
  constructor(public readonly tenantId: string, retryAfterMs: number) {
    super(`Per-tenant token budget exceeded for tenant ${tenantId}`);
    this.retryAfterMs = retryAfterMs;
    this.name = 'TenantTokenBudgetExceededError';
  }
}

interface TenantState {
  inFlight: number;
  bucketTokens: number;
  lastRefillMs: number;
  totalReservedTokens: number;
}

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

export interface QuotaLease {
  release(actualInputTokens?: number, actualOutputTokens?: number): void;
}

export class TenantQuotaRegistry {
  private states: Map<string, TenantState> = new Map();

  constructor(
    private readonly tiers: Record<string, TenantQuotaTierConfig> = DEFAULT_TIER_CONFIG,
  ) {}

  private cfgFor(tier: TenantTier | undefined): TenantQuotaTierConfig {
    return this.tiers[tier ?? 'standard'] ?? this.tiers.standard;
  }

  private stateFor(tenantId: string, cfg: TenantQuotaTierConfig): TenantState {
    let s = this.states.get(tenantId);
    if (!s) {
      s = {
        inFlight: 0,
        bucketTokens: cfg.bucketCapacity,
        lastRefillMs: nowMs(),
        totalReservedTokens: 0,
      };
      this.states.set(tenantId, s);
    }
    return s;
  }

  private refill(state: TenantState, cfg: TenantQuotaTierConfig): void {
    const now = nowMs();
    const elapsedSec = (now - state.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    const add = elapsedSec * cfg.refillTokensPerSec;
    state.bucketTokens = Math.min(cfg.bucketCapacity, state.bucketTokens + add);
    state.lastRefillMs = now;
  }

  /**
   * Reserve a slot + estimated tokens. Throws on rejection. Returns a lease
   * that the caller MUST `release()` (in a finally block).
   */
  acquire(opts: {
    tenantId: string;
    tenantTier?: TenantTier;
    estimatedTokens: number;
  }): QuotaLease {
    const { tenantId, tenantTier, estimatedTokens } = opts;
    const cfg = this.cfgFor(tenantTier);
    const state = this.stateFor(tenantId, cfg);

    if (state.inFlight >= cfg.maxConcurrency) {
      tenantConcurrencyRejectTotal.inc({ tenant_tier: tenantTier ?? 'standard' });
      throw new TenantConcurrencyExceededError(tenantId);
    }

    this.refill(state, cfg);
    if (estimatedTokens > state.bucketTokens) {
      const deficit = estimatedTokens - state.bucketTokens;
      const retryAfterMs = Math.ceil((deficit / cfg.refillTokensPerSec) * 1000);
      tenantTokenBudgetExceededTotal.inc({ tenant_tier: tenantTier ?? 'standard' });
      throw new TenantTokenBudgetExceededError(tenantId, retryAfterMs);
    }
    if (
      state.totalReservedTokens + estimatedTokens > cfg.hardUpperBoundTokens
    ) {
      tenantTokenBudgetExceededTotal.inc({ tenant_tier: tenantTier ?? 'standard' });
      throw new TenantTokenBudgetExceededError(tenantId, 1_000);
    }

    state.inFlight++;
    state.bucketTokens -= estimatedTokens;
    state.totalReservedTokens += estimatedTokens;
    tenantConcurrencyInFlight.set({ tenant_tier: tenantTier ?? 'standard' }, state.inFlight);

    let released = false;
    return {
      release: (actualInput?: number, actualOutput?: number) => {
        if (released) return;
        released = true;
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.totalReservedTokens = Math.max(
          0,
          state.totalReservedTokens - estimatedTokens,
        );

        if (typeof actualInput === 'number' && typeof actualOutput === 'number') {
          const actual = actualInput + actualOutput;
          const delta = actual - estimatedTokens;
          if (delta > 0) {
            // Underestimated — drain the additional usage from the bucket.
            state.bucketTokens = Math.max(0, state.bucketTokens - delta);
          } else if (delta < 0) {
            // Overestimated — refund the unused tokens (capped to capacity).
            state.bucketTokens = Math.min(
              cfg.bucketCapacity,
              state.bucketTokens + (-delta),
            );
          }
        }

        tenantConcurrencyInFlight.set(
          { tenant_tier: tenantTier ?? 'standard' },
          state.inFlight,
        );
      },
    };
  }
}

/** Rough token estimator — char count / 4. Cheap; provider returns true count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
