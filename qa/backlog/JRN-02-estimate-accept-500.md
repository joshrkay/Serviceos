# JRN-02 — Estimate accept transition returns 500

**Matrix row:** JRN-02 (Billing journey · three estimates → invoice two)
**Live verdict (2026-06-04):** fail
**Status: FIXED on `fix/qa-matrix-live-run-findings` 2026-06-04 — JRN-02 re-run = PASS**
Root cause: the partial unique index `uq_estimates_accepted_per_job` (one
accepted estimate per job, a deliberate billing-correctness rule). The
transition handler let the unique violation escape as a raw 500, and the
journey rows shared one seeded job so JRN-01's accepted estimate poisoned
JRN-02 (and EST-05, and any re-run). Fix: (a) transitionEstimateStatus
pre-checks the job and maps the 23505 race to ConflictError 409 with an
actionable message; (b) rows that accept estimates seed their OWN job
(e2e/qa-matrix/helpers/seed-entities.ts).
**Target verdict:** pass
**Effort:** M (needs server-log diagnosis first)

## Problem

`POST /api/estimates/:id/transition { "status": "accepted" }` returned
**500 INTERNAL_ERROR** (66 ms) for JRN-02's first estimate, immediately after
the same estimate's `sent` transition succeeded. JRN-01 runs the identical
draft → sent → accepted sequence and passes, so the failure is specific to
JRN-02's estimate shape (three estimates with distinct line items on one job)
or to repeated accepts against the same job.

## Evidence from the live run

- `qa/reports/2026-06-04/artifacts/JRN-02/api/02-accept-0-sent.json` —
  transition to `sent` → 200.
- `qa/reports/2026-06-04/artifacts/JRN-02/api/02-accept-0-accepted.json` —
  transition to `accepted` → 500 `{"error":"INTERNAL_ERROR"}`.
- Passing control: `qa/reports/2026-06-04/artifacts/JRN-01/api/01-accepted.json` → 200.

## Acceptance criteria

- [ ] Root cause identified from Railway dev API logs at 2026-06-04T19:51:56Z.
- [ ] Accept transition succeeds for JRN-02's fixture shape.
- [ ] Regression test covering the failing shape.
- [ ] QA matrix JRN-02 flips fail → pass.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run e2e:qa-matrix -- --grep JRN-02
```
