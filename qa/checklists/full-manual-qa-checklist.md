# ServiceOS — Full Manual QA Checklist

**Purpose:** a human-executable, click-by-click (and call-by-call) checklist
covering every shipped feature and workflow, for the manual sweeps described
as "Lever 4" in [`docs/qa-strategy.md`](../../docs/qa-strategy.md). Use this
when you need a human to actually drive the product — mouse, voice, and
phone — not just a green CI run. Green unit/integration tests are **not**
evidence that these pass; see the "Definition of verified" in
`docs/qa-strategy.md`.

This complements, and does not replace, the automated layers:

- Automated route/business-flow coverage: [`e2e/qa-matrix`](../../e2e/qa-matrix) (matrix row IDs referenced below as `[MATRIX-ID]` — these are verified against `e2e/qa-matrix/matrix.ts` and, unless explicitly marked "proposed", resolve to a real row there; if you add a new matrix row or rename one, grep this file for its old ID and update it in the same change)
- Platform-level workflow catalog + P0/P1 launch scoping: [`docs/superpowers/specs/2026-05-24-platform-assessment-and-e2e-qa-50-workflows.md`](../../docs/superpowers/specs/2026-05-24-platform-assessment-and-e2e-qa-50-workflows.md) (referenced below as `(WF-##)`)

**Total workflows in this checklist: 116** (14 inbound-call, 4 voice/in-app,
97 manual-click, several overlapping both), spanning 22 feature areas.
Sections 1–20 run once per tenant against **at least two tenants**;
Section 21 runs once, comparing the two.

## How to use this

1. **Use at least two tenants, not one.** A single-tenant pass cannot
   catch cross-tenant leaks, and every bug in `docs/qa-strategy.md`'s
   BUG-1..BUG-8 history that involved tenant scoping was invisible from
   inside a single tenant. Create **Tenant A** and **Tenant B** by
   actually running Sections 1–2 (sign up + onboarding) twice, once per
   tenant. That's the only way to get a real Clerk browser session and
   a real provisioned Twilio number for each tenant — both of which you
   need for the rest of the checklist. Running onboarding this way also
   *is* how you check off Section 2 for each tenant, so there's no
   separate third tenant needed.
   - `e2e/qa-matrix/fixtures/seed.ts` + `tokens.ts` are **not** a
     substitute here — they insert tenant/customer/job rows directly in
     Postgres and mint API-only HMAC JWTs for the automated
     `e2e/qa-matrix` suite. They create no Clerk user, no browser
     session, no Twilio number, and no price book/settings, so a tester
     cannot sign in or run the phone/settings/isolation portions of this
     checklist against them.
2. Run Sections 1–20 **once per tenant** (Tenant A fully — including its
   own onboarding pass — then Tenant B fully, or interleave if that's
   faster). Section 21 (isolation) is run **once, using both tenants
   together** — it specifically checks that Tenant A and Tenant B cannot
   see or affect each other.
3. Work top to bottom within a tenant pass, or cherry-pick a section
   after a change lands in that area.
4. Check the box, and record Pass/Fail/Blocked with a one-line note in
   the **Run log** table at the bottom (copy the table per run date) —
   note which tenant each row was run against.
5. Anything that fails gets a story file in `qa/backlog/BUG-NN-<slug>.md`
   the same day it's found (template: any existing file in that folder),
   even if the fix lands later. If a bug only reproduces on one of the
   two tenants, say so — that's a signal of a scoping bug, not
   flakiness.
6. "Fixed" is a claim that needs a screenshot (🖱️ items) or a call
   recording/transcript (☎️/🎙️ items) attached to the backlog file — not a
   green commit message.

### Legend

| Tag | Mode | What it means |
|-----|------|----------------|
| 🖱️ | Manual click | Drive the web app with a mouse/keyboard as a human would |
| 🎙️ | Voice (in-app) | Use the in-app voice bar / assistant mic, or place a real phone call as **yourself** to test an outbound/owner-facing voice path |
| ☎️ | Inbound call | Dial the tenant's live Twilio number **as a customer would**, from an external phone |
| 🔧 | API-assisted | A real UI/browser step exists but the specific action has no UI control yet (e.g. no "custom amount" field, no "generate portal link" button) — complete it with an authenticated API call (devtools fetch, Postman with your session cookie, etc.) using your own signed-in session; noted inline where this applies, along with why |
| P0 | — | Solo-launch blocker per WF catalog §4.0 — never skip |
| P1 | — | Core loop or multi-tech/dispatch — required before wider rollout |
| P2 | — | Deferrable / nice-to-have surface |

---

## 1. Auth & access

