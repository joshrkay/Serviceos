# Pre-Launch Hardening — Status Report + Dispatch List

> **⚠️ Subordinate / many items now resolved (2026-06-13).** This hardening
> sweep is **subordinate to `docs/PRD-launch-v1.md` §8 Epic 5 (Trust /
> reliability launch gates, P0)** — the authoritative, current statement of the
> launch trust/reliability gates (green CI, prod secrets, prod migration +
> RLS-FORCE verification, money-render fix, `/ready` 503 on DB outage, two-tenant
> isolation proof, webhook-replay drill). For launch scope, positioning, and
> sequencing the authoritative document is **`docs/PRD-launch-v1.md`**; the
> authoritative record of what is **completed & bug-free** is
> **`docs/feature-status-ledger.md`**. **Many of the Tier 1–5 / D-day items
> below are now resolved at HEAD** per the ledger — e.g. webhook idempotency is
> now a **durable, fail-closed** store in prod (ledger §1 / correction #1,
> `webhooks/routes.ts:168-171,187-194`), and RLS is at **~75/75 distinct-table
> parity, zero mismatch** (ledger correction #2). Read this doc as a historical
> cutover dispatch list, not current state; for the live trust/reliability
> picture see **PRD-launch-v1.md §8 Epic 5** and **feature-status-ledger.md**.
> Note also that the ledger's verified **launch-blocking** gaps — the dead
> owner-SMS channel (no reply-to-approve handler `app.ts:661-662`; no proactive
> owner-SMS sender `proposals/proposal.ts`) and the dead collections tail
> (`invoices/dunning-schedule.ts:35`, `invoices/late-fee.ts:47`) — are **not** in
> this doc's Tier list; they are PRD Epics 0/2. When in doubt, the PRD and the
> ledger win.

**Date:** 2026-05-16
**Branch of record:** `claude/codebase-review-status-1nFGz`
**Cutover target:** This week (Day 7 = Fri 2026-05-22)
**Scope:** Full Tier 1-5 sweep

Supersedes the open items in
`docs/codebase-readiness-assessment.md` (2026-05-06) for cutover purposes.
Cross-references: `TODOS.md`, `docs/remaining-features.md`, `plan.md`,
`docs/runbooks/launch-quality-bar.md`.

---

## TL;DR

196 commits in 3 days; two large PRs merged: **#382 Onboarding v2** and
**#383 Launch Quality Bar (§11 H1-H5)**. Codebase is ~85% built /
~70% launch-ready. To turn real customer traffic on this week we need a
**3-phase sweep**: P0 cutover blockers (D1-D2), feature finishing (D3-D5),
verification + ship (D6-D7). 4 product decisions block work and need a
call **today**.

---

## Quick-Action Dispatch List

These are the tickets in priority order. Each is a candidate for
`/dispatch-story` (or the named skill). Owner column is for the human
running this sprint.

### Day 1 (today) — P0 cutover blockers

- [x] ~~**D1-1**~~ — **already shipped**. `packages/api/test/webhooks/clerk-webhook-integration.test.ts` (262 LOC, labeled EXP-3) covers happy path, idempotency, bad-sig, missing headers, missing secret, existing-tenant short-circuit, async response timing. Audit missed this; X1 is closed.
- [x] **D1-2** done (commit `7241c41`, merged `de886d6`) — `createEmbeddingProvider()` added; `real-llm-gateway-factory.ts` moved under `ai/gateway/` as `real-layer-two-factory.ts`; 59 gateway tests green; bypass grep returns 0
- [ ] **D1-3** *(in flight)* X4 add `helmet()` to `packages/api/src/app.ts` with explicit CSP (Clerk + Stripe + Twilio)
- [x] **D1-4** product decisions resolved (see §2) — locked 2026-05-16
- [ ] **D1-5** `/security-review` — cumulative diff for PRs #382 + #383 → report into `docs/quality/` — *owner:*

### Day 2 — Audit trail + revenue paths

- [x] **D2-1 ALL SUB-BATCHES COMPLETE** — 18 route files now emit audit events; 19 canary smoke tests green
  - [x] **D2-1c** done (`b19983c`) — proposals (wired `logProposalEvent`) + settings + users + feature-flags (5 canary tests; uses `metadata.scope='platform'` for feature-flag cross-tenant tracking); 411 regression tests pass
  - [x] **D2-1a** done (`0185a6f` → `66c0074`) — appointments + locations + notes + conversations (4 canary tests); kept `auditRepo` optional in router factories for test back-compat
  - [x] **D2-1b** done (`92d9b18` → `d72d1e9`) — catalog + templates + bundles (3 canary tests); DELETE uses `archived` event (soft-delete)
  - [x] **D2-1d** done (`9802928` → `a63b944`) — portal + calendar-integrations + public-estimates + public-feedback + public-invoices (4 canary tests); shared `publicActorFromToken()` helper for synthetic `public:<sha256(token).slice(0,12)>` actors
  - [x] **D2-1e** done (`f9edbfc` → `22c0f32`) — pack-activation + maintenance-contracts (3 canary tests)
- [x] **D2-2** done (`fb33a02` → `6b57cdb`) — `RESTRICTED_DISABLED_REASONS` set (6 reasons) + account.updated webhook persists status; 21 tests pass
- [x] **D2-3** done (`ceff2d0`) — phone-number → tenant lookup via `tenant_integrations.provider_data->>'phoneE164'`; prod miss → Sentry error + "not in service" TwiML; dev fallback retained with WARN; 129 telephony tests pass
- [x] **D2-4** done (`eb15b73` → `3d130f9`) — migration 100 adds `refunded_amount_cents`/`refunded_at`/`last_refund_stripe_id`; `recordRefund()` service + `charge.refunded` webhook; tax export emits negative-income rows dated by `refundedAt`; money dashboard gross vs net; 22 tests. **Follow-up:** checkout flow needs to stamp `payment_id` on Stripe metadata so refund webhook can resolve payments.

### Day 3 — Voice agent prompts + transcript regression

- [ ] **D3-1** `/dispatch-story` — 3B wire `formatVerticalForCallerPrompt()` into `intent-classifier.ts` SYSTEM_PROMPT
- [ ] **D3-2** `/dispatch-story` — 3C maintenance-plan awareness in `buildCallerContext()`
- [ ] **D3-3** `/dispatch-story` — 3D `intake_questions` array on `VerticalPack` + HVAC/plumbing defaults
- [ ] **D3-4** `/dispatch-story` — 3E `objection_scripts` on tenant settings + per-vertical defaults
- [ ] **D3-5** `/dispatch-story` — Media Streams transcript regression suite (10 anonymized real-call fixtures)

### Day 4 — Voice provider latency (Tier 2; gated on decision #3)

- [ ] **D4-1** `/dispatch-story` — Tier 2 finish wiring `DeepgramStreamingProvider`; gate `STT_PROVIDER=deepgram`; staging smoke
- [ ] ~~**D4-2** `/dispatch-story` — Tier 2 implement `ElevenLabsTtsProvider`~~ — **deferred to week 2 (decision #3)**
- [ ] **D4-3** `/dispatch-story` + `/qa` — Run `scripts/voice-load-test.*` at 50 concurrent calls; report into `docs/quality/load-test-2026-05-19.md`

### Day 5 — Settings stubs + ops hardening

- [ ] **D5-1** `/dispatch-story` ×3 — close 3 of 8 settings stubs that don't need OAuth (Reminders timing, Team members, Roles)
- [ ] **D5-2** `/dispatch-story` — P7-020 dependency audit (replace `glob` old / `async` / `superagent`); `npm audit` clean
- [ ] **D5-3** `/dispatch-story` — P7-023 full-stack `scripts/smoke-test.sh` (signup → estimate → invoice → payment → voice); wire into deploy
- [ ] **D5-4** `/dispatch-story` — X8 tenant TZ bucketing (per decision #4); migrate money-dashboard + tax-export
- [ ] **D5-5** `/dispatch-story` — X7 drop `example.com` fallback in `NewJobFlow.tsx:552`; X10 subscribe supervisor wall to session channel

### Day 6 — Full QA + resilience-flag flip rehearsal

- [ ] **D6-1** `/qa` — top 5 journeys: signup, estimate-approval-execution, invoice-to-payment, in-app voice, telephony voice
- [ ] **D6-2** `/review` — cumulative branch diff
- [ ] **D6-3** Resilience-flag rehearsal in staging: enable `gateway.breaker_enforcement`, `gateway.retry_enabled`, `gateway.fallback_enabled`, `gateway.tenant_quota_enforced`; 2h soak; observe Sentry. Use `/investigate` on any anomaly.
- [ ] **D6-4** `/health` — quality scan; bookmark `as any` for backlog

### Day 7 — Ship

- [ ] **D7-1** `/security-review` — final pass on cumulative branch
- [ ] **D7-2** `/qa` — production smoke (Day 5 script) + manual dry-run on staging
- [ ] **D7-3** `/ship` — production deploy with flag-flip plan from D6-3
- [ ] **D7-4** `/document-release` — update `docs/codebase-readiness-assessment.md` + runbooks; `/retro` end of day

### Explicitly deferred past this week

- 5 remaining settings stubs that need OAuth (Calendar sync, Zapier, Rivet subscription, Payment methods/Deposit rules backend extension)
- Original P7 integrations (QuickBooks sync, Zapier, full feature-flag UI, degraded mode, backup/recovery)
- 8 `as any` escapes (cosmetic — P7-024)
- 9 EC-* edge cases in `remaining-features.md` §5
- 5 skipped voice-quality tests (Phase 2 corpus authoring — X11)
- Empty test stubs under `agreements/leads/workers/__tests__` (X12)

---

## Section 1 — Status Snapshot

### 1.1 Just shipped (last 48 h)

**PR #382 — Onboarding self-serve setup**
- Shell + sidebar + 5 step components (Identity / Pack / PhoneNumber / Billing / TestCall)
- `useOnboardingStatus` hook, `ProtectedRoute` auth guard
- `GET/PUT /api/onboarding/{status,identity,pack,test-call/skip}` (Zod-validated)
- 30-min upgrade-nudge banner + email; Playwright e2e (Task 20)
- Migration 098 `tenant_settings` onboarding fields
- Trial checkout session + end-trial-now (Stripe)

**PR #383 — Launch Quality Bar (§11 H1-H5)**
- **H1:** `ProposalExecutor` `IdempotencyGuard` + indexed `findByIdempotencyKey` + double-delivery tests
- **H2:** Voice structural smoke (Layer A) + deploy gate + `voice-smoke-real` cron
- **H3:** Sentry init + per-event tag scoping + `instrument()` helper on 4 critical paths (Stripe webhook, Twilio streams, execution worker, voice action router)
- **H4:** Migration-discipline test (migrations immutable)
- **H5:** Voice load-test script
- 5 runbooks: alerting, rollback, migration-discipline, voice-capacity, launch-quality-bar

### 1.2 Open / in-progress branches

| Branch | Last touch | State |
|---|---|---|
| `claude/codebase-review-status-1nFGz` | 2026-05-16 (this branch) | Working tree clean — used for this review |
| `cursor/vertical-voice-training-assets-00ce` | 2026-05-15 | In-progress; not merged |

### 1.3 Known-incomplete by tier

**Tier 1 — Phase 8 calling-agent hardening**
- End-to-end load testing on Media Streams path (script exists; not run)
- Real-call transcript regression suite (no fixtures yet)
- Post-launch cost tuning (data-driven; needs traffic)

**Tier 2 — Voice provider upgrades (latency)**
- `DeepgramStreamingProvider` scaffolded only, not wired — `packages/api/src/voice/transcription-providers.ts`
- `ElevenLabsTtsProvider` not started — `packages/api/src/ai/tts/tts-provider.ts`
- Without these: Twilio TTFA ≈ 800 ms vs target < 800 ms

**Tier 3 — Domain knowledge / prompts**
- 3A `emergency_dispatch` intent — **DONE**
- 3B vertical terminology helper landed in `verticals/context-assembly.ts` but **NOT WIRED** into `intent-classifier.ts`
- 3C maintenance-plan awareness in `buildCallerContext()` — **OPEN**
- 3D per-vertical `intake_questions` — **OPEN**
- 3E `objection_scripts` — **OPEN**

**Tier 4 — UI polish (settings stubs)**
- 5/13 closed end-to-end; **8 remain** in `packages/web/src/components/settings/SettingsPage.tsx`:
  Reminders & follow-ups, Team members, Roles & permissions, Payment methods, Deposit rules, Rivet subscription, Calendar sync, Zapier

**Tier 5 — Operational / hardening**
- P7-020 dependency audit (old `glob`, deprecated `async`, `superagent`)
- P7-023 generic `npm run smoke-test` (voice-smoke exists; no full-stack smoke)
- P7-025 50-concurrent-user load test (voice-only exists)
- P7-024 8 `as any` escapes
- P7 integrations: QuickBooks, Zapier, support tooling, feature-flag UI, degraded mode, backup/recovery, launch checklist

### 1.4 Cross-cutting gaps surfaced by this audit

| ID | Sev | Gap | Evidence |
|---|---|---|---|
| **X1** | **P0** | Clerk webhook → `bootstrapTenant()` has no integration smoke; silent failure = signed-in user with no tenant, every API call 403/500 | `plan.md` §CEO review; no test |
| **X2** | **P0** | LLM gateway bypasses outside `packages/api/src/ai/gateway/` | `ai/voice-quality/audio/real-llm-gateway-factory.ts`; `app.ts` voice-transcription |
| **X3** | **P1** | 28 of 47 route files don't inject `auditRepo` — violates CLAUDE.md "all mutations emit audit events" | `packages/api/src/routes/*.ts` (grep) |
| **X4** | **P1** | No `helmet` middleware — no CSP, HSTS, X-Frame-Options | `packages/api/src/app.ts` |
| **X5** | **P1** | `TWILIO_DEFAULT_TENANT_ID` fallback when phone-number → tenant lookup misses | `packages/api/src/routes/telephony.ts:17` |
| **X6** | **P1** | Can't distinguish pending vs restricted Stripe Connect status (revenue path) | `packages/api/src/billing/stripe-connect.ts:64` |
| **X7** | **P2** | Hardcoded `example.com` fallback for customer email | `packages/web/src/components/jobs/NewJobFlow.tsx:552` |
| **X8** | **P2** | Money dashboard + tax export bucket by UTC, not tenant TZ | `TODOS.md`; `packages/api/src/reports/money-dashboard.ts:resolveMonthWindow` |
| **X9** | **P2** | Partial refunds unrepresentable — `PaymentStatus` binary; magnitude lost | `TODOS.md` |
| **X10** | **P2** | Supervisor wall not subscribed to session channel | `packages/web/src/hooks/useActiveSessions.ts:41` |
| **X11** | **P3** | 5 skipped voice-quality tests (Phase 2 corpus authoring) | `test/voice-quality/voice-quality{,.layer2}.test.ts` |
| **X12** | **P3** | Empty test stubs under `agreements/__tests__`, `leads/__tests__`, `workers/__tests__` (<200 bytes) | filesystem |
| **X13** | info | 10 resilience feature flags default-off (intentional dark-launch) — flip plan needed pre-launch | `packages/api/src/flags/resilience-flags.ts` |

---

## Section 2 — Product Decisions (locked 2026-05-16)

All 4 decisions resolved with sprint defaults. Override by editing this section
and rolling forward to dependent tickets.

1. **`sendInvoice` auto-issue:** **Option A — auto-issue on send.** `sendInvoice` on a draft auto-calls `issueInvoice()` first (sets `issuedAt` + `dueDate` from tenant payment-term days). Aligns with estimate-send behavior. → Affects D5-1 and any invoice-send code touched in D2-1.
2. **Resilience-flag flip plan:** **Gateway flags ON at cutover; WS flags dark for week 1.** Flip `gateway.breaker_enforcement`, `gateway.retry_enabled`, `gateway.fallback_enabled`, `gateway.tenant_quota_enforced` during D6-3 rehearsal → ride to prod on D7. `ws.client_gateway_enabled` and the other 5 `ws.*` flags stay off through week 1. → Rolled into D6-3 + `docs/runbooks/rollback.md`.
3. **Tier 2 voice provider scope:** **Ship Deepgram this week; defer ElevenLabs to week 2.** Streaming STT closes the larger latency gap (1-3 s → ~300 ms) and the scaffold already exists. ElevenLabs TTS is a separate week-2 ticket. → D4-1 keeps; D4-2 deferred (struck below).
4. **Tenant TZ source:** **Explicit `tenant.timezone` (IANA) field in settings, defaulted from address inference at signup.** User can override. → D5-4 implements both: migration adds `timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'`; onboarding identity step infers from address; settings page exposes it.

---

## Section 3 — Critical Files Map

When dispatching tickets, point each agent at the right neighborhood:

- **Routes / audit (X3 / D2-1):** `packages/api/src/routes/*.ts` (47 files); pattern in `bundles.ts`
- **LLM gateway (X2 / D1-2):** `packages/api/src/ai/gateway/{factory,failover}.ts`; offenders: `ai/voice-quality/audio/real-llm-gateway-factory.ts`, `app.ts`
- **Helmet / app entry (X4 / D1-3):** `packages/api/src/app.ts`
- **Voice providers (Tier 2 / D4):** `packages/api/src/voice/transcription-providers.ts`, `packages/api/src/ai/tts/tts-provider.ts`, `packages/api/src/config/index.ts`
- **Calling-agent prompts (Tier 3 / D3):** `packages/api/src/ai/orchestration/intent-classifier.ts`, `packages/api/src/ai/orchestration/context-builder.ts`, `packages/api/src/verticals/{context-assembly.ts,packs/{hvac,plumbing}.ts}`
- **Clerk bootstrap (X1 / D1-1):** `packages/api/src/auth/clerk.ts:bootstrapTenant`, `packages/api/src/webhooks/routes.ts:125`
- **Partial refunds (X9 / D2-4):** `packages/api/src/payments/`, `packages/api/src/reports/tax-export.ts`
- **Money / TZ (X8 / D5-4):** `packages/api/src/reports/money-dashboard.ts:resolveMonthWindow`, `packages/web/src/components/reports/MoneyDashboardPage.tsx:monthRange`
- **Telephony tenant lookup (X5 / D2-3):** `packages/api/src/routes/telephony.ts:17`
- **Stripe Connect (X6 / D2-2):** `packages/api/src/billing/stripe-connect.ts:64`
- **Settings stubs (Tier 4 / D5-1):** `packages/web/src/components/settings/SettingsPage.tsx`
- **Resilience flags (X13 / D6-3):** `packages/api/src/flags/resilience-flags.ts`
- **Runbooks (Tier 5):** `docs/runbooks/{alerting,rollback,migration-discipline,voice-capacity,launch-quality-bar}.md`

---

## Section 4 — Skills Map

| Need | Skill | Why |
|---|---|---|
| Execute a single ticket end-to-end in isolation | `/dispatch-story <id>` | Runs in worktree, commits + opens PR |
| Diagnose a specific bug (X1 silent webhook, etc.) | `/investigate` | Bug-first workflow |
| Manual UI bug-hunt across journeys (D6-1) | `/qa` | Purpose-built |
| Per-PR code review (each dispatched ticket) | `/review` | Catches drift from CLAUDE.md |
| Security pass on cumulative diff (D1-5 / D7-1) | `/security-review` | Top-of-list before cutover |
| Codebase quality scan (D6-4) | `/health` | Surfaces hot spots / debt |
| Architecture call on Tier-2 provider swap | `/plan-eng-review` | If anyone disputes the design |
| Brand/visual pass on onboarding flow | `/design-review` | New UI deserves a polish lap |
| Final deploy (D7-3) | `/ship` | Standard cutover |
| Post-launch doc update (D7-4) | `/document-release` | Tier-5 deliverable |
| Friday retro on the sprint | `/retro` | Captures lessons |

`/loop` is useful for babysitting CI or polling smoke results during D6 / D7.

---

## Section 5 — Verification Gates

Each gate must be green before the next sprint day starts:

- **Pre-cutover build:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` — confirm pass in CI (review container has no `node_modules`, so local appears to error on missing `@types/node`)
- **Per-ticket:** `/review` on the PR before merge
- **Cross-cutting greps:**
  - X2: `grep -rE "new (Anthropic|OpenAI)" packages/api/src | grep -v ai/gateway/` returns 0
  - X3: `auditRepo` referenced in all mutation route files
  - X7: `grep -r "example.com" packages/web/src` returns 0
- **Day 4 voice load test:** TTFA p50 < target (400 ms STT, 300 ms TTS)
- **Day 6 QA:** every journey in `tests/playwright/journeys/*` green; `/security-review` clean
- **Day 7 cutover:** smoke green in prod within 5 min of deploy; Sentry error budget intact for 1 h

---

## Section 6 — Risks

1. **One week is tight for full Tier 1-5.** If anything slips, de-scope order: D5 settings stubs → Tier 2 ElevenLabs → Tier 2 Deepgram → Tier 3 (3C/3D/3E). **Cutover-blocker items (D1, D2, D7) are non-negotiable.**
2. **Clerk webhook race (X1)** is the single most likely day-1 failure mode — signed-up users with no tenant = 100% API failure for that user. **D1-1 must land first.**
3. **Resilience-flag flip (D6-3)** is the only way we verify §11 H3 instrumentation under load. Skipping it leaves breaker / retry / fallback paths untested in real traffic.
4. **Voice provider upgrades** are latency-only — agent works without them, just feels slow. Safe to defer if Tier 1/3 work runs over.
5. **Resilience flags default-off** is intentional; flip plan (decision #2) must be documented in `docs/runbooks/rollback.md` before cutover.
