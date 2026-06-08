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

## 3. Phone provisioning — **SHIPPED**
- Already implemented: Twilio subaccount + number purchase worker
  (`workers/provision-twilio.ts`), stored in `tenant_integrations` (RLS-isolated).
- Defect found: `wizard_step_phone` not emitted; provisioning isolation had no
  explicit RLS test on `tenant_integrations.provider_data`.
- Fix: `wizard_step_phone` (= phone step) in `OnboardingShell.tsx`; RLS isolation
  assertions in `rls-tenant-isolation.test.ts` (tenant A cannot read tenant B's
  provider_data secrets). (Vapi = Twilio per mapping.)

## 4. Voice agent configuration — **SHIPPED** (mapped) / partial upstream
- Real model: voice = Twilio + ElevenLabs TTS + `tenant_settings` voice metadata;
  the `ai_check` step is the "voice agent works" gate. No Vapi assistant object.
- Defect found: `wizard_step_voice` not emitted.
- Fix: `wizard_step_voice` (= `ai_check` step) in `OnboardingShell.tsx`. The
  existing `voice_agent_turned_on` event (go-live) is retained.

## 5. Calendar connection — **DEFERRED** (no wizard step)
- Real model: calendar is a per-user Google Calendar OAuth in **settings**
  (`routes/calendar-integrations.ts`), not a wizard step. There is no
  `wizard_step_calendar` analog in the onboarding flow.
- Decision: do **not** invent a calendar wizard step for launch. `wizard_step_calendar`
  is documented as N/A in FUNNEL.md. Estimated effort to add a real calendar
  wizard step + availability seeding: ~1–2 days (UI step + OAuth-in-wizard +
  7-day availability import). See LAUNCH_REPORT.md.

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
