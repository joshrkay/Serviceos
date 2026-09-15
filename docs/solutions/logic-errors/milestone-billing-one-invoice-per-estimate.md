---
title: "Milestone billing silently dropped every invoice after the deposit: a blanket 23505 catch hid the one-invoice-per-estimate index"
date: 2026-09-06
track: knowledge
problem_type: logic-errors
module: packages/api/src/invoices
tags: ["invoices", "milestone-billing", "postgres", "unique-index", "23505", "silent-failure", "integration-test"]
related: []
---

## Symptom

A 50% deposit / 50% balance `create_invoice_schedule` that referenced an
accepted estimate billed only the deposit. Completing the job created no
balance invoice, and nothing said so: the HTTP transition succeeded, the API
log was clean, no audit event fired. Found by driving the money loop on a real
Postgres during the 2026-09-06 visual verification pass, not by any test.

## Root cause

`invoices` carries two partial unique indexes:

- `uq_invoices_estimate` on `(estimate_id)` — an estimate converts to one invoice.
- `uniq_invoices_schedule_milestone` on `(schedule_id, milestone_index)` — one
  invoice per milestone.

Both mint paths (`proposals/execution/invoice-schedule-handler.ts` for
`on_accept`, `invoices/schedule-completion.ts` for `on_completion`) stamped
`estimate_id` on every milestone invoice, so the second one tripped the first
index. Both catch blocks matched on `err.code === '23505'` alone and treated
any duplicate key as "a concurrent run already minted this milestone", so the
real failure was swallowed as success.

In-memory repositories never raise either index, so the unit suite passed.

## Fix

- Only the first invoice minted for a schedule's estimate carries
  `estimate_id` (`milestoneEstimateLink` in `invoice-schedule.ts`); later
  milestones reach the estimate through the schedule row.
- The catch blocks now use `isDuplicateMilestoneError`, which also checks
  `err.constraint === 'uniq_invoices_schedule_milestone'`. A 23505 from any
  other index propagates (the handler reports execution failure).
- `test/integration/milestone-billing-estimate-link.test.ts` pins both index
  names and mints deposit + balance against real Postgres.

## Guidance

- Never catch Postgres 23505 by code alone when a table has more than one
  unique index. Match `err.constraint` to the index you mean, or the catch
  becomes a silent-drop path for every other invariant on the table.
- A swallowed write on a money path needs a real-DB test in the same commit;
  mocked repos cannot prove an INSERT survives the schema.
- `PgSettingsRepository.create()` does not persist `milestone_billing_enabled`;
  tests must set it through `update()`.
