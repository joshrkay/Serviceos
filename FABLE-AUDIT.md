# ServiceOS — Fable Model Briefing & Production Audit

_Compiled: 2026-06-09 · Sources: LAUNCH_REPORT.md (2026-06-08), docs/codebase-review-2026-05-31.md, BLOCKER-REMEDIATION-PLANS.md, and direct code-level inspection of HEAD._

---

## 1. Purpose & How to Use This Document

This document is your briefing before you write a single line of code. It tells you what is **solid and must not be touched**, what is **already done** (do not re-do it), what is **partially wired and just needs connecting**, and what is **genuinely missing**. A prioritized work order is at the end.

The existing status docs in this repo reflect different points in time and partially contradict each other:
- `GO-LIVE-READINESS.md` (2026-05-24) — lists 10 blockers; most are now fixed at HEAD
- `BLOCKER-REMEDIATION-PLANS.md` (2026-05-24) — detailed fix plans; Blockers 2 and 6 confirmed done; others done since
- `docs/codebase-review-2026-05-31.md` — structural snapshot; confirms Blockers 3, 4, 8 fixed at HEAD
- `LAUNCH_REPORT.md` (2026-06-08) — most recent; 8 features shipped; confirms 79 tables FORCE RLS

**This document supersedes all four for current status. When sources disagree, trust this file.**

---

## 2. Executive Summary

### Current Blocker Status

| Blocker | Status | Notes |
|---------|--------|-------|
| 1 — Stripe/Clerk webhook idempotency | ✅ **DONE** | `PgWebhookEventRepository` wired at `app.ts:654`; fail-fast in prod at `webhooks/routes.ts:188` |
| 2 — Txn rollback on error | ✅ **DONE** | `middleware/tenant-context.ts:140-152` rolls back on `statusCode >= 400` |
| 3 — FORCE RLS on all tenant tables | ✅ **DONE** | 79 ENABLE + 78 FORCE; 2 documented exempt; 17 static guards pass |
| 4 — Web proposal approval auth | ✅ **DONE** | `AssistantPage.tsx` uses authenticated `apiFetch`/`useApiClient` |
| 5 — Cron sweeps leader election + shutdown | ✅ **DONE** | Advisory lock per sweep at `app.ts:1301-1353`; graceful shutdown implemented |
| 6 — Payment audit trail | ✅ **DONE** | `recordPayment` emits audit events; `invoices/payment.ts:270-294` |
| 7 — Double-booking DB constraint | ✅ **DONE** | Migration 131: `btree_gist` extension + `EXCLUDE USING gist` in `schema.ts:3271-3408` |
| 8 — Estimate page mock-data leak | ✅ **DONE** | Mock fallback removed from `EstimateApprovalPage.tsx` |
| 9 — Three conflicting architectures | 🟡 **COSMETIC** | `CLAUDE.md:12-18` already documents them as non-production; remaining work is `git mv` to `experiments/` |
| 10 — Green CI build + migrations | ✅ **DONE** | Build green; 5,991 tests; migration 151 is current tip |
| 11 — TCPA/DNC consent gate | 🟡 **PARTIAL** | `voice/outbound-consent.ts` and `compliance/` infra built; `checkOutboundConsent()` not yet wired into any outbound call path |
| 12 — Transcript KMS encryption | ✅ **DONE** | AES-256-GCM via `TRANSCRIPT_ENCRYPTION_KEY` env var; `workers/transcription.ts:61-92` |

**Overall verdict: All 10 original blockers are either done or cosmetic. The project is architecturally production-ready.** The open work is completing the voice feature set (P8 Wave 8C stories), wiring the TCPA consent gate, and the patch-through vulnerability triage sprint.

### Key Health Indicators

| Area | Status | Finding |
|------|--------|---------|
| Production build | ✅ Green | `tsc --project tsconfig.build.json --noEmit` → 0 errors |
| Unit tests | ✅ Green | 5,991 passed / 619 files; 0 failed |
| Integration tests | ✅ Green | 180 tests / 40 files; needs Docker or `EXTERNAL_TEST_DB_URL` |
| RLS tenant isolation | ✅ Green | 79 ENABLE + 78 FORCE; static + live tests pass |
| Money math | ✅ Green | Integer cents throughout; `billing-engine.ts`; CI guard enforces |
| AI gateway | ✅ Green | All LLM calls route through `ai/gateway/`; CI guard enforces |
| Proposal safety | ✅ Green | Zod-validated, RBAC-gated, never auto-execute, 5s undo, idempotent |
| Auth | ✅ Green | Clerk RS256/JWKS; dev-bypass hard-gated off in prod |
| TCPA/DNC gate | 🟡 Partial | Infrastructure built; not wired into outbound call path |
| P8 Wave 8C | 🟡 In progress | P8-012 feature-flagged off; P8-013/P8-014/P8-015 not wired |
| Patch-through sprint | 🟡 Partially built | All detectors done; `triageFork()` wrapper and migration 152 missing |
| Dispatch Board UX | 🟡 Gap | ~60% complete; drag-drop assignment minimal |
| Reports Analytics | 🟡 Gap | ~50% complete; backend query logic incomplete |
| SkillMatcher | 🟡 Gap | Stub — tech assignment is "first available"; not skill-aware |
| app.ts size | 🟡 Debt | 3,263-line god composition root |
| Web data layer | 🟡 Debt | No TanStack Query; ~54 raw `fetch()` sites; stale-after-write |

