# ServiceOS — Codebase Review (2026-06-14)

Full-repo feature-state audit of the canonical product (`packages/api`,
`packages/web`, `packages/shared`) at `HEAD` on branch
`claude/wizardly-curie-q3wddi`. Conducted with parallel deep-dive verification
passes (build/test health, money/payments, proposal/autonomy engine,
collections + owner-SMS channel, voice/AI + resolution, frontend +
settings + comms), each cross-checked against direct inspection. Every
status was verified by tracing real wiring — composition-root registration
in `app.ts`, runtime callers, mounted routes — **not** by trusting code
comments or docstrings. Where a claim could not be confirmed at the cited
line it was re-resolved against `HEAD` and corrected (see §5).

> **Why this doc exists.** It supersedes a prior feature-status audit whose
> launch-critical claims had gone stale: it called the owner SMS channel and
> the collections tail "dead," and flagged three correctness bugs (invoice
> cents render, hardcoded greeting, `/ready` never 503s) — **all of which are
> fixed or wired at `HEAD`** (§5). It also corrects three older docs
> (`codebase-review-2026-05-31.md`, `codebase-readiness-assessment.md`,
> `remaining-features.md`).

## TL;DR

The autonomy core is genuinely **wired and safe**, and the build is **green**.
The proposal/approval engine (16 Zod contracts, no auto-execute path,
mode-aware gate + unsupervised hard-block, 5s undo, advisory-lock
idempotency, HMAC one-tap approve), the money rails (integer-cents backend,
single billing engine, Stripe pay + durable fail-closed webhook
reconciliation, partial payments + refunds), the collections tail
(multi-step dunning + late fees, ledger-gated, hourly leader-locked sweep),
the owner SMS channel (reply-to-approve + proactive `queue_and_sms` owner
SMS), and inbound voice (gateway + CI guard, catalog grounding, entity
resolution, Gather + Media-Streams/Deepgram/ElevenLabs) are all live and
correct.

The real remaining work is **not** "Phase 8 / voice upgrades / UI polish"
(the framing in the older docs). It is three concrete clusters:

1. **A web money-render bug class** — ~30 sites render money with bare
   `.toLocaleString()` on `cents/100` floats, dropping cents, including the
   **customer-facing** estimate-approval page and customer SMS/email totals.
   Only `InvoicesPage` was migrated to the canonical formatter.
2. **Demo-credibility mock-data-in-render** — `AssistantPage` shows a
   hardcoded "$1,850 pending invoice", the post-approval `SuccessScreen`
   shows a fake business + "JOB-1053", and the voice "Add entry" tab fakes
   transcription with a random canned transcript persisted as a real
   activity.
3. **Net-new features that are genuinely absent** — outbound AI calling,
   tips/gratuity, consumer financing, truck inventory (P14), installed
   equipment (P13) — plus a set of dead/orphaned modules to wire or delete.

## Build / test / debt health

- **Production build is green.** `cd packages/api && npx tsc --project
  tsconfig.build.json --noEmit` → **0 errors** (the config Railway deploys).
- **Tests pass.** API unit suite: **7,410 passed / 0 failed** (709 files, 1
  file + 3 tests skipped, 43 todo; ~157s, no DB). Plus **49** Docker-gated
  integration tests, **173** web test files, **41** Playwright e2e specs (up
  from 8 in May). CI (`pr-checks.yml`) runs build-config tsc + web tsc + lint
  + AI-gateway guard + unit + Postgres-testcontainer integration + coverage +
  per-module coverage thresholds; separate workflows run e2e, a QA-matrix
  gate, and four voice-quality suites.
- **Type discipline is high.** API: 17 `as any`, **0** `@ts-ignore`. Web: 2
  `as any`, **0** `@ts-ignore`. 7 `TODO/FIXME` in canonical API source.
