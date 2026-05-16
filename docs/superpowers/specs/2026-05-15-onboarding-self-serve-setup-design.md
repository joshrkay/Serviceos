# §10 Onboarding & Self-Serve Setup — Design

**Date:** 2026-05-15
**Spec slot:** §10 of [serviceos-launch-readiness](./2026-05-14-serviceos-launch-readiness-design.md)
**Status:** Approved, ready for implementation planning

---

## Goal

Stitch existing onboarding fragments (Clerk bootstrap, business-identity form, vertical-pack seeding, Twilio provisioning worker, Stripe billing) into one guided, **resumable** flow that:

1. Gets a freshly-signed-up tenant from "signed up" to "the business is running" without human intervention.
2. Collects a credit card and starts a **14-day free trial**, after which the agent stops answering inbound calls until billing is reactivated.
3. Bounds fraud exposure during the trial via layered usage caps.

The gap is **integration, not invention**: the underlying pieces exist. This spec defines the new glue (status endpoint, sidebar UI, trial gates, test-call detection) and the small set of additive schema changes needed to support them.

---

## Architecture

A single `/onboarding` route owns the experience. The page has a fixed left sidebar listing the 6 mandatory steps (each with a status icon: ✓ done, → current, ○ pending, ⚠ error) plus an "Optional" footer with two carry-over steps from the existing wizard (terminology preferences, automation rules). The main pane renders the current step's form/state.

**Resumability is derived, not stored.** A new read-only endpoint `GET /api/onboarding/status` composes the truth from existing entities. No new `onboarding_progress` table; there is exactly one source of truth per fact, and reloading the page recomputes the same answer.

**Derivation rules** — a step is `done` when:

| Step | "Done" rule (derived) |
|---|---|
| 1 Sign up | `tenants` row exists (always true if request authenticates) |
| 2 Identity | `tenant_settings.business_name`, `business_hours`, `job_buffer_minutes`, `hourly_rate_cents` all present |
| 3 Pack | ≥ 1 row in `tenant_packs` with `status='active'` |
| 4 Phone | `tenant_integrations.twilio_status='full_readiness'` |
| 5 Billing | `tenants.stripe_subscription_id` present AND `subscription_status` ∈ {`trialing`, `active`} |
| 6 Test call | A `voice_sessions` row exists for this tenant with `direction='inbound'` AND `ended_at IS NOT NULL` (any real inbound call counts), OR `tenant_settings.onboarding_test_call_skipped_at` is set |

The endpoint returns `{ steps: [{id, status, blockers?}], currentStep, isComplete }`. Cached for 2s per tenant. UI re-fetches after each mutation.

**Auth-gating.** A frontend guard on the app shell redirects to `/onboarding` whenever `isComplete === false`, except when the route is already `/onboarding/*` or `/login`/`/signup`. The backend does not block API calls based on onboarding state — the route guard is purely UX. The hard gate (voice agent stops answering) lives at the Twilio inbound webhook and is enforced separately.

---

## Step-by-step UX

### Step 1 — Sign up

No UI in `/onboarding`. Clerk handles signup at `/signup`. On `user.created`, the existing webhook bootstraps the `tenants` row and enqueues the Twilio provisioning worker. The user lands on `/onboarding`, which already shows step 1 ✓.

### Step 2 — Business identity

One short form. Fields:

- **Business name** (text, required)
- **Trade** (read-only display of the pack picked in step 3 — empty until then)
- **Service area** (free text + radius in miles)
- **Business hours** (per-day open/close; `null` for any closed day)
- **Job buffer** (minutes between jobs, default 30)
- **Hourly rate** (dollars, stored as `hourly_rate_cents`)

On save, PUTs to `/api/onboarding/identity`. Validated by Zod contract in `packages/shared/src/contracts/onboarding.ts`. Writes to `tenant_settings`.

### Step 3 — Pick your trade

Two cards: **HVAC** and **Plumbing**, each with a short blurb ("Includes 12 job types, 40 line items, 18 message templates"). Click → POST `/api/onboarding/pack` → backend calls existing `activatePack(tenantId, packId)`. Card flips to "✓ Activated" with a "Browse what we set up" link (opens a side panel listing templates/line items, read-only).

Single primary pack only at onboarding. "Add another trade" lives in Settings post-onboarding (out of scope for this spec).

### Step 4 — Phone number

Polls `GET /api/onboarding/status` every 3s. Three states:

- **Provisioning** — spinner + "We're claiming your phone number… usually 30 seconds."
- **Ready** — shows the number large, with a Copy button and a "Forward your existing business line to this number" collapsible card containing carrier-specific star-codes (Verizon, AT&T, T-Mobile, "other"). "I'll do this later" link is always available.
- **Failed** — red banner with the error and a Retry button that re-enqueues the worker.

User clicks Continue to advance. No DB write — the worker's success is what makes step 4 ✓.

### Step 5 — Subscribe + start trial

One Stripe action. Button: "Start 14-day free trial." Click → backend creates a Stripe Checkout Session in subscription mode with `trial_period_days: 14` and `payment_method_collection: 'always'` (card required). Redirects to Stripe-hosted checkout. On success, Stripe webhook fires `customer.subscription.created` with `status='trialing'` — existing webhook updates `tenants.stripe_subscription_id` + `subscription_status`. UI re-fetches status; step 5 flips to ✓.

### Step 6 — Test call

Shows the provisioned number again + "Call this number from your phone right now. We'll detect it." UI polls `/api/onboarding/status` for an inbound `voice_sessions` row ending in the last 5 minutes. When detected, step 6 flips to ✓ and the screen becomes a **"You're live"** moment: full-screen confirmation, single CTA "Go to dashboard."

A "Skip — I'll test later" link is always available; clicking it POSTs `/api/onboarding/test-call/skip` which sets `tenant_settings.onboarding_test_call_skipped_at`. Step 6 marks ✓ with a "skipped" badge.

### Optional steps (after go-live)

After all 6 mandatory ✓, the sidebar's "Optional" footer becomes interactive. The dashboard banner becomes "Polish your setup (2 optional steps)." Owner can open **Tune terminology** and **Set automation rules** from there or dismiss the banner forever. The fields/UI for these two steps are kept from the existing 9-step wizard, simply relocated; their backend persistence path is unchanged.

---

## Data + API surface

### Schema changes

One migration: `019_tenant_settings_onboarding_fields.sql`.

```sql
ALTER TABLE tenant_settings
  ADD COLUMN business_hours       JSONB    NOT NULL DEFAULT '{}',
  ADD COLUMN service_area_text    TEXT,
  ADD COLUMN service_area_radius  INT,
  ADD COLUMN job_buffer_minutes   INT      NOT NULL DEFAULT 30,
  ADD COLUMN hourly_rate_cents    INT,
  ADD COLUMN onboarding_test_call_skipped_at TIMESTAMPTZ,
  ADD COLUMN onboarding_upgrade_prompt_shown_at TIMESTAMPTZ;
```

`business_hours` shape (validated by Zod):

```ts
{ mon: { open: "08:00", close: "17:00" } | null, tue: ..., ... }
```

`null` means closed that day.

No new tables.

### API surface

A new `packages/api/src/routes/onboarding.ts` router (replaces the existing single POST):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/onboarding/status` | Derived status snapshot. Cached 2s per tenant. |
| `PUT` | `/api/onboarding/identity` | Upsert business identity fields. Validates Zod contract. |
| `POST` | `/api/onboarding/pack` | `{ packId: 'hvac' \| 'plumbing' }` → activates pack. Idempotent. |
| `POST` | `/api/onboarding/billing/checkout-session` | Creates Stripe Checkout session, returns URL. |
| `POST` | `/api/onboarding/test-call/skip` | Sets `onboarding_test_call_skipped_at`. Returns updated status. |

Plus one endpoint outside the onboarding router that the early-upgrade nudge depends on (see Trial gate section):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/billing/end-trial-now` | Sets the Stripe subscription's `trial_end = now`, triggering an immediate invoice. |

Step 4 has no endpoint of its own — the UI just polls `/api/onboarding/status` and reads `twilio_status` from the existing `tenant_integrations` row. The provisioning worker is already enqueued by the Clerk webhook; we don't re-trigger it from onboarding unless the user clicks Retry (which calls the existing worker enqueue path, idempotent).

### Shared contracts

`packages/shared/src/contracts/onboarding.ts`:

- `OnboardingStatusResponse`
- `BusinessIdentityInput` (Zod schema)
- `PackPickInput`

### Audit events

Emitted on every onboarding mutation: `tenant.identity_set`, `tenant.pack_activated`, `tenant.subscription_started`, `tenant.test_call_skipped`.

---

## Trial gate + anti-fraud

