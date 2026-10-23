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
| 8 | `wizard_completed` | `OnboardingShell.tsx` (alongside existing `onboarding_completed`); v3: `v3/AfterApproval.tsx` (same pair) | client | `isComplete` is seen to flip from false to true during the visit (a visit that opens on a finished setup does not fire it); in v3 that is the call being heard or "I'll test later" | `voice_agent_live` |
| 9 | `test_call_initiated` | `web/.../onboarding/v2/steps/TestCallStep.tsx`; v3: `v3/TestCallTurn.tsx` | client | user taps the number / copies it (call intent) | — |
| 10 | `test_call_succeeded` | `TestCallStep.tsx`; v3: `v3/AfterApproval.tsx` | client | test_call step flips to `done` (inbound detected) | — |
| 11 | `first_real_call_received` **[ACTIVATION]** | `api/.../voice/activation.ts` (called from `app.ts onSessionEnded`) | server | first real inbound call after go-live (idempotent once/tenant) | `inbound_call_count` |
| 12 | `trial_to_paid` **[CONVERSION]** | `api/.../webhooks/routes.ts` (Stripe `customer.subscription.updated`, trialing→active) | server | trial converts to a paid subscription | `priorStatus` |

### Pricing events (software + metered AI minutes — `docs/plans/per-call-pricing.md`)

| Event | Where it fires | Client/Server | Trigger | Extra props |
|---|---|---|---|---|
| `plan_selected` | `api/.../routes/onboarding.ts` (`POST /billing/checkout-session`) | server | owner picks Starter/Growth and a checkout session is minted | `plan` |
| `trial_minutes_milestone` | `api/.../voice/check-upgrade-nudge.ts` (call end) | server | trial reaches 40 billable AI minutes — the upgrade nudge fires (once/tenant) | `trial_minutes_used` |
| `overage_threshold` | `api/.../billing/usage-alerts.ts` (call end) | server | paid period first reaches 80% / 100% of included minutes or the overage cap (once/threshold/period) | `threshold`, `plan`, `used_minutes` |
| `minute_overage_invoiced` | `api/.../billing/call-usage-billing.ts` (Stripe `invoice.created`) | server | settlement creates an AI-minute overage invoice item | `plan`, `overage_minutes`, `charge_cents` |

### v3 (pick, don't build)

The single-surface conversation shell (`web/.../onboarding/v3/ConversationShell.tsx`),
behind the `onboarding_v3` flag. It sits alongside, not instead of, the v2 events
above until v2 retires. All are client events through `trackFunnel`, so they carry the
four required fields; `tenant_id` comes from the onboarding status (or the draft).

