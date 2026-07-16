# PostHog Instrumentation Strategy — Website → App → Feature

Companion to [`FUNNEL.md`](../FUNNEL.md). `FUNNEL.md` defines the acquisition →
activation → conversion funnel. This document covers the layer that funnel
stops at: **what a paying tenant actually does inside the product day to day**,
plus how we use PostHog to see bugs, measure feature usage, and close a
feedback loop as we roll the tool out.

Every recommendation here respects the two design rules already baked into the
wrappers: **off-by-default** (no key → no emission) and **no PII / no
credential ever leaves the device** (`packages/web/src/lib/analytics.ts`,
`packages/api/src/analytics/posthog.ts`, `packages/web/src/lib/errorReporter.ts`).

---

## 0. The one thing to fix first

**No product events are reaching the PostHog project today.** A schema read of
the connected project shows only PostHog's built-in events plus a stray
`test_event` — none of `view_landing`, `signup_completed`, `wizard_started`,
`app_error`, etc. The instrumentation exists in code but is not producing data.

Before any of the build-out below matters, confirm the pipeline end to end:

1. `POSTHOG_API_KEY` (server) and `VITE_POSTHOG_KEY` (web, injected via
   `env.js.template` → `getRuntimeConfigValue`) are set in the **production**
   Railway environment and point at the **same** project.
2. Do one authenticated E2E pass and watch **Activity → Live events** in
   PostHog. If `view_landing` and `signup_completed` don't show up, nothing
   downstream will.

Everything else is wasted effort until events actually flow.

---

## 1. Baseline — what's already wired (and what isn't)

| Area | Status | Where |
|---|---|---|
| Client wrapper, off-by-default, central event registry | ✅ Good | `web/src/lib/analytics.ts` |
| Server wrapper, off-by-default, flush on shutdown | ✅ Good | `api/src/analytics/posthog.ts` |
| Acquisition → onboarding → activation → conversion funnel | ✅ Instrumented | `FUNNEL.md` |
| Frontend error capture (`app_error`, redacted) | ✅ Good | `web/src/lib/errorReporter.ts` |
| `identify()` → stable user id (Clerk `userId`) | ✅ Good | `AnalyticsIdentityBridge.tsx` |
| **Group analytics by tenant** | ❌ Missing | `identify()` sets only `emailDomain` |
| **In-app feature usage (the whole product)** | ❌ Dark | assistant, proposals, estimates, invoices, jobs, scheduling, customers, catalog, voice, settings |
| **Backend errors / API 5xx in PostHog** | ❌ Dark | `captureRequestError` writes to the request logger only, not PostHog |
| **Customer feedback (1–5 ratings) in PostHog** | ❌ Dark | persisted + audited in `public-feedback.ts`, never mirrored to PostHog |
| Session replay | ❌ Off | `disable_session_recording: true` |
| Autocapture / pageview capture | ❌ Off (deliberate) | `autocapture: false`, `capture_pageview: false` |
| Second analytics tool (Pendo) running in parallel | ⚠️ Decision needed | `AnalyticsIdentityBridge.tsx` |

**The gap in one sentence:** we can see a user arrive, sign up, onboard, and
convert — and then they vanish. The moment they're a paying customer *using*
the product, PostHog goes blind. That's exactly the window where "what features
do they use" and "where do they hit bugs" live.

---

## 2. Design principles (decide these once, apply everywhere)

### 2.1 Identity + groups — the biggest B2B lever

We're a multi-tenant B2B product, so almost every question is really
"how many **tenants** do X," not "how many **users**." Today `identify()`
binds the Clerk `userId` and sets `emailDomain` only. Add **group analytics**:

- **Client:** after `identify()`, call `posthog.group('tenant', tenantId, {...})`
  with tenant-level traits (see below). Wire it in `AnalyticsIdentityBridge`
  where `/api/me` already provides `tenant_id`, `role`, `current_mode`.
- **Server:** pass `groups: { tenant: tenantId }` on every `capture()` so
  server events join the same group.

**Group (tenant) properties** to set: `vertical` (pack), `plan` /
`subscription_status`, `voice_agent_live`, `seat_count`, `created_at`,
`activated` (bool). These let every insight break down by tenant type without
touching the event payloads.

