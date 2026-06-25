# Rivet (ServiceOS) — Launch Readiness Assessment vs Master PRD v4

_Date: 2026-06-25 · Method: evidence-based, file:line-verified across 8 parallel
verification lanes + the build/test gates. Supersedes the 2026-05-24
`GO-LIVE-READINESS.md` (all 10 of its blockers are now confirmed fixed)._

> **Stack note:** the canonical product is the TypeScript stack in `/packages`
> (Express API + React/Vite web + Expo mobile, deployed on **Railway**). The
> PRD's *literal* stack (Next.js / Supabase / LangGraph / Vercel / Inngest) is
> the quarantined `/experiments` prototype, **not** what ships. The PRD's
> *features* were built on the real stack; map PRD concepts accordingly
> (Inngest → in-process leader-locked sweeps; Supabase → in-code Postgres
> migrations in `db/schema.ts`).

---

## Overall verdict: **READY_WITH_GAPS** — the core product is genuinely shippable

This is a real, production-grade SaaS, not a prototype. The full commercial spine
— online signup (Clerk) → durable Pg-backed webhook idempotency → 14-day
card-on-file Stripe trial → automatic trial→paid conversion → billing-gated
onboarding → leader-locked scheduled sweeps → graceful shutdown — is wired
end-to-end from the composition root and verified file:line. The web app is the
design wired to live APIs; the mobile app is a real Clerk-authed, API-backed Expo
client.

**It is READY_WITH_GAPS, not READY, because of three things — none of which is a
broken core flow:**

1. **Production env/config + external webhook wiring** must be set (ops, no code).
2. **Mobile release config** must be completed before any App Store / Play upload.
3. **Three P0-labeled PRD epics are genuinely unbuilt** (E17 Change Orders, E16
   field-status fast-path, E15 missed-call auto-response). These are *missing
   capabilities*, not broken ones — a product decision is required on whether they
   are launch-day promises or fast-follow.

---

## Gate status (run 2026-06-25, this environment)

| Gate | Result |
|------|--------|
| API production build — `tsc --project tsconfig.build.json` | ✅ PASS (exit 0) |
| Web build — `tsc --noEmit && vite build` | ✅ PASS (exit 0) |
| Mobile typecheck — `tsc --noEmit` | ✅ PASS (exit 0) |
| **API unit/component tests** | ✅ **8,487 passed**, 4 skipped, 43 todo (821 files) |
| **Web unit/component tests** | ✅ **1,396 passed** (216 files) |
| Integration / RLS tests (Docker-gated) | ⚠️ **Not runnable here** — testcontainers images (`pgvector`, `ryuk`) are unreachable under this sandbox's network policy. **Run in PR CI** (`pr-checks.yml` runs them on testcontainers Postgres). |

The "no bugs" bar is strong for everything the unit/component suites cover. The
critical-path bug hunt (money / auth / tenant-isolation / proposal execution)
found **no reproducible defect**.

---

## The 10 May go-live blockers — all FIXED (re-verified in current code)

| # | Blocker (2026-05-24) | Status | Evidence |
|---|----------------------|--------|----------|
| 1 | Stripe/Clerk webhook idempotency in-memory | ✅ FIXED | `PgWebhookRepository` wired `app.ts:860,900`; `createWebhookRouter` throws in prod without it (`webhooks/routes.ts:207`) |
| 2 | Txn commits on error | ✅ FIXED | `tenant-context.ts:150` commits only when `statusCode<400`; `close` always rolls back |
| 3 | RLS not FORCEd | ✅ FIXED | 104 FORCE vs 105 ENABLE; the one delta is a duplicate CREATE block re-declared FORCE in canonical block (`schema.ts:1193,1216`) |
| 4 | Web approval unauthenticated | ✅ FIXED | `AssistantPage.tsx:267` uses `apiFetch` (bearer attached) |
| 5 | In-process sweeps duplicate on multi-instance | ✅ FIXED | `runAsLeader` + `pg_try_advisory_lock` wraps every sweep; `clearInterval` on SIGTERM/SIGINT (`app.ts:1878,5196`) |
| 6 | `recordPayment` not audited | ✅ FIXED | emits `payment.recorded` + `invoice.status_changed` (`payment.ts:360-399`) |
| 7 | No double-booking protection | ✅ FIXED | `EXCLUDE USING gist no_double_booking` (`schema.ts:3408`) + 409 mapping + assignment audit |
| 8 | Estimate page mock-data leak | ✅ FIXED | network error → error screen, no fixture fallback (`EstimateApprovalPage.tsx:646-650`) |
| 9 | Conflicting deploy story | ✅ FIXED | CDK/prototype quarantined under `experiments/` with README; CI excludes them |
| 10 | CI build/tests/migrations green | ✅ FIXED (mechanism) | `pr-checks.yml` runs build+unit+integration+coverage; migrations via Railway `preDeployCommand`. **Residual: confirm the GH Actions run is green on the launch commit + the `no_double_booking` constraint actually installed in prod (not skipped by the overlap guard).** |

