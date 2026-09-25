# Rivet Pricing — Software + Metered AI Minutes (v3)

Status: decisions settled 2026-09-24 (v3 replaces the per-call bundles of
v2) · Branch `feat/per-call-pricing`

Rivet is priced as the whole ServiceOS platform (CRM, jobs, estimates,
invoices, payments, scheduling, dispatch, mobile) plus AI phone answering,
metered by the minute. Plans differ by users and included minutes only —
every feature is in both plans.

## 1. Packaging

| | Starter | Growth |
|---|---|---|
| Software (monthly) | $79 | $199 |
| Users (every login, incl. technicians) | 2 | 5 |
| AI answering minutes included / period | 20 (≈5 calls) | 60 (≈15 calls) |
| Extra AI minutes | $1.25 / min | $1.25 / min |
| Default overage cap | $79 / period | $199 / period |

- Flat public rate, same on both plans. At an estimated ~$0.25/min all-in
  provider cost (Twilio + STT + TTS + LLM) that is 5x cost; measured cost
  per call is recorded and reviewed quarterly against the rate.
- No paid seat add-ons; more than 5 users → "talk to us".
- No rollover of unused minutes. Annual plans deferred.
- 14-day trial, card on file (unchanged checkout).
- Setup: self-serve free; white-glove onboarding optional $750, waived for
  the first 10 shops; invoiced manually (no code).
- No platform fee on customer card payments.
- Brand stays Rivet. Pricing page leads with the software; AI answering is
  the metered add-on.

## 2. What counts as AI answering minutes (public, verbatim)

Every second the Rivet AI spends on an inbound call to your business
number counts, including calls it transfers to you or where it takes a
message. Calls from your own owner or business phone (for example, your
setup test call) never count. Seconds are added up for the billing period
and rounded up to the next whole minute once, at the end of the period.

## 3. Trial

- 60 AI minutes total; upgrade nudge due at 40 minutes; 2 concurrent calls.
- Over a cap (total or concurrent): forward to the owner's phone and send
  an upgrade prompt — never leave the caller unanswered.
- Trial minutes never bill; the meter resets to 0 at conversion.

## 4. Overage protection and alerts

- Tenant overage cap defaults to one plan price (≈63 extra minutes on Starter, ≈159 on Growth); the owner may raise or
  remove it. Once reached, further calls forward to the owner's phone.
- Alerts at 80% and 100% of included minutes, and at the cap: email + in-app
  banner (reuse the trial-reminder email and PastDueBanner patterns).
- Owner phone is required before go-live. If missing anyway, forwarding
  falls back to today's voicemail TwiML.

## 5. Billing mechanics

- Period = the Stripe subscription invoice period; settlement fires on the
  existing `invoice.created` webhook (skip `subscription_create`), same as
  the current voice settlement.
- Mid-period plan change: the whole period is priced on the plan in force
  when the invoice is created. Downgrades take effect at period end.
- Settlement row per (tenant, period): `pending → completed | failed`,
  unique per tenant+period, Stripe invoice item with idempotency key; zero
  overage completes without an invoice item.
- Money in integer cents only. Tables: `tenant_id NOT NULL` + ENABLE/FORCE
  RLS + `tenant_isolation_*` policy (pattern: migration 281).

## 6. Code changes (against origin/main facts)

Voice runs on a custom Twilio pipeline (Gather + Media Streams). Vapi is
dormant and is not the integration point.

