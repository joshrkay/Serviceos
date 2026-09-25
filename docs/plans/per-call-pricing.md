# Rivet Per-Call Pricing — Build Spec (v2, grilled)

Status: decisions settled 2026-09-24 · Supersedes the v1 draft ("Kai, for Josh") · Branch `feat/per-call-pricing`

Rivet is priced as the whole ServiceOS platform (CRM, jobs, estimates,
invoices, payments, scheduling, dispatch, mobile, voice AI). Calls are the
one usage meter. Plans differ by included calls and users only — every
feature is in both plans.

## 1. Packaging

| | Starter | Growth |
|---|---|---|
| Monthly | $79 | $199 |
| Users (every login, incl. technicians) | 2 | 5 |
| Included billable calls / period | 50 | 150 |
| Overage | $1.50 / call | $1.25 / call |
| Default overage cap | $79 / period | $199 / period |

- No paid seat add-ons; more than 5 users → "talk to us".
- No rollover of unused calls. Annual plans deferred.
- 14-day trial, card on file (unchanged checkout).
- Setup: self-serve is free. White-glove onboarding is an optional $750,
  waived for the first 10 shops; invoiced manually (no code).
- No platform fee on customer card payments (Stripe Connect stays
  direct-charge, no `application_fee_amount`).
- Brand stays Rivet.

## 2. What counts as a billable call (public, verbatim)

A call is billable when **all** hold:

1. Answered by the Rivet AI (voicemail taken *before* the AI answers never counts).
2. Lasts **30 seconds or more**.
3. The caller is not the business's own owner or business phone number.

Calls the AI answers and then transfers to a person, or where it takes a
message, count. A repeat call from the same number within **10 minutes**
of a counted call is the same call. Rivet does not judge whether a call
was "useful".

v1 has no spam classifier (none exists in the voice stack); the 30-second
rule is the robocall filter. Every call's duration is logged so the
threshold can be tightened later with data.

## 3. Trial

- 25 billable calls total; upgrade nudge due at 15; 2 concurrent calls.
- Over a cap (total or concurrent): forward to the owner's phone and send
  an upgrade prompt — never leave the caller unanswered.
- Trial calls never bill; the counter resets to 0 at conversion.
- The old daily/total minute caps are retired.

## 4. Overage protection and alerts

- Tenant overage cap defaults to one plan price; the owner may raise or
  remove it. Once reached, further calls forward to the owner's phone.
- Alerts at 80% and 100% of included calls, and at the cap: email + in-app
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
| 1 | ✅ `priceCallUsage` (bundle, overage, cap) | `billing/call-usage-pricing.ts` — `d40dd2478` |
| 2 | ✅ `decideTrialCall` (25 cap, nudge 15, concurrency → forward) — unwired | `voice/trial-limits.ts` — `753be39db` |
| 3 | Persist caller E.164 on each voice session (from Twilio `From`); classify at session end (answered-by-AI, ≥30s, not owner/business phone, 10-min same-number merge); write `call_usage_events` unique `(tenant_id, call_id)` | telephony inbound route, `twilio-adapter` `onSessionEnded`, new migration |
| 4 | Call-usage settlement replacing `voice-usage-billing`; wire into the `invoice.created` handler | `billing/call-usage-billing.ts`, `webhooks/routes.ts` |
| 5 | Plans: `BILLING_PLAN_IDS = ['starter','growth']`, `STRIPE_STARTER_PRICE_ID` / `STRIPE_GROWTH_PRICE_ID` at 7_900 / 19_900; persist the plan on `tenants` from checkout/subscription webhooks; enforce 2/5 users at invite (`users/invite-team-member.ts`) | `billing/subscription.ts`, `routes/onboarding.ts`, migration |
| 6 | Wire `decideTrialCall` + overage cap into the voice gate; forward-to-owner TwiML with voicemail fallback | `voice/voice-gate.ts`, `routes/telephony.ts` |
| 7 | `GET /api/billing/call-usage`; settings page shows calls (used / included, overage so far, projected charge); BillingStep plan cards ("$79/mo · 2 users · 50 answered calls · then $1.50/call") | `routes/billing.ts`, `SettingsPage.tsx`, `BillingStep.tsx` |
| 8 | Alerts (80/100/cap) and trial emails ("You've used X of 25 trial calls") | `workers/trial-reminder-sweep.ts`, upgrade-nudge path |
| 9 | Delete per-minute code: `voice-usage-pricing.ts`, `voice-usage-billing.ts`, `/api/billing/voice-usage`, minutes UI, `evaluateTrialCap` minute caps. Keep `ai_voice_usage_costs` recording for margin reporting. Do **not** drop `ai_voice_usage_settlements` (migration runner has no ledger). | |
| 10 | PostHog: `plan_selected`, `trial_call_milestone`, `overage_threshold`, `call_overage_invoiced` | `analytics/posthog.ts` |

`LandingPage.tsx` does not exist; the v1 §3.3 item is dropped. The static
`docs/marketing/landing-page.html` ($299/$499/$799) is stale and not a
source of truth.

## 7. Marketing site (Rivet-Marketing — not blocked; `~/Rivet-Marketing`)

Ship the same day as the app cutover:

- `src/lib/tiers.json` / `pricing.ts`: two tiers at $79 / $199 with users
  and call bundles; retire `basic`/`enterprise` naming.
- Remove the "no per-minute or per-call meter" FAQ and hero copy — it is
  false after cutover (and already false against today's per-minute billing).
- Publish §2 verbatim; FAQ: what counts as a call, what if I go over (cap
  + alerts), contract (none, cancel anytime), what setup includes.
- Update the JSON-LD Offer in step.

## 8. Ops checklist (Josh)

- [ ] Stripe: create Starter $79/mo and Growth $199/mo recurring prices.
- [ ] Railway: set `STRIPE_STARTER_PRICE_ID` / `STRIPE_GROWTH_PRICE_ID`; remove `STRIPE_BASIC_PRICE_ID` / `STRIPE_ENTERPRISE_PRICE_ID`.
- [ ] Stripe Customer Portal: plan names and downgrade-at-period-end.
- [ ] `POSTHOG_API_KEY` in prod for the funnel events.

## 9. Rollout

Clean cutover, no flag (no paying tenants). Staging run: synthetic tenant →
signup → trial calls (incl. an owner-phone test call and a 10-min repeat)
→ conversion → period settlement; evidence is the `call_usage_events` and
settlement rows plus the Stripe invoice item. First 10 shops: watch
classification daily for a week.

## 10. Definition of done

- [ ] Items 3–10 each land test-first (seams agreed before tests).
- [ ] Classification integration-tested against real Postgres: test call excluded, <30s excluded, 10-min repeat merged, double count impossible.
- [ ] Settlement: overage → one invoice item; zero → none; retry → no duplicate.
- [ ] Onboarding and settings show calls and users, not minutes (screenshot evidence).
- [ ] Per-minute code removed.
- [ ] Marketing site matches §1–§2 on the same day.
