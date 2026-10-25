/**
 * Per-tenant fairness: a concurrency semaphore + token bucket.
 *
 * Two failure modes are visible to callers:
 *   - TenantConcurrencyExceededError: the per-tenant in-flight cap is full.
 *   - TenantTokenBudgetExceededError: the rolling token bucket is empty.
 *
 * Tier-driven defaults; callers pass an estimated input+output token cost to
 * `acquire()`. The lease's `release()` then charges the provider's actual
 * usage instead: it refunds an overestimate and carries an underestimate as
 * debt. A failed call releases with no usage, so its estimate stays spent.
 */
import { z } from 'zod';
import { AppError } from '../../shared/errors';
import {
  tenantConcurrencyInFlight,
  tenantConcurrencyRejectTotal,
  tenantTokenBudgetExceededTotal,
} from '../../monitoring/metrics';

export type TenantTier = 'free' | 'standard' | 'premium' | string;

export interface TenantQuotaTierConfig {
  /** Max concurrent in-flight requests per tenant. */
  maxConcurrency: number;
  /**
   * Token bucket capacity (input+output tokens). Usage above a call's
   * reservation is carried as debt down to -bucketCapacity.
   */
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
  // Every non-classify call a tenant makes shares this bucket: chat replies,
  // drafting, summaries, and the per-turn sentiment and vulnerability
  // classifiers (~0.7–0.9k tokens each, every turn, when a tenant turns them
  // on). GATEWAY-01: ten callers with both on bill ~1.6k tok/s (a turn every
  // ~10s); at 500 tok/s that drained the bucket in about 3.5 minutes, and
  // both classifiers then scored most turns 0 without saying so. 5,000 tok/s
  // keeps that load under half the refill so drafting and chat keep the
  // rest; capacity is two minutes of refill. Sized for a busy tenant, not so
  // that concurrency binds (unlike classifier_standard below).
  standard: {
    maxConcurrency: 8,
    bucketCapacity: 600_000,
    refillTokensPerSec: 5_000,
    hardUpperBoundTokens: 1_000_000,
  },
  // Classifier calls carry the intent taxonomy: ~5k tokens on a phone
  // caller's turn (≤ the 9,000-token per-turn budget, session-cost-tracker
  // CLASSIFY_TURN_INPUT_TOKEN_BUDGET) and ~15–19k on the operator taxonomy
  // (owner line, in-app voice, chat, memos). They use an isolated bucket so
  // an operator burst cannot drain the ordinary task budget (or vice versa).
  // See ProviderTenantQuotaWrapper. Not reachable until a plan → tier
  // resolver exists, so not resized with the tiers below.
  classifier_free: {
    maxConcurrency: 1,
    bucketCapacity: 150_000,
    refillTokensPerSec: 250,
    hardUpperBoundTokens: 300_000,
  },
  // GATEWAY-01: this is the tier EVERY tenant's classify_intent runs on —
  // nothing in the product maps a tenant's plan to a quota tier yet (plans
  // differ by seats and included AI minutes only), so tenantTier is never set
  // on gateway requests. One classify call per live caller turn, in-app
  // command, chat or memo segment, and confirm read-back; the caps are
  // cluster-wide per tenant.
  //
  // Concurrency: by Little's law, ~3s classify latency and a turn every ~10s
  // per session, 8 slots carry ~25 concurrent sessions on average (and 8 even
  // when every call runs to the 12s deadline: a session has one turn in
  // flight at a time).
  //
  // Bucket: sized so that concurrency, not tokens, is the limit at that load.
  // 8 slots / 3s ≈ 2.7 calls/s, each billing at most the 9,000-token per-turn
  // input budget plus the 1,024-token output allowance ≈ 26.7k tok/s, rounded
  // up to 30,000 tok/s; capacity is two minutes of refill. That is at most
  // 108M tokens an hour per tenant, plus the 3.6M burst. It was 1,000 tok/s
  // (≈ 400 classify calls an hour), which ten callers emptied in under three
  // minutes. Pinned by test/ai/gateway/tenant-quota-sustained-load.test.ts.
  // An operator-heavy mix (more than about a quarter of calls on the ~17k
  // operator prompt) at full concurrency can still reach the bucket first.
  // This is a fairness cap, not a spend cap: spend is for the per-tenant
  // money cap (U8, pending) and the ai_spend_window alert.
  //
  // Resize without a deploy via AI_QUOTA_TIERS_JSON. Raise refillTokensPerSec
  // with maxConcurrency (~3,750 tok/s a slot), or the bucket binds first.
  classifier_standard: {
    maxConcurrency: 8,
    bucketCapacity: 3_600_000,
    refillTokensPerSec: 30_000,
    hardUpperBoundTokens: 1_200_000,
  },
  // Twice classifier_standard on concurrency and on both bucket figures (same
  // derivation: 16 slots / 3s × 10,024 ≈ 53.5k → 60,000 tok/s), and never
  // below it on any limit, so wiring a plan → tier resolver later can only
  // ever raise a tenant's classify capacity.
  classifier_premium: {
    maxConcurrency: 16,
    bucketCapacity: 7_200_000,
    refillTokensPerSec: 60_000,
    hardUpperBoundTokens: 4_000_000,
  },
  // Four times `standard` on concurrency and on both bucket figures.
  premium: {
    maxConcurrency: 32,
    bucketCapacity: 2_400_000,
    refillTokensPerSec: 20_000,
    hardUpperBoundTokens: 4_000_000,
  },
};