---

## 3. Architecture Overview

### 3.1 Package Map

```
packages/api      — Express/TypeScript backend; the ONLY Railway deploy target
packages/web      — React 18 + Vite + Tailwind + Clerk frontend
packages/shared   — Shared types, Zod contracts, enums, billing engine
```

**NOT deployed — do not mistake for production:**
```
infra/             — AWS CDK; built; deployed by nothing; drifts
service-os-app/    — Next.js prototype; writes direct to Supabase; bypasses proposal/audit gate
service-os-agent/  — Python LangGraph; unauthenticated /process; NameError crash at
                     clients/service_os_api.py:146 (missing `import json`)
supabase_migration.sql — Prototype schema at repo root; NOT the canonical migrations
```

`CLAUDE.md:12-18` already documents these as non-production. See §12, item 9.

### 3.2 Core Invariants — Do Not Break These

| Invariant | Rule | Implementation |
|-----------|------|----------------|
| **Money** | Integer cents only, never float | `packages/shared/src/billing-engine.ts` calculates; `packages/web/src/utils/currency.ts:formatCurrency()` displays |
| **Multi-tenant** | Every entity has `tenant_id`; RLS enforced at DB layer | GUC via `PgBaseRepository`; 79 tables ENABLE+FORCE RLS |
| **AI calls** | All LLM calls route through the gateway | `packages/api/src/ai/gateway/`; CI guard: `check:ai-gateway-guard` |
| **Proposals** | AI proposes → human approves → executor runs | Never auto-execute except `capture`-class autonomous-tier; 5s undo; idempotent via `claimForExecution` |
| **Webhooks** | Durable dedup before side-effects | `recordReceipt → (if inserted) handle → markProcessed` |
| **Migrations** | Forward-only, in-code, idempotent, sequential | Append to `MIGRATIONS` in `db/schema.ts`; never edit historical entries |
| **Build gate** | `tsc --project tsconfig.build.json --noEmit` must exit 0 | Use this config, not the default `tsconfig.json` (which includes test files) |

### 3.3 Key File Map

| Purpose | Path |
|---------|------|
| API entry point | `packages/api/src/index.ts` |
| Composition root (god file — see §9) | `packages/api/src/app.ts` |
| All 151 migrations | `packages/api/src/db/schema.ts` |
| Migration runner | `packages/api/src/db/migrate.ts` |
| Tenant RLS middleware | `packages/api/src/middleware/tenant-context.ts` |
| LLM gateway | `packages/api/src/ai/gateway/gateway.ts` |
| Calling agent FSM | `packages/api/src/ai/agents/customer-calling/state-machine.ts` |
| FSM transitions | `packages/api/src/ai/agents/customer-calling/transitions.ts` |
| In-app voice adapter | `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts` |
| Voice session store | `packages/api/src/ai/agents/customer-calling/voice-session-store.ts` |
| 25 AI skills | `packages/api/src/ai/skills/` |
| Billing engine | `packages/shared/src/billing-engine.ts` |
| Currency display | `packages/web/src/utils/currency.ts` |
| Webhook handlers | `packages/api/src/webhooks/routes.ts` |
| Twilio adapter | `packages/api/src/telephony/twilio-adapter.ts` |
| Media Streams (P8-012) | `packages/api/src/telephony/media-streams/` |
| Outbound consent gate | `packages/api/src/voice/outbound-consent.ts` |
| Vulnerability detectors | `packages/api/src/ai/vulnerability/` |
| Dropped-call recovery | `packages/api/src/sms/recovery/` + `packages/api/src/workers/dropped-call-worker.ts` |
| Web route map | `packages/web/src/routes.ts` |
| Railway config | `railway.toml` |
| Docker build | `Dockerfile` |

### 3.4 Deployment Path

```
git push
  → CI (pr-checks.yml): tsc build gate + web typecheck + lint + gateway guard + unit + integration + coverage + voice quality
  → Railway: docker build Dockerfile target=api
  → preDeployCommand: node packages/api/dist/src/db/migrate.js  (151 migrations, idempotent)
  → startCommand: node packages/api/dist/src/index.js
  → healthcheckPath: /health (always 200)
```

Migration 151 (`tenant_settings.bill_labor_from_time_entries`) is the current tip. Migration 152 does not yet exist — it's needed for the patch-through sprint (see §5.2).

### 3.5 AI Call Path

