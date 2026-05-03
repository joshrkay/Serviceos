# Ship-This-Week Analysis — 2026-05-03

**Audience:** founders / lead engineer
**Goal:** an AI-driven, voice-first OS for the trades — call comes in → AI books → tech goes out → estimate → invoice → paid, all voice-driven, all proposal-gated.
**Context:** evaluate where we are vs. seven days ago, identify the real blockers to a contractor logging in this week, and lay out a hardening + ship plan.

---

## 0. TL;DR

**Velocity is real.** In the last 7 days we merged P8 (full voice/telephony stack), P9 (CRM expansion: leads + timeline + recurring agreements), P11-001 (voice lookup skill family + intent routing) and P11-006 (UI create forms), plus the RAG corpus foundation (Phases 1+2) and the lead-to-cash attribution loop. ~30+ PRs, 60K+ lines net. Schema sits at migration **062**.

**The good news:** the launch-blocker quartet from `plan.md` (G1-G4) is *almost* done — `PgProposalRepository`, `useUser()` in Shell, `ProtectedRoute`, all wired. The Stripe stack (intent + link + webhook + reconciler) and the Twilio stack (gather, media-streams, recording, escalate, on-call) are present and tested.

**The bad news — we are NOT ship-ready.** Five hard blockers remain:

| # | Blocker | Severity | Fix size |
|---|---------|----------|----------|
| B1 | Supabase project is **INACTIVE** (paused) | 🔴 launch-stop | 5 min |
| B2 | Voice `create_customer`/`create_job`/`draft_estimate`/`update_customer` handlers return synthetic uuids — **don't persist** | 🔴 data-loss | 1 day |
| B3 | `ProposalExecutor` is constructed with `idempotencyGuard = undefined` → queue redelivery double-fires mutations | 🔴 data-corruption | 2 hr |
| B4 | `NoopInvoiceDeliveryProvider` silently swallows "send invoice" when `sendService` isn't configured in prod | 🔴 silent-failure | 1 hr |
| B5 | `cors({ origin: config.CORS_ORIGIN ?? true })` — wildcard fallback in prod (G4 still open) | 🟠 security | 30 min |

These five fixes are the entire P0 for ship-this-week. Everything else is hardening or scope-creep.

---

## 1. Where we were 7 days ago vs. today

### Then (~2026-04-26)
- P8 voice stack was mid-build: prework merged, P8-001/002/003/006/007/008 in flight as standalone skills, no media-streams, no recording, no escalation routing.
- Lead pipeline didn't exist.
- Customer timeline didn't exist.
- Service agreements / recurring revenue didn't exist.
- No RAG retrieval for voice context.
- Voice lookup intents (balance, appointment, invoice, account summary) didn't exist.
- UI create forms were proposal-only — no manual create paths in the office UI.

### Now (2026-05-03)
- **Voice telephony complete (P8-001 → P8-014):** Twilio inbound webhook, Gather adapter, Media Streams live audio, recording → S3, escalate_to_human + on-call <Dial>, identify_caller, confirm_intent, enforce_compliance (DNC + business hours), SessionCostTracker, summarize_session, fuzzy entity resolution.
- **CRM expansion (P9-001/002/003):** lead pipeline with attribution chain, unified communication timeline, service agreements with auto-recurring jobs/invoices.
- **Lead-to-cash:** end-to-end source attribution from intake form → lead → customer → job → invoice → revenue-by-source report.
- **Voice lookup (P11-001):** lookup_appointments / invoices / balance / jobs / agreements / account_summary skills, intent classifier knows the new intents, audit log for every lookup.
- **UI create forms (P11-006):** Invoice / Estimate / Job creation with shared `LineItemEditor` + `CustomerPicker`.
- **RAG corpus (Phases 1+2):** `knowledge_chunks` with pgvector, scrubber, retrieve-context skill; capture schema for turns/executions/outcomes/eval runs.

This is a *lot*. The thing we have not yet done is **prove the seam** — call → book → dispatch → estimate → invoice → paid in one continuous voice-driven session with a real contractor.

