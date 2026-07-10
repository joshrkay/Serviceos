# Fable-Orchestrated Full-App Verification — Plan & Model Delineation

**Date**: 2026-07-10
**Orchestrator**: Claude Fable 5 (session model)
**Branch**: `claude/fable-app-verification-rmbfty`
**Results doc**: `fable-verification-2026-07-10.md` (written by this run)
**Evidence**: `fable-2026-07-10-artifacts/` (full-page PNG screenshots + DB/API assertion logs)

---

## 1. Objective

Prove, with screen-capture evidence and database-level assertions, that every
workflow the PRD (v2, 2026-05-17) commits to — and that has shipped — actually
works end-to-end on the current `main`:

1. **AI takes inbound calls** — Twilio webhook → FSM → intent classification →
   task → typed proposal (never auto-executed).
2. **AI does the quoting** — estimate drafting with catalog-grounded prices
   (LLM-invented prices overwritten or confidence-capped below auto-approve).
3. **Customer communication** — estimate/invoice delivery, public approval
   (`/e/:id`) and payment (`/pay/:id`) pages, SMS approval transport,
   dropped-call recovery surfaces.
4. **Data accuracy** — every mutation the UI or AI performs is re-read from
   the API/DB and matched field-for-field (money in integer cents, times in
   tenant TZ, tenant_id scoping).
5. **The web audit surface** — inbox approvals, jobs, scheduling/dispatch,
   customers/leads, digest, settings.

"Proven" per `docs/qa-strategy.md`: real browser or real HTTP against real
handlers; **unit tests passing is not verification**. Prior runs (2026-06-25)
caught production-fatal schema bugs (`proposals.claimed_by`) precisely because
mocked-Pool tests could not.

## 2. Environment strategy (hermetic, this container)

The Railway dev deploy is unreachable from this sandbox (`403 Host not in
allowlist`, see the invalidated 2026-05-13 run), so the run is fully local —
the same recipe as the 2026-07-02 full verification:

| Layer | Choice | Why |
|---|---|---|
| DB | Real Postgres (`pgvector/pgvector:pg16` via Docker) + full migration set | Mocked DB hid real column bugs before; RLS/isolation claims need a real DB |
| API | `NODE_ENV=dev`, real PG repos, port 3000 | Real handlers, real SQL |
| Auth | `DEV_AUTH_BYPASS=true` (UI threads) + `CLERK_DEV_HMAC_TOKENS` minted JWTs (API threads) | Clerk cloud unreachable in sandbox; both seams are first-class, prod-forbidden by config |
| Web | Vite `VITE_AUTH_MODE=dev` (Clerk dev shim), port 5173 | Boots the full authed SPA headlessly |
| LLM | **Scripted OpenAI-compatible stub server** on localhost (`AI_PROVIDER_BASE_URL` → stub); falls back to built-in `MockLLMProvider` | Deterministic intents/drafts so voice + quoting paths run end-to-end without a provider key; prices deliberately include an uncatalogued line to prove the catalog-resolver confidence cap |
| Telephony | Signed Twilio webhooks (real `twilio.validateRequest` against a fake auth token) posted to `/api/telephony/voice` + `/gather` | Exercises the production code path incl. signature verification, without PSTN |
| Delivery (SMS/email) | Noop providers (dev default) — assert on dispatch/audit records | Provider egress impossible; the DB record is the contract |
| Browser | Pre-installed Chromium via `executablePath`, full-page screenshots per step | Screen-capture proof |

Out of scope this run (impossible from the sandbox, listed for the record):
real PSTN audio, real Stripe checkout (webhook-signed simulation only), real
Clerk sign-up, Google Business polling against the live API.

## 3. Workflow verification matrix (the threads)

Each thread produces: numbered full-page screenshots, an API/DB assertion log,
and a pass/fail verdict per check. Threads share one stack but use distinct
seeded tenants/entities to avoid collisions.