/** Wait hint on a concurrency rejection: a slot frees when any in-flight call ends. */
const CONCURRENCY_RETRY_AFTER_MS = 1_000;

/**
 * Both quota rejections are typed 429 AppErrors (GATEWAY-01). The gateway
 * rethrows an AppError unchanged, so `code` and `retryAfterMs` reach the
 * caller: the voice path files them as quota (not a provider fault) and the
 * in-app audit's CLASSIFIER_QUOTA_CODES match. As plain Errors they were
 * re-wrapped as LLM_PROVIDER_ERROR 502 and both were lost.
 */
export class TenantConcurrencyExceededError extends AppError {
  readonly retryAfterMs = CONCURRENCY_RETRY_AFTER_MS;
  constructor(public readonly tenantId: string) {
    super(
      'TENANT_CONCURRENCY_EXCEEDED',
      `Per-tenant concurrency cap exceeded for tenant ${tenantId}`,
      429,
      { retryAfterMs: CONCURRENCY_RETRY_AFTER_MS },
    );
    this.name = 'TenantConcurrencyExceededError';
  }
}

export class TenantTokenBudgetExceededError extends AppError {
  readonly retryAfterMs: number;
  constructor(public readonly tenantId: string, retryAfterMs: number) {
    super(
      'TENANT_TOKEN_BUDGET_EXCEEDED',
      `Per-tenant token budget exceeded for tenant ${tenantId}`,
      429,
      { retryAfterMs },
    );
    this.retryAfterMs = retryAfterMs;
    this.name = 'TenantTokenBudgetExceededError';
  }
}

const tierConfigSchema = z
  .object({
    maxConcurrency: z.number().int().positive(),
    bucketCapacity: z.number().int().positive(),
    refillTokensPerSec: z.number().positive(),
    hardUpperBoundTokens: z.number().int().positive(),
  })
  .strict();

const tierOverridesSchema = z.record(
  // Tier names are lowercase identifiers (e.g. classifier_standard).
  z.string().regex(/^[a-z][a-z0-9_]*$/, 'tier names are lowercase identifiers'),
  tierConfigSchema.partial(),
);

/**
 * The effective quota tier table: DEFAULT_TIER_CONFIG with AI_QUOTA_TIERS_JSON
 * merged over it, so a tier can be resized without a deploy. The env value is
 * a JSON object of `{ "<tier>": { maxConcurrency?, bucketCapacity?,
 * refillTokensPerSec?, hardUpperBoundTokens? } }`. A known tier may override
 * any subset of fields; a NEW tier must give all four.
 *
 * Unlike AI_MODEL_PRICING_JSON (which fails safe to "unknown cost"), a bad
 * value THROWS: a quota table that silently fell back to defaults would leave
 * ops believing a tenant had been resized when it had not. The factory calls
 * this while building the gateway, so the API refuses to boot instead.
 */
