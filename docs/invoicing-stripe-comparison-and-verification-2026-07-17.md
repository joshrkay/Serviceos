# Invoicing → Stripe → Payout: Comparison & Verification

**Date:** 2026-07-17 · **Method:** code-verified against `/packages` (code wins
over docs). Companion to `docs/competitive-review-rivet-vs-jobber-2026-07-02.md`
(Jobber-focused), `docs/strategy/prd-stripe-trades-payments.md` (product plan),
`docs/plans/2026-07-14-001-feat-stripe-connect-and-terminal-completion-plan.md`
(Connect completion), and `docs/ops/stripe-connect-webhooks.md` (ops).

**Question answered:** does invoicing connect to Stripe so customers can pay, and
is Stripe set up so tenants receive that money into their own bank accounts —
and how does this compare to Jobber / ServiceTitan?

---

## Bottom line

1. **Customers can pay invoices via Stripe — real, wired end-to-end, no stubs on
   the live path.** Customer opens the tokenized `/pay/{token}` page → server
   mints a real Stripe PaymentIntent (`payments/stripe-payment-intent.ts`) →
   browser confirms via embedded PaymentElement (card data goes browser→Stripe,
   never our server) → a signed Stripe webhook (`payment_intent.succeeded` /
   `checkout.session.completed`) settles the invoice via `invoices/payment.ts`
   `recordPayment` (atomic credit, durable idempotency).
2. **Tenants receive money into their own bank — via Stripe Connect (Express,
   direct charges).** With `charges_enabled=true`, every charge surface routes as
   a **direct charge** onto the tenant's account (`Stripe-Account` header), and
   Stripe auto-pays out to their bank. The platform never holds the funds.
   **Rivet takes $0** — no `application_fee` anywhere (deliberately deferred).
3. **The engineering is complete; the residual risk is configuration.** Two of
   three env vars boot-enforce; the remaining exposure is (a) per-tenant Connect
   onboarding and (b) the Stripe Dashboard webhook destinations — both operator
   steps, now gated by `docs/runbooks/stripe-go-live.md`.

---

## A. How the invoice process works (lifecycle map)

```
draft_invoice proposal (AI / auto-on-completion / batch)  ──human tap──▶  invoice (status=draft)
   OR manual POST /api/invoices   OR   convert accepted estimate
issue_invoice   (money-class, human tap) ─▶ status=open, issuedAt + dueDate set
send_invoice    (comms-class, human tap) ─▶ viewToken (60-day TTL), SMS+email, sentAt stamped
   customer opens /pay/{token}
   ─▶ Stripe PaymentIntent / Payment Link (Connect-routed to tenant) ─▶ webhook
   ─▶ recordPayment() atomic credit ─▶ partially_paid / paid  (chargeback/NSF can reopen → open)
```

- **States** (`invoices/invoice.ts`): `draft → open → partially_paid → paid →
  void/canceled`. No `sent`/`overdue` status — "sent" is a `sentAt` timestamp,
  "overdue" is derived (unpaid + past `due_date`). `paid` is **non-terminal**
  (ACH return / chargeback reverses and reopens).
- **Human-approval invariant** (`proposals/proposal.ts`, D-019): drafting can be
  autonomous, but *issue*, *send*, and *record-payment* are hard-gated to a human
  tap regardless of AI confidence — no system actor may approve a money mutation.
- **Money**: integer cents throughout the shared `billing-engine.ts` (tax in
  bps). Confirmed, no float.
- **Delivery**: multi-channel (SMS + email, consent/DNC-gated); tokenized public
  pay page via a `SECURITY DEFINER` token lookup (the token is the secret).

## B. Stripe verification (both directions)

**Customer-payment side — production-ready, conditional on 3 env vars**
(`STRIPE_SECRET_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`).
Real Stripe calls, custom-HMAC signature verification, durable webhook
idempotency (`webhook_events` unique on source+key), ACH lifecycle, refunds,
reversals — all implemented.

**Tenant-payout side — Connect Express, direct charges.** Onboarding is a
Stripe-hosted Account Link (`POST /api/billing/connect/onboarding`); the account
id + capability flags live on `tenants.stripe_connect_account_id` /
`stripe_connect_charges_enabled` / `stripe_connect_payouts_enabled` /
`stripe_connect_status`, mirrored from the `account.updated` webhook. All five
charge surfaces are Connect-aware: public invoice link, `/pay` PaymentIntent,
operator link, estimate deposit, Terminal.

**The three go-live risks** (now covered by `docs/runbooks/stripe-go-live.md`):

| # | Risk | Consequence | Status |
|---|------|-------------|--------|
| 1 | `STRIPE_WEBHOOK_SECRET` missing while API keys set | customer charged, invoice never settles | **Boot-fail** (SEC-43, `shared/config.ts`; pinned by `config.test.ts`) |
| 2 | Tenant not `charges_enabled` | charge falls back to platform account; no tenant payout | Per-tenant onboarding check in the go-live runbook |
| 3 | "Connected accounts" webhook destination not configured (Dashboard) | money reaches tenant's bank, but Rivet invoice ledger stays stale | Ops step in the go-live runbook + `stripe-connect-webhooks.md` |

## C. Rivet vs. Jobber vs. ServiceTitan (invoicing & payments)

The repo's Jobber comparison is code-verified
(`competitive-review-rivet-vs-jobber-2026-07-02.md`). **ServiceTitan** is not in
the repo's competitive docs and is a different tier (enterprise FSM for larger
contractors, custom high-cost pricing); its column is directional, not
code-verified, and "parity with ServiceTitan" is not the ICP goal — the relevant
bar is Jobber.