- [ ] **QA-001** 🖱️ P0 — Sign up as a brand-new owner (email + password or SSO per Clerk config). **Expect:** redirected into `/onboarding`, tenant + settings rows created. (WF-01)
- [ ] **QA-002** 🖱️ P0 — Sign in with an existing account. **Expect:** lands on home (`/`) or `/onboarding` if incomplete, no console errors. (WF-02)
- [ ] **QA-003** 🖱️ P0 — Visit `/` signed out. **Expect:** redirected to `/login`, no flash of authenticated content. (WF-03)
- [ ] **QA-004** 🖱️ P1 — Sign out from Settings. **Expect:** Clerk session actually terminated (not just a client-side redirect) — re-visiting `/` after sign-out bounces to `/login`.
- [ ] **QA-005** 🖱️ P0 — Log in as Tenant A, attempt to open a Tenant B customer/job/invoice URL directly by ID. **Expect:** 403/404, no data leak. (WF-04, `[ISO-01]`)
- [ ] **QA-006** 🖱️ P0 — Hit the API's `/health` and `/ready` endpoints directly (e.g. `<E2E_API_URL>/health` in a browser tab — no auth needed). **Expect:** `/health` 200; `/ready` 200 when dependencies (DB, etc.) are up, 503 if you can force one down. (WF-05)

## 2. Onboarding & go-live

- [ ] **QA-007** 🖱️ P0 — Immediately after signup, **before** touching the identity step, navigate directly to `/` in a new tab. **Expect:** `OnboardingGuard` redirects you back to `/onboarding` — do this now, since it's a "soft" gate keyed only on the `identity` step: once QA-008 below saves identity, the guard stops redirecting for the rest of this tenant's session. (WF-10)
- [ ] **QA-008** 🖱️ P0 — Identity step: enter business name, industry/vertical. **Expect:** advances, `wizard_step_business` fires. (WF-06)
- [ ] **QA-009** 🖱️ P0 — Pack step: select a vertical pack (e.g. HVAC/plumbing). **Expect:** pack active under `/api/verticals`; price book pre-seeds from the pack.
- [ ] **QA-010** 🖱️/☎️ P0 — Phone step: provision a Twilio number. **Expect:** number assigned within the async worker's window; number is dialable from an outside phone once provisioned. (WF-07)
- [ ] **QA-011** 🖱️ P1 — Billing step: start trial or enter card. **Expect:** subscription/trial row created; billing portal session reachable. (WF-09)
- [ ] **QA-012** 🖱️ P1 — AI check step's voice config panel: set the AI persona/greeting and (if enabled) a voice-approval PIN. **Expect:** persona text and PIN persist; PIN panel round-trips through settings.
- [ ] **QA-013** 🖱️ P1 — On the test-call step's screen, use the calendar choice panel: connect or skip Google Calendar. **Expect:** connect opens OAuth consent; skip advances without blocking.
- [ ] **QA-014** ☎️ P0 — Same screen, test-call step: call the newly-provisioned number from an outside phone. **Expect:** AI agent answers, discloses it's an AI (per `disclose-ai-identity` skill) and that the call may be recorded (`disclose-recording`), completes a greeting, onboarding checklist flips this step to done. (WF-08)
- [ ] **QA-015** 🖱️ P1 — Resume onboarding after closing the tab mid-wizard. **Expect:** re-opening `/onboarding` restores the correct step, no data loss.

## 3. CRM — customers

- [ ] **QA-016** 🖱️ P0 — Create a customer with a service location. **Expect:** appears in `/customers` list and in DB under the correct tenant. (WF-11, `[CUST-01]`)
- [ ] **QA-017** 🖱️ P1 — Edit customer fields + service location; attempt a duplicate. **Expect:** edits persist; dedupe guard triggers or merges as designed. (WF-12 — no dedicated matrix row yet; closest existing coverage is `[CUST-01]` create + `[CUST-03]` archive)
- [ ] **QA-018** 🖱️ P1 — Open a customer's timeline. **Expect:** jobs, estimates, invoices, and comms all show in one place with no 5xx. (WF-13)
- [ ] **QA-019** 🖱️ P2 — Search customers by name, phone, and email. **Expect:** all three match; partial-match search returns results.
- [ ] **QA-020** 🖱️ P1 — Add customer group / tag and filter customer list by it. **Expect:** filter narrows the list correctly.

## 4. CRM — leads

- [ ] **QA-021** 🖱️ P1 — Create a lead manually. **Expect:** appears on `/leads` kanban in the correct stage. (WF-14)
- [ ] **QA-022** 🖱️ P1 — Drag a lead card across kanban stages (all 6). **Expect:** stage persists on reload.
- [ ] **QA-023** 🖱️ P1 — Convert a lead to a customer. **Expect:** customer created/linked, lead marked won, no duplicate customer row. (WF-15)
- [ ] **QA-024** 🖱️ P0 — Submit the public intake form as a prospect. Bare `/intake` resolves no tenant — use the link Settings copies for you (`/intake?t=<tenantId>`). **Expect:** a lead or customer appears in the app within a few seconds. (WF-16)