The billing gate is a layered defense. Four gates fire in order on every inbound call (or where applicable, on signup/outbound).

### Gate A — Subscription status gate

A new check at the top of the Twilio inbound webhook (`packages/api/src/voice/inbound.ts`):

```
if subscription_status NOT IN ('trialing', 'active')
  → return TwiML <Say>"This number is being set up. Please call back later."</Say>
  → <Hangup/>
  → emit audit_events.type = 'voice_blocked_no_billing'
```

Covers two scenarios with one check:

- **Pre-step-5 fraud window** — number is provisioned at step 4 but no card on file yet. Any call hits the cheap voicemail, not the AI. AI cost = $0.
- **Trial expired without payment** — same TwiML, same audit event.

Twilio still charges for the inbound minute of voicemail (~$0.0085/min in US), but AI/OpenAI cost is zero and the call ends in seconds.

### Gate B — Trial usage caps

Even with a valid card, a stolen-card trial could rack up AI minutes. During `subscription_status='trialing'`, we cap usage per tenant:

| Limit | Value |
|---|---|
| Inbound AI minutes per UTC day | 60 |
| Total inbound AI minutes for the trial | 100 |
| Concurrent inbound calls | 2 |

Both caps active; whichever hits first wins. After the 100-minute trial total is exhausted, the tenant is voicemail-only until subscription transitions to `active`.

The voice webhook reads today's and lifetime `voice_sessions` aggregate for the tenant (indexed query) before routing to AI. Over either cap → same voicemail TwiML + `audit_events.type = 'voice_blocked_trial_cap'`. UI shows a banner: "Trial cap hit. Subscribe to remove limits." Limits drop away when status transitions to `active`.

**Fraud math:** worst-case stolen-card trial: 100 AI minutes × ~$0.10/min combined Twilio + OpenAI ≈ **$10 max exposure per fraudulent trial**.

### Gate C — Outbound restrictions

If/when the agent places outbound calls (callbacks, confirmations), wrap the Twilio dial call in `packages/api/src/voice/outbound.ts` (new) with an allowlist:

- **E.164 country code:** US/Canada only (`+1`). Block everything else.
- **NPA blocklist:** premium-rate (`+1-900`, `+1-976`) and known toll-fraud ranges. Maintained as a constant array.
- **Destination type check:** Twilio Lookup API (`carrier` field) — block `voip` destinations resolving to known premium-rate carriers.
- **Per-tenant outbound minutes/day cap during trial:** 10 minutes/day.

If the voice agent currently has no outbound capability, Gate C reduces to a guardrail constant file with no live integration — to be confirmed during implementation.

### Gate D — Signup velocity + Radar (out of scope here)

Per-IP and per-card-fingerprint signup rate limits, Twilio Voice Insights enrollment, and Stripe Radar tuning. Tracked as a follow-up: `docs/superpowers/specs/<later>-trial-abuse-hardening-design.md`.

### Configuration

Caps are constants (`packages/api/src/voice/trial-limits.ts`), not per-tenant settings — operators must not be able to lift their own caps. Override only via env var (`TRIAL_VOICE_MINUTES_DAILY_OVERRIDE`, `TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE`) for staging/QA.

### Early-upgrade nudge at 30 minutes of trial usage

A soft prompt to convert trial → paid early, independent of the hard caps.

- **Trigger:** cumulative `voice_sessions` minutes for the tenant across the trial reaches 30. Computed on the same indexed query the cap-check uses.
- **What fires:** one-time in-app banner ("You've used 30 minutes — your AI is earning. Lock in your subscription now and the trial bills today.") + one email via the existing notifications provider. Records `tenant_settings.onboarding_upgrade_prompt_shown_at` so it never repeats.
- **CTA:** "End trial and subscribe now" → POST `/api/billing/end-trial-now` → backend updates the Stripe subscription with `trial_end: 'now'`, triggering an immediate invoice and a `customer.subscription.updated` webhook flipping status to `active`. UI re-fetches.
- **No blocking.** This is a conversion hook, not a gate.

### Audit + observability

Every gate hit emits a typed audit event (`voice_blocked_no_billing`, `voice_blocked_trial_cap`, `voice_blocked_outbound_disallowed`). Prom counter `voice_blocks_total{reason}` so we can alert when block volume spikes (signal of attempted abuse).

---

## Testing

### Unit (`packages/api/.../onboarding/*.test.ts`)

