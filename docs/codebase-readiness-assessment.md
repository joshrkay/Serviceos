# ServiceOS — Codebase Readiness Assessment

## Context

Full audit of the ServiceOS codebase against the PRD, all 184 user stories
(Phases 0–7), the Phase 8 calling-agent roadmap, and the late-April / early-May
sprint deltas. ServiceOS is a multi-tenant field-service management platform
with AI assistant + voice capabilities, built as a monorepo (`infra/`,
`packages/api`, `packages/web`, `packages/shared`).

**Assessment date:** 2026-05-06
**Codebase size:** ~77,000 lines API source + ~44,000 lines web source
**Test coverage:** 353 API test files + 113 web test files + 8 Playwright E2E specs

> **Note on the prior version of this document.** The Apr 29 assessment is
> superseded. Most of the launch blockers it called out (Postgres wiring,
> frontend Clerk SDK, `bootstrapTenant`, the `'dev-secret-key'` fallback,
> mock payment provider in production paths, hardcoded AI replies, dispatch
> drag-and-drop, real STT) have shipped between Apr 29 and May 6. This
> document reflects what is actually in `main` today.

---

## Overall Verdict: ~85% Built, ~70% Launch-Ready

The platform has crossed from "high-quality prototype" into "credible private
beta candidate." Data persists through Postgres for ~37 repositories, Clerk
auth runs end-to-end (frontend SDK + backend JWT/RBAC + tenant bootstrap),
Stripe payment links are live with idempotent webhook reconciliation, public
estimate-approval and invoice-payment pages ship token-scoped, Twilio SMS
+ SendGrid email send for real, telephony provisioning is tenant-aware, and
the calling-agent state machine has its first scaffold landed.

The remaining gap is no longer infrastructure — it is **Phase 8 (the
customer calling agent)**, **production-grade voice provider upgrades**
(Deepgram streaming STT, ElevenLabs streaming TTS), **vertical-specific
domain knowledge** in agent prompts, and a finite list of UI polish items
(13 settings stubs, conflict badges, post-execution refresh).

---

## Story Completion by Phase

| Phase | Original Stories | Code Exists | Wired & Working | Remaining |
|-------|-----------------|-------------|-----------------|-----------|
| **P0 — Platform Foundation** | 18 | 18/18 | 17/18 | env-validation polish |
| **P1 — Core Business Entities** | 24 | 24/24 | ~22/24 | Settings save (1B/1C) |
| **P2 — Proposal Engine + AI Safety** | 27 | 27/27 | ~25/27 | inbox refresh, eval polish |
| **P3 — Conversation + Voice** | 15 | 15/15 | ~12/15 | streaming providers (1A/1B) |
| **P4 — Vertical Packs + Estimate Intelligence** | 26 | 26/26 | 26/26 | — |
| **P5 — Invoice Intelligence + Payments** | 29 | 28/29 | ~26/29 | invoice delivery notif |
| **P6 — Dispatch Board + Scheduling** | 27 | 24/27 | ~20/27 | conflict badges, refresh |
| **P7 — Integrations + Beta Hardening** | 18 | 8/18 | ~5/18 | QuickBooks, Zapier, runbook |
| **P8 — Customer Calling Agent (new)** | 14 | 13/14 | ~12/14 | hardening + Tier 3 prompt work |
| **TOTAL** | **198** | **183/198** | **~164/198** | **~34** |

---

## Original Launch Blockers — Status

