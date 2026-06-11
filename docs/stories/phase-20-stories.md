# Phase 20 — Cash Collects Itself (Auto-invoice + Dunning + Progress/Batch)

> **Wave 1 of the Jobs & Invoicing Parity Roadmap** (`docs/strategy/parity-jobs-invoicing.md`).
> Clusters C1 (auto-invoice + dunning) and C2 (progress + batch invoicing). Zero external integrations — pure reuse of the existing workers, the proposal gate, the billing engine, and the `service_agreement_runs` idempotency template.

## Purpose

Close the time-to-cash gap so an owner never hand-writes an invoice or chases a payment. A completed job auto-drafts an invoice the owner sends with one SMS tap; overdue invoices walk a configurable reminder cadence and accrue late fees automatically; large jobs bill in milestones; and a morning nudge bulk-generates invoices for everything finished yesterday. Every surface is a one-tap proposal or a digest line — no invoicing console.

## Exit Criteria

A job flips to `completed` → the owner gets one SMS proposal and the invoice goes out on approval. An unpaid invoice receives the tenant's configured reminders (e.g. day 3 SMS, day 7 email) and a late fee after grace, all idempotently. A `$12k` job can bill 50% deposit / 50% balance. The digest reports "6 jobs invoiced, 3 follow-ups sent, 1 late fee added."

| Story | Title | Size | Status |
|---|---|---|---|
| P20-001 | Auto-draft invoice on job completion | M | **Landed** (toggle mig. 137 + `auto-invoice-on-completion.ts` + completion-hook wiring) |
| P20-002 | Dunning cadence + late-fee config (data model) | S | **Landed** (migration 136 + repos) |
| P20-003 | Multi-step reminder cadence in the overdue sweep | M | Partially landed (pure selection `dunning-schedule.ts` done; worker wiring pending) |
| P20-004 | Late-fee accrual | S | Partially landed (pure calc `late-fee.ts` done; worker accrual + proposal pending) |
| P21-001 | Invoice schedule / milestone linkage (data model) | S | **Landed** (mig. 138 + `invoice-schedule.ts` `splitMilestones` + repos + `invoices.schedule_id/milestone_index`) |
| P21-002 | `create_invoice_schedule` proposal type | M | **Landed** (three-place ritual + `invoice-schedule-handler.ts`; mints first milestone invoice) |
| P21-003 | "Requires invoicing" queue + batch-generate sweep | M | **Landed** (queue + `batch_invoice` type + sweep + dedup; mig. 139). Web list = follow-up |

---

