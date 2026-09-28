# Full Product QA Sweep — 2026-09-16 (live development environment)

**Method:** Fable 5.1 orchestrated; ten Sonnet worker lanes. The repo's 4-agent QA matrix (`e2e/qa-matrix`, 80 manifests) ran against Railway dev with real Postgres, Clerk dev HMAC tokens and the real LLM gateway; four API-driven lanes (auth/onboarding, security, performance/reports, AI quality) and six headless-browser lanes on a freshly self-served tenant covered the QA checklist sections the matrix does not. Build under test: main @ 454cfe9bf. The rendered report with the defect ledger and coverage table is the artifact published from this session; this file is the evidence-level detail.

**Headline:** business-critical gate 30/30 pass; voice-critical 14/20 (3 of 6 misses are environment or fixtures); 7 P1 and 14 P2 product defects, one P1 fixed test-first on branch `fix/send-invoice-uuid-job-reference`.

# Part 1 — QA matrix against Railway dev (2026-09-16)

Run: `qa/reports/2026-09-16-live-matrix/QA-REPORT.md` · main @ 454cfe9bf · 80 manifests · Playwright 86 passed, 1 failed, 1 flaky (4.9 min)
Harness verdicts: 69 pass · 5 partial · 5 fail · 1 n/a
Gates: Business-critical 30/30 PASS · Voice-critical 14/20 FAIL

## Non-passing rows, triaged

| Row | Verdict | Class | What actually happened | Where |
|---|---|---|---|---|
| ISO-01 | fail | Harness env | Agent C connected as `postgres` (rolsuper, rolbypassrls) because E2E_DB_URL_READONLY was unset and defaulted to READWRITE. RLS never applies to a superuser, so the GUC probe cannot be denied. The runbook predicts this. API-level cross-tenant rows (EST-06, PROP-03, ISO-01 steps before line 99) passed. | Create `qa_readonly` per `qa/backlog/ISO-01-rls-probe-role.md`; set E2E_DB_URL_READONLY |
| INV-05 / INV-06 | partial | Harness env | E2E_STRIPE_WEBHOOK_SECRET not set; forged signature correctly rejected (401). Payment application and idempotency not exercised. | Set the shared dev webhook secret; Stripe CLI not installed on this Mac |
| SCH-03 | fail (passed on retry) | Fixture pollution | Precondition expects exactly 1 upcoming appointment on tenant B; found 2 from prior runs. | `qa:reset` is TRUNCATE-guarded on the `railway` DB; needs a deliberate operator run or per-run tenants |
| VOX-05 / VOX-07 | fail | Harness seed collision, product behaved correctly | Utterance "Draft an estimate for the QA Matrix job…" resolved 3 customers at score 1.0: `qa-matrix-A-customer`, `qa-matrix-A-ambiguous-1`, `qa-matrix-A-ambiguous-2` (the VOX-12/13 pair seeded 2026-08-30). The turn pipeline asked a clarification (D-029) instead of drafting. The row's utterance and the seed's names collide. | Rename the ambiguous pair in `e2e/qa-matrix/fixtures/seed.ts` or have the row answer the clarification |
| VOX-11 | fail | Fixture pollution exposing a product limit | Voice created proposal 72a2693f (create_customer, ready_for_review). Inbox returned 100 of 191 with `truncated: true`; the row only looked at page 1. Web `InboxPage.tsx:917` renders "(showing first 100)" with no way to see the rest. | `packages/api/src/routes/proposals.ts` inbox cap; `packages/web/src/components/inbox/InboxPage.tsx` |
| AST-04 | partial | **Product defect** | Chat "Create and send an invoice for job c73844bd… totaling $250" drafted `send_invoice` with `invoiceId` = the job UUID. Approval succeeded; execution failed "Invoice not found". An approvable proposal that cannot execute is the exact class D-029 targets. | `packages/api/src/routes/assistant.ts` — verified-id scrub (`dropUnverifiedIds` ~1085) and `invoiceId → invoiceReference` mapping (~1879) |
| AST-03 | partial | Capability gap | "Revise estimate … add a $75 parts charge" → assistant declined ("contact your field-service representative"). No revise-estimate chat intent exists; only `create_change_order` is mapped. | `routes/assistant.ts` CHAT_INTENT_TO_REGISTRY_KEY (~2190–2230) |
| AST-07 | partial | Known deferred | Chain produced create_customer + draft_estimate (both ready_for_review), no invoice leg. Backlog lists AST-07 multi-step chaining as Tier 4 XL, deferred. | `qa/backlog/AST-07-multi-step-chaining.md` |
| VOX-04 | n/a | Documented | Telephony-only edge cases need a live Twilio staging environment. | — |

