# User Workflow Audit — Web & Mobile (2026-06)

A complete inventory of the **working user workflows** across the web app
(`packages/web`, React Router) and the mobile app (`packages/mobile`, Expo
Router), the **workflow errors** found tracing each one end-to-end (UI → API
call → route handler), and **UX improvements** to make those jobs easier.

Findings tagged **[verified]** were independently re-checked against the cited
code by a second adversarial pass (17 confirmed, 1 partial). Other findings are
cited from the trace audit and are high-confidence but not separately
re-verified.

Surfaces covered: web has ~30 auth-gated routes + 6 public customer flows +
marketing/onboarding; mobile is a 5-tab shell (Home, Assistant/voice, Customers,
Jobs, Settings) with a persistent voice overlay plus stack screens.

---

## PART 1 — Working Workflows

### A. Web — office / back-office (auth-gated)

| # | Workflow | Route(s) | Status |
|---|----------|----------|--------|
| W1 | **Login / signup** (Clerk) → onboarding | `/login`, `/signup` | Working |
| W2 | **Onboarding wizard** (6 steps: identity → pack → phone → billing → ai_check → test_call), status-polled, resumable | `/onboarding` | Working |
| W3 | **Role home + mode-aware nav** (supervisor / tech / both; permission-gated items) | `/` | Working |
| W4 | **Leads pipeline** — kanban list, drag stage moves, source/assignee filters | `/leads` | Working |
| W5 | **Create lead** → navigates to detail | `/leads/new` | Working |
| W6 | **Lead detail** → convert to customer / mark lost (reason) / notes / preferred language | `/leads/:id` | Working (cleanest flow) |
| W7 | **Customers** — list, detail (Jobs/Estimates/Invoices tabs, quick actions), edit | `/customers`, `/customers/:id`, `/customers/:id/edit` | Working |
| W8 | **Estimate create via job** (select job → line items → tax/discount → save) + **send** | `/estimates/new`, `POST /estimates/:id/send` | Working (the *job-based* path) |
| W9 | **Jobs** — list, create (NewJobFlow), detail, status transitions (auto-invoice on complete), tech view, voice/typed notes | `/jobs`, `/jobs/new`, `/jobs/:id` | Working |
| W10 | **Dispatch board** — drag/drop reassign/reschedule/cancel via proposals, SSE live refresh, feasibility preview, optimistic-concurrency (`If-Match`/409) | `/dispatch` | Working — **gold standard** |
| W11 | **Technician day** — maps link, "On my way", GPS auto delay-detection | `/technician/day` | Working (with a permission bug, see E11) |
| W12 | **Schedule list** | `/schedule` | Working |
| W13 | **Invoices** — list (30s poll), create (optionally from estimate), detail, send pay-link, mark paid, notes, attachments | `/invoices`, `/invoices/new`, `/invoices/:id` | Working (with total-display bug, see E4) |
| W14 | **Comms inbox** — read/reply threads, "✨ Suggest reply", server search, DNC-gated send | `/comms-inbox` | Working |
| W15 | **Proposal inbox** — approve/reject, chain batch-approve, catalog line ambiguity picker | `/inbox` | Working |
| W16 | **Assistant** — chat → typed proposal card → approve; voice note → transcript → chat | `/assistant` | Working (with chat-card gaps, see E10) |
| W17 | **Interactions / call log** + transcript drawer | `/interactions` | Working |
| W18 | **End-of-day digest** (SMS deep-link target) | `/digest`, `/digest/:date` | Working |
| W19 | **Reports** — money dashboard (+ tax CSV export), revenue by source | `/reports/money`, `/reports/revenue-by-source` | Working |
| W20 | **Settings** — hub, templates, price book (CRUD + CSV), feedback dashboard, language, notification prefs | `/settings/*` | Working (mock template editor, see E12) |
| W21 | **Maintenance contracts** — list, detail, create | `/contracts`, `/contracts/:id` | Working |

### B. Web — public / customer-facing (no auth)

