# Wave 3 — Product improvements for Mike/Jenna’s day (thread index)

**Created:** 2026-07-10  
**Umbrella:** [`../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md`](../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)  
**Depends on:** Wave 1 (prove money) + Wave 2 (trust/legal) preferred before claiming these in sales  
**Goal:** Ship the next **product** capabilities that move day-in-the-life moments — AI-first, proposal/digest surfaces — with proof.

> **Naming note:** This is the *quality-assessment* Wave 3 (product day-in-the-life), overlapping parity **P20–P27** clusters. Prefer extending existing workers/proposals over new consoles.

Each item is a **separate thread**: own branch, own PR, own done criteria.

| Thread | Title | Branch | Parallel? | Est. | Parity anchor |
|--------|-------|--------|-----------|------|---------------|
| [W3-1](./W3-1-auto-invoice-on-completion.md) | Auto-invoice on job complete (prove + default path) | `feat/w3-1-auto-invoice-on-completion` | **Start here** | 1–2d | P20 / C1 |
| [W3-2](./W3-2-multi-step-dunning.md) | Multi-step overdue dunning cadence | `feat/w3-2-multi-step-dunning` | After W3-1 | 1.5–2d | P20 / C1 |
| [W3-3](./W3-3-estimate-confidence-ui.md) | Estimate confidence / ambiguity in UI | `feat/w3-3-estimate-confidence-ui` | Parallel | 1–1.5d | Estimating JTBD |
| [W3-4](./W3-4-emergency-triage-honesty.md) | Emergency triage honesty (no overclaim) | `feat/w3-4-emergency-triage-honesty` | Parallel | 1d | Emergencies JTBD |
| [W3-5](./W3-5-qbo-sync-enablement.md) | QuickBooks sync enablement path | `feat/w3-5-qbo-sync-enablement` | After money proof | 2–3d | P23 / C4 |
| [W3-6](./W3-6-route-eta-texts.md) | Route suggestion + GPS ETA texts | `feat/w3-6-route-eta-texts` | Later | 2–3d | P27 / C8 |

```text
Recommended kickoff (separate PRs):

  W3-1 auto-invoice ─► W3-2 dunning
  W3-3 confidence UI ─┐
  W3-4 emergency ─────┴─► (independent)
  W3-5 QBO  (needs Connect/OAuth ops)
  W3-6 route/ETA (needs travel-time + GPS confidence)
```

## Shared constraints

- **AI-first delivery:** proposal / SMS one-tap / digest line — not a new admin console.
- Proposal three-place ritual for any new `ProposalType`.
- Workers: `registerInterval` + `runAsLeader`; idempotent dedup tables.
- Integer cents; FORCE RLS; audit on mutations.
- Do not block Wave 3 on financing/tap-to-pay/PDF leaf unless a thread explicitly needs it.

## Wave exit (all threads done)

> Job completion can mint an invoice proposal; overdue invoices walk a real cadence; owners see estimate confidence; emergencies don’t overclaim; QBO has a documented on path; ETA/route has a thin approve surface — each with tests.