---

## 2. State of the four pillars

### 2.1 Database (Supabase)

- **62 migrations applied**, all idempotent, immutability test in place.
- All tenant-scoped tables have `tenant_id NOT NULL` + RLS. **Coverage: 52/56 tenant-relevant tables.**
- Money is **integer cents everywhere** (estimates, invoices, payments, agreements, leads). No float in money columns.
- pg_trgm fuzzy-search indexes on customer names, job summaries, invoice numbers.
- pgvector ANN index on `knowledge_chunks.embedding`.
- Idempotency keys on `proposals`, `webhook_events`, `message_dispatches`.

**Schema gaps for the voice→cash dream:**
| Table | Why we need it | Severity |
|---|---|---|
| `webhook_events` lacks `tenant_id` + RLS | Stripe / Twilio webhooks are global — application code is the only tenant guard | 🟠 |
| No `voice_sessions` table | FSM state lives in process memory; restart loses context mid-call | 🟠 |
| No `payments_refunds` | Refund state is flat in `payments.status='refunded'`; no amount, reason, processor id | 🟡 |
| No `technician_sessions` | No structured "tech arrived → started → completed" mobility data | 🟡 |
| No `voice_recordings.escalation_reason_code` | Outcome is terminal but reason-coded escalations are blank | 🟡 |
| No intermediate job states (`estimate_pending`, `awaiting_payment`, `ready_to_dispatch`) | Status enum is too coarse to drive dispatcher UI | 🟡 |

**Live Supabase state:** project `qiofhpvkapjacwhbfqlr` (joshrkay@gmail.com) — **status: INACTIVE / paused.** Must be restored before we cut over a real tenant.

### 2.2 API (packages/api)

- **Route surface is mature:** auth, customers, leads, jobs, schedule, dispatch, estimates, invoices, payments, agreements, voice/telephony, AI gateway, webhooks, admin.
- **AI gateway** routes through `packages/api/src/ai/gateway` with provider fallback, cost tracking, intent classifier, RAG retrieve-context, proposal generation.
- **Stripe stack present:** `payments/stripe-payment-intent.ts`, `stripe-payment-link.ts`, `stripe-webhook-handler.ts`, `invoice-payment-reconciler.ts`. Real, not stubs.
- **Twilio stack present:** `telephony/twilio-adapter.ts`, `twilio-signature.ts`, `recording-webhook.ts`, `media-streams/twilio-mediastream-server.ts`, `twilio-call-control.ts`.
- **Background workers:** PgQueue is the prod default (per ADR P0-028). Async jobs: recording transcription, lead enrichment, recurring agreement runs, proposal correction, scheduling confirmations.

**API gaps blocking ship:**
1. **Voice creation handlers don't persist** (`packages/api/src/proposals/execution/handlers.ts:51,63,78,189`). `CreateCustomerExecutionHandler`, `UpdateCustomerExecutionHandler`, `CreateJobExecutionHandler`, `DraftEstimateExecutionHandler` all return `uuidv4()` and write nothing. The proposal looks "executed" but no row exists. **A contractor saying "add Jane Doe and book her tomorrow" gets a green checkmark in the UI and no customer.** This is the single most embarrassing failure mode we ship with.
2. **`IdempotencyGuard` is not wired** (`packages/api/src/app.ts:720` passes `undefined`). The guard exists at `proposals/execution/idempotency.ts` and the constructor takes it — it just isn't passed. Queue redelivery (which will happen) → double-create.
3. **`NoopInvoiceDeliveryProvider` is the prod fallback** (`app.ts:696-698`) — when `sendService` isn't configured, "send invoice" returns success and no SMS/email goes out. No `NODE_ENV === 'prod'` fail-fast.
4. **CORS wildcard fallback** (`app.ts:344`: `origin: config.CORS_ORIGIN ?? true`). If env not set in prod → world-open.

### 2.3 Web (packages/web)

