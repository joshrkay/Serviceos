# W3-2 — Multi-step overdue dunning cadence

**Thread ID:** W3-2  
**Parent:** [Wave 3 index](./README.md) · [umbrella](../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w3-2-multi-step-dunning`  
**PR title:** `feat(invoices): multi-step overdue dunning cadence (W3-2)`  
**Estimate:** 1.5–2 days  
**Parity:** P20 / C1  
**Depends on:** W3-1 helpful (same money cluster); not hard-required

---

## Goal

Replace “single overdue notice” with a **configurable reminder cadence** (e.g. day 3 / 7 / 14) via the existing overdue sweep + leader lock, summarizing outcomes in the digest. Optional late-fee accrual only if billing engine already supports it cleanly.

## In scope

- Cadence config on tenant settings (sensible defaults)
- Overdue worker walks steps idempotently (dedup table or period key)
- Customer comms autonomous; money-touching late fees = proposal if irreversible
- Digest lines for sent / paid / silent
- Tests for step transitions + idempotency

## Out of scope

- Collections agency integrations
- Consumer financing (P22)
- Changing Stripe payment link generation

## Key reuse

- Existing overdue sweep in `app.ts` / invoice workers
- `runAsLeader` + idempotency pattern from `service_agreement_runs`

## Done when

- [ ] ≥2 reminder steps configurable and tested
- [ ] No duplicate sends on multi-instance (leader lock)
- [ ] Digest or audit shows cadence outcomes
- [ ] PR links this thread

## Handoff prompt

```text
Implement W3-2 only: docs/plans/wave3/W3-2-multi-step-dunning.md
Branch: feat/w3-2-multi-step-dunning from main.
Multi-step overdue cadence on existing sweep; idempotent + tests.
Do not implement financing or QBO.
```