## 5. Jobs

- [ ] **QA-025** 🖱️ P0 — Create a job from a customer record. **Expect:** job appears on `/jobs` and on the customer timeline. (WF-17, `[JOB-01]`)
- [ ] **QA-026** 🖱️ P0 — Walk a job through its full lifecycle: scheduled → in progress → complete. **Expect:** each transition is audit-logged; UI reflects status immediately. (WF-18)
- [ ] **QA-027** 🖱️ P1 — Upload job photos (`/jobs/:id/photos`). **Expect:** photos upload, thumbnail renders, attached to the correct job.
- [ ] **QA-028** 🖱️ P2 — Fill a custom job form and add a custom field. **Expect:** values save and re-render on reopen.
- [ ] **QA-029** 🖱️ P1 — On an approved estimate, use "Convert to job" (`ConvertToJobSheet`). Note estimates are job-first — the estimate already belongs to an existing job, so this schedules/assigns *that* job (auto-picking a technician + slot, or your override) rather than creating a new one. **Expect:** the existing linked job gets scheduled/assigned with no duplicate job created, and the estimate flips to accepted.
- [ ] **QA-030** 🖱️ P1 — Cancel a job mid-lifecycle. **Expect:** status reflects cancellation; any linked appointment is released.

## 6. Schedule & appointments

- [ ] **QA-031** 🖱️ P0 — Create an appointment on the schedule calendar. **Expect:** visible in week view immediately. (WF-19, `[SCH-01]`)
- [ ] **QA-032** 🖱️ P0 — Reschedule an appointment (drag or edit form). **Expect:** window updates, no double-assignment created. (WF-20, `[SCH-02]`)
- [ ] **QA-033** 🖱️ P1 — Cancel an appointment. **Expect:** status canceled, dispatch event fires, technician (if assigned) is freed. (WF-21, `[SCH-03]`)
- [ ] **QA-034** 🖱️ P0 — Attempt to double-book the same technician over an overlapping window. **Expect:** blocked or flagged — the DB exclusion constraint should reject the overlap, not just the UI.
- [ ] **QA-035** 🖱️ P2 — Switch calendar between day/week/month views. **Expect:** appointments render correctly in every view, no layout break.

## 7. Dispatch (multi-tech — P1, not launch-gated)

**Prerequisite:** onboarding (§2) only creates the owner account — there is
no team-member step in the wizard. Before running this section or §8, jump
ahead and do QA-097 (Settings → invite a team member as `technician`)
**twice**, for two technicians. One isn't enough: `getDispatchBoardData`
only creates a lane for a technician who already has at least one primary
appointment assignment — an invited-but-unassigned technician gets no lane
at all, so nothing to drag onto. Assign each technician at least one
appointment first (§6) so both lanes are populated before QA-036 (a drop
target) and QA-039 (reassign between two lanes).

- [ ] **QA-036** 🖱️ P1 — Drag an unassigned job from the pool onto a technician lane on `/dispatch`. **Expect:** assignment proposal created or direct-assigns per config. (WF-23)
- [ ] **QA-037** 🖱️ P1 — Trigger the feasibility preview before confirming an assignment. **Expect:** overlap/travel-time warnings surface when relevant. (WF-24)
- [ ] **QA-038** 🖱️ P1 — Approve a schedule proposal generated from dispatch, from the inbox. **Expect:** proposal executes; calendar updates to match. (WF-25)
- [ ] **QA-039** 🖱️ P1 — Reassign a job from one technician's lane to another. **Expect:** old assignment clears, new one appears, no orphaned assignment left behind.

## 8. Technician / field

- [ ] **QA-040** 🖱️ P1 — As a technician, open `/technician/day` and clock in/out on a job. **Expect:** time entry rows created; weekly hours reflect the entry. (WF-22)
- [ ] **QA-041** 🖱️ P1 — From the mobile tech view (`?view=tech`), change a job's status via the CTA buttons. **Expect:** status updates; optional customer SMS fires if configured. (WF-26, WF-27)
- [ ] **QA-042** 🖱️ P1 — Verify tap targets on `/technician/day` at a 320px-wide viewport. **Expect:** ≥44px targets, no horizontal overflow (per CLAUDE.md mobile UI rule).

## 9. Estimates

- [ ] **QA-043** 🖱️ P0 — Draft an estimate, add line items from the price book. **Expect:** totals in integer cents match manual math; uncatalogued lines get a lower confidence/flag. (WF-28, `[EST-01]`)
- [ ] **QA-044** 🖱️ P0 — Send the estimate to the customer (SMS and/or email). **Expect:** status flips to "sent"; dispatch log row created. (WF-29)
- [ ] **QA-045** 🖱️ P0 — As the customer, open the estimate link (`/e/:id`) and approve it (with a deposit, if configured). **Expect:** status flips to accepted; deposit charge succeeds if required. (WF-30, `[PORT-01]`)
- [ ] **QA-046** 🖱️ P1 — As the customer, open an **expired or invalid** estimate token. **Expect:** a clean error state — no leaked mock/placeholder data.
- [ ] **QA-047** 🖱️ P0 — Convert an accepted estimate to an invoice. **Expect:** `estimate_id` link preserved, line items carry over unchanged, no re-key. (WF-31, `[EST-05]`)

