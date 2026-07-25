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

**Total workflows in this checklist: 108** (13 inbound-call, 4 voice/in-app,
91 manual-click, several overlapping both), spanning 22 feature areas.
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

## 2. Onboarding & go-live

- [ ] **QA-006** 🖱️ P0 — Identity step: enter business name, industry/vertical. **Expect:** advances, `wizard_step_business` fires. (WF-06)
- [ ] **QA-007** 🖱️ P0 — Pack step: select a vertical pack (e.g. HVAC/plumbing). **Expect:** pack active under `/api/verticals`; price book pre-seeds from the pack.
- [ ] **QA-008** 🖱️/☎️ P0 — Phone step: provision a Twilio number. **Expect:** number assigned within the async worker's window; number is dialable from an outside phone once provisioned. (WF-07)
- [ ] **QA-009** 🖱️ P1 — Voice config panel: set the AI persona/greeting and (if enabled) a voice-approval PIN. **Expect:** persona text and PIN persist; PIN panel round-trips through settings.
- [ ] **QA-010** 🖱️ P1 — Calendar choice panel: connect or skip Google Calendar. **Expect:** connect opens OAuth consent; skip advances without blocking.
- [ ] **QA-011** 🖱️ P1 — Billing step: start trial or enter card. **Expect:** subscription/trial row created; billing portal session reachable. (WF-09)
- [ ] **QA-012** ☎️ P0 — Test-call step: call the newly-provisioned number from an outside phone. **Expect:** AI agent answers, discloses it's an AI (per `disclose-ai-identity` skill) and that the call may be recorded (`disclose-recording`), completes a greeting, onboarding checklist flips this step to done. (WF-08)
- [ ] **QA-013** 🖱️ P1 — Resume onboarding after closing the tab mid-wizard. **Expect:** re-opening `/onboarding` restores the correct step, no data loss.

## 3. CRM — customers

- [ ] **QA-014** 🖱️ P0 — Create a customer with a service location. **Expect:** appears in `/customers` list and in DB under the correct tenant. (WF-11, `[CUST-01]`)
- [ ] **QA-015** 🖱️ P1 — Edit customer fields + service location; attempt a duplicate. **Expect:** edits persist; dedupe guard triggers or merges as designed. (WF-12 — no dedicated matrix row yet; closest existing coverage is `[CUST-01]` create + `[CUST-03]` archive)
- [ ] **QA-016** 🖱️ P1 — Open a customer's timeline. **Expect:** jobs, estimates, invoices, and comms all show in one place with no 5xx. (WF-13)
- [ ] **QA-017** 🖱️ P2 — Search customers by name, phone, and email. **Expect:** all three match; partial-match search returns results.
- [ ] **QA-018** 🖱️ P1 — Add customer group / tag and filter customer list by it. **Expect:** filter narrows the list correctly.

## 4. CRM — leads

- [ ] **QA-019** 🖱️ P1 — Create a lead manually. **Expect:** appears on `/leads` kanban in the correct stage. (WF-14)
- [ ] **QA-020** 🖱️ P1 — Drag a lead card across kanban stages (all 6). **Expect:** stage persists on reload.
- [ ] **QA-021** 🖱️ P1 — Convert a lead to a customer. **Expect:** customer created/linked, lead marked won, no duplicate customer row. (WF-15)
- [ ] **QA-022** 🖱️ P0 — Submit the public intake form (`/intake`) as a prospect. **Expect:** a lead or customer appears in the app within a few seconds. (WF-16)

## 5. Jobs

- [ ] **QA-023** 🖱️ P0 — Create a job from a customer record. **Expect:** job appears on `/jobs` and on the customer timeline. (WF-17, `[JOB-01]`)
- [ ] **QA-024** 🖱️ P0 — Walk a job through its full lifecycle: scheduled → in progress → complete. **Expect:** each transition is audit-logged; UI reflects status immediately. (WF-18)
- [ ] **QA-025** 🖱️ P1 — Upload job photos (`/jobs/:id/photos`). **Expect:** photos upload, thumbnail renders, attached to the correct job.
- [ ] **QA-026** 🖱️ P2 — Fill a custom job form and add a custom field. **Expect:** values save and re-render on reopen.
- [ ] **QA-027** 🖱️ P1 — Create a job directly from an approved estimate (no re-key). **Expect:** line items/customer carry over untouched.
- [ ] **QA-028** 🖱️ P1 — Cancel a job mid-lifecycle. **Expect:** status reflects cancellation; any linked appointment is released.

## 6. Schedule & appointments