**Person properties** to set: `role`, `current_mode`, `can_field_serve`.

This one change makes "% of active tenants using the AI assistant," "adoption
by vertical," and "which plan churns" answerable — none of which are possible
with user-only identity.

### 2.2 The server-vs-client rule — "moment of truth vs. moment of intent"

Instrument each event on exactly one side, chosen by this rule:

- **Server (source-of-truth business events)** → the API route that commits the
  state change. Use these for anything that *is* the value: a proposal
  approved, an estimate accepted, an invoice paid, a call handled. Reasons:
  - It's the truth — it fired because the DB row changed, not because a button
    was clicked.
  - Immune to ad-blockers (a real fraction of `posthog-js` loads are blocked).
  - Fires no matter the channel — voice, SMS, one-tap email link, public API —
    not just the React app.
  - **Safe on credential-bearing public routes.** `/portal/:token`,
    `/feedback/:token`, `/e/:id`, `/pay/:id` carry the secret *in the URL*.
    Emitting these client-side risks leaking the token (which is exactly why
    `capture_pageview` is off). Server-side capture sidesteps it entirely.
- **Client (interaction / intent events)** → the React component. Use these for
  things the server never sees: a page/tab viewed, a filter applied, a form
  started but abandoned, time-on-step, a CTA clicked, a search run.

Rule of thumb: **if it changed a row, capture it server-side; if it's a
gesture, capture it client-side.**

### 2.3 Naming taxonomy

- `object_action`, snake_case, past tense: `proposal_approved`,
  `estimate_sent`, `invoice_paid`, `customer_created`.
- Keep the **central registry** discipline that already exists — add every new
  name to the `AnalyticsEvent` union (client) and the server event catalog, and
  extend `analytics.funnel.test.ts` so an un-registered name fails CI.
- Standard properties on **every** event: `tenant_id`, `user_id`, `source`
  (`'web'` | `'server'`), `timestamp`, plus a stable `entity_id` (the row id —
  **not** a customer name, phone, or address). Reuse the `trackFunnel()` shape.
- **Generalize the server wrapper.** Today `recordFunnelEvent()` accepts a
  fixed 5-value `FunnelEvent` union. Add a sibling `recordProductEvent(name,
  { tenantId, userId, ...props })` (same off-by-default client, same
  `groups: { tenant }`) so business events aren't forced through the funnel
  union. Keep the funnel names frozen — renaming breaks dashboards.

### 2.4 PII guardrails (don't regress the good instincts)

- Never put a customer name, phone, email, address, token, or money-in-free-text
  into an event property. IDs and enums only.
- Keep `autocapture: false` (autocapture would scrape proposal/customer names
  off the DOM — the comment in `analytics.ts` already calls this out).
- When session replay is enabled (§7), mask all inputs and block PII selectors.
- Public token routes: server-side events only, keyed by the resolved
  `tenant_id` / entity id — never the token.

---

## 3. Layer A — Acquisition (the website)

Mostly covered. Verify these fire and add the two gaps:

| Event | Side | Where | Status |
|---|---|---|---|
| `view_landing` | client | `landing/LandingPage.tsx` | ✅ |
| `view_features` / `view_pricing` / `view_about` / `view_download` | client | `marketing/*` | ✅ |
| `pricing_cta_clicked` / `landing_signup_clicked` | client | landing + pricing | ✅ |
| `download_app_clicked` | client | `marketing/StoreBadges.tsx` | ✅ |
| `signup_started` | client | `auth/SignupPage.tsx` | ✅ |
| **Marketing attribution** (utm_*, referrer) | client | set once as person props on first touch | ➕ add |
| **Nav / scroll-depth on pricing** | client | pricing page | ➕ optional |

Attribution is the one real gap: capture `utm_source/medium/campaign` +
`referrer` on the first pre-auth event and persist them as person properties so
you can answer "which channel produces tenants that *activate*," not just
tenants that sign up.

---

## 4. Layer B — Onboarding → Activation → Conversion

Already the strongest part of the stack (`FUNNEL.md`). Leave it alone except:

- Add `groups: { tenant }` to the server activation + conversion events once
  §2.1 lands, so they roll up per tenant.
- Consider an explicit `onboarding_abandoned { last_step }` server sweep (a
  daily job) so drop-off is a first-class event, not only a
  viewed-without-completed reconstruction. Optional — the reconstruction in
  `FUNNEL.md` already works.

---

## 5. Layer C — In-app product usage (the core build-out)

This is the missing layer and the answer to *"what are the most common features
they're using."* Instrument the value path first, then breadth.

Legend: **S** = server (route file), **C** = client (component). "★" = core
value moment — instrument these first.

### 5.1 AI Assistant / Conversations / Proposals — the core loop ★

This is the product. The human-in-the-loop approval gate is *the* value moment.

| Event | Side | Where |
|---|---|---|
| `assistant_message_sent` | C | `assistant/AssistantPage.tsx`, `conversations/MessageInput.tsx` |
| `proposal_generated` | S | `routes/proposals.ts` (on create) |
| `proposal_viewed` | C | `conversations/ProposalCard.tsx` |
| `proposal_approved` ★ | S | `routes/proposals.ts`, `routes/one-tap-approve.ts` |
| `proposal_rejected` ★ | S | `routes/proposals.ts` |
| `proposal_edited_before_approve` | S | `routes/proposals.ts` |
| `proposal_undone` | S | `routes/one-tap-undo.ts` |
| `clarification_shown` / `clarification_answered` | C | `conversations/ClarificationCard.tsx` |

Approve-vs-reject rate, broken down by proposal type and by whether the price
was catalog-grounded (per the `catalog-resolver` confidence rule), is the
single most important product-health metric we don't currently have.

### 5.2 Voice ★

| Event | Side | Where |
|---|---|---|
| `call_received` | S | `voice/activation.ts` path / `routes/calls.ts` |
| `voice_session_started` / `_ended` | S | `routes/voice-sessions.ts` |
| `voice_clarification_raised` / `_resolved` | S | entity resolver / voice path |
| `call_outcome` `{ booked \| estimate \| message \| no_action }` | S | call completion |

`first_real_call_received` (activation) already exists — these extend it into
ongoing voice-usage and voice-quality signal.

### 5.3 Estimates → Invoices → Payments (the money path) ★

| Event | Side | Where |
|---|---|---|
| `estimate_created` / `estimate_sent` | S | `routes/estimates.ts` |
| `estimate_viewed` (customer) | S | `routes/public-estimates.ts` (token-safe server-side) |
| `estimate_approved` ★ / `estimate_declined` | S | `routes/public-estimates.ts` |
| `deposit_paid` | S | `routes/public-payments.ts` |
| `invoice_created` / `invoice_sent` | S | `routes/invoices.ts` |
| `invoice_viewed` (customer) | S | `routes/public-invoices.ts` |
| `invoice_paid` ★ | S | `routes/payments.ts` / `routes/public-payments.ts` |
| `payment_failed` | S | payment webhook handler |

All money paths are server-side by rule §2.2 — several are token routes where
client capture would leak the token, and payment truth lives in the webhook.

### 5.4 Jobs / Scheduling / Appointments

| Event | Side | Where |
|---|---|---|
| `job_created` / `job_status_changed` | S | `routes/jobs.ts`, `routes/recurring-jobs.ts` |
| `appointment_scheduled` / `_rescheduled` / `_cancelled` | S | `routes/appointments.ts` |
| `technician_assigned` / `_reassigned` | S | `routes/appointments.ts` |
| `booking_submitted` (customer) | S | `routes/public-booking.ts` |
| `reschedule_dialog_opened` (intent) | C | `appointments/RescheduleDialog.tsx` |

### 5.5 Customers / CRM / Catalog

| Event | Side | Where |
|---|---|---|
| `customer_created` / `customer_merged` | S | `routes/customers.ts` |
| `note_added` / `interaction_logged` | S | `routes/notes.ts`, `routes/interactions.ts` |
| `intake_submitted` (customer) | S | `routes/public-intake.ts` |
| `catalog_item_created` / `_edited` | S | `routes/catalog-items.ts`, `routes/bundles.ts` |
| `customer_search_run` (intent) | C | `customers/CustomersPage.tsx` |