## Dev fixture state (tenant A)
57 customers (15× "QA Johnson", 15× "Priya Shah" from repeated CUST-01/AST-01 runs), 191 open proposals. Repeated runs accumulate data in the two matrix tenants, which now trips ambiguity and precondition checks. Recommend per-run tenants (QA_RUN_ID-suffixed owner_id) or a sanctioned reset before nightly runs.

## What the matrix proves works on dev (69 rows)
Provisioning for HVAC and plumbing packs; customer create/archive; estimate create, validate, edit, totals, convert, tenant isolation; estimate→send→accept and invoice→issue→pay journeys; appointment create/reschedule/status/running-late; voice scheduling (SCH-02) and cancel (SCH-03 on retry); SMS dispatch records and consent gating; partial/full/over-payment guards, deposit credit, money dashboard, overdue state; public estimate approval and invoice checkout by view token; voice emergency fast-path, Spanish response, DNC suppression, estimate send, invoice issue, interactions timeline, session DB linkage, no-guess caller matching; proposal guardrails, inbox prioritization endpoint, cross-tenant denial; reports; job and lead lifecycles; agreements; catalog, notes, conversations, locations, maintenance contracts; golden funnel JRN-03; invoice create/list/issue/void, payment link, overdue lifecycle; assistant create-customer, create-estimate, failure recovery.

# Part 2 — Authentication and self-serve onboarding on dev (browser, Clerk test mode)

Account: qa-lane-1789588054209+clerk_test@example.com · business "QA Lane Test Co" · HVAC. Evidence under scratchpad qa/auth/screenshots.

## Checklist §1
| Item | Verdict | Evidence |
|---|---|---|
| Sign-up completes and lands past auth | pass | 06-signup-after-verify.png → /onboarding |
| Mobile 375 px sign-in | partial | 53-mobile-375-login.png: layout fine, "Continue with Google" button ~30 px tall (guideline ≥44 px) |
| Invalid email shows error | pass | 54-invalid-email-error.png (native browser validation tooltip only) |
| Wrong password shows error | pass | 56-wrong-password-error.png |
| No account enumeration | **fail** | 00b-login-step2.png: unknown email → "Couldn't find your account." before any password prompt (Clerk hosted-UI default copy) |
| Password reset reachable | pass | 57-password-reset-requested.png |
| Session persists across reload / new context | pass | 51, 52 |
| Logout | pending | Sign-out control lives in the main Shell, unreachable pre-onboarding; retested by the onboarding-completion lane |
| Multi-tenant switching, role-based access | pending | needs the main Shell |

## Onboarding stepper (Sign up → Business identity → Pick trade → Phone number → Start trial → Verify AI → Test call; optional Tune terminology, Set automation rules)
- Business identity prefilled sane defaults (08-onboarding-step-0.png); trade picker (09); phone number auto-provisioned with no user action (10).
- **Start trial** opens a Stripe *sandbox* checkout for Basic $50/mo or Enterprise $150/mo with a 14-day trial (22-plan-selected.png, 24-stripe-checkout-filled.png).

## Bugs found (pathfinder)
1. **Checkout re-entry lockout (P2).** After one click on "Start 14-day free trial", every retry for ~2+ minutes returns 400 from `POST /api/onboarding/billing/checkout-session` with "A checkout was just started for this tenant. Complete it or wait a moment before trying again." A user who closes the Stripe tab or hits Back is stuck with no countdown or explanation. Evidence: 24-after-start-trial-retry.png, diagnostics-02.json.
2. **Stepper does not enforce order; "Verify AI" polls forever without a plan (P2).** Clicking "Verify AI" in the sidebar before completing Start trial shows "Running the check… usually a few seconds" and never resolves or errors (26–31-post-billing-step-*.png).
3. **Email enumeration at sign-in (P3, decision needed).** Clerk's hosted UI reveals whether an email exists. Either accept as a Clerk default or customise the copy.
4. Cosmetic: 4× aborted Pendo analytics beacons in headless Chromium; no app console errors otherwise.

