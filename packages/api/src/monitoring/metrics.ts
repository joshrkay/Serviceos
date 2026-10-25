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
  labelNames: ['tenant_tier', 'model', 'provider', 'outcome', 'task_type'],
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
  labelNames: ['tenant_tier', 'model', 'provider', 'outcome', 'task_type'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 60_000],
  registers: [metricsRegistry],
});

/**
 * Per-call LLM cost, accumulated in micro-cents (1 cent = 1,000,000
 * micro-cents — see ai/gateway/model-pricing.ts for the precision
 * rationale: this avoids every sub-cent call rounding to a 0 increment).
 * Divide the aggregate by 1,000,000 to get cents in a dashboard/alert query.
 *
 * Only incremented when the resolved model has a known price — an unpriced
 * model contributes nothing here rather than a guessed cost (spend
 * dashboards under-count unpriced traffic instead of silently fabricating
 * numbers for it; see gatewayRequestsTotal for the always-incremented
 * request count to cross-check coverage).
 *
 * Labels mirror gatewayRequestsTotal's existing tenant_tier/model/provider
 * convention plus task_type (bounded — the canonical TASK_TYPES enum in
 * config/ai-routing.ts, ~30 values) so spend can be sliced per task without
 * per-tenant cardinality (raw tenant_id is deliberately NOT a label).
 */
