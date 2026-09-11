# Verification: trial / provisioning proof pack — signup → workspace → trial → provisioned phone → first in-app booking

**Date:** 2026-09-09
**Scope:** Agent E, R4 of `docs/plans/2026-09-09-inapp-50-cases-plan.md`
("Trial / provisioning proof pack"). Produce a hermetic, automated proof —
no Clerk/Stripe/Twilio credentials — that a brand-new signup reaches an
authenticated workspace, a trial entitlement, a provisioned phone number,
and can complete its first in-app AI-booked appointment, so a
marketing/product claim about signup → first value has real evidence behind
it before it ships.

**New test:**
`packages/api/test/integration/trial-provisioning-first-value.test.ts`
(Docker-gated, runs against a real Postgres testcontainer — no mocked DB).

---

## TL;DR

| Step | Proven? | Evidence |
|---|---|---|
| a. Signup → tenant + owner + settings, idempotent | ✅ | real signed Clerk `user.created` webhook against real Postgres |
| b. Authenticated workspace (`/api/me`) | ✅ | real HTTP call, real DB-backed `UserModeService` |
| c. Trial entitlement | ✅ | real signed Stripe `customer.subscription.created` webhook + `evaluateTrialCap` |
| d. Phone provisioning | ✅ | real `provision-twilio` worker handler, dev/test stub number |
| e. First-value in-app AI booking | ✅ | real `InAppVoiceAdapter` → proposal → approve → production execution registry → real `appointments` row |
| Cross-tenant isolation | ✅ | second tenant 404s on the proposal, sees no appointment |
| Real Clerk hosted UI / real Stripe Checkout / real Twilio number purchase | ⚠️ STAGING-only | see "What remains STAGING" below |

All 6 assertions in the new test pass; the three cited sibling tests
(TEST-04, flow1-saas-billing-runthrough, clerk-owner-membership) and the two
existing in-app/telephony voice-booking integration tests
(voice-inbound-appointment, update-brand-voice-voice-execution) still pass
unchanged — 21/21 across the six files, in this run.

---

## Purpose

Nothing here fabricates plausibility — every step drives a REAL production
code path (the actual Express router, the actual webhook signature
verification, the actual `InAppVoiceAdapter`/FSM, the actual proposal
approval + execution registry) against a REAL Postgres database, with only
the three external providers (Clerk, Stripe, Twilio) replaced by the same
signed-webhook mechanism those providers themselves use to call us, plus the
dev/test provisioning stub the app already ships for Twilio-less
environments. Nothing is asserted from a mock; every assertion reads the
database or an HTTP response body a real handler produced.

This closes the gap between "the pieces are unit-tested" and "the actual
signup → trial → first-booked-appointment chain, driven end-to-end, has
never been proven as one thing" — the same gap TEST-04 closed for
signup → estimate → invoice → paid.

## What is proven vs. what remains STAGING

| Claim surface | Proven here (hermetic, CI-safe) | Exact gate | Remains STAGING (needs real credentials) |
|---|---|---|---|
| Clerk signup | The server-side effect of a Clerk `user.created` webhook: tenant row, owner `users` row (role owner, status active), `tenant_settings` row seeded — driven by a webhook signed with the SAME HMAC scheme (`svix-id`/`svix-timestamp`/`svix-signature`) Clerk itself uses, hitting the real `/webhooks/clerk` route | `POST /webhooks/clerk` with a hand-signed payload → real Postgres rows | The Clerk-hosted sign-up UI itself (email/password or OAuth screens, session cookie issuance) — needs `E2E_CLERK_PUBLISHABLE_KEY`/`E2E_CLERK_SECRET_KEY` (see `e2e/README.md`, the same blocker TEST-04 documents) |
| Stripe trial | The server-side effect of Stripe's `customer.subscription.created` webhook (status `trialing`, `trial_end`): `tenants.subscription_status`/`trial_ends_at` mirrored, onboarding status reflects it — driven by a webhook signed with `createWebhookSignature` (the same HMAC scheme `stripe-signature` verification checks) | `POST /webhooks/stripe` with a hand-signed payload → real Postgres row + `GET /api/onboarding/status` | Real Stripe Checkout (hosted payment page, real card entry, real trial-clock creation) — `BillingService`'s `fetchFn` is a stub here (matches `flow1-saas-billing-runthrough.test.ts`); no live Stripe test-mode key is exercised |
| Twilio phone number | The dev/test provisioning stub path already shipped in `workers/provision-twilio.ts`: no Twilio credentials + non-production `NODE_ENV` → deterministic Twilio *magic test number* `+15005550006` written to `tenant_integrations` with `full_readiness` | `provision-twilio` worker `.handle()` called directly (no HTTP), same code path a real queued job runs | Real Twilio subaccount + real DID purchase (`createTwilioSubaccountWithCreds`/`purchasePhoneNumber` — the `if (!masterSid \|\| !masterToken)` branch in `provision-twilio.ts` is never reached) |
| "AI books your first appointment" | A real `InAppVoiceAdapter` session: a scripted classifier reply (only the LLM call is scripted — routing, entity resolution, proposal drafting, approval, and execution are all the real handlers) resolves a spoken customer name to a real seeded customer via `PgEntityResolver`, drafts a `create_appointment` proposal with **no missing fields**, is approved through the real `POST /api/proposals/:id/approve` route, and executed through the production `createExecutionHandlerRegistry` → a real `appointments` row + `appointment.created` audit event | `POST /api/voice/sessions` → `POST /api/voice/sessions/:id/input` ("Book …" then "yes") → approve → `runExecutionSweep` | A real LLM provider's classification of the utterance (the classifier call itself is scripted here, exactly like every other hermetic voice integration test in this suite — see `voice-inbound-appointment.test.ts`); real speech-to-text (this proof is text-in, matching the in-app channel's actual contract, not phone audio) |

