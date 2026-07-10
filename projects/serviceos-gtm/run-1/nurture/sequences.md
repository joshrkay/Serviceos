# Rivet ServiceOS — Nurture Sequences

Email-only drip for the 14-day trial lifecycle. Plain-text-first, one CTA per
email, ≤180 words body, subjects ≤45 chars. Every email signed "Josh — founder,
Rivet." All sends are restricted to a test-contact allowlist until go-live (see
`lifecycle-mapping.md`).

Honesty guardrails applied throughout (per `../claims.md`):
- No testimonials, customer names, counts, ratings, or "trusted by" — we're
  pre-launch and have none. The day-8 email leans into that instead of faking it.
- Day-in-the-life (Mike morning) is framed as an illustrative scenario, never a
  real-customer case study.
- Claims limited to shipped capability: AI phone answering, proposal/approval
  gate, supervisor second pass, nightly digest, estimate/invoice drafting,
  card + payment links, unpaid-invoice follow-up. No MMS-to-quote, no ACH,
  no B2B/property-manager routing.
- No fabricated stats. Trial-summary numbers in the last-day email are product
  merge fields ({{calls_answered}} etc.), populated from real account data.

## Trial drip (main sequence — trigger: trial_started)

| # | Email | Delay | Job |
|---|-------|-------|-----|
| 1 | `emails/01-welcome.md` | immediate | You're in. The 4 onboarding steps. One job today: get the number live. |
| 2 | `emails/02-activation-nudge.md` | +1d | Walk the test call. "Call your own number, hear your shop answer." Suppressed if first real call already happened. |
| 3 | `emails/03-mid-trial-value.md` | +5d | Illustrative Mike morning (6 missed calls → one text). Point at digest + approval queue. |
| 4 | `emails/04-honesty.md` | +8d | No testimonials yet — so the trust layer IS the pitch: proposals, supervisor agent, digest that admits mistakes. |
| 5 | `emails/05-trial-ending.md` | +11d | 3 days left. What each plan keeps. How billing works (day 15, cancel before). |
| 6 | `emails/06-convert-last-day.md` | +13d | Final note. Real trial summary via merge fields. Zero-pressure CTA. |

## Off-lifecycle emails

| Email | Trigger | Delay | Job |
|-------|---------|-------|-----|
| `emails/07-win-back.md` | canceled OR trial expired unconverted | +7d | One honest email. What's changed, setup still saved, door stays open. |
| `emails/08-payment-failed.md` | payment_failed | immediate | Dunning. Card didn't clear; fix-payment link; account not paused yet. |

## Subject lines

1. Welcome — "You're in. Let's get your number live"
2. Activation — "Call your own number today"
3. Mid-trial — "What your AI wasn't sure about"
4. Honesty — "How Rivet tells you when it's wrong"
5. Trial-ending — "3 days left on your trial"
6. Convert — "Last day — here's what Rivet did"
7. Win-back — "The door's still open"
8. Payment-failed — "Your payment didn't go through"

## Merge fields used

`{{first_name}}`, `{{onboarding_url}}`, `{{app_url}}`, `{{restart_url}}`,
`{{fix_payment_url}}`, `{{calls_answered}}`, `{{bookings_approved}}`,
`{{estimates_drafted}}`, `{{invoices_sent}}`. Trial-summary fields are
product-data merges — never hardcode, never invent.