| # | Workflow | Route | Status |
|---|----------|-------|--------|
| P1 | **Public intake** → creates a lead (honeypot, UTM capture) | `/intake` | Working — strong |
| P2 | **Public booking** → held appointment + owner proposal (slot-conflict handled) | `/book` | Working |
| P3 | **Public estimate approval** — view, good/better/best tier, accept w/ signature + optimistic lock, decline, deposit checkout (Stripe) | `/e/:id` | Working — **strongest flow** |
| P4 | **Public invoice payment** — Stripe PaymentElement, card + ACH, async settle polling | `/pay/:id` | Working — robust |
| P5 | **Customer portal** — invoices, estimates, jobs, agreements, appointments, payment methods, request service, self-book (all proposal-gated) | `/portal/:token` | Working |
| P6 | **Public feedback** — star rating + comment → review-site links | `/public/feedback/:token` | Working |

### C. Mobile (Expo Router)

| # | Workflow | Screen | Status |
|---|----------|--------|--------|
| M1 | **Sign-in** (email+password, email-code fallback), auth gate, sign-out (revokes push token) | `(auth)/sign-in` | Working (test-code caveat, see E22) |
| M2 | **5-tab shell** — Home, Assistant, Customers, Jobs, Settings + persistent voice overlay w/ pending-proposal badge | `(tabs)/*` | Working |
| M3 | **Hold-to-talk voice** → upload → transcribe → drafts land in Approvals | `(tabs)/voice` | Working (silent no-op cases, see E16/E17) |
| M4 | **Approvals** — poll inbox, review, approve w/ 5s undo, reject w/ reason, catalog ambiguity picker | `approvals`, `proposals/[id]` | Working (entity picker is a dead-end, see E9) |
| M5 | **Jobs** — list, detail, create, clock in/out | `(tabs)/jobs`, `jobs/[id]`, `jobs/[id]/time`, `jobs/new` | Working (photos stub, see E6) |
| M6 | **Customers** — list, detail (click-to-call), create, edit | `customers*` | Working |
| M7 | **Calls** — log, detail w/ transcript, click-to-call from customer | `calls`, `calls/[id]` | Working |
| M8 | **Messages** — list (30s poll), thread (15s poll), optimistic reply | `messages`, `messages/[id]` | Working (title/parity gaps, see E14/E20/E21) |
| M9 | **Leads** — list, detail (read-only) | `leads`, `leads/[id]` | Working but read-only (no create/convert) |
| M10 | **Estimates list** | `estimates` | List works; **create + detail broken** (E2, E5) |
| M11 | **Invoices** — list, detail | `invoices`, `invoices/[id]` | List/detail work; **create broken** (E3) |
| M12 | **Digest** — daily | `digest/index`, `digest/end-of-day` | Renders, but duplicated/degraded (E18/E19) |
| M13 | **Schedule list** | `schedule` | List works; day/week/map non-functional (E25) |
| M14 | **Settings** — team, templates, notification prefs, callback number, sign-out | `(tabs)/settings/*` | team/templates work; 5 sub-pages are stubs (E24) |

---

## PART 2 — Workflow Errors

Grouped by severity. **CONFIRMED [verified]** = re-checked against code in a
second adversarial pass.

### 🔴 Critical — the core job silently fails

**E1 — Web "New Estimate" creates nothing (silent no-op). [verified]**
`NewEstimateFlow.tsx:1112-1118` — `handleSend()` and `saveAsDraft()` are pure
`setTimeout` mocks that fire the success animation and call
`onCreated()`/`onClose()` **without any `POST /api/estimates`**. This is the
primary estimate-creation entry point on web (opened from `CustomersPage` and the
Add-Customer sheet). The user sees "Sent" / "Saved as draft" and **no estimate
exists**. The preview also shows a hardcoded fake link `rivet.ai/e/est0049`
(`:1109-1110`) instead of the real tokened URL.

**E2 — Mobile "New estimate" always fails (HTTP 400). [verified]**
`mobile/src/api/estimates.ts` sends `{customerId, lineItems, notes}`, but
`createEstimateSchema` (`contracts.ts:212-220`) requires `jobId` and has no
`customerId`/`notes` fields → rejected at Zod validation every time. Entire
mobile estimate-creation flow is non-functional.

**E3 — Mobile "New invoice" always fails (HTTP 400). [verified, partial]**
`mobile/app/invoices/new.tsx:52` calls `createInvoice(api,{customerId,lineItems})`
with no `jobId`; `createInvoiceSchema` requires `jobId` (`contracts.ts:223`).
*Correction to the original finding:* the route is not "ignoring" `customerId` —
it reads `customerId` from the loaded job (`invoices.ts:111`) — but schema
validation fails first, so the create never succeeds.

