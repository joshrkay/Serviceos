# fix: Frontend review — all criticals and highs (5 criticals + 24 highs)

**Created:** 2026-07-08
**Depth:** Deep
**Status:** plan

## Summary

The 2026-07-07 full-frontend review (every non-test line in `packages/web/src`, findings verified against `packages/api`) found 5 critical broken flows and 24 high-severity defects. This plan fixes all of them in 10 dependency-ordered implementation units: job lifecycle truth, the customer feedback link, technician running-late RBAC, estimate/invoice money integrity, customer CRUD integrity, dispatch-board drag logic, tenant-timezone day boundaries, job creation/detail data integrity, and the home dashboard + voice-command routing.

## Problem Frame

Type-checks, 1,578 unit tests, and the production build are all green, yet core user flows fail every time they're exercised (job cancel, tech job completion, tech running-late notices, customer feedback links), money surfaces lie (AI estimate prices 100× inflated, invoice edits silently unpersisted, a fabricated payment link), and the dispatch/schedule surfaces put work on the wrong day for any non-UTC tenant. These hit owners, technicians, dispatchers, and paying customers directly.

## Requirements

- R1. Job cancel/no-show submits succeed (canonical `canceled` status). [C1]
- R2. Tech "Mark Complete" completes the job; status labels match their effects; transition failures surface. [C2]
- R3. AI-suggested estimate line prices display and persist at catalog-true value (integer cents honored). [C3]
- R4. Customer feedback links open the feedback page, not raw JSON; already-sent links keep working. [C4]
- R5. Technicians can send running-late notices without a 403. [C5]
- R6. Estimate/invoice money flows are idempotent and truthful: no duplicate documents on retry/double-tap, edits persist to the server, payment links shown are real, deposits never route to expired Stripe links, payments can't double-record. [highs: NewEstimateFlow:1337/:1359, EstimatesPage:356, InvoicesPage:787/:709, EstimateApprovalPage:1240, PaymentRecordForm:132]
- R7. Customer create/edit is race-safe and clearing a field actually clears it. [CustomersPage:366, CustomerEdit:105]
- R8. Dispatch-board drag/reorder computes correct slots under all orderings and filters; reorder is confirmable; time-edit dialog usable; board survives background refetch. [DispatchBoard:170/:728/:459/:600, useDispatchBoard:29]
- R9. All day-keyed queries and datetime inputs on dispatch/schedule/technician surfaces use tenant-timezone boundaries. [DispatchBoard:98/:74/:79, SchedulePage:49/:284, RescheduleDialog:12, TechnicianDayView:209]
- R10. Job creation persists what the UI claims (schedule/assignment), voice job creation can complete, captured photos upload, job detail/sheets show real linked documents. [NewJobFlow:714/:472, AddEntrySheet:74, JobSheets:9, JobDetail:48/:1289, TechJobView:690]
- R11. Home "Today" panel reflects today's actual work; voice commands stop hijacking dictation. [HomePage:305, useVoiceCommands:15]

## Key Technical Decisions