```
Voice/text input
  → ai/orchestration/reference-resolver.ts      (deterministic — rewrites pronouns/ellipsis)
  → ai/orchestration/intent-classifier.ts       (LLM; 14 intents + emergency_dispatch; 0.6 threshold)
  → ai/agents/customer-calling/entity-resolution.ts  (resolve free-text → tenant-scoped IDs)
  → ai/orchestration/task-router.ts             (dispatch to TaskHandler)
  → proposals/proposal.ts                       (create proposal)
  → human approval gate                         (web UI or SMS — SMS transport not yet built)
  → proposals/execution/executor.ts             (the ONLY executor)
  → proposals/execution/handlers/               (per-type side-effect handlers)
```

---

## 4. Deployment & Infrastructure

### 4.1 Railway (the only production target)

```toml
# railway.toml
[build]
dockerfilePath    = "Dockerfile"
dockerfileTarget  = "api"          # node:20-alpine final stage

[deploy]
preDeployCommand  = "node packages/api/dist/src/db/migrate.js"
startCommand      = "node packages/api/dist/src/index.js"
healthcheckPath   = "/health"      # always 200; note: /ready is NOT used as healthcheck
healthcheckTimeout = 60
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

The schema is **not** separate `.sql` files. It is a single `MIGRATIONS` object in `packages/api/src/db/schema.ts`, applied idempotently at every deploy.

### 4.2 CI/CD Gates (`.github/workflows/pr-checks.yml`)

Order:
1. `tsc --project tsconfig.build.json --noEmit` — API production typecheck
2. `tsc --noEmit` — web typecheck
3. lint (all packages)
4. Infra CDK tests
5. AI gateway guard (`check:ai-gateway-guard`)
6. Unit tests (all 3 packages)
7. Integration tests (testcontainers PostgreSQL 16 — needs Docker registry or `EXTERNAL_TEST_DB_URL`)
8. Per-module coverage check (`scripts/check-coverage.ts`)
9. Voice quality Layer 1 corpus (40 scripts, separate job, posts PR comment)

Additional workflows: `voice-quality-nightly.yml`, `voice-quality-weekly-trend.yml`, `e2e.yml`, `qa-matrix-gate.yml`.

### 4.3 Known CI Issues

| Issue | Location | Fix |
|-------|----------|-----|
| E2E self-skips without Clerk key | `e2e/smoke.spec.ts:33-36` | Set `E2E_CLERK_SECRET_KEY` in CI secrets |
| Node version drift | Dockerfile=20, some steps=22 | Pin all to `node:20-alpine` |
| 3 timezone-fragile unit tests | `test/invoices/invoice.test.ts:162`, `test/dispatch/validation.test.ts:147,160` | Add `TZ=UTC` to vitest config or use `vi.setSystemTime` |
| Integration tests need Docker | Any testcontainers test | Use `EXTERNAL_TEST_DB_URL` env var as escape hatch |

---

## 5. Open Work — What Needs Doing

### 5.1 Blocker 11 (PARTIAL) — TCPA/DNC Consent Gate Not Wired

**Status**: All infrastructure is built. The gate just isn't called from the production outbound call path.

**What exists**:
- `packages/api/src/voice/outbound-consent.ts` — `checkOutboundConsent()` queries the DNC list and `customers.consent_status`
- `packages/api/src/compliance/dnc.ts` — DNC list repo
- `packages/api/src/compliance/business-hours.ts` — business-hours logic (extend for TCPA quiet hours)

**What's missing**: `checkOutboundConsent()` has zero imports outside its own file. Find the outbound call initiation path (search: `outbound-allowlist`, `initiateOutboundCall`, or callers of the voice action router) and add the gate before any dial:
```ts
const { allowed, reason } = await checkOutboundConsent(deps, { tenantId, phoneNumber, customerId });
if (!allowed) {
  await auditRepo.record({ type: 'call.blocked', tenantId, reason });
  return;
}
```
Also add TCPA quiet hours (8am–9pm local) using `tenant_settings.timezone`.

**Tests needed**: Outbound to DNC number → blocked + audited; no consent → blocked; quiet hours → deferred.

**Effort**: ~1–1.5 days (reuses existing infrastructure)

---

### 5.2 Patch-Through Vulnerability Triage Sprint

**Context**: Spec in `docs/launch/2026-06-04-patch-through-sprint.md`. All detection components are built. The wiring is missing.

**What's already in the tree**:

| Component | File | Status |
|-----------|------|--------|
| Age detector | `packages/api/src/ai/vulnerability/detectors/age-detector.ts` | ✅ Built |
| Medical detector | `packages/api/src/ai/vulnerability/detectors/medical-detector.ts` | ✅ Built |
| Property type detector | `packages/api/src/ai/vulnerability/detectors/property-type-detector.ts` | ✅ Built |
| Weather detector | `packages/api/src/ai/vulnerability/detectors/weather-detector.ts` | ✅ Built |
| Signal aggregator | `packages/api/src/ai/vulnerability/signal-extractor.ts` | ✅ Built |
| Urgency tier classifier | `packages/api/src/ai/skills/classify-urgency-tier.ts` | ✅ Built |
| Triage matrix | `packages/api/src/ai/vulnerability/triage-decision.ts` | ✅ Built |
| Owner-cell `<Dial>` builder | `packages/api/src/voice/triage/owner-cell-patch.ts` | ✅ Built |
| Context preface (non-PII) | `packages/api/src/voice/triage/context-preface.ts` | ✅ Built |
| Owner phone column | Migration 143; `IdentityStep.tsx`; `BusinessProfileSheet.tsx` | ✅ Done |
| Dial-result cascade route | `packages/api/src/routes/telephony.ts` | ✅ Done (dispatcher path) |
| `escalate-to-human.ts` vulnerability reason | `packages/api/src/ai/skills/escalate-to-human.ts:81` | ✅ Done |

**What's missing** (per sprint plan):

1. **`ai/vulnerability/urgency-tier-mapping.ts`** — pure mapper from `UrgencyTier` (classifier output) → `UrgencyTier` (triage-decision input). Does not exist.

2. **Migration 152** — `tenant_settings.patch_through_enabled BOOLEAN DEFAULT false`. Not in `schema.ts` yet (current tip is 151).

3. **`triageFork()` in `ai/voice-turn/create-voice-turn-processor.ts`** — the decision fork at the `notify_oncall` side-effect site (`:494-641`). Currently falls through to `escalateToHuman()` unconditionally. Needs to call `triage-decision.ts` and fork to `owner-cell-patch.ts` when the flag is on and signals exceed threshold.

4. **`/dial-result` branch for `call_kind = 'owner_patch'`** in `packages/api/src/routes/telephony.ts` — currently only handles the dispatcher rotation path.

5. **Two new voice-quality cassettes** in `packages/api/src/ai/voice-quality/corpus/cassettes/` for patch-through scenarios.

**Sprint breakdown** (from sprint plan doc):
- Day 1: `urgency-tier-mapping.ts` + migration 152
- Day 2: `triageFork()` in `create-voice-turn-processor.ts`; gate on `patch_through_enabled` flag
- Day 3: `/dial-result` owner-patch branch + audit emissions
- Day 4: Two new voice-quality cassettes; staging dry-run
- Day 5: PostHog events, Sentry alert, Settings UI toggle, volunteer tenant rollout

---

### 5.3 Phase 8 Wave 8C — Voice Features Not Yet Wired

All of these have code built; the work is wiring/mounting/enabling.

**P8-012 — Twilio Media Streams real-time audio** (feature-flagged off)  
This is the competitive-parity story. Without it, the agent uses `<Gather>` polling and feels slow versus Avoca.

- `packages/api/src/telephony/media-streams/` — 4 files, 1,407 lines, fully built
- Feature flag: `TWILIO_MEDIA_STREAMS_ENABLED=false` in `.env`
- Wired into `routes/telephony.ts:367` — just needs the flag enabled and tested
- Steps: (1) test the WebSocket path against a staging Twilio number; (2) flip flag to `true` in Railway env; (3) verify TTFA < 800ms

**P8-013 — Telephony escalation (Dial transfer)**

- `telephony/twilio-call-control.ts` — built
- `escalate-to-human.ts:81-168` — `owner_patch` path exists
- **Gap**: `telephony/twilio-adapter.ts:133` has a `notify_oncall` no-op comment; replace it with a `TwilioCallControl.dialDispatcher()` call
- `routes/telephony.ts` — `/dial-result` handles dispatcher cascade; verify it covers the owner-patch path too

**P8-014 — Call recording**

- `telephony/recording-webhook.ts` — built (handles Twilio's recording status callback)
- **Gap**: `routes/telephony.ts` needs a `POST /recording` route mounting `recording-webhook.ts`
- `telephony/twilio-adapter.ts:143` — `recordingStatusCallback` conditional — enable for prod
- Verify S3 credentials and `voice_recordings` table insert idempotency

**P8-015 — Dropped-call SMS recovery**

- `packages/api/src/sms/recovery/scheduler.ts` — scheduler interface exists
- `packages/api/src/workers/dropped-call-worker.ts` — worker built
- `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts:118-129` — `droppedCallScheduler` injection point exists
- **Gap**: `app.ts` never constructs `createDroppedCallWorker` or wires `droppedCallScheduler` into the inapp-adapter deps
- Steps: (1) construct worker in `app.ts` with pool + SMS provider; (2) wire `droppedCallScheduler` into `inapp-adapter` deps; (3) add to sweep registration block

---

### 5.4 Strategy Gaps — Missing from Roadmap Entirely

These are in the strategy doc (`docs/strategy/roadmap-audit.md`) but have no codebase home:

| Missing Feature | Strategy Decision | Effort |
|----------------|-------------------|--------|
| End-of-day SMS digest (6–9pm, one-tap approve) | Decision #2: "End-of-day digest is the dashboard" | M (~2–3 wks) |
| Supervisor-agent post-hoc review of every booking/quote | Decision #5: "Supervisor-agent review of every booking/quote" — trust differentiator | M (~2–3 wks) |
| Dropped-call → automatic SMS recovery | Decision #8 | S (~1 wk; worker and scheduler built, see P8-015 above) |
| Google review monitoring + draft response | Decision #11; `workers/google-reviews.ts` polls but NLU classification + proposal emission not built | M (~2 wks) |

Also misaligned: SMS is treated as a comms channel but the strategy says it should be the **primary approval surface** — every proposal type needs an SMS-dispatchable format, not only web UI.

---

## 6. Important Pre-Scale Items

Not open blockers. Fix before serving significant traffic or scaling past one instance.

| Item | Location | Fix |
|------|----------|-----|
| Money formatting drops cents | `InvoicesPage.tsx:247,256,257,275,376,552,723,735,744` (and ~86 total sites) | Replace `.toLocaleString()`/`.toFixed()` on cent values with `formatCurrency()` from `utils/currency.ts` |
| `/metrics` auth | `packages/api/src/app.ts:557-584` | Already gated on `METRICS_TOKEN` bearer — verify `METRICS_TOKEN` is set in Railway env |
| DB health returns wrong level | `packages/api/src/app.ts:665` | `/ready` should 503 during DB outage; currently returns `degraded`+200, keeping traffic |
| SkillMatcher stub | `packages/api/src/ai/tasks/create-appointment-task.ts` | Build `PgSkillMatcher`; until then, require operator `technicianId` for skill-critical trades |
| Per-tenant SMS provisioning | `LAUNCH_REPORT.md` risk #2 | `getTenantTwilioCreds` throws for tenants with no `tenant_integrations` row; verify all live tenants provisioned |
| Webhook rate limit | `packages/api/src/app.ts:629` — 30/min/IP | Stripe can burst higher; raise limit or add Stripe IP allowlist |
| Timezone: UTC bucketing in reports | `packages/api/src/reports/money-dashboard.ts`, `packages/web/src/components/reports/MoneyDashboardPage.tsx` | Acceptable for US-Pacific beta; add UI label "Buckets reflect UTC days" |

---

## 7. Agent Inventory

All agents share the same orchestration brain:
```
audio/text
  → reference-resolver   (deterministic)
  → intent-classifier    (LLM; 14 intents + emergency_dispatch; 0.6 threshold)
  → entity-resolver      (resolve free-text → tenant-scoped IDs)
  → task-router          (dispatch to TaskHandler)
  → proposal             (human approval required)