## Onboarding completion lane (same account)
- Trial checkout completed with Stripe sandbox card 4242… once the Card panel's full billing address was supplied (`payment_method_collection: always`); Link "save info" unchecked instead of entering a phone. Return URL `/onboarding`; billing and Verify AI showed done within 0–3 s of returning. Test call skipped via the in-app "Skip — I'll test later" control. Optional "Tune terminology" and "Set automation rules" route to /settings.
- **P2 (root-caused) — checkout re-entry lockout is 32 minutes, not "a moment".** `packages/api/src/billing/subscription.ts` guards on a per-tenant `pending_checkout_at` with a hard-coded 32-minute window (matched to Stripe session expiry). A retry 200 s after the lock still failed; it cleared at the 32-minute mark. The error copy says "wait a moment" and no resume-checkout affordance exists although the backend tracks the live session.
- Logout works (`button[title="Sign out"]`, hidden behind a dismissible first-run tour modal) and re-login via email code works; §1 logout item → pass.
- Main navigation after onboarding: Home, Assistant, Jobs, Schedule, Customers, Messages, Leads, Estimates, Invoices, Interactions, Digest, Settings.
- Console/network: no first-party errors besides the documented 400; hCaptcha, Amazon Pay and Pendo noise is Stripe/third-party sandbox traffic.

# Part 3 — API-driven lanes on dev (Sonnet workers, evidence under scratchpad qa/lanes/*)

## Security & compliance (§18) and error handling (§15) — lanes/security/raw/*.txt
Findings
- **P2 — `/storage-dev/*` accepts unauthenticated PUT and GET on the live dev host.** `PUT /storage-dev/qa-sec-probe.txt` with no Authorization → 200; GET returns the bytes with the attacker-chosen Content-Type. `packages/api/src/routes/files.ts:198-227` (createDevStorageRouter) is mounted whenever NODE_ENV is not prod/staging (`app.ts:1112-1114`) regardless of whether DevStorageProvider is the active backend. In-memory, resets on restart, no tenant data reachable, but an open anonymous read/write surface.
- **P2 — the web app serves no security headers.** `serviceosweb-development` has no CSP, HSTS, X-Frame-Options, X-Content-Type-Options or Referrer-Policy; the API's helmet pipeline does not cover the static host.
- P3 (positive control) — mass assignment ignored: injected tenantId/role/isAdmin on POST /api/customers as Tenant B → server sets tenantId from auth (`routes/customers.ts:118`).
- P3 (informational) — `/api/health` and `/api/health/ai/completion` are not public despite being mounted before the auth gate (401, fail-closed); only `/api/health/ai` is open.
- Rate limiting: wiring and headers present, but dev ceiling is 100,000 req/min per tenant and 10,000 per IP per 15 min (`app.ts:682-697, 4696-4703`, "relaxed in dev"), so 429 was never observed with a ≤30-request budget.
Verified passing
- Auth matrix on 6 routes: no bearer, malformed, tampered signature → 401; valid → 200.
- Cross-tenant GET-by-id for customer, job, estimate, invoice, appointment, interaction, agreement → 404, never data. Conversations, files and voice sessions had no Tenant-A fixtures to target (partial).
- DNC gate: customer on Tenant B's DNC list with smsConsent true → `POST /api/estimates/:id/send` (sms) → 400 "SMS suppressed: dnc", blocked before any provider call (`gated-message-delivery.ts:318-341`).
- Input handling: 2 MB body → 413; malformed JSON → 400; missing fields → 400; unknown fields stripped; negative/float money on estimates and invoices → 400 ("Expected integer, received float"); SQL/NoSQL-shaped search → 200 empty; unicode/emoji names → 201. No 500 anywhere in the lane.
- Public surface enumerated from the pre-auth allowlist: health trio 200, swagger 301, random public estimate/invoice tokens 404, portal 401, OAuth callbacks 400 fail-closed, Twilio voice webhook without/with bogus signature → 403.
- CORS: unknown Origin never reflected. API headers on /health: HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy no-referrer, COOP/CORP same-origin (CSP only in production by design).
Not tested: true token expiry/revocation, PII-at-rest, actual 429, audit-row confirmation in DB, valid Twilio signature forging (deliberately not attempted). Data left in Tenant B: 3 `qa-sec-` customers, 1 location, 1 job, 1 estimate, 1 DNC entry.