- `deriveOnboardingStatus()` pure function — feed mock entity states, assert returned step statuses + currentStep.
- `business_hours` Zod validator — valid/invalid shapes.
- `trial-limits.ts` cap evaluator — at/under/over each cap, with mock `voice_sessions` aggregate.

### Integration (`packages/api/.../onboarding/*.integration.test.ts` with testcontainers Postgres)

- Full status endpoint round-trip: bootstrap tenant → call status → assert step 1 ✓, rest pending. Save identity → step 2 ✓. Activate pack → step 3 ✓. Etc.
- Migration `019` runs cleanly forward.
- Stripe webhook handler updates `subscription_status` and the trial-cap evaluator picks it up.
- Voice webhook gate: with `subscription_status='canceled'`, inbound call → voicemail TwiML + `voice_blocked_no_billing` audit event. With cap exceeded → voicemail + `voice_blocked_trial_cap`.

### E2E (`e2e/onboarding.spec.ts`)

- Fresh Clerk signup via `@clerk/testing` tokens → lands on `/onboarding` → sidebar shows step 2 active.
- Fill identity form → sidebar updates to step 3 → pick HVAC pack → step 4 active.
- Mock the Twilio provisioning worker to mark `full_readiness` immediately → step 5 active.
- Mock Stripe Checkout completion via webhook fixture → step 6 active.
- Skip test call → see "You're live" → redirected to `/`.
- Reload mid-flow at step 3 → returns to step 3 (resumability check).
- Trial-cap E2E: seed a tenant with 99 voice_session minutes → inbound call routes to AI; with 100 minutes → routes to voicemail.

---

## Rollout

Single PR, feature-flagged by env var `ONBOARDING_V2_ENABLED`. When off, the existing `OnboardingPage.tsx` and `/api/onboarding/configure` keep working. When on, the new `/onboarding` route, sidebar, six-step API surface, and voice gates take over. Migration `019` ships unconditionally (additive, default values supplied).

Rollout sequence:

1. Migration deployed to dev + staging.
2. Flag flipped on in dev → manual smoke of all 6 steps + trial-cap behavior using a real Twilio dev number and Stripe test mode.
3. Flag flipped on in staging → invite a handful of internal testers through a fresh signup.
4. Flag flipped on in production → monitor `voice_blocks_total{reason}` and `audit_events.type='tenant.subscription_started'` dashboards.
5. Delete old wizard code in a follow-up PR after 7 days of clean production traffic.

### Observability

- Prom counters: `voice_blocks_total{reason}`, `onboarding_step_completed_total{step}`, `trial_upgrade_prompt_total{outcome}`.
- Dashboard tile: funnel from signup → step 2 done → step 3 done → step 4 done → step 5 done → step 6 done. Conversion ratios per step surface where users drop.
- Alert: `voice_blocks_total{reason="trial_cap"}` spike rate > 20/hr → likely fraud attack.

---

## Out of scope (follow-up specs)

1. **Signup velocity + Stripe Radar + Twilio Voice Insights** — Gate D above. Separate hardening spec.
2. **Multi-pack support** — adding HVAC + Plumbing simultaneously from Settings.
3. **Localization** — copy is English-only.
4. **Mobile-specific layout** — sidebar collapses to top dropdown under 768px; full mobile-first redesign is a follow-up.

---

## Decisions log

| # | Decision | Rationale |
|---|---|---|
| 1 | Full §10 spec in one plan, not phased | User chose to ship the complete stitched flow rather than incremental slices |
| 2 | Resumability derived from real entities | One source of truth; no `onboarding_progress` table to drift |
| 3 | Voice agent stops answering when unpaid | Hard gate makes billing the actual gate; matches spec |
| 4 | Existing wizard fields (terminology, automation rules) kept as optional steps | Preserves the work; doesn't bloat the mandatory path |
| 5 | Single primary pack at onboarding | Matches spec; cleaner AI behavior; multi-pack deferred to Settings |
| 6 | Test call = owner calls the new number, backend detects it | True end-to-end; catches misconfigured inbound webhooks |
| 7 | Sidebar checklist layout (not linear stepper or dashboard card) | Always-visible state; supports jumping/retrying |
| 8 | Daily AI minute cap 60, trial total 100 | Tightens fraud exposure to ~$10/trial; creates strong conversion pressure on heavy users by day 2 |
| 9 | 30-minute usage upgrade nudge (one-time banner + email) | Strikes at moment of revealed value, before caps pinch |