| Event | Where it fires | Trigger | Extra props |
|---|---|---|---|
| `v3_ready_viewed` | `ConversationShell.tsx` | the owner first sees the finished shop ("<Business> is already set up"); once per mount | `trade`, `metro` |
| `v3_metro_changed` | `ConversationShell.tsx` | "Not Cleveland?" on Ready: the owner picked another city and the server re-priced the shop for it (a refused change, because a choice was staged or the draft moved on in another window, does not fire) | `from`, `to` (metro codes), `shows_city` (bool: false when the new city has no prices of its own and the shop uses the national ones) |
| `v3_turn_viewed` | `ConversationShell.tsx` | one of the seven choice turns first appears; once per choice per mount, so reopening a turn from the read-back does not fire it again | `choice_key` |
| `v3_choice_made` | `ConversationShell.tsx` | an answer was saved to the draft (the stage call succeeded; a failed or conflicted save does not fire). Fires again when the owner changes an answer from the read-back | `choice_key`, `answer_mode` (`tap` \| `type` \| `voice`: a card tapped then Next, the owner's own words typed, or a card picked by saying "first", "second" or words from its label), `option` (`a` \| `b` \| `override`), `is_most_shops` (bool) |
| `v3_keep_rest` | `ConversationShell.tsx` | the owner taps "Keep the rest as is" in a turn's header and skips to the read-back with the typical answers | `answered_count` (0-7) |
| `v3_readback_viewed` | `ConversationShell.tsx` | the owner first sees the read-back list; once per mount | `trade`, `metro` |
| `v3_readback_edit` | `ConversationShell.tsx` | the owner taps a read-back row to change that choice | `choice_key` |
| `v3_approved` | `ConversationShell.tsx` | "That's right" succeeded and this call saved the draft (a repeat tap on an already-saved draft does not fire) | `proposal_count` (2), `trade` |
| `v3_undo` | `ConversationShell.tsx` (raised by `AfterApproval.tsx`) | "Undo" in the saving window took back the whole approval and the read-back is back, answers kept (a refused or failed undo does not fire) | `proposal_count` (2) |
| `v3_retry` | `ConversationShell.tsx` (raised by `AfterApproval.tsx`) | "Try again" on "Something didn't save." re-queued the changes that failed (a refused or failed retry does not fire) | `retried_count` (1-2), `undoable` (bool: true when the whole set was retried and a fresh undo window opened) |
| `v3_reset` | `ConversationShell.tsx` (raised by `AfterApproval.tsx`) | "Start over" returned an approval that could no longer finish as one to the read-back, answers kept (a refused or failed start over does not fire) | none |
| `v3_trial_viewed` | `AfterApproval.tsx` | the trial turn ("start your free trial") first appears, after the saved choices have gone live; once per mount | none |
| `v3_trial_started` | `AfterApproval.tsx` (raised by `TrialTurn.tsx`) | the owner taps "Start my free trial", before the payment page is requested, so an attempt that then failed still counts. The server's `plan_selected` counts the checkouts that were actually created | `plan` (`starter` \| `growth`) |
| `v3_number_viewed` | `AfterApproval.tsx` | the number turn first appears (getting it, asking for it, or showing it); once per mount | none |
| `v3_number_ready` | `AfterApproval.tsx` | the owner's number is known while they are on the number turn; once per mount. A visit that picks up later in the flow never saw the wait and does not fire it | none |
| `v3_test_call_viewed` | `AfterApproval.tsx` | the test-call turn ("Now you call me.") first appears; the voice getting ready before it is not counted; once per mount | none |
| `v3_first_heard` | `hooks/useRivetVoice.ts` (mounted by `ConversationShell.tsx`) | the first of Rivet's lines is heard after the owner taps "Make it mine" or "Looks right as is": the server clip's `playing` event, or the browser voice starting when the clip fell back. Once per mount; a line heard before that tap (the Ready opener) is not counted | `ms_since_make_it_mine` (integer ms from the tap, >= 0; time to first heard), `source` (`server` \| `speech_synthesis`), `gesture` (`make_it_mine` \| `keep_as_is`) |
| `v3_tts_fallback` | `hooks/useRivetVoice.ts` | a line could not be spoken in the tenant's voice and Rivet fell back: the voice route answered 429, 501 or 502, the request failed, the clip would not play, or the browser refused to play it. Once per turn per mount; the rest of that turn stays on the fallback | `reason` (`rate_limited` \| `not_configured` \| `tts_failed` \| `network` \| `playback` \| `autoplay`), `mode` (`speech_synthesis` \| `silent`: the browser voice, or no voice at all and the heading on screen), `turn` (the choice key, or `ready` \| `readback` \| `trial` \| `number`) |
| `v3_voice_input` | `hooks/useRivetVoice.ts` (mounted by `ConversationShell.tsx`) | Rivet cannot listen this pass, or listens without the option-label boost. `denied`: the owner refused the microphone at "Make it mine" (or a mic tap); `unsupported`: the browser has no microphone recording or socket; `unavailable`: the server has no live transcription (`POST /api/voice/stream-token` answered 503) or the microphone could not be opened; `keyterms_off`: the first socket of the pass was refused with the two labels and "first"/"second" boosted, so it reopened without them and stays so for the pass. Each state once per mount. After `denied`, `unsupported` or `unavailable` every turn is answered by tap or typing, with no mic and no banner, and `v3_choice_made.answer_mode` reads `tap` or `type`. The transcript is never sent | `state` (`denied` \| `unsupported` \| `unavailable` \| `keyterms_off`) |

`choice_key` is one of the seven core setting keys (`greeting`, `trip_fee_and_rate`,
`booking_posture`, `payment_collection_mode`, `booking_hours`, `emergency_target`,
`after_hours_mode`). These events carry IDs, enums, counts and booleans only: never the
words the owner typed for a greeting, and never a price or a dollar amount.

Drop-off reads as `v3_ready_viewed` with no `v3_turn_viewed`, a `v3_turn_viewed` for a
choice with no `v3_choice_made` (the owner stalled on that turn), `v3_keep_rest` (how far
they got before skipping, from `answered_count`), or `v3_readback_viewed` with no
`v3_approved`. `v3_readback_edit` per tenant is the quality signal for the typical shop:
how often the finished answer needed changing. `answer_mode` splits taps, typing and spoken answers.

After the read-back the same frame carries the trial, the number and the test call, so
the funnel continues without a gap: `v3_approved` -> `v3_trial_viewed` -> `v3_trial_started`
(the checkout itself is the server's `plan_selected`; the trial going live is the Stripe
webhook) -> `v3_number_viewed` -> `v3_number_ready` -> `v3_test_call_viewed` ->
`test_call_initiated` -> `test_call_succeeded` -> `wizard_completed` (a skipped call reaches `wizard_completed` without `test_call_succeeded`). The two test-call events keep the meaning
they have in the sidebar shell (the intent to call is a tap on the number or the copy
button, once per visit; the success is the step being seen to flip to `done`, never replayed
by a visit that finds it already done), so the series stays comparable across both shells.
`v3_number_viewed` to `v3_number_ready` is how long the owner waited for a number;
`v3_trial_viewed` with no `v3_trial_started` is a trial the owner did not want to start.
Between `v3_approved` and `v3_trial_viewed` the owner may tap Undo in the five-second saving
window (`v3_undo`, then a second `v3_approved` when they confirm again), or see "Something didn't
save." (a saved change failed; Try again re-queues it, `v3_retry`), "Part of your setup was taken
back." (Start over returns to the read-back, `v3_reset`) or "Part of your setup already went
through." (finished in Settings). The screens are not events: a `v3_approved` that never reaches
`v3_trial_viewed` with no `v3_undo`/`v3_reset` after it is the drop-off to read them from, and the
step-by-step way out shows up in the sidebar shell's `onboarding_step_viewed` series.

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
real stack — the framework was deliberately not rewritten to match the launch
spec's assumed stack; the existing Vite/Express/in-code-migration stack was kept
and the spec's features were mapped onto it instead:

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
docs/archive/2026-07-cleanup/root/BLOCKED.md).

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