---

## Pillar verdicts

| Pillar | Verdict | One-line |
|--------|---------|----------|
| **Signup → Free Trial → Paid** | READY_WITH_GAPS | Full chain wired & functional; only blocker is setting prod Stripe/Clerk env + dashboard webhooks (no code). |
| **PRD E01–E08** (CRM/jobs/estimates/invoices) | READY_WITH_GAPS | Vast majority of P0 wired; small non-blocking deltas (US-069 detail tabs, US-032 assign-SMS, US-001 signup-fields-deferred). |
| **PRD E09–E15** (field, comms, QB, settings, inbound/missed-call) | NOT_READY | QuickBooks + inbound voice agent solid, but **E15 missed-call is record-only** and SMS booking has no AI agent. |
| **PRD E16–E22** (field-update, change-orders, lifecycle, BI, equipment, collections, briefing) | NOT_READY | Sweep infra + BI lookups + record_payment/clock/notes work, but **E16 status fast-path & E17 change-orders are absent**; E20 equipment missing. |
| **Mobile** | READY_WITH_GAPS | Real Clerk-authed, API-backed app; blocked only by release config (EAS projectId, push projectId, submit creds, assets, version). |
| **Design conformance** | READY_WITH_GAPS | Live web app *is* the design wired to APIs (mock-data-guarded); raw-palette leaks remain in the owner app; CustomerDetail/onboarding intentionally evolved past the design source. |
| **Go-live blockers (May)** | READY | All 10 fixed. |
| **Critical-path bug hunt** | READY | No reproducible money/auth/tenant/execution bug found. |

---

## LAUNCH BLOCKERS (must clear before customers)

### B1 — Production env vars + external webhook endpoints (ops, no code) · effort **S**
Billing/auth are hard-gated. Without these, signup→trial→paid silently 503s or the
API fails to boot.

Set in Railway (API):
`DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SECRET`,
`AI_PROVIDER_API_KEY`, `CORS_ORIGIN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_ID`, `WEB_URL`, plus Twilio/SendGrid/R2 unless their feature flags are
off (see `docs/prod-env-checklist.md`).

Set in Web build: `VITE_API_URL`, `VITE_CLERK_PUBLISHABLE_KEY`,
`VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_ONBOARDING_V2_ENABLED=true`.

Wire external dashboards:
- **Clerk** webhook → `https://<api>/webhooks/clerk`, event `user.created`.
- **Stripe** webhook → `https://<api>/webhooks/stripe`, events
  `customer.subscription.*`, `checkout.session.completed`, `charge.refunded`,
  `payment_intent.*`.

> ⚠️ Trial state is written **only** by the Stripe `customer.subscription.created`
> webhook. If the Stripe webhook isn't wired, tenants complete checkout but stay
> gated as `no_billing`. Verify webhook delivery in the Stripe dashboard.

### B2 — Mobile release config (mostly config) · effort **S–M**
- `eas init` to create the EAS project; add `extra.eas.projectId` + `owner` to `app.json`.
- Pass `projectId` to `Notifications.getExpoPushTokenAsync({ projectId })`
  (`src/push/nativePushDeps.ts:32` calls it bare → **throws in standalone builds → push silently dead for all prod users**).
- Fill `eas.json` submit creds (`appleId`/`ascAppId`/`appleTeamId` are
  `REPLACE_WITH_…`) or supply via EAS secrets.