- **Fix `running_late` with a dedicated endpoint, not a permission grant** — `PUT /api/appointments/:id` already special-cases `status === 'running_late'` as a virtual status (packages/api/src/routes/appointments.ts:197-231) but the router-level `requirePermission('appointments:update')` blocks technicians. Granting techs `appointments:update` would let them reschedule/cancel appointments (explicit non-goal per rbac.ts comments). Instead: new `POST /api/appointments/:id/running-late` gated by `appointments:view` (which technicians hold), containing the existing virtual-status logic; the PUT branch delegates to the same helper for backward compatibility. (Alternative — route through proposals — rejected: running-late is a notification trigger, not a schedule mutation.)
- **Feedback link: move the SPA route, keep the API endpoint, rescue old links via content negotiation** — SPA route becomes `/feedback/:token` (matching the short public-page convention `/e/:id`, `/pay/:id`, `/portal/:token` in routes.ts:57-62); the worker link (packages/api/src/workers/feedback-send.ts:68) points there. The API's `GET /public/feedback/:token` additionally 302-redirects to `/feedback/:token` **only when the `Accept` header contains `text/html`** (browser navigation) so links already texted to customers keep working; the page's own JSON fetch (explicit `Accept: application/json`) is unaffected. (Alternative — renaming the API mount — rejected: breaks the page's data fetch and any external callers.)
- **`waiting` becomes a branch state, not a step in the linear flow** — TechJobView's STATUS_FLOW is reordered so `in_progress` → `complete` is the linear path ("Mark Complete" posts `completed`); "Waiting for Parts" is entered only via explicit action/voice status and its CTA returns to `in_progress` without posting a self-transition. `res.ok` is checked and failures surface (they're currently swallowed). Follows the derive-status-from-canonical-rule learning (docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md).
- **Invoice edits persist via the existing `PUT /api/invoices/:id`** — `updateInvoiceSchema` (packages/api/src/shared/contracts.ts:244-250) already accepts `lineItems`/`discountCents`/`taxRateBps`; no backend work needed. Frontend mirrors EstimatesPage's save-on-editor-change pattern including error surfacing.
- **Payment links come from `invoice.stripePaymentLinkUrl` or the send response — never constructed** — the field exists on the shared contract (packages/shared/src/contracts/invoice.ts:34). When absent, the copy-link affordance is hidden with a "send the invoice to generate a payment link" hint instead of fabricating `pay.rivet.ai/...`.
- **Tenant-tz day handling is centralized in `packages/web/src/utils/formatInTenantTz.ts`** — add `todayInTz(tz)` (hoisted from DigestPage.tsx:70), `dateKeyInTz(date, tz)`, `dayWindowUtc(dateISO, tz)` (built on the existing `tenantWallClockToUtc`), and `utcToTenantWallClock(iso, tz)` for `datetime-local` round-trips. All fixed call sites use these helpers; no per-page date math. The technician day window is fixed server-side: dispatch route (packages/api/src/dispatch/routes.ts:133) stops hardcoding `T00:00:00.000Z` and uses the tenant timezone (the board-query `getDayBoundaries(dateStr, timezone)` pattern).
- **NewJobFlow schedule step creates a real appointment** — `POST /api/appointments` exists (`createAppointmentSchema`: jobId, scheduledStart/End, timezone — contracts.ts:278-286). After job creation, a chosen slot creates an appointment (times via `tenantWallClockToUtc`); the hardcoded 'Tue Mar 11' chips are replaced with computed next-7-days in tenant tz. Technician assignment goes through appointment update if the repo supports `technicianId` (Open Question Q2; if not, the assign UI is removed rather than left lying).
- **JobSheets/JobDetail link real documents via `?jobId=` list filters** — both `GET /api/estimates?jobId=` and `GET /api/invoices?jobId=` exist (routes verified). The mock-data import in JobSheets is deleted; sheets fetch the real linked document and route actions to the real estimate/invoice pages. The status stepper derives from `job.status` ordinal, not the never-populated `statusHistory`.
- **Same-lane drag indices are adjusted, and all board index math runs on the rendered (filtered, sorted) list** — one canonical `laneOrder` array per lane feeds rendering, `insertIndex`, `isSameLaneNoOp`, and neighbor lookup; when the dragged card precedes the target gap, `insertIndex` decrements after removal. Reorder arrows reuse `computeProposedSlot` (repack semantics) instead of proposing the neighbor's exact times, which the feasibility API always rejects as overlap.

## Scope Boundaries

**In scope:** the 5 criticals and 24 highs from the review report, plus tiny same-file adjacencies explicitly listed in units (e.g., integer-cents validation in PaymentRecordForm, DST-safe prev/next in SchedulePage, `todayIso()` in HomePage).

**Non-goals:** the ~70 medium and ~90 low findings (tap targets, swallowed-error sweep, remaining fetch races, mock-data eviction on assistant/suppliers, dead-code deletion sweep, SSE robustness, message timestamps tz). JobsList list-enrichment (technician/scheduledStart on `GET /api/jobs` list) — medium finding, backend enrichment deferred.

### Deferred to follow-up work
- Shared `useGuardedFetch`/migration of remaining hand-rolled fetches to `useListQuery`.
- Tap-target/320px-overflow sweep with class-contract tests.
- Mock-data eviction outside JobSheets (AssistantPage TODAY_CONTEXT/attachments, SuppliersSheet, EstimateForm fake AI, NewEstimateFlow photos flow + 'EST-0049').
- Dead-module deletion (unrouted pages listed in the review), PendingProposalsCard wiring decision.
- Extending the production-mock-data guard test to cover non-routed components.

