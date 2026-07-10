# feat: Wave 1 — Prove the money loop (umbrella)

**Created:** 2026-07-10  
**Depth:** Standard  
**Status:** plan (split into separate threads)  
**Depends on:** `fix/frontend-render-stability-and-e2e` — soft; can start in parallel  
**Out of scope:** Wave 2 (TCPA, appointment feasibility, field “I’m out”) and Wave 3 (auto-invoice, dunning, QBO)

---

## Separate threads (pick up independently)

> **Do not implement Wave 1 as one mega-PR.** Use one branch/PR per thread.

| Thread | Doc | Branch |
|--------|-----|--------|
| **Index** | [`wave1/README.md`](./wave1/README.md) | — |
| **W1-1** Estimate approve → execute | [`wave1/W1-1-estimate-approve-execute.md`](./wave1/W1-1-estimate-approve-execute.md) | `feat/w1-1-estimate-approve-execute` |
| **W1-2** Invoice webhook → paid | [`wave1/W1-2-invoice-webhook-paid.md`](./wave1/W1-2-invoice-webhook-paid.md) | `feat/w1-2-invoice-webhook-paid` |
| **W1-3** Public `/e/:id` | [`wave1/W1-3-public-estimate-approval.md`](./wave1/W1-3-public-estimate-approval.md) | `feat/w1-3-public-estimate-approval` |
| **W1-4** Public `/pay/:id` status | [`wave1/W1-4-public-pay-status.md`](./wave1/W1-4-public-pay-status.md) | `feat/w1-4-public-pay-status` |
| **W1-5** QA matrix business gate | [`wave1/W1-5-qa-matrix-business-gate.md`](./wave1/W1-5-qa-matrix-business-gate.md) | `chore/w1-5-qa-matrix-green` |

Each thread file includes a **handoff prompt** to paste into a new agent conversation.

---

## Summary

Turn Rivet’s **already-built** money spine into **continuously proven** CI evidence. Wave 1 does **not** add product features.

**Wave exit (all threads done):**

1. CI proves estimate approve → execute (W1-1)  
2. CI proves invoice → Stripe webhook → paid (W1-2)  
3. Hermetic public `/e/:id` + `/pay/:id` (W1-3, W1-4)  
4. One green QA matrix Business-Critical ≥27/30 (W1-5)  

---

## Kickoff order

```text
W1-3 ─┬─► W1-1 ─┐
      │         ├─► then W1-5
W1-4 ─┴─► W1-2 ─┘
```

Start **W1-3** and **W1-4** first (no auth). Run **W1-1** / **W1-2** in parallel next. **W1-5** last (operator/secrets).

---

## Progress

| Thread | Status |
|--------|--------|
| W1-1 Estimate approve → execute | ☐ Not started |
| W1-2 Invoice → webhook → paid | ☐ Not started |
| W1-3 Public `/e/:id` | ☐ Not started |
| W1-4 Public `/pay/:id` status | ☐ Not started |
| W1-5 QA matrix business gate | ☐ Not started |

---

## Success statement

> After all Wave 1 threads merge, any engineer can point at CI (and one QA matrix report) and say:  
> **“A tradesperson can approve an estimate and get paid — and we prove it on every PR.”**

## Related waves

- **Wave 2 (trust/field):** [`wave2/README.md`](./wave2/README.md) · [`2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md`](./2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md)
- **Wave 3 (product):** [`wave3/README.md`](./wave3/README.md) · [`2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md`](./2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)