export const gatewayRequestCostMicroCentsTotal = new Counter({
  name: 'gateway_request_cost_micro_cents_total',
  help: 'Cumulative LLM gateway request cost in micro-cents (1 micro-cent = 1e-6 cent; divide by 1,000,000 for cents). Only incremented for models with a known price.',
  labelNames: ['tenant_tier', 'task_type', 'model', 'provider'],
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

/**
 * LLM calls that started while a tenant transaction held a pooled connection
 * (the /api request transaction, or an explicit unit of work spanning the
 * call). Each one pins that connection, and under PgBouncer a server backend,
 * for the whole call. The gateway logs an error with the call site and lets
 * the call proceed; any non-zero rate is a route that belongs on
 * LLM_LONG_CALL_ROUTES (middleware/tenant-context.ts). Under NODE_ENV=test the
 * gateway throws LlmCallInTransactionError instead.
 */
export const gatewayLlmCallInTransactionTotal = new Counter({
  name: 'gateway_llm_call_in_transaction_total',
  help: 'LLM gateway calls started while a tenant transaction held a pooled connection',
  labelNames: ['task_type'],
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
  help: 'Voice turn latency (ms): STT-final transcript → first AUDIBLE outbound chunk of the reply (filler included), media-streams path, measured at enqueue. The caller-perceived reply gap is voice_reply_gap_ms.',
  buckets: [250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 5000, 7500, 10_000],
  registers: [metricsRegistry],
});

/**
 * Voice parity U1 — the caller-perceived reply gap: the caller's LAST WORD →
 * the first REAL (non-filler) reply frame as Twilio ACKED the mark behind it
 * (playout reached it), media-streams path. Same buckets as
 * `voice_turn_latency_ms` so the two can be read side by side.
 *
 * `anchor` keeps the two populations apart: `last_word` is the SLO (Deepgram
 * word timing anchored to wall clock at the first forwarded sample);
 * `stt_final` is the fallback for a final that carried no timing — measured
 * from the recogniser's endpoint, it understates the gap by the endpoint delay
 * and is never mixed into the `last_word` percentile.
 */
export const voiceReplyGapMs = new Histogram({
  name: 'voice_reply_gap_ms',
  help: "Caller-perceived reply gap (ms): caller's last word (anchor=last_word) or STT-final (anchor=stt_final) → first REAL reply frame acked by Twilio, media-streams path.",
  labelNames: ['anchor'] as const,
  buckets: [250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 5000, 7500, 10_000],
  registers: [metricsRegistry],
});

/**
 * U1 — replies whose first real frame was enqueued but never acknowledged by
 * Twilio: the mark came back as a `clear` echo (barge-in), no ack within 5 s,
 * or the stream closed first. These are exactly the turns on which the caller
 * heard a long delay or nothing, so they are counted beside the histogram
 * rather than dropped from it — the SLO is the p95 AND this rate.
 */
export const voiceReplyUnackedTotal = new Counter({
  name: 'voice_reply_unacked_total',
  help: 'Replies whose first real frame was enqueued but never acked by Twilio (reason=clear_echo|ack_timeout|stream_closed).',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

/**
 * U1 — a reply-audio stamp (`markReplyAudio`) that updated zero rows: the
 * call_transcript_turns row was deleted underneath the chained update. Logged
 * with the key as well, so a silent drop is visible rather than assumed away.
 */
export const voiceReplyStampLostTotal = new Counter({
  name: 'voice_reply_stamp_lost_total',
  help: 'Reply-audio stamps whose call_transcript_turns UPDATE affected zero rows (row deleted underneath).',
  registers: [metricsRegistry],
});

/**
 * PRIV-3 — a cross-turn card-number rewrite of the stored call rows that did
 * not land, by where: `live` (the store's own write failed; the job queued
 * before it, and the session's memory, still hold it for the retry worker and
 * the recording hook), `enqueue` (the queue refused the job: a live write that
 * fails too leaves only the session's memory holding it) and
 * `retry_exhausted` (the worker's last attempt failed: the call's rows still
 * hold part of a card). Alert on any `enqueue` or `retry_exhausted`.
 */
export const cardNumberRewriteFailedTotal = new Counter({
  name: 'voice_card_number_rewrite_failed_total',
  help: 'Cross-turn card-number rewrites of stored call rows that did not land, by stage (live, enqueue, retry_exhausted).',
  labelNames: ['stage'] as const,
  registers: [metricsRegistry],
});

/**
 * PRIV-2 — voicemails whose Twilio-hosted copy the notify-only branch of the
 * voicemail-status route left at Twilio, by why: `no_credentials` (no platform
 * Twilio credentials, so nothing can delete it), `no_recording_url` (the
 * callback named no recording URL) and `delete_failed` (the DELETE did not
 * succeed). Each one is also recorded in `webhook_events` (source
 * `twilio_voicemail_orphaned_copy`) so it can be deleted later. Alert on any
 * increase: the audio outlives the tenant's retention horizon until it is.
 */
export const voicemailTwilioCopyOrphanedTotal = new Counter({
  name: 'voicemail_twilio_copy_orphaned_total',
  help: 'Voicemail Twilio copies the notify-only branch could not delete, by reason (no_credentials, no_recording_url, delete_failed)',
  labelNames: ['reason'] as const,
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
  help: 'Last evaluated value per platform SLO rule (call_completion_rate=ratio, queue_staleness=stale job count, sweep_lag=seconds since last sweep success, voice_turn_latency_p95=P95 turn latency ms, voice_graded_pass_rate_7d=ratio of graded production calls that passed)',
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

/**
 * FAIL-VIS — last evaluated non-completion rate per AI task type, from the
 * failure-rate monitor. Separate from `slo_rule_value` so the per-task label
 * does not inflate that gauge's cardinality; `task_type` is a code-defined,
 * bounded set (~dozens), not user input.
 */
export const aiTaskFailureRate = new Gauge({
  name: 'ai_task_failure_rate',
  help: 'Fraction of ai_runs in the trailing window that did NOT reach status=completed, by task_type (includes failed AND stuck pending/running)',
  labelNames: ['task_type'],
  registers: [metricsRegistry],
});

/** FAIL-VIS — total ai_runs observed per task type in the last evaluated window. */
export const aiTaskRunsObserved = new Gauge({
  name: 'ai_task_runs_observed',
  help: 'ai_runs created in the last evaluated failure-monitor window, by task_type (the volume floor denominator)',
  labelNames: ['task_type'],
  registers: [metricsRegistry],
});

/**
 * OBS-4 — platform-wide ai_runs spend (micro-cents; divide by 1,000,000 for
 * cents) over the last evaluated failure-monitor window. Unlabelled on
 * purpose: per-tenant attribution rides in the alert details, never in a
 * metric label (raw tenant_id is deliberately not a label anywhere here).
 */
export const aiSpendWindowMicroCents = new Gauge({
  name: 'ai_spend_window_micro_cents',
  help: 'SUM(ai_runs.cost_micro_cents) over the last evaluated failure-monitor window, platform-wide (unpriced runs count 0)',
  registers: [metricsRegistry],
});

/**
 * FAIL-VIS — silent proposal-execution findings. `check` is
 * `stalled_executing` (stuck in `executing` past the staleness bound) or
 * `failed_without_error` (terminal `execution_failed` carrying a NULL
 * `execution_error` — the exact signature that hid the estimate bug).
 */
export const proposalSilentFailureFindings = new Gauge({
  name: 'proposal_silent_failure_findings',
  help: 'Proposals matching a silent-execution-failure predicate at last evaluation, by check (stalled_executing|failed_without_error)',
  labelNames: ['check'],
  registers: [metricsRegistry],
});

/**
 * WS15 — operator alerts actually dispatched, per channel (post-cooldown).
 * `rule` is OperatorAlert.metricRule when set: a per-tenant rule keys its
 * cooldown by tenant but labels this series by task family only, so no
 * tenant id ever lands in a label here.
 */
export const sloAlertsSentTotal = new Counter({
  name: 'slo_alerts_sent_total',
  help: 'Operator alerts dispatched by alertOperator, by rule and channel (sentry|sms)',
  labelNames: ['rule', 'channel'],
  registers: [metricsRegistry],
});

/**
 * U7 (S6-2) — demo-call reservations refused because the day's call or cost
 * cap is reached. The crossing that filled the cap paged once; refusals after
 * it only count here, so a busy day never pages again.
 */
export const demoCallBudgetRefusalsTotal = new Counter({
  name: 'demo_call_budget_refusals_total',
  help: 'Demo-call budget reservations refused because the UTC day is at its call or cost cap',
  registers: [metricsRegistry],
});

/**
 * Knowledge-chunk inserts refused because another tenant already holds the
 * same (scope, source_type, source_id, source_version) on 062's tenant-blind
 * dedupe index, which 351 keeps until its contract migration drops it. The
 * chunk is not written; the other tenant's row is untouched. `source_type` is
 * the bounded KnowledgeChunkSourceType whitelist. Source ids are server UUIDs,
 * so any count here is unexpected; remove with the contract migration.
 */
export const knowledgeChunkDedupeCollisionsTotal = new Counter({
  name: 'knowledge_chunk_dedupe_collisions_total',
  help: "Knowledge-chunk inserts refused on the tenant-blind dedupe index because another tenant holds the source tuple",
  labelNames: ['source_type'],
  registers: [metricsRegistry],
});

/**
 * `shadow_comparisons` rows the retention sweep deleted past
 * SHADOW_COMPARISON_RETENTION_DAYS (workers/shadow-comparison-retention-worker.ts).
 * Flat while SHADOW_LLM_ENABLED has been off for longer than the window.
 */
export const shadowComparisonsPurgedTotal = new Counter({
  name: 'shadow_comparisons_purged_total',
  help: 'shadow_comparisons rows deleted by the retention sweep past SHADOW_COMPARISON_RETENTION_DAYS',
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
