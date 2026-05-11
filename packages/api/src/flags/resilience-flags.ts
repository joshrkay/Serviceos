/**
 * Resilience-layer kill-switch flag definitions.
 *
 * These flags are wired into the gateway / breaker / WS layers. They
 * default to disabled-when-missing — `isFeatureEnabled` returns false
 * for unknown flags, so production traffic stays on the legacy path
 * during dark launch. Operators flip them on per-tenant or globally
 * via the admin API.
 */
import type { FeatureFlag } from './feature-flags';

export const RESILIENCE_FLAG_NAMES = {
  breakerEnforcement: 'gateway.breaker_enforcement',
  retryEnabled: 'gateway.retry_enabled',
  fallbackEnabled: 'gateway.fallback_enabled',
  tenantQuotaEnforced: 'gateway.tenant_quota_enforced',
  clientGatewayEnabled: 'ws.client_gateway_enabled',
  assistantStreamEnabled: 'ws.assistant_stream_enabled',
  voiceEventsEnabled: 'ws.voice_events_enabled',
  backpressureEnforced: 'ws.backpressure_enforced',
  slowConsumerDisconnect: 'ws.slow_consumer_disconnect_enabled',
  reconnectRateLimit: 'ws.reconnect_rate_limit_enabled',
} as const;

export type ResilienceFlagName = (typeof RESILIENCE_FLAG_NAMES)[keyof typeof RESILIENCE_FLAG_NAMES];

/**
 * Default-off declarations. Persisted on first boot so operators see
 * the flags in the admin UI even though they're disabled.
 */
export function defaultResilienceFlags(): FeatureFlag[] {
  return Object.values(RESILIENCE_FLAG_NAMES).map((name) => ({
    name,
    enabled: false,
    description: descriptionFor(name),
  }));
}

function descriptionFor(name: string): string {
  switch (name) {
    case RESILIENCE_FLAG_NAMES.breakerEnforcement:
      return 'Enforce circuit breaker decisions on the AI gateway. When off, breaker is metrics-only.';
    case RESILIENCE_FLAG_NAMES.retryEnabled:
      return 'Allow retry on transient gateway errors with jittered backoff.';
    case RESILIENCE_FLAG_NAMES.fallbackEnabled:
      return 'Cascade through cheaper-model and fallback-provider stages on primary failure.';
    case RESILIENCE_FLAG_NAMES.tenantQuotaEnforced:
      return 'Reject requests that exceed per-tenant concurrency or token budgets.';
    case RESILIENCE_FLAG_NAMES.clientGatewayEnabled:
      return 'Accept upgrades on the new client WebSocket gateway.';
    case RESILIENCE_FLAG_NAMES.assistantStreamEnabled:
      return 'Mirror assistant token stream onto the WS gateway in addition to SSE.';
    case RESILIENCE_FLAG_NAMES.voiceEventsEnabled:
      return 'Mirror voice FSM events onto the WS gateway in addition to SSE.';
    case RESILIENCE_FLAG_NAMES.backpressureEnforced:
      return 'Enforce bounded outbound queues + drop policy on WS surfaces.';
    case RESILIENCE_FLAG_NAMES.slowConsumerDisconnect:
      return 'Disconnect WS clients that fail slow-consumer detection.';
    case RESILIENCE_FLAG_NAMES.reconnectRateLimit:
      return 'Apply token-bucket reconnect-storm guard on WS upgrades.';
    default:
      return '';
  }
}

/**
 * Persist defaults if not already present. Fire-and-forget; safe to
 * call repeatedly because upsert is idempotent and we only seed missing
 * flags so an operator's flip isn't reset on next boot.
 */
export async function seedResilienceFlags(repo: {
  get: (name: string) => Promise<FeatureFlag | null>;
  upsert: (flag: FeatureFlag) => Promise<FeatureFlag>;
}): Promise<void> {
  for (const flag of defaultResilienceFlags()) {
    const existing = await repo.get(flag.name);
    if (!existing) {
      await repo.upsert(flag);
    }
  }
}
