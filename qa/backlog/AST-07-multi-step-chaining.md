# AST-07 — Multi-step proposal chaining

**Matrix row:** AST-07 (Assistant · multi-step orchestration)
**Current predicted verdict:** fail (1:1 intent→proposal, no chaining)
**Target verdict:** pass
**Effort:** XL (3–5 days — treat as epic; may warrant sub-stories)

## Problem

The assistant can only produce one proposal per turn. "Create a customer
named Acme and draft a $1500 estimate for them and send the invoice" requires
three turns today. Voice, specifically, feels broken because users speak in
multi-verb sentences.

## Evidence from code

- `packages/api/src/ai/orchestration/voice-action-router.ts:44-50` — strict
  1:1 intent→proposal mapping, no chaining structure.
- No orchestration module (grep for `chain|orchestrat|multi.*step` returns no
  matches in `packages/api/src/ai/`).
- `packages/api/src/proposals/` has no concept of a "plan" composed of
  sequential proposals.

## Design sketch (not prescriptive)

Introduce a `plan` abstraction:

```ts
type Plan = {
  id: string;
  tenantId: string;
  steps: Array<{
    id: string;
    proposal: Proposal;
    dependsOn: string[];   // other step ids that must approve first
    status: 'pending' | 'approved' | 'executed' | 'rejected' | 'blocked';
  }>;
};
```

- LLM produces a plan JSON for multi-verb transcripts.
- Each step is an individual proposal; the human approves per-step.
- Dependencies let later steps see earlier step outputs (e.g., newly-created
  customer id flows into the estimate step).
- If any step is rejected, downstream steps are marked `blocked` and skipped.

## Acceptance criteria (first pass — treat as MVP)

- [ ] Plan data model persisted in a new `assistant_plans` + `assistant_plan_steps` tables.
- [ ] Classifier or a new planner stage emits a plan for multi-verb inputs.
  Fall back to single-step when only one verb is detected.
- [ ] Each step is a normal proposal going through the existing approval flow —
  no bypass of the human-approval core rule.
- [ ] Later steps can reference earlier step outputs via a templating
  convention (e.g., `"customerId": "{{ step_1.result.customerId }}"`).
- [ ] UI shows the plan as a numbered list with per-step approve/reject.
- [ ] Rejection of step N blocks steps > N that depend on it.
- [ ] Integration test: "Create customer Acme, draft $1500 estimate, send the
  invoice" creates 3 steps, approving all 3 in order produces a customer, an
  estimate, and an issued invoice.
- [ ] QA matrix `AST-07` flips from fail → pass.

## Suggested split into sub-stories

This is too big for one branch. Suggested split:

1. **AST-07a** — Plan schema + persistence (no LLM yet).
2. **AST-07b** — Planner prompt that emits 2-step plans for trivial inputs.
3. **AST-07c** — Cross-step output templating.
4. **AST-07d** — Web UI for plan review + per-step approval.
5. **AST-07e** — Voice surface for plans (read plan aloud before executing).

Do (a) and (b) first; they unblock the matrix's minimum bar.

## Allowed files (per sub-story)

To be scoped when each sub-story is ready to work on.

## Out of scope

- Parallel step execution. Keep sequential for v1.
- Rollback of already-executed steps when a later step fails. Document as
  follow-up.

## Verify

```bash
npm run e2e:qa-matrix -- --grep AST-07
```

(Acceptance depends on all sub-stories landing — this is the final gate.)