### P20-001 — Auto-draft invoice on job completion
**Status:** Landed. Toggle `tenant_settings.auto_invoice_on_completion` (migration 137, opt-in, off by default; settable via the settings API). `invoices/auto-invoice-on-completion.ts maybeAutoInvoiceOnCompletion` builds line items from the accepted estimate's billed selection (`resolveSelectedLineItems`) and raises a `draft_invoice` proposal (validated via `validateProposalPayload`); wired best-effort into the job-completion endpoint alongside `feedback_send`. Idempotent (no-op when already invoiced / ineligible money-state / nothing to bill). **Follow-up:** apply `applyDepositCreditToInvoice` at draft_invoice execution (deposit credit happens on the resulting invoice, not at proposal time); thin Settings toggle UI.
**Allowed files:** `packages/api/src/jobs/job-lifecycle.ts` (emit a hook on `in_progress→completed`), `packages/api/src/invoices/auto-invoice-on-completion.ts` (new), `packages/api/src/jobs/pg-job-lifecycle.ts` (call inside the transition), `packages/api/test/invoices/auto-invoice-on-completion.test.ts` (new), `packages/api/src/db/schema.ts` (only if a `tenant_settings` toggle column is needed).
**Build prompt:** On the `completed` transition, if the job has no open/paid invoice and `money_state ∈ {estimate_accepted, no_estimate}`, build line items from the accepted estimate (or job catalog lines) via `shared/billing-engine.ts calculateDocumentTotals`, then create a `draft_invoice` proposal through the existing proposal path (trust gate + audit apply). If a deposit exists, call `invoices/deposit-credit.ts applyDepositCreditToInvoice` on the resulting draft. Gate behind a `tenant_settings.auto_invoice_on_completion` toggle (reuse the quick-toggles JSONB). No new proposal type — `draft_invoice` already exists; chain a `send_invoice` (comms, one-tap).
**Reuse:** `draftInvoicePayloadSchema` (`proposals/contracts.ts`), `invoices/convert-estimate.ts`, `invoices/deposit-credit.ts`, `jobs/job-money-state.ts`.
**Required tests:** completed job with accepted estimate → one draft proposal; deposit credited; idempotent (no second draft on re-entry); toggle off → no-op.
**Verification:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run auto-invoice-on-completion`

---

### P20-002 — Dunning cadence + late-fee config (data model)  ✅ LANDED
**Status:** Landed in this slice.
**Files:** `packages/api/src/db/schema.ts` (migration `136_create_invoice_dunning`), `packages/api/src/invoices/dunning-config.ts` (entities + in-memory repos), `packages/api/src/invoices/pg-dunning-config.ts` (Pg repos), `packages/api/test/invoices/dunning-config.test.ts`.
**What shipped:** Two RLS tables — `invoice_dunning_configs` (one per tenant: ordered `reminder_steps` JSONB; `late_fee_type none|flat|percent`, value in cents/bps, grace days, optional cap) and `invoice_dunning_events` (`(tenant, invoice, kind, step_key) UNIQUE` idempotency ledger). The dedup `step_key` is a **stable identity** — reminders use `'<offsetDays>:<channel>'` (via `reminderStepKey`), late fees use a period key (`LATE_FEE_ONE_TIME_KEY` for one-time) — so editing/reordering the cadence never resends or skips. Repos mirror the `service_agreement_runs` pattern (in-memory raises `23505` on duplicate). `defaultDunningConfig()` returns a UUID-id, single-3-day-SMS fallback.
**Follow-up (not yet landed):** thin Settings → "Payment reminders" config screen; wiring the repos into `app.ts` (happens with P20-003).
**Verification (passing):** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run test/invoices/dunning-config.test.ts`

---

### P20-003 — Multi-step reminder cadence in the overdue sweep
**Status:** Partially landed — pure selection done; worker wiring pending.
**Done:** `packages/api/src/invoices/dunning-schedule.ts` `selectDueReminderSteps(config, {dueDate, now, sentStepIndexes})` (pure, ordered, skips already-sent, honors `enabled`) + tests.
**Remaining — Allowed files:** `packages/api/src/workers/overdue-invoice-worker.ts` (walk due steps; record `invoice_dunning_events`), `packages/api/src/notifications/transactional-comms-service.ts` (parameterize `notifyInvoiceOverdue` by step/channel), `packages/api/src/app.ts` (inject `dunningConfigRepo` + `dunningEventRepo`; **reuse `SWEEP_LOCK.overdueInvoice`** — no new lock), `packages/api/test/workers/overdue-invoice-worker.test.ts`.
**Build prompt:** For each overdue invoice, load the tenant config (fallback `defaultDunningConfig`), read sent step keys via `dunningEventRepo.findByInvoice` (map to `stepKey`), call `selectDueReminderSteps`, send each step's channel via `transactionalComms`, then insert the `invoice_dunning_events(kind='reminder', step_key, channel)` dedup row (catch `23505` as "already sent"). Reconcile with the existing `message_dispatches` send-dedupe (entity_type `invoice_overdue`) rather than introducing a competing source of truth. Keep the existing single `invoice.overdue` audit on first crossing.
**Reuse:** entire existing `overdue-invoice-worker` loop shape; `refreshJobMoneyStateSafe`; the leader-gated `setInterval` wiring.
**Required tests:** day-3 sends step 0 only; day-9 sends 0+1; re-run sends nothing new; `23505` swallowed; disabled config sends nothing.
**Verification:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run overdue-invoice-worker`

---

### P20-004 — Late-fee accrual
**Status:** Partially landed — pure calc done; worker accrual + proposal pending.
**Done:** `packages/api/src/invoices/late-fee.ts` `computeLateFeeCents(config, {amountDueCents, dueDate, now, alreadyAccruedCents})` + `daysPastDue()` (flat/percent in bps, grace, cap, integer-cents, rounding) + tests.
**Remaining — Allowed files:** `packages/api/src/workers/overdue-invoice-worker.ts` (accrue once per period), `packages/api/src/invoices/late-fee.ts` (apply-as-line-item helper if needed), `packages/api/test/invoices/late-fee-accrual.test.ts`.
**Build prompt:** When `computeLateFeeCents > 0` and no `late_fee` dunning event exists for the current period key (`LATE_FEE_ONE_TIME_KEY` for a one-time fee; a period bucket like `'2026-02'` for recurring), append a late-fee line item (category `other`, `taxable=false`) via `billing-engine`, recompute totals, refresh money-state, and insert `invoice_dunning_events(kind='late_fee', step_key, amount_cents)`. Default = surface as an `update_invoice` proposal (money-affecting) — auto-apply only if the tenant opts in. Cap via `lateFeeMaxCents` using the sum of prior `late_fee` event `amount_cents`.
**Reuse:** `billing-engine.calculateDocumentTotals`; `update_invoice` proposal type (exists); money-state refresh.
**Required tests:** fee appended once; second sweep is a no-op; cap respected across periods; proposal-vs-auto-apply branch.
**Verification:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run late-fee`

