# Phase 9 (CRM Expansion) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-9-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-9-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 9A | P9-001 | single agent (touches db/schema.ts + app.ts wiring) | unlocks 9B + 9C parallel |
| 9B | P9-002 | parallel-eligible after 9A merges | none |
| 9C | P9-003 | parallel-eligible after 9A merges | none |

P9-001 ships first because it establishes the migration cadence at 055 and edits `app.ts` for new repo wiring. P9-002 (timeline) and P9-003 (recurring services) both extend `app.ts` and `db/schema.ts` (003 only) but in append-only regions; running them after 9A merges keeps the merge surface clean.

---

## P9-001 — Lead pipeline with source attribution and customer conversion

**Wave:** 9A
**Migration number reserved:** 055_create_leads
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/shared/src/enums.ts` (Tier-1 — adding LeadStage / LeadSource enums OK ONLY if you put them in a NEW file `packages/api/src/leads/enums.ts`; do NOT touch shared/enums.ts in this story)
- `packages/api/src/customers/**` (no edits to existing customer files; the convert endpoint composes via the service layer)
- `packages/api/src/proposals/**`
- `packages/web/src/components/auth/**`
- `packages/web/src/hooks/useListQuery.ts`

**Allowed files (concrete list):**
- `packages/api/src/leads/lead.ts` (new — interface, InMemory repo, types)
- `packages/api/src/leads/pg-lead.ts` (new — Postgres repo extending PgBaseRepository)
- `packages/api/src/leads/lead-service.ts` (new — createLead, transitionStage, convertToCustomer, lose)
- `packages/api/src/leads/enums.ts` (new — LeadStage + LeadSource enums + Zod schemas)
- `packages/api/src/leads/__tests__/lead.test.ts` (new)
- `packages/api/src/leads/__tests__/lead-service.test.ts` (new)
- `packages/api/src/leads/__tests__/pg-lead.test.ts` (new — gated on DATABASE_URL)
- `packages/api/src/routes/leads.ts` (new — Express router)
- `packages/api/src/db/schema.ts` (modify — add migration `055_create_leads` only; do NOT touch any other migration string)
- `packages/api/src/app.ts` (modify — wire LeadRepository ternary + mount `/api/leads` router; copy the pattern from existing entries; do NOT refactor unrelated wiring)
- `packages/web/src/pages/leads/LeadList.tsx` (new — kanban view)
- `packages/web/src/pages/leads/LeadDetail.tsx` (new)
- `packages/web/src/pages/leads/LeadCreate.tsx` (new)
- `packages/web/src/pages/leads/__tests__/LeadList.test.tsx` (new)
- `packages/web/src/pages/leads/__tests__/LeadDetail.test.tsx` (new)
- `packages/web/src/components/leads/LeadCard.tsx` (new — used by kanban)
- `packages/web/src/components/leads/LeadStageColumn.tsx` (new)
- `packages/web/src/components/leads/__tests__/LeadCard.test.tsx` (new)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "leads|P9-001") && \
  (cd packages/web && npm test -- --run -t "Leads|P9-001")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- Migration number `055_create_leads` is not yet present in `packages/api/src/db/schema.ts` (the preflight script verifies this automatically).

**Risk note:**
- **Atomicity of conversion.** `convertToCustomer` MUST be a single transaction: insert customer row, set `lead.converted_customer_id`, transition `lead.stage='won'`, write two audit events (one per side). If any step fails, the whole transaction rolls back. Use `withTenantTransaction()` from `pg-base.ts` (read it; do NOT modify it).
- **No proposal bypass for "won" stage.** Stage transitions in the kanban are direct PATCHes — they're CRM bookkeeping, not operational mutations, and don't go through the proposals system. Conversion is an explicit user action with its own audit event. Document this in a one-line comment at the top of `lead-service.ts` so future readers don't ask.
- **Tenant isolation must be tested.** Add a test that creates a lead in tenant A, then asserts a tenant-B-scoped query returns zero rows. Same for the convert endpoint.
- **Money safety.** `estimated_value_cents` is `BIGINT` in the migration and `bigint`/`number` in TS. Never use `numeric` or floats. The Zod schema must reject decimals.

**Implementation hints:**
1. Read `packages/api/src/customers/customer.ts` first — it's the closest existing pattern (interface + InMemory + types). Mirror the shape exactly (tenantId-first methods, async, `T | null`).
2. Read `packages/api/src/customers/pg-customer.ts` for the `withTenant()` usage. Do NOT invent a new persistence pattern.
3. Read `packages/api/src/db/schema.ts` to see where migrations are declared (look for the `'054_p8_telephony_tables'` string — your `'055_create_leads'` goes after it). Look at `'042_create_feedback_requests'` for a recent example of a CREATE TABLE migration with RLS policies.
4. Read `packages/api/src/app.ts` lines 251-280 for the repository ternary pattern. Copy that exact shape for `LeadRepository`. Mount the `/api/leads` router next to `/api/customers`.
5. For the kanban UI, drag-between-columns triggers `PATCH /api/leads/:id { stage: '<new>' }`. Use the same `useMutation` pattern as the dispatch board (P6-025 reference). Convert button is a separate explicit CTA on `LeadDetail`, NOT triggered by drag.
6. `convertToCustomer` returns the new customer object so the UI can navigate to `/customers/<id>` immediately.

---

## P9-002 — Unified customer communication timeline

**Wave:** 9B (after 9A merges)
**Migration number reserved:** none (read-only aggregator — no schema changes)
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/api/src/db/schema.ts` (no migration this story)
- `packages/shared/**`
- `packages/api/src/notes/**`, `packages/api/src/jobs/**`, `packages/api/src/estimates/**`, `packages/api/src/invoices/**`, `packages/api/src/payments/**`, `packages/api/src/conversations/**`, `packages/api/src/appointments/**` (READ ONLY — query through their existing repositories; do not modify any of these files)
- `packages/api/src/app.ts` (no wiring changes; the timeline endpoint mounts under the existing customers router)
- `packages/web/src/components/auth/**`

**Allowed files (concrete list):**
- `packages/api/src/customers/timeline.ts` (new — `TimelineEvent` discriminated union + `TimelineKind` enum + Zod query schema)
- `packages/api/src/customers/timeline-service.ts` (new — `getCustomerTimeline(tenantId, customerId, opts)` orchestrator)
- `packages/api/src/customers/__tests__/timeline.test.ts` (new)
- `packages/api/src/customers/__tests__/timeline-service.test.ts` (new)
- `packages/api/src/routes/customers.ts` (modify — add `GET /:id/timeline` route only; do NOT modify any existing route)
- `packages/web/src/pages/customers/CustomerDetail.tsx` (modify — add an "Activity" tab/section that mounts CommunicationTimeline; do NOT touch other tabs)
- `packages/web/src/components/customers/CommunicationTimeline.tsx` (new)
- `packages/web/src/components/customers/__tests__/CommunicationTimeline.test.tsx` (new)
- `packages/web/src/api/customers.ts` (modify — add `getCustomerTimeline` client function; if file doesn't exist, add to the closest existing customers API client)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "timeline|P9-002") && \
  (cd packages/web && npm test -- --run -t "Timeline|P9-002")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- P9-001 (`055_create_leads`) merged on origin/main (so `app.ts` and `db/schema.ts` editing surface is clean).

**Risk note:**
- **No N+1.** Each source repo gets exactly one query per timeline request. Use `Promise.all` to fan out, NOT a `for await` loop. Test with a customer that has 100 jobs and assert total query count is ≤ 8 (one per source).
- **Tenant scoping per source.** Every source query MUST go through the existing repo method that already enforces tenant scoping (e.g. `notesRepo.findByCustomer(tenantId, customerId)`). Do NOT write raw SQL in the timeline service. If a needed method doesn't exist on a source repo, surface it in the PR description rather than adding it (that would make this story exceed its allowed-files list).
- **Cursor pagination.** The `before` query param is an ISO timestamp; events with `occurredAt < before` only. Test that pagination is consistent under inserts (insert a new note between page 1 and page 2 fetches; the new note should appear at the top of a fresh page-1 query, not in page 2).
- **Empty state.** A customer with zero events returns `{ events: [], nextCursor: null }`, never throws.

**Implementation hints:**
1. The `TimelineEvent` union has 16+ variants. Build a small mapper per source (`mapNoteToEvent`, `mapJobToEvent`, etc.) — keep them pure functions in `timeline.ts` so tests are trivial.
2. For SMS/call/email events, query the `conversations` repo (messages table). Use the existing `Message.direction` field to derive `sms_sent` vs `sms_received`.
3. For `payment_received`, query the payments repo joined to invoice → customer linkage. If the existing `paymentsRepo` doesn't expose `findByCustomer`, fall back to `findByInvoice` looped over the customer's invoices (still bounded — one query per invoice). Document the choice in a comment.
4. Sort merge: after fan-out, concat all event arrays, sort `desc` by `occurredAt`, then slice to `limit`. Don't bother with k-way merge — input arrays are small (each capped at the source repo's own pagination).
5. Frontend timeline icons: reuse whatever icon library is already imported in the dispatch board / customer detail page. Do NOT add a new dep.

---

## P9-003 — Service agreements with recurring job/invoice generation

**Wave:** 9C (after 9A merges)
**Migration number reserved:** 056_create_service_agreements
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/shared/src/enums.ts` (put new enums in `packages/api/src/agreements/enums.ts`)
- `packages/api/src/jobs/**`, `packages/api/src/invoices/**` (READ ONLY — call existing services to create jobs/invoices; do not modify them)
- `packages/api/src/customers/**`, `packages/api/src/locations/**`
- `packages/api/src/proposals/**` (decision: auto-generated artifacts bypass the proposals layer; document in code)
- `packages/web/src/components/auth/**`

**Allowed files (concrete list):**
- `packages/api/src/agreements/agreement.ts` (new — interface, InMemory repo)
- `packages/api/src/agreements/pg-agreement.ts` (new)
- `packages/api/src/agreements/agreement-run.ts` (new — interface, InMemory repo for runs)
- `packages/api/src/agreements/pg-agreement-run.ts` (new)
- `packages/api/src/agreements/agreement-service.ts` (new — create/update/pause/resume/cancel/runDueAgreements)
- `packages/api/src/agreements/recurrence.ts` (new — pure RRULE-subset calculator)
- `packages/api/src/agreements/enums.ts` (new — RecurrenceFrequency, AgreementStatus, RunStatus)
- `packages/api/src/agreements/__tests__/agreement.test.ts` (new)
- `packages/api/src/agreements/__tests__/agreement-service.test.ts` (new)
- `packages/api/src/agreements/__tests__/recurrence.test.ts` (new — heavy edge-case coverage)
- `packages/api/src/agreements/__tests__/pg-agreement.test.ts` (new)
- `packages/api/src/routes/agreements.ts` (new — Express router)
- `packages/api/src/workers/recurring-agreements-worker.ts` (new — follows P0-009 pattern)
- `packages/api/src/workers/__tests__/recurring-agreements-worker.test.ts` (new)
- `packages/api/src/db/schema.ts` (modify — add migration `056_create_service_agreements` only)
- `packages/api/src/app.ts` (modify — wire AgreementRepository, AgreementRunRepository, mount `/api/agreements`, register the worker)
- `packages/web/src/pages/agreements/AgreementList.tsx` (new)
- `packages/web/src/pages/agreements/AgreementCreate.tsx` (new)
- `packages/web/src/pages/agreements/AgreementDetail.tsx` (new)
- `packages/web/src/pages/agreements/__tests__/AgreementList.test.tsx` (new)
- `packages/web/src/pages/agreements/__tests__/AgreementDetail.test.tsx` (new)
- `packages/web/src/components/agreements/RecurrenceBuilder.tsx` (new — frequency/interval/byMonthDay form)
- `packages/web/src/components/agreements/AgreementRunsList.tsx` (new)
- `packages/web/src/components/agreements/__tests__/RecurrenceBuilder.test.tsx` (new)
- `packages/web/src/api/agreements.ts` (new — typed API client)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "agreement|recurring|P9-003") && \
  (cd packages/web && npm test -- --run -t "Agreement|P9-003")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- P9-001 (`055_create_leads`) merged on origin/main.
- P0-009 (async worker pattern) on origin/main — verify by `git log origin/main --oneline | grep -F P0-009`.

**Risk note:**
- **Idempotency is non-negotiable.** `runDueAgreements` may be called twice for the same `next_run_at` (worker retry, manual "Run Now" race). The check is: before generating, query `service_agreement_runs WHERE agreement_id = ? AND scheduled_for = ?`. If a row exists with status `generated`, no-op. If status `failed`, allow retry. Test this directly — call the function twice in a single test and assert exactly one job + one invoice exist.
- **Recurrence edge cases.** Build the calculator pure (input → output, no I/O). Mandatory tests:
  - `FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31` from Jan 31 → Feb 28/29, Mar 31, Apr 30, May 31...
  - `FREQ=MONTHLY;INTERVAL=3` (quarterly) from Jan 15 → Apr 15, Jul 15, Oct 15.
  - `FREQ=YEARLY` from Feb 29 2024 → Feb 28 2025, Feb 29 2028.
  - DST transition: a daily-equivalent rule across a DST boundary doesn't double-count or skip a day. (We store `next_run_at` as `timestamptz` in UTC; convert at boundaries via the customer's tenant timezone if available, else UTC.)
- **Bypassing the proposals layer.** Auto-generated jobs/invoices from agreements skip the proposals system — they're system mutations driven by a customer-approved contract, not user-proposed changes. Add a one-line comment at the top of `agreement-service.ts` documenting this and citing CLAUDE.md rule "Never auto-execute proposals — all require human approval" with the carve-out: "Service agreements are pre-approved at creation time; subsequent runs are executions of that approval, not new proposals."
- **Money safety.** `price_cents` is BIGINT, never decimal. The Zod schema rejects floats.
- **Worker pattern fidelity.** Read `packages/api/src/workers/` first to find the P0-009 base worker. Do NOT invent a new scheduling primitive. The worker is a tenant-iterating loop that calls `agreementService.runDueAgreements(tenantId)` every hour.

**Implementation hints:**
1. Read `packages/api/src/workers/` and find the P0-009 base. Mirror its tenant iteration, error handling, and graceful shutdown.
2. For job creation, call `jobsService.createJob({...})` — do NOT touch `jobs/job.ts`. Same for invoices.
3. Recurrence rule storage: store as a single text column with the RRULE-subset string (`FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15`). Parse on read in `recurrence.ts`. This keeps the schema simple and lets you extend later without migration.
4. `runDueAgreements` returns `{ generatedRunIds: string[], skippedRunIds: string[], failedRunIds: string[] }` so the worker can log structured results.
5. UI recurrence builder: minimum viable is three dropdowns (frequency, interval, day-of-month). Don't try to build a full RRULE editor.
6. The "Run Now" button is owner-role only. Use the existing role check from `auth/rbac.ts` (read it; do NOT modify).

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 9 story before launching the dispatch agent.
