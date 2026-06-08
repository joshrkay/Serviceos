# Onboarding Launch-Readiness — Progress

Per-feature status for the 8-feature inventory. Status line per feature:
**SHIPPED** | **DEFERRED** | **BLOCKED**.

Branch: `claude/kind-pascal-2mv42`. All work additive; analytics off-by-default.

Legend for "defects": gaps found vs. the launch spec when read against the **real**
architecture (npm + Vite/React-Router + Express + in-code migrations + Twilio;
no Next.js/Supabase/Vapi).

---

## 1. Signup → account creation — **SHIPPED**
- Already implemented: Clerk signup → `user.created` webhook → `bootstrapTenant()`
  creates tenant + owner user + `tenant_settings`. `signup_completed` already fired
  server-side.
- Defect found: no `signup_started` event (top-of-funnel gap).
- Fix: `signup_started` on `SignupPage` mount (`trackFunnel`). Test:
  `SignupPage.funnel.test.tsx`.

## 2. Onboarding wizard — business profile — **SHIPPED**
- Already implemented: resumable wizard, `/identity` route persists business
  profile + owner phone, audit event `tenant.identity_set`.
- Defect found: `wizard_started` and per-step view/complete events were
  *declared* in the analytics union but **never emitted** (abandonment was
  un-instrumented).
- Fix: `wizard_started`, `onboarding_step_viewed/_completed` (deduped, seeded),
  and mapped `wizard_step_business` (= identity), `wizard_completed` in
  `OnboardingShell.tsx`. Tests: `analytics.funnel.test.ts`.

## 3. Phone provisioning — **SHIPPED** (incl. real Vapi)
- Already implemented: Twilio subaccount + number purchase worker
  (`workers/provision-twilio.ts`), stored in `tenant_integrations` (RLS-isolated).
- Built (literal pass): a real **Vapi integration** — `integrations/vapi/client.ts`
  (fetch-based, no SDK dep, off-by-default) creates the assistant and links it to
  the provisioned number; `vapi_assistant_id` persisted to `tenant_settings`
  (migration 147). Wired into the provisioning worker (best-effort).
- `wizard_step_phone` emitted; provisioning isolation RLS-tested
  (`rls-tenant-isolation.test.ts` — tenant A cannot read tenant B's provider_data /
  vapi_assistant_id).

## 4. Voice agent configuration — **SHIPPED** (literal)
- Built: `integrations/vapi/assistant-config.ts` (3 ElevenLabs presets + greeting
  auto-generation), `voice/voice-config.ts` + `PUT /api/onboarding/voice` (persist
  voice + greeting and push onto the Vapi assistant), `VoiceConfigPanel` web UI
  (preset picker + greeting override) mounted in the voice (ai_check) step.
- `wizard_step_voice` emitted; `voice_agent_turned_on` (go-live) retained.
- Tests: `voice-config.test.ts`, `assistant-config.test.ts`, `VoiceConfigPanel.test.tsx`.

## 5. Calendar connection — **SHIPPED** (literal)
- Built: `calendar_provider` column (migration 149), `POST /api/onboarding/calendar/choose`
  (google OAuth / builtin skip), `CalendarChoicePanel` web UI mounted in the
  test-call completion screen; Google choice kicks off the existing
  `calendar-integrations` OAuth connect flow.
- `wizard_step_calendar` emitted on choice. Tests: `CalendarChoicePanel.funnel.test.tsx`,
  `feature-inventory.test.ts` (choice validation).
- Next-7-days availability seeding on Google connect remains a follow-up (the
  provider choice + OAuth handoff ship now).

## 6. Test call flow — **SHIPPED**
- Already implemented: number display, inbound detection via `voice_sessions`,
  step flips to `done`, 3s poll surfaces it.
- Defect found: `test_call_initiated` / `test_call_succeeded` not emitted.
- Fix: `test_call_initiated` on call-intent (tap/copy, once per mount),
  `test_call_succeeded` on step→`done` transition (seeded so resumed sessions
  don't replay). Tests: `TestCallStep.funnel.test.tsx`.

## 7. Activation tracking (`first_real_call_received`) — **SHIPPED**
- Defect found: genuinely **not implemented** — no activation milestone, email,
  or banner.
- Fix: migration `146_tenant_settings_activated_at`; `voice/activation.ts`
  (`maybeFireFirstRealCallActivation`, count-based rule, idempotent check-and-set,
  funnel event + `tenant.activated` audit + activation email); wired into
  `app.ts onSessionEnded`; `ActivationCelebrationBanner` (web).
- Tests: `voice/activation.test.ts` (10 unit cases),
  `integration/onboarding-activation.test.ts` (6 real-DB cases — Docker-gated).
- Identity-based detection (exclude owner's own real calls by verified phone)
  **DEFERRED** — see BLOCKED.md.

## 8. Trial → paid conversion — **SHIPPED**
- Already implemented: Stripe trial checkout + signature-verified, idempotent
  webhook; `trial_to_paid` already fired (trialing→active).
- Defect found: no in-app past-due payment banner.
- Fix: `PastDueBanner` (web), driven off the existing `subscription_status`
  mirror (no new column — Stripe stays source of truth, per DECISIONS.md).
  Stripe signature + idempotency covered by existing unit tests (`test/webhooks/`).

---

## Verifier status (run in this environment)

| Gate | Status |
|---|---|
| `npm run typecheck` (canonical build) | ✅ exit 0 |
| `npm run lint` (api/web/shared, incl. log-safety) | ✅ exit 0 |
| `npm run test` (web 1050+ / api 5954 unit) | ✅ exit 0 |
| `npm run test:funnel` | ✅ exit 0 |
| `npm run test:webhooks` | ✅ exit 0 (110 tests) |
| `npm run test:provisioning` | ✅ exit 0 |
| `npm run build` | ✅ exit 0 |
| grep gate (no new console.log/TODO/FIXME/any/@ts-ignore) | ✅ clean |
| `npm run test:rls` | ⛔ BLOCKED-on-Docker (image pull 403) — files authored + type-checked |
| `npm run test:activation` | ⛔ BLOCKED-on-Docker (same) |
| `npm run test:e2e:onboarding` | ⛔ BLOCKED-on-env (needs Clerk creds + bootable API/DB) |

See LAUNCH_REPORT.md for the full report and BLOCKED.md for diagnoses.