export function resolveQuotaTierConfig(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, TenantQuotaTierConfig> {
  const raw = env.AI_QUOTA_TIERS_JSON;
  if (!raw || raw.trim() === '') return { ...DEFAULT_TIER_CONFIG };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AI_QUOTA_TIERS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const overrides = tierOverridesSchema.safeParse(parsed);
  if (!overrides.success) {
    throw new Error(`AI_QUOTA_TIERS_JSON is invalid: ${overrides.error.message}`);
  }

  const tiers: Record<string, TenantQuotaTierConfig> = { ...DEFAULT_TIER_CONFIG };
  for (const [tier, fields] of Object.entries(overrides.data)) {
    const base = Object.hasOwn(DEFAULT_TIER_CONFIG, tier) ? DEFAULT_TIER_CONFIG[tier] : {};
    const merged = tierConfigSchema.safeParse({ ...base, ...fields });
    if (!merged.success) {
      throw new Error(
        `AI_QUOTA_TIERS_JSON tier "${tier}" is not a built-in tier, so it needs all of ` +
          `maxConcurrency, bucketCapacity, refillTokensPerSec, hardUpperBoundTokens: ` +
          merged.error.message,
      );
    }
    tiers[tier] = merged.data;
  }
  return tiers;
}

interface TenantState {
  inFlight: number;
  bucketTokens: number;
  lastRefillMs: number;
  totalReservedTokens: number;
  lastTouchedMs: number;
}

/** States older than this with zero in-flight requests are pruned. */
const TENANT_STATE_IDLE_TTL_MS = 30 * 60 * 1000;
/** Cap on tracked tenants — after this, prune the oldest idle entries. */
const TENANT_STATE_MAX_ENTRIES = 10_000;

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

export interface QuotaLease {
  /** Release the slot + reconcile tokens against actual usage. Idempotent. */
  release(actualInputTokens?: number, actualOutputTokens?: number): Promise<void>;
}

/**
 * Async quota seam (scale-to-1000 U3c). Both the process-local
 * `TenantQuotaRegistry` (default) and the cluster-wide `RedisTenantQuotaStore`
 * implement this so the resilience wrapper is impl-agnostic. `acquire` throws
 * `TenantConcurrencyExceededError` / `TenantTokenBudgetExceededError` on
 * rejection (unchanged envelope); on success it resolves a lease the caller
 * MUST `release()` in a finally.
 */
export interface QuotaStore {
  acquire(opts: {
    tenantId: string;
    tenantTier?: TenantTier;
    estimatedTokens: number;
  }): Promise<QuotaLease>;
}

export class TenantQuotaRegistry implements QuotaStore {
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
      this.maybePrune();
      s = {
        inFlight: 0,
        bucketTokens: cfg.bucketCapacity,
        lastRefillMs: nowMs(),
        totalReservedTokens: 0,
        lastTouchedMs: nowMs(),
      };
      this.states.set(tenantId, s);
    } else {
      s.lastTouchedMs = nowMs();
    }
    return s;
  }

  /**
   * Best-effort pruning: drop idle entries past the TTL when the table
   * grows large. Called from the cold path (state creation) so the hot
   * path never pays for the scan.
   */
  private maybePrune(): void {
    if (this.states.size < TENANT_STATE_MAX_ENTRIES) return;
    const cutoff = nowMs() - TENANT_STATE_IDLE_TTL_MS;
    for (const [id, s] of this.states) {
      if (s.inFlight === 0 && s.lastTouchedMs < cutoff) {
        this.states.delete(id);
      }
    }
  }

  /** Test-only: count tracked tenants. */
  trackedTenantCount(): number {
    return this.states.size;
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
  async acquire(opts: {
    tenantId: string;
    tenantTier?: TenantTier;
    estimatedTokens: number;
  }): Promise<QuotaLease> {
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
      release: async (actualInput?: number, actualOutput?: number) => {
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
            // Underestimated — charge the additional usage. GATEWAY-05: carry
            // it as debt (down to -bucketCapacity) rather than forgiving it
            // at 0, so later calls wait for the refill to pay it back.
            state.bucketTokens = Math.max(-cfg.bucketCapacity, state.bucketTokens - delta);
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

/**
 * Delegating quota store that starts in-memory and swaps to the cluster-wide
 * Redis store once connected — mirrors the connection-registry's sync-return +
 * async-upgrade so the (synchronous) gateway factory stays unchanged. Acquires
 * during the brief boot window are per-replica; once swapped they are
 * cluster-wide. The quota is a fairness cap, so a sub-second per-replica window
 * at boot is acceptable.
 */
class SwappableQuotaStore implements QuotaStore {
  private impl: QuotaStore;
  constructor(tiers: Record<string, TenantQuotaTierConfig>) {
    this.impl = new TenantQuotaRegistry(tiers);
  }
  swap(next: QuotaStore): void {
    this.impl = next;
  }
  acquire(opts: {
    tenantId: string;
    tenantTier?: TenantTier;
    estimatedTokens: number;
  }): Promise<QuotaLease> {
    return this.impl.acquire(opts);
  }
}

/**
 * Select the quota store by REDIS_URL. Returns SYNCHRONOUSLY (in-memory) and,
 * when REDIS_URL is set, upgrades to the cluster-wide Redis store in the
 * background (falling back to in-memory if the connect fails). Byte-identical to
 * the in-memory registry when REDIS_URL is unset.
 */
export function createTenantQuotaStore(
  redisUrl?: string,
  tiers: Record<string, TenantQuotaTierConfig> = DEFAULT_TIER_CONFIG,
): QuotaStore {
  if (!redisUrl) return new TenantQuotaRegistry(tiers);
  const store = new SwappableQuotaStore(tiers);
  void import('./redis-tenant-quota')
    .then(({ createRedisTenantQuotaStore }) => createRedisTenantQuotaStore(redisUrl, tiers))
    .then((redisStore) => {
      if (redisStore) store.swap(redisStore);
    })
    .catch(() => {
      // Redis unavailable — stay in-memory (per-replica quota).
    });
  return store;
}
