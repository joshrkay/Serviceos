# LAUNCH REPORT — Onboarding + Conversion Launch-Readiness

ServiceOS (Rivet) — funnel instrumentation, activation milestone, conversion
hardening. Branch `claude/kind-pascal-2mv42`. Changes: **29 files, +1332/−9**,
all within in-scope dirs. Analytics changes are additive and off-by-default.

> Context: the launch spec targeted a Next.js/Supabase/Vapi/pnpm architecture this
> repo doesn't use (it's Vite/React-Router + Express + in-code migrations + Twilio +
> npm). Intent was mapped onto the real stack — see FUNNEL.md and DECISIONS.md.

---

## SHIPPED (with commit SHAs)

> Two phases. **Phase 1** (instrumentation + activation, mapped to the real stack).
> **Phase 2** (after the "go fully literal" decision, DECISIONS.md D9): the literal
> Vapi / voice / calendar / business-profile features built end-to-end.

| Feature | What shipped | Commit |
|---|---|---|
| 7. Activation milestone | migration `146` `activated_at`; `voice/activation.ts` (idempotent check-and-set, `first_real_call_received` + audit + email); `app.ts onSessionEnded`; status contract surfaces `tenantId`/`subscriptionStatus`/`activatedAt` | `c458b3d` |
| 1,2,4,6,8 + abandonment | client funnel events, `onboarding_step_viewed/_completed` abandonment, `trackFunnel`, `ActivationCelebrationBanner`, `PastDueBanner` | `5300a2e` |
| Test coverage | activation, posthog union, web funnel contract + components; integration tests + npm scripts; per-feature inventory tests | `6a270f1`, `3712570`, `0ccc03d` |
| **3. Vapi provisioning** | `integrations/vapi/*` (fetch client, assistant-config + 3 presets, HMAC/shared-secret webhook sig, idempotent webhook, identity activation); assistant create+link wired into provisioning; migrations 147–149; 25 tests | `d1c0f63` |
| **4. Voice config** | `voice/voice-config.ts` + `PUT /api/onboarding/voice` + `/voice/presets` (persist + push to assistant); `VoiceConfigPanel` UI | `ae1951b`, `596c8fc` |
| **2. Business profile** | `serviceAddress` / `serviceAreaZips` / `servicesOffered` (contract + `/identity` persistence + `IdentityStep` inputs) | `ae1951b`, `596c8fc` |
| **5. Calendar** | `calendar_provider` (migration 149) + `POST /calendar/choose` + `CalendarChoicePanel` (Google OAuth / built-in) + `wizard_step_calendar` | `ae1951b`, `596c8fc` |

All 8 inventory features now ship. Diff vs branch base: **54 files, +3694/−9**.

Per-feature named tests added this pass: `signup-fixtures.test.ts` (email / Google /
duplicate — feature 1), `IdentityStep.profile.test.tsx` (feature 2),
`onboarding-vapi.test.ts` (features 3/6/7, Docker-gated — Vapi end-of-call →
session + activation + isolation in real DB), `seed-from-google.test.ts` (feature 5),
plus the voice/calendar/activation/funnel suites.

## DEFERRED (reason + effort)

| Item | Reason | Effort |
|---|---|---|
| Framework re-platform (Next.js/Supabase) | Intentionally NOT done — would delete the working 6000-test Express/Vite app + existing tests. "Fully literal" applied to features, not the framework (DECISIONS.md D9). | N/A (by design) |

## BLOCKED (diagnosis)

| Item | Diagnosis |
|---|---|
| `test:rls`, `test:activation`, full `test/integration/**` | testcontainers `pgvector/pgvector:pg16` pull **403 Forbidden** from the registry blob CDN in this environment (also hits `postgres:16-alpine` → env-level egress block, not image-specific). Test files authored + type-checked; activation logic covered by unit tests that run here. |
| `test:e2e:onboarding` | Spec self-skips without Clerk testing creds + `VITE_ONBOARDING_V2_ENABLED`; DB path + Playwright `webServer` need the same blocked pgvector container + a bootable API. No Clerk keys in this env. |

Full diagnoses in BLOCKED.md.

---

## Funnel event inventory (every event, location, payload)

All events carry the required base payload `{ tenant_id, user_id, timestamp, source }`
(client via `trackFunnel`; server activation via `properties`). Full table + the
spec→real mapping in **FUNNEL.md**.

```
view_landing            web  LandingPage mount                         { + base }
signup_started          web  SignupPage mount                         { + base }
signup_completed        srv  Clerk user.created → bootstrapTenant      (existing)
wizard_started          web  OnboardingShell first incomplete load     { + base }
wizard_step_business    web  reach identity step                       { base, step }
wizard_step_phone       web  reach phone step                          { base, step }
wizard_step_voice       web  reach ai_check (voice) step               { base, step }
wizard_step_calendar    web  calendar provider chosen (CalendarChoicePanel) { base, provider }
wizard_completed        web  isComplete flips true                     { base, voice_agent_live }
test_call_initiated     web  tap/copy number (call intent)             { + base }
test_call_succeeded     web  test_call step → done                     { + base }
first_real_call_received srv voice/activation.ts (idempotent)          { base, inbound_call_count }   [ACTIVATION]
trial_to_paid           srv  Stripe subscription trialing→active       (existing)                    [CONVERSION]
onboarding_step_viewed   web each step active (deduped)                { base, step }   (abandonment)
onboarding_step_completed web step flips done (seeded)                 { base, step }   (abandonment)
```