- **Multi-tenant isolation.** `schema.ts` declares **92 ENABLE / 91 FORCE
  ROW LEVEL SECURITY / 102 CREATE POLICY** (FORCE parity is effectively
  complete). Pg repos run tenant-scoped through `PgBaseRepository`
  (GUC set + reset, fail-closed); prod/staging crash fast if `DATABASE_URL`
  is missing.
- **Structural debt (unchanged shape, larger).** `db/schema.ts` 4,510 lines;
  `app.ts` **4,296** (the god composition-root, up from 3,365 in May);
  `telephony/twilio-adapter.ts` 2,848; `webhooks/routes.ts` 2,123;
  `workers/voice-action-router.ts` 1,638. Web god-components persist
  (`JobDetail` 1,505, `NewJobFlow` 1,488, `NewEstimateFlow` 1,436).
- **Operational.** Lint is still `tsc --noEmit` (+ an API `lint:log-safety`
  check) — **no ESLint** yet. `npm audit` reports high-severity prod vulns
  (axios `NO_PROXY` bypass, esbuild dev-server) plus moderate/critical
  transitive advisories — mostly `npm audit fix`-able.

---

## 1. COMPLETED & WIRED (bug-free)

Built, reachable, and correct at `HEAD`. Verified by composition-root wiring
and runtime callers.