```

### Customer Calling Agent (Inbound Voice)

**Location**: `packages/api/src/ai/agents/customer-calling/`

**What works end-to-end (shipped)**:
- 12-state FSM with 14 intents + low-confidence → human fallback; 5/5 launch fixtures pass
- Slot extraction: strict Zod `voiceSlotsSchema`; 8/8 transcript fixtures pass
- Entity resolution, escalation context builder, sentiment/frustration detection
- All 8A and 8B stories shipped (entity resolver, compliance, session caps, FSM core, recording disclosure, identify caller, confirm intent, escalate-to-human, in-app voice session, summarize session, Twilio inbound `<Gather>`)
- In-app adapter: text-in → LLM → TTS-out working; HTTP/SSE bridge to AssistantPage

**Wave 8C status**:

| Story | Status | Specific gap |
|-------|--------|-------------|
| P8-012 Media Streams | Built, feature-flagged off | Enable `TWILIO_MEDIA_STREAMS_ENABLED`; test TTFA < 800ms |
| P8-013 Dial escalation | Partially wired | `twilio-adapter.ts:133` `notify_oncall` no-op; replace with `TwilioCallControl.dialDispatcher()` |
| P8-014 Call recording | Webhook built | Mount `POST /recording` route in `routes/telephony.ts` |
| P8-015 Dropped-call SMS | Worker built | Wire `droppedCallScheduler` into `inapp-adapter` deps from `app.ts` |
| P8-016 Vulnerability triage | All detectors built | `triageFork()` wrapper missing; migration 152 missing (see §5.2) |

**Skills directory**: `packages/api/src/ai/skills/` — 25 reusable skills consumed by agents

### Customer Follow-Up Agent (Outbound)

**Status**: Spec drafted; no implementation dispatched  
**Spec**: `docs/superpowers/agents/customer-followup/`  
**Channels**: Outbound SMS (v1), email (v2), voice (v3)  
**Note**: TCPA/DNC gate (§5.1) must be wired before this agent dials anyone

### Invoice Agent & Estimate-Invoice Agent

**Status**: TBD spec; no stories written  
**Spec stubs**: `docs/superpowers/agents/invoice/`, `docs/superpowers/agents/estimate/`

---

## 8. UX/UI Audit

### 8.1 Page Status

| Page | Route | Completion | Key Gap |
|------|-------|-----------|---------|
| Dashboard | `/` | ✅ Complete | — |
| AI Assistant | `/assistant` | ✅ Complete | Text + TTS only; real-time mic needs P8-012 |
| Jobs | `/jobs`, `/jobs/:id` | ✅ Complete | — |
| Customers | `/customers`, `/customers/:id` | ✅ Complete | — |
| Estimates | `/estimates`, `/estimates/:id` | ✅ Complete | — |
| Invoices | `/invoices`, `/invoices/:id` | ✅ Complete | Money formatting drops cents (see §6) |
| Leads | `/leads`, `/leads/:id` | ✅ Complete | — |
| Maintenance Contracts | `/contracts`, `/contracts/:id` | ✅ Complete | — |
| Invoice Payment (public) | `/pay/:id` | ✅ Complete | — |
| Estimate Approval (public) | `/e/:id` | ✅ Complete | — |
| Onboarding | `/onboarding` | 95% | Test call detection identity-based (deferred) |
| Customer Portal | `/portal/:token` | 85% | Booking error handling incomplete |
| Settings | `/settings` | 80% | Team management business logic incomplete |
| Technician Day View | `/technician/day` | 70% | Voice recording + time entry integration partial |
| Schedule | `/schedule` | 85% | Conflict detection works; no visual highlight |
| Dispatch Board | `/dispatch` | 60% | Queue visualization rudimentary; drag-drop minimal |
| Money Dashboard | `/reports/money` | 50% | Backend query logic incomplete |
| Revenue by Source | `/reports/revenue-by-source` | 50% | Backend partially stubbed |

### 8.2 Known UX Issues

| Issue | File / Location | Impact |
|-------|----------------|--------|
| God components (1,000+ lines) | `JobDetail.tsx` (1,501), `NewJobFlow.tsx` (1,488), `NewEstimateFlow.tsx` (1,405), `EstimatesPage.tsx` (1,370), `TemplatesPage.tsx` (1,312) | Dev velocity; hard to test |
| No TanStack Query — stale-after-write | All list/detail pages | Data goes stale after mutations |
| Two auth-fetch mechanisms | `utils/api-fetch.ts` (weaker, `apiFetch`) vs `lib/apiClient.ts` (`useApiClient`, preferred) | Weaker `apiFetch` used on money pages; ~54 raw `fetch()` sites |
| Money formatting drops cents | `InvoicesPage.tsx:247,256,...` (86 sites total) | $1,234.50 displays as $1,234.5 |
| Timezone: browser-local not tenant TZ | All time displays | Incorrect for non-Pacific tenants |
| Client-side search only | Customer/job/estimate list pages | Breaks at >1,000 records |

**Router error handling**: Fixed — `packages/web/src/routes.ts:124-147` attaches `ErrorBoundary: RouteErrorElement` to all top-level routes. No white-screen on crash.

---

## 9. Technical Debt (ranked by impact)

### High Impact

**1. `app.ts` 3,263-line god composition root** (`packages/api/src/app.ts`)

`createApp()` builds ~120 repos/services, mounts ~110 routers, and registers all sweeps. Decompose into:
```
packages/api/src/bootstrap/
  repositories.ts   — all repo instantiations
  routers.ts        — route mounting
  sweeps.ts         — sweep registration + advisory locks
  webhooks.ts       — webhook router wiring
