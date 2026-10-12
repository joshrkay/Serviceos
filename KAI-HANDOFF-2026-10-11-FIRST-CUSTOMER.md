# Handoff from Kai — first paying customer lookup (2026-10-11)

Rivet's first paying customer came in today. Before we email them, Josh wants
their usage/onboarding state so the outreach lands right.

## The customer
- Email: kapokapokepo@gmail.com
- Stripe customer: cus_VKyiVsVo00LZWd, name on file "SA SA"
- $79.00 payment received 2026-10-11 ~08:12 MST ("Subscription update" — first
  payment processed on the Rivet Stripe account, acct_1Tsx1z2cPEEui7wB)

## What Josh needs (read-only, prod data)
1. **When did they sign up?** Trial start date if any — is this a fresh
   signup that paid today, or a ~14-day trial (card up front) converting?
2. **Onboarding/setup state** — did they complete the finish-setup flow?
   (ACCOUNT_SETUP_INCOMPLETE vs complete; greeting/services/calendar configured?)
3. **Usage to date** — billable AI minutes used (PgCallUsageRepository /
   tenant billing state). Any calls handled? Upgrade nudge fired?

## Why it matters
- Fresh signup → Josh sends the 20-min done-for-you setup offer.
- Trial converting with real usage → the setup offer lands wrong; instead a
  "you're officially on, how'd the first two weeks go" check-in + tune-up offer.
- Trial converting with zero usage → at-risk; needs the setup call framed as
  rescue, not onboarding.

Please report back: signup date, setup completion (yes/no/partial), billable
minutes used, call count. No action on the tenant — read-only.
