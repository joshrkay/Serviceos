# feat: Wave 3 — Product day-in-the-life improvements (umbrella)

**Created:** 2026-07-10  
**Depth:** Standard  
**Status:** plan (split into separate threads)  
**Depends on:** Wave 1 (prove money) + Wave 2 (trust/legal) preferred before sales claims  
**Out of scope:** Full Jobber console parity; financing/tap-to-pay/PDF leaf unless a thread explicitly needs them

> **Naming:** Quality-assessment Wave 3 — overlaps parity **P20–P27** but is sequenced for Mike/Jenna day-in-the-life, not the full parity wave chart.

---

## Separate threads (pick up independently)

| Thread | Doc | Branch |
|--------|-----|--------|
| **Index** | [`wave3/README.md`](./wave3/README.md) | — |
| **W3-1** Auto-invoice on completion | [`wave3/W3-1-auto-invoice-on-completion.md`](./wave3/W3-1-auto-invoice-on-completion.md) | `feat/w3-1-auto-invoice-on-completion` |
| **W3-2** Multi-step dunning | [`wave3/W3-2-multi-step-dunning.md`](./wave3/W3-2-multi-step-dunning.md) | `feat/w3-2-multi-step-dunning` |
| **W3-3** Estimate confidence UI | [`wave3/W3-3-estimate-confidence-ui.md`](./wave3/W3-3-estimate-confidence-ui.md) | `feat/w3-3-estimate-confidence-ui` |
| **W3-4** Emergency triage honesty | [`wave3/W3-4-emergency-triage-honesty.md`](./wave3/W3-4-emergency-triage-honesty.md) | `feat/w3-4-emergency-triage-honesty` |
| **W3-5** QBO sync enablement | [`wave3/W3-5-qbo-sync-enablement.md`](./wave3/W3-5-qbo-sync-enablement.md) | `feat/w3-5-qbo-sync-enablement` |
| **W3-6** Route + ETA texts | [`wave3/W3-6-route-eta-texts.md`](./wave3/W3-6-route-eta-texts.md) | `feat/w3-6-route-eta-texts` |

Each thread includes a paste-ready **handoff prompt**.

---

## Summary

Ship the next **product** capabilities that move the day-in-the-life:

| Thread | Mike/Jenna moment |
|--------|-------------------|
| W3-1 | Job done → invoice draft waiting for approve |
| W3-2 | Unpaid invoices chased on a real cadence |
| W3-3 | Owner sees when AI is unsure on a quote |
| W3-4 | Emergencies escalate honestly — no fake triage |
| W3-5 | Books sync without weekend QuickBooks hell |
| W3-6 | Route/ETA saves drive time; customers get ETAs |

## Kickoff order

```text
W3-1 auto-invoice ─► W3-2 dunning
W3-3 confidence ─┐
W3-4 emergency ──┴─► independent
W3-5 QBO (ops/credentials)
W3-6 route/ETA (after W2-2)
```

## Progress

| Thread | Status |
|--------|--------|
| W3-1 Auto-invoice | ☐ Not started |
| W3-2 Dunning | ☐ Not started |
| W3-3 Confidence UI | ☐ Not started |
| W3-4 Emergency honesty | ☐ Not started |
| W3-5 QBO | ☐ Not started |
| W3-6 Route/ETA | ☐ Not started |

## Success statement

> Completion can mint invoice proposals; overdue walks a cadence; owners see estimate confidence; emergencies don’t overclaim; QBO has an on-ramp; route/ETA has a thin approve surface — each tested.