| Thread | Workflows (PRD anchor) | Method | Evidence |
|---|---|---|---|
| **T1 Voice intake → proposal** | Inbound call answering, intent classification, safety scan, proposal creation, never-auto-execute (§5 architecture, §6 Intake, P8) | Signed Twilio `voice` + `gather` webhooks with scripted LLM turns; assert `voice_sessions`, `proposals` rows; screenshot `/inbox` + `/comms-inbox` showing the call-born proposal | PNG + DB |
| **T2 AI quoting & catalog grounding** | Estimate drafting, catalog resolver price grounding, confidence caps, ambiguity → clarification (§6 Quoting, P2-016/017, core pattern) | Voice/assistant-driven `draft_estimate` with one catalogued + one uncatalogued line; assert grounded `unitPriceCents` equals price-book, uncatalogued confidence ≤ 0.85 (below auto-approve); screenshot proposal review UI | PNG + DB |
| **T3 Approval → execution → customer comms** | Inbox approve (undo window), proposal execution, estimate delivery, public approval `/e/:id`, invoice, `/pay/:id`, payment webhook → paid (§3 decision 1/3, P5, money loop) | Drive `/inbox` approve in browser; then public pages as an unauthenticated context; signed Stripe-style webhook flip; assert invoice/payment rows in integer cents | PNG + DB |
| **T4 CRM & scheduling data accuracy** | Customers/leads CRUD, jobs lifecycle + transitions, appointments, conflict detection, tenant-TZ rendering (§6 Customer & job mgmt, P1, P6) | Create/edit/cancel via UI; re-read via API; drive `/schedule` under a non-NY browser TZ to prove tenant-TZ day bucketing | PNG + API |
| **T5 Comms surfaces & SMS approval transport** | Comms inbox threads, conversation transcript review, owner SMS APPROVE/REJECT reply path, technician "OUT" (§3 decision 1, N-001, N-010) | Signed inbound SMS webhooks as the owner; assert proposal state transitions + idempotent duplicate reply; screenshot thread UI | PNG + DB |
| **T6 Digest, settings, guardrails config** | End-of-day digest page, brand-voice/AI approval rules sheets, price book, vertical packs (N-005, N-011, P4) | Drive `/digest`, `/settings/*`; assert settings persist (the 2026-07-02 run found settings-save wiping vertical packs — regression-check) | PNG + API |
| **T7 Tenant isolation & security invariants** | Cross-tenant 403/404 on customers/estimates/invoices/jobs, RLS posture, webhook signature rejection (§17 runbook, always-blocking) | Tenant-B minted token against Tenant-A ids; unsigned Twilio/Stripe webhooks must be rejected; note the known "app connects as superuser → RLS bypassed" posture finding | API log |
| **T8 Static & suite baseline** | Production build health, unit/handler suites, mobile tap-target contracts | `tsc --project tsconfig.build.json --noEmit`, `vitest` (api/web/shared), hermetic e2e specs (money-loop, public, 401-storm) | Logs |

Sequencing: T8 runs first (cheap, catches a broken tree before anything
boots). Stack boot; then T1/T2 feed T3 (proposal ids), T4–T7 run in parallel
alongside them.

## 4. Model delineation (who does what)

Per CLAUDE.md the local Gemma 4 26B executor (LM Studio, `localhost:1234`) is
the default coding executor — **it is not reachable in this cloud container**,
so its executor role is delegated to Anthropic models this run.

| Role | Model | Rationale |
|---|---|---|
| **Orchestrator / reviewer / judge** | **Fable 5** (this session) | PRD synthesis, thread design, adversarial review of every finding ("is this a real bug or harness artifact?"), fix review against Core Patterns, GO/NO-GO verdict. Fable does *not* run mechanical steps itself — highest-leverage tokens only. |
| **Complex executors** | **Opus 4.8** | Threads that must author non-trivial harness code and diagnose failures live: T1 (signed-webhook voice driver + LLM stub), T2 (catalog-grounding assertions), T3 (money loop), T7 (isolation probes). Bug-fix threads (code changes need judgment about blast radius). |
| **Mechanical executors** | **Sonnet 5** | Deterministic, recipe-following threads: T4, T5, T6 UI drives with predefined flow maps, T8 suite runs, screenshot collection, report table assembly. |
| **Log skimming** | Haiku 4.5 (optional) | Only if large log triage is needed; otherwise skipped. |

Decision rule applied: **Fable is not the right choice for execution volume** —
the verification threads are parallel, evidence-producing, and recipe-bound,
which is Opus/Sonnet work. Fable's irreplaceable contribution is the plan,
the adversarial review pass (every FAIL is independently re-verified before
being called a bug), and the fix reviews. That is how this run is structured.

## 5. Bug protocol

1. A thread reporting FAIL produces: repro steps, evidence, suspected file.
2. **Fable review**: re-verify the failure is real (not env/harness), classify
   severity — `blocking` (auth/isolation/money) / `high` (lead-to-cash) /
   `medium` / `low` — and check `docs/solutions/` for prior art.
3. Confirmed bugs each get a **separate fix thread** (Opus 4.8, isolated
   worktree): fix + unit test in same commit, `tsc --project
   tsconfig.build.json --noEmit` clean, dead code removed.
4. **Fable reviews the diff** against Core Patterns (cents, UTC, tenant_id,
   audit events, gateway routing, catalog grounding) before it lands on the
   branch.
5. Fixes land on `claude/fable-app-verification-rmbfty`; the results doc
   links bug → fix commit.

## 6. Known prior findings to re-check (regression watch)

- `proposals.claimed_by` type fix (migration 215) — approve→execute must work.
- `delay_notice_state` table (migration 216) — running-late SMS path.
- Settings save wiping vertical packs (fixed 2026-07-02) — T6.
- Batch-approve 400 (duplicate Content-Type, fixed 2026-07-02) — T3.
- Appointments posted in browser TZ (fixed 2026-07-02) — T4.
- Open: TCPA/DNC gate on outbound AI calls (`isOutboundAllowed()` never
  called) — confirm current state, T7.
- RLS runtime posture (superuser bypass) — document, T7.
- Recent `[HELD FOR REVIEW]` commits on main (Vapi per-tenant webhook secret,
  atomic invoice/deposit credit) — exercised by T3/T7.
