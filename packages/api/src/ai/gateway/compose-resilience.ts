/**
 * P2-029 — Resilience stack composition for LLMProvider.
 *
 * Provides LLMProvider-level wrappers for each resilience module plus a
 * factory helper that wires them in the canonical order:
 *
 *   primary → BreakerProvider → RetryProvider → FailoverProvider → TenantQuotaProvider
 *
 * Note on composition order vs. task spec:
 *   The spec says innermost-to-outermost:
 *     provider → retry → deadline → breaker → failover → tenant-quota → LLMGateway
 *
 *   At the LLMProvider level (before LLMGateway) we compose:
 *     primary → ProviderBreakerWrapper (enforces cell gate)
 *              → ProviderFailoverWrapper (tries next provider on 5xx/network)
 *              → ProviderTenantQuotaWrapper (outermost — quota is per-call)
 *
 *   Retry and deadline are applied *inside* ProviderBreakerWrapper so breaker
 *   counts only the final outcome of a retry sequence, not each individual
 *   attempt. The FailoverProvider wraps an array of breaker-wrapped providers
 *   so each candidate is independently protected.
 *
 * Single-provider scenario (P2-029):
 *   ProviderFailoverWrapper is constructed with a single-element list.
 *   On 5xx it exhausts the list and throws LLM_PROVIDER_UNAVAILABLE immediately.
 *   This is correct — the failover *ability* is wired; adding a second real
 *   provider in a follow-up story is purely additive.
 */

import { AppError } from '../../shared/errors';
import {
  CircuitBreakerRegistry,
  BreakerOpenError,
  type BreakerKeyParts,
  DEFAULT_BREAKER,
  type BreakerConfig,
} from './breaker';
import { runWithRetry, DEFAULT_RETRY, type RetryPolicy } from './retry';
import { adoptDeadline, STAGE_BUDGETS } from './deadline';
import {
  TenantQuotaRegistry,
  estimateTokens,
  DEFAULT_TIER_CONFIG,
  type TenantTier,
} from './tenant-quota';
import {
  gatewayRetryAttemptsTotal,
  gatewayFailoverTotal,
} from '../../monitoring/metrics';
import type { LLMProvider, LLMRequest, LLMResponse } from './gateway';

// ─── Helper: classify whether an error should trigger failover ────────────────

/**
 * Returns true when the error is a 5xx or network-level transient failure that
 * warrants advancing to the next provider.
 *
 * 4xx errors (other than 429) indicate bad input — they are NOT failover
 * triggers because the next provider would return the same error.
 * 429 (rate-limited) is treated as failover-eligible since a different
 * provider or model might not be rate-limited.
 */
function isFailoverEligible(err: unknown): boolean {
  if (!(err && typeof err === 'object')) return true; // unknown → assume transient
  const status =
    (err as { status?: number }).status ??
    (err as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return false; // permanent 4xx — do not failover
  }
  return true;
}

// ─── ProviderRetryDeadlineWrapper ────────────────────────────────────────────

/**
 * Wraps an LLMProvider with retry (exponential backoff + jitter) and a
 * per-request deadline (AbortSignal).
 *
 * Exposed as a named class (not an anonymous object literal) so the test
 * suite can traverse the wrapper chain for structural assertions.
 */
export class ProviderRetryDeadlineWrapper implements LLMProvider {
  readonly name: string;

