# Wave 2 — Trust, legal & field gaps (thread index)

**Created:** 2026-07-10  
**Umbrella:** [`../2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md`](../2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md)  
**Depends on:** Wave 1 money-loop proof preferred, not hard-blocked  
**Goal:** Close the remaining **trust / legal / correctness** gaps so a beta shop can run outbound voice, scheduling, and field flows without silent failures.

> **Naming note:** This is the *quality-assessment* Wave 2 (trust & field), **not** the parity-roadmap “Wave 2 / truck is the office” (P24/P26). Parity clusters are referenced where they overlap.

Each item is a **separate thread**: own branch, own PR, own done criteria.

| Thread | Title | Branch | Parallel? | Est. |
|--------|-------|--------|-----------|------|
| [W2-1](./W2-1-tcpa-dnc-outbound-consent.md) | Wire TCPA/DNC outbound consent | `feat/w2-1-tcpa-dnc-outbound-consent` | **Start here** (legal) | 1d |
| [W2-2](./W2-2-appointment-feasibility-gate.md) | Feasibility on `POST /api/appointments` | `feat/w2-2-appointment-feasibility-gate` | Parallel with W2-1 | 0.5–1d |
| [W2-3](./W2-3-estimate-tier-cents-display.md) | Estimate tier cents display | `feat/w2-3-estimate-tier-cents-display` | Parallel (tiny) | 0.25d |
| [W2-4](./W2-4-notes-to-draft-invoice.md) | Job notes → draft invoice proposal | `feat/w2-4-notes-to-draft-invoice` | After W2-1/2 preferred | 1–2d |
| [W2-5](./W2-5-field-tech-out-and-day-proof.md) | Field: tech-out + technician day proof | `feat/w2-5-field-tech-out-day-proof` | Parallel with W2-4 | 1–1.5d |

```text
Recommended kickoff (separate PRs):

  W2-1 (TCPA) ──┐
  W2-2 (feas.) ─┼─► W2-4 (notes→invoice)
  W2-3 (cents) ─┘         │
                          └─► W2-5 (field proof)
```

## Shared constraints

- Do **not** pull Wave 3 product expansion (multi-step dunning UX, QBO enablement, route opt) into these PRs.
- Prefer wiring **existing** modules (`outbound-consent.ts`, `scheduling/feasibility.ts`, P6-028 tech-status) over rewrites.
- Every thread ships tests (unit and/or integration); hermetic E2E where UI-facing.
- Money stays integer cents; mutations emit audit events; AI stays behind the proposal gate.

## Wave exit (all threads done)

> Outbound AI cannot dial without consent; direct appointment create cannot double-book past feasibility; public estimate money renders correctly; a tech can mark out / run their day with proof in CI.