- **Office routes:** assistant, jobs, schedule, customers, leads, estimates, invoices, contracts, interactions, settings, revenue-by-source.
- **Tech route:** `/technician/day` (GPS-aware appointment list).
- **Public routes:** `/e/:id` (estimate approval + signature), `/pay/:id` (Stripe embedded), `/intake`, `/public/feedback/:token`.
- **Auth:** Clerk + ProtectedRoute + AuthTokenBridge. 401 auto-retry. Sign-out wired.
- **State:** custom `useMutation`/`useListQuery`/`useDetailQuery` hooks on top of `useApiClient`. No TanStack/Zustand.
- **AI proposal UI:** `AIProposalCard` renders 10 proposal types with approve/reject/edit-inline. Confidence bars surface "Review recommended" on medium scores.
- **Dispatch board exists** (`pages/dispatch/DispatchBoard.tsx`) with drag-drop reassignment — but **not in nav**.

**Frontend gaps blocking ship:**
1. **DispatchBoard not reachable** from the nav. The single most operational page in the app, hidden.
2. **Tech mobile flow is a desktop page in disguise.** `TechnicianDayPage` has no responsive breakpoints, no app shell, no offline cache, no on-site estimate→invoice→capture-payment flow. `CameraCapture` and `EstimateForm` exist but aren't integrated for the field tech.
3. **Signature capture only on customer-facing approval page** — not in the tech's on-site estimate.
4. **No SMS template UI** — no compose flow for booking confirmations / payment reminders / "tech is on the way".
5. **No proposal review queue** — proposals only surface in the assistant chat; no "20 proposals pending — batch review" page.
6. **No live transcript** during voice sessions — transcript shows up post-upload.
7. **No customer self-service portal dashboard** — public token URLs work for one-off estimate/invoice/payment, but no "my account" hub. (P10-001 is documented but not dispatched.)

### 2.4 AI / Voice

- **Skills registry covers most of the voice→cash loop:** identify_caller, confirm_intent, enforce_compliance, book_appointment, availability_finder, escalate_to_human, summarize_session, record_call, retrieve_context, lookup_* family.
- **Adapters unified** via `VoiceSessionStore`: in-app voice, Twilio Gather, Twilio Media Streams (live audio behind feature flag).
- **Cost guards:** `SessionCostTracker` enforces per-session token + duration caps.
- **Compliance:** business hours + DNC list per tenant.
- **Proposals are typed + Zod-validated.** Confidence scores drive review-required UI.

**AI/voice gaps blocking ship:**
1. **Persistence gap (B2)** — voice books a "new customer" → uuid that doesn't exist. End-to-end voice flow visibly broken.
2. **No persistent voice session state** — restart kills mid-call context (DB schema gap, see 2.1).
3. **P11-002 (Spanish i18n) not started** — single-language for now is fine for week-one launch but flag.
4. **No live cost meter / escalate button** in the in-app voice UI — user can't kill a runaway session.

---

## 3. Hardening dimensions (cross-cutting)

| Dimension | State | Gap |
|---|---|---|
| **Auth** | Clerk + ProtectedRoute + token-bridge wired; reverse guard on `/login` open | Add reverse guard so signed-in users don't see login page |
| **Tenant isolation** | RLS on 52/56 tables; SET LOCAL via tenant-context middleware (P0-024) | `webhook_events` has no tenant_id; verify every public route validates tenant from token, not query param |
| **Idempotency** | Schema-level on `proposals`, `webhook_events`, `message_dispatches`; `IdempotencyGuard` class exists | **Not wired into `ProposalExecutor` (B3).** Queue redelivery → double-create |
| **Audit** | `audit_events` table + `proposal_executions` row on every execution; correlation_id | Verify every mutation handler emits an audit event; no silent paths |
| **Rate limits** | Login throttle present | No per-tenant API rate limit; no per-token rate limit on public portal/payment links |
| **Webhook signature verification** | Twilio signature verifier (`telephony/twilio-signature.ts`); Stripe webhook handler verifies | Confirm both reject on missing/invalid sig in prod (no dev-bypass) |
| **Money correctness** | Integer cents everywhere, `formatCents` helper | No `payments_refunds` table — refund flow undefined |
| **PII / scrubbing** | RAG `knowledge_chunks` runs through scrubber; voice transcripts in `voice_recordings` | Confirm phone/email/address scrub coverage in transcripts before they hit `knowledge_chunks` |
| **Observability** | `quality_metrics`, `provider_health`, `ai_runs.token_usage`, structured logs | No live dashboard; no SLO definition; no alerting wired (Sentry? PagerDuty? unknown) |
| **Error budget / on-call** | `tenant_oncall_rotation` exists for telephony escalation | No internal on-call rotation for ServiceOS itself; no runbook for "AI dropped a call" / "Stripe webhook 500ed" |
| **Backup / disaster recovery** | Supabase managed Postgres backups | No documented restore drill; no point-in-time recovery test |
| **Multi-tenant onboarding** | Clerk webhook → tenant creation untested per TODOS.md | Smoke test before any second tenant signs up |

