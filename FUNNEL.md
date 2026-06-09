# Onboarding → Activation → Conversion Funnel

The launch funnel for ServiceOS (Rivet), from first landing-page view to paid
conversion. Every event is emitted through the analytics wrappers
(`packages/web/src/lib/analytics.ts` client, `packages/api/src/analytics/posthog.ts`
server), which are **off-by-default** — no `POSTHOG_API_KEY` / `VITE_POSTHOG_KEY`,
no emission. PostHog stitches browser + server events by `distinct_id` (the Clerk
`userId`).

## Required payload (every funnel event)

| field | meaning |
|---|---|
| `tenant_id` | the tenant the event belongs to (null on pre-auth events until `identify()` binds it) |
| `user_id` | Clerk user id (= server `distinctId`); null pre-auth |
| `timestamp` | ISO-8601 emit time |
| `source` | `'web'` (client) or `'server'` |

Client events go through `trackFunnel(event, { tenantId, userId }, extra?)`, which
stamps the four fields uniformly. The server activation event passes them in
`properties`.

## The funnel

| # | Event | Where it fires | Client/Server | Trigger | Extra props |
|---|---|---|---|---|---|
| 1 | `view_landing` | `web/.../landing/LandingPage.tsx` | client | landing page mount | — |
| 2 | `signup_started` | `web/.../auth/SignupPage.tsx` | client | signup form mount | — |
| 3 | `signup_completed` | `api/.../webhooks/routes.ts` (Clerk `user.created` → `bootstrapTenant`) | server | tenant + owner row created | — |
| 4 | `wizard_started` | `web/.../onboarding/v2/OnboardingShell.tsx` | client | first status load with `isComplete=false` | — |
| 5 | `wizard_step_business` | `OnboardingShell.tsx` | client | user reaches the `identity` step | `step` |
| 6 | `wizard_step_phone` | `OnboardingShell.tsx` | client | user reaches the `phone` step | `step` |
| 7 | `wizard_step_voice` | `OnboardingShell.tsx` | client | user reaches the `ai_check` (voice) step | `step` |
| 7b | `wizard_step_calendar` | `CalendarChoicePanel.tsx` | client | user chooses a calendar provider (google/builtin) | `provider` |
| 8 | `wizard_completed` | `OnboardingShell.tsx` (alongside existing `onboarding_completed`) | client | `isComplete` flips true | `voice_agent_live` |
| 9 | `test_call_initiated` | `web/.../onboarding/v2/steps/TestCallStep.tsx` | client | user taps the number / copies it (call intent) | — |
| 10 | `test_call_succeeded` | `TestCallStep.tsx` | client | test_call step flips to `done` (inbound detected) | — |
| 11 | `first_real_call_received` **[ACTIVATION]** | `api/.../voice/activation.ts` (called from `app.ts onSessionEnded`) | server | first real inbound call after go-live (idempotent once/tenant) | `inbound_call_count` |
| 12 | `trial_to_paid` **[CONVERSION]** | `api/.../webhooks/routes.ts` (Stripe `customer.subscription.updated`, trialing→active) | server | trial converts to a paid subscription | `priorStatus` |

### Generic per-step events (drive abandonment)