## Performance (§16, non-destructive) and reports (§12) — lanes/perf/REPORT.md
- API latency, 14 endpoints × 2 tenants × 10 sequential samples: every p95 under 250 ms except `GET /api/proposals/inbox` on Tenant A (191 proposals): p50 86 ms, **p95 1,091 ms** (P2). Every list endpoint scales with data volume (Tenant A 150–245 ms p50 vs Tenant B ~60 ms). No response over 500 KB.
- Reports: money-dashboard, revenue-by-source, time-given-back return integer cents, isolate tenants correctly, invalid input → 400, empty ranges degrade gracefully. `revenue-by-source` accepts an inverted from>to range (P3). `time-given-back` has no date-range parameters. `tax-export` CSV works.
- Page loads (headless Chromium, 3 runs, desktop and 375 px): root, /login, public /e/:token and /pay/:token all under 1 s; /login LCP ~950 ms is the slowest; /pay transfers ~2.5 MB, dominated by Stripe.js. Zero app console errors.
- Bundle: largest asset `charts-*.js` 373.7 KB; no asset over 1 MB; **no asset served gzip/brotli-compressed** (P3).
- Health: /health, /ready, /api/telephony/health under 150 ms, no sensitive data.
- No P1: nothing over 3 s page load or 2 s p95 API. Load and concurrency items not run (shared environment).

## AI and proposal quality (§17, AI parts of §4/§9) — lanes/ai/evidence.jsonl (114 redacted pairs), Tenant B
Defects
- **P1 D — approvable proposal fails execution on a precondition its own error names as a pre-approval check.** Resolved `draft_estimate` for a customer with no service location approves, then `execution_failed: "Customer has no service location — add one before approving this estimate"`. Same class as AST-04.
- **P1 E — voice closing line claims completion for proposals that cannot be approved as drafted.** (1) Voice cancel-appointment drafts with `missingFields:[cancellationType]` (approve 400s) although the golden fixture expects `customer_request` and `voice-extended-tasks.ts:377` defaults it; the in-app adapter that built this proposal never sets it. (2) Voice "draft an estimate for a diagnostic visit" produced a proposal with no `lineItems` at all. Both times the caller hears "Great, I've got that taken care of… you'll receive a confirmation shortly" (`tts-copy.ts:210`).
- P2 A — "Add a new customer named Taylor." drafts at High confidence with no clarification and executes a customer with `lastName:""`, which the REST schema (`lastName: min(1)`) would reject. create_customer is the one chat intent not routed through the registry (`routes/assistant.ts` ~2182).
- P2 B — `DRAFT_ESTIMATE_PATTERN` (`intent-classifier.ts:1796`) captures everything up to the first colon as the customer reference, so natural phrasing between the name and the line-item colon breaks resolution; the same request with the colon right after the name resolves. A literal job UUID does not map to its customer either.
- P2 C — numeric picker replies ("1") work for appointment disambiguation but not for customer disambiguation, where the reply falls to general chat and loses the conversation. Owner: picker-reply handling in `gated-reference-resolution.ts`.
- P2 F — "Create an invoice from the accepted estimate" drafts one placeholder line "Service as per accepted estimate" at $10.00, uncatalogued, while the real accepted estimate totals $1,170 and REST convert-to-invoice carries it correctly.
- P2 G — "How much is a diagnostic visit?" answers with generic consumer advice instead of the tenant catalog price ($89 item exists); no catalog-price lookup intent in `lookup-dispatch.ts`.
- P3 H — Spanish input understood, replies always English.
- Reproduced: AST-04 on Tenant B (job UUID in invoiceId → execution_failed) and AST-03 (no revise-estimate intent).
Verified passing
- Safety: "delete all my customers", "refund everyone", "mark every invoice paid" → refused, no proposal, DB unchanged. Prompt injection in a customer name and note → treated as data, draft stayed ready_for_review.
- Emergency ("smell gas") → immediate 911 escalation, on-call notified, no proposal. Frustration → complaint guardrail, escalation. Bare "yes" with nothing pending → reprompt, no proposal. Lookups: "what is on my schedule today" answered directly. Two clean single-question disambiguations (customer pair, three appointments). "Send the invoice to <customer>" resolved the real invoice and executed. Missing tenant timezone → refusal to guess (intended).
- Budget used: 25 chat turns, 6 voice sessions.

# Part 5 — Browser lanes on the fresh tenant "QA Lane Test Co" (Sonnet workers, evidence under scratchpad qa/lanes/ui-*/screenshots)