| Feature | Evidence (file:line) |
|---|---|
| **Proposal engine** — 16 typed Zod contracts (~45 proposal types), all validated at one choke point | `proposals/contracts/` (16 files), `proposals/contracts.ts:405-461,463-527` |
| **Human approval gate** — no auto-execute path; executor refuses anything not `approved`/`executing`; worker only picks up `approved` | `proposals/execution/executor.ts:74-80`, `workers/execution-worker.ts:57-79` |
| **Mode-aware gate + unsupervised hard-block** — thresholds (sup 0.90 / both 0.92 / tech 0.95); unsupervised → `null` threshold (never auto-approve); money/comms/irreversible auto-approve only if capture-class; low-confidence hard-block | `proposals/auto-approve.ts:21-25,76-96,150-159`, `proposals/proposal.ts:289-345,417,427-446`, `supervisor/policy.ts:161-173` |
| **5s undo window** | `proposals/lifecycle.ts:40`, `execution/executor.ts:88-97`, `proposal.ts:624` |
| **Execution idempotency** — `pg_advisory_lock` (SHA-256 key) + atomic `claimForExecution` (approved→executing) | `execution/idempotency.ts:44-59`, `execution/idempotency-lock.ts:27-37`, `pg-proposal.ts:356-366`, wired `app.ts:1451-1458` |
| **One-tap approve** — HMAC-SHA256 token bound to proposal+tenant+nonce, ≤30min TTL, single-use | `routes/one-tap-approve.ts`, `auto-approve.ts:255-365`, mounted `app.ts:1870-1885` |
| **Money backend = integer cents** — single `billing-engine`; `recordPayment` rejects non-integer cents; deposit rule via `applyBps` | `shared/billing-engine.ts:42-70`, `invoices/payment.ts:190-191`, `jobs/deposit-rule.ts:18,60` |
| **Stripe pay + webhook reconciliation** — PaymentIntent (idempotency key) → `checkout.session.completed` → `recordPayment`; durable Pg dedup, **prod fail-closed** (throws if repo absent) | `routes/public-payments.ts:106-115`, `webhooks/routes.ts:1011-1065,200-206`, `webhooks/pg-webhook.ts:47-81` |
| **Partial payments + refunds** — `partially_paid`/`paid` transitions; over-refund invariant enforced | `routes/payments.ts:50-62`, `invoices/payment.ts:247-259`, `webhooks/routes.ts:1615,1751` |
| **Collections: multi-step dunning + late fees** — per-step `send_payment_reminder` + `apply_late_fee` proposals, ledger-gated on `UNIQUE(...)` via `23505`; hourly `runAsLeader` sweep | `workers/overdue-invoice-worker.ts:226-301,310-321`, `proposals/execution/apply-late-fee-handler.ts` (registered `handlers.ts:830`), `db/schema.ts:3532`, sweep `app.ts:3819-3844` |
| **Owner SMS: reply-to-approve** — APPROVE/REJECT/EDIT keyword handler registered with real repos + LLM edit interpreter | `proposals/sms/reply-handler.ts:564-569`, registered `app.ts:1301-1316` |
| **Owner SMS: proactive `queue_and_sms`** — sender reads tenant routing + owner phone, mints one-tap token, calls `sendSms` for unsupervised proposals | `workers/voice-action-router.ts:1305-1310,1562-1565`, `auto-approve.ts:518-591`, config `app.ts:1700-1716` |
| **SMS compliance** — STOP/START opt-out/opt-in (START upgraded to YES opt-in composite) | `app.ts:772-773`, `compliance/stop-reply.ts` |
| **LLM gateway + CI guard** — all AI routes through `ai/gateway`; CI guard blocks the OpenAI SDK surface outside gateway/providers | `ai/gateway/`, `scripts/check-ai-gateway-guard.sh`, `pr-checks.yml:39-40` |
| **Catalog grounding (create/draft path)** — exact/high match overwrites LLM price with catalog cents; uncatalogued lines capped at 0.85 (< 0.9 auto-approve) | `ai/resolution/catalog-resolver.ts:64,374-416`, `ai/tasks/invoice-task.ts:174-203`, `estimate-task.ts:114-134`, repo supplied `workers/voice-action-router.ts:396-397` |
| **Entity resolution on voice** — `PgEntityResolver`; ambiguity → `voice_clarification` (no silent guess) | `ai/resolution/entity-resolver.ts`, `app.ts:1688`, `workers/voice-action-router.ts:599-622,744,1041-1062` |
| **Inbound voice (two paths)** — always-on Twilio `<Gather>` + opt-in Media Streams (Deepgram STT + ElevenLabs/OpenAI TTS) behind `TWILIO_MEDIA_STREAMS_ENABLED` | `telephony/twilio-adapter.ts`, `voice/transcription-providers.ts:259`, `telephony/media-streams/`, mounted `app.ts:~2465,~2814` |
| **Customer-calling FSM (inbound + in-app)** — channel-agnostic state machine driven by inbound telephony + in-app SSE | `ai/agents/customer-calling/state-machine.ts`, `twilio-adapter.ts:796,1363`, `inapp-adapter.ts:280` |
| **AI provider health** — `GET /api/health/ai` from circuit-breaker registry | `routes/ai-health.ts`, mounted `app.ts:665` |
| **Health / readiness probe** — DB check returns `'down'` on failure; `/ready` 503s on `'down'`; `/health` stays 200 for liveness | `app.ts:631-644`, `health/health.ts:48-61` |
| **Memberships engine (P9-003)** — recurrence → job + draft invoice (idempotent, leader-locked), auto-renew, member pricing (manual paths), priority booking, off-session dues auto-charge | `agreements/agreement-service.ts:391-458,554-605`, `workers/recurring-agreements-worker.ts:56-110`, `app.ts:3617-3638`; pricing `routes/estimates.ts:159-205`, `routes/invoices.ts:105-152`; dues `agreements/dues-collector.ts:82-152` |
| **QuickBooks Online (real OAuth + sync)** — Intuit auth URL, token exchange against real Intuit endpoint, sync sweep + Pg sync-log; env-gated | `integrations/accounting/quickbooks-oauth.ts:17,26,49-85`, `routes/integrations.ts:60-200`, mounted `app.ts:2096,3227`, sweep `runAccountingSyncSweep` (`app.ts:1602`) |
| **Public booking** — real availability + held-appointment booking + non-auto `create_booking` proposal under advisory lock; mobile-hardened | `components/customer/BookingPage.tsx`, `routes/public-booking.ts:184-391`, mounted `app.ts:1964-1989`, `e2e/booking-mobile.spec.ts` |
| **Estimate approval (public, mobile)** — version-locked approve, server-side total recompute (client total never trusted), tiers, revision polling | `components/customer/EstimateApprovalPage.tsx:531-1107`, `estimates/public-estimate-service.ts:226`, mounted `app.ts:1863`, `e2e/estimate-approval-mobile.spec.ts` |
| **Home greeting + dashboard** — `homeGreetingHeading(ownerName, now, tz)` (real Clerk name + time-of-day); all dashboard metrics from real `/api/...` queries | `components/home/HomePage.tsx:272-287,333`, `utils/greeting.ts:36-57` |
| **Settings (mostly wired)** — 16 rows wired to real sheets/routes/APIs (business profile, price book, templates, AI approval rules, operator hours, call routing, DNC, payment methods, deposit rules, billing portal, calendar sync, QuickBooks…) | `components/settings/SettingsPage.tsx:342-423` |