- [ ] **QA-029** 🖱️ P0 — Create an appointment on the schedule calendar. **Expect:** visible in week view immediately. (WF-19, `[SCH-01]`)
- [ ] **QA-030** 🖱️ P0 — Reschedule an appointment (drag or edit form). **Expect:** window updates, no double-assignment created. (WF-20, `[SCH-02]`)
- [ ] **QA-031** 🖱️ P1 — Cancel an appointment. **Expect:** status canceled, dispatch event fires, technician (if assigned) is freed. (WF-21, `[SCH-03]`)
- [ ] **QA-032** 🖱️ P0 — Attempt to double-book the same technician over an overlapping window. **Expect:** blocked or flagged — the DB exclusion constraint should reject the overlap, not just the UI.
- [ ] **QA-033** 🖱️ P2 — Switch calendar between day/week/month views. **Expect:** appointments render correctly in every view, no layout break.

## 7. Dispatch (multi-tech — P1, not launch-gated)

- [ ] **QA-034** 🖱️ P1 — Drag an unassigned job from the pool onto a technician lane on `/dispatch`. **Expect:** assignment proposal created or direct-assigns per config. (WF-23)
- [ ] **QA-035** 🖱️ P1 — Trigger the feasibility preview before confirming an assignment. **Expect:** overlap/travel-time warnings surface when relevant. (WF-24)
- [ ] **QA-036** 🖱️ P1 — Approve a schedule proposal generated from dispatch, from the inbox. **Expect:** proposal executes; calendar updates to match. (WF-25)
- [ ] **QA-037** 🖱️ P1 — Reassign a job from one technician's lane to another. **Expect:** old assignment clears, new one appears, no orphaned assignment left behind.

## 8. Technician / field

- [ ] **QA-038** 🖱️ P1 — As a technician, open `/technician/day` and clock in/out on a job. **Expect:** time entry rows created; weekly hours reflect the entry. (WF-22)
- [ ] **QA-039** 🖱️ P1 — From the mobile tech view (`?view=tech`), change a job's status via the CTA buttons. **Expect:** status updates; optional customer SMS fires if configured. (WF-26, WF-27)
- [ ] **QA-040** 🖱️ P1 — Verify tap targets on `/technician/day` at a 320px-wide viewport. **Expect:** ≥44px targets, no horizontal overflow (per CLAUDE.md mobile UI rule).

## 9. Estimates

- [ ] **QA-041** 🖱️ P0 — Draft an estimate, add line items from the price book. **Expect:** totals in integer cents match manual math; uncatalogued lines get a lower confidence/flag. (WF-28, `[EST-01]`)
- [ ] **QA-042** 🖱️ P0 — Send the estimate to the customer (SMS and/or email). **Expect:** status flips to "sent"; dispatch log row created. (WF-29)
- [ ] **QA-043** 🖱️ P0 — As the customer, open the estimate link (`/e/:id`) and approve it (with a deposit, if configured). **Expect:** status flips to accepted; deposit charge succeeds if required. (WF-30, `[PORT-01]`)
- [ ] **QA-044** 🖱️ P1 — As the customer, open an **expired or invalid** estimate token. **Expect:** a clean error state — no leaked mock/placeholder data.
- [ ] **QA-045** 🖱️ P0 — Convert an accepted estimate to an invoice. **Expect:** `estimate_id` link preserved, line items carry over unchanged, no re-key. (WF-31, `[EST-05]`)

## 10. Invoices & payments

- [ ] **QA-046** 🖱️ P0 — Issue an invoice and confirm customer delivery (SMS/email link). **Expect:** issued timestamp set; customer receives a working link. (WF-32, `[INV-01]` for the issue transition; the delivery leg is exercised end-to-end by `[JRN-03]`)
- [ ] **QA-047** 🖱️ P0 — As the customer, pay the invoice on `/pay/:id` with a Stripe test card. **Expect:** `checkout.session.completed` webhook flips invoice to paid. (WF-33, `[PORT-02]`)
- [ ] **QA-048** 🖱️ P1 — Make a partial payment, then pay the remainder. **Expect:** `partially_paid` → `paid` transitions correctly; overpayment is rejected. (WF-34, `[PAY-01]`)
- [ ] **QA-049** 🖱️ P1 — Let an invoice go overdue (or seed one). **Expect:** overdue-invoice worker flags it; owner sees it on the money dashboard. (`[PAY-04]`)
- [ ] **QA-050** 🖱️ P2 — Set up a progress/milestone billing plan on a job (a `create_invoice_schedule` proposal — e.g. percent-on-accept, percent-on-completion, remainder-on-manual — approved from the inbox). **Expect:** the schedule persists with its milestones; each milestone's invoice drafts/fires on its configured trigger (`on_accept`, `on_completion`, or `manual`) — note there is no date/recurrence-based trigger today, only these three.
- [ ] **QA-051** 🖱️ P2 — Run a batch invoice job across multiple jobs/customers. **Expect:** one invoice per eligible job, no duplicates, no cross-tenant leakage.
- [ ] **QA-052** 🖱️ P1 — Export a tax/revenue report for a date range. **Expect:** totals reconcile against the money dashboard for the same range.

