# Lifecycle Mapping — Nurture Engine

Maps each email to a site lifecycle event, its delay, and suppression rules.
Site lifecycle event names (canonical): `trial_started`, `trial_converted`,
`payment_past_due`, `payment_failed`, `canceled`.

The main drip is scheduled off a single `trial_started` timestamp (t0). Each
email fires at t0 + delay unless a suppression condition is met at send time.

## Mapping table

| Email | File | Trigger event | Delay from anchor | Suppression rules |
|-------|------|---------------|-------------------|-------------------|
| Welcome | `emails/01-welcome.md` | `trial_started` | immediate (t0) | None (always fires on trial start). |
| Activation nudge | `emails/02-activation-nudge.md` | `trial_started` | +1d | Suppress if `first_real_call` recorded (activation already reached). Also suppress if `canceled` or `trial_converted` fired. |
| Mid-trial value | `emails/03-mid-trial-value.md` | `trial_started` | +5d | Suppress if `canceled` fired. |
| Honesty | `emails/04-honesty.md` | `trial_started` | +8d | Suppress if `canceled` fired. |
| Trial-ending | `emails/05-trial-ending.md` | `trial_started` | +11d | Suppress if `canceled` or `trial_converted` fired (they already committed or already left). |
| Convert / last day | `emails/06-convert-last-day.md` | `trial_started` | +13d | Suppress if `canceled` or `trial_converted` fired. |
| Win-back | `emails/07-win-back.md` | `canceled` OR trial-expired-unconverted* | +7d from that event | Suppress if `trial_converted` later fired (they came back on their own). Send once, ever. |
| Payment-failed | `emails/08-payment-failed.md` | `payment_failed` | immediate | Suppress if payment succeeds on retry before send. De-dupe: max 1 per failed-payment event; do not re-send on repeated retries within 24h. |

\* trial-expired-unconverted = day-15 reached with no `trial_converted` and no
`canceled`. If the product does not emit a distinct event for this, derive it:
`trial_started + 14d` elapsed AND no `trial_converted` AND no `canceled`. The
`canceled` path and the derived-expiry path both feed the single win-back email;
send whichever fires first, never both.

## Global suppression / hygiene

- **Convert stops the drip.** Once `trial_converted` fires, no further trial-drip
  emails (2–6) send. Converted owners move to lifecycle/product comms, not this
  nurture track.
- **Cancel stops the drip.** Once `canceled` fires, emails 2–6 are suppressed and
  the win-back timer starts.
- **One win-back, ever.** Never loop win-back.
- **`payment_past_due`** does not trigger a nurture email here; it is handled by
  in-product/billing dunning. `payment_failed` is the only billing email in this
  track. (Documented so the two aren't double-sent.)
- **Unsubscribe** honored on all marketing emails (2–6, 7). Transactional emails
  (1 welcome, 8 payment-failed) send regardless of marketing opt-out.

## TEST-CONTACTS-ONLY rule (pre-go-live)

Until go-live, the engine sends ONLY to an allowlist of test addresses,
regardless of transport (per decision D3: Resend-compatible transport, preview
transport renders to an inspectable mailbox). Any recipient not on the allowlist
is dropped and logged — never delivered.

Allowlist (placeholders — replace at go-live):
```
test+rivet@example.com
test+welcome@example.com
test+activation@example.com
test+billing@example.com
josh+test@example.com
```

Go-live step (checklist item, human action only): remove the allowlist gate and
paste the live ESP key. Until then the allowlist is enforced in code, not config,
so a stray real address cannot receive a send.

## Anchor summary

- Emails 1–6 anchor on `trial_started`.
- Email 7 anchors on `canceled` or derived trial-expiry.
- Email 8 anchors on `payment_failed`.
