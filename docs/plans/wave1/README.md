# Wave 1 — Prove the money loop (thread index)

**Created:** 2026-07-10  
**Parent plan:** [`../2026-07-10-001-feat-wave1-prove-money-loop-followup-plan.md`](../2026-07-10-001-feat-wave1-prove-money-loop-followup-plan.md)  
**Goal:** Continuously prove Rivet’s already-built money spine in CI — not add new product features.

Each item below is a **separate thread**: own branch, own PR, own done criteria. Threads can run in parallel unless noted.

| Thread | Title | Branch | Parallel? | Est. |
|--------|-------|--------|-----------|------|
| [W1-1](./W1-1-estimate-approve-execute.md) | Hermetic: estimate approve → execute | `feat/w1-1-estimate-approve-execute` | After W1-3 helpful, not required | 1–1.5d |
| [W1-2](./W1-2-invoice-webhook-paid.md) | Hermetic: invoice → Stripe webhook → paid | `feat/w1-2-invoice-webhook-paid` | Parallel with W1-1 | 1–1.5d |
| [W1-3](./W1-3-public-estimate-approval.md) | Hermetic: public `/e/:id` approve | `feat/w1-3-public-estimate-approval` | **Start here** (no auth) | 0.5–1d |
| [W1-4](./W1-4-public-pay-status.md) | Hermetic: public `/pay/:id` status | `feat/w1-4-public-pay-status` | Parallel with W1-3 | 0.5–1d |
| [W1-5](./W1-5-qa-matrix-business-gate.md) | One green QA matrix (Business-Critical) | `chore/w1-5-qa-matrix-green` | After hermetic specs preferred | 0.5–1d ops |

```text
Recommended kickoff order (still separate PRs):

  W1-3 ─┬─► W1-1 ─┐
        │         ├─► CI wiring note in each PR ─► W1-5
  W1-4 ─┴─► W1-2 ─┘
```

## Shared constraints (all threads)

- **Do not** pull in Wave 2 (TCPA, appointment feasibility) or Wave 3 (auto-invoice, dunning, QBO).
- Soft dependency on `fix/frontend-render-stability-and-e2e` — merge if available; don’t block.
- Prefer hermetic Clerk-stub / public mocks over live Clerk + Stripe network.
- Reuse: `e2e/helpers/clerk-stub.ts`, `e2e/render-stability.spec.ts`, `docs/plans/2026-07-06-001-feat-offline-authed-e2e-coverage-plan.md`.

## Wave exit (all threads done)

> CI (and one QA matrix report) shows: **a tradesperson can approve an estimate and get paid — and we prove it on every PR.**
