# W2-2 — Feasibility gate on `POST /api/appointments`

**Thread ID:** W2-2  
**Parent:** [Wave 2 index](./README.md) · [umbrella](../2026-07-10-002-feat-wave2-trust-and-field-gaps-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w2-2-appointment-feasibility-gate`  
**PR title:** `fix(scheduling): enforce feasibility on appointment create (W2-2)`  
**Estimate:** 0.5–1 day  
**Parallel with:** W2-1, W2-3

---

## Goal

Direct `POST /api/appointments` must not create overlapping/infeasible bookings that only fail later at assignment time. Reuse `scheduling/feasibility.ts` (and DB exclusion where applicable).

## Why this thread exists

Double-booking protection was partially fixed (DB EXCLUDE / assignment path). `POST /api/appointments` still calls `createAppointment` **without** a feasibility options argument — advisory gap / TOCTOU risk for unassigned overlaps and bad windows.

## In scope

- Wire feasibility (or equivalent validation) into `packages/api/src/routes/appointments.ts` create path
- Return clear 409/400 with machine-readable reason when infeasible
- Integration tests: overlapping tech assignment rejected; happy path still works
- Emit audit on rejected create if that’s the house pattern for scheduling mutations
- Document interaction with existing `no_double_booking` trigger

## Out of scope

- Full AI auto-dispatch ranking (parity P25 / W3-6 adjacent)
- Rewriting the dispatch board UI
- Hold reaper / ETA mutation (separate stories)

## Key files

| Path | Role |
|------|------|
| `packages/api/src/routes/appointments.ts` | Create route |
| `packages/api/src/scheduling/feasibility.ts` | Reuse |
| `packages/api/src/dispatch/validation.ts` | Related |
| Assignment / schema EXCLUDE migrations | Backstop |

## Done when

- [ ] Create route invokes feasibility (or documented stricter equivalent)
- [ ] Integration test covers conflict rejection
- [ ] No silent success on known-overlapping assigned create
- [ ] PR links this thread

## Handoff prompt

```text
Implement W2-2 only: docs/plans/wave2/W2-2-appointment-feasibility-gate.md
Branch: feat/w2-2-appointment-feasibility-gate from main.
Add feasibility enforcement to POST /api/appointments; integration tests.
Do not implement other Wave 2/3 threads.
```