## Repository invariants touched

- **Integer cents:** C3 fixes a cents-as-dollars violation; U5 adds `Number.isInteger` validation on payment amounts; no new float money math anywhere (display conversions divide by 100 at render only).
- **UTC stored / tenant tz rendered:** U8 is entirely this invariant; all new date-key/window logic goes through `formatInTenantTz.ts` helpers.
- **Audit events:** backend changes (U3 running-late route, U8 dispatch day-window) reuse existing service paths that already audit; the new running-late endpoint calls the same delay-notification coordinator as the existing PUT branch (no new mutation paths without audit).
- **Zod contracts:** the new running-late endpoint validates `delayMinutes` with the existing `delayMinutesSchema`; no `req.body` pass-throughs added.
- **Human-approval gate:** U7 keeps dispatch changes flowing through the proposal/feasibility flow — fixes make proposals *correct*, never auto-executed.
- **Catalog grounding:** C3 preserves resolver-grounded prices end-to-end (the defect was the UI corrupting them); no client-side price invention added.
- **RLS/tenant_id:** no new tables or queries outside existing tenant-scoped repos.

## Implementation Units

### U1. Job lifecycle truth (cancel, complete, backward transition, notes shape)
- **Goal:** Job cancel/no-show works; "Mark Complete" completes; backward reschedule stops silently failing; tech-view notes render.
- **Requirements:** R1, R2, R10 (notes)
- **Dependencies:** none
- **Files:** `packages/web/src/components/jobs/CancelNoShowSheet.tsx`, `packages/web/src/components/jobs/TechJobView.tsx`, `packages/web/src/components/jobs/JobDetail.tsx`, tests: `packages/web/src/components/jobs/CancelNoShowSheet.test.tsx` (new), `packages/web/src/components/jobs/TechJobView.test.tsx` (extend), `packages/web/src/components/jobs/JobDetail.test.tsx` (extend)
- **Approach:** (a) D1 branch posts `status: 'canceled'` (mirror the fixed D2 branch and its comment). (b) Restructure STATUS_FLOW per the Key Decision: linear `en_route → on_site → in_progress → complete`; `waiting` is a side state with "Resume Job" returning to `in_progress` locally (no API self-transition); `advanceStatus` checks `res.ok` and surfaces failure via the existing error affordance. (c) The "← Scheduled (reschedule)" option includes a `reason` (small prompt or fixed reason string per product copy) since the API requires one for backward moves; drop the silent `catch {}` in favor of a toast. (d) `loadNotes` in TechJobView parses the bare-array response of `GET /api/notes` (mirror JobDetail.tsx:944).
- **Patterns to follow:** the D2 branch of CancelNoShowSheet (canonical status + error propagation); JobDetail's notes parsing; docs/solutions derive-shared-status-rule learning.
- **Test scenarios:**
  - Happy path: no-appointment cancel submits `{status:'canceled', reason}` and closes on 200 (assert fetch body).
  - Happy path: at `in_progress`, primary CTA posts `{status:'completed'}`; UI reaches Complete.
  - Edge: `waiting` state shows "Resume Job" and posts no transition when resuming.
  - Error: transition 400 → error surfaced, status UI not falsely advanced.
  - Error: backward reschedule sends `reason`; 400 without reason is unreachable (assert body includes reason).
  - Notes: mocked bare-array `GET /api/notes` renders entries in TechJobView.
- **Verification:** cancel/no-show and Mark Complete succeed against the real API in dev; notes appear in tech view.