---

### P21-001 — Invoice schedule / milestone linkage (data model)
**Status:** Landed. `invoice_schedules` table (mig. 138, RLS) + `invoices.schedule_id`/`milestone_index`. `invoices/invoice-schedule.ts` owns the entity, `validateMilestones` (exactly one `remainder`; percents 0–10000 bps; non-negative flat cents — mirrors the P21-002 Zod rule), and the pure `splitMilestones(totalCents, milestones)` (percent=bps, flat=cents, the single `remainder` absorbs rounding so Σ === total). `pg-invoice-schedule.ts` mirrors the dunning repo (RLS via `withTenant`). **Not yet wired into app.ts** — the `PgInvoiceScheduleRepository` is consumed by P21-002 (`create_invoice_schedule` proposal).
**Allowed files:** `packages/api/src/invoices/invoice-schedule.ts` (+ `pg-invoice-schedule.ts`), `packages/api/src/db/schema.ts` (migration — discover next number), `packages/api/src/invoices/invoice.ts` (optional `scheduleId`/`milestoneIndex`), tests.
**Build prompt:** `invoice_schedules(job_id, estimate_id, total_amount_cents, milestones JSONB)` + `invoices.schedule_id`, `invoices.milestone_index`. Pure `splitMilestones(totalCents, milestones[])` guarantees Σ == total (a `remainder` milestone absorbs rounding). RLS standard.
**Reuse:** deposit-on-job concept; `applyDepositCreditToInvoice` as the deposit→balance credit path; `billing-engine` rounding.
**Required tests:** `splitMilestones` conserves cents across percent/flat/remainder; RLS isolation.
**Verification:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run invoice-schedule`

---

### P21-002 — `create_invoice_schedule` proposal type
**Status:** Landed. Three-place ritual done: `CREATE_INVOICE_SCHEDULE` enum (`packages/shared`), `create_invoice_schedule` added to the `proposal.ts` union + `PROPOSAL_TYPES` + `actionClassForProposalType` (capture) + `prioritization.ts`, and `contracts/create-invoice-schedule.ts` registered in `PROPOSAL_TYPE_SCHEMAS` (Zod: exactly one `remainder`, percent ≤ 10000 bps). `execution/invoice-schedule-handler.ts` writes the `invoice_schedules` row (total from payload or derived from the estimate via `splitMilestones`) then drafts the first milestone invoice linked by `schedule_id`/`milestone_index` (threaded through `createInvoiceWithNextNumber`); registered in the handler registry + app.ts with an `InvoiceScheduleRepository`. **Done:** later milestones now mint on job completion — `invoices/schedule-completion.ts mintCompletionMilestones` drafts each `on_completion` milestone (idempotent via `schedule_id`+`milestone_index`), wired into the job-completion path next to auto-invoice. So a deposit/balance plan auto-bills the balance.
**Allowed files:** `packages/api/src/proposals/proposal.ts` (union + classify `capture`), `packages/shared/src/enums.ts` (`CREATE_INVOICE_SCHEDULE`), `packages/api/src/proposals/contracts/create-invoice-schedule.ts` (+ register in `PROPOSAL_TYPE_SCHEMAS`), `packages/api/src/proposals/execution/invoice-schedule-handler.ts`, tests.
**Build prompt:** Payload `{ jobId, estimateId?, milestones:[{label, type:'percent'|'flat'|'remainder', value, trigger:'on_accept'|'on_completion'|'manual'}] }`, Zod-validated (percent ≤ 10000 bps; exactly one `remainder`). Execution writes `invoice_schedules` then drafts the first milestone via the existing invoice-create path; later milestones minted by the completion hook (P20-001) + an `on_accept` check. **Follow the three-place ritual exactly** (omitting the switch arm is a compile error).
**Reuse:** `proposals/execution/executor.ts`, `invoice-execution-handler.ts`; `splitMilestones`.
**Required tests:** proposal classified `capture`; first invoice minted; Zod rejects two remainders.
**Verification:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run invoice-schedule-handler proposals`