---

## 4. Open vs. shipped story inventory

### Shipped in last 7 days (merged to main)
P8-001..014 (full voice stack), P9-001 (leads), P9-002 (timeline), P9-003 (agreements), P11-001 (voice lookup), P11-006 (UI create forms), RAG Phase 1, RAG Phase 2, lead-to-cash attribution.

### Documented & dispatch-ready, not yet executed
- **P10-001** — Customer self-service portal (migration 059 reserved). Wave 10A.
- **P10-002** — Customer dashboard. Parallel after P10-001.
- **P10-003** — Reviews / NPS. Parallel after P10-001.
- **P11-002** — Multilingual / Spanish i18n across the voice stack. Wave 11B (large diff, single agent).
- **P11-007** — UI edit forms (Invoice/Estimate/Job edit). Wave 11C-2, after P11-006.
- **P11-008** — UI compose flow (notes / send). Wave 11C-3, parallel with 11C-2.
- **P0-035** — `pg_queue_dlq_cleanup` worker. Standalone.

### Documented as deferred (do NOT ship this week)
- Executor double-execution `SELECT...FOR UPDATE` claim (TODOS.md). Only matters once we run >1 dyno; we're on Railway single-dyno.
- Multi-tenant horizontal scale.

---

## 5. Ship-this-week plan

The week needs three layers:

**Layer A — make-it-work (P0 blockers, ~2 days):** the five blockers above. Without these we ship a confidently broken product.
**Layer B — make-it-safe (P1 hardening, ~1.5 days):** the highest-risk holes that aren't blockers but would burn us in week one.
**Layer C — make-it-feel-real (P2 polish, ~1.5 days):** the smallest set of UX additions that turn the demo into a product a contractor would actually use.

### Day-by-day (5 working days)

#### Monday — kill the data-loss blockers
- **B1 (5 min):** Restore Supabase project from inactive → active. Confirm migrations are at 062. Run advisors.
- **B2 (full day, single focused agent):** Wire voice creation handlers to real repos. Pattern is documented in `docs/superpowers/plans/2026-04-23-production-readiness-blockers.md` Phase 1. Four handlers, four tests, one app.ts wiring change.
  - `CreateCustomerExecutionHandler(customerRepo)` — write through; map `payload.name` → `firstName/lastName/companyName`.
  - `UpdateCustomerExecutionHandler(customerRepo)` — write through.
  - `CreateJobExecutionHandler(jobRepo)` — write through; link `originating_lead_id` if present.
  - `DraftEstimateExecutionHandler(estimateRepo)` — persist with `status='draft'`, set `view_token`.
  - Update `createExecutionHandlerRegistry` deps; pass them in `app.ts:702`.
  - Tests: real-repo round-trip per handler.