**E4 — Web invoice detail displays the wrong total (and uses float money). [verified]**
The mounted detail (`InvoicesPage.tsx:631`, `:700`) computes
`total = Σ(qty × rate)` where `rate = unitPriceCents/100`. This **ignores**
`totals.discountCents`, `taxCents`, `processingFeeCents` **and** `amountPaidCents`
— so any invoice with tax/discount/fee shows a wrong "Amount due", and a
partially-paid invoice shows the full subtotal instead of the remaining balance
(`:731, :877`). The correct `inv.totals.totalCents` / `inv.amountDueCents` are in
the response but only used as a fallback (`:934`). Also a float-on-money path,
which violates the integer-cents rule.

### 🟠 High — broken steps, dead ends, silent data errors

**E5 — Mobile estimate detail route doesn't exist → dead-end navigation. [verified]**
`mobile/app/estimates.tsx:40` does `router.push('/estimates/'+id)` for non-draft
rows, but there is **no `app/estimates/[id].tsx`** (every other entity has one).
Draft rows route to `/estimates/new` (a blank form), so "tap to edit" never edits
the tapped draft.

**E6 — Mobile job photos screen is a non-functional stub. [verified]**
`mobile/app/jobs/[id]/photos.tsx:11-13` renders only "Upload from the field
coming soon." — no camera, no presign, no upload — while `jobs/[id].tsx` routes a
"Photos" row to it. The backend (`job-photos.ts`, fully tested and mounted) is
unused on mobile. The core field-photo workflow does not exist on mobile.

**E7 — Web photos are never persisted. [verified]**
Both `JobDetail.tsx:1486` and `TechJobView.tsx:801` push `CameraCapture` results
into React state only (`setJobMedia`/`setPhotos`) with **no API call**. Photos
vanish on reload and are invisible to anyone else. The working
`JobPhotoUploader`/`uploadJobPhoto` pipeline and `JobPhotos` page exist but are
**orphaned** — not imported and not routed (`routes.ts` has no `jobs/:id/photos`).

**E8 — Dispatch log page is wired to the wrong endpoint → always empty. [verified]**
`DispatchLogPage.tsx:65` reads `data.dispatches`, but `GET /api/interactions`
returns `{data,total,...}` where `data` is **voice_sessions**, with no
`dispatches` key (`interactions.ts:109`). No dispatch-list endpoint exists, so the
page permanently shows "No outbound messages yet." Dead feature in the nav.

**E9 — Entity disambiguation ("which Bob?") is a dead-end. [verified]**
On mobile, picking a candidate calls `reject('entity_selected', id)`
(`proposals/[id].tsx:101-104`), which just **rejects** the clarification — no
backend route consumes `entity_selected` to re-draft with the chosen id, so the
original intent + transcript are discarded and the user must re-dictate. **Web has
no entity picker at all** — the same `voice_clarification`/`entityCandidates`
signal is unhandled in `InboxPage`. This defeats the "ambiguity becomes a one-tap
clarification, never a silent guess" promise.

**E10 — Assistant chat card hides pricing/confidence warnings → approve into a 400. [verified]**
`assistant.ts` `proposalToUI`/`customerProposalToUI` (`:177-210, :237-262`) build
a narrow card that **drops** `_meta`, `lineItems[].pricingSource`, `markers`, and
`missingFields`. So an AI-drafted invoice/estimate with an uncatalogued
(AI-invented) price or an ambiguous line renders a normal "Approve" button in
chat — no "AI-estimated" badge, no "Needs a pick", no missing-field block — and
tapping Approve hits a server rejection. (`AIProposalCard` already has all this
UI; the data is just not passed through.) The money *gate* still holds
server-side; the failure is silent UX on the assistant path.

**E11 — Technician can't edit their own appointment (403); customer delay-notify fails silently. [verified]**
`TechnicianDayView.tsx` "Edit time" (`:423`) and the auto `running_late` notify
(`:348`) both `PUT /api/appointments/:id`, which requires `appointments:update`
(`appointments.ts:194`) — a permission the **technician role lacks** (`rbac.ts`).
On the page literally named for technicians, "Edit time" 403s with a generic
error, and the GPS-driven customer "running late" notification is fire-and-forget
(`void apiFetch`, no `.catch`) so it fails with no signal. (For owner/dispatcher
this also bypasses the proposal/audit gate that the dispatch board enforces.)