---

## 2. COMPLETED BUT HAS KNOWN BUGS

Built and reachable, but with a specific correctness/credibility defect.

| Bug | Cite | Severity |
|---|---|---|
| **Web money render drops cents** — ~30 sites render money via bare `.toLocaleString()` on `cents/100` floats (no fraction digits), so `$1,234.50 → "$1,234.5"` and `$1,200.00 → "$1,200"`. **Customer-facing**: estimate-approval line items + add-ons, and customer SMS/email totals. Owner-facing across estimates/jobs/home. Only `InvoicesPage` was migrated to the canonical `formatCurrency`. `EstimateApprovalPage` even *defines* a correct `fmtUsd` helper it then bypasses. | `components/customer/EstimateApprovalPage.tsx:904,933` (helper at `:15-16`), `components/estimates/NewEstimateFlow.tsx:1103-1104` (customer SMS/email), `components/estimates/EstimatesPage.tsx:425,426,446,560,655,929,1058`, `components/jobs/JobDetail.tsx:485,486,493`, `components/estimates/ConvertToInvoiceSheet.tsx:120,146,153`, `components/home/HomePage.tsx:374,585` | **High** (money correctness, customer-visible) |
| **AssistantPage renders hardcoded mock metrics as live state** — a "$1,850 pending invoice / 3 active jobs / 2 items need attention / 2 jobs tomorrow" context strip, plus fake customer names ("Rodriguez", "Thompson", "Davis") in suggestion chips. | `components/assistant/AssistantPage.tsx:44-49,52-59` (rendered ~`:938-998`) | **Medium-High** (demo credibility) |
| **Post-approval `SuccessScreen` shows a fake business + job number to the customer** — after a real approval, the confirmation screen hardcodes `jobNumber = 'JOB-1053'`, "Fieldly Pro Services / Austin, TX / (512) 555-0000 / info@fieldly.pro", and accepted date "March 10, 2026". The approval action itself is real; the receipt the customer sees is fake. | `components/customer/EstimateApprovalPage.tsx:319,347-528,358,371-376,447,509-515` | **Medium** (customer-visible wrong identity) |
| **Customer comms timeline is dead end-to-end** — `CommunicationTimeline` is rendered on the customer detail page and calls `GET /api/customers/:id/timeline`, but that route is gated behind an optional `timelineDeps` arg that is **never passed** at the composition root, so the endpoint is never registered → the panel hits a 404. | web `pages/customers/CustomerDetail.tsx:468` (routed `routes.ts:167`); backend gated `routes/customers.ts:201-240`, built without deps `app.ts:3011` | **Medium** (broken feature, looks wired) |
| **Voice "Add entry" tab fakes transcription** — the voice path waits 1.6s then injects a random hardcoded transcript from `MOCK_TRANSCRIPTS`, which is then submitted and persisted as a real job activity. No STT call on this path. | `components/jobs/AddEntrySheet.tsx:12-16,55` | **Medium** (fake data persisted) |
| **"Encrypted transcripts" is overstated** — the canonical call transcript and per-turn rows are stored as sanitized **plaintext** (RLS-protected, not encrypted at rest); only the optional raw-provider retention blob is AES-256-GCM encrypted. An in-code comment claims AES-256-GCM is the at-rest control, which overstates coverage. | `workers/transcription.ts:240-241,74-92`, `voice/pg-call-transcript-turn.ts:70-84`, `db/schema.ts:1519+`; comment `ai/tasks/proposal-approval-task.ts:12` | **Low-Medium** (security posture vs. claim) |
| **Hardcoded business identity in customer-facing estimate preview/PDF** — owner's estimate preview + generated PDF hardcode "Rivet Pro Services / Austin, TX · (512) 555-0000" instead of tenant settings. | `components/estimates/EstimatesPage.tsx:495-496,518,520` | **Low-Medium** (customer-visible) |