```
`packages/api/src/bootstrap/` already exists (`helmet-options.ts`, `metrics-auth.ts`). The directory is ready.

**Critical constraints when splitting**:
- `webhookEventRepo` instances for Stripe/Clerk must be separate from the main `webhookEventRepo`
- `jobRepo` is hoisted early so it's the same in-memory instance shared across inapp voice + routes — preserve this

**2. Web data layer: no cache, stale-after-write** (all pages)

~54 raw `fetch()` sites; mutations don't invalidate. Fix: adopt **TanStack Query** (`@tanstack/react-query`); wrap `useApiClient` as the default `queryFn`; migrate data-fetching one component at a time. Start with `JobDetail.tsx` (highest-value, most pain).

**3. `asyncRoute` under-adopted** (`packages/api/src/middleware/async-route.ts` exists)

Only 14–16 of ~52 route files use `asyncRoute`; ~201 manual `catch` blocks remain. Mechanical migration.

### Medium Impact

**4. `webhooks/routes.ts` 2,027 lines** — each provider inlines verify+dedup. Decompose into per-provider handler files (`stripe-handler.ts`, `clerk-handler.ts`, etc.).

**5. Money rendering** — 86 `.toLocaleString()`/`.toFixed()` on cent values. Active display bug. Replace with `formatCurrency()` from `utils/currency.ts`.

**6. No real ESLint** — `lint` is `tsc --noEmit`. Add `@typescript-eslint/recommended` + `no-floating-promises` + `react-hooks/exhaustive-deps`.

**7. npm vulnerabilities** — 3 high / 5 moderate. Most `npm audit fix`-able. Run `npm audit fix --workspace=packages/api` and `--workspace=packages/web`.

### Lower Impact

**8. Dead but dangerous code** — `packages/api/src/routes/proposals-execute.ts` (approve+execute in one call, bypasses undo window; currently unmounted). Delete it.

**9. Blocker 9 cosmetic** — Move `infra/`, `service-os-app/`, `service-os-agent/`, `supabase_migration.sql` to `experiments/`. Update `CLAUDE.md` (currently omits these) and `docs/deployment.md`.

**10. 138 stale test-fixture type errors** — test files only; excluded from prod build. Fix incrementally.

---

## 10. Testing & Quality

### Coverage Summary

| Suite | Tests / Files | Notes |
|-------|--------------|-------|
| API unit | 5,991 / 619 files | `packages/api/test/`; no DB required |
| Web unit | 1,050 / ~161 files | `packages/web/src/**/*.test.tsx` |
| Shared | 49 / 20 files | |
| Integration (Postgres) | 180 / 40 files | Needs Docker or `EXTERNAL_TEST_DB_URL` |
| RLS isolation | 8 tests | `test/db/rls-tenant-isolation.test.ts` |
| Voice quality corpus | 60 cassettes + 13 fixture tests | |
| E2E Playwright | 39 spec files | Self-skip without `E2E_CLERK_SECRET_KEY` |

### How to Run

```bash
# Mandatory gate — same config Railway uses
cd packages/api && npx tsc --project tsconfig.build.json --noEmit