| Capability | Rivet (verified) | Jobber (2026) | ServiceTitan (enterprise) |
|---|---|---|---|
| Invoice creation | Auto-on-completion, batch, progress schedules, estimate-conversion, voice/AI — all human-approved | Manual, batch, progress | Deep enterprise workflows |
| Customer pays online | Stripe embedded PaymentElement + hosted links + saved cards | Jobber Payments (Stripe-backed) | ServiceTitan Payments (own processor) |
| Money → contractor's bank | **Connect Express, direct charge → auto payout** | Deposits to bank | Deposits to bank |
| Platform take-rate on volume | **$0** (Stripe's fees only) | Jobber's card/ACH rates | ServiceTitan's payment rates |
| ACH | One-time ✓; recurring/mandated ✗ | ✓ | ✓ |
| Tips at checkout | ✗ (planned pay-page toggle) | ✓ | ✓ |
| Tap-to-Pay / Terminal | Server built; mobile MVP in progress | ✓ | ✓ |
| Financing | Wisetack ✓ | Wisetack built-in | GreenSky/partners |
| Accounting sync | One-way QuickBooks push (D-010) | Two-way QuickBooks | Deep QBO + ERP |
| Price | **Flat $99/mo, all-in** | ~$377–527/mo realistic (AI-forward 1–5 person) | Enterprise, custom, high |

**Read:** on the core invoice→paid loop Rivet is parity+ with Jobber and routes
100% of payment volume to the contractor at a flat price — something neither
Jobber nor ServiceTitan does. The genuine remaining gaps vs Jobber are narrow and
known: **tips at checkout, recurring ACH, two-way QuickBooks.**

## D. Learnings (relevant before touching this path)

1. **Line-item price field differs by document** (`docs/solutions/conventions/
   line-item-price-field-estimate-vs-invoice.md`): estimates use `unitPrice`;
   invoices use `unitPriceCents` + recomputed `totalCents`. TS won't catch a
   mismatch. Include an estimate-shaped fixture; pick the field by contract.
2. **Mocks that mislead** (`docs/solutions/database-issues/mocked-pool-hides-
   real-schema-mismatch.md`, `.../test-failures/mocked-client-shape-masks-
   server-schema-rejection.md`): a mocked Pool once let a worker write a TEXT
   label into a UUID column → no proposal ever executed; a mocked client hid a
   server Zod 400. For money code, **pin real columns (Docker-gated integration
   test) and the real schema** — never in-memory alone.
3. **"Overdue" is derived, not stored** (`docs/solutions/architecture-patterns/
   derive-shared-status-rule-across-frontends.md`): web once shipped an
   unreachable overdue UI. Use the shared pure rule.
4. **Verify an epic isn't already on `main`** (`docs/solutions/workflow-issues/
   verify-roadmap-epic-not-already-on-main.md`): an ACH epic was rebuilt and
   lost. **This applied here** — W1-2 (invoice webhook → paid) was already fully
   built; this pass extended it rather than rebuilding it.
5. **The Connect-routing invariant is the recurring money bug**
   (`prd-stripe-trades-payments`): the "route to Connect?" decision is duplicated
   inline across surfaces; a forgotten one lands funds on the platform. Now
   guarded by `test/payments/connect-routing-audit.test.ts`.

## E. What this pass verified and added (2026-07-17)

Delivered in the recommended order; all changes are tests + docs (no product
source changed).

1. **Go-live gate.** New `docs/runbooks/stripe-go-live.md` (env vars + both
   webhook destinations in Test/Live + per-tenant Connect onboarding + an
   end-to-end paid-invoice smoke). Corrected the stale `docs/prod-env-checklist.md`
   (moved `STRIPE_WEBHOOK_SECRET` from runtime-fail to **boot-fail**, reflecting
   the SEC-43 guard already in code; added rows for the webhook destinations and
   per-tenant Connect onboarding).
2. **Settlement spine (W1-2) — already built; extended.** The existing
   `checkout.session.completed` and `payment_intent.succeeded` proofs cover the
   platform account. Added the missing **Connect-scoped** proof — a
   `payment_intent.succeeded` carrying a top-level `account: acct_…` (as the
   connected-accounts destination delivers) still settles the invoice and is
   idempotent — in both the hermetic (`test/webhooks/stripe-payment-events.test.ts`)
   and Docker-gated (`test/integration/invoice-webhook-paid.test.ts`) tests. This
   pins the "Connect direct charges settle through the existing ledger" premise
   (plan U6).
3. **Connect-routing audit (U9).** New `test/payments/connect-routing-audit.test.ts`
   states the invariant (`Stripe-Account` present iff `charges_enabled`; absent
   for SaaS/platform) and enumerates every charge surface. Filled the gap in the
   operator payment-link surface (`test/invoices/invoice-payment-link.test.ts` had
   no absent-case) and added the SaaS assertion (`test/integration/billing-trial.test.ts`:
   the subscription checkout never sends `Stripe-Account`).

**Verification:** deploy build typecheck (`tsconfig.build.json`) exit 0; project
test typecheck (`tsconfig.lint.json`) 0 errors; all new/changed hermetic and
Docker-gated tests pass.

## F. Recommended next (not in this pass)

- **Tips at checkout** — the highest-value Jobber gap on the pay page (software-only).
- **Recurring/mandated ACH** — saved methods are card-only today (Josh-gated, money).
- **Two-way QuickBooks** — currently one-way push (D-010); the long pole.
- **Consider a shared `shouldRouteToConnect(connect)` helper** so the routing
  decision lives once instead of duplicated inline across five surfaces (the
  audit test now guards the invariant, but a single decision point would remove
  the class of bug entirely).