### U2. Customer feedback link opens the page (route shadowing)
- **Goal:** Feedback links render FeedbackPage; legacy links redirect; page data fetch unaffected.
- **Requirements:** R4
- **Dependencies:** none
- **Files:** `packages/web/src/routes.ts`, `packages/web/src/components/customer/FeedbackPage.tsx` (data fetch sends explicit `Accept: application/json`), `packages/api/src/workers/feedback-send.ts`, `packages/api/src/routes/public-feedback.ts`, tests: `packages/api/src/routes/public-feedback.test.ts` (extend/new — Accept-negotiation), `packages/api/src/workers/feedback-send.test.ts` (extend — link shape), `packages/web/src/components/customer/FeedbackPage.test.tsx` (extend — fetch headers/URL unchanged)
- **Approach:** per Key Decision: SPA route `/feedback/:token`; worker emits `${base}/feedback/${token}`; API `GET /public/feedback/:token` 302s to `/feedback/:token` when `Accept` contains `text/html`, else serves JSON as today.
- **Patterns to follow:** short public-route convention (`/e/:id`, `/pay/:id`); existing public-feedback router structure.
- **Test scenarios:**
  - Happy: GET with `Accept: text/html` → 302 Location `/feedback/:token`.
  - Happy: GET with `Accept: application/json` → 200 JSON (page fetch contract pinned).
  - Worker: generated URL is `/feedback/<token>`.
  - Edge: unknown token with html Accept still redirects (page renders its own invalid-token state).
- **Verification:** navigating to both the new and the legacy URL in a browser renders the feedback page.

### U3. Technician running-late endpoint (RBAC)
- **Goal:** Technicians can trigger the delay notice; no privilege widening.
- **Requirements:** R5
- **Dependencies:** none
- **Files:** `packages/api/src/routes/appointments.ts`, `packages/web/src/pages/technician/TechnicianDayView.tsx`, tests: `packages/api/src/routes/appointments.running-late.test.ts` (new handler-level), `packages/web/src/pages/technician/TechnicianDayView.test.tsx` (extend — client hits new endpoint)
- **Approach:** extract the existing `running_late` virtual-status block into a shared handler; expose it as `POST /api/appointments/:id/running-late` gated `requirePermission('appointments:view')`; validate `delayMinutes` (existing `delayMinutesSchema`, default 20); PUT branch delegates to the same helper (backcompat). Client `markRunningLate` calls the new endpoint.
- **Patterns to follow:** existing virtual-status block (appointments.ts:197-231) — reuse its coordinator call, delayVersion derivation, and response shape verbatim.
- **Test scenarios:**
  - Happy: technician-role request → 200 `{queued:true}`, coordinator invoked with correct delayVersion/minutes.
  - Error: unknown appointment → 404; cross-tenant id → 404 (tenant guard).
  - Edge: invalid `delayMinutes` → validation error; missing → default 20.
  - Backcompat: PUT with `status:'running_late'` (dispatcher role) still works.
  - Client: delay-prompt Accept posts to `/running-late`; failure surfaces the existing error banner.
- **Verification:** as a technician in dev, accepting the delay prompt returns success and enqueues the notice (no 403).

### U4. Estimate money integrity (AI cents, duplicate creates, stale editor)
- **Goal:** AI-suggested prices correct; no duplicate estimates from retry/double-tap; line-item editors never save stale rows.
- **Requirements:** R3, R6
- **Dependencies:** none
- **Files:** `packages/web/src/components/estimates/NewEstimateFlow.tsx`, `packages/web/src/components/estimates/EstimatesPage.tsx`, tests: `packages/web/src/components/estimates/NewEstimateFlow.test.tsx` (extend), `packages/web/src/components/estimates/EstimatesPage.test.tsx` (extend)
- **Approach:** (a) map `rate: li.unitPrice / 100` at the suggest-response boundary (NewEstimateFlow:201) — cents in, dollars for display, `Math.round(rate*100)` back out stays. (b) `handleSend`: cache the created estimate id in a ref; retry after a failed `/send` reuses it instead of re-creating; disable Send while in flight. (c) `saveAsDraft`: pending guard + disabled button. (d) `LineItemsEditor` (EstimatesPage:356 and its InvoicesPage twin in U5): entering edit mode re-seeds the draft from current `items`, so a save can never PUT rows older than the last refetch.
- **Patterns to follow:** the correct cents conversion two screens over (`defaultRate: it.unitPriceCents / 100`, NewEstimateFlow:706); existing `creatingJob` pending-guard pattern in the same file.
- **Test scenarios:**
  - Happy: mocked suggest response `unitPrice: 8500` renders $85.00 and submits `unitPriceCents: 8500` (round-trip pinned).
  - Error/retry: create 200 + send 500 → second click sends the SAME estimate id, no second POST /api/estimates.
  - Edge: double-tap Save-as-draft fires one create.
  - Editor: refetch replaces items → Edit shows the fresh rows; save PUTs them (not the mount-time rows).
