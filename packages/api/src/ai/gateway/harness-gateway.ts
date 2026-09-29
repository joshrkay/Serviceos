/**
 * The PRODUCTION gateway, built for an eval/test harness.
 *
 * The live voice eval (#1431), the real-LLM path smoke (#1426) and Voice
 * Quality Layer 2 (#1450) must measure the exact stack production runs —
 * `createLLMGateway(loadConfig(env))`: provider, tier routing, retry, deadline,
 * breaker, failover. They must NOT inherit its per-tenant token bucket
 * (tenant-quota.ts DEFAULT_TIER_CONFIG): that is a fairness cap between real
 * tenants, and a harness drives a long sequential sample through ONE
 * pseudo-tenant, so the classifier bucket drains within minutes and the run
 * dies with "Per-tenant token budget exceeded for tenant system:classify_intent"
 * (gh run 36500073030).
 *
 * The harness therefore injects its own quota store through the existing
 * `opts.resilience.quota` seam — an explicit no-op. Spend is bounded by each
 * harness's cost caps (preflight projection + actual-spend cap), which are the
 * real guard. DEFAULT_TIER_CONFIG and app behaviour are unchanged.
 */
import type { AppConfig } from '../../shared/config';
import { createLLMGateway, type CreateLLMGatewayOptions } from './factory';
import type { LLMGateway } from './gateway';
import type { QuotaLease, QuotaStore } from './tenant-quota';

const NO_OP_LEASE: QuotaLease = { release: async () => {} };

/** Quota store that admits every request: harness runs are bounded by cost caps, not tenant fairness. */
export function createHarnessQuotaStore(): QuotaStore {
  return { acquire: async () => NO_OP_LEASE };
}

/** `createLLMGateway` with the harness quota store; every other option passes through. */
export function createHarnessLLMGateway(
  config: AppConfig,
  opts: Omit<CreateLLMGatewayOptions, 'resilience'> & {
    resilience?: Omit<NonNullable<CreateLLMGatewayOptions['resilience']>, 'quota'>;
  } = {},
): LLMGateway {
  return createLLMGateway(config, {
    ...opts,
    resilience: { ...opts.resilience, quota: createHarnessQuotaStore() },
  });
}
