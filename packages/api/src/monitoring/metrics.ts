/**
 * Prometheus metrics registry for the resilience layer.
 *
 * Centralised so callers always touch the same registry and label set.
 * `prom-client` default-metrics (event-loop lag, RSS, GC) are enabled here
 * so the /metrics endpoint exposes them alongside our domain counters.
 */
import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

// ---------- Gateway ----------

export const gatewayRequestsTotal = new Counter({
  name: 'gateway_requests_total',
  help: 'LLM gateway requests, partitioned by outcome',
  labelNames: ['tenant_tier', 'model', 'provider', 'outcome'],
  registers: [metricsRegistry],
});

// ---------- Database connection pool (scale-to-1000 U2c) ----------

/**
 * Postgres pool occupancy, sampled from the pg.Pool. `state`:
 *  - total   — open connections (≤ pool max)
 *  - idle    — open and idle (immediately available)
 *  - waiting — callers blocked in `pool.connect()` awaiting a free connection
 *
 * A persistently non-zero `waiting` while `total` is pinned at the pool max is
 * the saturation signal — the hard ceiling this phase targets. `pool` labels the
 * main (request / PgBouncer) pool vs. the direct (session) pool.
 */
export const dbPoolConnections = new Gauge({
  name: 'db_pool_connections',
  help: 'Postgres connection-pool occupancy sampled from pg.Pool',
  labelNames: ['pool', 'state'],
  registers: [metricsRegistry],
});

// ---------- Voice gates (§10 onboarding — trial fraud guardrails) ----------

export const voiceBlocksTotal = new Counter({
  name: 'voice_blocks_total',
  help: 'Inbound voice calls blocked by trial/billing gates, by reason',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});

export const gatewayRequestLatencyMs = new Histogram({
  name: 'gateway_request_latency_ms',
  help: 'End-to-end LLM gateway request latency in ms',
  labelNames: ['tenant_tier', 'model', 'provider', 'outcome'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 60_000],
  registers: [metricsRegistry],
});

// BREAKING CHANGE (P2-029): labels changed from {provider, reason} to
// {provider, taskType, outcome}. Update any dashboards or alerts that
// reference the old 'reason' label.
export const gatewayRetryAttemptsTotal = new Counter({
  name: 'gateway_retry_attempts_total',
  help: 'Retry attempts issued by the gateway',
  labelNames: ['provider', 'taskType', 'outcome'],
  registers: [metricsRegistry],
});

export const gatewayFallbackActivationsTotal = new Counter({
  name: 'gateway_fallback_activations_total',
  help: 'Fallback path activations',
  labelNames: ['stage'],
  registers: [metricsRegistry],
});

/**
 * P2-029 — provider-level failover counter.
 * Incremented each time ProviderFailoverWrapper advances from one provider
 * to the next (from_provider → to_provider).
 */
export const gatewayFailoverTotal = new Counter({
  name: 'gateway_failover_total',
  help: 'Provider-level failover events',
  labelNames: ['from_provider', 'to_provider'],
  registers: [metricsRegistry],
});

export const gatewayDeadlineExceededTotal = new Counter({
  name: 'gateway_deadline_exceeded_total',
  help: 'Requests aborted because the deadline elapsed',
  labelNames: ['stage'],
  registers: [metricsRegistry],
});

// ---------- Tenant fairness ----------

export const tenantConcurrencyRejectTotal = new Counter({
  name: 'tenant_concurrency_reject_total',
  help: 'Requests rejected because the per-tenant concurrency cap was full',
  labelNames: ['tenant_tier'],
  registers: [metricsRegistry],
});

export const tenantTokenBudgetExceededTotal = new Counter({
  name: 'tenant_token_budget_exceeded_total',
  help: 'Requests rejected because the per-tenant token bucket was empty',
  labelNames: ['tenant_tier'],
  registers: [metricsRegistry],
});

export const tenantConcurrencyInFlight = new Gauge({
  name: 'tenant_concurrency_in_flight',
  help: 'Per-tenant in-flight request count',
  labelNames: ['tenant_tier'],
  registers: [metricsRegistry],
});