## Dashboard (§2), Customers (§6), Leads (§7) — lanes/ui-customers
Dashboard: clean empty state, metric cards, quick actions, sidebar badge updated live when another lane's AI created a proposal, approval inbox at /inbox, money dashboard at /reports/money with $0 empty state; no console errors. Click-to-detail and date filters not exercised (no data yet). "Notifications" is an approval queue, not a read/unread inbox (partial vs checklist phrasing).
Customers: two-step create wizard with disabled-until-valid buttons; live duplicate detection (only once ≥10 digits typed); directory search by name/phone; service-type and tag chips; rich detail page (records tabs, contacts, portal, notes, tags, groups, recurring jobs, custom fields, merge tool, service locations, activity/profitability); edit works; notes persist (verified after reload via PUT /api/customers/:id).
Leads: kanban pipeline; new-lead validation; stage dropdown excludes won/lost by design; follow-up notes persist; mark-lost requires a reason and displays it; convert-to-customer redirects to the new record; public intake form at `/intake?t=<tenantId>` works unauthenticated end to end (POST /public/intake/:tenantId/leads → 201, lead visible in pipeline).
Bugs
- **P2 — malformed email on customer create surfaces only "Invalid request data".** Server returns `{"email":["Invalid email"]}`; the sheet discards the field detail. Form state preserved. `packages/web/src/components/customers/CustomersPage.tsx` (AddCustomerSheet).
- **P2 — Archive customer is one click, no confirmation, and no restore/unarchive control anywhere** (no "Archived" list filter; archived detail shows a static pill). Accidental archive has no UI undo.
- **P2 — public intake page shows the Clerk organisation default name** ("…+clerk_test's Organization") instead of the business name; confirmed in `GET /public/intake/:tenantId`.
- P3 — bare `/intake` without `?t=` hangs on "Loading services…" with no error.
- P3 — duplicate detection never fires for 7-digit numbers (threshold ≥10 digits).
- P3 — customer "Message" quick action opens the generic comms inbox empty state, not a compose for that customer.
- fail — no sort control on the customer directory; no create-estimate/schedule action on a lead before conversion (convert-first is the intended path).
- partial — phone numbers display verbatim (no (555) 555-0188 formatting); no dedicated Email/Call buttons on customer detail.
Data: customers qa-ui-cust-Full Flow (archived), qa-ui-cust-Notes Test (archived), qa-ui-cust-lead-Morgan Convert; leads qa-ui-cust-lead-Jamie Rivera (lost), qa-ui-cust-lead-Intake Public.

## Assistant and proposal review (§17 UI, §4.x), Messages (§10 UI), Interactions, Digest, Notifications (§2.3) — lanes/ui-assistant (17 assistant turns)
Works: proposal cards show fields and a High-confidence / Review-recommended bar; approve → "Applying shortly" → "Approved · undo" toast; undo within the window leaves nothing applied; ambiguity → a numbered one-question clarification and a typed "1" in chat resolves it (the API-lane numeric-reply failure did not reproduce through the UI); "delete all my customers" refused with no proposal; batch "Approve all" correctly excludes money, messages and irreversible actions (approved 1 of 5); the approval inbox shows "Approved but failed to execute" with a plain-English reason; SMS to a customer without consent is suppressed before Twilio (`SMS suppressed: no_consent`) and the customer record shows "No SMS consent"; notification badge tracks the pending count live; digest empty state renders.
Bugs
- **P1 — the assistant drops the customer's address on create_customer**, so every AI-created customer has no service location (tenant-wide "0 locations" across 15 customers). Downstream: an approved estimate fails execution "Customer has no service location — add one before approving this estimate" and appointment scheduling gates on `locationId`. The card only echoes name/email/phone. (Same root as the API lane's P1 D; the create_customer path also has no `address` on the customer entity per the API lane.)
- **P2 — the in-chat estimate card says "Tap Edit to fill before approval" but has no Edit control** for gated line-item/catalog picks; only Approve (disabled) and Dismiss. Resolution works only on `/inbox`, which is not in the primary navigation.
- **P2 — chat "Edit" for a customerId gate silently fails**: free-text "Customer name or ID" → Save & apply → `PUT /api/proposals/:id` 400, no error shown, Approve stays disabled.
- P3 — "Add a new customer named Taylor." approved at High confidence with a bare name (matches API lane P2 A).
- P3 — Reject is one click with no reason capture.
- P3 — `/interactions` is an AI voice-call log only, not the cross-entity timeline its name implies; the activity trail lives in Home's "Recent activity".
- P3 — Messages search placeholder overlaps its label; empty `/comms-inbox` has no compose button.
- Info — one WebSocket handshake failure (`/api/ws` 502, HTTP2 protocol error) during heavy proposal churn; not reproduced.
- Not observed: "(showing first 100)" inbox state (never reached 100 items); execution-failure status is not surfaced in the chat thread itself.
Data: customers Priya Whitfield, Taylor, Morgan Ashworth, Riley Ashworth; one failed-execution estimate for Priya; other proposals rejected/undone.

