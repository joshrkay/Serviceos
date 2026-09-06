---
title: "Competitive feature audit — Rivet vs ServiceTitan, Jobber, Housecall Pro, Workiz, Avoca"
date: 2026-09-06
status: research
supersedes: docs/competitive-review-rivet-vs-jobber-2026-07-02.md (verdict table), docs/competitive-gap-analysis.md §5
companions: appendix-a … appendix-h in this folder; docs/verification/full-verification-2026-09-06.md
tags: [competitive-analysis, feature-inventory, verification-plan, jobber, servicetitan, housecall-pro, workiz, avoca]
---

# Competitive feature audit — 2026-09-06

**Three questions this answers.** (1) What is our complete feature set, workflow by
workflow, with the code that proves each one exists and its real status? (2) How do we
stack up against the top five competitors, row by row, and where are we behind? (3) How
do we verify that every claim in here — ours and theirs — is actually true?

**Frame.** The ICP is the owner-operator shop with 1–3 trucks and no office staff
(`docs/PRD.md` §2). The competitive set is the four field-service platforms that shop is
choosing between (ServiceTitan, Jobber, Housecall Pro, Workiz) plus the AI-receptionist
category leader (Avoca), because we are sold as both. Anti-personas (12-truck dispatch
shops, franchises) are not optimised for, so rows that only matter to them are marked
`n/a` rather than counted as gaps. Notable exclusions: FieldEdge and Service Fusion
(HVAC-specific and mid-market; neither adds a capability class the five do not cover).

## 0. Bottom line

1. **The product is far more complete than its own docs say — again.** 320+ backend
   capabilities, 70+ operator screens, 8 public customer surfaces, and 53 proposal types
   are shipped and mostly proven by automated gates. Three "gaps" the API inventory
   reported (no e-signature, no ACH, no good/better/best selection on the public
   estimate) are wrong; the code has all three (§1.4, §4.1). Treat every gap list in this
   repo older than this document as suspect in both directions.
2. **Where we lead is structural, not feature-count:** the trust architecture (typed
   proposals, approval, 5-second undo, audit, catalog-grounded prices, clarification
   instead of guessing), in-call grounded quoting, photo-to-quote, life-safety triage,
   dropped-call recovery, the consent ledger, the correction-learning loop, and one flat
   price. No competitor shows evidence of the first item, and it is the one they cannot
   copy in a release.
3. **Where we are behind the ICP's expectations (Tier 1, §3.1):** the AI answers but,
   by default, *queues* instead of *books*; inbound texts and web chat are drafted, not
   answered; no Google Local Services / Reserve-with-Google / Thumbtack lead ingestion;
   no week or month calendar, no map, no live "track my tech" link; QuickBooks is
   one-way and manual; no data import from Jobber or Housecall Pro; no tips or instant
   payout. Every one of these is table stakes on all four FSMs' entry or mid tiers.