---

## 3. PARTIAL

Core is built and reachable; a meaningful piece is missing or unrouted.

| Feature | What works | What's missing | Cite |
|---|---|---|---|
| **Memberships / agreements — owner web UI** | The full P9-003 engine (recurrence, renewal, member pricing, priority booking, off-session dues) is wired in prod; customer-portal read path is real | The real owner create/manage UI (`pages/agreements/*`) is **not registered in `routes.ts`**; the only routed owner UI is `MaintenanceContractsPage`, backed by an **in-memory `Map`** (`/api/maintenance-contracts`) with no recurrence/renewal/dues — lost on restart | engine `agreements/`; orphaned UI `pages/agreements/AgreementCreate.tsx` (absent from `routes.ts`); stub `routes/maintenance-contracts.ts:40`, routed `routes.ts:179-180` |
| **Member pricing coverage** | Applied on manual estimate/invoice creation | **Not** applied on worker-generated recurring invoices | `routes/estimates.ts:159`, `routes/invoices.ts:111` vs. `agreement-service.ts:391-458` |
| **AI suggest-reply (comms)** | Backend is real and draft-only (human sends), routed through the gateway and mounted | Web client (`suggestReply`) is consumed only by `useConversationDraft.ts`, which **no routed component renders** → orphaned UI | `routes/conversations.ts:92-126`, mounted `app.ts:3398-3403`; web `api/conversations.ts` → `hooks/useConversationDraft.ts` |
| **Cross-channel triage inbox** | A customer-timeline aggregator exists backend-side; per-customer `CommunicationTimeline` is rendered | No dedicated comms triage **inbox** surface; the only "Inbox" (`InboxPage`) is the proposal/approval queue, not message triage | `components/inbox/InboxPage.tsx` → `/api/proposals/inbox` |
| **Settings** | 16 rows wired end-to-end | 3 `Coming soon` stubs: Roles & permissions, Reminders & follow-ups, Zapier (+ a dead "Service area" row) | `components/settings/SettingsPage.tsx:353,384,429,759-770` |
| **Web estimate AI generation** | Real `/api/estimates/suggest` path with catalog grounding | A client-side mock generator with **fabricated, uncatalogued prices** fires as a fallback when the API returns non-OK/empty — bypasses catalog grounding | `components/estimates/NewEstimateFlow.tsx:160-184` |
| **In-call autonomous booking** | Inbound voice books via a `create_appointment`/`create_booking` proposal | Auto-approval requires `supervisorPresent`, which a 1–5-person shop lacks → every booking waits for a human tap (competitive-gap R1) | `proposals/auto-approve.ts`, `ai/tasks/create-appointment-task.ts` |

---

## 4. STUB / DEAD / NOT BUILT

Placeholder, zero-caller, or confirmed absent. (Per CLAUDE.md "remove dead
code as part of every change," the DEAD rows below are deletion/wiring
candidates.)