| # | Change | Where |
|---|---|---|
| 1 | ✅→🔁 `priceCallUsage` built for calls (`d40dd2478`); rework to minutes: included 20/60 min, $1.25/min, round up once per period, cap | `billing/call-usage-pricing.ts` |
| 2 | ✅→🔁 `decideTrialCall` built for calls (`753be39db`); rework to 60 trial minutes, nudge at 40, concurrency → forward — unwired | `voice/trial-limits.ts` |
| 3 | ✅→🔁 Ledger `call_usage_events` + caller E.164 on the session-ended hook + hook fix (`d3b55f27f`, `3fc0eb751`, `c1e3fd9fe`); rework: billable seconds = full AI-answered duration (drop the 30s floor and 10-min merge), keep own-number/in-app exclusions; sum seconds per period | `billing/call-usage-events.ts`, `twilio-adapter`, migration 282 |
| 4 | ✅→🔁 Settlement on `invoice.created` (`d08f2eac3`); rework: settle billable seconds → minutes | `billing/call-usage-billing.ts`, `webhooks/routes.ts`, migration 283 |
| 5 | Plans: `BILLING_PLAN_IDS = ['starter','growth']`, `STRIPE_STARTER_PRICE_ID` / `STRIPE_GROWTH_PRICE_ID` at 7_900 / 19_900; persist the plan on `tenants` from checkout/subscription webhooks; enforce 2/5 users at invite (`users/invite-team-member.ts`) | `billing/subscription.ts`, `routes/onboarding.ts`, migration |
| 6 | Wire `decideTrialCall` + overage cap into the voice gate; forward-to-owner TwiML with voicemail fallback | `voice/voice-gate.ts`, `routes/telephony.ts` |
| 7 | `GET /api/billing/call-usage`; settings page shows AI minutes (used / included, overage so far, projected charge); BillingStep plan cards ("$79/mo · 2 users · 20 AI minutes · then $1.25/min") | `routes/billing.ts`, `SettingsPage.tsx`, `BillingStep.tsx` |
| 8 | Alerts (80/100/cap) and trial emails ("You've used X of 60 trial AI minutes") | `workers/trial-reminder-sweep.ts`, upgrade-nudge path |
| 9 | Delete per-minute code: `voice-usage-pricing.ts`, `voice-usage-billing.ts`, `/api/billing/voice-usage`, minutes UI, `evaluateTrialCap` minute caps. Keep `ai_voice_usage_costs` recording for margin reporting. Do **not** drop `ai_voice_usage_settlements` (migration runner has no ledger). | |
| 10 | PostHog: `plan_selected`, `trial_minutes_milestone`, `overage_threshold`, `minute_overage_invoiced` | `analytics/posthog.ts` |

`LandingPage.tsx` does not exist; the v1 §3.3 item is dropped. The static
`docs/marketing/landing-page.html` ($299/$499/$799) is stale and not a
source of truth.

## 7. Marketing site (Rivet-Marketing — not blocked; `~/Rivet-Marketing`)

Ship the same day as the app cutover:

- `src/lib/tiers.json` / `pricing.ts`: two tiers at $79 / $199 with users
  and included AI minutes; retire `basic`/`enterprise` naming.
- Remove the "no per-minute or per-call meter" FAQ and hero copy — it is
  false after cutover.
- Publish §2 verbatim; FAQ: what counts as an AI minute, what if I go over (cap
  + alerts), contract (none, cancel anytime), what setup includes.
- Update the JSON-LD Offer in step.

## 8. Ops checklist (Josh)

- [ ] Stripe: create Starter $79/mo and Growth $199/mo recurring prices.
- [ ] Railway: set `STRIPE_STARTER_PRICE_ID` / `STRIPE_GROWTH_PRICE_ID`; remove `STRIPE_BASIC_PRICE_ID` / `STRIPE_ENTERPRISE_PRICE_ID`.
- [ ] Stripe Customer Portal: plan names and downgrade-at-period-end.
- [ ] `POSTHOG_API_KEY` in prod for the funnel events.

## 9. Rollout

Clean cutover, no flag (no paying tenants). Staging run: synthetic tenant →
signup → trial calls (incl. an owner-phone test call)
→ conversion → period settlement; evidence is the `call_usage_events` and
settlement rows plus the Stripe invoice item. First 10 shops: watch
classification daily for a week.

## 10. Definition of done

- [ ] Items 3–10 each land test-first (seams agreed before tests).
- [ ] Classification integration-tested against real Postgres: test call excluded, in-app excluded, seconds summed and rounded once per period, double count impossible.
- [ ] Settlement: overage → one invoice item; zero → none; retry → no duplicate.
- [ ] Onboarding and settings show AI minutes, users and the $1.25/min rate (screenshot evidence).
- [ ] Per-minute code removed.
- [ ] Marketing site matches §1–§2 on the same day.