- **B3 (2 hr):** Wire `IdempotencyGuard`. Build `new IdempotencyGuard(proposalRepo)`, pass as 3rd arg to `new ProposalExecutor(...)` at `app.ts:717`. Add executor test for "duplicate idempotency_key short-circuits".
- **B4 (1 hr):** Fail-fast on Noop invoice delivery. In `app.ts:696-698`, throw at boot when `NODE_ENV === 'prod' && !sendService`. Keep Noop for tests.
- **B5 (30 min):** CORS guard. Replace `origin: config.CORS_ORIGIN ?? true` with strict allowlist; throw at boot if `NODE_ENV === 'prod' && !config.CORS_ORIGIN`.

End-of-day verification gate:
```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npm test
cd packages/web && npm test -- --run
```

#### Tuesday — hardening pass
- **H1:** Add `tenant_id` + RLS to `webhook_events`. Migration 063. Backfill from payload where derivable; null where not (Stripe signing-secret-validated payloads contain customer_id → tenant_id lookup).
- **H2:** Confirm Twilio + Stripe webhook signature verification rejects in prod when missing/invalid (no dev-bypass leaking). Add explicit test.
- **H3:** Add per-token rate limit (in-memory token bucket, 60/min) to public portal + payment-link routes.
- **H4:** Reverse auth guard on `/login` and `/signup` — signed-in users redirect to `/`.
- **H5:** Clerk webhook → tenant-creation smoke test (TODOS.md item). One e2e.
- **H6:** Confirm voice transcript scrubber catches phone/email/address before `knowledge_chunks` write. Add fixture + unit test.

#### Wednesday — make the operational seam visible
- **U1:** Add **DispatchBoard to nav** (route is registered, page exists, just hidden). One line in Shell.
- **U2:** Add **proposal review queue page** at `/proposals` — list of `status='ready_for_review'`, batch approve/reject. ~150 LOC, reuses `AIProposalCard`.
- **U3:** Add **live cost meter + "stop session" button** to in-app voice UI — read from `SessionCostTracker`.
- **U4:** Add **live transcript display** during in-app voice (websocket or poll). Reuses media-streams transport.

#### Thursday — tech mobile minimum
- **T1:** Make `/technician/day` mobile-responsive (Tailwind sm:/md: breakpoints, large tap targets).
- **T2:** Wire `CameraCapture` into the job detail page for photo upload (existing `PhotoBucket` is a stub).
- **T3:** Wire signature capture into a tech-side "sign-off" flow for completed work.
- **T4:** "Take payment" button on the tech's job view → opens `/pay/:id` (existing public flow) in a new tab, prefilled.

(Goal: a tech can do photos + signature + payment from a phone. Not a native app — a real responsive web flow.)

#### Friday — soak + go-live drill
- **G1:** Run a scripted end-to-end: inbound call → AI books → dispatch reassign → tech arrives (mock GPS) → on-site estimate → convert to invoice → SMS payment link → Stripe pay → reconciler closes invoice → revenue-by-source updates. Capture every break.
- **G2:** Restore drill: take a Supabase point-in-time snapshot, restore to a branch, verify integrity.
- **G3:** Set up Sentry (or equivalent) for API + web, alerting to a Slack channel. Wire one runbook ("AI dropped a call" / "Stripe webhook failed") to a markdown doc + on-call.
- **G4:** Cut a `v1.0.0` release tag. Update `README.md` + a one-page operator runbook.

### Cut from this week (defer to next)
- P10 portal trio (P10-001/002/003) — important for self-service but not week-one critical. Public token URLs already cover the immediate "approve this estimate / pay this invoice" flows.
- P11-002 Spanish i18n — flag for week 2; English-only is acceptable launch posture.
- P11-007 UI edit forms — proposal review queue + manual create cover the gap; full edit flows can wait.
- P11-008 UI compose — out of scope week-one.
- Schema additions for `payments_refunds`, `voice_sessions`, `technician_sessions` — defer; live with current schema for week-one, plan migration 063+ for week-two.
- Executor `SELECT...FOR UPDATE` race fix — only needed at >1 dyno.
- `vertical_packs` admin UI — already shipped functional packs; admin can wait.

---

## 6. What we should consider adding (beyond the docs)

These are not in any story today but matter for "AI-driven, voice-driven, end-to-end":