# All unit tests (no DB required)
npm test

# Voice fixtures
npm run test:voice-fixtures

# Integration + RLS (needs Postgres 16 + pgvector)
EXTERNAL_TEST_DB_URL=postgres://user:pass@host/db npm run test:integration
EXTERNAL_TEST_DB_URL=postgres://user:pass@host/db npm run test:rls

# Full build
npm run build
```

### Test Gaps

- Dispatch Board and Reports pages largely untested
- SkillMatcher stub: tech assignment tests only validate "first available"
- Multi-labor invoicing edge cases (multiple labor lines)
- E2E self-skips in CI without `E2E_CLERK_SECRET_KEY`
- No voice-quality cassettes yet for patch-through vulnerability scenarios (Day 4 of sprint)

---

## 11. Environment & Security

### Required Production Variables

```bash
DATABASE_URL
CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY
CLERK_WEBHOOK_SECRET
VITE_CLERK_PUBLISHABLE_KEY          # web build-time
VITE_API_URL                        # web build-time
VITE_STRIPE_PUBLISHABLE_KEY         # web build-time
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_ID
METRICS_TOKEN                       # bearer auth for /metrics
AI_PROVIDER_API_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER
CORS_ORIGIN
```

### Voice-Specific

```bash
TRANSCRIPT_ENCRYPTION_KEY           # 32-byte hex; AES-256-GCM for transcripts (Blocker 12 DONE)
TTS_PROVIDER                        # openai or elevenlabs
ELEVENLABS_API_KEY                  # if TTS_PROVIDER=elevenlabs
DEEPGRAM_API_KEY                    # for streaming STT when P8-012 is enabled
TWILIO_MEDIA_STREAMS_ENABLED        # set to true to enable P8-012
```

---

## 12. Recommended Work Order for Fable

Execute in tier order. Items within a tier are independent and can run in parallel.

---

### Tier 0 — Verify Baseline (0.25 day, always first)

1. `npm run typecheck && npm run lint && npm run test && npm run build` — confirm all green
2. `npm run test:voice-fixtures` — confirm 13/13
3. Integration + RLS tests against local Postgres: confirm 180/180 and 8/8

---

### Tier 1 — Complete Voice Feature Set (2–3 days, highest user value)

4. **P8-015**: Wire `createDroppedCallWorker` + `droppedCallScheduler` in `app.ts`; inject into `inapp-adapter.ts` deps at `:118-129`
5. **P8-014**: Mount `POST /recording` route in `routes/telephony.ts` using `telephony/recording-webhook.ts`; enable `recordingStatusCallback` in `twilio-adapter.ts:143`
6. **P8-013**: Replace `notify_oncall` no-op at `twilio-adapter.ts:133` with `TwilioCallControl.dialDispatcher()`
7. **P8-012**: Test Media Streams WebSocket path against staging Twilio number; enable `TWILIO_MEDIA_STREAMS_ENABLED=true` in Railway env; verify TTFA < 800ms

---

### Tier 2 — Patch-Through Vulnerability Triage (4–5 days, trust differentiator)

8. Day 1: Create `ai/vulnerability/urgency-tier-mapping.ts` + migration 152 (`tenant_settings.patch_through_enabled`)
9. Day 2: `triageFork()` in `ai/voice-turn/create-voice-turn-processor.ts:494-641`; gate on flag; wire `ownerPhoneResolver`
10. Day 3: `/dial-result` owner-patch branch in `routes/telephony.ts`; add audit emissions
11. Day 4: Two new voice-quality cassettes; staging dry-run
12. Day 5: PostHog events, Sentry alert, Settings UI toggle, volunteer tenant rollout

---

### Tier 3 — TCPA/DNC Consent Gate (1–1.5 days, legal requirement)

13. Find outbound call initiation (search `outbound-allowlist`); add `checkOutboundConsent()` from `voice/outbound-consent.ts` as pre-dial gate
14. Add TCPA quiet-hours guard (8am–9pm local) using `compliance/business-hours.ts` + tenant timezone
15. Write tests: DNC blocked, no consent blocked, quiet-hours deferred

---

### Tier 4 — Operational Cleanup (1 day)

16. **Blocker 9 cosmetic**: Move `infra/`, `service-os-app/`, `service-os-agent/`, `supabase_migration.sql` to `experiments/`; update `CLAUDE.md` and `docs/deployment.md`
17. CI: align Node version to 20 everywhere; fix 3 timezone-fragile tests (`TZ=UTC`)

---

### Tier 5 — UX Correctness (1 day)

18. Fix money formatting: replace `.toLocaleString()`/`.toFixed()` on cent values with `formatCurrency()` from `utils/currency.ts` — start with `InvoicesPage.tsx:247,256,275,376`
19. Fix `centsToDisplay` — add thousands separator
20. Label UTC bucketing in money dashboard UI ("Buckets reflect UTC days")

---

### Tier 6 — Backend Structural Cleanup (2–3 days)

21. Decompose `app.ts` into `bootstrap/{repositories,routers,sweeps,webhooks}.ts`
22. Migrate remaining ~35 route files to `asyncRoute` from `middleware/async-route.ts`
23. Decompose `webhooks/routes.ts` into per-provider handler files
24. Delete dead `routes/proposals-execute.ts`

---

### Tier 7 — Frontend Data Layer (3–5 days)

25. Add `@tanstack/react-query`; wrap `useApiClient` as default `queryFn`
26. Migrate `JobDetail.tsx` as first god-component decomposition
27. Consolidate `apiFetch` callers onto `useApiClient`; eliminate raw `fetch()` on money pages first

---

### Post-PMF — Missing Strategy Stories

28. SMS approval transport (`P2-XXX`) — every proposal type dispatchable as formatted SMS
29. End-of-day digest generator (no story exists today)
30. Supervisor-agent review pass (no story exists; biggest trust differentiator)
31. Google review NLU classification + proposal emission (PR b/c of P7-026)

---

## 13. What Fable Must Not Change

These are correct and well-tested. Do not refactor unless fixing a specific named bug.

| Module | Why hands-off |
|--------|--------------|
| `packages/shared/src/billing-engine.ts` | Correct money math; 37 billing tests; every estimate/invoice path depends on it |
| `packages/api/src/proposals/` | Proposal engine, execution, idempotency; all correct |
| `packages/api/src/ai/gateway/` | LLM routing, circuit breaker, retry, failover, quota; all working |
| `packages/api/src/db/schema.ts` historical migrations | Never edit past migrations; only append forward |
| `packages/api/src/middleware/tenant-context.ts` | RLS + transaction commit/rollback correct (Blockers 2+6 done) |
| `packages/web/src/components/auth/` + `packages/api/src/middleware/auth.ts` | Clerk RS256 auth working; dev-bypass hard-gated |
| `packages/api/src/voice/outbound-allowlist.ts` | Extend it for TCPA (§5.1); do not replace |
| `packages/api/test/voice-quality/corpus/cassettes/` | Do not modify existing cassettes without a matching voice quality run |
| `packages/api/src/db/schema.ts` RLS entries | 79 tables FORCE RLS with correct policies; validated by 17 static guards + 8 integration tests |

---

## 14. Quick Reference — Where to Find Things

| What | Where |
|------|-------|
| Migration runner + all 151 migrations | `packages/api/src/db/schema.ts` (append only) |
| Billing engine | `packages/shared/src/billing-engine.ts` |
| Currency display formatters | `packages/web/src/utils/currency.ts` |
| LLM gateway | `packages/api/src/ai/gateway/gateway.ts` |
| All 13 proposal contracts (Zod) | `packages/api/src/proposals/contracts/` |
| Proposal executor | `packages/api/src/proposals/execution/executor.ts` |
| All 25 AI skills | `packages/api/src/ai/skills/` |
| Tenant context middleware | `packages/api/src/middleware/tenant-context.ts` |
| asyncRoute wrapper | `packages/api/src/middleware/async-route.ts` |
| Auth middleware | `packages/api/src/middleware/auth.ts` |
| PgBaseRepository | `packages/api/src/db/pg-base.ts` |
| setTenantContext() | `packages/api/src/db/schema.ts:3910` |
| Voice FSM | `packages/api/src/ai/agents/customer-calling/state-machine.ts` |
| Twilio adapter | `packages/api/src/telephony/twilio-adapter.ts` |
| Media Streams (P8-012) | `packages/api/src/telephony/media-streams/` |
| Vulnerability triage | `packages/api/src/ai/vulnerability/` |
| Outbound consent gate | `packages/api/src/voice/outbound-consent.ts` |
| DNC list | `packages/api/src/compliance/dnc.ts` |
| Dropped-call recovery | `packages/api/src/sms/recovery/` + `packages/api/src/workers/dropped-call-worker.ts` |
| Patch-through sprint plan | `docs/launch/2026-06-04-patch-through-sprint.md` |
| Phase 8 Wave 8C specs | `docs/stories/phase-8-gap-stories.md` |
| Roadmap alignment audit | `docs/strategy/roadmap-audit.md` |
| CI pipeline | `.github/workflows/pr-checks.yml` |
| Railway config | `railway.toml` |
| Most current launch status | `LAUNCH_REPORT.md` (2026-06-08) |