**E12 — Technician opens web Settings → blank page, no error. [verified]**
`Shell.tsx:70` shows Settings to all roles, but `GET /api/settings` requires
`settings:view` (`settings.ts:106`), which technician lacks. `SettingsPage`'s
load `catch` is empty (`:77`), so the tech gets a silent default/blank page.
Settings sub-routes aren't role-gated either, so deep links 403.

**E13 — Template editor lies about saving (data loss). [verified]**
`TemplatesPage.tsx` `TemplateDetailModal.handleSave` (`:454-457`) sets `saved=true`
and closes with **no API call**, while the banner (`:488`) says "Edits here update
your live templates immediately." Users believe edits saved; they did not. "Reset
to defaults" (`:526`) has no `onClick`.

**E14 — "Mark as paid" on a Draft invoice is a dead end. [verified]**
The button renders for any `status !== 'Paid'` incl. Draft (`InvoicesPage.tsx:902`),
but `recordPayment` rejects non-`open`/`partially_paid` statuses
(`payment.ts:305-308`) → 400 "Cannot record payment on invoice with status
'draft'". No issue-first hint is offered.

**E15 — JobDetail time-entries panel shows the wrong data. [verified]**
`JobDetail.tsx:985` calls `GET /api/time-entries?jobId=…`, but the route never
reads `jobId` (`time-entries.ts:151-206`) — it filters by `userId` only. The panel
shows the current user's entries across **all** jobs, not this job's. A
`repo.findByJob` exists but is never exposed over HTTP.

### 🟡 Medium — friction, parity gaps, misleading UI

**E16 — Voice transcript that yields no action is a silent dead-end (mobile).**
A transcription that classifies as a read-only/approval intent is `skipped` with
no proposal (`voice-action-router.ts:1043-1068`), but the voice screen
unconditionally says "your proposals will appear in approvals" (`voice.tsx:27`) and
sends the user to an empty list with no explanation.

