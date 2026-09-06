# Full Product Verification — 2026-09-06

**Goal:** prove every feature and workflow works, and produce a fix plan for anything that does not.
**Method:** Fable 5.1 planned and orchestrated; six Sonnet worker agents executed each verification lane in parallel on a 4-core cloud container (no external credentials, Docker available). Every lane ran the exact commands CI runs, plus two runtime lanes that booted the real API and real web app and drove them over HTTP and headless Chromium.
**Branch / commit under test:** `claude/feature-workflow-testing-s8dbhs` at `e6ef330` (identical to `origin/main`).
**Substituted layers:** auth (the repo's own `DEV_AUTH_BYPASS` + `VITE_AUTH_MODE=dev` shim), persistence for runtime lanes (InMemory repos; the integration lane used real Postgres 16 + pgvector with all 277 migrations). External providers (Clerk cloud, Stripe, Twilio, Deepgram/ElevenLabs, LLM, QuickBooks, Wisetack) have no credentials here; those legs are marked **STAGING** with the exact gate that proves them.

---

## 0. Verdict

| Lane | Command (as CI runs it) | Result | Numbers |
|---|---|---|---|
| API production typecheck | `tsc --project tsconfig.build.json --noEmit` | ✅ PASS | 0 diagnostics |
| API lint (log-safety, lint tsconfig, scripts) | `npm run lint` (packages/api) | ✅ PASS | 0 findings |
| API unit tests | `vitest run` (packages/api) | ✅ PASS | 1158 files, 14 158 tests passed, 0 failed, 6 expected-fail, 12 skipped, 38 todo, 271 s |
| API integration tests (real Postgres, RLS runtime role) | `TEST_DB=testcontainers RLS_RUNTIME_ROLE=true vitest run --config vitest.integration.config.ts` | ✅ PASS | 213 files, 1 218 tests passed, 0 failed, 113 s |
| Web typecheck | `tsc --noEmit` (packages/web) | ✅ PASS | 0 diagnostics |
| Web unit/component tests | `vitest run` (packages/web) | ✅ PASS | 282 files, 2 058 tests, 0 failed, 197 s |
| Shared typecheck + tests | `tsc --noEmit && vitest run` (packages/shared) | ✅ PASS | 16 files, 173 tests |
| Mobile unit tests + coverage gate | `vitest run --root packages/mobile --coverage` | ✅ PASS | 116 files, 826 tests; stmts 87.41 % (≥86), branches 77.27 % (≥72), funcs 85.46 % (≥82), lines 90.35 % (≥89) |
| Mobile typecheck | `npm ci && npm run typecheck` (packages/mobile) | ✅ PASS | 0 diagnostics |
| Corpus pipeline typecheck | `npm run typecheck:corpus` | ✅ PASS | 0 diagnostics |
| AI gateway guard | `check:ai-gateway-guard` | ✅ PASS | no direct provider calls outside gateway |
| FK-path coverage guard | `check:fk-paths` | ✅ PASS | all allowlisted FK-writing paths covered |
| Migration key guard | `check:migration-keys` | ✅ PASS | 277 keys OK |
| Env-coverage guard | `check:env-coverage` | ✅ PASS | 162 vars read, 82 declared, 29 on the advisory `unreviewed` backlog (non-blocking) |
| Agent graph coverage gate | `agent:graph-coverage --gate` | ✅ PASS | 15/15 required paths (100 %) |
| Corpus PII guard | `test:pii-leakage` | ✅ PASS | 8 files, 0 PII |
| Corpus schema floors | `test:corpus-schema` | ⚠️ FAIL (known, non-blocking in CI) | ~39 legacy rows with intent `unknown` (T6-F03 taxonomy drift) |
| Corpus duplicate gate | `corpus:dedup` | ⚠️ FAIL (known, non-blocking in CI) | 0 exact, 600 near-duplicates (cosine > 0.95) |
| Voice-quality cassette presence | `voice-quality:check-cassettes` | ✅ PASS | 73/73 Layer-1 scripts have cassettes |
| Voice-quality corpus suite + launch gate | `VOICE_QUALITY_ENFORCE_LAUNCH_GATE=true npm run voice-quality` | ✅ PASS | 73/73 scripts, 100 %, `launchGate.pass=true`, all 11 buckets at/above threshold, 0 cassette drift |
| Cassette seed idempotence | `voice-quality:seed-cassettes` + `git status` | ✅ PASS | `Seeded 73/73 cassettes.`, zero file changes |
| Playwright hermetic tier (CI `e2e.yml` equivalent) | `npm run e2e` (default chromium project) | ✅ PASS | 19 passed, 0 failed, 0 flaky, 59 skipped (credential-gated, see §3) |
| API runtime proof (real HTTP against booted API) | 11 workflows, §4 | ✅ 11/11 PASS | 1 defect confirmed (D-1, pre-existing C-1) |
| Web runtime proof (headless Chromium against booted SPA) | 10 steps / 25 page loads, §5 | ✅ 25/25 rendered, flows PASS | 1 money-display defect (D-7), 1 dev-harness gap (D-8), 2 minor (D-9, D-10) |

**Bottom line:** every automated gate the repository defines is green on this commit, including the two lanes CI runs only with Docker (integration) and a browser (Playwright). No regression was found in any automated suite. Two pre-existing, documented non-blocking corpus checks remain red. The runtime lanes found one pre-existing defect (D-1, unmatched `/api/*` falls into the SPA catch-all) and one new customer-facing money-display defect (D-7, estimate detail shows the untaxed subtotal as the total). Both are P1 in §7 and were dispatched to worker agents in this session.

**Infra events during the run (not product):** (a) the first integration run died at T+91 s with Postgres `57P01` because a sibling agent force-removed "leftover" pgvector/ryuk containers during its own probe; the isolated re-run passed 1 218/1 218. (b) Playwright 1.62.1 expects `chromium_headless_shell-1234`; the container ships build 1194. The repo's own `QA_CHROMIUM_PATH` escape hatch in `playwright.config.ts` fixed it with no file change.

---

## 1. Surface inventory (what "every feature" means)

### 1.1 API route prefixes (mounted in `packages/api/src/app.ts`)

| Prefix | Domain |
|---|---|
| `/api/health`, `/` | liveness/readiness |
| `/api/me` | identity, role, permissions, mode, timezone |
| `/api/customers`, `/api/customer-groups`, `/api/customer-custom-fields`, `/api/locations` | customer domain |
| `/api/leads`, `/public/intake` | lead intake |
| `/api/jobs`, `/api/job-forms`, `/api/job-custom-fields`, `/api/recurring-jobs`, `/api/time-entries` | job lifecycle |
| `/api/appointments`, `/api/dispatch`, `/api/technician-location` | scheduling and dispatch |
| `/api/estimates`, `/public/estimates` | estimates + public approval |
| `/api/invoices`, `/public/invoices`, `/api/public-payments`, `/api/payments`, `/api/terminal`, `/api/billing`, `/api/financing`, `/webhooks/wisetack` | invoices, payments, SaaS billing, financing |
| `/api/maintenance-contracts`, `/api/standing-instructions` | agreements, standing instructions |
| `/api/users`, `/api/admin/tenants`, `/api/admin/feature-flags`, `/api/settings`, `/api/settings/brand-voice`, `/api/settings/packs`, `/api/notification-preferences`, `/api/devices` | tenant/user configuration |
| `/api/calendar-integrations`, `/api/integrations`, `/api/googlebusiness-integrations` | third-party OAuth |
| `/api/conversations`, `/api/interactions`, `/api/assistant`, `/api/proposals`, `/api/notes` | AI inbox, assistant, proposal gate |
| `/api/onboarding`, `/api/onboarding/conversation` | onboarding v1 + conversational v2 |
| `/api/voice`, `/api/voice/sessions`, `/api/telephony`, `/api/calls`, `/api/dnc`, `/api/escalations` | voice and telephony |
| `/api/reports`, `/api/digests`, `/api/analytics/*` | reporting |
| `/api/catalog/items`, `/api/templates`, `/api/message-templates`, `/api/bundles`, `/api/verticals`, `/api/vertical-training-assets` | catalog and templating |
| `/api/quality`, `/api/evaluation`, `/api/feedback/responses`, `/api/entity-aliases` | AI quality, feedback, entity resolution |
| `/api/files`, `/storage-dev` | attachments |
| `/public/feedback`, `/public/booking`, `/public/portal` | customer-facing public surfaces |
| `/webhooks/{stripe,clerk,vapi,twilio,wisetack,sendgrid}` | inbound provider webhooks (all signature-validating) |
| `/api-docs` | Swagger UI |

### 1.2 Web page routes (`packages/web/src/routes.ts`, pinned by `routes.test.ts`)

Fullscreen: `/login`, `/signup`, `/onboarding`, `/e/:id` (estimate approval), `/pay/:id` (invoice payment), `/intake`, `/book`, `/feedback/:token`, `/portal/:token`.
Authenticated shell: `/`, `assistant`, `sessions/:id`, `jobs`, `jobs/new`, `jobs/:id`, `jobs/:id/photos`, `schedule`, `dispatch`, `customers`, `customers/new`, `customers/:id`, `customers/:id/edit`, `appointments/:id/edit`, `leads`, `leads/new`, `leads/:id`, `estimates`, `estimates/new`, `estimates/:id`, `invoices`, `invoices/new`, `invoices/:id`, `contracts`, `contracts/:id`, `inbox` (`proposals` redirects here), `comms-inbox`, `interactions`, `interactions/dispatch`, `settings`, `settings/templates`, `settings/price-book`, `settings/feedback`, `settings/language`, `reports/money`, `digest`, `digest/:date`, `reports/revenue-by-source`, `technician/day`, `design`.

---

## 2. Complete feature and workflow list with evidence

Legend: **VERIFIED** = automated evidence executed green in this run; **VERIFIED (runtime)** = additionally driven live in §4/§5; **STAGING** = code path exists and is wired (signature checks, stubs, skips prove wiring) but the end-to-end leg needs a provider credential; **GAP** = no automated evidence found, manual only.

### 2.1 Authentication and account management (QA §1)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Clerk RS256 session verification, JWKS | `test/auth/clerk-rs256.test.ts`, `test/middleware/auth*.test.ts` | VERIFIED |
| RBAC owner/admin/dispatcher/technician permissions | `test/auth/rbac.test.ts`; `/api/me` returned 27 permissions for owner (§4.1) | VERIFIED (runtime) |
| Tenant context + RLS session GUC | `test/middleware/tenant-context.test.ts`; integration `rls-runtime-role`, `rls-runtime-audit` (every table RLS enabled+forced, every table has a policy), `pgbouncer-tenant-isolation`, `rls-cross-tenant-sweep`, `rls-force-catalog`, `rls-tenant-isolation`, `tenant-isolation.leak` | VERIFIED |
| Cross-tenant reads over HTTP | §4.7: second tenant got 404 on customer, job, estimate, invoice | VERIFIED (runtime) |
| Clerk webhook `user.created` → owner membership bootstrap, replay idempotent | integration `clerk-owner-membership`, `owner-membership-backfill`, `users-tenant-clerk-unique`, `webhooks` (svix signature) | VERIFIED |
| Session persistence / no 401 storm on token refresh | `e2e/no-401-storm.spec.ts` (3 passed) | VERIFIED |
| Sign-in / sign-up UI against Clerk cloud, password reset | `smoke.spec.ts` UI tests, `journeys/signup-to-first-estimate.spec.ts`, `coverage-sweep` | STAGING (needs `E2E_CLERK_*`) |
| Account deletion (soft delete self) | integration `user-account-deletion`; mobile `settings-delete-account.test.ts` | VERIFIED |
| Dev auth bypass refused in production | `test/auth/dev-auth-bypass*`, `prodEnvSchema` forbids `DEV_AUTH_BYPASS=true` (`test/shared/config*`) | VERIFIED |

### 2.2 Dashboard and home (QA §2)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Role home (owner/dispatcher/technician variants) | `components/home/RoleHome.test.tsx`, `HomePage.test.tsx` | VERIFIED |
| KPI cards, money-loop card, activity feed | `CoreKpisCard.test.tsx`, `MoneyLoopHomeCard.test.tsx`, `ActivityFeedCard.test.tsx`; API `test/analytics/*`, `test/digest/*` | VERIFIED |
| "Active today" count in tenant timezone | §5 step 1 | see §5 |
| Notifications: preferences, device tokens, owner push | integration `notification-preferences`, `device-tokens`, `appointment-reminder-owner-push.integration` | VERIFIED |
| Customer portal dashboard (mobile) | `e2e/portal-dashboard-mobile.spec.ts` (4 passed, hermetic Clerk stub) | VERIFIED |

### 2.3 Appointments and scheduling (QA §3)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Create appointment (API) and see it in the day window | §4.3 steps 2 and 8; integration `appointments` | VERIFIED (runtime) |
| Reschedule / cancel / reassign dialogs | web `RescheduleDialog`, `CancelDialog`, `ReassignDialog` tests (unit + `__tests__`) | VERIFIED |
| Voice-driven reschedule / cancel / reassign / auto-pick | integration `reschedule-appointment-voice`, `cancel-appointment-voice`, `reassign-appointment-voice`, `auto-pick-appointment-920`, `voice-inbound-appointment` | VERIFIED |
| Reschedule via proposal with 5 s undo window | §4.6 steps 5–10 | VERIFIED (runtime) |
| Technician double-booking race, slot conflicts, held-slot reaper | integration `technician-double-booking-race`, `slot-conflict-checker`, `hold-reaper`, `emergency-dispatch-hold` | VERIFIED |
| Tenant-timezone day window | integration `dispatch-technician-day-window`, `live-call-booking-timezone`; §5 step 5 | VERIFIED |
| Public booking page → held appointment → inbox proposal | `e2e/booking-mobile.spec.ts` (skipped: needs Clerk key); API `test/scheduling/*` | STAGING (UI), VERIFIED (API) |
| SMS appointment confirmations | `test/sms/*`, integration `customer-message-delivery` (claim-before-send, crash/retry paths), `tech-status-sms` | VERIFIED (delivery itself STAGING: Twilio) |
| Job ↔ appointment status sync | integration `job-appointment-sync` | VERIFIED |

### 2.4 Estimates and proposals (QA §4)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Create estimate, integer-cents subtotal/tax/total | §4.4: 31 000 + 2 558 (825 bps, rounded) = 33 558; 29 files in `test/estimates/*`; integration `estimates`, `estimate-phases` | VERIFIED (runtime) |
| Float or negative cents rejected | §4.11 steps 3–4 (400 `VALIDATION_ERROR`) | VERIFIED (runtime) |
| Send → accept transitions | §4.4 steps 2–4 | VERIFIED (runtime) |
| Public approval page with signature, deposit | `e2e/public/estimate-approval.spec.ts` (2 passed), `money-loop/estimate-approve-execute.spec.ts` (2 passed), `EstimateApprovalPage.*.test.tsx` (5 variants) | VERIFIED |
| AI-drafted estimate proposal, catalog grounding, confidence caps | `test/ai/resolution/catalog-resolver*`, `test/proposals/*` (114 files); integration `draft-estimate-execution`, `update-estimate-execution`, `resolve-line`, `invoice-pricing-source`, `line-item-unit-editor-round-trip`, `spoken-parts-*` | VERIFIED |
| Estimate revise / nudge | `e2e/qa-matrix/estimate-revise.spec.ts` (deployed-only); integration `estimate-nudge` | VERIFIED (API), STAGING (matrix UI) |
| Mobile estimate create/edit | mobile `estimate-create.test.ts`, `estimate-edit.test.ts`; `e2e/estimate-approval-mobile.spec.ts` (skipped: Clerk key) | VERIFIED (logic), STAGING (browser) |

### 2.5 Invoices and payments (QA §5)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Convert accepted estimate → invoice, totals preserved | §4.5 step 1; integration `invoices`, `flow2-money-loop-runthrough` | VERIFIED (runtime) |
| Issue (due date), send by SMS with public token | §4.5 steps 2–3 (202 + `viewUrl`) | VERIFIED (runtime) |
| Record manual payment, `amountDue = total − paid` exact | §4.5 steps 4–5 (33 558 − 10 000 = 23 558) | VERIFIED (runtime) |
| Public pay page, unauthenticated | §4.5 step 6; `e2e/public/invoice-pay-status.spec.ts`, `InvoicePaymentPage.*.test.tsx` | VERIFIED (runtime) |
| Stripe webhook → paid, duplicate-event idempotency, concurrent credit, reversal | `e2e/money-loop/invoice-webhook-paid.spec.ts` (2 passed); integration `invoice-webhook-paid`, `payment-duplicate-race`, `payment-concurrent-credit`, `payment-credit-guards`, `payment-reversal-concurrent`, `deposit-concurrent-credit`, `deposit-credit-atomic`, `webhooks` (CAS claim exactly-one-wins) | VERIFIED (live Stripe STAGING) |
| Refund ledger, late fee idempotency, payment reminders | integration `payment-refunds` (migration 264 backfill), `late-fee-idempotency`, `payment-reminder-dedup`, `record-payment-refund-proposal-flow`, `voice-collections-execution` | VERIFIED |
| ACH, financing (Wisetack), terminal, saved cards | integration `ach-webhook`, `financing`, `customer-payment-methods`; `test/payments/*` (15 files) | VERIFIED (provider legs STAGING) |
| SaaS billing: trial checkout, end trial, lifecycle emails | integration `billing-trial`, `flow1-saas-billing-runthrough`, `lifecycle-emails` | VERIFIED |
| Money reconciliation | integration `money-reconciliation`, `send-claim-ledger` | VERIFIED |

### 2.6 Customer management (QA §6)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Create / read / update / list / archive | §4.2 all 7 steps; integration `customers` | VERIFIED (runtime) |
| Duplicate detection warning on create | §4.2 step 2 (`warnings[]`, name match 0.8) | VERIFIED (runtime) |
| Merge, B2B hierarchy, contacts, groups, tags, custom fields, billing address, payment methods, negotiation context | integration `customer-merge`, `customer-account-type`, `customer-contacts`, `customer-groups`, `customer-tags-custom-fields`, `customer-billing-address`, `customer-parent-lookup`, `customer-negotiation-context`; web `MergeCustomerPanel.test.tsx` + 10 more | VERIFIED |
| Edit page clears a field to empty | §5 step 4 | see §5 |
| Validation errors are structured | §4.11 steps 1–2 | VERIFIED (runtime) |

### 2.7 Leads and intake (QA §7)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Lead CRUD, convert, mark lost | `test/leads/*` (7); integration `leads` | VERIFIED |
| Public intake form → lead | integration `public-intake` (`POST /:tenantId/leads`) | VERIFIED |
| Voice lead capture bucket | voice-quality bucket `03-lead-capture` 7/7 | VERIFIED |
| Leads web pages | no `.test.tsx` for `pages/leads/*`; `e2e/qa-matrix/leads.spec.ts` deployed-only | GAP (web unit), §5 load check |

### 2.8 Jobs and workflow (QA §8)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Create job, transition new→scheduled→dispatched→in_progress→completed with timeline | §4.3 steps 1, 4–7; integration `jobs`, `update-job-execution`, `create-job-execution` | VERIFIED (runtime) |
| Job forms/checklists, custom fields, recurring jobs, per-job profit, time entries, expenses | integration `job-forms`, `job-custom-fields`, `recurring-jobs`, `job-profit.int`, `time-entries-by-job`, `log-time-entry-execution`, `log-expense-job-link`; mobile `job-expenses.test.ts` | VERIFIED |
| Job detail page shows real estimate/invoice/schedule; cancel flow | §5 steps 2–3 | see §5 |
| Thank-you SMS after completion, review request sweep | integration `thank-you-sms-worker` (8 tests incl. exactly-once), `review-request-sweep`, `google-reviews-worker` | VERIFIED |

### 2.9 Voice and telephony (QA §9)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Inbound Twilio webhook fail-closed (unsigned 403), signed → TwiML `<Gather>` | §4.9 | VERIFIED (runtime) |
| Stream-vs-Gather matrix, media-streams WS, disclosure timing, degrade paths | `test/telephony/*` (37 files), `test/voice/*` (35), integration `durable-telephony-timers` (7 tests: restart survival, SKIP LOCKED, ladder), `dropped-call-worker` | VERIFIED (live audio STAGING: Deepgram/ElevenLabs) |
| Recording upload → transcription → classifier → `voice_clarification` proposal, no AI keys | §4.8 (proposal within 1 s) | VERIFIED (runtime) |
| Voice-quality corpus: lookups, booker, lead capture, identity, compliance, hang-ups, out-of-scope, ambiguity, concurrency, adversarial, Spanish | 73/73 scripts, all 11 buckets ≥ threshold, launch gate pass | VERIFIED |
| Voice → create customer / job / estimate / invoice / note / time entry / brand voice / crew | integration `voice-create-customer`, `create-job-execution`, `draft-estimate-execution`, `draft-invoice-execution`, `add-note-voice-execution`, `log-time-entry-execution`, `update-brand-voice-voice-execution`, `crew-voice-execution`, `en-route-voice`, `voice-lookup-answer`, `voice-idempotency`, `voicemail-replay-idempotency`, `voice-proposal-ai-run-link`/`-fk`, `voice-recording-provenance` | VERIFIED |
| Vapi provisioning + webhook signature, onboarding test call | integration `provision-twilio-vapi`, `onboarding-vapi` (bad signature 403) | VERIFIED |
| DNC, consent, STOP/START, cross-channel consent | integration `consent-cross-channel`, `stop-reply-unify`, `outbound-consent-phone-lookup`, `ws3-consent-audit-atomicity`, `sms-suppression.integration`; `test/compliance/*` | VERIFIED |
| Caller identification, phone rate limit, glossary/transcription correction | integration `identify-caller`, `phone-rate-limit`, `transcription-correction`, `glossary-query-limits` | VERIFIED |
| Agent graph paths | 15/15 required paths covered | VERIFIED |
| Real-LLM path smoke | `.github/workflows/agent-path-smoke.yml` (credential-gated) | STAGING |

### 2.10 SMS messaging (QA §10)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Inbound SMS capture, conversation threads, reply send, thread race | integration `inbound-sms-capture`, `conversations`, `conversation-inbox`, `conversation-reply-send`, `conversation-thread-race`, `conversation-links`, `conversation-consent-ordering` | VERIFIED |
| MMS-to-quote | integration `mms-to-quote.int`; `.github/workflows/mms-vision-smoke.yml` (credential-gated) | VERIFIED (vision STAGING) |
| Proposal SMS one-tap approval events | integration `proposal-sms-events` | VERIFIED |
| Marketing campaigns, HFCR weekly send, message templates | integration `marketing-campaigns`, `hfcr-weekly-send-worker`, `message-templates` | VERIFIED |
| Comms inbox UI | `e2e/comms-inbox-mobile.spec.ts` (skipped: authenticated `E2E_BASE_URL`); §5 step 8 load check | STAGING (browser flow) |

### 2.11 Dispatch (operator view) (QA §11)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Feasibility, bookable slots, presence, availability | `test/dispatch/*` (15); integration `dispatch`, `dispatch-availability`, `feasibility-no-technician`, `dispatch-entity-portal-session` | VERIFIED |
| Technician location auth + ping idempotency | integration `technician-location-authz` (6 tests), `technician-location-ping-idempotency` | VERIFIED |
| Dispatch board UI (lanes, conflicts) | web `TechnicianLane.test.tsx`, `ConflictDisplay.test.tsx` + 13 more; §5 step 8 load check | VERIFIED (unit); no e2e drives the board (GAP, §7) |

### 2.12 Reports and analytics (QA §12)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Reports endpoints, money dashboard, revenue-by-source, jobs-booked, voice ROI, activity | integration `reports`, `activity-feed`; `test/reports/*` (10), `test/analytics/*` (7); web `components/reports/*` | VERIFIED |
| Daily digest worker (claim, no-duplicate, opt-out) and reflection sections | integration `daily-digest-worker`, `digest-reflection`, `weekly-feedback-builder`; web `DigestPage.*.test.tsx` | VERIFIED |
| Audit → PostHog forwarding | integration `audit-posthog-forwarding` | VERIFIED |

### 2.13 Settings and configuration (QA §13)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Tenant settings CRUD, defaults, tenant isolation, voice-agent columns, speed-to-lead | integration `settings` (10 tests) | VERIFIED |
| Autonomous booking threshold CHECKs, discount policy CHECKs | integration `settings-autonomous-booking`, `settings-discount-policy` | VERIFIED |
| Vertical packs activation, mirror sync, onboarding pack seed concurrency | integration `onboarding-pack`, `pack-activation-mirror-sync`, `onboarding-pack-seed-concurrency`, `verticals`; `test/verticals/*` (16) | VERIFIED |
| Brand voice capture, cool-down 423, concurrency lock | integration `brand-voice.integration` (5 tests) | VERIFIED |
| Feature flags (lazy table, upsert, arrays, delete) | integration `feature-flags` (7 tests) | VERIFIED |
| Templates, catalog/price book, bundles, standing instructions, maintenance contracts, agreements | integration `templates`, `catalog`, `bundles`, `standing-instructions`, `maintenance-contracts`, `agreements` | VERIFIED |
| Calendar sync, accounting sync (QuickBooks), Google reviews | integration `calendar-sync`, `accounting-sync`, `google-reviews-worker` | VERIFIED (OAuth legs STAGING) |
| Settings web pages (largest web test cluster, 30 files) | `components/settings/*.test.tsx`; §5 step 8 | VERIFIED |
| Supervisor policy default-on / kill switch, supervisor reviews | integration `supervisor-default-on`, `supervisor-reviews` | VERIFIED |
| Onboarding: identity, status, activation, AI check, test-call skip, conversation v2 parity and concurrency | integration `onboarding-identity`, `onboarding-status`, `onboarding-activation` (6), `onboarding-ai-check`, `onboarding-test-call-skip`, `onboarding-conversation`, `onboarding-conversation-parity`, `onboarding-conversation-concurrent-turns` | VERIFIED |
| Onboarding v2 browser journey | `journeys/onboarding-v2*.spec.ts` (skipped: Clerk testing tokens) | STAGING |

### 2.14 Mobile app (QA §14)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Screens, hooks, API client, push, proposals, offline queue, voice capture, messaging, payments terminal | 116 mobile test files / 826 tests, coverage thresholds met | VERIFIED |
| Mobile typecheck (Expo, isolated project) | `npm run typecheck` after `npm ci` | VERIFIED |
| Responsive web at 375 px, ≥44 px tap targets, no horizontal overflow | `e2e/portal-dashboard-mobile.spec.ts` (4 passed); §5 step 10; other 10 `*-mobile.spec.ts` skipped (Clerk) | VERIFIED (partial), STAGING (rest) |
| RN component tests (jest-expo) | intentionally ungated (jest globs Vitest specs) | GAP (known, tracked in `pr-checks.yml`) |

### 2.15 Error handling and edge cases (QA §15)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Structured 400s for invalid bodies | §4.11 | VERIFIED (runtime) |
| Route error boundary, no list flicker on refetch | web `RouteErrorElement.test.tsx`; `e2e/render-stability.spec.ts` (2 passed) | VERIFIED |
| Rate limiting, helmet, request logging, idempotency, stale-executing reset | `test/middleware/*` (6), `test/webhooks/*` (22); integration `reset-stale-executing-timeout-message`, `executor-atomicity-data31`, `executor-audit-atomicity`, `executor-concurrent`, `executor-double-delivery`, `training-asset-transaction-atomicity`, `direct-pool-session-locks`, `migration-advisory-lock`, `queue` | VERIFIED |
| Unmatched `/api/*` route | §4.10: 500 "Frontend assets unavailable" here, 200 HTML when `web/dist` exists | **DEFECT D-1** |

### 2.16 Performance and load (QA §16)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Query indexes used (EXPLAIN) | integration `jobs-audit-tenant-indexes` (5 tests), `migration-099-idempotency-index` | VERIFIED |
| HTTP / mixed 1000-user load, voice load | `loadtest/*.ts`, `voice-load:*` exist, not wired to CI | GAP (manual only) |
| Response-time budgets | none | GAP |

### 2.17 AI and proposal quality (QA §17)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| Never auto-execute: draft → approve → 5 s undo → execute | §4.6 steps 5–10; `test/proposals/*` (114) | VERIFIED (runtime) |
| Clarifications are not approvable (D-004) | §4.6 step 3 (400) | VERIFIED (runtime) |
| Proposal status CAS, find-by-key, cross-tenant never | integration `pg-proposal-update-status-if` (5), `pg-proposal-execution-find-by-key` (5) | VERIFIED |
| Entity resolution, gated reference resolution, chat chains | integration `entity-resolution`, `chat-entity-resolution`, `resolve-entity-money`, `issue-invoice-conversation-resolution`, `entity-alias-rls`; `test/ai/*` (271 files) | VERIFIED |
| Correction loop, lessons, repetition meta-proposal | integration `correction-loop`, `corrections`, `correction-lesson-on-execution`, `correction-repetition-meta-proposal` | VERIFIED |
| Mode switch no bleed, approve-stall, autonomous close chain | integration `mode-switch-no-bleed`, `approve-stall-five`, `autonomous-close-chain` | VERIFIED |
| AI run ledger, cost micro-cents, FK to proposals | integration `ai-runs-cost-micro-cents`, `voice-proposal-ai-run-fk`; `check:fk-paths` | VERIFIED |
| Gateway guard (no direct provider calls) | `check:ai-gateway-guard` | VERIFIED |
| Real-LLM soak (`concurrent-supervisor.md`), assistant reply content | `ENABLE_REAL_LLM_HARNESS=1` opt-in | STAGING |

### 2.18 Security and compliance (QA §18)

| Workflow | Evidence executed | Verdict |
|---|---|---|
| RLS enabled+forced on every table, migration 219 grants revoked | integration `rls-runtime-audit` | VERIFIED |
| Cross-tenant HTTP isolation | §4.7 | VERIFIED (runtime) |
| Webhook signatures (Twilio, Svix/Clerk, Vapi, Stripe) | §4.9; integration `onboarding-vapi`, `clerk-owner-membership`, `webhooks`; `test/webhooks/*` | VERIFIED |
| Log safety (no secrets in logs), deployment secret regression | `lint:log-safety`; `test/security/deployment-secret-regression-3.test.ts` | VERIFIED |
| Corpus PII | `test:pii-leakage` | VERIFIED |
| Dependency audit | `.github/workflows/dependency-audit.yml`; mobile `npm ci` reported 56 advisories (35 moderate, 20 high, 1 critical) | ⚠️ see §7 |

---

## 3. Playwright hermetic tier — spec by spec

Passed (19): `journeys/signup-to-first-estimate.hermetic` (1), `journeys/estimate-approval-execution` (1, pointer), `money-loop/estimate-approve-execute` (2), `money-loop/invoice-webhook-paid` (2), `public/estimate-approval` (2), `public/invoice-pay-status` (1), `no-401-storm` (3), `render-stability` (2), `portal-dashboard-mobile` (4), `smoke` (1 API health).

Skipped (59), all credential-gated by the spec's own guard: `smoke` UI (4), `booking-mobile` (5), `estimate-approval-mobile` (10), `invoice-payment-mobile` (6), `comms-inbox-mobile` (4), `review-response-approval-mobile` (4), `job-scheduling-mobile` (3), `settings-mobile` (3), `onboarding-conversation-mobile` (3), `onboarding-phone-picker-mobile` (3, also `VITE_ONBOARDING_V2_ENABLED`), `technician-phone-mobile` (1), `journeys/onboarding-v2` (7), `journeys/onboarding-v2-conversation` (2), `journeys/signup-to-first-estimate` (2), `journeys/cloud-agent-full-journey` (1), `journeys/invoice-to-payment` (1, permanent skip, superseded by money-loop).

This is exactly the set CI's `e2e.yml` runs on PRs today (it has no Clerk secrets either). The `qa-matrix` project (32 specs, 11 required env vars against a Railway deployment) and `qa-runner` (defaults to Railway URLs) cannot run outside a deployed environment.

---

## 4. API runtime proof (booted `packages/api`, InMemory repos, port 3101)

All 11 workflows passed; full request/response tables are in the run report. Summary of what was observed live:

1. **Identity** — `GET /api/me`: role owner, 27 permissions, mode supervisor, timezone America/New_York.
2. **Customer lifecycle** — create (201), duplicate warning on a similar name, get, update, list, archive (200, hidden from default list).
3. **Job + appointment** — location → job `JOB-0001` (`new`, `no_estimate`) → appointment `scheduled` → transitions new→scheduled→dispatched→in_progress→completed with timeline entries → day-window query returns the appointment.
4. **Estimate money loop** — 15 000 + 2×8 000 = 31 000; tax 825 bps = 2 557.5 → 2 558; total 33 558; sent → accepted.
5. **Invoice money loop** — convert (totals preserved) → issue (30-day due) → send by SMS (202, `viewUrl`) → cash payment 10 000 → `partially_paid`, due 23 558 → public token view unauthenticated shows the same.
6. **Proposal gate** — `voice_clarification` cannot be approved (400, by design) and is rejectable; a `reschedule_appointment` proposal does not mutate on create, does not mutate on approve, mutates only after the 5 s undo window, then reads `executed`.
7. **Tenant isolation** — second tenant: 404 on all four entity types.
8. **Voice pipeline without AI keys** — upload-url → PUT bytes → recordings (202) → `voice_clarification` proposal within 1 s with `[Dev mode]` transcript and confidence 0.2.
9. **Telephony** — unsigned POST 403; HMAC-SHA1-signed POST 200 TwiML with `<Record>` + `<Gather>`.
10. **Unmatched route** — `GET /api/does-not-exist` → 500 `Frontend assets unavailable` (D-1).
11. **Validation** — missing/empty names, bad email, float cents, negative cents all 400 with field-level details.

---

## 5. Web runtime proof (booted SPA in `VITE_AUTH_MODE=dev`, headless Chromium)

Setup: API on :3000 (`NODE_ENV=dev DEV_AUTH_BYPASS=true`, InMemory), Vite on :5173 with the Clerk dev shim, seeded by `packages/api/scripts/verify-seed.mjs` (1 customer, 3 jobs, 2 appointments today incl. one at 23:30 local, 1 estimate with 8 % tax, 1 draft invoice; tenant tz America/New_York). 1280×900 desktop context unless noted; one screenshot per step retained in the session scratchpad. The first pass was discarded because the API process died before the driver started (every page showed connection resets); the API was relaunched detached with a health watchdog, re-seeded, and the whole driver re-run cleanly. All rows below are from the clean run.

| Step | URL | Rendered | Failed `/api` calls (besides the documented `/api/onboarding/status` 503) | Verdict |
|---|---|---|---|---|
| 1 Home, owner | `/` | "Active today: 2" = the two seeded appointments | `503 /api/analytics/jobs-booked` ×2 (D-9) | PASS |
| 2a Jobs list | `/jobs` | JOB-0001/0002/0003 present | none | PASS |
| 2b Job detail | `/jobs/:id` | Estimate, Invoice, Schedule sections show the seeded records | none | PASS |
| 3 Cancel job | More → Customer Canceled → reason → Continue → Confirm | `POST /api/jobs/:id/transition {status:'canceled', reason:'Customer Canceled: Financial reasons'}` → 200; badge "Canceled" after reload | none | PASS |
| 4a Customers list | `/customers` | seeded customer present | none | PASS |
| 4b Clear email | `/customers/:id/edit` → clear → Save | `PUT /api/customers/:id` carried `email:""` → 200; reload shows no email | none | PASS |
| 5 Tenant-tz day | `/schedule` in an `Australia/Sydney` browser context | both appointments, including 23:30, render under "Sun Sep 6" (the New York day) | none | PASS |
| 6a Estimates list | `/estimates` | EST-0001 present | none | PASS |
| 6b Estimate detail | `/estimates/:id` | line items 129 + 135 + 89 render exactly (no float artifacts) **but header, table Total row and "Estimate total" card all show $353 = untaxed subtotal; no Tax row although `taxRateBps=800` and all lines taxable** | none | PASS render / **DEFECT D-7** |
| 7a Invoices list | `/invoices` | INV present | none | PASS |
| 7b Invoice detail | `/invoices/:id` | draft invoice renders | none | PASS |
| 8 Sweep | `/dispatch`, `/inbox`, `/comms-inbox`, `/leads`, `/contracts`, `/reports/money`, `/settings`, `/settings/price-book`, `/settings/templates`, `/assistant`, `/technician/day` | all render, no error boundary | none | PASS ×11 |
| 8 Sweep | `/digest` | renders empty state | `404 /api/digests/latest` (no digest generated yet, expected) | PASS |
| 9 Technician role | second Vite on :5174 with `VITE_DEV_AUTH_ROLE=technician` | home shows "My Schedule" tech view; `/invoices` → server 403 (billing hidden from technicians) but the page shows a generic "Something went wrong" | `403 GET /api/invoices` (correct) | PASS (D-10 UX) |
| 10 Mobile 375 px | `/`, `/jobs`, `/schedule`, `/estimates/:id` | `document.documentElement.scrollWidth === 375` on all four (no horizontal overflow) | — | PASS |

Every page load logged one console error: the realtime socket `ws://…/api/ws?token=<unsigned dev JWT>` is rejected with "HTTP Authentication failed" (D-8). REST calls with the same token succeed, so this is the WebSocket upgrade path not honouring `DEV_AUTH_BYPASS`; it means dispatch presence and live escalations are never exercised under the dev harness.

## 6. Defects and open items

### Found or re-confirmed in this run

| Id | Severity | What | Evidence | Status |
|---|---|---|---|---|
| D-1 (= deferred C-1) | Medium | No JSON 404 for unmatched `/api/*`; the `app.get('*')` SPA catch-all answers instead: 200 HTML when `web/dist` exists, 500 "Frontend assets unavailable" when it does not. Mobile hooks then hit `res.json()` SyntaxError → "Unknown error". | §4.10; `packages/api/src/app.ts` catch-all (~line 7013) | Planned, §7 P1 |
| D-2 | Low | 59 of 78 Playwright tests skip for lack of Clerk credentials even though the repo ships a dev-auth shim (`VITE_AUTH_MODE=dev`) that boots the whole authenticated SPA without Clerk. Ten mobile/UI specs are therefore never exercised in CI. | §3; `packages/web/.claude/skills/verify/SKILL.md` | Planned, §7 P1 |
| D-3 | Low | `docs/QA_LOG.md` still carries the 2026-08-18 manual run (71 %, 🔴 BLOCKED, most areas "0 % auth-blocked", Dispatch "not implemented") which no longer reflects the automated evidence above. | inventory report | Fixed in this PR (`docs/QA_LOG.md` row + scorecard) |
| D-4 | Low | Mobile dependency tree reports 56 advisories (1 critical) on `npm ci`. Root workspace reports 9 (5 high). | web/mobile lane | Planned, §7 P2 |
| D-5 | Low | `corpus:dedup` (600 near-duplicates) and `test:corpus-schema` (legacy `unknown` intents) remain red and `continue-on-error`. | guards lane | Planned, §7 P3 |
| D-6 | Low | Playwright's pinned browser build (1234) does not match the container image (1194); works only via `QA_CHROMIUM_PATH`. Not a product defect; note for the session-start hook. | e2e lane | Planned, §7 P3 |
| D-7 | **High (money display)** | Estimate detail view shows the untaxed subtotal as the estimate total in three places and never renders a Tax row. `EstimatesPage.tsx:1103` computes `total = Σ qty × rate` in floating dollars from the UI line model, ignoring `est.totals.taxCents`/`discountCents`, while the API stores `totalCents` including tax (35 300 subtotal + 2 824 tax = 38 124 for the seeded estimate; the page shows $353). The list view in the same file already uses `totals.totalCents`. Violates "all money integer cents". | §5 step 6b screenshot; API lane §4.4 | **Dispatched, §7 P1-3** |
| D-8 | Medium (harness) | `/api/ws` upgrade rejects the unsigned dev JWT that `DEV_AUTH_BYPASS` accepts on REST, so no realtime feature runs under the dev harness or the planned dev-auth Playwright project. | §5 console errors | Planned, §7 P2-7 |
| D-9 | Low (harness) | `GET /api/analytics/jobs-booked?month=…` returns 503 on InMemory repos; the home page degrades gracefully. Should be documented alongside the onboarding-status 503 or given an in-memory implementation. | §5 step 1 | Planned, §7 P3 |
| D-10 | Low (UX) | A technician opening `/invoices` gets a generic "Something went wrong" instead of a permission message; server gating (403) is correct. | §5 step 9 | Planned, §7 P3 |

### Pre-existing, still open (from `docs/RIVET_DEFERRED_QUEUE.md`, not re-tested here)

C-2 Stripe fetches without timeouts; C-3 dispatch presence routes without async wrapper; C-4 no max wall-clock cap on voice calls; C-5 transcripts lost if the in-memory session is reaped before the recording webhook; C-7 `launch-quality-check.ts` H3/H5 stale paths; C-8 `app.system_lookup` GUC escape-hatch audit; C-9 `estimates (tenant_id, status)` index; C-11/C-12 account-deletion edge cases (product decision).

### Evidence gaps (no automated proof exists)

G-1 Performance budgets and load (loadtest scripts unwired). G-2 Dispatch board browser flow. G-3 Leads web pages have no component tests. G-4 SMS composition UI has no SMS-labelled test. G-5 Mobile offline queue has no browser/e2e proof. G-6 RN component tests (jest-expo) ungated. G-7 Real-provider legs (Clerk sign-in, Stripe Elements, Twilio/Deepgram/ElevenLabs audio, LLM content, QuickBooks OAuth) need the staging runbook in `docs/verification/full-verification-2026-07-02.md` §4 and the credential-gated workflows (`voice-smoke-real`, `agent-path-smoke`, `mms-vision-smoke`, `qa-matrix-gate`, `voice-eval-live`).

---

## 7. Fix plan (Fable orchestrates, worker models execute)

Execution model: Fable 5.1 writes the story, allowed files, and acceptance test for each item; a Sonnet worker (or the local Gemma executor when reachable at `localhost:1234`) implements in an isolated worktree; Fable reviews the diff against Core Patterns and Code Hygiene before merge. Each item is one PR.

### P1 — do now

| # | Item | Allowed files | Acceptance |
|---|---|---|---|
| P1-1 | **JSON 404 for unmatched `/api/*` and `/public/*`** (D-1 / C-1). Mount `app.all(['/api/*','/public/*','/webhooks/*'])` → `404 {error:'NOT_FOUND', message:'Route not found'}` immediately before the SPA catch-all; keep the catch-all for non-API paths. | `packages/api/src/app.ts`, new `packages/api/test/routes/api-404.test.ts`, `docs/RIVET_DEFERRED_QUEUE.md` (close C-1) | Supertest: authenticated `GET /api/nope` → 404 JSON with and without `web/dist`; `GET /some/spa/path` still serves `index.html` when dist exists; API integration + unit suites green; `tsc --project tsconfig.build.json` clean. |
| P1-2 | **Run the skipped UI specs in CI via the dev-auth shim** (D-2). Add a `chromium-devauth` Playwright project that starts vite with `VITE_AUTH_MODE=dev` and the API with `DEV_AUTH_BYPASS=true`, seeds with `scripts/verify-seed.mjs`, and lifts the "needs real Clerk key" guard when the shim is active. Wire into `e2e.yml`. | `playwright.config.ts`, `e2e/helpers/*`, the 10 `e2e/*-mobile.spec.ts` guards, `.github/workflows/e2e.yml`, `packages/api/scripts/verify-seed.mjs` | `npm run e2e` locally with no secrets: previously-skipped mobile specs execute (target ≥ 40 of the 59 skips become passes); `e2e.yml` green; no spec weakened. |
| P1-3 | **Estimate detail total must come from `totals` in integer cents** (D-7). Display subtotal / discount / tax (rate) / total from `est.totals`; when line items are being edited locally, preview in integer cents (Σ `totalCents`, tax = round((taxable − discount) × bps / 10000)) via one pure helper; fix the other `Math.round(qty × rate × 100)` float sites that feed displayed or persisted money. | `packages/web/src/components/estimates/EstimatesPage.tsx`, a totals helper in `packages/web/src/utils` or `packages/shared`, new tests beside them | jsdom test renders "Tax (8.00%)" and $381.24 for a fixture with `taxCents=2824` and never shows $353 as the total; pure test covers zero tax, half-cent rounding, discount, non-taxable line; web vitest and `tsc --noEmit` green. |

### P2 — this sprint

| # | Item | Allowed files | Acceptance |
|---|---|---|---|
| P2-1 | **Dependency advisories** (D-4): `npm audit` root + mobile; upgrade or override the critical and high findings; keep `dependency-audit.yml` green. | `package.json`, `package-lock.json`, `packages/mobile/package*.json` | `npm run check:dependency-audit` passes; all suites green. |
| P2-2 | **QA log refresh** (D-3): add a 2026-09-06 row pointing at this document, correct the Dispatch "not implemented" note, and mark the 2026-08-18 row as environment-constrained. | `docs/QA_LOG.md`, `docs/QA_README.md` | Log row present; health scorecard reflects §2 verdicts. |
| P2-3 | **Dispatch board e2e** (G-2): a hermetic Playwright spec that loads `/dispatch` with seeded technicians and appointments, asserts lanes render and a conflict badge appears for an overlapping pair. | new `e2e/dispatch-board.spec.ts`, `packages/api/scripts/verify-seed.mjs` | Spec passes under P1-2's dev-auth project. |
| P2-4 | **Leads web component tests** (G-3): jsdom tests for `LeadList`, `LeadCreate`, `LeadDetail` covering render, validation, convert-to-customer and mark-lost actions. | `packages/web/src/pages/leads/*.test.tsx` | Web vitest green; ≥70 % line coverage on those files. |
| P2-5 | **Stripe fetch timeouts** (C-2): add `AbortSignal.timeout(…)` to the nine Stripe fetches; unit-test the timeout path with a mocked fetch. | `packages/api/src/payments/stripe-*.ts` + tests | Unit tests prove a stalled fetch rejects within the budget. |
| P2-6 | **Dispatch presence async wrapper** (C-3). | `packages/api/src/dispatch/presence-routes.ts` + test | A thrown handler yields a JSON 500, not a hung request. |
| P2-8 | **Same money-display class as D-7 in the remaining estimate surfaces**: `EstimateDocPreview` (customer preview modal) and `SendEstimateSheet`'s internal rows still sum `qty × rate` float dollars with no tax; the AI-suggestion advisory string does too. Route all three through `computeEstimatePreviewTotals` / `totals`. | `packages/web/src/components/estimates/EstimatesPage.tsx`, `SendEstimateSheet.tsx` + tests | jsdom tests assert the preview modal and send sheet show the taxed total for the D-7 fixture. |
| P2-7 | **WebSocket upgrade honours `DEV_AUTH_BYPASS`** (D-8) so realtime surfaces run under the dev harness and the P1-2 Playwright project; production path unchanged and still refused when bypass is off. | `packages/api/src/**/ws*` auth hook + test | Unit test: bypass on + unsigned JWT → upgrade accepted; bypass off → rejected as today; `/dispatch` under dev-auth shows presence without console auth errors. |

### P3 — backlog

| # | Item |
|---|---|
| P3-1 | Corpus follow-ups (D-5): relabel the legacy `unknown`-intent rows (T6-F03) and add dedup to the utterance generator; flip both `pr-checks.yml` steps to blocking in the same commits. |
| P3-2 | Session-start hook (D-6): symlink or pin `QA_CHROMIUM_PATH` so `npm run e2e` works without manual env. |
| P3-7 | InMemory `analytics/jobs-booked` (D-9) and a permission-specific error state for technician-forbidden pages (D-10). |
| P3-3 | Wire `loadtest/http-load-selfcheck.ts` into a nightly workflow with a p95 budget assertion (G-1). |
| P3-4 | jest-expo config scoped to RN component specs so `test:rn` can gate (G-6). |
| P3-5 | Voice call wall-clock cap (C-4) and transcript persistence before session reap (C-5) — need a design note first. |
| P3-6 | Staging sign-off run of the credential-gated workflows (G-7) once secrets are provisioned in the environment; record results in `docs/QA_LOG.md`. |

---

### Execution status (this session)

| Story | Worker | State |
|---|---|---|
| P1-1 JSON 404 for unmatched `/api/*` | Sonnet, isolated worktree | **merged** as `7ed1cc5` (tsc build, lint, 14 163 API unit tests green; route-manifest snapshot +1 layer; C-1 closed in the deferred queue) |
| P1-2 dev-auth Playwright project | Sonnet, isolated worktree | in progress |
| P1-3 estimate total from `totals` | Sonnet, isolated worktree | **merged** as `c310786` (`computeEstimatePreviewTotals` + 7 unit tests, jsdom test renders "Tax (8.00%)" and $381.24; web suite 2 067 passed; line totals now round unit price to cents before multiplying) |

Fable reviews each worktree diff against Core Patterns / Code Hygiene before merging into `claude/feature-workflow-testing-s8dbhs`.

## 8. How to reproduce this run

```bash
# unit + guards (no Docker)
npm run typecheck && npm run lint && npm test
npx vitest run --root packages/mobile --coverage
npm run check:ai-gateway-guard --workspace=packages/api && npm run check:fk-paths --workspace=packages/api
npm run check:migration-keys --workspace=packages/api && npm run check:env-coverage
npm run agent:graph-coverage --workspace=packages/api -- --gate && npm run test:pii-leakage
cd packages/api && VOICE_QUALITY_ENFORCE_LAUNCH_GATE=true npm run voice-quality && cd ../..

# integration (Docker)
cd packages/api && TEST_DB=testcontainers RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts && cd ../..

# hermetic browser tier (no secrets)
export VITE_CLERK_PUBLISHABLE_KEY='pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA=='
export QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome   # only if the pinned build is absent
npm run e2e

# runtime proofs
# API: packages/api/.claude/skills/verify/SKILL.md ; Web: packages/web/.claude/skills/verify/SKILL.md
```