## Abandonment instrumentation summary

Drop-off is reconstructed in PostHog with no extra server signal:
**abandoned at step X = `onboarding_step_viewed{step:X}` with no subsequent
`onboarding_step_completed{step:X}`**. `onboarding_step_viewed` fires for every step
the user lands on (deduped per step via a ref `Set` so the 3s status poll can't
double-count); `onboarding_step_completed` fires on the not-done→done transition,
with the tracking ref **seeded on first load** so resumed sessions don't replay
completions. The server's furthest-completed step is already known via
`derive-status.ts currentStep`. See FUNNEL.md → "Abandonment instrumentation".

## E2E / time-to-activation

The Playwright onboarding journey (`e2e/journeys/onboarding-v2.spec.ts`) **could not
run** here (BLOCKED — Clerk creds + bootable DB unavailable). What the path looks like
when run on a provisioned runner:

- **Steps to activation:** 7 wizard steps (`signup → identity → pack → phone →
  billing → ai_check → test_call`) → test call → **first real inbound call =
  ACTIVATION**. The wizard is resumable (state derived from real entities).
- **Time-to-activation (modeled by the integration test):**
  `onboarding-activation.test.ts` seeds a live, trialing tenant with the agent live
  and asserts the 2nd inbound `voice_inbound` session-end stamps `activated_at` and
  fires `first_real_call_received` + email **exactly once**; replay is a no-op. The
  activation path itself is a single `onSessionEnded` callback (sub-second), gated
  behind go-live + live subscription.
- **Failure points to watch in a real run:** (a) Clerk signup → `/onboarding`
  redirect latency; (b) Twilio number provisioning worker completing before the
  phone step (async); (c) Stripe Checkout redirect round-trip on the billing step.

## Test coverage delta — onboarding surface

Real path for the spec's `packages/web/app/(onboarding)/` is
**`packages/web/src/components/onboarding/`**. New tests added against this surface
and its server backing:

- `OnboardingShell` funnel logic — exercised via `analytics.funnel.test.ts`
  (every web funnel event fires with the 4 required fields) and component tests.
- `TestCallStep.funnel.test.tsx` — `test_call_initiated` (once/mount) +
  `test_call_succeeded` (on flip, not on resume). **New file.**
- `SignupPage.funnel.test.tsx`, `LandingPage.funnel.test.tsx` — top-of-funnel emits.
- Server backing: `voice/activation.test.ts` (10 unit cases),
  `onboarding/contracts.test.ts` + `derive-status.test.ts` updated for the new
  contract fields.
- Net: **6 new web test files / +259 web test lines**, **2 new API test files +
  3 extended** for the onboarding/activation surface. Every feature in the inventory
  has ≥1 new test referencing it by name; every funnel event has an emit + a test.

## Top 3 conversion risks to address post-launch (not blocking)

1. **Async provisioning can strand the wizard.** Phone provisioning and AI
   verification run on background workers; if a worker is slow/fails, the user sits
   on the phone/ai_check step. Add a visible "still working / retry" affordance and
   alert on worker failure rate. The funnel will now *show* this drop (step viewed,
   not completed) — wire a dashboard alert on `wizard_step_phone` view→complete gap.
2. **Activation depends on a *second* inbound call.** With the count-based rule, a
   tenant who makes the test call but never receives a real customer call won't
   activate. Consider a nudge ("forward your business line") and the identity-based
   upgrade (deferred) so the genuine first real call always counts.
3. **Trial→paid relies on a single Stripe transition.** The `trialing→active`
   handler is already idempotent and signature-verified, but a documented non-atomic
   edge (`webhooks/routes.ts:~1298`) can over-count `trial_started`/`trial_to_paid`
   metrics on concurrent transitions. Reconcile funnel counts against Stripe
   periodically rather than trusting event counts alone.

## Recommendation: in-app vs hosted Stripe checkout

**Use the hosted Stripe Checkout (already implemented) — do not build in-app card
collection.** What the code shows: `BillingService.createTrialCheckoutSession`
mints a **Stripe-hosted Checkout Session** and `BillingStep` redirects to it; it's
already hardened with per-tenant advisory-lock serialization, a `pending_checkout_at`
+ session-id gate (closes the lock-release-vs-webhook race), explicit cancel cleanup
that expires the Stripe session, and a signature-verified, idempotent
`customer.subscription.*` webhook that mirrors status. Reasons to keep hosted:

- **PCI scope stays with Stripe** — no card fields in our DOM, no SAQ-A-EP burden.
- The reliability problems are already solved server-side (idempotency, race gates);
  an in-app Payment-Element flow would re-introduce client-side failure modes
  (3DS handling, ret[ry] state) for no conversion gain at this volume.
- The only UX cost is one redirect; the post-return `?billing=ok|cancel` handling is
  already implemented in `OnboardingShell`.

Revisit an embedded Payment Element only if redirect drop-off shows up materially in
the funnel (watch `billing` step view→complete) — the instrumentation added here
makes that measurable.