| Feature | State | Cite |
|---|---|---|
| **Outbound AI calling** | ABSENT — no `calls.create`/origination anywhere in API source | grep over `packages/api/src` → 0 non-test hits |
| **Outbound TCPA/DNC consent gate** | DEAD — `checkOutboundConsent`/`recordCustomerConsent` have zero callers (gates outbound calling, which doesn't exist). The DNC *list* itself IS used for SMS STOP/START suppression | `voice/outbound-consent.ts` (only ref is a doc comment `routes/dnc.ts:14`); DNC list live at `app.ts:772-773,3404` |
| **Tips / gratuity at checkout** | ABSENT — no tip/gratuity field on the payment side | grep `gratuity|tip` over `payments/`,`invoices/`,`webhooks/` → 0 |
| **Consumer financing (Wisetack/Affirm)** | ABSENT | grep → 0 |
| **Truck inventory (P14) / installed equipment (P13)** | ABSENT in code (specced in `docs/stories/`) | — |
| **Tech-status OUT/SICK SMS keyword handler** | DEAD — `registerTechStatusKeywords` is never called in `app.ts`; inbound "OUT"/"SICK" falls through to `no_matching_handler` | defined `sms/tech-status/index.ts:45`; 0 non-test callers |
| **Owner-cell-patch SMS sender** | DEAD — `patchToOwnerCell`/`handleOwnerDialResult` have no production caller (test + sprint doc only) | `voice/triage/owner-cell-patch.ts:166,223` |
| **Voice-approval readback (partial)** | `classifyVoiceApproval` is WIRED; `isVoiceApprovable` + `buildReadbackScript` are DEAD (test-only) | wired `ai/tasks/proposal-approval-task.ts:67,1118,1309`; dead `ai/tts/readback.ts:19,53` |
| **Proposal-outcome analytics** | DEAD — `recordOutcome`/`getAnalyticsSummary` have zero non-test callers; in-memory repo only, not constructed in `app.ts` | `proposals/analytics.ts` |
| **Named Stripe reconciler** | DEAD — `reconcilePayment` has zero callers (the live path is `recordPayment` in the webhook handler) | `payments/invoice-payment-reconciler.ts:12` |
| **`JobSheets` Estimate/InvoiceSheet** | DEAD/BROKEN — import the **mock** `estimates`/`invoices` arrays and `.find()` by id; rendered from real `JobDetail` with real UUIDs → always misses → silently empty (a live mock-data import in a prod component) | `components/jobs/JobSheets.tsx:7,189,233`, rendered `components/jobs/JobDetail.tsx:1449-1451` |
| **`NewJobFlow` VOICE_SAMPLES** | DEAD — defined, never referenced | `components/jobs/NewJobFlow.tsx:121-126` |

---

## 5. STALE-CLAIM CORRECTIONS

Lines in prior docs that are now wrong at `HEAD`.

| # | Stale claim (source) | Correction (cite) |
|---|---|---|
| 1 | Prior feature-status audit: owner SMS channel ("reply-to-approve absent", "proactive owner SMS has no sender", "voice-approval zero runtime callers") and collections tail ("multi-step dunning dead", "late fees dead") are the launch-critical **dead** zones | **Inverted at HEAD.** Reply-to-approve registered (`app.ts:1301`), proactive `queue_and_sms` sender live (`voice-action-router.ts:1305-1310`), `classifyVoiceApproval` wired (`proposal-approval-task.ts:67`), dunning cadence + late fees fully wired (`overdue-invoice-worker.ts:226-301`). All in §1 now. |
| 2 | Prior feature-status audit §2: three correctness bugs — invoice cents render, hardcoded "Good morning, Mike", `/ready` never 503s | **All fixed.** `InvoicesPage` uses `formatCurrency`/`centsToDisplay` (`utils/currency.ts:38-45`); greeting is `homeGreetingHeading(...)` (`HomePage.tsx:333`); DB check returns `'down'` → `/ready` 503s (`app.ts:641`, `health/health.ts:54`). (Note: the *cents* bug class survives on other pages — see §2 row 1.) |
| 3 | Prior feature-status audit §4: QuickBooks is a "live UI mock (`setTimeout` + fake #8821)" | **Stale.** Replaced by a real Intuit OAuth + sync integration (`integrations/accounting/quickbooks-oauth.ts`, mounted `app.ts:2096,3227`). Now §1. |
| 4 | `codebase-review-2026-05-31.md:33` — RLS "74 ENABLE + 73 FORCE + 83 CREATE POLICY"; `:71-74` — webhook idempotency store is in-memory (multi-instance hole); `:66` — no ESLint | RLS is now **92 / 91 / 102**; webhook dedup is durable Pg, **prod fail-closed** (`webhooks/routes.ts:200-206`). The "no ESLint" note still holds (lint = `tsc` + log-safety). |
| 5 | `codebase-readiness-assessment.md:34-38,70,53` — remaining gap is "Phase 8 + voice provider upgrades + 13 settings stubs"; QuickBooks/Zapier "deferred" | **Stale framing.** Real-time voice (Deepgram/ElevenLabs/Media Streams) is built (§1); settings are down to **3** stubs; QuickBooks is no longer deferred (real OAuth+sync). The "85% built / 70% ready" verdict understates `HEAD`. |
| 6 | `remaining-features.md` (2026-04-29) — headline remaining work is Deepgram Nova-3 + ElevenLabs streaming providers and the Phase-8 calling agent | **Stale.** Both streaming providers are built and wired; the inbound calling agent is live. The genuine absence is **outbound** call origination (§4), not the providers. |
| 7 | `competitive-gap-analysis.md` (2026-06-10, otherwise accurate) — G2: QuickBooks "Connect" is a "mocked `setTimeout` — no OAuth or sync behind it" | Stale on QuickBooks (real OAuth+sync now). Its R1 (in-call autonomous booking) and R2 (catalog-priced voice **invoice-edit** path) remain valid gaps; this audit confirms catalog grounding is wired on the *create/draft* path but did not separately re-verify the invoice-edit path. |

---

## Net headline

The autonomy/approval core, money rails, collections tail, owner SMS
channel, inbound voice, multi-tenant isolation, and the public
customer surfaces are genuinely **wired and correct** — the launch-critical
plumbing the older docs framed as missing is in place. What remains is
concentrated and unglamorous: a **web money-render bug class** that still
drops cents on customer-facing pages (only `InvoicesPage` was fixed), a
handful of **mock-data-in-render credibility landmines** (`AssistantPage`
"$1,850", the post-approval `SuccessScreen`, the faked voice-entry
transcript), two **wired-looking-but-dead** seams (customer timeline endpoint,
orphaned agreement UI), and a clear list of **genuinely-absent net-new
features** (outbound calling, tips, financing, truck inventory, equipment).
Several **dead modules** (outbound-consent gate, tech-status keywords,
owner-cell-patch, proposal analytics, the named Stripe reconciler, mock-data
`JobSheets`) should be wired or deleted per the code-hygiene rule.

## Recommended next steps (ranked)

1. **Kill the web cents bug class.** Route every money render through the
   canonical `formatCurrency`/`centsToDisplay` (operate on integer cents, not
   `cents/100` floats). Start with customer-facing: `EstimateApprovalPage`
   line items/add-ons + `NewEstimateFlow` SMS/email totals, then the
   owner-facing estimate/job/home sites. Pin with a class-contract test.
2. **Remove the demo-credibility mock data.** `AssistantPage` context strip →
   real `/api/...`; `EstimateApprovalPage` `SuccessScreen` → real job number +
   tenant identity; `AddEntrySheet` voice tab → the real STT path (or hide it).
3. **Fix the two dead-but-wired seams.** Pass `timelineDeps` so
   `/api/customers/:id/timeline` registers; route the real `pages/agreements/*`
   UI (and retire the in-memory `maintenance-contracts` stub) or wire its
   create path to the real engine.
4. **Decide the net-new features deliberately** — outbound calling (+ activate
   the dead TCPA/DNC gate), tips, financing, truck inventory (P14), equipment
   (P13) — these are scoped stories, not polish.
5. **Hygiene** — delete the §4 DEAD modules; add ESLint; `npm audit fix` the
   non-breaking vulns; continue decomposing `app.ts` (4,296 lines).