## 11. Maintenance contracts

- [ ] **QA-053** 🖱️ P2 — Create a maintenance contract and attach it to a customer. **Expect:** appears on `/contracts` and on the customer's contract detail page.
- [ ] **QA-054** 🖱️ P2 — Edit/cancel a contract. **Expect:** status updates persist; linked jobs (if any) are unaffected.

## 12. Money reports & digest

- [ ] **QA-055** 🖱️ P1 — Open the money dashboard (`/reports/money`). **Expect:** revenue reflects actual payments; no stale mock data. (`[PAY-03]`, `[PAY-04]`)
- [ ] **QA-056** 🖱️ P2 — Open revenue-by-source (`/reports/revenue-by-source`). **Expect:** totals sum to the same figure as the money dashboard.
- [ ] **QA-057** 🖱️ P1 — Open today's digest (`/digest`) and a past date (`/digest/:date`). **Expect:** digest content matches the day's actual jobs/revenue/leads.

## 13. Inbox & AI proposals

- [ ] **QA-058** 🖱️ P0 — Approve a booking proposal from `/inbox`. **Expect:** executor runs; the resulting appointment actually exists on the calendar. (WF-36)
- [ ] **QA-059** 🖱️ P0 — Reject a proposal. **Expect:** status rejected, no side effect (no entity created). (WF-37)
- [ ] **QA-060** 🖱️ P1 — Edit a proposal's payload before approving (e.g. change a price or time). **Expect:** the edited value — not the original AI draft — is what gets executed. (WF-38)
- [ ] **QA-061** 🖱️ P1 — Use "Approve all eligible" on a chain of proposals. **Expect:** every eligible member executes; ineligible ones are skipped, not silently dropped.
- [ ] **QA-062** 🖱️ P1 — Click a proposal toast from elsewhere in the app. **Expect:** navigates straight into `/inbox` on the right item. (WF-41)

## 14. Comms inbox & interactions

- [ ] **QA-063** 🖱️ P1 — Open `/comms-inbox` and confirm SMS/email/voice threads for a customer are unified in one view.
- [ ] **QA-064** 🖱️ P1 — Open `/interactions` and view a call transcript drawer. **Expect:** transcript loads without a 5xx, even for a long call. (WF-46)
- [ ] **QA-065** 🖱️ P1 — Open `/interactions/dispatch` (dispatch log). **Expect:** shows a chronological log of dispatch-relevant events tied to the right job/appointment.

## 15. Assistant & in-app voice

- [ ] **QA-066** 🖱️/🎙️ P1 — On `/assistant`, type (or speak via the voice bar) "create an estimate for [customer] for [service]". **Expect:** a proposal card appears; approving it creates the estimate with correct line items. (WF-39)
- [ ] **QA-067** 🎙️ P1 — Use the in-app voice bar to issue a navigation command ("show me today's schedule"). **Expect:** app navigates correctly; no silent failure if the command is unrecognized (a fallback/clarification message shows instead). (WF-40)
- [ ] **QA-068** 🎙️ P1 — Start an in-app voice session (WebSocket) end to end. **Expect:** session completes cleanly; any resulting proposal shows in `/inbox`. (WF-45)

## 16. Inbound voice calls (Twilio)

Dial the tenant's real number from an external phone for every item in this
section — do not simulate. This is the highest-risk, least-automatable
surface in the product; treat it as launch-gating (P0) per `docs/qa-strategy.md`.

