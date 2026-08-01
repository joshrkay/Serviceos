# Stripe money-loop go-live gate

**Audience:** Rivet ops / on-call · **Run:** once before onboarding the first
paying tenant in an environment, and again after any Stripe key or webhook
change.
**Related:** `docs/prod-env-checklist.md`, `docs/ops/stripe-connect-webhooks.md`,
`docs/strategy/prd-stripe-trades-payments.md`.

## Why this gate exists

The invoice → payment → payout path is real and wired end-to-end in code, but it
crosses **three** trust boundaries that fail independently and, in two cases,
**silently** — the customer's card is charged but the Rivet invoice never flips
to `paid`, or the money lands in the platform account instead of the tenant's.
Two of the three env vars are already boot-enforced (the process refuses to
start without them); the remaining exposure is **configuration**, not code. This
gate makes that configuration a checklist with an end-to-end smoke, so a
half-configured environment is caught before a real customer pays.

Run every section. Do **not** onboard a paying tenant until Section D passes.

---

## A. Environment variables (mostly self-enforcing)

| Var | Where | How it's verified |
|-----|-------|-------------------|
| `STRIPE_SECRET_KEY` (or legacy `STRIPE_API_KEY`) | API service | **Boot-fail.** `createPaymentLinkProvider` (`packages/api/src/payments/payment-link-provider.ts`) throws in prod/staging when unset — it refuses to fall back to the mock provider that mints synthetic `pay.mock.com` URLs. Pinned by `test/payments/payment-link-provider.test.ts`. |
| `STRIPE_WEBHOOK_SECRET` | API service | **Boot-fail (SEC-43).** `validateProductionConfig` (`packages/api/src/shared/config.ts`) throws in prod/staging when unset. Without it the webhook handler rejects every event → charges succeed but invoices never settle. Pinned by `test/shared/config.test.ts` ("SEC-43"). **Accepts a comma-separated list** of secrets (one per Stripe endpoint) — see Section B; a single value is unchanged. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | **Web build** | Not boot-enforced (it's a Vite build-time var, invisible to the API). The pay page reads it at `packages/web/src/components/customer/InvoicePaymentPage.tsx` and degrades to "Online payment is temporarily unavailable" rather than erroring — so a missing key is a *silent* "customers can't pay". **Manually confirm** it is set on the web service and belongs to the **same Stripe account** as `STRIPE_SECRET_KEY` (both live, or both test). |

**Check:**
- [ ] API service boots clean in the target environment (no config throw in logs).
- [ ] `VITE_STRIPE_PUBLISHABLE_KEY` is set on the web service and matches the API key's mode (live ↔ live, test ↔ test).
- [ ] `WEB_URL` / `APP_PUBLIC_URL` point at the real customer domain (used to build the `/pay/{token}` link).

---

## B. Webhook destinations (the #1 silent failure — Dashboard, not code)

Customer charges are **Connect direct charges** (`Stripe-Account` header), so the
resulting `payment_intent.*` / `checkout.session.completed` events are emitted by
the **connected account**, not the platform. A webhook destination that only
listens to the platform account will never receive them, and the invoice stays
unpaid in Rivet even though the money settled. See
`docs/ops/stripe-connect-webhooks.md` for the full procedure.

Configure **separately in Test and Live** Dashboards. Both destinations point at
the same URL: `https://<API_HOST>/webhooks/stripe`.

- [ ] **"Your account"** destination — SaaS subscriptions, platform-fallback charges, and the platform account's own `account.updated`.
- [ ] **"Connected accounts"** destination — payment intents, checkout sessions, setup intents, refunds, disputes, **and each tenant's `account.updated`** (onboarding completion → `charges_enabled`; delivered with a top-level `account: acct_…`, which is what flips the tenant's cached status).
- [ ] Both enable at minimum: `payment_intent.processing`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `checkout.session.completed`, `checkout.session.expired`, `setup_intent.succeeded`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `account.updated`, `customer.subscription.created|updated|deleted`.
- [ ] **Both destinations' signing secrets** are copied into `STRIPE_WEBHOOK_SECRET` as a **comma-separated list** (`whsec_platform,whsec_connected`). Stripe issues a distinct secret per endpoint, and the handler verifies each request against every secret in the list — so setting only one destination's secret would 401 the other's events (silently breaking either settlement or SaaS billing). A single value still works when you truly have one endpoint.
- [ ] Repeated for **both** Test and Live (each mode has its own two secrets).

