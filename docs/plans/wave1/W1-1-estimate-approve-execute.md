# W1-1 — Hermetic: estimate approve → execute

**Thread ID:** W1-1  
**Parent:** [Wave 1 index](./README.md) · [umbrella plan](../2026-07-10-001-feat-wave1-prove-money-loop-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w1-1-estimate-approve-execute`  
**PR title:** `test(e2e): hermetic estimate approve → execute (W1-1)`  
**Estimate:** 1–1.5 days  
**Parallel with:** W1-2; helpful after W1-3 fixture patterns exist

---

## Goal

Prove the AI OS loop in CI **without** Clerk cloud or a live LLM:

`pending estimate proposal → owner Approve in Inbox/Assistant → executed (estimate created/sent)`

## Why this thread exists

Journey 2 (`e2e/journeys/estimate-approval-execution.spec.ts`) is written but `test.skip`. Unit/integration cover pieces; nothing continuously proves the browser approve path.

## In scope

- Offline Clerk stub signed-in boot (reuse `clerk-stub` / offline-app fixture if present)
- Canned / seeded `ready_for_review` proposal (no `AI_PROVIDER_API_KEY`)
- Drive Approve in real SPA (Inbox preferred; Assistant OK)
- Assert approve POST + proposal reaches `executed` (mock worker tick **or** test hook to advance undo window)
- Spec runs with only `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…`

## Out of scope

- Live LLM drafting
- Real Clerk testing tokens / signup journey
- SMS one-tap path (digest/SMS can be a later thread)
- Wave 2/3 product work

## Approach

1. Read `e2e/journeys/estimate-approval-execution.spec.ts`, `e2e/helpers/clerk-stub.ts`, offline-authed plan.
2. Prefer new `e2e/money-loop/estimate-approve-execute.spec.ts` (keep old journey as docs or thin wrapper).
3. Mock or seed proposal list/detail + approve + post-approve status.
4. Handle 5s undo: advance `approvedAt` via test hook, or mock execution worker — **no multi-minute sleeps**.
5. Wire into default Playwright project / `e2e.yml` with placeholder `pk_test_` fallback.

## Expected files

| Path | Action |
|------|--------|
| `e2e/money-loop/estimate-approve-execute.spec.ts` | Create |
| `e2e/helpers/offline-app.ts` (or equivalent) | Create/reuse |
| `e2e/journeys/estimate-approval-execution.spec.ts` | Point at new spec or unskip via shared helper |
| `.github/workflows/e2e.yml` | Ensure placeholder key runs this spec |

## Done when

- [ ] Spec green locally with placeholder `pk_test_`
- [ ] Spec green in CI without `E2E_CLERK_SECRET_KEY`
- [ ] No `pageerror`; no dependence on live AI
- [ ] `render-stability` + `no-401-storm` still green
- [ ] PR links this thread doc

## Handoff prompt (paste into new agent thread)

```text
Implement W1-1 only: docs/plans/wave1/W1-1-estimate-approve-execute.md
Branch: feat/w1-1-estimate-approve-execute from main.
Do not implement W1-2..W1-5 or Wave 2/3.
Prove hermetic Inbox/Assistant approve → proposal executed without live LLM/Clerk secrets.
```