  constructor(
    readonly inner: LLMProvider,
    private readonly retryPolicy: RetryPolicy,
    private readonly defaultDeadlineMs: number,
  ) {
    this.name = inner.name;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const totalMs = request.deadlineMs ?? this.defaultDeadlineMs;
    const deadline = adoptDeadline(totalMs, request.signal);

    try {
      return await runWithRetry(
        () => this.inner.complete({ ...request, signal: deadline.signal }),
        {
          policy: this.retryPolicy,
          deadline,
          provider: this.inner.name,
        },
      );
    } finally {
      deadline.abort();
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

// ─── ProviderBreakerWrapper ────────────────────────────────────────────────────

/**
 * Wraps an LLMProvider with circuit-breaker enforcement.
 *
 * The breaker key is derived from the provider name so each provider gets its
 * own cell. A `cellKeyOverride` can be supplied to share a cell across
 * wrappers (useful in tests).
 */
export class ProviderBreakerWrapper implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly registry: CircuitBreakerRegistry,
    private readonly cellKeyOverride?: string,
  ) {
    this.name = inner.name;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const modelFamily = (request.model ?? 'unknown').split(/[/-]/, 1)[0] || 'unknown';
    const parts: BreakerKeyParts = this.cellKeyOverride
      ? {
          provider: this.cellKeyOverride,
          modelFamily,
          tenantTier: request.tenantTier,
        }
      : {
          provider: this.inner.name,
          modelFamily,
          tenantTier: request.tenantTier,
        };

    return this.registry.run(parts, () => this.inner.complete(request));
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

// ─── ProviderFailoverWrapper ──────────────────────────────────────────────────

/**
 * Wraps an ordered list of LLMProviders and advances to the next on any
 * failover-eligible error (5xx / network / BreakerOpenError).
 *
 * 4xx validation errors are re-thrown immediately without trying the next
 * provider — they indicate bad input, not provider health.
 *
 * On full exhaustion (all providers failed with failover-eligible errors),
 * throws AppError with code LLM_PROVIDER_UNAVAILABLE (HTTP 503).
 *
 * `providerPath` is populated on the response with the ordered list of
 * provider:model entries that were attempted.
 */
export class ProviderFailoverWrapper implements LLMProvider {
  readonly name: string;

  constructor(private readonly providers: LLMProvider[]) {
    if (providers.length === 0) throw new Error('ProviderFailoverWrapper requires at least one provider');
    this.name = providers[0].name;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const path: string[] = [];
    let lastErr: unknown;

    for (const provider of this.providers) {
      path.push(`${provider.name}:${request.model}`);
      try {
        const response = await provider.complete(request);
        // Annotate the response with the accumulated providerPath
        return { ...response, providerPath: [...path] };
      } catch (err) {
        lastErr = err;

        // 4xx validation errors → do not failover, re-throw immediately
        if (!isFailoverEligible(err)) {
          throw err;
        }

        // Record failover metric (from → to) if there is a next provider
        const nextIndex = this.providers.indexOf(provider) + 1;
        if (nextIndex < this.providers.length) {
          gatewayFailoverTotal.inc({
            from_provider: provider.name,
            to_provider: this.providers[nextIndex].name,
          });
        }
        // Continue to next provider
      }
    }

    // All providers exhausted
    const retryAfterMs =
      lastErr instanceof BreakerOpenError ? lastErr.retryAfterMs : 1_000;

    throw new AppError(
      'LLM_PROVIDER_UNAVAILABLE',
      `All providers failed. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      503,
      {
        providerPath: path,
        retryAfterMs,
      },
    );
  }

  async isAvailable(): Promise<boolean> {
    // Available if any provider is available
    for (const p of this.providers) {
      if (await p.isAvailable()) return true;
    }
    return false;
  }
}

// ─── ProviderTenantQuotaWrapper ───────────────────────────────────────────────

/**
 * Wraps an LLMProvider with per-tenant concurrency + token-bucket enforcement.
 *
 * Acquires a lease before forwarding to the inner provider and releases it
 * (with actual token reconciliation) regardless of outcome.
 */
export class ProviderTenantQuotaWrapper implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly registry: TenantQuotaRegistry,
  ) {
    this.name = inner.name;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const tenantId = request.tenantId ?? 'system';
    const tenantTier: TenantTier = request.tenantTier ?? 'standard';

    // Estimate tokens from message text
    const estimatedTokens = request.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    const lease = this.registry.acquire({ tenantId, tenantTier, estimatedTokens });
    try {
      const response = await this.inner.complete(request);
      lease.release(response.tokenUsage.input, response.tokenUsage.output);
      return response;
    } catch (err) {
      lease.release();
      throw err;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

// ─── composeResilienceStack ───────────────────────────────────────────────────

export interface ResilienceStackOptions {
  /**
   * Circuit breaker registry. Shared across the whole gateway so cells are
   * keyed by provider — creating a new registry per call would defeat the purpose.
   */
  breakers?: CircuitBreakerRegistry;
  breakerConfig?: BreakerConfig;

  /** Per-tenant quota registry. */
  quota?: TenantQuotaRegistry;

  /** Retry policy override. */
  retryPolicy?: RetryPolicy;

  /**
   * Additional fallback providers tried in order after the primary fails.
   * For P2-029 this is always empty — the failover *wiring* is in place for
   * when a real second provider is provisioned in a follow-up.
   */
  fallbackProviders?: LLMProvider[];

  /** Default per-request deadline in ms. */
  defaultDeadlineMs?: number;
}

/**
 * Compose the resilience stack around a primary LLMProvider.
 *
 * Composition order (inner → outer):
 *   primary
 *     → ProviderBreakerWrapper  (breaker per-provider cell)
 *   [all breaker-wrapped providers]
 *     → ProviderFailoverWrapper (advance on 5xx/network)
 *     → ProviderTenantQuotaWrapper (outermost — quota gate)
 *
 * Retry + deadline are handled inside the breaker wrapper (via runWithRetry /
 * adoptDeadline) so the breaker counts the final outcome of each attempt
 * sequence rather than individual retry attempts.
 */
export function composeResilienceStack(
  primary: LLMProvider,
  options: ResilienceStackOptions = {},
): LLMProvider {
  const {
    breakers = new CircuitBreakerRegistry(options.breakerConfig ?? DEFAULT_BREAKER),
    quota = new TenantQuotaRegistry(DEFAULT_TIER_CONFIG),
    retryPolicy = DEFAULT_RETRY,
    fallbackProviders = [],
    defaultDeadlineMs = STAGE_BUDGETS.defaultTotal,
  } = options;

  // Wrap each provider (primary + any fallbacks) with retry+deadline+breaker
  const wrapWithRetryAndBreaker = (provider: LLMProvider): LLMProvider => {
    // Retry+deadline shim — exposed as a class so the test suite can introspect
    // the wrapper chain (see factory-shadow.test.ts).
    const retryProvider = new ProviderRetryDeadlineWrapper(
      provider,
      retryPolicy,
      defaultDeadlineMs,
    );

    // Wrap with breaker so breaker cell sees the final retry outcome
    return new ProviderBreakerWrapper(retryProvider, breakers);
  };

  const allProviders = [primary, ...fallbackProviders].map(wrapWithRetryAndBreaker);

  // Failover wrapper across all providers
  const failoverProvider = new ProviderFailoverWrapper(allProviders);

  // Outermost: tenant quota enforcement
  return new ProviderTenantQuotaWrapper(failoverProvider, quota);
}