| # | Blocker (Apr 29 doc) | Status | Where it landed |
|---|---|---|---|
| 1 | All data lives in-memory | **RESOLVED** | 37 Pg ternaries in `app.ts`. Last InMemory-only repo (`PaymentReadinessRepository`) deleted 2026-05-06 as redundant — its state is sourced from invoice columns from migration 050. |
| 2 | Frontend auth is fake | **RESOLVED** | `@clerk/clerk-react` v5.61, `<ClerkProvider>` in `main.tsx`, `AuthTokenBridge`, `ProtectedRoute`, `SignupPage`, `LoginPage` all live. Test coverage in `P0-029.ClerkProvider.test.tsx`. |
| 3 | Clerk webhook tenant bootstrap incomplete | **RESOLVED** | `bootstrapTenant()` implemented in `auth/clerk.ts` and called from `webhooks/routes.ts:125` on `user.created`. |
| 4 | Hardcoded `'dev-secret-key'` in prod path | **RESOLVED** | Now `process.env.CLERK_SECRET_KEY ?? ''`; `validateEnvSchema` in `shared/config.ts:205` enforces presence in production / staging; defense-in-depth check in `auth/clerk.ts:349`. |
| 5 | AI Assistant demo-only / hardcoded replies | **RESOLVED** | `AssistantPage` calls real `/api/assistant/chat`, real `/api/voice/recordings`, real upload URL flow. No more `AI_REPLIES` dict. |
| 6 | Voice/STT pipeline is a stub | **RESOLVED for file-based path** | `OpenAiWhisperProvider` is the production transcription provider in `voice/transcription-providers.ts`. Streaming `DeepgramStreamingProvider` scaffolded; full streaming integration is Phase 8B/8C. |
| 7 | Mock payment provider in production code | **RESOLVED** | `createPaymentLinkProvider` (P5-017) throws in `production` / `staging` if `STRIPE_SECRET_KEY` is missing. Real Stripe Payment Links + `checkout.session.completed` webhook with idempotency are live. |
| 8 | Settings page is all stubs | **PARTIALLY OPEN** | 13 `action: () => {}` handlers remain in `components/settings/SettingsPage.tsx`. |
| 9 | Dispatch board drag-and-drop not wired | **RESOLVED** | `DispatchBoard.tsx:180-198` implements `handleDropOnLane` + `handleDropOnUnassigned`, wired via `TechnicianLane`/`UnassignedQueue`. Proposal-creation hook lives in `useCreateScheduleProposal`. |
| 10 | No E2E tests | **RESOLVED for top journeys** | 8 Playwright specs: `smoke.spec.ts`, `journeys/signup-to-first-estimate`, `journeys/estimate-approval-execution`, `journeys/invoice-to-payment`, plus a 4-spec QA matrix. |
| 11 | No global error boundary / toast provider | **RESOLVED** | Sonner Toaster + error boundary wired (per PR history; verify in `App.tsx`). |

---

## What Actually Shipped Late April → Early May

From `git log` and `docs/remaining-features.md` cross-referenced against code:

| Feature | Where |
|---|---|
| Stripe Payment Links + invoice checkout | `payments/stripe-payment-link.ts`, `routes/public-portal.ts` |
| `checkout.session.completed` webhook + idempotency | `webhooks/routes.ts` (PgWebhookEventRepository) |
| Public invoice payment page (token-scoped, `/pay/:token`) | `web/.../InvoicePaymentPage.tsx`, `routes/public-portal.ts`, P5-016 |
| Public estimate approval page (`/e/:token`) | `web/.../EstimateApprovalPage.tsx` |
| Twilio SMS + SendGrid email `/send` endpoints | `notifications/`, recent PRs #310/#311/#312 |
| 12 Stripe / public-invoice edge-case hardening fixes | various |
| 6-repo Postgres pool ternary wiring (P0-023) | `app.ts:572-646` (continued; now 37 ternaries) |
| Telephony tenant-aware `/api/telephony` (PR #312) | `routes/telephony` |
| Twilio number-purchase + attach idempotency (PR #310) | `integrations/twilio/provisioning` |
| Gateway WebSocket resilience (PR #309/#311) | `ai/gateway/` |
| Logging redaction + worker diagnostics + monitoring (PRs #301–#306) | `logging/`, `monitoring/` |
| Voice-onboarding plan scaffold (PR #79) | `web/.../onboarding`, `web/.../estimates`, `web/.../jobs` |
| Phase 8 calling-agent state machine scaffold | `ai/agents/customer-calling/state-machine.ts` + `transitions.ts` + `voice-session-store.ts` + `inapp-adapter.ts` + `types.ts` |
| Removed redundant `PaymentReadinessRepository` (this branch) | `payments/stripe-payment-link.ts`, `invoices/payment-readiness.ts` slimmed to `assessPaymentReadiness` |

---

## REMAINING WORK (May 6 forward)

### Tier 1 — Phase 8 Customer Calling Agent (largely shipped)

> **Reality check 2026-05-06:** when this audit dug into the calling-agent
> directory, ~13 of the 14 Phase 8 stories had implementation in
> `packages/api/src/ai/agents/customer-calling/`,
> `packages/api/src/ai/skills/`, `packages/api/src/telephony/`, and
> `packages/api/src/routes/telephony.ts` + `routes/voice-sessions.ts`.
> Hardening, end-to-end load testing, and the Tier 3 prompt-engineering
> follow-ups below are the actual remaining work.

**Wave 8A — shipped:** P8-001 (`ai/resolution/pg-entity-resolver.ts`),
P8-002 (`compliance/business-hours.ts` + `dnc.ts` + `jurisdiction.ts` +
`ai/skills/enforce-compliance.ts`), P8-003 (`ai/skills/session-cost-tracker.ts`),
P8-004 (FSM in `ai/agents/customer-calling/state-machine.ts` +
`transitions.ts`), P8-005 (`ai/skills/disclose-recording.ts`),
P8-006 (`ai/skills/identify-caller.ts`), P8-007 (`ai/skills/confirm-intent.ts`),
P8-008 (`ai/skills/escalate-to-human.ts` in-app variant).

**Wave 8B — shipped:** P8-009 (`routes/voice-sessions.ts` +
`ai/agents/customer-calling/inapp-adapter.ts`, mounted in `app.ts:1843`),
P8-010 (`ai/skills/summarize-session.ts`), P8-011 (`routes/telephony.ts`
+ `telephony/twilio-adapter.ts`, Gather mode at `/api/telephony/voice` +
`/api/telephony/gather`).

**Wave 8C — shipped:** P8-012 (`telephony/media-streams/` —
`mulaw-codec.ts`, `mediastream-adapter.ts`, `twilio-mediastream-server.ts`,
4 dedicated test files, gated behind `TWILIO_MEDIA_STREAMS_ENABLED`),
P8-013 (`telephony/twilio-call-control.ts` + `OnCallRepository.listRotation`
integration), P8-014 (`telephony/recording-webhook.ts`, mounted at
`/api/telephony/recording`, `voice_recordings` table + S3 upload).

**Remaining Phase-8 tasks:** end-to-end load testing of the Media Streams
path, real-call transcript regression suite, post-launch cost tuning, and
the Tier 3 prompt-engineering follow-ups below.

### Tier 2 — Voice provider upgrades (1A / 1B)

| Story | Why | Where |
|---|---|---|
| **DeepgramStreamingProvider** (backend, calling agent) | Whisper is file-based (1–3 s); real-time agent needs ~300 ms via WebSocket. | `voice/transcription-providers.ts` (Deepgram class scaffolded) |
| **ElevenLabsTtsProvider** (streaming TTS) | OpenAI `tts-1` buffers full audio (~800 ms TTFA); ElevenLabs streams (~250 ms TTFA). | `ai/tts/tts-provider.ts` |

### Tier 3 — Domain knowledge gaps (close *during* Phase 8 build)

Prompt-engineering + data-wiring tasks that make the calling agent sound like
it knows home services. From `remaining-features.md` §3.

| ID | Gap | Status / Fix |
|---|---|---|
| 3A | No `emergency_dispatch` intent | **DONE** — present in `ai/orchestration/intent-classifier.ts` (15th intent). Fast-path in FSM via `transitions.ts` `intent_capture → escalating` on `emergency_dispatch`. |
| 3B | Vertical terminology not injected into agent prompts | **HELPER LANDED** — `formatVerticalForCallerPrompt()` in `verticals/context-assembly.ts`. Wire-up into `intent-classifier`'s `SYSTEM_PROMPT` is the next slice. |
| 3C | No maintenance-plan / membership awareness | OPEN — extend `buildCallerContext()` in `ai/orchestration/context-builder.ts` to query active contracts; pass `{ hasActivePlan, planType, nextServiceDue }` to FSM. |
| 3D | No service-type disambiguation templates | OPEN — add `intake_questions` array to `VerticalPack` + per-pack defaults in `verticals/packs/{hvac,plumbing}.ts`. |
| 3E | No objection-handling scripts | OPEN — add `objection_scripts` to tenant settings + per-vertical defaults; classifier emits `objection_detected` event. |

### Tier 4 — Finite UI polish

| Item | Status |
|---|---|
| 13 settings page handlers still `action: () => {}` | **5/13 closed** end-to-end (Business profile, Language & region, Estimate & invoice templates, Terminology, AI approval rules — both data plane + actually-affects-routing wire-up). 8 remain: Reminders & follow-ups (timing knob), Team members, Roles & permissions, Payment methods, Deposit rules, Rivet subscription, Calendar sync, Zapier. Several need backend extensions or external OAuth. |
| Conflict-visibility badges on appointment cards (P6-026) | **DONE** — `AppointmentCard` accepts `hasConflict?` and renders an aria-labeled "Conflict" badge; `DispatchBoard` computes overlap pairwise per technician lane and threads the set through `TechnicianLane`/`UnassignedQueue`. |
| Board refresh after proposal execution (P6-027) | **DONE** — `DispatchBoard` calls `refetch()` after a successful proposal POST, plus on `visibilitychange` and `window.focus` so cross-tab approvals show without a manual reload. |
| Template management UI in settings (P4-014) | **DONE** — `TemplatesPage.tsx` (961 lines) at `/settings/templates` ships an AI-suggestion review flow, accept/skip controls, weekly digest settings, per-template editing. The settings-page entry that pointed at this destination as a stub now navigates correctly. |
| Conversation state persistence across navigation (P3-019) | **DONE** — `AssistantPage.tsx` reads `conversationId` from URL searchParams or localStorage on mount; writes it on creation; clears it on explicit reset. URL + storage both hydrate. |
| Quick-settings toggle persistence | **DONE** (bonus) — `autoApplyInternalUpdates` and `autoSendAppointmentReminders` columns added (migration 075); spanish-mode toggle bound to `/api/settings/language`; failed PUT reverts the local toggle and shows a Sonner toast. |

### Tier 5 — Operational / hardening backlog

| Item | Why it matters |
|---|---|
| Dependency audit (P7-020) | Old `glob`, deprecated `async`, `superagent` flagged. |
| Rollback runbook (P7-022) | Pipeline exists; procedure isn't documented. |
| Production smoke-test script (P7-023) | Manual today; needs `npm run smoke-test`. |
| Load test (P7-025) | 50-concurrent-user simulation against staging. |
| 8 `as any` escapes (P7-024) | Catalogued; cosmetic. |
| Original P7 integrations (~10 stories) | QuickBooks sync, Zapier, support tooling, feature flags UI, degraded mode, backup/recovery, launch checklist. |

### Tier 6 — Edge cases (non-blocking)

From the 30-item audit in `remaining-features.md` §5: 9 low-priority items in
`public-invoices.ts`, `webhooks/routes.ts`, `InvoicePaymentPage.tsx`,
`invoice.ts` (token-guard logging, Zod-validate webhook payloads,
`formatMoney` negative guard, etc.).

### Tier 7 — Open product questions

§6 of `remaining-features.md`: should `sendInvoice` on a draft auto-transition
to `open` (calling `issueInvoice()` for `issuedAt` + `dueDate`)? Three options
spelled out; decision pending.

---

## DETAILED MODULE STATUS

### Backend (`packages/api/src/` — ~77,000 lines)

| Module | Status | Persistence |
|---|---|---|
| customers/ | Production | Postgres (`PgCustomerRepository`) |
| locations/ | Production | Postgres |
| jobs/ + job-photo + job-lifecycle | Production | Postgres |
| appointments/ + assignments | Production | Postgres |
| estimates/ + approvals + edit-deltas | Production-grade | Postgres |
| invoices/ + payments + payment-readiness helper | Production | Postgres (readiness now derived from invoice cols) |
| proposals/ + handlers + execution | Production-grade | Postgres (incl. `executing` status migration 072) |
| conversations/ | Production | Postgres |
| voice/ — file STT (Whisper) | Production | Postgres |
| voice/ — streaming STT (Deepgram) | Scaffolded | — |
| ai/ + gateway + orchestration + tts | Production-grade | Postgres |
| ai/agents/customer-calling/ | Scaffold (FSM + adapter + store + transitions + types) | In-flight |
| verticals/ + bundles + packs | Production | Postgres |
| templates/ | Production | Postgres |
| settings/ + pack-activation | Production | Postgres |
| audit/ + lookup-events | Production | Postgres |
| notes/ | Production | Postgres |
| quality/ + metrics | Production | Postgres |
| payments/ — Stripe links | Production | Stripe + invoice cols (readiness layer removed) |
| payments/ — Stripe PaymentIntent / Elements | Production (P5-016) | — |
| routes/ (public-portal, public-payments, telephony, etc.) | Production | — |
| auth/ — Clerk JWT + RBAC + bootstrap | Production | Postgres tenants |
| webhooks/ — Clerk + Stripe + Twilio | Production | Pg idempotency |
| db/ — pool + migrations + RLS | Production | Real Postgres |
| dispatch/ + analytics | Production | Postgres |
| availability/ | Production | Postgres |
| feedback/ + feedback-response | Production | Postgres |
| files/ + job-files | Production | Postgres |
| catalog/ | Production | Postgres |
| flags/ — feature flags | Production | Pg repo + in-memory hot cache |
| oncall/ — rotation | Production | Postgres |
| portal/ — customer portal sessions | Production | Postgres |
| time-tracking/ — time-entry | Production | Postgres |
| telemetry/ — technician location pings | Production | Postgres |
| agreements/ + agreement-runs | Production | Postgres |
| notifications/ — Twilio SMS + SendGrid email | Production | — |
| integrations/twilio (provisioning, telephony) | Production, tenant-aware | Postgres |
| compliance/, learning/, logging/, monitoring/, middleware/, queues/ | Production / hardened recently | Mixed |

### Frontend (`packages/web/src/` — ~44,000 lines)

| Area | Status |
|---|---|
| Auth — `<ClerkProvider>` + `LoginPage` + `SignupPage` + `ProtectedRoute` + `AuthTokenBridge` | Working |
| Shell / layout | Working (Clerk user data) |
| Dashboard (HomePage) | Working |
| Jobs | Working — full CRUD, multiple views, real API |
| Customers | Working — full CRUD, search, archive |
| Leads | Working |
| Estimates | Working — line items, proposals, approvals |
| Invoices | Working — proposal review, send |
| Payments — list + InvoicePaymentPage (Stripe Elements) | Working |
| Dispatch board — DnD wired to schedule proposals | Working (badges/refresh polish open) |
| Conversations | Working — real `/api/assistant/chat` |
| AssistantPage / AI | Working — real API + real voice recording flow |
| Voice capture | Working (file upload → Whisper); streaming agent path is Phase 8B/8C |
| Settings | **Partial** — 13 stubs remain |
| Onboarding | Working — voice-onboarding plan landed (PR #79) |
| Estimate Approval (token-scoped) | Working |
| Invoice Payment (token-scoped, Stripe Elements) | Working |
| Intake Form | Working |
| E2E tests (Playwright) | 8 specs covering smoke + 3 customer journeys + 4-spec QA matrix |

---

## NEW GAP STORY SUMMARY

The 36 gap stories from the Apr 29 doc are mostly closed. Open work tracked in:

- `docs/stories/phase-8-gap-stories.md` — calling agent
- `docs/stories/phase-9-gap-stories.md`, `phase-10-…`, `phase-11-…` — newer expansions
- `docs/remaining-features.md` — lighter-weight tracking of voice upgrades + domain knowledge + edge cases

Original P0 gaps (P0-019 through P0-032): all resolved except minor polish.
Original P1/P2/P3/P4/P5/P6 gap stories: ~85% resolved; remaining items are
in Tier 4 (UI polish) above.

---

## RECOMMENDED EXECUTION ORDER

### Now — Sprint A (active)
**Phase 8 hardening + Tier 3 prompt wire-up** — Wire
`formatVerticalForCallerPrompt` (3B helper, landed 2026-05-06) into
`intent-classifier`'s `SYSTEM_PROMPT` so per-tenant terminology actually
reaches the LLM. Add Media Streams transcript regression fixtures.
Outcome: agent uses tenant vocabulary; Media Streams path validated
under load.

### Next — Sprint B
**Tier 3 (3C + 3D + 3E) + Tier 2** — Plan-awareness via `buildCallerContext`
(3C), per-vertical `intake_questions` (3D), per-vertical `objection_scripts`
(3E). Then upgrade to Deepgram streaming STT + ElevenLabs streaming TTS
(Tier 2) for sub-800 ms TTFA. Outcome: vertical-aware agent at competitive
latency.

### Then — Sprint C
**Tier 4 — UI polish** — Mostly shipped: 5/13 settings stubs closed
end-to-end, Quick-toggle persistence wired, conflict-visibility badges
live, board-refresh-after-execution + on-focus live, conversation state
persistence across navigation verified, Templates page already
shipping. Remaining: 8 settings stubs (most need backend extension or
external OAuth), Reminders timing knob, optional polish items.

### Polish — Sprint D
**Tier 5 — Operational hardening** — dependency audit, rollback runbook,
production smoke-test script, load test, `as any` cleanup.

### Final — Sprint E (beta hardening)
**Original P7-001..018** — QuickBooks sync, Zapier, support tooling,
feature-flag UI, degraded-mode, backup/recovery, launch checklist.

---

## VERIFICATION PLAN (status)

1. **Data persistence:** ✅ verified via 37 Pg ternaries + Pg integration tests.
2. **Auth:** ✅ Clerk SDK on web, JWT verify on API, tenant bootstrap on signup.
3. **RLS:** ✅ tenant context middleware + RLS policies in migrations.
4. **AI:** ✅ AssistantPage hits real `/api/assistant/chat`; gateway has 3,100+ lines incl. provider routing, failover, caching, eval.
5. **Voice (file):** ✅ OpenAI Whisper provider; streaming path is Phase 8B/8C.
6. **Payments:** ✅ Stripe test mode end-to-end; webhook idempotent.
7. **Dispatch:** ✅ DnD → schedule proposal; conflict badges/refresh polish open.
8. **Settings:** ⚠️ Partial — 13 stubs.
9. **E2E:** ✅ 8 Playwright specs covering signup → estimate → approval → invoice → payment.
10. **Load:** ❌ not run yet (P7-025).
11. **Smoke:** ❌ no `npm run smoke-test` yet (P7-023).