### 5.6 Settings / Integrations (drives retention + support load)

| Event | Side | Where |
|---|---|---|
| `integration_connected` `{ provider }` | S | `routes/integrations.ts`, `routes/calendar-integrations.ts`, `routes/telephony.ts`, `routes/financing.ts` |
| `integration_disconnected` `{ provider }` | S | same |
| `settings_updated` `{ section }` | S | `routes/settings.ts` |
| `pack_activated` `{ vertical }` | S | `routes/pack-activation.ts` |

`provider` ∈ `google_calendar | twilio | vapi | stripe | quickbooks | wisetack`.
Integration connect/disconnect is a leading indicator of both value and churn.

---

## 6. Bug visibility — "where customers are seeing bugs"

Four complementary signals; we have one.

1. **Frontend errors — already live.** `app_error` (redacted `{name, message,
   source}`) via `errorReporter.ts`. Keep it. Optionally also enable
   `posthog-js` **Error Tracking** so these group into issues with trends and
   spike alerts (the project already has `$exception` /
   `$error_tracking_issue_*` scaffolding). Keep the redaction — feed the safe
   shape, not raw stacks.
2. **Backend errors — the gap.** `captureRequestError` only stashes the error
   for the request logger. Add a PostHog capture in the **global Express error
   handler** in `app.ts` (the terminal `app.use((err, _req, res, _next) => …)`
   that maps `toErrorResponse`) for any 5xx: emit `api_error { route, status,
   source, tenant_id }` — **no** request body, headers, or message with PII. Also cover
   LLM gateway failures and async worker (P0-009) job failures. Without this,
   "customer hit a 500" is invisible in PostHog.
3. **Session replay (masked) — highest-leverage bug tool.** Turn on replay
   **for the authenticated app only** with `maskAllInputs: true` and PII
   selectors blocked. When an `app_error` / `api_error` fires or a customer
   reports a bug, you watch the exact session that produced it. Leave it off on
   public token routes.
4. **Frustration signals — free.** `$rageclick` and `$dead_click` are already
   available event types; enable them to catch broken-but-not-throwing UI
   (a button that does nothing) that no exception would surface.

**Tie bugs to the funnel:** an error during onboarding step X or during
proposal approval is a conversion/retention killer. Build a "errors by funnel
step" and "error rate by tenant" view so a spike is attributable.

---

## 7. Feature-usage analytics — "what are the most common features"

Once §5 events flow, this is a dashboard, not new code.

- **Define "active" for this product.** Candidate north-star: a tenant that
  **approves ≥1 proposal** or **handles ≥1 real call** in a week. Everything
  else is a supporting metric.
- **Feature Adoption dashboard:**
  - `query-trends` of each feature event, **broken down by tenant `vertical`
    and `plan`** (needs §2.1 groups).
  - **% of active tenants** using each feature (not raw counts — a handful of
    power tenants distort totals).
  - `query-stickiness` on the assistant (days/week used) → separates habitual
    from trial-tire-kickers.
  - `query-retention` keyed on the activation event → does feature X predict
    week-4 retention?
  - `query-paths` from app login → what do users actually do first / next.
- **Segment every headline metric by vertical.** A plumbing tenant and a
  cleaning tenant use the product differently; blended averages hide it.

---

## 8. Feedback loop — "start a loop with customers"

Three mechanisms, cheapest first.

1. **PostHog Surveys (no code).** Configured in PostHog, targeted by event /
   person / group properties:
   - **NPS** to the owner N days after `first_real_call_received`.
   - **Behavior-triggered micro-surveys:** after the 3rd `proposal_rejected`
     → "why did you change this?"; after first `invoice_paid` → one-tap CSAT;
     on an `app_error` spike for a tenant → "did something just break?"
   - Target by group so you survey *tenants*, and suppress for anyone who
     answered recently.
2. **Mirror the feedback we already collect.** The 1–5 customer ratings in
   `public-feedback.ts` are persisted and audited but never reach PostHog. Add
   a server-side `customer_feedback_submitted { rating, has_comment, job_id,
   tenant_id }` alongside the existing audit write. Now CSAT correlates with
   feature usage, errors, and vertical — the loop's payoff.