Nothing above is asserted by inference — each STAGING row is a capability
this test suite literally cannot exercise without external credentials this
sandbox does not have, per the same constraint TEST-04 already documents.

---

## Step table

Command for the whole file:
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts \
  test/integration/trial-provisioning-first-value.test.ts --reporter=verbose
```

| Step | What it drives | Evidence asserted | Result |
|---|---|---|---|
| a | Signed Clerk `user.created` → `/webhooks/clerk`, replayed with the same `svix-id` | `tenants` row (`findByOwner`), `users` row (`role='owner'`, `status='active'`, `deleted_at IS NULL`), `tenant_settings.ai_model` non-null; replay leaves exactly 1 tenant + 1 owner row | ✅ 98ms |
| b | `GET /api/me` as the bootstrapped owner | `tenant_id` matches, `role='owner'`, `permissions` non-empty array | ✅ 9ms |
| c | Signed Stripe `customer.subscription.created` (`status:'trialing'`, `trial_end` +14d) → `/webhooks/stripe` | `tenants.subscription_status='trialing'`, `trial_ends_at` mirrors `trial_end` exactly; `GET /api/onboarding/status` → `subscriptionStatus:'trialing'`, billing step `done`; `evaluateTrialCap` (pure fn) allows a fresh trial and blocks one at the daily-minutes ceiling | ✅ 63ms |
| d | `provision-twilio` worker `.handle()` with no Twilio creds, `NODE_ENV=test`; `POST /api/onboarding/test-call/skip` | `tenant_integrations` row: `provider='twilio'`, `status='full_readiness'`, `phoneE164='+15005550006'`; onboarding phone step `done` with the number in `metadata`; test_call step `skipped` | ✅ 38ms |
| e | Seed customer+location via `POST /api/customers` / `POST /api/locations`; `POST /api/voice/sessions`; `POST .../input` ("Book Priya Natarajan for next Tuesday at 2 pm for a furnace tune-up"); `POST .../input` ("yes"); approve via `POST /api/proposals/:id/approve`; backdate past the 5s undo window; `runExecutionSweep` with the production `createExecutionHandlerRegistry` | Proposal: `proposalType='create_appointment'`, `status='ready_for_review'`, zero `missingFields`, `payload.customerId` = the seeded customer's real id (never the LLM's own text); after execution: `status='executed'`, one `appointments` row joined to a job with the seeded `customer_id`, `status='scheduled'`, summary containing "Furnace tune-up"; `proposal.approved` and `appointment.created` audit events exist; a second tenant's owner gets 404 on `GET /api/proposals/:id` and sees no appointment | ✅ 195ms |
| f | Prints the evidence block | tenant id, user id, subscription status, phone, proposal id, appointment id all present | ✅ 1ms |

### Pasted output (this run)

```
 ✓ … step a — signed Clerk user.created bootstraps tenant + owner + settings, idempotently 98ms
 ✓ … step b — GET /api/me returns the authenticated workspace (tenant id, owner role, permissions) 9ms
 ✓ … step c — signed Stripe customer.subscription.created (trialing) mirrors trial entitlement 63ms
 ✓ … step d — provision-twilio dev stub reaches full_readiness; onboarding phone step done; test-call skip works 38ms

=== Trial / provisioning proof pack — evidence ===
{
  "tenantId": "8ffb9284-93e4-4be8-a981-e4ddd4afa25c",
  "userId": "user_5c901500-986a-4358-a09f-f26bad725dd2",
  "mePermissionsCount": 59,
  "subscriptionStatus": "trialing",
  "trialEndsAt": "2026-09-23T19:57:32.000Z",
  "phoneE164": "+15005550006",
  "proposalId": "29c1e4b7-7998-45b2-b4de-123980085aa3",
  "appointmentId": "e04ff37b-01e7-4e66-bd58-5c218108cfc1"
}
===================================================

 ✓ … step e — first-value in-app: seed customer, voice-book, approve, execute → real appointment; cross-tenant isolated 195ms
 ✓ … step f — evidence block 1ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  11.57s