## 10. Invoices & payments

- [ ] **QA-048** 🖱️ P0 — Issue an invoice and confirm customer delivery (SMS/email link). **Expect:** issued timestamp set; customer receives a working link. (WF-32, `[INV-01]` for the issue transition; the delivery leg is exercised end-to-end by `[JRN-03]`)
- [ ] **QA-049** 🖱️ P0 — As the customer, pay the invoice on `/pay/:id` with a Stripe test card. `InvoicePaymentPage` creates and confirms a PaymentIntent directly (Stripe Payment Element), not a Checkout Session. **Expect:** the `payment_intent.succeeded` webhook (not `checkout.session.completed`, which this path never emits) flips invoice to paid. (WF-33 — no matrix row exercises this path today: `PORT-02` only hits `/public/invoices/:token/checkout`, a separate Checkout Session endpoint, never `/pay/:id`)
- [ ] **QA-050** 🖱️/🔧 P1 — Make a partial payment, then pay the remainder. The shipped "Mark Paid" UI (`MarkPaidSheet`) only records the full `amountDueCents` — there's no UI control for a custom amount (`PaymentRecordForm` supports one but isn't wired into any page). Use an API-assisted step instead: as the signed-in owner, `POST /api/payments` with `{invoiceId, amountCents: <less than amountDueCents>, method, receivedDate}`, then repeat with the remainder. **Expect:** `partially_paid` → `paid` transitions correctly; a follow-up over-`amountDueCents` request is rejected. (WF-34, `[PAY-01]`)
- [ ] **QA-051** 🖱️/🔧 P1 — Let an invoice go overdue. The `dueDate` field in `InvoiceForm` is display-only — it's never sent in the `POST /api/invoices` body — and the send flow always auto-issues with a fixed 30-day term, so a same-session invoice won't be overdue by default. Use an API-assisted step instead: `POST /api/invoices/:id/issue` with `{paymentTermDays: 0}` (accepts 0–365) to make it due immediately, then wait for the overdue-invoice sweep. **Expect:** overdue-invoice worker flags it; owner sees it on the money dashboard. (`[PAY-04]`)
- [ ] **QA-052** 🖱️/🔧 P2 — Set up a progress/milestone billing plan on a job (a `create_invoice_schedule` proposal — e.g. percent-on-accept, percent-on-completion, remainder-on-manual — approved from the inbox). **Expect:** the schedule persists with its milestones; the `on_accept`/`manual` milestones draft/fire with no extra setup. The `on_completion` milestone is different: `mintCompletionMilestones` no-ops unless the tenant setting `milestoneBillingEnabled` is true, and there's no web UI toggle for it — before testing that trigger, enable it via an authenticated `PUT /api/settings` with `{milestoneBillingEnabled: true}`. There is no date/recurrence-based trigger today, only these three.
- [ ] **QA-053** 🖱️/🔧 P2 — Run a batch invoice job across multiple jobs/customers. `batchInvoiceEnabled` defaults false with no web UI toggle, and `runBatchInvoiceSweep` only picks up opted-in tenants on its hourly tick. Prerequisite: `PUT /api/settings` with `{batchInvoiceEnabled: true}`, have several jobs in an eligible (completed, uninvoiced) state, then wait up to an hour for the sweep. The sweep itself doesn't create invoices — it drafts a single `batch_invoice` proposal summarizing the eligible jobs; you must find and approve that proposal in `/inbox` (which fans out one `draft_invoice` proposal per job) before invoices exist. **Expect:** after approving both the batch proposal and its fanned-out per-job proposals, one invoice per eligible job, no duplicates, no cross-tenant leakage.
- [ ] **QA-054** 🖱️ P1 — Export a tax/revenue report for a date range. **Expect:** totals reconcile against the money dashboard for the same range.

## 11. Maintenance contracts