3. **In-app "report a problem" → replay.** Add a lightweight affordance that
   emits `feedback_reported` and (with replay on, §6.3) links straight to the
   session recording. A bug report that arrives with a replay attached is
   triaged in minutes, not a back-and-forth.

**Close the loop** with §9: when feedback identifies a fix, ship it behind a
flag to the affected segment and watch the same events move.

---

## 9. Rollout instrumentation — flags + experiments

We roll the tool out to real customers now, so measure the rollout itself.

- **Reconcile the two flag systems.** There's a homegrown registry
  (`routes/feature-flags.ts`, platform-admin gated, per-tenant/env). It gates
  behavior but PostHog can't see exposure. For **customer-facing rollout**,
  prefer **PostHog feature flags** so flag exposure auto-correlates with the
  §5 feature events and the funnel. Keep the homegrown registry for
  operational/kill-switch flags. Document which system owns which flag.
- **Experiments:** when a change is meant to move a metric (e.g. a new proposal
  UI meant to raise approval rate), run it as a PostHog experiment against
  `proposal_approved` so the impact is measured, not asserted.
- **Reconcile Pendo.** `AnalyticsIdentityBridge` also identifies to **Pendo**.
  Running two tools doubles the PII surface and the maintenance. Decide:
  PostHog as system-of-record for behavior/funnels/replay/errors/flags/
  experiments; Pendo (if kept) for in-app guides *only*. Otherwise drop it.

---

## 10. The "add these during the next E2E test" checklist

Run one full pass, website → paid feature use → feedback, and confirm each
fires (Activity → Live events). This is the literal punch-list.

**Acquisition:** `view_landing` · `view_pricing` · `pricing_cta_clicked` ·
`signup_started`
**Signup/onboarding:** `signup_completed` (S) · `wizard_started` ·
`wizard_step_business/phone/voice/calendar` · `wizard_completed` ·
`test_call_initiated` · `test_call_succeeded`
**Activation/conversion:** `first_real_call_received` (S) · `trial_to_paid` (S)
**Core value loop (new):** `assistant_message_sent` · `proposal_generated` (S)
· `proposal_approved` (S) · `proposal_rejected` (S)
**Money path (new):** `estimate_sent` (S) · `estimate_approved` (S) ·
`invoice_sent` (S) · `invoice_paid` (S)
**Voice (new):** `call_received` (S) · `call_outcome` (S)
**Ops (new):** `job_created` (S) · `appointment_scheduled` (S) ·
`integration_connected` (S)
**Bugs:** `app_error` (force one) · `api_error` (force a 5xx) · a replay exists
for the session
**Feedback:** `customer_feedback_submitted` (S) · an NPS/CSAT survey renders

Cross-check: **`tenant` group is set** on the identified user, and every server
event carries `groups: { tenant }`.

---

## 11. Sequencing

- **P0 (make the data trustworthy):** confirm keys/events actually flow (§0);
  add tenant **group analytics** + group/person properties (§2.1); mirror
  `customer_feedback_submitted` (§8.2). Small, unblocks every breakdown.
- **P1 (see the product + the bugs):** core-value + money-path server events
  (§5.1, §5.3, §5.2); `api_error` in the global error handler (§6.2);
  generalize the server wrapper to `recordProductEvent` (§2.3).
- **P2 (deepen + close the loop):** session replay masked + Error Tracking
  (§6.3–6.4); Surveys / NPS (§8.1); PostHog-flag-gated rollout + the Feature
  Adoption and Errors-by-step dashboards (§7, §9); reconcile Pendo.

---

## 12. Guardrails (carry forward, don't regress)

- IDs and enums in properties — never customer name / phone / email / address /
  token / free-text money.
- Public token routes → **server-side events only**, keyed by resolved ids.
- Keep `autocapture: false`; keep replay masked; keep the off-by-default gate.
- Every new event name goes in the central registry, enforced by
  `analytics.funnel.test.ts`.
- New pure logic (e.g. a `recordProductEvent` catalog, an `api_error`
  redactor) ships with unit tests in the same commit, per `CLAUDE.md`.
