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

// scale-to-1000 C1 — durable Postgres job-queue backlog. The committed SLO
// bounds this at < 1,000 sustained; the P2 "queue depth" alert (see
// docs/runbooks/alerting.md) filters on it. Sampled by a leader-elected
// interval in app.ts so exactly one replica queries the shared table.
export const pgQueueDepth = new Gauge({
  name: 'pg_queue_depth',
  help: 'Durable Postgres job-queue backlog (scale-to-1000 SLO: < 1000 sustained). Labeled queue=pending|dead_letter.',
  labelNames: ['queue'],
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

// ---------- Voice turn latency (WS26) ----------

/**
 * WS26 — voice turn latency: the time from the STT provider returning a FINAL
 * transcript for the caller's turn to the FIRST outbound TTS audio chunk of the
 * agent's reply being enqueued, on the Twilio Media Streams path. This is the
 * "caller stops speaking → first audio of the reply" seam the scorecard's
 * "turn latency P95" SLO targets.
 *
 * Observed best-effort inside the media-streams adapter (mediastream-adapter.ts)
 * at the exact points that already bracket the turn: `transcript_received`
 * (final transcript) arms the timer, the first non-filler outbound media chunk
 * observes it. FILLER chunks are excluded — a filler clip fills the LLM-thinking
 * gap and would mask the real turn latency.
 *
 * No labels: this histogram is only ever observed from the single media-streams
 * transport. If a second transport ever measures turn latency, add a `transport`
 * label here and at the observe site.
 *
 * Cumulative in-process: like every prom-client histogram it accumulates since
 * process boot and is only visible where the voice service runs. The SLO monitor
 * reads it in-process ONLY under PROCESS_ROLE=all (single-service deploys). Split
 * topologies alert on it via Prometheus/Grafana — see docs/runbooks/slo-alerts.md.
 */
export const voiceTurnLatencyMs = new Histogram({
  name: 'voice_turn_latency_ms',
  help: 'Voice turn latency (ms): STT-final transcript → first outbound TTS chunk of the reply, media-streams path. Excludes filler chunks.',
  buckets: [250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 5000, 7500, 10_000],
  registers: [metricsRegistry],
});

// ---------- Platform SLOs (WS15 — operational resilience) ----------

/**
 * WS15 — calls abandoned by a shutdown drain: the SIGTERM drain window
 * (DRAIN_TIMEOUT_MS) expired with live voice sessions still active, and
 * teardown proceeded anyway (Twilio ends the calls).
 *
 * NOTE: Prometheus counters live in process memory and are LOST at process
 * exit — and this counter is by definition incremented moments before exit,
 * so a scraper will usually never see it. The Sentry error event emitted
 * alongside it (see monitoring/alert-operator.ts emitDrainAbandonment) is
 * the durable alarm; this counter exists for the case where the increment
 * happens on a process that lingers long enough to be scraped mid-drain.
 */
export const voiceDrainAbandonedCallsTotal = new Counter({
  name: 'voice_drain_abandoned_calls_total',
  help: 'Voice calls still live when the shutdown drain window expired (teardown proceeded). Durable alarm is the paired Sentry event.',
  registers: [metricsRegistry],
});

/** WS15 — last evaluated value per SLO rule (see workers/slo-monitor.ts). */
export const sloRuleValue = new Gauge({
  name: 'slo_rule_value',
  help: 'Last evaluated value per platform SLO rule (call_completion_rate=ratio, queue_staleness=stale job count, sweep_lag=seconds since last sweep success, voice_turn_latency_p95=P95 turn latency ms)',
  labelNames: ['rule'],
  registers: [metricsRegistry],
});

/** WS15 — SLO breaches detected by the monitor (pre-cooldown). */
export const sloBreachTotal = new Counter({
  name: 'slo_breach_total',
  help: 'Platform SLO breaches detected by the slo-monitor worker',
  labelNames: ['rule'],
  registers: [metricsRegistry],
});

/** WS15 — operator alerts actually dispatched, per channel (post-cooldown). */
export const sloAlertsSentTotal = new Counter({
  name: 'slo_alerts_sent_total',
  help: 'Operator alerts dispatched by alertOperator, by rule and channel (sentry|sms)',
  labelNames: ['rule', 'channel'],
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
