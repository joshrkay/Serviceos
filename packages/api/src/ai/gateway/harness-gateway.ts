/**
 * The PRODUCTION gateway, built for an eval/test harness.
 *
 * The live voice eval (#1431), the real-LLM path smoke (#1426) and Voice
 * Quality Layer 2 (#1450) must measure the exact stack production runs —
 * `createLLMGateway(loadConfig(env))`: provider, tier routing, retry, deadline,
 * breaker, failover. They must NOT inherit its per-tenant quota (tenant-quota.ts
 * DEFAULT_TIER_CONFIG, plus any AI_QUOTA_TIERS_JSON override): that is a
 * fairness cap between real tenants, sized for their live load, and a harness
 * drives a long sequential sample through ONE pseudo-tenant.
 *
 * Under the old classifier_standard bucket (1,000 tok/s, 600,000 capacity)
 * that sample — one ~15k-token operator-taxonomy classify every few seconds —
 * drained the bucket within minutes and the run died with "Per-tenant token
 * budget exceeded for tenant system:classify_intent" (gh run 36500073030).
 * GATEWAY-01 resized it to 30,000 tok/s (3.6M capacity); one call in flight
 * at a time bills ~5–7.5k tok/s at 2–3s a call, so a sequential sample no
 * longer drains it. The harness keeps its own store anyway: the table is
 * tuned for live tenants and resizable per environment without a deploy, and
 * an eval whose run can die on whatever the fairness table currently says
 * measures the quota, not the stack.
 *
 * So the harness injects its own quota store through the existing
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
