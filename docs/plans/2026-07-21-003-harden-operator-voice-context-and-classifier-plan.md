# harden: Operator voice prompt context, classifier coverage, and resilience

**Created:** 2026-07-21  
**Depth:** Deep  
**Status:** plan

## Summary
The operator classifier currently sends a roughly 9k-token static taxonomy on
every turn, while the most useful tenant knowledge—approved aliases, current
entity candidates, catalog snippets, terminology, and operator context—is
either absent or injected inconsistently by surface. This plan replaces
ad-hoc prompt growth with bounded, intent-conditioned retrieval; aligns context
gates across voice surfaces; and makes deadline, quota, parse, and provider
failures observable rather than masking them as low audio confidence.

## Problem Frame
The top-50 probe has shown that a green cheap completion probe does not prove a
full classifier call works. Full classify requests carry a 36,678-character
taxonomy plus optional tenant context, use a 4s deadline, and can fail due to
provider abort, quota, malformed JSON, or genuine ambiguity. In-app voice
turns currently collapse those causes into `score: 0`, making prompt coverage
and infrastructure failures impossible to distinguish from real uncertainty.

## Requirements
- R1. Classifier context is layered, tenant-scoped, token-bounded, and
  provenance-aware.
- R2. All operator surfaces apply the same authorized extended/owner context.
- R3. The resolver remains the authority for entity identity; prompt hints
  never silently choose a canonical record.
- R4. Unsafe raw transcript/audit/AI-run data never becomes system context.
- R5. Classifier errors are observable as provider/quota/deadline/parse/semantic
  outcomes, not all as `confidence_low`.
- R6. Readiness proves both a cheap provider completion and a representative
  full classifier JSON request.
- R7. Load tests and the live top-50 prove 50/50 valid outcomes under bounded
  tenant cost and latency.

## Key Technical Decisions
- **Do not add more raw taxonomy prose.** Split static taxonomy into a compact
  routing core and structured extraction contract; retrieve only relevant
  tenant hints after a cheap first-pass intent-family hint.
- **Layer context by trust.** Canonical labels/IDs and approved aliases are
  direct retrieval; approved summaries/training assets are bounded and
  provenance-tagged; raw transcripts, audit JSON, draft proposals, and
  `ai_runs` snapshots are excluded.
- **Aliases are retrieval hints, not authority.** Active owner-approved aliases
  are checked before pg_trgm, then target tenancy/lifecycle is verified.
- **Observability before optimization.** Add task-type metrics and typed
  classifier outcomes before changing retry/deadline/failover defaults.
- **Representative readiness.** Keep `ping` as transport liveness and add a
  protected full classifier probe for deploy/operator gating.

## Context Sources and Controls
| Layer | Source | Cap / safety |
|---|---|---|
| L0 | compact taxonomy + JSON schema | byte/token-pinned, cacheable |
| L1 | vertical, timezone, approved terminology | ≤400 tokens, tenant cache |
| L2 | owner/extended surface gates | explicit booleans, no raw content |
| L3 | active aliases; top entity/catalog candidates by intent family | ≤500 tokens, IDs + labels only |
| L4 | user utterance | user role only |

Never inject raw transcripts, webhook payloads, `ai_runs`, raw corrections,
unallowlisted audit metadata, or draft/rejected proposal payloads.

## Implementation Units

### U1. Classifier outcome telemetry and non-masking voice errors
- **Goal:** distinguish semantic uncertainty from provider, quota, deadline,
  breaker, and parse failures.
- **Files:** `packages/api/src/monitoring/metrics.ts`,
  `packages/api/src/ai/orchestration/intent-classifier.ts`,
  `packages/api/src/ai/gateway/{gateway,retry,compose-resilience}.ts`,
  voice adapters, classifier/resilience tests.
- **Tests:** task-type labels; deadline metric increments; typed outcomes;
  adapter emits infrastructure telemetry before safe reprompt.
- **Verification:** dashboard can calculate `classify_intent` infra error rate
  independently of low-confidence classifications.

### U2. Surface context parity
- **Goal:** apply authorized `extendedIntents` and owner context consistently
  to assistant, in-app voice, worker/router, Gather, and Media Streams.
- **Files:** `packages/api/src/{app.ts,routes/assistant.ts,workers/voice-action-router.ts,ai/agents/customer-calling/inapp-adapter.ts,ai/voice-turn/create-voice-turn-processor.ts}`,
  surface parity tests.
- **Tests:** flag/role matrix pins exact system-section presence and runtime
  rejection for unauthorized owner actions.
- **Verification:** lookup/extended operator utterances behave identically
  across eligible surfaces.

### U3. Bounded classifier context assembler
- **Goal:** add `classifier-context-assembler.ts` that constructs L1/L3
  context by intent family without full-table prompt dumps.
- **Files:** `packages/api/src/ai/orchestration/classifier-context-assembler.ts`,
  vertical resolver/context assembly, entity/catalog repos, tenant alias repo,
  classifier tests.
- **Tests:** token caps, allowlisted fields, cache invalidation, injection
  delimiters, tenant RLS integration.
- **Verification:** prompts include only relevant top-N candidates and stay
  below the configured budget.

### U4. Representative classifier readiness and deploy gate
- **Goal:** add a protected full-taxonomy JSON classifier probe alongside
  transport liveness, optionally gate `/ready` by feature flag.
- **Files:** `packages/api/src/ai/gateway/readiness.ts`,
  `packages/api/src/routes/ai-health.ts`, `packages/api/src/app.ts`,
  readiness tests.
- **Tests:** ping may pass while classifier probe fails; classifier probe maps
  timeout/auth/quota/model errors stably; auth is enforced.
- **Verification:** three consecutive full classifier probes succeed before
  a voice rollout is accepted.

### U5. Resilience/load evaluation and live acceptance
- **Goal:** validate bounded latency, quota, retries, and all top-50 outcomes.
- **Files:** classifier load tests, `scripts/probe-operator-voice-50-live.mjs`,
  `docs/verification-runs/`.
- **Tests:** chaos 5xx/429/deadline cases, per-tenant burst, 50 valid
  outcomes; Docker-gated gateway integration.
- **Verification:** p95 full classify <3.5s, <2% infrastructure error rate,
  zero masked infrastructure failures, and 50/50 accepted top-50 outcomes.

## Risks
- A compact taxonomy must preserve intent accuracy; pin corpus/cassette
  behavior before swapping it.
- Retrieval content can inject instructions; delimit, quote, cap, redact, and
  allowlist every derived source.
- Prompt context never supplies money values as authority; catalog grounding
  remains deterministic after classification.
- New metrics must avoid tenant IDs and raw reference text as labels.