1. **AI runtime kill-switch** — a tenant-level or global flag that drops voice into "human only" mode without redeploy. Today, an AI misfire requires a code rollback.
2. **Per-tenant model + prompt configuration** — `prompt_versions` exists but isn't tenant-scoped. Different trades (HVAC vs. plumbing) want different language. Already partially in `wording_preferences` and `vertical_packs`; needs a UI surface.
3. **"Why did the AI do that?" trace per proposal** — `evaluation_snapshots` captures it; we don't show it. A founder-grade debug overlay on `AIProposalCard` would 10x trust.
4. **Inbound MMS** — customer texts a photo of a leaking pipe → AI classifies → creates a lead with the photo attached. Twilio MMS is a one-day add given the existing Twilio plumbing.
5. **"Send this estimate as a video" via TTS + screen capture** — differentiator vs. ServiceTitan; not week-one.
6. **Per-call recording transcript redaction** — once we hit a payment-card-on-call moment, PCI scope appears. Today we record everything. A "pause recording during card capture" hook is cheap insurance.
7. **Webhook event replay UI** — when Stripe drops a webhook (it will), an operator should be able to replay from `webhook_events` without a script.
8. **AI-vs-human attribution on every entity** — every customer/job/invoice already has provenance hooks (`estimate_provenance`); generalize to all entities for a "% of revenue booked by AI" metric. Founders will want this number daily.
9. **Customer SMS reply → conversation thread** — today outbound SMS via Twilio is wired; inbound replies aren't routed back into the customer timeline. Closes the loop.
10. **Cold-start cache for tenant settings** — every API call reads `tenant_settings`; cache for 60s in-process. Cheap latency win.

---

## 7. Risks & open questions

1. **Persistence ship (B2) might surface latent bugs in the proposal payload shape** — `create_customer` carries `payload.name` (one string) but `CustomerRepository.create` wants `firstName/lastName/companyName + primaryPhone`. Plan doc has the mapping; verify against the voice classifier output.
2. **PgQueue retry semantics on the new persistence path** — once handlers actually write, transient DB failures will trigger retries. With `IdempotencyGuard` wired (B3), this is safe. Without B3, B2 makes things worse. **Ship B2 + B3 together, not separately.**
3. **Stripe webhook → invoice reconciler under load** — exists but not load-tested. A tenant with 50 invoices/day is fine; 500 may surface concurrency bugs in `invoice-payment-reconciler.ts`.
4. **Media-streams adapter is feature-flagged** — staying on Gather mode for week-one is the safer call. Keep media-streams off until we've soak-tested.
5. **Single Railway dyno** — fine for one tenant, breaks at horizontal scale. Don't add a second dyno without first landing the executor `SELECT...FOR UPDATE` fix.
6. **Supabase restoration may take 15-30 min once requested** — front-load Monday morning.
7. **Clerk webhook → tenant creation untested** — if a real founder signs up Friday and the webhook is silently broken, we have no tenant. Smoke test Tuesday is non-negotiable.

---

## 8. Definition of "ship-ready"

A contractor can:
1. Sign up via Clerk → tenant auto-created (verified by H5 smoke test).
2. Forward their business number to our Twilio number.
3. Receive a real call → AI greets, identifies, books an appointment that **persists** (B2).
4. See the booking in DispatchBoard (U1) and the proposal trail in the proposal review queue (U2).
5. Send a tech via the day-view, who can on a phone capture photos (T2), signature (T3), and trigger payment (T4).
6. Watch the invoice flip to paid via the Stripe webhook → reconciler (already works).
7. Survive a process restart mid-day with no double-charges (B3) and no silent send failures (B4).
8. Feel safe that another tenant can't see their data (RLS coverage + H1 webhook tenant scope).

If all eight check, we ship.

---

## Appendix A — File-by-file change manifest for Layer A (P0 blockers)

