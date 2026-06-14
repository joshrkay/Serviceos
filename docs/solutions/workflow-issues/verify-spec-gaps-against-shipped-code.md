---
title: "Verify spec \"gaps\" against shipped code before planning"
date: 2026-06-14
track: knowledge
problem_type: workflow-issues
module: "docs/remaining-features.md, packages/api/src/proposals/execution"
tags: ["planning", "ce-plan", "stale-docs", "backlog", "verification", "research"]
related: []
---

## Context

Planning the "3A — Emergency detection fast-path" item from
`docs/remaining-features.md`. The spec framed it as a from-scratch build:

> **Gap:** The intent classifier has 14 intents; none is `emergency_dispatch`.
> A caller saying "my furnace is out at 15°F" is treated the same as a tune-up.

Research against the *actual code* told a different story — the feature was
~80% already shipped:

- `emergency_dispatch` was already intent #15 in
  `packages/api/src/ai/orchestration/intent-classifier.ts` (`SUPPORTED_INTENTS`).
- A deterministic `emergency-detector.ts` (RV-140), an FSM fast-path in
  `transitions.ts` (RV-142, 911 line → escalate), an execution handler
  `emergency-dispatch-handler.ts` (RV-141), and a page-retry ladder (RV-143)
  all existed — **all merged in PR #551**.
- `docs/superpowers/plans/2026-06-11-rivet-architect-plan.md` marked
  `[x] RV-140/141/142/143 DONE`.

`docs/remaining-features.md` had simply never been updated after the
rivet-architect work landed. The only genuinely-open, plannable work was a
**documented deviation** noted in the handler's own header — the emergency
appointment-hold ("no auto appointment-hold, documented"). A plan taken at
face value from the spec would have generated ~6 units re-implementing
shipped code.

## Guidance

Before planning work that originates from a backlog / spec / roadmap doc,
**verify each claimed "gap" against the shipped code and the merged plan
checklists.** Treat the spec as a *hypothesis*, not a work order.

Concrete checks (cheap, ~2 minutes):

```bash
# 1. The identifiers the spec says are missing usually already exist.
grep -rn "emergency_dispatch" packages/api/src packages/shared/src

# 2. The files the spec says to create/edit — do they already do the thing?
ls packages/api/src/ai/agents/customer-calling/

# 3. Is the story already checked off in a merged plan?
grep -rn "RV-141\|\[x\].*emergency" docs/superpowers/plans/
```

When the spec and the code disagree, **trust the code.** The backlog doc is a
lagging indicator; the source tree + merged plan checklists + PR history are
ground truth. The real plannable work is often a narrow, explicitly-documented
deviation rather than the headline feature.

When you find a stale entry, **fix or flag it** (update the backlog doc / note
it in the plan's Problem Frame) so the next person isn't misled the same way.

## Why This Matters

Planning against a stale spec wastes effort and actively risks harm: it leads
to re-implementing or conflicting with shipped code, which violates this repo's
"remove dead code / don't reimplement" ethos and can regress a working
feature. Catching it during the research phase turned a wrong ~6-unit plan into
a correct 3-unit one (the appointment-hold) — and in some cases reveals there
is nothing to build at all. The few minutes of verification is the cheapest
step in the whole loop.

## When to Apply

- The research phase of `/ce-plan` (and any ad-hoc planning) whenever the task
  comes from a backlog / roadmap / "remaining work" doc.
- Especially for older docs, or features described as part of a larger
  initiative (e.g. a "Phase N" roadmap) that has since had stories merged.
- Any time a spec says "X doesn't exist yet" about a non-trivial feature —
  grep for X first.

## Examples

**Stale spec (what the doc claimed):**

> Add `emergency_dispatch` as a 15th intent … none is `emergency_dispatch`.

**Ground truth (what the code showed):**

```
packages/api/src/ai/orchestration/intent-classifier.ts:124:  'emergency_dispatch',
docs/superpowers/plans/2026-06-11-rivet-architect-plan.md:793:- [x] RV-141 (P2) DONE, PR #551 (deviation: no auto appointment-hold, documented).
```

**Outcome:** the plan's Problem Frame was rewritten to "3A is largely shipped
(PR #551); the residual is the documented appointment-hold deviation," and the
implementation closed exactly that deviation instead of rebuilding the feature.
