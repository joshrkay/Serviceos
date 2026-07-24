---
title: "Empty AI_CLASSIFY_INTENT_DEADLINE_MS silently falls back to 4s and collapses prod voice PASS"
date: 2026-07-23
track: bug
problem_type: runtime-errors
module: packages/api/src/config/ai-routing.ts
tags: ["voice", "classify_intent", "deadline", "railway", "operator-voice-top-50", "env"]
related:
  - docs/solutions/architecture-patterns/dual-provider-failover-not-profile-b-swap.md
  - docs/verification-runs/operator-voice-50-v3-prod-2026-07-23.md
  - docs/runbooks/live-ai-restore.md
---

## Problem

Production operator-voice top-50 stayed ~10–17/50 after the #734 breaker-cascade
fix because Railway had `AI_CLASSIFY_INTENT_DEADLINE_MS` set to an **empty
string**. The code treated that as unset and used the **4000ms** default while
OpenAI classify latency was often ~9–14s.

## Symptoms

- `/api/health/ai` shows `available:true`, `breakerState:closed` (post-#734).
- Warm classify / many top-50 cases audit as `classifier_provider_failure` with
  `LLM_PROVIDER_UNAVAILABLE` (failover wrap of abort when only one provider).
- Spoken repair: “Is this about scheduling a visit…” (`low_intent_confidence`).
- Completion probe ~9–17s; voice cases abort under a 4s classify budget.
- After restoring `12000`: voice-only jumped to **30/50** (and full **28/50**).

## What Didn't Work

- Assuming the verification-run table (“deadlines raised to 12000”) meant Railway
  still had that value — the var existed but was blank.
- Treating breaker-closed + `LLM_PROVIDER_UNAVAILABLE` as “need more breaker
  work” — cascade was already fixed; the budget was wrong.
- Relying on `/api/health/ai/completion` alone — it can timeout or succeed with
  `breakerBypassed:true` while tenant classify still aborts.

## Solution

1. **Ops:** Set `AI_CLASSIFY_INTENT_DEADLINE_MS=12000` on prod `@serviceos/api`
   (never leave empty). Redeploy.
2. **Guard:** `validateClassifyIntentDeadlineEnv` +
   `npm run check:ai-provider-config` **fail** when the var is present-but-blank.
3. **Runtime warn:** `resolveClassifyIntentDeadlineMs` stderr-warns on empty and
   still falls back to 4000 (dev-safe) so logs show the regression.
4. **Docs:** `docs/runbooks/live-ai-restore.md`, `docs/prod-env-checklist.md`.

## Why This Works

`parsePositiveIntEnv` uses `if (!raw) return fallback`. In JS, `""` is falsy, so
Railway’s empty string is indistinguishable from “unset” and silently selects
the 4s default. Present-but-blank detection uses
`Object.prototype.hasOwnProperty` + `trim() === ''`.

## Prevention

- Pre-probe checklist: confirm classify deadline is a positive integer (12000),
  not blank.
- Run `cd packages/api && npm run check:ai-provider-config` before prod voice
  retests.
- Prefer `./scripts/apply-railway-ai-fallback.sh` (pins deadline to 12000) when
  touching AI vars.
- Unit tests: `packages/api/test/ai/gateway/deadline-config.test.ts`.