**E17 — `onTranscribed` hook failure silently drops drafting.**
`transcription.ts:294-303` swallows a hand-off error (so the queue won't retry);
the recording is marked `completed` and the client gets a transcript, but **no
proposals are created** and nothing is surfaced. Two distinct silent causes of
"transcript succeeded, approvals empty."

**E18 — Both mobile digest screens render identical content. [verified path]**
`digest/index.tsx` ("Weekly digest") and `digest/end-of-day.tsx` ("End of day
review") both call `useDigest('latest')` → same daily snapshot → same `DigestBody`.
The "Weekly digest" is mislabeled; there is no weekly data path on mobile.

**E19 — Mobile digest summary is degenerate.**
`DigestBody`/`api/digest.ts:71` shows `"$X revenue · N payload fields"` — it leaks
the literal JSON key count to the owner and omits the structured sections (pending
approvals, tomorrow, unbilled) the web digest renders from the same payload.

**E20 — Web comms inbox doesn't poll (mobile does).**
`CommsInboxPage` loads once; an inbound reply doesn't appear while a thread is open
until re-select/reload. Mobile polls (15-30s). Web/mobile mismatch + real-time gap.

**E21 — Mobile thread shows "Conversation" instead of the sender on push/cold-start.**
`messages/[id].tsx:36` derives the title from a route param that push deep links
don't carry, and never fetches conversation metadata — so for a new inbound text
(exactly when the name matters), the header is generic.

**E22 — "Suggest reply" is web-only.** The endpoint exists; the mobile composer
(`messages/[id].tsx`) doesn't wire it — missing on the surface where typing is
hardest.

**E23 — `incoming_call` / `lead_captured` push dead-ends at Home. [verified]**
`owner-notification-service.ts:110,215` set `screen:'/customers'` (no id), but the
mobile allowlist (`notificationRouting.ts:21-22`) only permits `/customers/<id>` —
so the tap falls back to Home instead of the customers list.

**E24 — Mobile onboarding is orphaned; mobile has no onboarding gate. [verified]**
Nothing routes to `(onboarding)` — `AuthGate` only sends signed-in→`/`,
signed-out→`/sign-in` — so `(onboarding)/index.tsx` is unreachable dead code.
Conversely there's no mobile equivalent of web's `OnboardingGuard`: a brand-new
user lands on Home with no setup, diverging from web.

**E25 — EstimateForm "AI Suggestions" is hardcoded HVAC prices (rule violation). [verified]**
`EstimateForm.tsx:60-70,131-147` — `handleAiSuggest()` injects fixed HVAC line
items (`$95/hr`, `$85` …) regardless of vertical, with no catalog resolution and
no confidence cap. Violates the mandatory catalog-grounding rule for AI-drafted
prices.

**E26 — `?customerId=` is dropped on the post-conversion estimate path (web + mobile).**
`CustomerDetail.tsx:316` → `/estimates/new?customerId=…`, but `EstimateForm` never
reads the param and forces a job pick instead. Same on mobile
(`customers/[id].tsx` → `/estimates/new?customerId=` ignored). The lead → customer
→ "Estimate" handoff lands on an unrelated job dropdown.

**E27 — Stub screens that read as real features:** mobile `notifications.tsx` &
`reviews.tsx` (static "coming soon"); mobile settings `voice`, `brand-voice`,
`lanes`, `lead-sources`, `billing` (stubs); web settings rows "Roles &
permissions", "Reminders", "Zapier", a no-`onClick` "Service area" row.

**E28 — Web service agreements UI is unreachable.** `AgreementCreate`,
`AgreementDetail`, `RecurrenceBuilder`, `AgreementRunsList` are built and tested
but not in `routes.ts` and referenced nowhere — the `/api/agreements` backend +
recurrence worker are stranded with no operator entry point.

**E29 — Dropped form fields imply false capability:** web `InvoiceForm` collects a
**Due date** never sent (`InvoiceForm.tsx:277` vs POST `:183`); `PaymentRecordForm`
& the live "Payment date" input collect a **received date** the API ignores
(always stamps `now`) — back-dated payments are impossible.

**E30 — Other confirmed smaller issues:**
- Maintenance-contracts list pagination is a no-op contract mismatch (`maintenance-contracts.ts:34`) — "{total} contracts" diverges past page 1.
- CSV price import accepts malformed money: `parseFloat('12abc')→$12.00`, whitespace→`$0.00` (`PriceBookPage.tsx:353`).
- Templates edit is gated on `role==='owner'`, but `PUT /api/templates/:id` needs `estimates:update` (dispatcher has it) — dispatchers wrongly told "owners only".
- `LiveTemplatesSection` silently drops non-hvac/plumbing packs → false "No vertical pack is active".
- Voice go-live/pause toggle and Price-book "Add item" have no in-flight guard → concurrent-request desync.
- QuickBooks refresh nulls a genuinely-connected integration on any transient error.
- Portal "Save card" is a silently-disabled dead button when the Stripe key is missing (unlike the pay page, which has a fallback).
- JobDetail manual time-entry silently auto-closes a running shift (`clockIn` always closes a prior open entry); mobile clock-out closes the user's active entry regardless of which job screen they're on.
- Mobile job-detail "Message" and "Navigate" buttons are `onPress={() => {}}` no-ops.
- Mobile `sign-in` hardcodes the Clerk test email code `424242` — breaks any real email-code MFA.
- Web `useMe` caches identity at module scope with no session key → stale role/tenant risk on in-tab account switch (mobile already fixed this).
- `EstimateCreate` navigates to the list, not the new estimate (can't immediately send).
- Lead-list assignee filter is a raw user-id text box (unusable for humans).

### Suspected (needs confirmation)
- Technician can fetch **another** technician's full day (customer names+addresses) via `GET /api/dispatch/technician/:id/appointments` — no self-scoping; the id comes from `localStorage`.
- Presigned-but-never-attached photo `files` rows have no reaper → slow storage/row leak.
- Deposit-credit / record-payment writes aren't wrapped in a DB transaction (documented non-atomic window).

---

## PART 3 — UX Improvements (prioritized)

### Tier 1 — make the broken core workflows actually work
1. **Wire `NewEstimateFlow` to the real API** (fixes E1): `POST /api/estimates`
   (draft) + `POST /:id/send`, and build the `/e/:id` link from the returned
   token instead of the fake `rivet.ai/...` string. Single highest-impact fix.
2. **Align the estimate/invoice create contract across clients** (fixes E2, E3):
   add an optional `customerId` to the create schemas with server-side job
   resolution, *or* have mobile resolve/create a job first. At minimum surface the
   400 body instead of a generic save error.
3. **Render `inv.totals.totalCents` / `inv.amountDueCents` directly** in the web
   invoice detail (fixes E4) — removes the float path and shows the true balance,
   with a separate "Paid" line for partial payments.
4. **Add `mobile/app/estimates/[id].tsx`** and fix row routing so drafts open
   their own editor and sent estimates open a real detail screen (fixes E5).

### Tier 2 — close the dead-ends and silent failures
5. **Wire mobile job photos** to the existing presign→S3→attach pipeline via
   `expo-image-picker` (fixes E6); **persist web photos** through `uploadJobPhoto`
   and render `JobPhotoGallery`, and route the orphaned `JobPhotos` page (fixes E7).
6. **Make entity disambiguation resolve, not discard** (fixes E9): add
   `POST /api/proposals/:id/resolve-entity {candidateId}` that re-drafts the
   original intent with the chosen id (transcript is already on `sourceContext`),
   and mirror the mobile `ClarifyPicker` into the web inbox.
7. **Pass `_meta`/`pricingSource`/`markers`/`missingFields` into the assistant
   chat card** (fixes E10) so the existing AIProposalCard warnings render and
   Approve is disabled (not 400'd) when a line needs a pick.
8. **Surface "nothing to draft / couldn't draft"** on the voice screen via a
   recording sub-status the client polls (fixes E16, E17) instead of the
   unconditional "your proposals will appear in approvals."
9. **Add a real dispatch-list endpoint** and point `DispatchLogPage` at it, or
   remove the page from nav (fixes E8).

### Tier 3 — fix the permission/role mismatches
10. **Hide Settings (and role-locked sub-routes/tabs) for roles without
    `settings:view`**, and surface the swallowed `SettingsPage` load error with a
    retry (fixes E12). Same for the mobile Settings tab's team/templates rows.
11. **Route technician appointment edits through a proposal** (consistent with the
    dispatch board) or grant a scoped self-edit permission, and stop swallowing the
    `running_late` PUT result (fixes E11).
12. **Re-gate template editing to `estimates:update`** so dispatchers can edit and
    the copy is accurate (E30).

### Tier 4 — honesty & polish (remove the "it lied to me" moments)
13. **Remove the mock template editor / fake "edits go live" banner / no-op
    buttons** (fixes E13) — wire to `PUT /api/templates/:id` or delete.
14. **Gate "Mark as paid" behind issued status** (or auto-issue with confirm) and
    add an explicit "Issue invoice" action (fixes E14).
15. **Persist or remove the Due-date / received-date / payment-date inputs**
    (fixes E29) so they don't imply false capability.
16. **Consume `?customerId=`** in the estimate form (pre-filter the job picker to
    that customer, offer inline "create a job") so the lead→customer→estimate
    handoff is one tap (fixes E26).
17. **Bring lead create/convert, "Suggest reply", and the full digest to mobile**
    (fixes M9 read-only gap, E22, E18/E19); add web comms polling (E20) and fetch
    the thread title on mobile (E21).
18. **Allowlist `/customers` (and `/calls/<id>`) in mobile notification routing**
    (fixes E23); add a mobile onboarding gate or remove the orphan route (E24).
19. **Reject malformed money in CSV import**, add in-flight guards to toggles, and
    fix the QuickBooks transient-error clobber (E30).
20. **Delete dead code** per code-hygiene rules: orphaned `pages/invoices/InvoiceDetail.tsx`
    (latent `$NaN`), the unreachable agreements UI (E28) or route it, the
    unwired conversational-onboarding path, and the stub screens (E27).

### Cross-cutting observation
The **public customer flows** (estimate approval, payment, portal, intake,
booking) and the **dispatch board** are genuinely excellent — optimistic locking,
idempotent Stripe webhooks, feasibility checks, proposal-gated mutations. The
weaknesses cluster in the **internal create paths** (estimate/invoice creation is
mocked or contract-mismatched on the very surfaces operators use most) and the
**mobile field experience** (photos, time, schedule, leads are stubs or
read-only). The backend contracts are mostly complete and correct — the failures
are overwhelmingly in the **UI → API wiring layer**, which makes most of these
fast, well-scoped fixes rather than redesigns.