- [ ] **QA-055** 🖱️ P2 — Create a maintenance contract (title, cadence, start date — `CreateContractSheet` has no customer-link field; the API stores no CRM customer reference, only free-text). **Expect:** appears on `/contracts` and its read-only `ContractDetailPage` loads. (The "attach to a customer" and "edit/cancel a contract" surfaces referenced in earlier drafts of this checklist don't exist — the router only implements `POST`/`GET`, no `PUT`/`PATCH`/`DELETE`; treat those as a product gap, not a test to run.)

## 12. Money reports & digest

- [ ] **QA-056** 🖱️ P1 — Open the money dashboard (`/reports/money`). **Expect:** revenue reflects actual payments; no stale mock data. (`[PAY-03]`, `[PAY-04]`)
- [ ] **QA-057** 🖱️ P2 — Open revenue-by-source (`/reports/revenue-by-source`). **Expect:** totals sum to the same figure as the money dashboard.
- [ ] **QA-058** 🖱️/🔧 P1 — Open today's digest (`/digest`) and a past date (`/digest/:date`). `digestEnabled` defaults false and `DigestPage` only ever renders a previously-computed snapshot — it never computes on demand. Prerequisite: `PUT /api/settings` with `{digestEnabled: true, digestTime: "<a few minutes from now, HH:MM tenant-local>"}`, then wait for the 15-minute sweep (`runDailyDigestSweep`) to cross that bucket. **Expect:** once computed, digest content matches the day's actual jobs/revenue/leads; a date with no computed snapshot correctly shows "No digest for this day" rather than an error.

## 13. Inbox & AI proposals

- [ ] **QA-059** 🖱️ P0 — Approve a booking proposal from `/inbox`. **Expect:** executor runs; the resulting appointment actually exists on the calendar. (WF-36)
- [ ] **QA-060** 🖱️ P0 — Reject a proposal. **Expect:** status rejected, no side effect (no entity created). (WF-37)
- [ ] **QA-061** 🖱️ P1 — Edit a proposal's payload before approving (e.g. change a price or time). **Expect:** the edited value — not the original AI draft — is what gets executed. (WF-38)
- [ ] **QA-062** 🖱️ P1 — Use "Approve all eligible" on a chain of proposals. **Expect:** every eligible member executes; ineligible ones are skipped, not silently dropped.
- [ ] **QA-063** 🖱️ P1 — Click a proposal toast from elsewhere in the app. `Shell.handleNewProposal` calls `navigate('/inbox')` with no proposal ID or deep link — it opens the generic urgency-sorted inbox, it does not select the specific proposal for you. **Expect:** navigates to `/inbox`; you then find the toast's proposal yourself in the feed (this is *not* a proposal-specific deep link). (WF-41)

## 14. Comms inbox & interactions

- [ ] **QA-064** 🖱️ P1 — Open `/comms-inbox` and confirm SMS/email/voice threads for a customer are unified in one view.
- [ ] **QA-065** 🖱️ P1 — Open `/interactions` and view a call transcript drawer. **Expect:** transcript loads without a 5xx, even for a long call. (WF-46)
- [ ] **QA-066** 🖱️ P1 — Open `/interactions/dispatch` (dispatch log). **Expect:** shows a chronological log of dispatch-relevant events tied to the right job/appointment.

## 15. Assistant & in-app voice

- [ ] **QA-067** 🖱️/🎙️ P1 — On `/assistant`, type (or speak via the voice bar) "create an estimate for [customer] for [service]". **Expect:** a proposal card appears; approving it creates the estimate with correct line items. (WF-39)
- [ ] **QA-068** 🎙️ P1 — Use the in-app voice bar to issue a navigation command ("show me today's schedule"). **Expect:** app navigates correctly; no silent failure if the command is unrecognized (a fallback/clarification message shows instead). (WF-40)
- [ ] **QA-069** 🎙️ P1 — Start an in-app voice session (WebSocket) end to end. **Expect:** session completes cleanly; any resulting proposal shows in `/inbox`. (WF-45)

## 16. Inbound voice calls (Twilio)

Dial the tenant's real number from an external phone for every item in this
section — do not simulate. This is the highest-risk, least-automatable
surface in the product; treat it as launch-gating (P0) per `docs/qa-strategy.md`.

- [ ] **QA-070** ☎️ P0 — Call in as a **new** caller. **Expect:** the agent identifies you're new (`find-or-create-customer`/`find-or-create-lead`), discloses it's AI and that the call is recorded, and asks what you need. (WF-42)
- [ ] **QA-071** ☎️ P0 — Call in as an **existing** customer (from their number on file). **Expect:** `identify-caller` recognizes you by phone number without re-asking for your name.
- [ ] **QA-072** ☎️ P0 — Ask to book an appointment for a specific service and rough timeframe. **Expect:** agent proposes a real available slot (`lookup-availability`), confirms the details back to you (`confirm-intent`), and a booking proposal lands in `/inbox`; approving it creates the appointment. (WF-42, `[SCH-02]`, `[CUST-02]`)
- [ ] **QA-073** ☎️ P0 — Ask to reschedule or cancel an existing appointment by voice. **Expect:** agent finds the correct appointment (`lookup-appointments`) and produces the matching proposal — not a duplicate booking.
- [ ] **QA-074** ☎️ P0 — Say something urgent/emergency-sounding ("no heat, pipe burst," etc.). **Expect:** `classify-urgency-tier` + `escalate-to-human` trigger an escalation path with human-handoff context, not a routine booking flow. (WF-43, `[VOX-01]`)
- [ ] **QA-075** ☎️ P1 — Ask "what do I owe" / "what's my balance". **Expect:** `lookup-balance`/`lookup-invoices` returns your real, tenant-scoped balance in spoken-friendly format — never another customer's data.
- [ ] **QA-076** ☎️ P1 — Ask a question outside the agent's scope (e.g. unrelated small talk, or a request requiring owner judgment). **Expect:** `patch-owner-through` or an equivalent graceful handoff/voicemail — never a hallucinated commitment.
- [ ] **QA-077** ☎️/🔧 P1 — Deliberately go quiet or hang up mid-sentence (dropped-call simulation). The recovery worker (`runDroppedCallRecoverySweep`) *is* wired into `app.ts`, but it's dark by default behind the per-tenant `dropped_call_recovery` feature flag, and its only observable effect is a follow-up SMS — not a redial or voicemail. As a **platform admin** (not the tenant owner — this flag is gated above tenant level), enable it first: `PUT /api/admin/feature-flags/dropped_call_recovery` with `{enabled: true, tenantIds: [<your tenant id>]}`. **Expect:** roughly 60–90 seconds after the drop, an SMS arrives on the caller's phone, threaded into the same conversation as the dropped session (visible on `/interactions`).
- [ ] **QA-078** ☎️ P1 — Trigger a failed owner/on-call transfer (e.g. ask for the owner during a scenario that escalates, with no one answering) so the call falls through the full `owner → on-call → voicemail` chain. Calling merely outside business hours does **not** reach voicemail — `enforceCompliance` treats after-hours as a soft `allowed: true, isAfterHours: true` flag that routes to a separate after-hours greeting branch, not to `voicemail-fallback`. **Expect:** `voicemail-fallback` picks up only after the transfer chain is exhausted; the message is captured and a transcript shows up on `/interactions`.
- [ ] **QA-079** ☎️ P2 — Call outside the tenant's configured business hours. **Expect:** you're routed to the after-hours greeting branch (`isAfterHours: true`), not voicemail — note tenants have no business-hours schedule configured by default, so this may behave as `open` unless one is set first.
- [ ] **QA-080** ☎️ P1 — After the call ends, check `/interactions` for the transcript and recording. **Expect:** transcript is complete and encrypted at rest (per the 2026-06-04 QA report's Blocker 12 fix); recording link works. (WF-44, `[VOX-09]` session-in-timeline, `[VOX-10]` session artifact/DB linkage)
- [ ] **QA-081** ☎️ P0 — Confirm any outbound call/SMS the AI initiates to a number on the tenant's Do-Not-Call list is blocked, and that no outbound call fires during tenant-configured quiet hours (9pm–8am local by default). This is the TCPA/DNC gate — verify it end-to-end, not just that the code path exists, since it was the one open blocker in the most recent comprehensive QA pass.

## 17. Notifications & compliance

- [ ] **QA-082** 🖱️ P0 — Trigger a delay notice SMS: on the Schedule page, open a same-day appointment and use the **Notify delay** action (`Bell` icon) with a delay duration — an ordinary appointment reschedule does *not* send this SMS, "Notify delay" is a distinct virtual-status action (`isRunningBehind`/`delayMinutes`, does not change the appointment's stored status). **Expect:** customer receives the SMS with the delay noted; appointment status is unchanged. (`[SCH-05]`)
- [ ] **QA-083** 🖱️/🔧 P1 — Trigger a post-job feedback SMS/email. `runReviewRequestSweep` only fires for jobs whose `completed_at` is at least 24 hours in the past (its own ~10-minute sweep cadence, `tenant_settings.send_review_request = TRUE`), and it's gated by the customer's SMS consent/DNC status — a job you complete right now won't trigger anything today. Either backdate a test job's `completed_at` via an API-assisted step, or complete a job and check back the next day. Use a customer with `sms_consent = true` and a real primary phone. **Expect:** customer receives a working feedback link roughly 24h + up to 10min after completion — this also unblocks QA-091/QA-092, which depend on having a live feedback token to test against.
- [ ] **QA-084** ☎️/🖱️ P0 — Reply **STOP** to an SMS from the tenant number. **Expect:** the customer is marked opted-out and receives no further marketing/automated SMS; a direct reply confirming opt-out is sent once.
- [ ] **QA-085** 🖱️/🔧 P2 — Trigger an overdue-invoice reminder, on the overdue invoice from QA-050. `defaultDunningConfig`'s first cadence step is 3 days past due (not immediate), and `raiseDunningProposals` creates a `send_payment_reminder` proposal in `ready_for_review` — it does **not** dispatch automatically. Get to 3+ days past due (via a QA-050-style `paymentTermDays` backdate, or wait), then find and approve the proposal in `/inbox`. **Expect:** approving it sends the reminder once for that cadence step; re-running the sweep before the next cadence step doesn't raise a duplicate.
- [ ] **QA-086** 🖱️ P2 — Send an email via SendGrid-backed path (estimate/invoice delivery). **Expect:** email arrives, links resolve to the correct tenant-scoped page.

## 18. Public & customer self-service

- [ ] **QA-087** 🖱️ P1 — Fill and submit the public booking page (no token/login required, but bare `/book` reports "missing its business id" — use the link Settings copies for you (`/book?t=<tenantId>`)). **Expect:** produces a held appointment + owner proposal, visible in the inbox. (Not in the WF-01–50 catalog — a newer public surface distinct from the token-gated portal booking below)
**Prerequisite for QA-088–093:** there is no UI button anywhere in the
app to generate a `/portal/:token` link — the only thing that mints one is
the authenticated `POST /api/portal-sessions` route (body
`{customerId, contactId?, ttlDays?}`; the response includes the portal URL).
As the signed-in owner, call it with devtools/Postman using a real
`customerId` from your tenant to get a token for QA-088–093, and again
with a short `ttlDays` (or a hand-edited token) to get an expired/garbage one
for QA-093.

`PortalShell` ships **8 tabs** (`dashboard`/Overview, `estimates`, `invoices`,
`jobs`, `agreements`, `book`, `payment-methods`, `request`); QA-088 below
covers the shell load + the three list tabs together, the rest each get their
own row since they exercise distinct backend surfaces.

- [ ] **QA-088** 🖱️/🔧 P0 — Open the customer portal with a valid token (`/portal/:token`). Check the **Overview**, **Estimates**, **Invoices**, and **Jobs** tabs. **Expect:** shell loads, all four tabs load data scoped strictly to that token's customer. (WF-47 — the multi-tab `PortalShell` has no dedicated matrix row today; the closest existing coverage is the single-document token flows `[PORT-01]` estimate / `[PORT-02]` invoice)
- [ ] **QA-089** 🖱️/🔧 P1 — From inside the customer portal, use the **Request service** tab (`PortalRequestService`) to submit a new request. **Expect:** request recorded and the operator is notified — this is the actual WF-48 flow (do not conflate with QA-087's public `/book`, which is a different, unauthenticated surface). (WF-48)
- [ ] **QA-090** 🖱️/🔧 P1 — Use the portal's **Book appointment** tab (`PortalBookAppointment` + `PortalSlotPicker`) to describe a need and pick an open slot within business hours. **Expect:** booking succeeds; a taken/conflicting slot is rejected with `slotTaken`, not a silent double-book. This is a distinct, token-gated booking surface from QA-087's public `/book`.
- [ ] **QA-091** 🖱️/🔧 P1 — Open the portal's **Agreements** tab. **Expect:** any recurring service agreements for that customer list correctly (read-only per the shipped surface — no pause/cancel from the portal).
- [ ] **QA-092** 🖱️/🔧 P1 — Open the portal's **Payment methods** tab and add a card via the Stripe SetupIntent flow. **Expect:** the card saves and lists as a saved payment method for future use.
- [ ] **QA-093** 🖱️/🔧 P1 — Open the portal with an expired/garbage token. **Expect:** clean error, no data leak, no 500.
- [ ] **QA-094** 🖱️ P1 — Submit the post-job feedback form (`/feedback/:token`). **Expect:** rating persists; Settings → Feedback dashboard chart updates. (WF-49)
- [ ] **QA-095** 🖱️ P1 — Resubmit the same feedback token twice. **Expect:** second submission is rejected or treated as an edit — not double-counted.

## 19. Settings

- [ ] **QA-096** 🖱️ P1 — Update company profile (name, branding, contact info). **Expect:** changes reflect immediately in customer-facing surfaces (estimate/invoice pages, portal).
- [ ] **QA-097** 🖱️ P1 — Invite a team member and set their role. **Expect:** invite delivers; role gates the right UI/API access after they accept.
- [ ] **QA-098** 🖱️ P0 — Connect/verify Stripe from Settings. **Expect:** Stripe Connect account status shows correctly; payments route to the right connected account.
- [ ] **QA-099** 🖱️ P1 — On `/settings/templates`, edit an estimate template's customer-facing message (`defaultCustomerMessage`) — the surrounding template cards are AI-suggestion/mock UI, not a real dispatch-template editor; this field is the only one that's actually backend-persisted. **Expect:** the edited copy shows up on a newly created estimate using that template.
- [ ] **QA-100** 🖱️ P1 — Add/edit a price-book item and use it in a new estimate. **Expect:** the new price shows up as a selectable catalog line, and AI-drafted lines resolve against it.
- [ ] **QA-101** 🖱️/☎️ P2 — On `/settings/language`, set default language to Spanish **and** check the separate **Enable Spanish** checkbox — the checkbox controls `supportedLanguages` (defaults to `['en']` only) independently of the default-language picker, and the inbound language resolver rejects Spanish entirely when `'es'` isn't in that list. This page only controls the voice stack (`defaultLanguage`, TTS voice, caller auto-detect) — the web app has no i18n/translation layer, so the UI itself will **not** change language; that's expected, not a bug. **Expect:** both settings persist on reload, and a follow-up inbound call in Spanish (repeat a QA-074-style call speaking Spanish) gets a Spanish-language response.

## 20. Integrations — Google Calendar & QuickBooks

- [ ] **QA-102** 🖱️ P1 — Connect Google Calendar from Settings. **Expect:** OAuth completes, integration status shows connected. (WF-50)
- [ ] **QA-103** 🖱️ P1 — Create/assign an appointment and confirm it pushes to Google Calendar. **Expect:** `appointment_calendar_events.status = 'synced'` with a real external event id; event visible in the actual Google Calendar. (proposed matrix row `CAL-01` — not yet added to `matrix.ts`; see the WF-50 appendix in the platform-assessment spec)
- [ ] **QA-104** 🖱️ P2 — Disconnect Google Calendar. **Expect:** integration clears; no further pushes attempted; existing synced events aren't force-deleted from the customer's calendar.
- [ ] **QA-105** 🖱️ P1 — Connect QuickBooks Online from Settings (`QuickBooksIntegrationSheet`). **Expect:** OAuth completes, integration status shows connected.
- [ ] **QA-106** 🖱️ P1 — Pay an invoice, then trigger a manual sync from the QuickBooks sheet. **Expect:** the paid invoice appears in QuickBooks Online (per the sheet's "sync paid invoices" description); sync status reflects success in the UI.
- [ ] **QA-107** 🖱️ P2 — Disconnect QuickBooks. **Expect:** integration clears; no further syncs attempted.

## 21. Multi-tenant isolation & security

This section requires **both** tenants set up side by side (see "How to
use this" above) and is the one section that is run once, comparing the
two, rather than once per tenant.

- [ ] **QA-108** 🖱️ P0 — Hit `/metrics` and other operational endpoints without an auth token. **Expect:** requires the configured secret, not open by default.
- [ ] **QA-109** 🖱️ P0 — Hammer an authenticated endpoint past the configured rate limit. **Expect:** 429s kick in rather than the request silently succeeding forever.
- [ ] **QA-110** 🖱️ P0 — As Tenant B, attempt to approve/reject a Tenant A proposal by guessing/incrementing its ID. **Expect:** rejected — proposal execution respects tenant scoping, not just list views.
- [ ] **QA-111** 🖱️ P0 — As Tenant B, directly hit Tenant A's customer/job/estimate/invoice detail URLs by ID (repeat QA-008 with fresh IDs from §3–10 of your Tenant A pass). **Expect:** 403/404 on every entity type you touched, not just the ones already covered in §1.
- [ ] **QA-112** 🖱️ P0 — Compare Tenant A's and Tenant B's price books, templates, and settings side by side. **Expect:** each tenant's catalog/templates are fully independent — editing one never mutates the other (regression risk from any shared-cache or shared-fixture bug).
- [ ] **QA-113** ☎️ P0 — Call Tenant A's Twilio number and Tenant B's Twilio number back to back. **Expect:** each call is answered with that tenant's own greeting/persona and only surfaces that tenant's data (e.g. asking "what's my balance" on Tenant B's line never returns a Tenant A customer's numbers) — confirms `identify-caller` and the voice skills are scoped per-tenant, not per-phone-number-format.
- [ ] **QA-114** 🖱️ P1 — Create an estimate/invoice on both tenants around the same time. **Expect:** numbering sequences (invoice #, estimate #) are independent per tenant — no shared counter, no collision.
- [ ] **QA-115** 🖱️ P1 — Compare Tenant A's and Tenant B's Stripe Connect status and a payment made on each. **Expect:** each tenant's payments settle to its own connected Stripe account — a Tenant A customer's payment never appears on Tenant B's money dashboard.

## 22. Misc / internal

- [ ] **QA-116** 🖱️ P2 — Open `/design` (internal design-system showcase). **Expect:** loads without error; not linked from customer-facing nav.

---

## Run log

Copy this table into a dated file under `qa/reports/<date>/` (or append a
new block below) each time you run the sweep.

| Date | Tester | Tenant | Section(s) run | Pass | Fail | Blocked | Bugs filed |
|------|--------|--------|-----------------|------|------|---------|------------|
| | | | | | | | |

Log Tenant A and Tenant B as **separate rows** for Sections 1–20 (even on
the same date), and a single row noting "A vs B" for Section 21.

For each **Fail**, open `qa/backlog/BUG-NN-<slug>.md` the same day, following
the shape of the existing files in that folder (what broke, repro steps,
evidence, suggested fix location). Link the BUG-NN file back to the QA-###
item ID above so backlog and checklist stay cross-referenced.
