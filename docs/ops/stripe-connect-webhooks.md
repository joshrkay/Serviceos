# Stripe Connect webhooks (ops checklist)

**Audience:** Rivet ops / on-call  
**Related:** `docs/strategy/prd-stripe-trades-payments.md` §13, plan U6  
**Mode:** Configure separately in **Test** and **Live** Dashboards.

## Why this exists

Customer charges may be **Connect direct charges** (`Stripe-Account`). Those objects live on the connected account. If the webhook destination only listens to the **platform** account, `payment_intent.*` / `checkout.session.completed` for tenant charges never reach `POST /webhooks/stripe`, and invoices stay unpaid in Rivet.

## Checklist

1. Open [Workbench → Webhooks](https://dashboard.stripe.com/webhooks) (use `/test/webhooks` in Test mode).
2. Ensure an event destination points at:
   ```
   https://<API_HOST>/webhooks/stripe
   ```
3. Create **two** destinations (or equivalent scope), both hitting the same URL if desired:
   - **Your account** — SaaS subscriptions, platform fallback charges, `account.updated` from the platform perspective as applicable.
   - **Connected accounts** — payment intents, checkout sessions, setup intents, refunds, disputes on Express accounts.
4. Enable at least:
   - `payment_intent.processing`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `setup_intent.succeeded`
   - `charge.refunded`
   - `charge.refund.updated`
   - `charge.dispute.created`
   - `account.updated`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` (per environment).
6. Smoke: pay a Connect-routed test invoice → Dashboard shows the PI on the connected account → Rivet invoice flips to `paid`.

## Notes

- Stripe MCP (Cursor Desktop, Test mode) can help inspect accounts/prices; webhook destination listing may still require the Dashboard.
- Do not rely on `stripe listen` alone for production Connect coverage.
- SaaS Billing Checkout stays on the **platform** account; Connected-accounts destination must not break those events (platform destination still required).