- **Verification:** AI-suggest an $85 catalog item in dev — estimate shows $85; spam-click send/draft — exactly one document exists.

### U5. Invoice + payment money integrity
- **Goal:** Invoice edits persist; payment links are real; payments can't double-record; cents stay integers.
- **Requirements:** R6
- **Dependencies:** none (shares the editor-reseed pattern with U4)
- **Files:** `packages/web/src/components/invoices/InvoicesPage.tsx`, `packages/web/src/components/payments/PaymentRecordForm.tsx`, tests: `packages/web/src/components/invoices/InvoicesPage.test.tsx` (extend), `packages/web/src/components/payments/__tests__/PaymentRecordForm.test.tsx` (extend or co-located equivalent)
- **Approach:** (a) draft-invoice line-item save calls `PUT /api/invoices/:id` with `lineItems` (schema verified: contracts.ts:244); on failure, keep editor open + toast, don't commit local state; refetch on success. (b) Replace the fabricated `pay.rivet.ai/...` string: render `inv.stripePaymentLinkUrl` when present; otherwise hide copy-link and show a "send to generate" hint; SendPaymentSheet shows the link returned by the send call (Open Question Q1 for exact response field). (c) Re-seed the invoice line editor on entering edit (twin of U4d). (d) PaymentRecordForm: pending state disables submit during POST; validate `Number.isInteger(amountCents)` (same-file adjacency, medium finding).
- **Patterns to follow:** EstimatesPage's `updateEstimate` save-on-change + 409/error handling; `formatCurrency` for any new money display.
- **Test scenarios:**
  - Happy: editing draft line items PUTs `{lineItems}` and re-renders server response.
  - Error: PUT 500 → editor stays open, error shown, list unchanged.
  - Links: invoice with `stripePaymentLinkUrl` shows/copies it; without → no copyable fake link rendered anywhere (assert absence of `pay.rivet.ai`).
  - Double-submit: two rapid clicks on Record Payment → one POST `/api/payments`.
  - Edge: `amountCents` 100.5 → validation error, no POST.
- **Verification:** edit + reload a draft invoice in dev — edits survive; recorded payment appears once.

