# W3-5 — QuickBooks sync enablement path

**Thread ID:** W3-5  
**Parent:** [Wave 3 index](./README.md) · [umbrella](../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w3-5-qbo-sync-enablement`  
**PR title:** `feat(qbo): enablement path + digest sync status (W3-5)`  
**Estimate:** 2–3 days  
**Parity:** P23 / C4  
**Depends on:** Wave 1 money proof; Intuit app credentials in env

---

## Goal

QBO is **built but off-by-default**. Deliver a safe enablement path: OAuth connect, queue-driven sync worker, digest “synced ✓ / 1 failed — Retry?”, no owner console sprawl.

## In scope

- Verify OAuth token pattern (mig 084/085) + worker registration in `app.ts`
- Settings: Connect / Disconnect QuickBooks
- Sync invoices/payments (scope the minimum viable entity set and document it)
- Digest or inbox failure retry proposal
- Integration tests with mocked Intuit API
- Runbook: env vars + Intuit app review notes

## Out of scope

- Full chart-of-accounts mapping UI
- Xero
- PDF renderer leaf (parity Wave 0) unless sync attach is blocked — then file dependency note, don’t expand scope silently
- Rewriting billing engine

## Done when

- [ ] Documented enable path works in dev with keys
- [ ] Failure surfaces to owner (digest/proposal)
- [ ] Tests for sync happy + auth failure
- [ ] PR links this thread + runbook snippet

## Handoff prompt

```text
Implement W3-5 only: docs/plans/wave3/W3-5-qbo-sync-enablement.md
Branch: feat/w3-5-qbo-sync-enablement from main.
QBO enablement + digest status; mocked Intuit tests.
Do not build full accounting console or Xero.
```