| File | Change | Story-equivalent |
|---|---|---|
| Supabase console | Restore project | B1 |
| `packages/api/src/proposals/execution/handlers.ts` | Add repo deps + persisting paths to 4 handlers | B2 |
| `packages/api/src/app.ts:702` | Pass `customerRepo`, `jobRepo`, `estimateRepo` into `createExecutionHandlerRegistry` | B2 |
| `packages/api/test/proposals/execution/handlers.test.ts` | Add round-trip tests for 4 handlers | B2 |
| `packages/api/src/app.ts:717` | Construct `IdempotencyGuard(proposalRepo)`, pass as 3rd arg to `ProposalExecutor` | B3 |
| `packages/api/test/proposals/execution/executor.test.ts` | Add duplicate-key short-circuit test | B3 |
| `packages/api/src/app.ts:696-698` | Throw at boot when `NODE_ENV==='prod' && !sendService` | B4 |
| `packages/api/src/app.ts:343-344` | Strict CORS allowlist; throw if unset in prod | B5 |

That's it. ~6-8 hours of focused work; the verification gate is the existing `tsc --project tsconfig.build.json --noEmit` plus the test suite.

---

## Appendix B — Multi-session supervisor model (architecture refinement)

The original plan implied a single-rail "AI handles a call, human reviews after" loop. Per founder direction, the actual model is:

- **AI operator = per-conversation, ephemeral.** Customer connects (voice / SMS / MMS) → spin up a dedicated AI operator instance for that conversation. Customer disconnects → instance ends. **No queue. No hold.** If 10 customers arrive simultaneously, 10 AI operators run concurrently.
- **Human supervisor = one watcher over N.** A single human (founder or CSR) watches all concurrent AI sessions on one screen and approves across all of them. The human is *not* per-conversation.
- **Capacity target this week: 4 concurrent AI sessions** supervised by 1 human. Test for that, design for it, alert if we exceed it.

### Supervisor UI — the wall of sessions

Not a co-pilot view; a multi-panel session wall. Each panel shows live transcript + live draft proposal + confidence + approve/edit/reject controls. The human can focus a panel (click) and direct voice commands at the focused session ("approve", "change to 3pm").

### Three new product requirements that fall out of this model

1. **Auto-approve threshold per tenant.** A human can't realistically eyeball 4 simultaneous proposals every 20 seconds. High-confidence proposals (e.g. ≥ 0.9) auto-approve after a 10-second visible countdown unless cancelled. Low/medium always wait for click. **New:** add `tenant_settings.auto_approve_threshold` (numeric 0–1, default `null` meaning "always require click") and a per-proposal-type override map.

2. **Voice approval with session targeting.** Operator says "approve session 2" or "Jane, approve" — not just "approve". Disambiguation: focused session is the implicit target; voice utterance routes there. Falls back to button if session is ambiguous. **New skill:** `classify_operator_intent` (mirror of customer-side `confirm_intent`, P8-007). Recognized intents: `approve_current_proposal`, `edit_proposal_field`, `reject_current_proposal`, `human_takeover`, `pause_session`.

3. **Operator presence detection.** If the human looks away (no clicks for 30s, tab not visible), AI behavior shifts: lower the auto-approve threshold, escalate fresh emergencies to the on-call human via existing Twilio Dial path, and surface a "Supervisor away — N proposals pending" alert. Prevents a runaway AI booking emergencies at 2am when no one is watching.

### Schema reprioritization

`voice_sessions` table moves from "deferred" to **P1 this week**. Reason: each AI operator instance must persist its FSM state so a process restart mid-call can resume the conversation rather than orphan a customer mid-sentence. Without persistent session state, our single-dyno restart kills any in-flight call.

Proposed migration **063_create_voice_sessions**:

```sql
CREATE TABLE voice_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id),
  channel       TEXT NOT NULL CHECK (channel IN ('voice_inbound','voice_outbound','sms','mms','inapp_voice','webchat')),
  external_id   TEXT,             -- Twilio CallSid / SMS thread id / etc
  state         TEXT NOT NULL,    -- FSM state name
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  ended_reason  TEXT,             -- completed | escalated | callback_required | dropped | restart_orphan
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX voice_sessions_tenant_started ON voice_sessions(tenant_id, started_at DESC);
CREATE INDEX voice_sessions_active ON voice_sessions(tenant_id) WHERE ended_at IS NULL;
ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_sessions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`tenant_session_budget` cap — extend `tenant_settings` with `session_budget_cents_per_hour` (default e.g. 2000 = $20/hr) and `session_budget_cents_per_day`. The existing `SessionCostTracker` already enforces per-session caps; add a tenant-wide cap that triggers a hard fail (no new sessions accepted) plus an alert when tripped.

### Where 4 concurrent could break — concurrency test surface

| Layer | Risk | Verify |
|---|---|---|
| Twilio account | Per-account concurrent-call limit | Confirm number's settings; place 4 simulated inbound webhooks within 5s |
| Node event loop | Long-running LLM calls block other handlers | Audit for sync `JSON.parse` on large bodies, sync crypto, sync file I/O — all should be async/streamed |
| LLM provider rate limits | 4 sessions × continuous classification could hit per-minute caps | Check Anthropic + OpenAI org rate-limit headers; budget for sustained ~60 RPM per provider |
| Postgres pool | Default `pg` pool = 10. Proposal writes briefly hold connections | Set pool to 20+ in prod; load-test with 4 sessions writing concurrently |
| Twilio Media Streams WS | One WS per call; 4 concurrent receiving μ-law at 50 frames/s | Stress test with 4 concurrent media streams; watch CPU + dropped frames |
| Operator UI WS fan-out | One browser subscribes to N channels; reconnect logic | Open 4 sessions, force network blip, verify all 4 reconnect cleanly |
| Voice scrubber | Runs before transcript persistence; 4× CPU spike could starve | Benchmark on 60s transcript; verify p95 < 200ms |
| `SessionCostTracker` | Must be per-session-id keyed, no shared mutable map without lock | Audit for shared state |
| **Cross-session bleed** | The single bug that would kill us | Test below — non-negotiable pass criteria |
| Tenant cost runaway | 4 concurrent at $0.05–0.15/min → hundreds/hr if stuck | New tenant-wide hard cap, alarm wired |

### Concrete test harness — `qa-runner/scenarios/concurrent-supervisor.ts`

1. Fire 4 simulated Twilio inbound webhooks within a 5-second window, distinct `CallSid` + `From`.
2. Each script drives a different intent: emergency plumbing / non-urgent estimate / payment question / agreement question.
3. Assert each session writes its own `voice_recording`, `voice_session`, `ai_run`, and proposal — **zero foreign session_id cross-references**.
4. Assert a single supervisor websocket sees 4 distinct session channels with live transcript + live proposal updates.
5. Assert approving session 2 only executes session 2's proposal (idempotency keys distinct).
6. Record p50/p95 latency per turn and total cost per session.
7. **Pass criteria:** zero cross-session writes, p95 turn latency < 3s, total cost < $0.50 across all 4 sessions for a 2-minute scripted call each.

### Day-by-day adjustments

- **Wednesday (U1–U4) is now bigger.** The "live oversight UI" needs websocket transport for transcript + proposal updates *plus* multi-panel layout *plus* focus/voice-target logic. Buttons-only (no operator voice approval) for week-one is the cut. Voice approval ships week-two as a focused follow-up.
- **Thursday adds voice_sessions migration + tenant budget cap** (pulled from "next week" into this week).
- **Friday's soak replaces the single-call e2e with the 4-concurrent harness above** as the launch gate.

### What this changes about ship-readiness

The Definition of Ship-Ready (Section 8) gains two clauses:

9. **Four concurrent AI sessions can run with one human supervisor without cross-session bleed, without breaching tenant cost cap, with p95 turn latency < 3s.**
10. **A process restart mid-session resumes the AI operator from `voice_sessions.context` rather than dropping the customer mid-sentence** (or, if resume is infeasible for live audio, drops cleanly with an SMS apology + callback invitation rather than going silent).