- [ ] **QA-069** ☎️ P0 — Call in as a **new** caller. **Expect:** the agent identifies you're new (`find-or-create-customer`/`find-or-create-lead`), discloses it's AI and that the call is recorded, and asks what you need. (WF-42)
- [ ] **QA-070** ☎️ P0 — Call in as an **existing** customer (from their number on file). **Expect:** `identify-caller` recognizes you by phone number without re-asking for your name.
- [ ] **QA-071** ☎️ P0 — Ask to book an appointment for a specific service and rough timeframe. **Expect:** agent proposes a real available slot (`lookup-availability`), confirms the details back to you (`confirm-intent`), and a booking proposal lands in `/inbox`; approving it creates the appointment. (WF-42, `[SCH-02]`, `[CUST-02]`)
- [ ] **QA-072** ☎️ P0 — Ask to reschedule or cancel an existing appointment by voice. **Expect:** agent finds the correct appointment (`lookup-appointments`) and produces the matching proposal — not a duplicate booking.
- [ ] **QA-073** ☎️ P0 — Say something urgent/emergency-sounding ("no heat, pipe burst," etc.). **Expect:** `classify-urgency-tier` + `escalate-to-human` trigger an escalation path with human-handoff context, not a routine booking flow. (WF-43, `[VOX-01]`)
- [ ] **QA-074** ☎️ P1 — Ask "what do I owe" / "what's my balance". **Expect:** `lookup-balance`/`lookup-invoices` returns your real, tenant-scoped balance in spoken-friendly format — never another customer's data.
- [ ] **QA-075** ☎️ P1 — Ask a question outside the agent's scope (e.g. unrelated small talk, or a request requiring owner judgment). **Expect:** `patch-owner-through` or an equivalent graceful handoff/voicemail — never a hallucinated commitment.
- [ ] **QA-076** ☎️ P1 — Deliberately go quiet or hang up mid-sentence (dropped-call simulation). **Expect:** the dropped-call recovery path (`detect-dropped`) either re-engages gracefully on redial or leaves a clean voicemail fallback — confirm the `dropped-call-worker` is actually wired into `app.ts` before signing this off, it has a known history of being built-but-unwired.
- [ ] **QA-077** ☎️ P1 — Let a call ring through to voicemail (or call outside business hours). **Expect:** `voicemail-fallback` picks up cleanly; the message is captured and a transcript shows up on `/interactions`.
- [ ] **QA-078** ☎️ P1 — After the call ends, check `/interactions` for the transcript and recording. **Expect:** transcript is complete and encrypted at rest (per the 2026-06-04 QA report's Blocker 12 fix); recording link works. (WF-44, `[VOX-09]` session-in-timeline, `[VOX-10]` session artifact/DB linkage)
- [ ] **QA-079** ☎️ P0 — Confirm any outbound call/SMS the AI initiates to a number on the tenant's Do-Not-Call list is blocked, and that no outbound call fires during tenant-configured quiet hours (9pm–8am local by default). This is the TCPA/DNC gate — verify it end-to-end, not just that the code path exists, since it was the one open blocker in the most recent comprehensive QA pass.

## 17. Notifications & compliance

- [ ] **QA-080** 🖱️ P0 — Trigger a delay notice SMS (e.g. reschedule a same-day appointment). **Expect:** customer receives the SMS with correct new time.
- [ ] **QA-081** 🖱️ P1 — Trigger a post-job feedback SMS/email. **Expect:** customer receives a working feedback link.
- [ ] **QA-082** ☎️/🖱️ P0 — Reply **STOP** to an SMS from the tenant number. **Expect:** the customer is marked opted-out and receives no further marketing/automated SMS; a direct reply confirming opt-out is sent once.
- [ ] **QA-083** 🖱️ P2 — Trigger an overdue-invoice reminder. **Expect:** reminder sends once per cadence, not on every worker tick.
- [ ] **QA-084** 🖱️ P2 — Send an email via SendGrid-backed path (estimate/invoice delivery). **Expect:** email arrives, links resolve to the correct tenant-scoped page.

## 18. Public & customer self-service

- [ ] **QA-085** 🖱️ P1 — Fill and submit the public booking page (`/book`, no token/login required). **Expect:** produces a held appointment + owner proposal, visible in the inbox. (Not in the WF-01–50 catalog — a newer public surface distinct from the token-gated portal booking below)
- [ ] **QA-086** 🖱️ P1 — From inside the customer portal (`/portal/:token`), use the **Request service** tab (`PortalRequestService`) to submit a new request. **Expect:** request recorded and the operator is notified — this is the actual WF-48 flow (do not conflate with QA-085's public `/book`, which is a different, unauthenticated surface). (WF-48)
- [ ] **QA-087** 🖱️ P0 — Open the customer portal with a valid token (`/portal/:token`). **Expect:** jobs/estimates/invoices tabs load, scoped strictly to that token's data. (WF-47 — the multi-tab `PortalShell` has no dedicated matrix row today; the closest existing coverage is the single-document token flows `[PORT-01]` estimate / `[PORT-02]` invoice)
- [ ] **QA-088** 🖱️ P1 — Open the portal with an expired/garbage token. **Expect:** clean error, no data leak, no 500.
- [ ] **QA-089** 🖱️ P1 — Submit the post-job feedback form (`/feedback/:token`). **Expect:** rating persists; Settings → Feedback dashboard chart updates. (WF-49)
- [ ] **QA-090** 🖱️ P1 — Resubmit the same feedback token twice. **Expect:** second submission is rejected or treated as an edit — not double-counted.

## 19. Settings

- [ ] **QA-091** 🖱️ P1 — Update company profile (name, branding, contact info). **Expect:** changes reflect immediately in customer-facing surfaces (estimate/invoice pages, portal).
- [ ] **QA-092** 🖱️ P1 — Invite a team member and set their role. **Expect:** invite delivers; role gates the right UI/API access after they accept.
- [ ] **QA-093** 🖱️ P0 — Connect/verify Stripe from Settings. **Expect:** Stripe Connect account status shows correctly; payments route to the right connected account.
- [ ] **QA-094** 🖱️ P1 — Edit an SMS/email template. **Expect:** the edited copy is what customers actually receive on the next send.
- [ ] **QA-095** 🖱️ P1 — Add/edit a price-book item and use it in a new estimate. **Expect:** the new price shows up as a selectable catalog line, and AI-drafted lines resolve against it.
- [ ] **QA-096** 🖱️ P2 — Change language setting (`/settings/language`). **Expect:** UI (and voice persona, if wired) reflects the new language.

## 20. Integrations — Google Calendar

- [ ] **QA-097** 🖱️ P1 — Connect Google Calendar from Settings. **Expect:** OAuth completes, integration status shows connected. (WF-50)
- [ ] **QA-098** 🖱️ P1 — Create/assign an appointment and confirm it pushes to Google Calendar. **Expect:** `appointment_calendar_events.status = 'synced'` with a real external event id; event visible in the actual Google Calendar. (proposed matrix row `CAL-01` — not yet added to `matrix.ts`; see the WF-50 appendix in the platform-assessment spec)
- [ ] **QA-099** 🖱️ P2 — Disconnect Google Calendar. **Expect:** integration clears; no further pushes attempted; existing synced events aren't force-deleted from the customer's calendar.

## 21. Multi-tenant isolation & security

This section requires **both** tenants set up side by side (see "How to
use this" above) and is the one section that is run once, comparing the
two, rather than once per tenant.

- [ ] **QA-100** 🖱️ P0 — Hit `/metrics` and other operational endpoints without an auth token. **Expect:** requires the configured secret, not open by default.
- [ ] **QA-101** 🖱️ P0 — Hammer an authenticated endpoint past the configured rate limit. **Expect:** 429s kick in rather than the request silently succeeding forever.
- [ ] **QA-102** 🖱️ P0 — As Tenant B, attempt to approve/reject a Tenant A proposal by guessing/incrementing its ID. **Expect:** rejected — proposal execution respects tenant scoping, not just list views.
- [ ] **QA-103** 🖱️ P0 — As Tenant B, directly hit Tenant A's customer/job/estimate/invoice detail URLs by ID (repeat QA-005 with fresh IDs from §3–10 of your Tenant A pass). **Expect:** 403/404 on every entity type you touched, not just the ones already covered in §1.
- [ ] **QA-104** 🖱️ P0 — Compare Tenant A's and Tenant B's price books, templates, and settings side by side. **Expect:** each tenant's catalog/templates are fully independent — editing one never mutates the other (regression risk from any shared-cache or shared-fixture bug).
- [ ] **QA-105** ☎️ P0 — Call Tenant A's Twilio number and Tenant B's Twilio number back to back. **Expect:** each call is answered with that tenant's own greeting/persona and only surfaces that tenant's data (e.g. asking "what's my balance" on Tenant B's line never returns a Tenant A customer's numbers) — confirms `identify-caller` and the voice skills are scoped per-tenant, not per-phone-number-format.
- [ ] **QA-106** 🖱️ P1 — Create an estimate/invoice on both tenants around the same time. **Expect:** numbering sequences (invoice #, estimate #) are independent per tenant — no shared counter, no collision.
- [ ] **QA-107** 🖱️ P1 — Compare Tenant A's and Tenant B's Stripe Connect status and a payment made on each. **Expect:** each tenant's payments settle to its own connected Stripe account — a Tenant A customer's payment never appears on Tenant B's money dashboard.

## 22. Misc / internal

- [ ] **QA-108** 🖱️ P2 — Open `/design` (internal design-system showcase). **Expect:** loads without error; not linked from customer-facing nav.

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
