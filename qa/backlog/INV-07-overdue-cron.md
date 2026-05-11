# INV-07 — Overdue status + nightly cron

**Matrix row:** INV-07 (Invoices · overdue detection)
**Current predicted verdict:** fail (no status, no transition, no job)
**Target verdict:** pass
**Effort:** L (1–2 days)

## Problem

No way to detect or expose overdue invoices. Collections workflows can't run;
the assistant can't surface "overdue" state; customer dashboards are blind.

## Evidence from code

- `packages/api/src/db/schema.ts:564` — invoice status enum:
  `draft|open|partially_paid|paid|void|canceled`. No `overdue`.
- `packages/api/src/invoices/invoice.ts:54-61` — status transitions, no
  `open → overdue` edge.
- Repo has no cron/scheduler for invoice maintenance. (`grep -r "overdue"
  packages/api/src` returns only assistant proposal-type references.)

## Acceptance criteria

### Schema + transitions

- [ ] Add `overdue` to invoice status enum (migration: ADD VALUE).
- [ ] Allowed transitions:
  - `open → overdue` (auto, via job)
  - `overdue → partially_paid | paid | void | canceled` (mirrors `open`)
  - `partially_paid → overdue` (yes — partially paid but past due is overdue)
- [ ] `POST /api/invoices/:id/transition` accepts `overdue` if dueDate has passed.
- [ ] On `paid`/`partially_paid` transition, if previously `overdue`, audit
  event records the recovery.

### Scheduled job

- [ ] New job `mark-invoices-overdue` runs daily at 02:00 tenant-local
  (or 02:00 UTC until we have per-tenant scheduling; document decision).
- [ ] Job flips `open` or `partially_paid` invoices where `due_date < now()` to
  `overdue`. Batch with an upper bound (e.g., 500 per run) and LIMIT/OFFSET or
  a cursor if needed.
- [ ] Uses the async worker pattern (P0-009), not a raw setInterval.
- [ ] Emits per-invoice audit events on transition.
- [ ] Integration test seeds invoices with past + future due dates and asserts
  only the past ones transition.

### Query surface

- [ ] `GET /api/invoices?status=overdue` returns overdue invoices for the
  tenant (depends on INV-02).

## Dependencies

- INV-02 must land first so the matrix row can observe overdue invoices via
  the list endpoint. If INV-02 slips, the matrix row can still read the DB
  directly via Agent C.

## Allowed files

- `packages/api/src/db/schema.ts` + migration
- `packages/api/src/invoices/invoice.ts` (transitions)
- `packages/api/src/invoices/overdue-job.ts` (new)
- `packages/api/src/jobs/registry.ts` or equivalent (wire the job)
- `packages/api/src/routes/invoices.ts` (only to extend filter validation)
- `packages/api/src/invoices/__tests__/*`

## Out of scope

- Customer reminder emails on overdue (separate story — collections).
- Grace-period configuration per tenant.
- Business day vs calendar day logic for dueDate (document as follow-up).

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- overdue
# Manual: invoke the job locally
npx tsx packages/api/scripts/run-overdue-job.ts
npm run e2e:qa-matrix -- --grep INV-07
```