- Replace placeholder assets (4.5 KB icon; no splash/adaptive/notification icons).
- Bump version `0.0.1` → `1.0.0`.
- Provide `EXPO_PUBLIC_API_URL` + `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in build profiles (default falls back to `localhost:3000`).

### B3 — PRODUCT DECISION: three P0-labeled PRD epics are unbuilt · effort **XS to decide, XL each to build**
Independently grep-verified absent in `packages/api/src` + `packages/shared/src`:
- **E17 Change Orders** (US-330–333): zero references anywhere. No table, no
  proposal type, no intent.
- **E16 field-status fast-path** (US-320–323): no `in_transit`/`on_my_way`/
  `arrived`/`heading`/`add_material` intents; `JobStatus` has no `in_transit`;
  `jobs` has no `arrived_at`/`in_transit_at`. _(record_payment, clock-in/out,
  add_note from E16 **are** built.)_
- **E15 missed-call handling** (US-310–312): the Twilio StatusCallback only
  branches on `kind==='sms'` and never inspects `CallStatus` — no 2-min auto-SMS,
  no missed-call lead, no reply agent.

These do **not** break the paying-customer loop. Decide: launch-day promises (hold)
or fast-follow (ship core now).

---

## PRD coverage matrix (by epic)

| Epic | P | Status | Notes |
|------|---|--------|-------|
| E01 Auth & Tenant Setup | P0 | ✅ Working | Clerk auth, role landing, conversational onboarding FSM, config approval. US-001: business-name/vertical captured in onboarding, not on the signup screen (deviation, no data loss). |
| E02 AI Assistant & Dispatch | P0 | 🟡 Working core | Assistant builds real proposals for customer/estimate/invoice intents + chaining; `create_job`/scheduling are voice-path-only in chat; server SSE exists but web posts non-streaming (US-019 minor). |
| E03 Job Management | P0 | ✅ Working | Voice create, filters, role-enforced backward-move+reason, timeline, cancel/no-show. Verify US-032 assign→SMS+in-app. |
| E04 Lead Management | P0/P1 | ✅ Working | Pipeline, convert, public intake. Owner **in-app/push** notification fires via `createLead`→`notifyOwnerLeadCaptured`; owner-**SMS** on web leads is not sent (product choice). |
| E05 Scheduling & Dispatch | P0/P1 | ✅ Working | Feasibility (overlap/hours/travel/skill), no double-book (DB constraint), reminders, late-arrival coordinator. |
| E06 Customer Management | P0 | ✅ Working (detail incomplete) | Voice create + pg_trgm dedup + search. **US-069: CustomerDetail lacks Jobs/Estimates/Invoices/Messages tabs + revenue badge** (P1). |
| E07 Estimates | P0 | ✅ Working | Agent draft, inline edit, deposit rules, send, public token approval, follow-up reminder. |
| E08 Invoices & Payments | P0/P1 | ✅ Working | Estimate→invoice, voice invoice, Stripe link, paid webhook + notify, deposits, QB sync. Confirm QB-sync + dunning-dismiss trigger on the paid path (US-092). |
| E09 Technician Field Tools | P0 | 🟡 Partial | Photos, clock-in/out, tech job view ✅. **US-046 materials-by-voice MISSING** (`job_parts` table not built; materials default to 0). |
| E10 Customer Communications | P0/P1 | 🟡 Partial | Document-send proposals ✅. **US-098 generic AI-drafted `message.send` (free-form, 48 hr, inline-editable) MISSING.** |
| E11 QuickBooks | P0 | ✅ Working | OAuth + sync worker + idempotency, leader-locked. (Direct QBO OAuth, not Nango — wording deviation.) |
| E12 Platform Settings | P0/P1 | 🟡 Partial | Profile direct-save ✅. **US-112: pricing/tax/deposit/threshold save directly with audit, NOT via `config.change` proposals** (no such proposal type) — invariant deviation. **US-109: team removal does not block-and-reassign open jobs.** |
| E13 Onboarding Intelligence | P0/P1 | ✅ Working | Adaptive conversation FSM; correction-lesson loop wired; `setTemplateWeight` cascade is a no-op stub (US-120 partial). |
| E14 Inbound Voice & SMS Agent | P0 | 🟡 Partial | **Voice** agent + per-tenant Twilio provisioning ✅ (env-gated). **SMS channel is keyword-only — no AI book/leave-message/reschedule agent** (US-302/305/306). Vapi webhook is analytics-only. |
| E15 Missed Call Handling | P0 | ❌ Missing | Status callback is record-only (see B3). |
| E16 Field Update Agent | P0 | 🟡 Partial | record_payment/clock/notes ✅; **status fast-path (on-my-way/arrived/done/add-material) MISSING** (see B3). |
| E17 Change Orders | P0 | ❌ Missing | Zero references (see B3). |
| E18 Appointment Lifecycle | P0 | 🟡 Working w/ default gaps | 24 hr reminder, thank-you, completion ✅. **2 hr reminder not default** (Story 10.2 ships `[24]`; `[24,2]` is per-tenant config). **Review-request is voice-triggered, not an auto 24 hr-post-completion sweep.** |
| E19 BI Agent | P1 | ✅ Working (mostly) | Revenue/invoices/jobs/customer/day-overview lookups wired. Missing dedicated skills: estimate acceptance-rate (US-352), best job type (US-354). |
| E20 Equipment Tracking | P1 | ❌ Missing | No table, proposal type, lookup skill, or Equipment tab. |
| E21 Collections | P0 | 🟡 Partial | Overdue sweep + dunning engine wired and multi-step-capable, **but default cadence is day-3 only, not PRD 3/7/14** (US-372 day-14 should be an owner-review proposal). |
| E22 Daily Briefing | P1 | 🟡 Partial | Digest sweep wired, but **evening recap (default 18:00), not PRD morning 7am**; omits today's schedule list + missed-calls. On-demand "what's on my schedule" (US-382) ✅. |

---

## High-value, low-risk follow-ups (verified real; ready to build)

| Item | Effort | Why it matters |
|------|--------|----------------|
| US-069 CustomerDetail: Jobs/Estimates/Invoices/Messages tabs + revenue badge | M | Core CRM surface the PRD specifies; data endpoints already exist. |
| E18 auto review-request sweep (24 hr post-completion) + `review_platform_url` | M | Reputation loop is a stated core differentiator; mirror the thank-you-sms worker. |
| BI skills: estimate acceptance-rate (US-352) + best job type (US-354) | M | Closes E19 to full PRD. |
| US-032 confirm/add assign-tech SMS + in-app | S | P0 acceptance criterion; verify the `job.update(assigned_to)` execution path emits it. |
| Surface SSE streaming in AssistantPage (server already supports it) | S | Delivers US-019 streamed UX with no backend work. |

### Deliberate PRD divergences — need a product call, not a silent flip
These are **intentional, documented** choices that differ from the PRD. Changing
them affects customer-facing comms volume / behavior, so they're product
decisions, not bugs:
- **Appointment reminders default `[24]`** (Story 10.2) vs PRD `[24,2]`.
- **Collections default day-3 only** ("conservative default") vs PRD 3/7/14
  (with US-372 day-14 as an owner-review proposal).
- **Daily briefing is an evening recap (18:00)** vs PRD morning 7am.
- **Pricing/settings save directly-with-audit** vs PRD `config.change` proposal gate.

---

## Remaining roadmap (prioritized)

**P0 (decide launch-day vs fast-follow — see B3):**
1. E16 field-status fast-path — intents + `jobs.in_transit_at/arrived_at` + `in_transit` JobStatus + on-my-way SMS. **XL**
2. E17 Change Orders — table + `change_order.create` proposal + execution + customer re-approval portal + merge/decline logic. **XL**
3. E15 missed-call handler — status-callback branch: 2-min auto-SMS + `missed_call` lead + owner notify + reply continuation. **L**

**P1:**
4. US-069 CustomerDetail tabs + revenue badge — **M**
5. US-046 materials-by-voice — `job_parts` table + capture + mobile sheet + auto-invoice prefill — **XL**
6. E14 SMS-as-conversational-agent (route unclaimed SMS through the intent classifier) — **XL**
7. US-109 team-removal blocks-and-reassigns open jobs — **M**
8. E20 Equipment tracking (table + proposal + BI skill + Equipment tab) — **L**
9. E18 auto review-request sweep — **M**

**P2:**
10. E22 morning-briefing variant (07:00 default + today's schedule + missed-calls) — **M**
11. E12 `config.change` proposal gate for pricing edits (or amend PRD) — **L**
12. Tokenize owner-app pages to Rivet + extend the no-raw-palette guard beyond the portal cluster (1,718 raw-palette occurrences) — **L**
13. Mobile OTA via `expo-updates` (or document as out-of-scope for v1) — **S**

---

## Recommended launch sequence

1. **Now:** Set B1 prod env + wire Clerk/Stripe dashboard webhooks → smoke the
   signup→trial→paid loop on a real Stripe test card. Confirm the GH Actions run
   is green on the launch commit and the `no_double_booking` constraint installed.
2. **Now (parallel):** Complete B2 mobile release config → push an internal
   TestFlight / Play internal-testing build.
3. **Decide B3:** if E15/E16/E17 are launch-day promises, schedule them as the
   first post-merge PRs (each is its own focused PR with unit + Docker-gated
   integration tests); otherwise ship the core and treat them as fast-follow.
4. **Soft launch** the web product to pilot tenants on the verified core loop.