### U6. Customer create/edit integrity + deposit link expiry
- **Goal:** No duplicate customers, cleared fields clear, deposits never hit expired Stripe links.
- **Requirements:** R6 (deposit), R7
- **Dependencies:** none
- **Files:** `packages/web/src/components/customers/CustomersPage.tsx`, `packages/web/src/pages/customers/CustomerEdit.tsx`, `packages/web/src/components/customer/EstimateApprovalPage.tsx`, tests: `packages/web/src/components/customers/__tests__/CustomersPage.test.tsx` (extend), `packages/web/src/pages/customers/__tests__/CustomerEdit.test.tsx` (extend), `packages/web/src/components/customer/EstimateApprovalPage.deposit.test.tsx` (extend)
- **Approach:** (a) Add-customer: pending guard; created-customer id cached in a ref so a location-step failure retries only `createLocation`; try/catch with toast (route errors through the existing sonner pattern). (b) CustomerEdit: cleared optional fields serialize as `''` (matching the file's own doc comment); the API route passes body through and the pg repo SETs present keys, so `''` persists the clear — pin with a handler test asserting the PUT body contains `lastName: ''` etc., and verify server acceptance (Q3). (c) `PayDepositButton.go()` honors `expiresAt`: expired or absent → `POST /deposit-checkout` (the documented contract at lines 100-112); only a live link short-circuits.
- **Patterns to follow:** `useMutation` error-toast conventions used elsewhere in customers components; the deposit field docs in the same file.
- **Test scenarios:**
  - Double-tap Add customer → one POST /api/customers.
  - createCustomer 200 + createLocation 400 → error shown; retry POSTs only the location for the cached customer id.
  - Clearing email/phone/lastName → PUT body carries empty strings; success path reflects cleared values after refetch.
  - Deposit: expired `expiresAt` → POST /deposit-checkout called, `initialUrl` NOT navigated; live link → navigated.
- **Verification:** clear a customer's email in dev and reload — it stays cleared.

### U7. Dispatch board interaction logic
- **Goal:** Drag/reorder produce correct, confirmable proposals under all orderings and filters; background refreshes stop nuking the board.
- **Requirements:** R8
- **Dependencies:** none (U8 touches the same file — land U7 first; sequencing note below)
- **Files:** `packages/web/src/pages/dispatch/DispatchBoard.tsx`, `packages/web/src/hooks/useDispatchBoard.ts`, tests: `packages/web/src/pages/dispatch/__tests__/DispatchBoard.test.tsx` (extend/new — pure slot-index helpers extracted for unit-testability), `packages/web/src/hooks/useDispatchBoard.test.ts` (new)
- **Approach:** (a) Extract a pure helper computing `(laneOrder, insertIndexAdjusted)` from (lane appointments, active status filter, dragged id, raw gap index): one canonical rendered-order array feeds render, gap indices, `isSameLaneNoOp`, neighbor lookup, and `handleReorderWithinLane` — fixing both the same-lane off-by-one and the filtered/unfiltered mismatch (also confirm path :345-354). (b) Reorder arrows build their proposal via `computeProposedSlot` with the adjusted insert index (repack), replacing the neighbor-time-copy that feasibility always rejects. (c) `updatePendingTimes` preserves the existing `placement` instead of hardcoding `'gap'`, keeping the overflow time inputs mounted. (d) `useDispatchBoard`: `requestVersionRef` stale-response guard (copy the useListQuery pattern); `isLoading` true only when no data yet or the date changed — background refetches set an `isRefreshing` flag so DispatchBoard keeps lanes mounted (drag + scroll survive).
- **Patterns to follow:** `useListQuery`/`useDetailQuery` requestVersionRef; existing `computeProposedSlot` usage in the gap-drop path.
- **Test scenarios:**
  - Same-lane [A,B,C]: drag A to between B and C → insertIndex adjusts; proposal packs A after B (not after C); no-op detection correct for dropping A back onto its own slot.
  - Filtered lane: with a status filter hiding one card, reorder arrows pick the correct appointment + neighbor + version.
  - Reorder proposal times come from computeProposedSlot (assert not equal to neighbor's exact times).
  - Overflow dialog: editing start then end works; placement stays 'overflow'.
  - Hook: fast date A→B with A resolving last → board shows B; background refetch keeps `data` non-null and `isLoading` false.
- **Verification:** on a seeded board in dev, drag within a lane with a filter on — the confirm dialog names the right cards and Confirm is enabled when the lane has room.

### U8. Tenant-timezone day boundaries (shared helpers + all high call sites)
- **Goal:** Every fixed surface derives day keys/windows/datetime inputs from the tenant timezone.
- **Requirements:** R9
- **Dependencies:** U7 (same-file edits in DispatchBoard land first)
- **Files:** `packages/web/src/utils/formatInTenantTz.ts` (+ its test), `packages/web/src/pages/digest/DigestPage.tsx` (adopt hoisted helper), `packages/web/src/components/schedule/SchedulePage.tsx`, `packages/web/src/pages/dispatch/DispatchBoard.tsx`, `packages/web/src/components/appointments/RescheduleDialog.tsx`, `packages/api/src/dispatch/routes.ts` (technician day window), tests: `packages/web/src/utils/formatInTenantTz.test.ts` (extend — new helpers incl. DST cases), `packages/web/src/components/schedule/SchedulePage.test.tsx` (extend), `packages/web/src/pages/dispatch/__tests__/DispatchBoard.test.tsx` (extend), `packages/api/test/integration/dispatch-day-window.test.ts` (new, Docker-gated — day bucketing by tenant tz against real columns)
- **Approach:** add `todayInTz`, `dateKeyInTz`, `dayWindowUtc`, `utcToTenantWallClock` per Key Decision. SchedulePage: chips keyed by `dateKeyInTz`; query window from `dayWindowUtc`; prev/next via calendar-date arithmetic on the Y/M/D triple (DST-safe — same-file adjacency for the :416 finding). DispatchBoard: pass `useTenantTimezone()` result into `useDispatchBoard` (param already exists); `dayStartIso` via `tenantWallClockToUtc(boardDate, workStart, tz)`; overflow `datetime-local` renders via `utcToTenantWallClock` and parses via `tenantWallClockToUtc`. RescheduleDialog: same in/out conversion. API: technician appointments day window (dispatch/routes.ts:133) resolves the tenant's timezone (existing settings/board-query pattern) instead of `T00:00:00.000Z`.
- **Patterns to follow:** `tenantWallClockToUtc` doc examples in formatInTenantTz.ts; `getDayBoundaries(dateStr, timezone)` in packages/api/src/dispatch/board-query.ts.
- **Test scenarios:**
  - Helpers: `dateKeyInTz`/`dayWindowUtc` across UTC±offsets and the US DST transitions (Mar 8 / Nov 1 class dates); round-trip `utcToTenantWallClock` ∘ `tenantWallClockToUtc` = identity.
  - SchedulePage: browser tz ≠ tenant tz → chip label date equals query-window date; prev/next crosses DST without skip/repeat.
  - DispatchBoard: board request carries tenant tz; empty-lane drop for a NY tenant proposes 08:00 local (13:00Z), not 08:00Z.
  - RescheduleDialog: rendering + submitting preserves the tenant wall clock for a dispatcher in another tz.
  - Integration (Docker): appointment at 23:00 tenant-local lands on that tenant date's technician day view, not the next UTC day.
- **Verification:** with browser tz set to a non-tenant tz in dev, schedule/dispatch/tech views all show the same day's work under the same date label.

### U9. Job creation & detail data integrity
- **Goal:** Job creation persists schedule/assignment truthfully; voice path completes; photos upload; job detail/sheets show real linked documents.
- **Requirements:** R10
- **Dependencies:** U8 (uses `tenantWallClockToUtc`/next-7-days chips), U1 (JobDetail/TechJobView merge order)
- **Files:** `packages/web/src/components/jobs/NewJobFlow.tsx`, `packages/web/src/components/jobs/AddEntrySheet.tsx`, `packages/web/src/components/jobs/JobSheets.tsx`, `packages/web/src/components/jobs/JobDetail.tsx`, tests: `packages/web/src/components/jobs/NewJobFlow.test.tsx` (extend), `packages/web/src/components/jobs/JobSheets.routes.test.ts` (extend), `packages/web/src/components/jobs/JobDetail.test.tsx` (extend), `packages/web/src/components/jobs/AddEntrySheet.test.tsx` (new)
- **Approach:** (a) NewJobFlow: date chips computed (next 7 days, tenant tz); after `createJob`, a chosen slot POSTs `/api/appointments` (jobId, window via `tenantWallClockToUtc`, timezone); tech assignment via appointment update if supported (Q2), else the assign UI is dropped; `onCreated` routes to the tab matching the job's real status; done-screen renders only persisted facts. (b) Voice path: on customer match, fetch `/api/locations?customerId=` (mirror `selectCustomer`, line 512) and render the location picker — unblocking completion. (c) AddEntrySheet photo tab: upload captured media through the existing job-photos client (`packages/web/src/api/job-photos.ts`) exactly as JobDetail.persistCapturedMedia does, then post the note; drop the fake "N photos added" text-only path. (d) JobSheets: delete the `data/mock-data` import; EstimateSheet/InvoiceSheet fetch via `GET /api/estimates?jobId=` / `GET /api/invoices?jobId=`; empty states link to the real create flows; "Send invoice now" routes to the real send flow instead of `setSent(true)`. (e) JobDetail compat: stepper index derives from `job.status`; estimate/invoice actions enabled from the jobId-filtered fetches; ScheduleTechCard reads `GET /api/appointments?jobId=`; the three onClick-less buttons either navigate to the schedule surface or are removed (dead-UI hygiene).
- **Patterns to follow:** `selectCustomer` location fetch; JobDetail's photo persistence block (:876-895); production-mock-data-guard test conventions.
- **Test scenarios:**
  - Create with slot → POST /api/jobs then POST /api/appointments with tenant-tz-correct instants; without slot → no appointment POST and no fabricated done-screen schedule.
  - Voice match → locations fetched; picker rendered; flow completable.
  - AddEntrySheet: captured photo → job-photos upload called with the media; failure surfaces and doesn't fake success.
  - JobSheets: real estimate/invoice render from jobId fetch; `data/mock-data` no longer imported (pin via the mock-data guard test extension).
  - JobDetail: completed job renders stepper at Completed; job with linked invoice enables the invoice action with the real id.
- **Verification:** create a scheduled job in dev and see it on the schedule surface; open a real job's estimate/invoice sheets and see live data.

### U10. Home "Today" truth + voice-command regex
- **Goal:** The home panel shows today's actual work (tenant tz); dictation stops being hijacked into navigation.
- **Requirements:** R11
- **Dependencies:** U8 (`todayInTz`, `dayWindowUtc`)
- **Files:** `packages/web/src/components/home/HomePage.tsx`, `packages/web/src/hooks/useVoiceCommands.ts`, tests: `packages/web/src/components/home/HomePage.test.tsx` (extend), `packages/web/src/hooks/useVoiceCommands.test.ts` (new)
- **Approach:** (a) Replace the ignored `scheduledDate` jobs filter: fetch `GET /api/appointments?fromDate&toDate` for the tenant-tz today window, join to the jobs list by `jobId` for display; "Active today", the unassigned banner, and WeekStrip `todayCount` derive from that set; `todayIso()` replaced by `todayInTz` (same-file adjacency for the :108 finding). (b) Rewrite the command regexes with explicit grouping (`/\b(show|open|go to|see)\b.*\b(schedule|calendar)\b/i` shape for every alternation at lines 15-19 and 23-24) so bare keywords ("home", "calendar", "client", "quote") no longer match mid-sentence; navigation requires the verb.
- **Patterns to follow:** DigestPage's tz-correct "today"; existing VoiceBar consumer contract (match → navigate, no match → assistant).
- **Test scenarios:**
  - Home: appointment inside today's tenant-tz window renders; one at 23:30 tenant-local still counts on the right day for a non-UTC browser tz.
  - Home: no appointments → panel empty state (not the full jobs list).
  - Regex table test: "show my schedule" → navigate; "add a note that the customer wasn't home" → NO match; "text the client about their quote" → NO match; "open clients" → navigate; "go home" → navigate.
- **Verification:** dictating a note containing "home" in dev sends to the assistant instead of navigating.

## Risks & Dependencies

- **Sequencing:** U7 → U8 → U9/U10 (shared files/helpers). U1-U6 are independent and parallelizable.
- **Q2/Q3 (below) can reshape small parts of U9/U6** — both have a defined fallback (drop the assign UI; add server-side handling for `''`) so neither blocks starting.
- **DispatchBoard is heavily edited by U7+U8** — land as separate commits with the extracted pure helpers tested first; the existing e2e/board tests (if any) plus new unit tests gate regressions.
- **Legacy feedback links** depend on the Accept-header heuristic; SMS in-app browsers send `text/html` on navigation, so risk is low, but U2's handler test pins both branches.
- Run `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` before every push (repo build-verification rule); web: `npx vitest run` + `npx tsc --noEmit` in packages/web.

## Open Questions (deferred to implementation)

- Q1: Exact field name for the payment URL in the invoice `/send` response (`viewUrl` vs. link object) — read `packages/api/src/invoices/public-invoice-service.ts` return shape when wiring U5b.
- Q2: Whether `updateAppointment` persists `technicianId` (enabling NewJobFlow tech assignment) — check `packages/api/src/appointments/pg-appointment.ts` update column map during U9; fallback: remove the assign control.
- Q3: Whether `updateCustomer` accepts `''` for email (any format validation on non-empty strings) — verify during U6; fallback: treat `''` as clear server-side with a handler test.
- Q4: Whether creating an appointment auto-transitions the job `new → scheduled` or U9 must POST `/api/jobs/:id/transition` explicitly.

## Sources & Research

- Frontend review report (2026-07-07 session): 5 criticals verified against `packages/api` (job-lifecycle.ts transitions, rbac.ts role grants, estimate-task.ts cents contract, app.ts mount order, appointments.ts virtual-status branch).
- Prior learnings applied: `docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md` (U1, U9), `docs/solutions/test-failures/component-test-green-in-isolation-red-in-ci.md` (test hygiene for the extended component suites).