## Settings (§13), roles and multi-tenant (§1.2–1.3), security UI (§18) — lanes/ui-settings (technician session saved as state-tech.json)
Works: business profile edit/save/cancel/reload; terminology sheet; operator hours; quick-settings toggles autosave; price book add/edit/archive and the item appears in the estimate picker at the right price; team roster and a working technician invite; Stripe/calendar/QuickBooks connect surfaces and the subscription page (read-only, confirms before leaving to Stripe portal); call routing and handoff settings. A technician invited and signed up via Clerk test mode lands on /technician/day with a reduced nav (no Estimates, Invoices, Settings); every money/settings API returns 403 for that role and an actual invoice create attempt is refused server-side with "Insufficient permissions". No tenant switcher exists for a single-tenant owner (expected). No CSV export feature exists for any role. All changed settings were restored and verified.
Bugs
- **P2 — no client-side route guards for `/invoices`, `/estimates`, `/settings`, `/settings/price-book`: the technician role gets the full page shell and the New Invoice / New Estimate forms, whose job picker lists every tenant job with customer names and full service addresses.** Writes are blocked by the API (403), reads of invoices/estimates are 403, but the picker's job/customer data is not. `packages/web/src/components/invoices/InvoiceForm.tsx`; route-level guard absent.
- P3 — Team members modal says "Role and invite editing arrive in a follow-up release" above a working Invite control with role selection.
- P3 — price-book archive is a single click with no confirmation.
- P3 — no audit-trail / activity-log surface anywhere in the UI (§18.2 unverifiable from the product).
- Blocked — session timeout not observable from the UI.
- Test-automation trap (not a bug): several Settings row descriptions contain other rows' labels as substrings; loose text selectors misfire.
Console: one transient 502 on `GET /api/escalations/events`; technician 403s are correct enforcement.
Accounts: technician qa-ui-set-tech+clerk_test@example.com; catalog item qa-ui-set-Filter Kit (Deluxe) left archived.

## Phone size (§14) and error handling (§15) — lanes/ui-mobile (iPhone 13 emulation plus a 320 px overflow pass, 75 screenshots)
Works: all 12 navigation destinations render at 375 px with no horizontal overflow at 375 or 320; customer create via the sheet, job create, schedule today, estimate detail, one assistant turn, public estimate and invoice pages (the invoice "Pay $180.00 securely" button is 308×52) all work on the phone; branded 404 for unknown routes; required-field validation; server trims whitespace; simulated API failure shows an inline error and keeps the typed data; double-submit guarded (one POST, one record); refresh discards unsaved input as expected.
Bugs
- **P1 — `/customers/new` (the full-page CustomerEdit form) cannot create a customer unless every optional field is filled.** With only first and last name, `POST /api/customers` → 400 with companyName, secondaryPhone and email "at least 1 character / Invalid email" because the form sends empty strings instead of omitting them (`packages/web/src/pages/customers/CustomerEdit.tsx` handleSubmit ~L158–171); the UI shows only "Invalid request data". The sheet path (AddCustomerSheet) omits blanks and works. This route is also the target of the voice command "add a new customer" (`useVoiceCommands.ts` L37).
- **P1/P2 — a 280-character multibyte name with emoji makes `POST /api/customers` return 500 INTERNAL_ERROR** instead of a 400 "name too long"; looks like an uncaught column-length error and likely affects every create surface.
- P3 — the mobile bottom bar carries Home, AI, Jobs, Leads, Customers, Invoices only; Schedule, Messages, Estimates, Interactions and Digest have no tap-reachable entry on phone (no drawer or "More" in `Shell.tsx` getBottomNav L115–145); all render when deep-linked.
- P3 — cross-page tap targets under 44 px in `Shell.tsx`: topbar bell 18×18, avatar/settings 28×28, camera 32×32, mode-toggle segments 40 px; plus list filter chips (30–34 px), Settings native checkboxes (13×13) and "Edit" (21×16). Settings has the most offenders (29).
- P3 — bad or missing customer ids show the generic "Something went wrong / HTTP 404 / Retry" boundary rather than a customer-specific not-found.
- P3 — no offline indicator; the dashboard silently freezes at its last state when offline (recovers after reload).
- P3 — concurrent edits in two tabs both save 200 and the last write silently wins, no conflict warning.
- Inconclusive — back-after-save (confounded by the P1). Untestable — message thread (no threads on the tenant). Note: Stripe's embedded card element takes 5–7 s to paint in headless Chromium (rendering artifact, not a product bug).
Data: customers qa-ui-mob-Customer Two, qa-ui-mob-Debug Customer2, qa-ui-mob-DblSheet; job JOB-0004; estimate EST-0002 ($89).

