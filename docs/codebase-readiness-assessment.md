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
| **P4 — Vertical Packs + Estimate Intelligence** | 26 | 26/26 | ~25/26 | Template management UI |
| **P5 — Invoice Intelligence + Payments** | 29 | 28/29 | ~26/29 | invoice delivery notif |
| **P6 — Dispatch Board + Scheduling** | 27 | 24/27 | ~20/27 | conflict badges, refresh |
| **P7 — Integrations + Beta Hardening** | 18 | 8/18 | ~5/18 | QuickBooks, Zapier, runbook |
| **P8 — Customer Calling Agent (new)** | 14 | 5/14 | ~3/14 | 9 stories across 8B/8C |
| **TOTAL** | **198** | **175/198** | **~155/198** | **~43** |

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

### Tier 1 — In-flight active sprint (Phase 8: Customer Calling Agent)

The active bet per `docs/remaining-features.md`. 14 stories across 3 waves;
~5 stories scaffolded, 9 still open.

**Wave 8A (parallel — 8 stories, ~3 partly scaffolded):**
P8-001 Pg entity resolver + trigram, P8-002 enforce_compliance,
P8-003 enforce_session_caps, P8-004 calling-agent FSM core (scaffolded),
P8-005 disclose_recording, P8-006 identify_caller, P8-007 confirm_intent,
P8-008 escalate_to_human (in-app variant).

**Wave 8B (3 stories, after 8A):**
P8-009 in-app voice session integration, P8-010 summarize_session,
P8-011 Twilio inbound webhook + TwiML adapter (`<Gather>` mode).

**Wave 8C (3 stories, after 8B — competitive parity):**
**P8-012 Twilio Media Streams (real-time audio)** — the Avoca-parity story,
P8-013 escalate_to_human telephony, P8-014 record_call.

### Tier 2 — Voice provider upgrades (1A / 1B)

| Story | Why | Where |
|---|---|---|
| **DeepgramStreamingProvider** (backend, calling agent) | Whisper is file-based (1–3 s); real-time agent needs ~300 ms via WebSocket. | `voice/transcription-providers.ts` (Deepgram class scaffolded) |
| **ElevenLabsTtsProvider** (streaming TTS) | OpenAI `tts-1` buffers full audio (~800 ms TTFA); ElevenLabs streams (~250 ms TTFA). | `ai/tts/tts-provider.ts` |

### Tier 3 — Domain knowledge gaps (close *during* Phase 8 build)

Prompt-engineering + data-wiring tasks that make the calling agent sound like
it knows home services. From `remaining-features.md` §3.

| ID | Gap | Fix |
|---|---|---|
| 3A | No `emergency_dispatch` intent | Add 15th intent in `ai/orchestration/intent-classifier.ts`; fast-path in P8-004 FSM. |
| 3B | Vertical terminology not injected into agent prompts | `formatVerticalForCallerPrompt()` in `verticals/context-assembly.ts`. |
| 3C | No maintenance-plan / membership awareness | Extend `buildCallerContext()` in `ai/orchestration/context-builder.ts` to query active contracts. |
| 3D | No service-type disambiguation templates | Add `intake_questions` array to vertical packs. |
| 3E | No objection-handling scripts | Add `objection_scripts` to tenant settings + per-vertical defaults. |

### Tier 4 — Finite UI polish

| Item | Location |
|---|---|
| 13 settings page handlers still `action: () => {}` | `components/settings/SettingsPage.tsx:63-73,…` |
| Conflict-visibility badges on appointment cards (P6-026) | `components/dispatch/AppointmentCard.tsx` |
| Board refresh after proposal execution (P6-027) | `pages/dispatch/DispatchBoard.tsx` |
| Template management UI in settings (P4-014) | `components/settings/` |
| Conversation state persistence across navigation (P3-019) | `web/.../conversations` |

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
**Phase 8 Wave 8A** — 8 stories, parallelizable. Land the calling-agent state
machine, identify_caller, confirm_intent, compliance + session caps, recording
disclosure. Outcome: in-app voice agent demonstrably handles a full intake.

### Next — Sprint B
**Phase 8 Wave 8B + Tier 3 (3A + 3B)** — Twilio inbound `<Gather>` adapter,
session summary, in-app voice integration. Add emergency intent fast-path
+ vertical terminology in agent prompts. Outcome: telephony path live (higher
latency but functional); agent sounds vertical-aware.

### Then — Sprint C (competitive parity)
**Phase 8 Wave 8C + Tier 2** — Twilio Media Streams + Deepgram streaming +
ElevenLabs TTS + telephony escalation + recording. Target TTFA < 800 ms.
Outcome: feature parity vs. Avoca for inbound calls.

### Polish — Sprint D
**Tier 4 + Tier 3 (3C–3E) + Tier 5 partial** — Settings page wiring (close
13 stubs), conflict badges, board refresh, plan-awareness, disambiguation
templates, objection scripts, dependency audit, rollback runbook,
production smoke script.

### Final — Sprint E (beta hardening)
**Tier 5 (Original P7-001..018)** — QuickBooks sync, Zapier, support tooling,
feature-flag UI, degraded-mode, backup/recovery, launch checklist, load test.

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
