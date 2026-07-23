# Fix voice breaker abort cascade — Implementation Plan

> **For agentic workers:** Execute task-by-task. Do not stop until unit variations
> and live probe variations pass. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop Railway→OpenAI aborts and probe load from opening the tenant
circuit breaker and cascading the operator voice top-50 into DEGRADED.

**Architecture:** Treat local deadline/AbortSignal cancellations as
non-health failures (like 4xx): they still fail the turn, but they must not
open the shared provider breaker. Isolate `classify_intent` into its own
breaker cell so assistant chat cannot poison voice. Stop adapter retries on
breaker-open/unavailable. Gate and vary the live probe.

**Tech Stack:** TypeScript, Vitest, Express AI gateway, production-retest harness

## Global Constraints

- Never auto-execute proposals; AI remains advisory.
- Money stays integer cents; tenant isolation absolute.
- No Railway flip to `sk_test_` / `pk_test_`; no JWT lifetime extension.
- Do not commit `.env.production.local` or `.tmp-prod-serviceos.jwt`.
- Verify production build with `npx tsc --project tsconfig.build.json --noEmit`.

---

## Failure modes (RCA)

| ID | Break | Symptom | Root cause | Fix |
|----|-------|---------|------------|-----|
| FM-01 | Local deadline abort counted as provider failure | `lastError: Request was aborted.` → breaker open | `CircuitBreakerRegistry.run` records all non-4xx | Do not count local deadline/abort toward breaker |
| FM-02 | Coarse breaker cell | Assistant failures poison voice | Key is `provider\|gpt\|…` for all GPT tasks | Isolate `classify_intent` task class in breaker key |
| FM-03 | Single-provider failover | `LLM_PROVIDER_UNAVAILABLE` after open | Empty `fallbackProviders` | Later: OpenRouter Profile B (ops); code ready via env |
| FM-04 | Half-open brittle | One miss reopens | `onResult(false)` in half-open → open | Covered by FM-01 (deadline miss no longer reopens) |
| FM-05 | Green completion while tenant broken | Ops false confidence | System tenant skips breaker | Surface `breakerBypassed` + provider states on completion probe |
| FM-06 | Adapter retry amplifies load | 2× classify under abort | Retries all non-quota | Skip retry for `BREAKER_OPEN` / `LLM_PROVIDER_UNAVAILABLE` |
| FM-07 | Unavailable mislabeled deadline | Wrong audit | Wrapped abort message | Already fixed on branch; keep tests |

---

## Files

| File | Responsibility |
|------|----------------|
| `packages/api/src/ai/gateway/breaker.ts` | `isNonHealthFailure` + skip counting |
| `packages/api/src/ai/gateway/deadline.ts` | `isLocalDeadlineOrAbort` (narrower than `isDeadlineExceeded`) |
| `packages/api/src/ai/gateway/compose-resilience.ts` | Breaker key includes task class |
| `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts` | No retry on breaker/unavailable |
| `packages/api/src/ai/gateway/readiness.ts` | Expose breaker bypass + provider health |
| `packages/api/src/routes/ai-health.ts` | Pass registry into completion response if needed |
| `scripts/production-retest.mjs` | `--voice-only`, wait-for-closed gate |
| Tests under `packages/api/test/ai/` | Unit variations per FM |

---

## Tasks

### Task 1 — Narrow local-deadline helper + breaker non-health path (FM-01, FM-04)

- [x] Add `isLocalDeadlineOrAbort` in `deadline.ts` (AbortError / Request was aborted / DEADLINE_EXCEEDED only — NOT broad "timeout"/"etimedout")
- [x] In `breaker.ts`, treat those like 4xx: `releaseReservation()`, do not `onResult(false)`
- [x] Tests: 20 aborts do not open breaker; 503s still open; half-open deadline abort does not reopen

### Task 2 — Isolate classify breaker cell (FM-02)

- [x] Extend `BreakerKeyParts` with optional `taskClass`
- [x] `ProviderBreakerWrapper` sets `taskClass: classify` for `classify_intent`, else `default`
- [x] Test: assistant-cell failures do not open classify-cell

### Task 3 — Adapter retry discipline (FM-06) + keep FM-07

- [x] `classifyIntentWithRetry`: throw through on `BREAKER_OPEN` / `LLM_PROVIDER_UNAVAILABLE`
- [x] Keep provider-vs-deadline audit tests

### Task 4 — Readiness honesty (FM-05)

- [x] Completion probe result includes `breakerBypassed: true` and `providers` snapshot from shared registry when available
- [x] Unit test for fields

### Task 5 — Probe harness variations

- [x] `--voice-only` skips assistant chat per case
- [x] Wait until `/api/health/ai` `available:true` before starting (env/flag)
- [ ] Document variation matrix in verification run

### Task 6 — Multi-variation validation gate

Run and record:

1. [x] Unit pack (all new tests) — 98 passed incl. cascade A–D
2. [x] `tsc --project tsconfig.build.json --noEmit`
3. [ ] Live prod: voice-only v3 (after closed) — requires deploy of this PR
4. [ ] Live prod: full assistant+voice v3 (after closed) — requires deploy of this PR
5. [ ] Optional: v4 corpus voice-only smoke (first 10) if time

Success criteria:

- Unit: aborts never open breaker; 503 still does; classify cell isolated
- Live voice-only: voice PASS ≥ previous best (26/50) and no mid-run breaker open lasting >1 cooldown, OR clear residual attributed only to true provider 5xx
- Live full: voice PASS improves vs post-#732 8/50; breaker stays closed or recovers without cascading whole run

### Task 7 — Ship

- [ ] Commit(s), push, PR, update `docs/verification-runs/operator-voice-50-v3-prod-2026-07-23.md`

## Out of scope (explicit)

- Extending Clerk JWT lifetime
- Flipping `NODE_ENV=production` before sustained green
- Implementing OpenRouter billing/keys in this change (document as FM-03 follow-up)