// ---------- Circuit breaker ----------

/** 0 = closed, 1 = half-open, 2 = open. */
export const breakerState = new Gauge({
  name: 'breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['key'],
  registers: [metricsRegistry],
});

/**
 * P2-029 spec-compliant breaker state gauge.
 * Set to 1 for the current state, 0 for others.
 * Labels: provider (string), state ('closed'|'open'|'half_open').
 * Note: half-open is spelled with underscore here to match Prometheus label conventions.
 */
export const gatewayBreakerState = new Gauge({
  name: 'gateway_breaker_state',
  help: 'Circuit breaker state per provider (1=active, 0=inactive)',
  labelNames: ['provider', 'state'],
  registers: [metricsRegistry],
});

export const breakerTransitionsTotal = new Counter({
  name: 'breaker_transitions_total',
  help: 'Circuit breaker state transitions',
  labelNames: ['key', 'from', 'to'],
  registers: [metricsRegistry],
});

export const breakerOpenSecondsTotal = new Counter({
  name: 'breaker_open_seconds_total',
  help: 'Total seconds spent in the open state per breaker key',
  labelNames: ['key'],
  registers: [metricsRegistry],
});

export const breakerHalfOpenProbeSuccessRatio = new Gauge({
  name: 'breaker_half_open_probe_success_ratio',
  help: 'Last observed half-open probe success ratio per breaker key',
  labelNames: ['key'],
  registers: [metricsRegistry],
});

// ---------- Cache ----------

/**
 * P2-031 — response cache hit/miss counters.
 * Partitioned by taskType so operators can see which task types benefit most.
 */
export const gatewayCacheHitsTotal = new Counter({
  name: 'gateway_cache_hits_total',
  help: 'LLM gateway cache hits (deterministic tasks served from cache)',
  labelNames: ['taskType'],
  registers: [metricsRegistry],
});

export const gatewayCacheMissesTotal = new Counter({
  name: 'gateway_cache_misses_total',
  help: 'LLM gateway cache misses (deterministic tasks not found in cache)',
  labelNames: ['taskType'],
  registers: [metricsRegistry],
});

// ---------- WebSocket ----------

export const wsConnections = new Gauge({
  name: 'ws_connections',
  help: 'Open WebSocket connections',
  labelNames: ['surface', 'tenant_tier'],
  registers: [metricsRegistry],
});

export const wsQueueDepthMsgs = new Gauge({
  name: 'ws_queue_depth_msgs',
  help: 'Outbound WS queue depth in messages (per connection sample)',
  labelNames: ['surface'],
  registers: [metricsRegistry],
});

export const wsQueueDepthBytes = new Gauge({
  name: 'ws_queue_depth_bytes',
  help: 'Outbound WS queue depth in bytes (per connection sample)',
  labelNames: ['surface'],
  registers: [metricsRegistry],
});

export const wsDropTotal = new Counter({
  name: 'ws_drop_total',
  help: 'WS frames dropped from the outbound queue',
  labelNames: ['surface', 'reason', 'priority'],
  registers: [metricsRegistry],
});

export const wsDisconnectTotal = new Counter({
  name: 'ws_disconnect_total',
  help: 'WS connection terminations',
  labelNames: ['surface', 'reason'],
  registers: [metricsRegistry],
});

export const wsSendLatencyMs = new Histogram({
  name: 'ws_send_latency_ms',
  help: 'Per-frame WS send latency in ms',
  labelNames: ['surface'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  registers: [metricsRegistry],
});

export const wsReconnectRejectTotal = new Counter({
  name: 'ws_reconnect_reject_total',
  help: 'WS upgrade requests rejected by the reconnect-storm guard',
  labelNames: ['surface', 'reason'],
  registers: [metricsRegistry],
});

export async function renderMetrics(): Promise<{
  contentType: string;
  body: string;
}> {
  return {
    contentType: metricsRegistry.contentType,
    body: await metricsRegistry.metrics(),
  };
}