> `stripe listen` is **not** sufficient for production Connect coverage — it does
> not stand in for the connected-accounts destination.

---

## C. Per-tenant Connect onboarding (payout routing)

A tenant only receives money into their own bank once their Express account is
`charges_enabled`. Until then, their customers' charges fall back to the
**platform** account (`Stripe-Account` header omitted) with no automatic payout
to the tenant — code paths: `invoices/public-invoice-service.ts`,
`routes/public-payments.ts`, `invoices/invoice-payment-link.ts`. Onboarding is a
Stripe-hosted Account Link; status is mirrored from the `account.updated`
webhook onto `tenants.stripe_connect_charges_enabled` /
`stripe_connect_payouts_enabled` / `stripe_connect_status`.

- [ ] Each go-live tenant has completed onboarding: `GET /api/billing/connect` returns `status: "active"` with `chargesEnabled: true` (start onboarding via `POST /api/billing/connect/onboarding`).
- [ ] You understand the platform-fallback behavior: a non-onboarded tenant's payments land in Rivet's account. Decide deliberately whether to **block** issuing payable links for not-yet-onboarded tenants, or accept the fallback for pilot tenants.
- [ ] (If relevant) Terminal/field collect: the tenant has a Terminal location — `POST /api/terminal/connection-token` returns a location, else finish the Connect **business address** first (`TERMINAL_LOCATION_ADDRESS_REQUIRED`).

---

## D. End-to-end smoke (Test mode — the actual proof)

Do this against an onboarded **test-mode** connected account before trusting Live.

1. Issue and send a test invoice to yourself; open the `/pay/{token}` link.
2. Pay with a Stripe test card (`4242 4242 4242 4242`).
3. In the Stripe Dashboard, confirm the PaymentIntent appears **on the connected account**, not the platform.
4. Confirm the Rivet invoice flips to `paid` (via UI or `GET /public/invoices/:token`) — this proves the connected-accounts webhook destination reaches `/webhooks/stripe` and `recordPayment` ran.
5. Re-deliver the same webhook event from the Dashboard and confirm the payment is **not** double-applied (idempotency — see the CI proof in `packages/api/test/integration/`).

- [ ] Test-mode paid-invoice smoke passes end-to-end, including idempotent replay.
- [ ] Repeat the smoke in **Live** with a real card + small amount before general availability.

---

## Known failure modes (symptom → cause → fix)

| Symptom | Cause | Fix |
|---|---|---|
| API won't boot, log names `STRIPE_WEBHOOK_SECRET` / Stripe key | Boot guard (Section A) — working as intended | Set the missing var. |
| Customer charged, invoice stuck `open` | Connected-accounts webhook destination missing (Section B) | Add the connected-accounts destination for this mode; re-deliver the event. |
| `Stripe webhook signature verification failed` (401) for one endpoint's events only | Only one destination's secret is in `STRIPE_WEBHOOK_SECRET` | Add BOTH secrets, comma-separated (Section B); re-deliver. |
| Pay page shows "temporarily unavailable" | `VITE_STRIPE_PUBLISHABLE_KEY` unset/mismatched, or API returned `503 STRIPE_NOT_CONFIGURED` | Set the web publishable key (matching mode); confirm `STRIPE_SECRET_KEY`. |
| Payment succeeds but lands in the platform account | Tenant not `charges_enabled` (Section C) | Complete Connect onboarding; re-check `GET /api/billing/connect`. |
| `account.updated` never flips `chargesEnabled` | A tenant's onboarding-completion `account.updated` is a **connected-account** event (top-level `account: acct_…`), so it arrives on the **Connected accounts** destination — not the platform "Your account" one | Enable `account.updated` on the **Connected accounts** destination (Section B), then re-deliver the event. |
