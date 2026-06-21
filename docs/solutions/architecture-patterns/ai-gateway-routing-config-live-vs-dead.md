---
title: "AI gateway routing: tier-based config (ai-routing.ts) is live; the per-task DEFAULT_GATEWAY_CONFIG table was never wired"
date: 2026-06-21
track: knowledge
problem_type: architecture-patterns
module: packages/api/src/ai/gateway
tags: ["ai-gateway", "model-routing", "system-prompts", "dead-code", "config"]
related: []
---

## Context

The AI gateway (CLAUDE.md Core Pattern: "All AI calls route through LLM
gateway") carried **two parallel routing-config abstractions**. One was live;
the other was a never-wired decoy that *looked* authoritative — a full
`taskType → { model, systemPrompt, temperature, maxTokens }` table. A
dead-code cleanup (2026-06-21) removed the decoy after grep-proving it had zero
consumers. This note records which config is real so the next person doesn't
edit the dead one or hunt for system prompts in the wrong place.

## Guidance

**LIVE — change these to affect routing:**

- `packages/api/src/config/ai-routing.ts` → `DEFAULT_AI_ROUTING_CONFIG`. The
  built-in routing defaults are **tier-based**: a `taskType` maps to a
  complexity tier (`lightweight` / `standard` / `complex`), and each tier maps
  to a model, with per-tenant overrides.
- Consumed by `gateway/router.ts` (`config || DEFAULT_AI_ROUTING_CONFIG`),
  `gateway/gateway.ts`, and `gateway/factory.ts` (`buildGatewayConfig` wires
  the env vars `AI_DEFAULT_MODEL` / `AI_LIGHTWEIGHT_MODEL` / `AI_STANDARD_MODEL`
  / `AI_COMPLEX_MODEL` into an `LLMGatewayConfig`).
- An **unmapped** `taskType` defaults to the **standard** tier (gateway.ts logs
  a one-time warning). So "cheap model for task X" is only true if X is
  explicitly mapped to a cheaper tier — don't assume.
- **Live gotcha (found 2026-06-21):** most call-site `taskType` strings are
  *absent* from `taskTierMapping`, so they silently resolve to **standard**
  (sonnet). Of ~20 call-site task types, only `intent_classification`,
  `draft_estimate`, `update_estimate`, and `create_appointment` are mapped;
  the rest fall through — including `classify_intent` (the mapped key is the
  differently-named `intent_classification`), `decompose_transcript`,
  `summarize_conversation`, `transcription_correction` (mapped key is
  `transcript_normalization`), `voice_clarification`, and `call_sentiment`.
  Tasks meant to be lightweight are paying for the standard tier. The naming
  split mirrors the two configs: call sites still use the old
  `DEFAULT_GATEWAY_CONFIG`-era names while the live map uses newer ones.
  (Counts from a literal `taskType: '…'` grep — a few dynamic call sites may be
  missed; verify per task before relying on a tier. Worth a dedicated audit.)

**The gateway does NOT inject system prompts.** `LLMGateway.complete()`
resolves *provider* and *model* by `taskType`; there is no `taskType →
systemPrompt` lookup anywhere in the gateway. System prompts are entirely the
**caller's** responsibility — each handler/worker puts a system message in
`messages` if it wants one, and **some callers pass none** (e.g.
`workers/transcription.ts` `correctTranscript` sends only a user message for
`transcription_correction`).

**DEAD — removed 2026-06-21, do not resurrect:**

- `gateway/routing-config.ts` → `DEFAULT_GATEWAY_CONFIG` and the
  `GatewayConfig` interface. A per-task-string table (`routes[taskType] =
  { model, systemPrompt, ... }`) that was defined and re-exported from
  `gateway/index.ts` but **imported by nothing**. Because the gateway has no
  prompt-by-taskType lookup, its rich-looking `systemPrompt` entries were never
  applied at runtime — dead on arrival.
- The file `routing-config.ts` itself still exists (pinned by
  `test/decisions/decisions.test.ts` A4, and it hosts the **still-live**
  `TaskRouteConfig` type that `gateway/complexity-classifier.ts`'s
  `ComplexityRoute` extends) — but it no longer carries a routing table.

**How to tell a gateway config is live, fast:** grep the symbol across `src`
for *consumers* (imports/usage), not just its definition plus a barrel
re-export. `DEFAULT_GATEWAY_CONFIG` had a tempting `export { … } from
'./routing-config'` in `index.ts` but zero importers — **a re-export is not a
wire-up.**

## Why This Matters

- Editing `DEFAULT_GATEWAY_CONFIG` (model picks or prompts) would have had
  **zero runtime effect** — a silent trap that wastes debugging time.
- Routing is by **complexity tier**, not by task string. Hunting for "the model
  for taskType X" in a task→model table is the wrong mental model.
- System prompts live **with the caller**, not in any central config. To change
  (or add) a task's system prompt, edit the handler that builds the
  `LLMRequest` — and be aware a task may currently send none.

## When to Apply

When changing model routing, adding a new `taskType`, or tracing where a task's
model or system prompt is set in the AI gateway.

## Examples

Live tier routing (factory wires env → `LLMGatewayConfig`; router falls back to
`DEFAULT_AI_ROUTING_CONFIG`):

```ts
// gateway/factory.ts buildGatewayConfig — tiers, not task strings
tenantOverrides: { [SYSTEM_TENANT_ID]: { tiers: {
  lightweight: { model, provider }, standard: { … }, complex: { … },
} } }

// gateway/router.ts
const routingConfig = config || DEFAULT_AI_ROUTING_CONFIG;
```

Dead per-task shape (removed — never consumed):

```ts
// gateway/routing-config.ts (deleted block)
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  defaultModel,
  routes: { draft_estimate: { model, systemPrompt, … }, /* … */ },
};
```

## Known stale references (follow-up)

Two worker comments still point at the removed table and are now misleading
(they predate this cleanup and were never accurate, since the gateway never
read the table):

- `packages/api/src/workers/transcription.ts` — "system prompt configured in
  ai/gateway/routing-config.ts" (no system prompt is applied for this task).
- `packages/api/src/workers/supervisor-review-worker.ts` — "cheap model per
  routing-config" (model is tier-resolved via `config/ai-routing.ts`).