## Jobs (§8), Appointments (§3), Dispatch operator view (§11) — lanes/ui-schedule
Works: manual job create with validation; job detail (customer, location, service type), notes, technician assignment link, time tracking; status control offers exactly the valid transitions at each stage and disappears at terminal; appointments create/appear on the schedule, reschedule, reassign dialog, cancel requires a reason; dispatch board loads with filters and date navigation and an unassigned queue sorted by time.
Bugs
- **P1 — the full-page customer form (`CustomerEdit.tsx` ~L158–168) sends blank optional fields as `""`, and `createCustomerSchema` (`packages/api/src/shared/contracts.ts:144-158`) uses `z.string().min(1).optional()`, which rejects `""`.** Every normal submit (no company, no secondary phone) is a generic "Invalid request data" 400. Independently found by the mobile lane; blocks the jobs/appointments flow from a fresh customer.
- **P1 — job photo upload is broken on dev: `POST /api/jobs/:id/photos/presign-upload` returns a PUT target on `http://localhost:8080/storage-dev/…`**, unreachable from the browser (ERR_CONNECTION_REFUSED), UI shows "Failed to fetch". The dev-mode storage adapter is reachable only from the API host. (`JobPhotoUploader.tsx`, `api/job-photos.ts`; same `/storage-dev` surface the security lane found open.)
- **P2 — two disconnected technician-assignment paths.** JobForm, JobSchedulePanel and Schedule's "New appointment" write `assignedTechnicianId` on the job; the dispatch board and appointment-level conflict/lateness logic read a separate assignment relation (`appointments/assignment.ts`, `dispatch/board-query.ts`) written only by the drag-and-drop proposal flow. Reproduced: two overlapping 10:30–11:30 appointments for the same active technician both returned 201 (rows carry no technicianId), the double-booking check in `pg-appointment.ts:70` never fires, and the dispatch board shows "No technician lanes to display" with both appointments Unassigned while the schedule day-list names the technician.
- P3 — "Preferred channel" offers `mail`, not in the API enum (phone|email|sms|none); selecting it 400s.
- P3 — cancel reason is persisted (`notes`) but never shown anywhere.
- P3 — Job Detail's primary Photos action is camera-only (getUserMedia) with no file-picker fallback; the working upload page is not discoverable from it.
- fail — no week/month calendar grid (single-day agenda plus a 7-day chip strip); no confirmed-vs-pending colour coding; no SMS confirmation preview or confirmed/unconfirmed indicator; no map, route, travel-time or skills alerts; no inline "new customer" in the appointment job picker.
- partial — job activity log shows the manual note but not the status transitions or time entry as audit events (only the progress stepper). Invited technicians remain pending Clerk invitations and do not appear in `/api/users?role=technician` for assignment until accepted.
Data: customers qa-ui-sched-Jobs-*, qa-ui-sched-Appt-B-*, qa-ui-sched-Appt-C-*; three jobs; two appointments; pending technician invite qa-ui-sched-tech+clerk_test@example.com.

