# W3-6 — Route suggestion + GPS ETA texts

**Thread ID:** W3-6  
**Parent:** [Wave 3 index](./README.md) · [umbrella](../2026-07-10-003-feat-wave3-product-day-in-the-life-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w3-6-route-eta-texts`  
**PR title:** `feat(dispatch): route suggestion proposal + ETA texts (W3-6)`  
**Estimate:** 2–3 days  
**Parity:** P27 / C8 (+ P25 assign ranking optional stretch)  
**Depends on:** W2-2 feasibility; existing GPS pings + travel-time helpers

---

## Goal

AI-first “Jenna’s 90 minutes saved”:

1. Ranked/ordered route (or assign) as a **proposal**: *“This route saves ~N min — Approve?”*  
2. Customers get **ETA texts** driven from stored GPS pings (autonomous comms)

## In scope

- Reuse `scheduling/travel-time/` (haversine fallback OK if Maps key absent)
- New or existing proposal type via three-place ritual
- Thin approve UI (inbox/SMS) — not a full route-planning console
- ETA SMS worker/trigger with idempotency + STOP/DNC respect (reuse SMS consent)
- Tests: ranking deterministic with fixed coords; ETA send idempotent

## Out of scope

- Owner-facing drag-the-map route console (positioning forbids)
- Full AI dispatch skill matrix (P25 can be stretch if cheap)
- Offline field PWA (P26)

## Done when

- [ ] Proposal path creates approve-able route/order suggestion
- [ ] ETA text path tested with consent/DNC guard
- [ ] Works without paid Maps key (fallback documented)
- [ ] PR links this thread

## Handoff prompt

```text
Implement W3-6 only: docs/plans/wave3/W3-6-route-eta-texts.md
Branch: feat/w3-6-route-eta-texts from main.
Route/order proposal + GPS ETA texts; AI-first, no route console.
Respect DNC/SMS consent. Do not build P26 field PWA.
```
