# Phase 9 — CRM Expansion: Service-CRM Parity Gaps

> **3 stories** | New phase covering CRM-tier features to compete with Jobber / ServiceTitan / Housecall Pro

---

## Purpose

Serviceos has strong **job → estimate → invoice → payment** operational flow. The gap vs. category-leading service CRMs is in **pre-sales** (no lead pipeline, no source attribution), **post-sales visibility** (no unified customer communication timeline), and **recurring revenue** (no service agreements / recurring jobs). These three stories close the largest functional gaps.

## Exit Criteria

- Owners can capture leads, track them through pipeline stages, and convert to customers with source attribution preserved.
- Customer detail page shows a single chronological feed of calls, SMS, email, notes, jobs, estimates, invoices, and payments.
- Owners can create service agreements (e.g. quarterly HVAC tune-up) that auto-generate jobs and invoices on a recurring schedule.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P9-001 | Lead pipeline with source attribution and customer conversion | M | CRM | Medium | Heavy | none (greenfield) |
| P9-002 | Unified customer communication timeline | S | CRM | High | Moderate | none (read-only aggregator) |
| P9-003 | Service agreements with recurring job/invoice generation | M | CRM | Medium | Heavy | P0-009 (worker pattern) |

---

## Story Specifications

### P9-001 — Lead pipeline with source attribution and customer conversion