## Estimates (§4), Invoices and payments (§5), public pages — lanes/ui-money
Works: estimate builder pre-fills customer and job; catalog lines carry cents-accurate prices; custom line; integer cents on the wire (unitPriceCents 9900/8900/4550, subtotalCents 27900); notes; send by email (202, status Sent); public estimate link loads unauthenticated with view tracking; tampered token 404; approval with name, signature pad and consent; operator shows Approved with the tracker lit; "Approved" tab filters correctly; change history logs edits. Convert to invoice carries totals exactly; INV-0001 issued/sent with a payment link and a real Stripe PaymentIntent; public pay page renders the Stripe Payment Element; test card 4242 confirms (200) and the customer sees "Payment received!"; repeat visit is idempotent; manual "Mark as paid" creates a Payment row and flips the invoice to paid; filters work; no float artifacts anywhere; no horizontal scroll at 375 px.
Bugs
- **P1 — a successful Stripe payment never updates the invoice on dev.** 15 s+ after Stripe confirm returned 200, `GET /api/invoices/:id` still says `status: open, amountPaidCents: 0`; the operator sees "Unpaid $279.00" and a "Mark as paid" button; Invoices list shows Collected $0.00. Only the manual "Mark as paid" workaround (a separate `credit_card` Payment row) reconciles it, leaving two disconnected records of one money event. `create-payment-intent` returned `stripeAccountId: null`. Most likely the Stripe webhook to the dev API is unconfigured or its secret is wrong (the matrix's INV-05/06 could not exercise the webhook either). Whether production is affected is unknown from dev.
- **P2 — rejected line-item edits render as if saved.** Negative price or blank description → API 400, but the UI shows the invalid line and a wrong total with no toast; only a reload restores the truth.
- P2 — public estimate and invoice pages show "…+clerk_test's Organization" instead of the business name (same root as the intake-page finding).
- P3 — zero-quantity lines accepted silently ($0 line); mobile "Decline this estimate" link is 16 px tall (Accept is 52 px); raw ISO timestamps ("Valid until 2026-10-16T07:00:00.000Z") in operator and send-dialog surfaces; "Estimate" quick action disabled on a fresh job while "Invoice" is enabled.
- Gaps — no tax-rate or discount UI in create/edit although the backend models taxRateBps/discountCents; SMS send not pre-filled from the customer phone; "Preview document" produced no PDF in headless (inconclusive); void, decline, 3-D Secure, partial and over-payment not exercised in the UI (proven at the API layer by the matrix).
Data: customer qa-ui-money-Customer Alpha; job JOB-0001; estimate EST-0001 ($279.00, approved); invoice INV-0001 (paid via manual reconcile); Stripe test PaymentIntent pi_3UGPueGwJGmWUrHG1R65D5tC.

# Part 4 — Fixed during this sweep (branch fix/send-invoice-uuid-job-reference, uncommitted)

Defect: chat "Create and send an invoice for job <jobId> totaling $250" drafted `send_invoice` with the job's UUID as `invoiceId`; approval succeeded; execution failed "Invoice not found" (matrix AST-04, reproduced on Tenant B by the AI lane).

Test-driven at three agreed seams, five red→green slices plus two pins:
- `SendInvoiceTaskHandler.handle` (`ai/tasks/voice-extended-tasks.ts`): a literal UUID lifts the gate only if it names an invoice this tenant owns; a job UUID with exactly one invoice resolves to that invoice; a job with several invoices keeps the gate and offers exactly those invoices as picker candidates; repo-verified ids are stamped `sourceContext.verifiedIds` so the chat route's scrub keeps them. Tests: `test/ai/tasks/voice-send-invoice.test.ts` (+3).
- `POST /api/assistant/chat`: the resolved invoice survives the verified-id scrub and approves; with no invoice the draft gates on invoiceId and approval refuses. Tests: `test/routes/assistant-send-invoice-job-reference.test.ts` (2).
- `approveProposal` (`proposals/actions.ts`): optional approval-time reference checks; new `proposals/approval-reference-checks.ts` with `invoiceReferenceCheck` (allowlisted to `send_invoice`), wired through `createProposalsRouter`'s trailing parameter in `app.ts`. Tests: `test/proposals/approve-reference-check.test.ts` (2), `test/routes/proposals-approve-reference-check.route.test.ts` (2, HTTP wiring pin).

Verification: `tsc --project tsconfig.build.json` clean; `npm run lint` clean; full API unit suite 1,256 files / 16,272 tests passed, 1 unrelated flaky portal-booking horizon test (passes 30/30 in isolation).

**Merged and verified live (2026-09-17):** PR #1311 merged (`380112072`), deployed to dev. After-artifact on Tenant B: no invoice → `send_invoice` gated on `invoiceId`, approve 400; one issued invoice → `invoiceId` resolved and stamped verified, approve 200, `executed` (`resultEntityId: mem-email-1`); draft-only → gated with the draft as a picker candidate. Review follow-ups landed: reference checks on every approval channel, chain-ref tokens exempt, only issued unsettled invoices lift the gate. Unblocking main's required check needed PR #1312 (test-only, fallout from #1263 and #1248). Production deploys fail independently — see issue #1313.
Follow-ups in the same defect class (not fixed): AI-lane P1 D (resolved estimate draft approves, fails on "customer has no service location"), P1 E (voice closing copy claims completion for un-approvable drafts), and extending the approval reference check to other invoice/estimate-carrying proposal types.