4. **Where we are behind but should stay behind (won't-build, §3.3):** route
   optimisation, a campaign builder, postcards, inventory and purchase orders, payroll,
   franchise roll-up, human-CSR coaching, per-seat pricing. These are the anti-persona's
   needs and the competitors' upsell treadmill.
5. **Verification is the real deliverable.** Today's merged run
   (`docs/verification/full-verification-2026-09-06.md`) proves the automated layer end
   to end. What it cannot prove — and what no run without credentials can — is the
   live-provider layer: a real call on a real number through the realtime transport, a
   real card and a real ACH debit, QuickBooks OAuth, Wisetack, Google Business, Vapi.
   Those legs are blocked on the same secrets as PR #975's U3/U4 operator work. §4 gives
   the claim ledger, the exact gates, and the staging scripts; §4.2 gives the plan for
   verifying the competitor rows, all of which were built from search excerpts because
   this sandbox's egress proxy blocks every vendor and review site.

## 0.1 Method and confidence

- **Our side (code wins over docs).** Three read-only agents inventoried `packages/api`
  (85 mounted routers, 123 layers, every domain directory), the AI/voice/telephony
  stack, and `packages/web` + `packages/mobile` + public surfaces. Full tables with
  evidence paths are Appendices A–C. Status vocabulary used everywhere below:
  **Shipped** (wired and reachable), **Env-gated** (shipped, no-ops or 503s without a
  credential), **Flagged-off** (shipped, per-tenant or platform flag defaults off),
  **Partial** (one half of the loop), **Dormant** (code with no production caller).
- **Their side (search excerpts, not page reads).** Five agents researched one
  competitor each. Direct fetches of servicetitan.com, getjobber.com, housecallpro.com,
  workiz.com, avoca.ai, help centres, G2, Capterra and Trustpilot were all blocked by
  the sandbox proxy, so every competitor row is built from search-engine excerpts of the
  cited page. Rows the agent could not corroborate are marked `?`. Pricing is the most
  fragile category: Jobber's Receptionist is $29/mo per its help centre but $99/mo on
  several third-party pages; Workiz publishes no prices at all. §4.2 is the plan to
  replace excerpts with captured pages.
- **Disputes resolved by reading the code.** Where two inventories disagreed, the
  tie-break was a direct grep (§4.1 item A5): signature capture
  (`routes/public-estimates.ts:9`, `public-estimate-service.ts:394`), tier selection
  (`public-estimate-service.ts:186,328-351`), ACH (`payments/stripe-payment-intent.ts:87`
  with `us_bank_account` and `ach_return` handling in `webhooks/routes.ts`).
- **Prior art folded in, not repeated.** The 2026-07-02 Jobber review's 27-row scorecard
  and the 2026-06-21 Avoca parity tracker are the ancestors of §2; their verdicts were
  re-checked against current code, and the rows that moved are called out inline.

## 1. Our feature set — complete inventory by workflow

The full tables (Appendices A–C) run to ~600 rows. This section is the workflow-level
view: what a shop can actually do, end to end, and the evidence anchor for each.
Evidence paths are repo-relative under `packages/api/src` unless noted.

### 1.1 The phone rings (inbound AI receptionist)

| Capability | Status | Evidence |
|---|---|---|
| 24/7 AI answers the tenant's Twilio number; greeting, persona, recording disclosure (state-aware two-party copy), AI-identity disclosure | Shipped | `routes/telephony.ts`, `ai/skills/disclose-recording.ts`, `disclose-ai-identity.ts` |
| Two transports: turn-based `<Gather>` (default) and realtime Media Streams with Deepgram STT, ElevenLabs TTS, barge-in, filler audio, mid-call degrade back to Gather on the same session | Shipped; realtime **Flagged-off** in prod (`TWILIO_MEDIA_STREAMS_ENABLED`) | `telephony/twilio-adapter.ts`, `telephony/media-streams/mediastream-adapter.ts`, `telephony/twilio-call-redirect.ts` |
| Caller identified from caller-ID (0/1/N outcomes), B2B / property-manager hierarchy loaded, membership context injected, unknown callers become leads | Shipped | `ai/skills/identify-caller.ts`, `ai/agents/customer-calling/b2b-account-context.ts`, `ai/skills/find-or-create-lead.ts` |
| 100+ typed intents with confidence floor; vertical-aware prompts (HVAC, plumbing, electrical, painting); two-intents-in-one-sentence decomposition; STT keyword boost from catalog and names | Shipped | `ai/orchestration/intent-classifier.ts`, `verticals/*`, `ai/orchestration/transcript-decomposer.ts`, `voice/tenant-glossary-provider.ts` |
| Booking: deterministic date resolution in tenant timezone, feasibility-checked slot, tentative hold, `create_appointment` proposal; reschedule, cancel, confirm; slot-taken-mid-call handled | Shipped | `ai/scheduling/resolve-datetime.ts`, `place-hold.ts`, `ai/voice-turn/inbound-booking-completion.ts`, corpus `02-happy-booker`, `09-concurrency` |
| Autonomous booking lane: confident bookings auto-approve with instant customer confirmation and an owner UNDO SMS | **Flagged-off** per tenant (`autonomous_booking_enabled` default false; platform kill switch) | `proposals/autonomous-lane.ts`, `routes/one-tap-undo.ts` |
| In-call grounded quoting: prices read back only when every line matched the tenant catalog; post-quote "yes book it / make it two" handled deterministically | Shipped | `ai/voice-turn/quote-readback.ts`, `post-quote-precheck.ts`, `ai/resolution/catalog-resolver.ts` |
| ~25 read-only lookups (appointments, balance, invoices, jobs, agreements, availability, revenue, job profit, crew schedule, digest…) | Shipped | `ai/skills/lookup-*.ts`, `workers/voice-lookup-answer.ts` |
| Spanish: detection on first utterance, mid-call switch, ES TTS and templates, Deepgram reopened in ES | Shipped (en/es only) | `ai/orchestration/language-detector.ts`, `ai/i18n/*`, corpus `11-spanish` |
| Emergency: deterministic keyword interrupt (including interim transcripts), E1/E2/E3 tiering, 911 script first, durable owner page-retry ladder, `emergency_dispatch` urgent job + hold | Shipped | `ai/agents/customer-calling/emergency-detector.ts`, `emergency-tier.ts`, `telephony/emergency-page-retry.ts` |
| Vulnerable-caller grading and owner-cell patch with a non-clinical whisper preface | **Flagged-off** per tenant (`voice_vulnerability_triage`) | `vulnerability-grader.ts`, `voice/triage/owner-cell-patch.ts` |
| Frustration keyword + LLM sentiment escalation | Flagged per tenant (escalation settings) | `frustration-detector.ts`, `sentiment-classifier.ts` |
| Escalation to a human: on-call rotation cascade, warm transfer with templated whisper + context SMS, single-line transfer with spoken callback capture, dispatcher live panel over SSE | Shipped (outcome-recording route is **Dormant**: always 200) | `ai/skills/escalate-to-human.ts`, `oncall/rotation.ts`, `telephony/whisper-route.ts`, `escalations/events-route.ts`, `escalations/outcome-route.ts` |
| After-hours: voicemail with transcription → lead, or AI answering (per-tenant mode); subscription/trial gates fall to voicemail with a reason | Shipped | `telephony/voicemail-status-route.ts`, `voice/voice-gate.ts` |
| Guardrails: negotiation refusal → owner callback proposal; complaint capture; DNC terminate; prompt-injection detection with lifetime `untrusted` provenance; per-session cost cap; wall-clock cap (15 min) with spoken wrap-up; low-STT-confidence ladder | Shipped | `proposals/guardrails/*`, `compliance/dnc.ts`, `ai/untrusted-content.ts`, `ai/skills/session-cost-tracker.ts` |
| Recording: whole-call to S3, pause on "stop recording" objection, retention purge, per-turn transcript persistence with recording attach, encryption at rest, end-of-call summary, transcript → RAG chunks | Shipped (RAG retrieval **Flagged-off**, not on the live-call path) | `telephony/recording-webhook.ts`, `recording-transcript-hook.ts`, `workers/transcript-ingestion-worker.ts` |
| Dropped-call SMS recovery 60 s after a dropped/failed session, suppressed if resolved, reply threads back to the intake | Flagged per tenant | `sms/recovery/*`, `workers/dropped-call-worker.ts` |
| Consent: append-only ledger, disclosure-before-capture ordering, mid-call SMS consent capture, STOP/START unification across channels | Shipped | `compliance/consent-events.ts`, `compliance/stop-reply.ts` |
| Alternate provider: Vapi assistant per tenant | **Env-gated** (`VAPI_API_KEY`) | `integrations/vapi/*` |

### 1.2 The owner directs (assistant, approvals, learning)

| Capability | Status | Evidence |
|---|---|---|
| Proposal-first invariant: the AI never writes operational data; five action classes (capture / comms / money / irreversible / manual); 53 proposal types with Zod contracts; ~40 idempotent execution handlers; chains | Shipped | `proposals/*`, `packages/shared/src/contracts/proposal-action-class.ts` |
| Approval surfaces: web inbox (one-tap approve with 5 s undo, batch approve ≥0.8, inline edit, reject with reason), mobile Approvals, SMS reply (Y/N/EDIT), HMAC one-tap link, voice on an owner line with readback + strict confirm + spoken PIN for money classes, voice batch walk-through | Shipped | `components/inbox/InboxPage.tsx`, `proposals/sms/reply-handler.ts`, `routes/one-tap-approve.ts`, `ai/tasks/proposal-approval-task.ts` |
| Auto-approve thresholds by supervisor mode (0.90 / 0.92 / 0.95), per-tenant override, unsupervised routing to SMS | Shipped | `proposals/auto-approve.ts`, `threshold-resolver.ts` |
| Assistant chat (typed or dictated): same handler registry as phone; honest-failure guard; entity resolution with one clarification question; chain drafting; `en_route` direct act | Shipped (in-app voice session has no live mic; memo is record-then-poll) | `routes/assistant.ts`, `ai/orchestration/assistant-honesty-guard.ts`, `routes/voice-sessions.ts` |
| Standing instructions ("always add a $79 diagnostic fee"): ≤20 active, injected as a delimited system message, model's claimed applications intersected with reality | Shipped | `instructions/*`, `ai/standing-instructions-context.ts` |
| Correction loop: owner edits become structured lessons cascaded into settings, catalog, brand voice; repetition → meta-proposal; undo reverses | Shipped | `learning/corrections/*` |
| Entity aliases ("the Henderson place") learned, proposal-gated, consulted first by the resolver | Shipped | `learning/entity-aliases/*` |
| Brand voice: six fields, cool-down, versioned history, rollback; manual-class only | Shipped | `tenants/brand/*` |
| Supervisor policy engine + async risk annotator + pre-dispatch review gate | Flagged (`supervisor_agent`); policy admin routes deferred | `proposals/supervisor/*`, `ai/supervisor/review-gate.ts` |
| Conversational onboarding: identity → pack → phone → billing → AI check → test call, or "talk it through"; pack activation seeds job types, price book, templates | Shipped | `routes/onboarding.ts`, `ai/orchestration/onboarding-conversation.ts`, `onboarding/activate-pack-with-seed.ts` |
| End-of-day SMS digest with one-tap "invoice it"; weekly advisor email; HFCR weekly SMS; spoken digest by voice | Shipped | `digest/*`, `workers/daily-digest-worker.ts`, `metrics/hfcr.ts` |

### 1.3 Scheduling and dispatch

| Capability | Status | Evidence |
|---|---|---|
| Appointments with lifecycle, double-booking guard (app pre-flight + DB `EXCLUDE`), crews, tentative AI holds with reaper | Shipped | `appointments/*`, `workers/hold-reaper-worker.ts` |
| Availability engine shared by dispatch, public booking and the AI (working hours, time-off, skills, travel time with Google or haversine fallback, service-area ZIPs, DST-correct) | Shipped (Google travel time Env-gated) | `scheduling/booking-availability.ts`, `feasibility.ts` |
| Dispatch board: technician lanes + unassigned queue, drag-and-drop, every drop confirmed as a proposal with feasibility preview, conflict display, live SSE/WS updates, multi-dispatcher presence, Redis fan-out for replicas | Shipped (map view **absent**; Redis Env-gated) | `pages/dispatch/DispatchBoard.tsx`, `dispatch/*` |
| Schedule page: rolling 7-day agenda in tenant timezone, conflict detection, create/reschedule/reassign/cancel dialogs | Shipped (no week/month grid) | `components/schedule/SchedulePage.tsx` |
| Voice scheduling: create, reschedule, cancel, confirm, reassign by spoken technician name, auto-pick slot | Shipped | integration tests `reschedule-appointment-voice`, `reassign-appointment-voice`, `auto-pick-appointment-920` |
| On-my-way from app button, `OMW` SMS keyword, or voice — one audited direct act; running-late detection from browser GPS with confidence-gated customer notice; delay notices and escalation | Shipped | `dispatch/routes.ts`, `sms/tech-status/*`, `pages/technician/TechnicianDayView.tsx`, `notifications/delay-notifications.ts` |
| Tech "OUT/SICK" SMS → same-day block + reschedule proposals with drafted customer texts | Shipped | `sms/tech-status/handler.ts`, `scheduling/reschedule/from-tech-out.ts` |
| Reminders (24 h + 2 h, configurable) and confirmations by SMS/email; owner push | Shipped, per-tenant toggle | `workers/appointment-reminder-worker.ts` |
| Technician GPS ping ingestion | **Partial** — write-only; no read, ETA, or customer tracking link | `routes/technician-location.ts` |
| Google Calendar per-user sync | **Partial** — create/upsert only; update and delete deferred | `integrations/calendar-sync.ts` |
| Recurring job series with occurrence preview | **Partial** — materialisation is manual (`POST /:id/generate`); no sweep | `recurring-jobs/materialize.ts` |
| Service agreements (RRULE), auto-renew, member pricing, priority booking, off-session dues; maintenance contracts (create/read only) | Shipped / Partial | `agreements/*`, `routes/maintenance-contracts.ts` |
| Public booking page: real slots, held appointment + owner proposal, never auto-confirms; portal booking for existing customers | Shipped | `routes/public-booking.ts`, `routes/public-portal.ts` |

### 1.4 Quote, job, invoice, get paid (the money loop)

| Capability | Status | Evidence |
|---|---|---|
| Estimates: catalog-priced line items, good/better/best tiers + optional add-ons, revisions with history, clone, templates, send by SMS/email with view tracking, nudges, expiry | Shipped | `routes/estimates.ts`, `estimates/*`, `components/forms/LineItemEditor.tsx` |
| AI-drafted estimates from voice, chat, or a customer's MMS photo (vision model, catalog-grounded, uncatalogued lines capped below auto-approve) | Shipped (vision model Env-gated) | `ai/tasks/mms-estimate-task.ts`, `routes/estimates.ts` (`/suggest`) |
| Public approval page: tier selection persisted as `acceptedSelection`, drawn signature stored, decline, deposit checkout before or after approval, optimistic concurrency | Shipped | `routes/public-estimates.ts`, `estimates/public-estimate-service.ts`, `components/customer/EstimateApprovalPage.tsx` |
| Deposit rules (percent / fixed / threshold / timing) and deposit credit onto the invoice | Shipped | `jobs/deposit-rule.ts`, `invoices/deposit-credit.ts` |
| Jobs: canonical lifecycle with timeline, forms and checklists, custom fields, photos (EXIF-stripped) and files, time entries, materials list, expenses, per-job P&L | Shipped (expenses and materials are voice-only writes) | `routes/jobs.ts`, `job-forms/*`, `jobs/job-profit.ts` |
| Invoices: issue with real numbering, send, hosted payment link, auto-draft on completion, labor from time entries, milestone/progress schedules from a spoken sentence, batch invoicing sweep, multi-step dunning with late fees | Shipped, per-tenant toggles | `invoices/*`, `workers/batch-invoice-worker.ts`, `workers/overdue-invoice-worker.ts` |
| Payments: Stripe Connect onboarding, PaymentElement card + ACH + wallets on the public pay page, saved cards and off-session membership dues, Stripe Terminal card-present in the mobile app, manual payments, partial and full refunds, disputes recorded, reconciliation monitor | Shipped, **Env-gated** on Stripe keys; Terminal unproven with hardware | `billing/stripe-connect.ts`, `routes/public-payments.ts`, `payments/*`, `packages/mobile/src/payments/*` |
| Consumer financing offers on invoices | **Env-gated** (Wisetack key; Manual provider otherwise) | `routes/financing.ts` |
| Customer portal (30-day token): open invoices, estimates, jobs, agreements, book, cancel/reschedule, saved cards, request service | Shipped | `routes/public-portal.ts`, `pages/portal/*` |
| Tax: per-document basis points, taxable flags, RFC-4180 tax export | **Partial** — no rate configuration UI, no jurisdiction lookup, CSV only | `reports/tax-export.ts` |
| QuickBooks Online: OAuth, paid-invoice push with dedup, manual sync trigger | **Partial** — one-way, manual; Xero is a stub | `integrations/accounting/*` |
| Reports: money dashboard (net of refunds), revenue by source, customer/technician/job profit, HFCR, time given back, voice ROI, activity feed | Shipped | `reports/*`, `analytics/*` |

### 1.5 Retain the customer (comms, reviews, CRM)

| Capability | Status | Evidence |
|---|---|---|
| Two-way SMS/MMS + email unified inbox; every inbound SMS captured to a customer, lead, or unmatched thread; AI suggested reply (draft only) | Shipped | `conversations/*`, `sms/inbound-capture.ts`, `ai/tasks/suggest-reply-task.ts` |
| Single consent + DNC gate on every product send; per-tenant Twilio numbers fail-closed; non-prod structurally cannot send; claim-before-send ledger | Shipped | `notifications/gated-message-delivery.ts`, `delivery-provider-factory.ts`, `send-claim-ledger.ts` |
| Thank-you SMS, review request 24 h after completion with 4★+ routing to Google/Yelp URL; Google Business review polling; classified reviews → drafted public reply + private follow-up + tiered service credit, owner-approved; voice "respond to that 1-star review" | Shipped (Google OAuth Env-gated) | `workers/review-request-worker.ts`, `reputation/*`, `ai/tasks/review-response-task.ts` |
| CRM: customers with contacts, tags, groups, custom fields, multiple locations, B2B parent/sub hierarchy, dedup advisories, non-destructive merge, unified timeline, attribution and negotiation context | Shipped | `customers/*`, `locations/*` |
| Leads: kanban pipeline (new → won/lost), public intake form with UTM capture and honeypot, speed-to-lead SMS | Shipped (speed-to-lead opt-in) | `routes/leads.ts`, `routes/public-intake.ts`, `leads/speed-to-lead.ts` |
| Email campaigns to a tag or group | **Partial** — email only, no scheduling, no open/click tracking (SendGrid events are received and discarded) | `routes/marketing.ts`, `webhooks/routes.ts` (SendGrid) |
| Notification preferences and device tokens; owner push with permission-gated content | Shipped (web has no push and no preferences UI) | `routes/notification-preferences.ts`, `notifications/owner-notification-service.ts` |
| EN/ES for customer-facing notifications and voice | Shipped (operator UI is English only) | `notifications/i18n/*` |

### 1.6 Field app, platform, operations

| Capability | Status | Evidence |
|---|---|---|
| Web operator app: mode-aware nav (supervisor / tech / both), RBAC-gated money surfaces, 44 px targets and 320 px no-overflow pinned by tests | Shipped | `components/layout/Shell.tsx`, `e2e/*-mobile.spec.ts` |
| Native mobile (Expo): hold-to-talk voice capture, approvals with batch, offline queue for voice and capture-class approvals, push with deep links, jobs/photos/time, estimates/invoices with Terminal collect, messages, calls, digest | Shipped (expenses screen is intentionally read-only) | `packages/mobile/app/*`, `packages/mobile/src/offline/*` |
| Technician day view with GPS arrival detection and running-late prompts | Shipped | `pages/technician/TechnicianDayView.tsx` |
| RBAC: owner / dispatcher / technician, ~60 permissions, frozen matrix; team invites via Clerk; account deletion | Shipped | `auth/rbac.ts`, `users/invite-team-member.ts` |
| Tenant isolation: Postgres RLS forced on every table plus explicit `tenant_id` predicates; runtime RLS role required in prod | Shipped | `db/rls-runtime-role.ts`, integration `rls-runtime-audit` |
| Webhooks in: Stripe, Clerk, Twilio, Vapi, SendGrid, Wisetack — all signature-verified with idempotent receipt | Shipped | `webhooks/*` |
| LLM gateway: three-tier routing, vision routing, breaker/retry/deadline/cascading fallback, response cache, micro-cent cost accounting, per-tenant quota, Langfuse export, shadow-model comparison, AI health probes | Shipped (Langfuse, shadow, PostHog Env-gated) | `ai/gateway/*` |
| Evaluation: 8 floor + 4 disposition rubric criteria, 73-script cassette corpus across 11 buckets with a launch gate in CI, Layer-2 real-audio harness with latency gates, dialect/WER scaffold, intent/slot eval package | Shipped; Layer-2 cadence and dialect fixtures **Partial**; Layer-1 pg mode **Dormant** | `ai/voice-quality/*`, `packages/voice-eval/*` |
| Observability: Sentry capture on every unhandled 5xx (PR #975), SLO and silent-failure monitors paging via Sentry/SMS, Prometheus metrics, route-manifest guard | Shipped | `monitoring/*`, `workers/slo-monitor.ts`, `app-route-manifest.ts` |
| Public API, outbound webhooks, Zapier, CSV import/export | **Absent** (Swagger covers ~14 of 85 routers and advertises an unmounted `/api/v1`) | `swagger/spec.ts` |

### 1.7 Dormant, placeholder, or stale

Consolidated from the three inventories; each is a candidate for either wiring or deletion
under the Code Hygiene rule.

- `contracts/contract-job-generator.ts` — no production importer.
- `escalations/outcome-route.ts` — validates and returns 200 without persisting.
- `voice_outbound` session channel — enum value with no producer.
- Feature-flag admin API — only `force_primary_provider` is ever read.
- Web: "Voice notes coming soon" tab in the job Add-Entry sheet; Weekly Digest panel in
  Templates that never calls the API; dead `TEMPLATES` / `COMMUNITY_INSIGHTS` fixtures in
  `TemplatesPage.tsx`; the inline "Mock AI generator" fallback in `NewEstimateFlow.tsx`;
  demo technician names in `SchedulePage.tsx` `TECH_COLORS`; Language settings header
  admits the voice-override pickers are placeholders.
- `NoopBrandVoiceLoader`, Xero provider stub, `markPurchased` with no caller.
- OpenAPI `servers` points at `/api/v1`, which is not mounted.

## 2. Head-to-head: Rivet vs the top five

Cell key: **✅** shipped and included · **◐** partial, flagged-off, or env-gated · **❌**
absent · **$** paid add-on or higher tier · **?** unverified from available sources ·
**n/a** not in the ICP's decision. Verdict is from the 1–3-truck owner-operator's
seat: **WIN** we are ahead, **PARITY** equivalent, **GAP** they are ahead on something the
ICP expects, **POLICY** the gap is a product decision not a missing capability,
**WON'T** deliberately not built (see §3.3). Rivet pricing: one flat monthly plan
(`docs/competitive-review-rivet-vs-jobber-2026-07-02.md` cites $99/mo; the current price
page was not reachable from here — verify, §4.2).

### 2.1 AI phone and messaging

| # | Capability | Rivet | ServiceTitan | Jobber | Housecall Pro | Workiz | Avoca | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | AI answers inbound calls 24/7 | ✅ flat | ✅ $ (~$2.75/call) | ✅ $ ($29/mo + $0.79/convo; free on Plus) | ✅ $ (unpublished) | ✅ $ (~$200/mo, needs Workiz Phone) | ✅ (quote-only, ~$1–3.5k/mo) | **WIN on price**, PARITY on presence |
| 2 | Books the job itself, no human tap | ◐ default holds slot + owner tap; autonomous lane flagged off | ✅ | ✅ | ✅ | ✅ | ✅ | **POLICY** (flip `autonomous_booking_enabled`; undo + audit they lack) |
| 3 | Quotes prices on the call from the price book | ✅ grounded, no-number when uncatalogued | ❌ dispatch fee only | ❌ creates a work request | ◐ reads booking-catalog prices | ◐ Q&A from account data | ? | **WIN** |
| 4 | Life-safety / emergency triage with 911 script and on-call dispatch | ✅ deterministic E1/E2/E3 | ? | ❌ keyword transfer only | ❌ | ❌ | ✅ | **WIN** vs FSMs, PARITY vs Avoca |
| 5 | Vulnerable-caller detection with owner patch-through | ◐ flagged off | ❌ | ❌ | ❌ | ❌ | ❌ | latent WIN |
| 6 | Warm transfer with context to a human | ✅ whisper + SMS brief | ✅ | ✅ (no context evidenced) | ✅ | ✅ | ✅ | PARITY |
| 7 | Spanish on the call | ✅ (realtime path flagged) | ✅ | ? | ✅ | ✅ + French | ? | PARITY; Workiz leads on languages |
| 8 | After-hours mode choice (voicemail vs AI) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | PARITY |
| 9 | Recognises returning callers and their history | ✅ incl. B2B hierarchy, membership | ✅ | ✅ | ✅ | ✅ | ✅ | PARITY |
| 10 | Recording disclosure by state + consent ledger + "stop recording" | ✅ | ✅ recording | ? | ? | ✅ recording | ? | **WIN on compliance depth** |
| 11 | Dropped-call SMS recovery | ✅ (per-tenant flag) | ◐ Second Chance Leads (post-hoc flag, not outreach) | ❌ | ❌ | ❌ | ❌ | **WIN** |
| 12 | AI answers inbound SMS and web chat autonomously | ◐ SMS captured, reply is draft-only; no chat widget | ✅ $ SMS agent + chat | ✅ texts (Receptionist) | ✅ chat on all plans, texts | ✅ | ✅ | **GAP** |
| 13 | Outbound AI voice (speed-to-lead call, estimate follow-up, renewals) | ❌ SMS/email only; human click-to-call bridge | ✅ $ SMS agent, outbound support | ❌ | ◐ AI texts | ◐ automations | ✅ Nurture | GAP vs Avoca/ST; **WON'T** for voice dialer this cycle |
| 14 | Owner assistant that executes tasks by voice/chat | ✅ 30+ actions + lookups, proposal-gated; memo is record-then-poll | ✅ Atlas | ✅ Voice/Chat 100+ tasks, live, all plans | ◐ advisory AIs | ◐ Smart Messaging | ❌ | PARITY on capability, GAP on live-conversational feel |
| 15 | Trust architecture: typed proposals, approval, undo, audit, catalog grounding, clarification not guessing | ✅ | ❌ not evidenced | ❌ | ❌ | ❌ | ❌ | **WIN** (structural) |
| 16 | Standing instructions / automations | ✅ ≤20 directives, proposal-gated | ✅ | ✅ $ builder (Grow) | ◐ pipeline automations | ✅ | ❌ | PARITY (different shape) |
| 17 | Learns from owner corrections | ✅ lessons cascade to config | ? | ❌ | ❌ | ❌ | ◐ CSR feedback loop | **WIN** |
| 18 | Human-CSR call scoring and coaching | ❌ | ✅ $ | ❌ | ❌ | ✅ Call Insights | ✅ Coach | n/a (ICP has no CSRs) |
| 19 | Photo-to-quote from a customer MMS | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | **WIN** |
| 20 | Voice-quality launch gate in CI (73 scripts, 11 buckets) | ✅ | internal | internal | internal | internal | internal | n/a (our moat for quality claims) |

### 2.2 Scheduling and dispatch

| # | Capability | Rivet | ServiceTitan | Jobber | Housecall Pro | Workiz | Avoca | Verdict |
|---|---|---|---|---|---|---|---|---|
| 21 | Drag-and-drop dispatch board | ✅ proposal-confirmed drops | ✅ | ✅ | ✅ | ✅ | n/a | PARITY |
| 22 | Week / month calendar views | ❌ 7-day agenda only | ✅ | ✅ | ✅ | ✅ | n/a | **GAP** |
| 23 | Map view / live technician map | ❌ GPS ingested, never plotted | ✅ | ✅ | ✅ | ✅ | n/a | **GAP** |
| 24 | Live "track my tech" link for the customer | ❌ | ✅ | ❌ | ◐ with GPS add-on | ◐ | n/a | GAP (minor for ICP) |
| 25 | Route optimisation | ❌ pairwise drive time only | ✅ $ Dispatch Pro | ✅ Grow | ◐ alpha / MAX | ◐ | n/a | **WON'T** (PRD out of scope) |
| 26 | AI slot / tech suggestion | ◐ feasibility + auto-pick for voice bookings | ✅ $ | ◐ nearest tech | ◐ | ✅ Genius Scheduling | n/a | PARITY− |
| 27 | Online booking from real availability | ✅ held + approved | ✅ $ Scheduling Pro | ✅ | ✅ | ✅ | ✅ Simple Scheduler | PARITY |
| 28 | On-my-way, running-late, reminders, confirmations | ✅ 3 surfaces + auto-late | ✅ | ✅ | ✅ | ✅ | n/a | PARITY+ |
| 29 | Recurring visits / service plans | ◐ agreements sweep ✅; recurring jobs manual; contracts thin | ✅ | ✅ | ✅ MAX | ✅ | n/a | PARITY− |
| 30 | GPS timers / geofence clock-in | ◐ arrival detection on tech day view; no geofence timers | ✅ | ✅ Grow | ✅ Essentials | ✅ | n/a | PARITY− |

### 2.3 Estimates, invoicing, payments

| # | Capability | Rivet | ServiceTitan | Jobber | Housecall Pro | Workiz | Avoca | Verdict |
|---|---|---|---|---|---|---|---|---|
| 31 | Good/better/best + optional add-ons, customer picks online | ✅ included | ✅ | ✅ Grow | ✅ $ proposal tool | ✅ $ proposals | n/a | **WIN on price** |
| 32 | E-signature on approval | ✅ drawn canvas (not audit-certificate grade) | ✅ | ✅ | ✅ with IP/timestamp PDF | ✅ required | n/a | PARITY |
| 33 | Deposits at approval, before or after | ✅ rules engine | ✅ | ✅ | ✅ | ✅ | n/a | PARITY |
| 34 | Consumer financing | ◐ Wisetack, env-gated | ✅ six lenders | ✅ Wisetack | ✅ Wisetack | ✅ Wisetack + Sunbit | n/a | PARITY once keyed |
| 35 | AI-drafted quotes from a request | ✅ voice, chat, photo | ◐ Atlas | ✅ auto-draft from requests | ❌ | ❌ | n/a | PARITY+ |
| 36 | Quote follow-ups and expiry | ✅ | ✅ $ Marketing Pro | ✅ | ◐ | ✅ automations | n/a | PARITY |
| 37 | Price book with flat-rate content / price benchmarks | ◐ catalog + pack seeds, no benchmarks | ✅ $ Pricebook Pro + Price Insights | ❌ | ◐ announced | ❌ | n/a | n/a |
| 38 | Online card + wallets | ✅ Stripe Connect | ✅ in-house | ✅ Stripe | ✅ | ✅ Workiz Pay | n/a | PARITY |
| 39 | ACH / bank debit | ✅ one-time (no recurring mandate) | ✅ | ✅ 1% | ✅ | ✅ 1% | n/a | PARITY |
| 40 | Tap to Pay / card reader in the field | ◐ Stripe Terminal wired in mobile, unproven with hardware | ✅ | ✅ 2.7% | ✅ $5/user | ✅ | n/a | PARITY− (needs hardware proof) |
| 41 | Tips at checkout | ❌ | ? | ✅ | ✅ | ? | n/a | **GAP** (small build) |
| 42 | Instant payouts | ❌ standard Stripe | next-day | ✅ 1% | ✅ 1% | 3–4 days | n/a | GAP (minor) |
| 43 | Saved card + auto-charge memberships | ✅ off-session dues | ✅ | ✅ | ✅ MAX | ✅ | n/a | PARITY |
| 44 | Progress / milestone billing and batch invoicing | ✅ both, spoken on-ramp | ✅ | ✅ Grow | ❌? | ❌? | n/a | **WIN** vs HCP/Workiz |
| 45 | Reminders, late fees, dunning | ✅ multi-step + late fees | ✅ | ✅ reminders | ✅ reminders | ✅ automations | n/a | PARITY+ |
| 46 | Refunds / void / disputes | ◐ API has partial refunds and disputes; **no web UI** | ✅ | ✅ | ✅ | ✅ | n/a | **GAP** (UI only) |
| 47 | Customer-side partial payment | ❌ full balance only | ✅ | ✅ schedules | ? | ? | n/a | GAP (minor) |
| 48 | Tax rate configuration | ◐ per-document bps, no settings UI | ✅ | ✅ | ✅ | ✅ | n/a | **GAP** |
| 49 | QuickBooks sync | ◐ one-way paid invoices, manual trigger | ✅ two-way, near real-time | ✅ one-way auto (+ Xero) | ✅ QBO + Desktop | ✅ two-way | n/a | **GAP** |
| 50 | Payroll / commissions | ❌ time entries only | ✅ | Gusto | ✅ $ | ❌ | n/a | **WON'T** (PRD out of scope, ever) |

### 2.4 Communications, CRM, retention

| # | Capability | Rivet | ServiceTitan | Jobber | Housecall Pro | Workiz | Avoca | Verdict |
|---|---|---|---|---|---|---|---|---|
| 51 | Two-way SMS unified inbox | ✅ flat | ✅ | ✅ Grow ($149+) | ✅ | ✅ | ✅ | **WIN on price** |
| 52 | AI-suggested replies | ✅ draft, never auto-send | ✅ Atlas | ✅ Rewrite | ✅ Marketing AI | ✅ Smart Messaging | ✅ | PARITY |
| 53 | Review requests + Google review response drafting | ✅ poll, classify, draft, credit tiers | ✅ $ Marketing Pro | ✅ $39/mo | ✅ | ✅ | ✅ (via Nurture) | **WIN on price and depth** |
| 54 | Email/SMS campaign builder | ◐ segment email, no scheduling or tracking | ✅ $$ | ✅ $79/mo | ✅ $ | ✅ $ Genius Marketing | ✅ | **WON'T** (campaign treadmill) |
| 55 | Postcards / direct mail | ❌ | ✅ $ | ❌ | ✅ | ❌ | ❌ | n/a |
| 56 | Google LSA / Reserve with Google / Thumbtack / Yelp / Angi lead ingestion | ❌ public intake + UTM only | ✅ | ✅ LSA, Thumbtack | ✅ all, Job Inbox | ✅ all | n/a | **GAP** (Tier 1) |
| 57 | Sales pipeline kanban | ✅ included | ✅ 2026 residential CRM | ✅ $49/mo | ✅ $ | ✅ | n/a | **WIN on price** |
| 58 | Customer portal | ✅ token: pay, approve, book, cards, agreements, request | ✅ | ✅ Client Hub (+ tips, referrals) | ✅ passwordless | ✅ | n/a | PARITY |
| 59 | Custom fields, tags, groups, merge, B2B hierarchy | ✅ | ✅ | ✅ | ❌ no custom fields | ✅ | n/a | PARITY+ |
| 60 | Equipment / asset registry per location | ❌ | ✅ | ◐ notes | ? | ✅ | ✅ reads from FSM | **GAP** (Tier 2; P24) |
| 61 | Referral programme | ❌ | ❌ | ✅ $ | ◐ | ❌ | ❌ | **WON'T** |
| 62 | Hosted website / booking widget | ❌ hosted `/book` page only | ✅ $ | ✅ free site | ✅ $ | ✅ hosted page | ✅ web chat | GAP (minor) |
| 63 | Data import from a previous system | ❌ | ✅ (paid implementation) | ✅ CSV | ✅ | ✅ | n/a | **GAP** (Tier 1: switching cost) |

### 2.5 Job execution, mobile, platform

| # | Capability | Rivet | ServiceTitan | Jobber | Housecall Pro | Workiz | Avoca | Verdict |
|---|---|---|---|---|---|---|---|---|
| 64 | Forms / checklists with photos and signature | ✅ forms; no signature on forms | ✅ | ✅ Connect | ✅ | ✅ | n/a | PARITY− |
| 65 | Job photos before/after, annotation | ✅ pairing; no annotation | ✅ | ✅ | ✅ annotation, reports | ✅ | n/a | PARITY− |
| 66 | Time tracking + job costing / profit | ✅ job, customer, tech P&L; voice lookup | ✅ | ✅ Grow | ◐ | ✅ | n/a | PARITY+ |
| 67 | Expenses with receipts | ◐ voice-only write, no screen | ✅ | ✅ Connect | ◐ | ◐ | n/a | PARITY− |
| 68 | Inventory / purchase orders | ❌ materials list only | ✅ | ❌ | ◐ | ✅ $ | n/a | **WON'T** |
| 69 | Offline mobile | ✅ durable queue for voice + approvals | ? | ✅ | ◐ view-only | ✅ | n/a | PARITY |
| 70 | Push notifications | ✅ native; no web push | ✅ | ✅ | ✅ | ✅ | n/a | PARITY |
| 71 | Dashboards / custom reports | ◐ digest-as-dashboard + fixed reports | ✅ custom | ✅ 20+ | ✅ Analyst AI | ✅ | ✅ | GAP by design |
| 72 | Ask questions of your data in plain language | ✅ voice/chat lookups | ✅ Atlas | ✅ AI chat | ✅ Analyst AI | ◐ | ✅ | PARITY |
| 73 | Open API, outbound webhooks, Zapier | ❌ inbound only; partial Swagger | ✅ gated | ✅ GraphQL + webhooks | ✅ MAX | ✅ | ◐ | **GAP** (Tier 2) |
| 74 | Custom roles | ❌ 3 fixed roles | ✅ | ✅ | ◐ | ✅ | n/a | n/a for ICP |
| 75 | Multi-location / franchise | ❌ B2B customer hierarchy only | ✅ | ❌ | ❌ | ✅ $ | ✅ roll-up | **WON'T** (anti-persona) |
| 76 | Vertical packs (HVAC, plumbing, electrical, painting) with seeded catalog, terminology, intake questions | ✅ (2 of 4 fully built) | ✅ trade packages | ❌ | ✅ trade packages (Jul 2026) | ❌ | ✅ HVAC-native | PARITY |
| 77 | Price | flat monthly, everything included | ~$245–500/tech/mo + add-ons + $5–50k setup | $29–$399+/mo + $29/user + add-ons | $59–$299/mo + unpublished add-ons | ~$187–270/mo + $100 phone + $200 AI | ~$1,000–3,500/mo, quote-only | **WIN** (structural) |

### 2.6 What moved since the July review

- Standing instructions: GAP → **shipped** (`instructions/*`, UB-A).
- Voice technician reassignment: CLAIM≠REALITY → **shipped** (`reassign-appointment-voice` integration test).
- Invoice-schedule and review-response voice on-ramps: orphaned → **shipped** (U2, U3).
- Spanish on the realtime stream: GAP → **shipped behind the realtime flag** (UB-C).
- Autonomous booking lane: GAP → **shipped, default off** (D-015).
- Conversational owner assistant (UB-B): still record-then-poll on memo; chat is synchronous. Unchanged.
- Jobber's Receptionist price: the review used $99/mo; Jobber's help centre now says $29/mo + $0.79 per conversation beyond 30. Our price advantage narrows on the receptionist line and remains structural on the bundle.

## 3. Gaps, ranked for the 1–3-truck shop

### 3.1 Tier 1 — the shop notices in week one

| Gap | Why it matters to the ICP | Smallest credible build | Rows |
|---|---|---|---|
| **AI queues instead of books** | Every competitor's receptionist confirms the appointment on the call; ours holds a slot and texts the owner. In a shop with no dispatcher that is "AI answers and queues." | Product decision: default `autonomous_booking_enabled` on for capture-class bookings above 0.95, keep the UNDO SMS; fix the documented `supervisorMode` coupling so the lane's threshold branch runs. | 2 |
| **Inbound texts and web chat are not answered** | The same caller texts after hours; the FSMs and Avoca reply and book. We draft and wait. | Capture-class SMS auto-reply for FAQ/booking through the existing negotiation guardrail; a hosted chat widget on `/book` that drives the in-app voice session FSM. | 12 |
| **No marketplace lead ingestion** | Google Local Services Ads is where the ICP's leads come from; HCP, Workiz, Jobber, ST all book LSA/Reserve-with-Google leads straight in. | Reserve with Google + LSA lead webhooks → existing `leads` + speed-to-lead; Thumbtack/Yelp email parsing via the intake path. | 56 |
| **No calendar grid, no map** | Owner-operators still look at a week; a dispatch board without a map reads as unfinished next to any competitor screenshot. | Week view over the existing day-window query; a single map component plotting the GPS pings we already ingest. | 22, 23 |
| **Switching cost: no import** | A shop on Jobber or HCP has 500 customers in a CSV. | CSV import for customers + locations with dedup advisories (the scorer exists). | 63 |
| **QuickBooks is one-way and manual** | The most-complained-about integration in Jobber reviews is still expected to exist and run itself. | Scheduled sync + customers and payments, not just paid invoices. | 49 |
| **Tips, instant payout, customer partial pay** | Time-to-cash features the ICP sees on Jobber/HCP pay pages. | Tip toggle on the pay page; Stripe instant payouts; amount field on `/pay/:id`. | 41, 42, 47 |

### 3.2 Tier 2 — completeness the docs already promise

Equipment registry per location (60, the Avoca-beating cross-call memory move); refund
and void UI on web (46); tax-rate settings sheet (48); recurring-job materialisation
sweep (29); Google Calendar update/delete sync (§1.3); SendGrid delivery events written
back to dispatches (§1.5); customer "track my tech" link from the GPS we ingest (24);
signature on job forms (64); web push and a web notification-preferences row (70);
public API and outbound webhooks (73); realtime transport on by default once capacity is
measured (row 7 and the July punch list); Layer-2 audio corpus on a CI cadence (§4.1 A4).

### 3.3 Won't-build (re-affirmed)

Route optimisation and geofencing; campaign builder, postcards, referral engine; inventory,
purchase orders, vendor bills; payroll and commissions; franchise and multi-location
roll-up; human-CSR coaching; per-seat pricing; a visual no-code workflow builder; an
outbound AI voice dialer this cycle (speed-to-lead stays SMS until consent capture and
TCPA enforcement are on in `block` mode). Each is either a PRD non-goal, an anti-persona
need, or a flat-price trap. Re-litigate only with a customer count behind it.

## 4. Verification plan — how we know all of this is true

Three tracks. A proves our own rows. B proves the competitor rows. C proves the verdicts.
Definition of proven, borrowed from `docs/qa-strategy.md`: an automated gate executed
green on the commit, or a runtime observation with captured output; a test that mocks the
seam under question is not proof (the entity resolver shipped with non-existent column
names behind a mocked pool).

### 4.1 Track A — our claims

**A1. Claim ledger.** Every Rivet cell in §2 maps to exactly one evidence class. The
mapping below is the ledger; the per-workflow evidence is
`docs/verification/full-verification-2026-09-06.md` §2 (referenced as FV §2.x).

| Class | Meaning | Rows in §2 |
|---|---|---|
| **P1 Automated, green today** | A unit, integration (real Postgres + RLS), Playwright, or corpus gate ran green on `353502d` / `2e5e598` | 1, 3, 4, 8, 9, 10, 15, 16, 17, 19, 20, 21, 27, 28, 31, 32, 33, 35, 36, 38, 39, 43, 44, 45, 51, 52, 53, 57, 58, 59, 64, 66, 69, 76 (FV §2.3–2.13, §2.17) |
| **P2 Runtime-observed** | Driven live over HTTP/TwiML/Postgres in this session's `/verify` of PR #975 | call cap and wrap-up (row 1), signed-webhook fail-closed, mid-call transcript persistence and recording attach, ended-session recovery, Sentry capture on a thrown 500, Langfuse export, gate-red reporter |
| **P3 Code-present, mock-proven only** | Exists and is unit-tested, but the seam that matters is mocked or flagged off | 2 (autonomous lane, flag off; threshold coupling noted), 5, 6 (whisper needs a real second leg), 7 (realtime Spanish), 11, 26, 30, 40 (Terminal), 34 (Manual provider), 49 (OAuth) |
| **P4 Needs staging credentials** | Cannot be proven without a real provider | real inbound call on the realtime transport (Deepgram + ElevenLabs), Stripe Elements card and ACH debit, Terminal with a reader, Wisetack, QuickBooks OAuth + push, Google Business OAuth + review poll, Vapi, Clerk sign-in UI, PostHog, Langfuse against a real project |
| **P5 Contradicted or unproven** | Inventory found the claim false, dormant, or unmeasured | escalation outcome route (§1.7), recurring-job sweep (29), calendar delete sync, SendGrid events, Layer-1 pg mode, Layer-2 cadence, load and p95 budgets (FV G-1), dialect fixtures |

**A2. Re-run the automated layer** (30 min with Docker; this is FV §8 verbatim and is
what CI runs):

```bash
npm run typecheck && npm run lint && npm test
npx vitest run --root packages/mobile --coverage
npm run check:ai-gateway-guard --workspace=packages/api && npm run check:fk-paths --workspace=packages/api
npm run check:migration-keys --workspace=packages/api && npm run check:env-coverage
npm run agent:graph-coverage --workspace=packages/api -- --gate && npm run test:pii-leakage
cd packages/api && VOICE_QUALITY_ENFORCE_LAUNCH_GATE=true npm run voice-quality && cd ../..
cd packages/api && TEST_DB=testcontainers RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts && cd ../..
export VITE_CLERK_PUBLISHABLE_KEY='pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA=='
npm run e2e        # 55 pass / 59 skip on the dev-auth project after #977
```

**A3. Runtime proof without credentials** (1–2 h). Use the two project verify skills;
they are the replayable recipes and were extended today:

- `packages/api/.claude/skills/verify/SKILL.md` — in-memory boot for webhook surfaces;
  Postgres boot (pgvector container, `DB_SSL=false`, `migrate:apply`, tenant seed) for
  recording persistence, transcript turns, audit rows, queue workers; signed Twilio
  poster; `VOICE_MAX_CALL_DURATION_MS=4000` to end sessions deterministically; the
  fake-AI-key trick that registers the ingestion queue; `/public/estimates/<token>` as the
  unauthenticated DB-backed 500 for Sentry.
- `packages/web/.claude/skills/verify/SKILL.md` — SPA under `VITE_AUTH_MODE=dev`,
  `verify-seed.mjs`, headless Chromium at 1280×900 and 375 px.

Drive, in this order, and capture the response or screenshot for each: public booking →
held appointment → inbox proposal → approve → undo inside 5 s → execute; estimate with
tiers → `/e/:id` pick a tier, sign, decline path, deposit-before-approval path; invoice
→ `/pay/:id` (Stripe unconfigured shows the fallback copy, which is itself a P4 marker);
Gather call → booking → recording webhook → `call_transcript_turns` and
`voice_recordings.outcome`; dispatch board drag → confirm dialog → feasibility preview;
tech day view en-route and running-late with a spoofed geolocation; SMS `OMW`, `OUT`,
`STOP`, `Y` keywords through the signed SMS webhook; portal token: book, cancel, cards
setup (P4 for the SetupIntent). Every step here that passes moves a row from P3 to P2.

**A4. Staging sign-off for the credential legs** (blocked on PR #975 U3/U4 secrets;
half a day once they exist). Run the credential-gated workflows —
`voice-smoke-real`, `agent-path-smoke`, `mms-vision-smoke`, `qa-matrix-gate`,
`voice-eval-live` — then twelve scripted phone calls to the provisioned number, each with
a pass criterion and a database assertion:

| # | Script (caller says) | Pass when |
|---|---|---|
| 1 | New caller books an AC tune-up for Tuesday morning | `appointments.hold_pending_approval`, proposal `create_booking`, owner SMS within 10 s; with autonomous lane on: confirmation SMS to caller after 5 s and an UNDO SMS to owner |
| 2 | Known caller (seeded phone) asks "when is my next appointment" | correct date spoken; `lookup_events` row; no PII before identity |
| 3 | "How much for a capacitor replacement" (catalogued) then "book it" | price read back equals catalog cents; `draft_estimate` + booking chain |
| 4 | Same, uncatalogued item | no number spoken; estimate line confidence below auto-approve |
| 5 | "I smell gas" | 911 script spoken first, session `escalating`, owner page SMS, `emergency_dispatch` proposal, no booking |
| 6 | Elderly caller, no heat, snow (vulnerability flag on) | `patch_owner` decision, owner cell rings with preface, fallback booking after 60 s |
| 7 | Caller speaks Spanish from the first utterance | ES greeting continues, Deepgram `es`, ES confirmation SMS |
| 8 | "Can you take 20% off" | no negotiation; holding line; `callback` proposal with verbatim ask |
| 9 | Hang up mid-booking, wait 90 s | dropped-call recovery SMS; reply "yes" threads to the intake |
| 10 | Call after hours (mode voicemail, then mode AI) | voicemail → lead + transcription; AI mode → normal booking |
| 11 | Owner line: "approve the Henderson estimate", then a money proposal with PIN | readback, strict confirm, PIN challenge, `approveProposal(channel='voice')`, 3 bad PINs lock money class |
| 12 | Talk past the wall-clock cap (set 60 s on staging) | wrap-up line at cap − 30 s, `<Hangup>`, outcome `completed` with reason `max_call_duration`, transcript intact |

Plus the money legs: a real test card and a real ACH debit on `/pay/:id` (webhook →
`paid`, `processing_async` polling for ACH), a refund from the API, a Terminal tap with a
reader on the mobile app, one Wisetack sandbox offer, one QuickBooks OAuth + push, one
Google Business connect + review poll. Record results as a new row in `docs/QA_LOG.md`
and flip each row's class in this ledger.

**A5. Keep the ledger honest.** Three cheap guards so this document does not rot the
way its predecessors did:

- A test that asserts every evidence path cited in this README and the appendices exists
  on disk (`packages/api/test/docs/evidence-paths.test.ts`; a path that moves fails CI
  and forces the doc to move with it).
- Fold the seven §1.7 dormant items into #975's follow-up list or delete them; a dormant
  module is a future false "we have it".
- The two adversarial reads that caught this run's errors: when two inventories disagree,
  grep before believing either (this is how e-signature, ACH and tier selection were
  rescued from the gap list), and give reviewers a numbered claim list, not "review
  this" (`docs/solutions/workflow-issues/adversarially-verify-plan-units-before-execution.md`).

### 4.2 Track B — competitor claims

Everything in §2's competitor columns came through search-engine excerpts because the
sandbox proxy returned 403 on every vendor, help-centre and review domain. Confidence
today: vendor-page-excerpted rows are probably right on presence and often wrong on tier
and price; third-party-only rows are guesses. To make the table citable:

1. **Capture the sources** (2 h, any machine off the proxy). For every URL in Appendices
   D–H, fetch the page, save an HTML or PDF snapshot with the capture date into
   `docs/research/competitive-2026-09-06/sources/<vendor>/`, and stamp each appendix row
   `vendor` / `help-centre` / `third-party` / `unverified`. Re-check the four price
   conflicts first: Jobber Receptionist ($29 vs $99), Jobber Marketing Suite ($79 vs $99),
   Housecall Pro extra-user cost, Workiz tier prices (unpublished).
2. **Trial the three that offer one** (a week of calendar time, an afternoon of effort
   each): Jobber 14 days, Housecall Pro 14 days, Workiz 7 days. Run the same twelve call
   scripts from A4 against each vendor's AI receptionist on a forwarded number, and the
   core loop (book → quote with tiers → sign → deposit → invoice → pay → review request)
   on each. Score every §2 row for that vendor as observed / not offered / not on this
   tier. This converts the two most-compared competitors from excerpts to evidence.
3. **Demo the two that gate behind sales** (ServiceTitan, Avoca). Take a written question
   list into the demo: does the voice agent quote prices; which languages; what happens on
   a gas-leak call; transfer with context; what is written back to the FSM; per-call and
   per-minute pricing; minimum contract; onboarding time. Record answers with the date and
   the rep's name in the appendix.
4. **Refresh cadence.** Quarterly, plus after each vendor's release event: Jobber Now
   (Sept 23–24 2026), ServiceTitan Pantheon, Housecall Pro's summit and monthly product
   updates page, Workiz's Genius releases. Re-run step 1 only for the rows that changed.

### 4.3 Track C — the verdicts

A verdict is a judgement, so verify it the way the plan units were verified before
execution: two independent read-only reviewers, each given a numbered list of §2 rows,
returning WRONG / MISSING / RISK / OK with a `file:line` or a captured competitor page for
every non-OK, and the replacement text. Apply the July review's governing test to every
WIN: *can the owner complete it by speaking a sentence?* If not, it is at best PARITY.
Then put the ICP in the loop: three shops from the beta list walk the head-to-head with
us and mark which GAP rows they would actually switch over. That ranking, not ours,
finalises §3.1.

### 4.4 Sequence and effort

| When | What | Owner | Unblocks |
|---|---|---|---|
| Now | A1 ledger (this document), A2 automated re-run, A3 runtime drives | engineering | rows P3 → P2 |
| This week | B1 source capture, B2 trials started, A5 evidence-path test | product + engineering | citable table |
| When U3/U4 secrets land | A4 staging calls and money legs, credential-gated workflows | operator + engineering | rows P4 → P2; QA_LOG row |
| Two weeks | B3 demos, C reviewer pass, ICP walk-through | product | final §3.1 ranking |
| Quarterly | B4 refresh | product | table stays true |

Total new engineering for verification itself is small — the harnesses exist. The cost
is calendar time for trials and the operator secrets. The Tier 1 build list in §3.1 is a
separate plan and should go through `ce-plan` with this ledger as its input.