| Event | Where | Trigger | Extra |
|---|---|---|---|
| `onboarding_step_viewed` | `OnboardingShell.tsx` | each time a step becomes active (deduped per step) | `step` |
| `onboarding_step_completed` | `OnboardingShell.tsx` | a step flips to `done` (seeded on first load so resumed sessions don't replay) | `step` |

The real wizard steps are `signup → identity → pack → phone → billing → ai_check →
test_call`. The spec's named steps map onto them (table above); the extra real
steps (`pack`, `billing`) carry only the generic `onboarding_step_*` events.

## Architecture notes (post "go-fully-literal")

The launch spec assumed Next.js/Supabase/pnpm; this repo is Vite/React-Router +
Express + in-code migrations + npm. The **features** were built literally on that
real stack (the framework was deliberately NOT rewritten — see DECISIONS.md D9):

- **Vapi is now a real integration** (`integrations/vapi/*`): fetch-based client
  (no SDK dep, off-by-default), assistant created + linked to the provisioned
  Twilio number during onboarding, `vapi_assistant_id` stored on `tenant_settings`
  (migration 147). **Vapi webhook signature** = `integrations/vapi/signature.ts`
  (HMAC + shared-secret, fail-closed); idempotent on call id via `webhook_events`.
- **`wizard_step_voice`** = the `ai_check` step, now with a real ElevenLabs voice
  picker (`VoiceConfigPanel`) that persists + pushes to the Vapi assistant.
- **`wizard_step_calendar`** = the calendar provider choice (`CalendarChoicePanel`),
  persisting `tenant_settings.calendar_provider`.
- Twilio signature verification (`telephony/twilio-signature.ts`) remains enforced
  for the Twilio voice/SMS webhooks.

## Abandonment instrumentation

Drop-off is reconstructed in PostHog, no extra server signal:

> A user **abandoned at step X** = an `onboarding_step_viewed { step: X }` event
> with **no** subsequent `onboarding_step_completed { step: X }`.

`onboarding_step_viewed` fires for every step the user lands on (deduped per step
via a ref `Set` so the 3-second status poll can't double-count). The furthest
viewed-without-completed step is the abandonment point. The server already knows
the furthest *completed* step via `derive-status.ts` `currentStep`, so no
`onboarding_progress` table is needed.

## Activation rule (`first_real_call_received`)

Two detection paths, both writing the same once-per-tenant `activated_at` marker
(so they can never double-fire):

**Identity-based (primary — the Vapi webhook path).** The Vapi `end-of-call-report`
carries the caller number, so `maybeFireActivationForInboundCall` fires when the
caller is NOT one of the tenant's verified phones (the owner's cell
`tenant_settings.owner_phone` or the tenant's own `business_phone`) — i.e. a real
customer, not the owner's test call.

**Count-based (fallback — the Twilio `onSessionEnded` path).** When only Twilio is
wired, `onSessionEnded` receives only `{ tenantId, channel }` (no caller number), so
a count-based rule matches the product flow (the onboarding test call is the first
inbound call; the first *real* call is the next):

```
fires when:
  channel === 'voice_inbound'
  AND tenants.subscription_status ∈ {trialing, active}
  AND tenant_settings.voice_agent_live_at IS NOT NULL   (agent is live)
  AND tenant_settings.activated_at IS NULL              (not already activated)
  AND inbound_call_count >= threshold
      where threshold = onboarding_test_call_skipped_at ? 1 : 2
```

- Test call made (not skipped): call #1 = test (no fire), call #2 = first real (fires).
- Test call skipped: the first real inbound call (#1) fires immediately.

**Idempotency:** a check-and-set
`UPDATE tenant_settings SET activated_at = now() WHERE tenant_id = $1 AND activated_at IS NULL`
guarantees the event + activation email fire **exactly once per tenant, forever**
(replays / concurrent calls write 0 rows → no-op).

On activation: `first_real_call_received` funnel event + `tenant.activated` audit
event + a best-effort activation email to the owner. Drives the in-app
`ActivationCelebrationBanner`. The identity-based variant is deferred (see
BLOCKED.md).

## Conversion + payment health

- `trial_to_paid` (existing, server) fires from the Stripe
  `customer.subscription.updated` handler on trialing→active.
- Past-due state is **not** a funnel event; it's surfaced as the in-app
  `PastDueBanner`, driven off `tenants.subscription_status === 'past_due'`
  (mirrored by the Stripe `customer.subscription.*` webhook). Stripe stays the
  source of truth — no `plan` / `trial_ends_at` / `payment_status` columns added.

## Existing events (unchanged — additive only)

These pre-existing events were **not** renamed or removed (breaking event names is
a downstream dashboard break): `signup_completed`, `trial_started`, `trial_to_paid`,
`subscription_canceled` (server); `onboarding_completed`, `voice_agent_turned_on`,
`first_ai_call_detected`, `pricing_cta_clicked`, `landing_signup_clicked` (client).