---

### P21-003 — "Requires invoicing" queue + batch-generate sweep
**Status:** Landed (backend). `invoices/invoicing-queue.ts findJobsRequiringInvoicing` (completed + eligible money-state + no live invoice + billable). `batch_invoice` proposal type via the three-place ritual (capture) + `contracts/batch-invoice.ts`. `invoices/batch-invoice-run.ts` (+ pg) is the `(tenant, job, batch_date)` dedup ledger (23505). `workers/batch-invoice-worker.ts runBatchInvoiceSweep` is opt-in (`settings.batchInvoiceEnabled`, mig. 139), reserves a run per job then emits ONE `batch_invoice` proposal; `execution/batch-invoice-handler.ts` fans out N `draft_invoice` proposals on approval. Wired in app.ts (`SWEEP_LOCK.batchInvoice = 590007`, hourly, leader-gated). **Follow-up:** thin read-only "Requires invoicing" web list (the queue fn is ready to expose).
**Allowed files:** `packages/api/src/invoices/invoicing-queue.ts`, `packages/api/src/workers/batch-invoice-worker.ts`, `packages/api/src/invoices/batch-invoice-run.ts`, `packages/api/src/db/schema.ts` (`batch_invoice_runs`, `(tenant, job_id, batch_date) UNIQUE`), `packages/api/src/app.ts` (register; **add `SWEEP_LOCK.batchInvoice: 590007`**), tests.
**Build prompt:** Query completed jobs with no open invoice + `money_state ∈ {estimate_accepted, no_estimate}`. Opt-in per tenant, **proposal-first**: emit one `batch_invoice` proposal summarizing N candidate jobs + total; on approval fan out N `draft_invoice` proposals. `batch_invoice_runs` dedups so re-runs don't double-draft. Thin read-only "Requires invoicing" web list. Clone `workers/recurring-agreements-worker.ts` loop shape + `service_agreement_runs` idempotency.
**Reuse:** `recurring-agreements-worker.ts`; `agreements/agreement-run.ts`; `runAsLeader`. New `batch_invoice` proposal type via the three-place ritual.
**Required tests:** queue excludes already-invoiced jobs; approval fans out N drafts; re-run no-ops via dedup.
**Verification:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run batch-invoice-worker invoicing-queue`