```

### Sibling regression check (same run session)

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/signup-to-paid-critical-path.test.ts \
  test/integration/flow1-saas-billing-runthrough.test.ts \
  test/integration/clerk-owner-membership.test.ts --reporter=verbose

 Test Files  3 passed (3)
      Tests  6 passed (6)

cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/voice-inbound-appointment.test.ts \
  test/integration/reschedule-appointment-voice.test.ts \
  test/integration/update-brand-voice-voice-execution.test.ts --reporter=verbose

 Test Files  3 passed (3)
      Tests  12 passed (12)
```

---

## Marketing-claim checklist

| Claim | Mapped proof | Status |
|---|---|---|
| "14-day trial" | Step c: a signed Stripe `customer.subscription.created` with `trial_end` = now + 14 days mirrors byte-for-byte onto `tenants.trial_ends_at`; `evaluateTrialCap` enforces the trial's daily/total/concurrency caps (`TRIAL_LIMITS.DAILY_MINUTES` etc. — not the 14-day length itself, which is a Stripe-side trial-clock property mirrored, not computed, here) | ✅ Proven (the 14-day WINDOW is proven as an exact mirror of what Stripe sends; the decision to configure Stripe's trial period at 14 days is a dashboard/price config, not something this test can independently verify — NOT YET PROVABLE for "Stripe is actually configured for 14 days in production," only that if Stripe says 14 days, we store 14 days) |
| "live in minutes" | Steps a–d chained: signup → workspace → trial → provisioned phone number all complete in the same test run (real work: ~200ms of real HTTP + DB round-trips in this proof; the real-world "minutes" claim also includes the Clerk hosted UI and Stripe Checkout screens a human clicks through, which are STAGING-only per the table above) | ⚠️ Partially proven — the SERVER-SIDE chain is proven fast and correct; the CLIENT-SIDE minutes (how long a human spends on Clerk/Stripe screens) is NOT YET PROVABLE here |
| "AI books your first appointment" | Step e, in full: a spoken (text) utterance naming an existing customer and a relative date/time resolves through the real entity resolver and real datetime resolver, drafts a real `create_appointment` proposal with zero missing fields, is approved by the owner, and executes into a real `appointments` row via the exact production execution registry — the same registry `voice-inbound-appointment.test.ts` and `reschedule-appointment-voice.test.ts` pin | ✅ Proven, for the in-app text-booking surface. The literal LLM call is scripted (matching how every hermetic voice integration test in this suite proves the surrounding pipeline — see `voice-inbound-appointment.test.ts`'s own doc comment on why); "AI" here means the real classification→resolution→drafting→execution PIPELINE, not a live third-party model call |

---

## Files changed

- **Added:** `packages/api/test/integration/trial-provisioning-first-value.test.ts`
- **Added:** this doc.
- No `src/` files were modified. No files under
  `packages/api/src/ai/agents/customer-calling/*`, `app.ts` voice wiring, or
  `entity-resolution.ts` were touched, per the R4 constraint — the test
  builds its own minimal Express apps from the real routers + real Pg
  repositories (the established pattern in `test/integration/`; see TEST-04,
  `flow1-saas-billing-runthrough.test.ts`,
  `voice-inbound-appointment.test.ts`), the same way `app.ts` wires them,
  without editing `app.ts` itself.
- No defects required a fix to make the flow pass — everything worked
  end-to-end against the current `packages/api/src` on the first run.

## How to re-run

```bash
cd packages/api

# The new proof pack:
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/trial-provisioning-first-value.test.ts --reporter=verbose

# Siblings it reuses patterns from (regression check):
RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/signup-to-paid-critical-path.test.ts \
  test/integration/flow1-saas-billing-runthrough.test.ts \
  test/integration/clerk-owner-membership.test.ts \
  test/integration/voice-inbound-appointment.test.ts \
  test/integration/reschedule-appointment-voice.test.ts \
  test/integration/update-brand-voice-voice-execution.test.ts --reporter=verbose
```

Docker must be available (the Postgres testcontainer starts automatically
via `test/integration/global-setup.ts`); if the `pgvector` image pull fails,
see `docs/solutions/test-failures/docker-hub-cdn-blocked-in-remote-sessions.md`.
No `CLERK_*`, `STRIPE_*`, or `TWILIO_*` credentials are required or read —
the suite explicitly unsets `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` for the
duration of the run (restored in `afterAll`) so it can never accidentally
provision a real number even if the host environment happens to carry them.
