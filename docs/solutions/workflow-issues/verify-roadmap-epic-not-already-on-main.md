---
title: "Verify a roadmap epic isn't already built on main before planning or coding it"
date: 2026-06-15
track: knowledge
problem_type: workflow-issues
module: "workflow (ce-plan / ce-work), docs/plans"
tags: ["roadmap", "parallel-work", "duplicate-work", "git", "ce-plan", "ce-work", "merge-conflict", "ci"]
related: ["docs/solutions/workflow-issues/verify-spec-gaps-against-shipped-code.md"]
---

## Context

The PRD-parity roadmap is executed as discrete epics, and **multiple agents/sessions can run it in parallel**. In one session, three epics — F-A (LLM gateway multimodal/vision), E5 (review low-rating feedback digest line), and E2a (one-time ACH processing lifecycle) — were each planned with `ce-plan` and built with `ce-work` (tests + a deepening pass) end-to-end over a long, single-branch session.

At PR time (#582) CI failed, and investigation showed `main` had **independently shipped the same three epics** while the work was in flight — near-identical implementations (same helper names `recordProcessingPayment` / `settleProcessingPayment`, `RatingCounts` / `countByRatingInRange`, `LLMContentPart` / `isVisionCapableModel`, even the same comments like `"PRD §6.11 step 5"`), plus E1 (`mms-estimate-task.ts`) and E3 (B2B migration) beyond what was built. The PR was closed as **superseded** — the entire build was wasted duplicate work. The branch had drifted to **80 commits ahead / 5 behind** main.

The first visible symptom was a **CI-only** TypeScript error (the local build passed):

```
src/payments/payment-service.ts: error TS2551:
Property 'reverseInFlightPaymentAtomic' does not exist on type 'PaymentRepository'
```

CI builds the PR **merged with latest main** (`pull/<n>/merge`), so main's new caller met this branch's independently-rewritten `PaymentRepository` interface. The local branch built fine because it predated main's change.

## Guidance

Before `ce-plan` **and** before `ce-work` on any roadmap/story epic — and again before opening a PR — confirm the epic isn't already built or in flight:

1. **Fetch and grep `main` for the epic's distinctive target symbols + migrations.** ~30 seconds:
   ```bash
   git fetch origin main
   # 2-3 symbols/files the epic would introduce:
   git grep -lE "recordProcessingPayment|settleProcessingPayment|LLMContentPart|countByRatingInRange" origin/main -- packages/api/src
   git grep -nE "ach_payment_processing|provider_reference" origin/main -- packages/api/src/db/schema.ts
   ```
   If the symbols already exist on `main`, the epic is built (or landing) → **skip or reconcile; do not rebuild.**
2. **Re-verify per epic, not once per roadmap.** Parallel work lands continuously; a check made at roadmap-planning time is stale within hours.
3. **Integrate `main` frequently; keep branches short-lived.** Rebase/merge `origin/main` at the start of each epic and before each PR — not only when CI complains.
4. **Prefer one epic per branch/PR** over long multi-epic sessions. Three epics on one branch turned a single collision into a whole-PR loss.
5. **Treat "CI fails but it passes locally" as a divergence signal.** A symbol that's "missing" in CI but present locally usually means `main` moved underneath you (CI tests the merge with `main`).

## Why This Matters

Duplicate epics are pure loss: hours of planning, building, testing, and a deepening pass produced nothing landable and created a confusing PR that had to be triaged and closed. The cheap insurance — one `git grep` against `origin/main` — would have prevented all of it. Compounding engineering means each unit makes the next easier; silently rebuilding already-shipped work does the opposite. (Sibling concern, the inverse direction — verifying the spec's "built" claims against shipped code — is covered in `verify-spec-gaps-against-shipped-code.md`.)

## When to Apply

Any time work is dispatched from a shared roadmap / story list where other agents or people may be executing items concurrently — especially before `ce-plan` / `ce-work`, and before opening a PR.

## Examples

- **Missed (this incident):** built E2a ACH processing over a long session; `main` already had `recordProcessingPayment` / `settleProcessingPayment` and migration `179_ach_payment_processing_state`. PR #582 closed as superseded.
- **The check that would have caught it, before any planning:**
  ```bash
  $ git fetch origin main && git grep -l "settleProcessingPayment" origin/main -- packages/api/src
  origin/main:packages/api/src/payments/payment-service.ts   # already built → don't rebuild
  ```
