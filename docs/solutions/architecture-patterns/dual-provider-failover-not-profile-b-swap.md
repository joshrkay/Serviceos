---
title: "Dual-provider failover needs AI_FALLBACK_PROVIDER_* factory wiring — Profile B swap is not failover"
date: 2026-07-23
track: knowledge
problem_type: architecture-patterns
module: packages/api/src/ai/gateway/factory.ts
tags: ["ai-gateway", "failover", "openrouter", "FM-03", "fallbackProviders", "voice"]
related:
  - docs/solutions/architecture-patterns/ai-gateway-routing-config-live-vs-dead.md
  - docs/solutions/runtime-errors/empty-classify-deadline-env-collapses-voice-pass.md
  - docs/plans/2026-07-23-003-fix-operator-voice-degraded-to-fifty-plan.md
  - docs/runbooks/live-ai-restore.md
---

## Context

After #734, local deadline/AbortSignal no longer opens the tenant breaker, yet
many voice cases still degraded with `LLM_PROVIDER_UNAVAILABLE` while
`breakerState:closed`. Root shape: `ProviderFailoverWrapper` existed, but
`createLLMGateway()` never passed `fallbackProviders` — so “failover” always
exhausted a **single** provider (often after wrapping a local abort).

Separately, ops runbooks offered **Profile B** (`apply-railway-ai-profile.sh b`)
which **replaces** `AI_PROVIDER_*` with OpenRouter. That is a primary swap, not
dual-provider failover. Earlier plan text that said “code ready via env” for
FM-03 was incorrect.

## Guidance

**LIVE dual-provider (preferred for voice residual):**

| Role | Env |
|------|-----|
| Primary | Profile A — `AI_PROVIDER_*` → `api.openai.com` + gpt models |
| Fallback | `AI_FALLBACK_PROVIDER_API_KEY` + `AI_FALLBACK_PROVIDER_BASE_URL` (+ optional `AI_FALLBACK_*_MODEL`) |

Factory builds a second `OpenAICompatibleProvider`, wraps it in
`FallbackModelMapProvider` (rewrites `gpt-4o-mini` → Llama/Qwen ids), and
passes `[secondary]` into `composeResilienceStack({ fallbackProviders })`.

Apply: `./scripts/apply-railway-ai-fallback.sh` (or Railway desktop). Both key
and URL required; partial config is ignored (no boot crash).

**NOT the same:**

| Mode | Script / vars | Effect |
|------|---------------|--------|
| Profile B primary swap | `apply-railway-ai-profile.sh b` | OpenRouter becomes the **only** provider |
| Dual-provider failover | `AI_FALLBACK_PROVIDER_*` | OpenAI first; OpenRouter on abort/5xx |

**Also remember:** abort still must **not** count toward breaker health (FM-01,
#734). Failover eligibility and breaker health are separate concerns.

## Why This Matters

- Sole-provider exhaustion after a deadline abort surfaces as
  `LLM_PROVIDER_UNAVAILABLE` / `classifier_provider_failure` even when the
  breaker stays closed — looks like “provider down” but is often “no second hop”.
- Swapping Profile B alone does not populate `fallbackProviders`; it only
  changes the primary host/models.
- Probe taxonomy (`failureTaxonomy` A vs B) separates remaining infra noise
  from product DEGRADED before triage.

## When to Apply

- Prod voice PASS stuck with closed breaker + many `LLM_PROVIDER_UNAVAILABLE`
  after deadline is confirmed non-empty (12000).
- Implementing FM-03 or any second OpenAI-compatible host.
- Writing runbooks — never call Profile B “failover” without the fallback env pair.

## Examples

**Before (inert wiring):**

```ts
const resilientProvider = composeResilienceStack(shadowWrappedProvider, {
  breakers: breakerRegistry,
  quota: quotaRegistry,
  // fallbackProviders defaulted to []
});
```

**After (env-driven):**

```ts
const fallbackProviders =
  opts.resilience?.fallbackProviders ?? buildFallbackProvidersFromEnv(opts.logger);
const resilientProvider = composeResilienceStack(shadowWrappedProvider, {
  breakers: breakerRegistry,
  quota: quotaRegistry,
  fallbackProviders,
});
```

Tests: `packages/api/test/ai/gateway/factory-fallback.test.ts`.  
Live gate still needs an OpenRouter key on Railway + voice-only top-50.