> **Size:** M | **Layer:** CRM | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/leads/**, packages/api/src/routes/leads.ts, packages/api/src/db/schema.ts (migration 055 only), packages/api/src/app.ts (wiring only), packages/web/src/pages/leads/**, packages/web/src/components/leads/**, packages/api/src/leads/__tests__/**, packages/web/src/pages/leads/__tests__/**`

**Build prompt:** Implement a `leads` entity and pipeline UI. (1) **Schema:** create migration `055_create_leads` with columns `id, tenant_id, first_name, last_name, company_name, primary_phone, email, source (enum: web_form, phone_call, referral, walk_in, marketplace, other), source_detail (text — campaign name or referrer name), stage (enum: new, contacted, qualified, quoted, won, lost), estimated_value_cents (bigint, nullable), notes (text), assigned_user_id (uuid, nullable), converted_customer_id (uuid, nullable, FK to customers — null until conversion), lost_reason (text, nullable), created_by, created_at, updated_at`. Add tenant RLS policy. (2) **Repository:** `packages/api/src/leads/lead.ts` defines the `Lead` interface, `LeadRepository` interface, `InMemoryLeadRepository`, `CreateLeadInput`, `UpdateLeadInput`, `LeadListOptions` (filter by stage, source, assigned_user_id). Follow the conventions in `repository-conventions.md` (tenantId is the first arg of every method). (3) **Pg repo:** `packages/api/src/leads/pg-lead.ts` extends `PgBaseRepository`, uses `withTenant()`. (4) **Service:** `lead-service.ts` exposes `createLead`, `updateLead`, `transitionStage` (writes audit event), `convertToCustomer` (creates a customer from lead fields, sets `converted_customer_id`, transitions stage to `won`, audit-logs both sides). (5) **Routes:** `packages/api/src/routes/leads.ts` exposes `POST /api/leads, GET /api/leads (paginated, filter by stage/source/assignee), GET /api/leads/:id, PATCH /api/leads/:id, POST /api/leads/:id/convert (returns the new customer), POST /api/leads/:id/lose (body: { reason })`. Wire in `app.ts` next to other repos. (6) **Web pages:** `LeadList.tsx` (kanban view by stage, drag between columns triggers `PATCH /api/leads/:id` with new stage; supports filter chips for source/assignee), `LeadDetail.tsx` (shows lead fields, edit form, "Convert to Customer" button → confirmation dialog → calls convert endpoint → routes to new CustomerDetail), `LeadCreate.tsx` (form). All Zod-validated. All emit audit events.

**Review prompt:** Verify migration 055 is the next sequential number and matches `db/schema.ts` declarations. Verify all repo methods take `tenantId` first. Verify RLS via `withTenant()` (no string concatenation). Verify lead → customer conversion is atomic (transaction or rollback on customer-create failure) and writes an audit event tying both ids. Verify the kanban drag updates stage but does NOT auto-execute conversion (won-stage transition is just a flag; conversion is a separate explicit action). Verify Zod validation on every route. Verify pagination is capped at 200 server-side. Check that no money fields use floats (estimated_value_cents is bigint).

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "leads|P9-001"
cd packages/web && npm test -- --run -t "Leads|P9-001"
```

**Required tests:**
- [ ] Create lead with required fields → 201
- [ ] List leads filtered by stage / source / assignee
- [ ] Stage transition writes audit event
- [ ] Convert lead → customer is created, lead.converted_customer_id set, stage = won, both audit events written
- [ ] Conversion rolls back if customer create fails
- [ ] Lose lead requires reason
- [ ] Tenant isolation — lead from tenant A invisible to tenant B
- [ ] Kanban drag triggers stage update
- [ ] Convert button on detail page calls convert endpoint and routes to CustomerDetail

---

### P9-002 — Unified customer communication timeline

> **Size:** S | **Layer:** CRM | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** none

**Allowed files:** `packages/api/src/customers/timeline.ts, packages/api/src/customers/timeline-service.ts, packages/api/src/routes/customers.ts (add timeline endpoint only), packages/api/src/customers/__tests__/timeline.test.ts, packages/web/src/pages/customers/CustomerDetail.tsx (add timeline tab/section only), packages/web/src/components/customers/CommunicationTimeline.tsx, packages/web/src/components/customers/__tests__/CommunicationTimeline.test.tsx`

**Build prompt:** Build a unified, read-only timeline aggregator for a single customer. No schema changes — this is a query-time merge across existing tables. (1) **Aggregator:** `packages/api/src/customers/timeline.ts` defines `TimelineEvent` discriminated union: `{ kind: 'note' | 'job_created' | 'job_status_changed' | 'estimate_sent' | 'estimate_approved' | 'invoice_sent' | 'invoice_paid' | 'payment_received' | 'sms_sent' | 'sms_received' | 'call_inbound' | 'call_outbound' | 'email_sent' | 'email_received' | 'appointment_scheduled' | 'appointment_completed', occurredAt: Date, actorUserId?: string, summary: string, metadata: Record<string, unknown>, sourceEntityId: string, sourceEntityType: string }`. (2) **Service:** `timeline-service.ts` exposes `getCustomerTimeline(tenantId, customerId, opts: { before?: Date, limit?: number, kinds?: TimelineKind[] })`. Internally, query each source repo (notes, jobs, jobTimeline, estimates, invoices, payments, conversations, appointments) for items linked to the customer, map each row to a `TimelineEvent`, merge, sort desc by `occurredAt`, slice to `limit` (default 50, hard cap 200). Use `Promise.all` for parallel fan-out. (3) **Route:** `GET /api/customers/:id/timeline?before=ISO&limit=N&kinds=note,sms_sent` on the existing customers router; tenant-scoped via existing middleware. (4) **Web component:** `CommunicationTimeline.tsx` renders a vertical timeline; each event has an icon (per kind), timestamp (relative + absolute on hover), summary line, and a "view source" link to the source entity. Filter chips at top to toggle kinds. "Load older" button paginates with `before` cursor. (5) **Wire** into `CustomerDetail.tsx` as a new tab or collapsible section ("Activity"). No new dependencies — use existing Tailwind primitives and existing icon set.

**Review prompt:** Verify zero schema changes. Verify the aggregator queries all relevant repos in parallel (not serial). Verify tenant scoping is enforced for every source query (no leaking events from another tenant via a bad join). Verify pagination is cursor-based on `occurredAt` (consistent under inserts). Verify the timeline doesn't N+1 — all source queries should be single SQL each. Verify the UI doesn't crash on customers with zero events. Check performance: a customer with 1k events should still render in <200ms.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "timeline|P9-002"
cd packages/web && npm test -- --run -t "Timeline|P9-002"
```

**Required tests:**
- [ ] Returns merged events from notes, jobs, estimates, invoices, payments, conversations
- [ ] Sorted desc by occurredAt
- [ ] Pagination via `before` cursor returns next page
- [ ] `kinds` filter narrows result
- [ ] Tenant isolation — no events from other tenants
- [ ] Empty customer returns empty array (not error)
- [ ] UI renders icons + summaries + "view source" links
- [ ] Filter chips toggle visible kinds
- [ ] Load older paginates correctly

---

### P9-003 — Service agreements with recurring job/invoice generation

> **Size:** M | **Layer:** CRM | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-009 (async worker pattern)

**Allowed files:** `packages/api/src/agreements/**, packages/api/src/routes/agreements.ts, packages/api/src/db/schema.ts (migration 056 only), packages/api/src/app.ts (wiring only), packages/api/src/workers/recurring-agreements-worker.ts, packages/web/src/pages/agreements/**, packages/web/src/components/agreements/**, packages/api/src/agreements/__tests__/**, packages/web/src/pages/agreements/__tests__/**`

**Build prompt:** Implement service agreements (recurring service contracts). (1) **Schema:** migration `056_create_service_agreements` with two tables. `service_agreements`: `id, tenant_id, customer_id (FK), location_id (FK, nullable), name (e.g. "Quarterly HVAC Tune-up"), description, recurrence_rule (text, RFC5545 RRULE subset — start with FREQ=MONTHLY/QUARTERLY/YEARLY, INTERVAL, BYMONTHDAY), price_cents (bigint), auto_generate_invoice (bool, default true), auto_generate_job (bool, default true), next_run_at (timestamptz), last_run_at (timestamptz, nullable), status (enum: active, paused, cancelled), starts_on (date), ends_on (date, nullable), created_by, created_at, updated_at`. `service_agreement_runs`: `id, tenant_id, agreement_id (FK), scheduled_for (date), generated_job_id (uuid, nullable), generated_invoice_id (uuid, nullable), status (enum: pending, generated, skipped, failed), error_message (text, nullable), created_at`. Tenant RLS on both. (2) **Repos:** `agreement.ts` (interface + InMemory), `pg-agreement.ts`, plus `agreement-run.ts` + `pg-agreement-run.ts`. Method shapes match `repository-conventions.md`. (3) **Service:** `agreement-service.ts` — `createAgreement` (calculates initial `next_run_at` from `recurrence_rule` and `starts_on`), `updateAgreement` (recalculates `next_run_at` on rule change), `pauseAgreement`, `resumeAgreement`, `cancelAgreement`. Plus `runDueAgreements(tenantId)` — finds all active agreements with `next_run_at <= now()`, for each: create a job (if `auto_generate_job`), create a draft invoice (if `auto_generate_invoice`), insert a `service_agreement_runs` row, advance `next_run_at` by the recurrence rule, update `last_run_at`. Idempotent — re-running for the same `next_run_at` does NOT double-generate (check `service_agreement_runs` for an existing row at `scheduled_for`). (4) **Worker:** `workers/recurring-agreements-worker.ts` follows the P0-009 worker pattern; processes one tenant at a time; runs every 1 hour by default. Uses the existing async worker infrastructure — do NOT invent a new scheduling primitive. (5) **Routes:** `POST /api/agreements, GET /api/agreements (filter by customer_id, status), GET /api/agreements/:id (includes recent runs), PATCH /api/agreements/:id, POST /api/agreements/:id/pause, POST /api/agreements/:id/resume, POST /api/agreements/:id/cancel, POST /api/agreements/:id/run-now (manual trigger — admin only)`. Wire in `app.ts`. (6) **Web pages:** `AgreementList.tsx` (filterable table), `AgreementCreate.tsx` (form with customer picker, recurrence builder UI — at minimum dropdowns for frequency/interval), `AgreementDetail.tsx` (shows agreement + runs history with links to generated jobs/invoices, pause/resume/cancel buttons, "Run Now" button gated by role).

**Review prompt:** Verify migration 056 is sequential. Verify recurrence calculation is deterministic and tested for monthly/quarterly/yearly with edge cases (Feb 29, month-end rollover, DST). Verify idempotency: calling `runDueAgreements` twice for the same `next_run_at` produces exactly one job + one invoice + one runs row. Verify worker uses the P0-009 pattern (no new scheduling primitive). Verify proposals layer is NOT bypassed for the generated job/invoice — these are auto-generated artifacts, not user proposals; OR if it should go through proposals, document the decision and route through them. Verify pause/cancel doesn't delete history. Verify tenant isolation across all routes. Check money: `price_cents` is bigint, never float.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "agreement|recurring|P9-003"
cd packages/web && npm test -- --run -t "Agreement|P9-003"
```

**Required tests:**
- [ ] Create agreement with monthly recurrence → next_run_at correct
- [ ] Create with quarterly recurrence → next_run_at = starts_on + 3 months
- [ ] runDueAgreements generates job + invoice + run row
- [ ] runDueAgreements is idempotent (second call no-ops for same scheduled_for)
- [ ] Pause prevents run; resume restores schedule
- [ ] Cancel terminates without deleting history
- [ ] ends_on respected — agreement past ends_on does not run
- [ ] Worker processes due agreements per tenant
- [ ] Manual "run now" creates an immediate run row
- [ ] Tenant isolation across all routes
- [ ] Edge case: Feb 29 monthly recurrence rolls to Feb 28 in non-leap years
