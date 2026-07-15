# PRD: Stripe payments for in-person trades (remaining work)

**Product:** Rivet / AI Service OS  
**Audience:** In-person trades businesses (HVAC, plumbing, electrical, etc.)  
**Created:** 2026-07-14  
**Status:** draft  
**Companion plan:** `docs/plans/2026-07-14-001-feat-stripe-connect-and-terminal-completion-plan.md`  
**Stripe API version target:** `2026-06-24.dahlia`  
**Related:** `docs/strategy/parity-jobs-invoicing.md` (C3 tap-to-pay / Connect), `docs/strategy/day-in-the-life.md`

---

## 1. Problem

Trades owners collect money in three places: at the kitchen table (deposit), on the job (balance), and remotely (SMS/email pay link). Rivet already has SaaS billing, Connect Express onboarding, invoice Payment Links (partially Connect-routed), Elements pay pages, ACH lifecycle, refunds/disputes, and membership saved-card dues.

**Gaps that break the merchant-of-record promise:**

1. Several customer charge paths still create Stripe objects on the **platform** account instead of the tenant’s Connect account — funds do not land in the contractor’s bank.
2. **In-person / card-present** collection (Terminal / Tap to Pay) is not implemented, so techs cannot collect on-site the way Jobber/ServiceTitan competitors do.
3. Online Elements and portal save-card UIs do not consistently pass Connect account context to Stripe.js (`stripeAccount`), so even a correctly created Connect PaymentIntent can fail client-side confirm.

Without closing these, Connect onboarding is incomplete for a trades product: owners believe “Stripe is set up,” but many payments still settle on Rivet’s platform.

---

## 2. Goals

| ID | Goal | Success signal |
|----|------|----------------|
| G1 | **Correct account** — every end-customer charge for tenant work settles on the tenant Connect account when `charges_enabled` | No new customer PaymentIntent / Payment Link / Terminal charge created on the platform for Connect-active tenants |
| G2 | **Remote pay still works** — `/pay/:token`, hosted links, portal pay | Same UX; Connect-scoped objects + Elements confirm |
| G3 | **Field collect** — tech collects card-present balance or deposit on site | Terminal (reader and/or Tap to Pay) → paid invoice / deposit credit via existing webhooks |
| G4 | **Cash/check coexistence** | Manual `recordPayment` unchanged |
| G5 | **SaaS remains platform-only** | Tenant subscription Checkout / Portal never uses `Stripe-Account` |

---

## 3. Non-goals (this PRD)

- Migrating Connect to Accounts v2 APIs
- Platform application fees / pricing tool monetization of payment volume
- Tips, Venmo/Zelle, store credit
- Wisetack/financing settlement → `recordPayment` (separate C3 financing track)
- Multi-currency invoices
- Replacing Payment Links with Checkout Sessions everywhere (optional follow-up; Connect routing is the priority)
- Changing the proposal / human-approval gate for money mutations

---

## 4. Personas & jobs-to-be-done

| Persona | Job | Stripe need |
|---------|-----|-------------|
| **Owner (Mike)** | Get paid without chasing; bank deposits match jobs | Connect KYC + all customer charges → their `acct_` |
| **Office / Jenna** | Send invoices, mark cash, dispute refunds | Links + Elements + webhooks + manual path |
| **Technician** | Collect balance before leaving the driveway | Terminal / Tap to Pay on Connect |
| **Homeowner** | Pay deposit remotely or card on site | Pay page, link, or tap |
| **Rivet ops** | Bill the tenant for software | Platform subscription only |

---

## 5. Capability inventory (required Stripe behaviors)

### 5.1 Platform plane (already built — must not regress)

| Cap | Behavior |
|-----|----------|
| P-SUB | Trial Checkout Session + Customer Portal for Rivet SaaS |
| P-WH | Platform webhooks for `customer.subscription.*`, `checkout.session.*` (SaaS) |

### 5.2 Connect plane — account routing (partially built)

| Cap | Behavior | Status |
|-----|----------|--------|
| C-ONB | Express Connect onboarding + Account Links + status cache | Built |
| C-ACC | `account.updated` → `charges_enabled` / `payouts_enabled` | Built |
| C-PL-INV | Public invoice Payment Link with `Stripe-Account` when active | Built |
| C-PM | Portal SetupIntent + saved PM `stripe_account_id` | Built |
| C-DUES | Off-session dues on Connect | Built |
| **C-PI-INV** | Public `/pay` PaymentIntent + Elements on Connect | **Gap** |
| **C-PL-OP** | Operator `POST /invoices/:id/payment-link` on Connect | **Gap** |
| **C-DEP** | Estimate deposit Payment Link / checkout on Connect | **Gap** |
| **C-JS** | Stripe.js `loadStripe(pk, { stripeAccount })` when PI is Connect-scoped | **Gap** |
| **C-WH** | Connect webhook endpoint (or Dashboard “listen to events on Connected accounts”) so connected-account payment events reach `/webhooks/stripe` | **Ops gap** |

### 5.3 Field / in-person (not built)

| Cap | Behavior | Status |
|-----|----------|--------|
| **T-LOC** | Terminal Location(s) per Connect account (or platform model if destination — we use **direct charges**, so Locations on Connect) | **Gap** |
| **T-TOK** | Connection token API (`POST /v1/terminal/connection_tokens`) with `Stripe-Account` | **Gap** |
| **T-PI** | PaymentIntent with `payment_method_types: ['card_present']` (Terminal exception to dynamic-PM rule) + Connect header | **Gap** |
| **T-COLLECT** | Mobile/field UI: collect → process → capture; settle via existing `payment_intent.*` / checkout webhooks | **Gap** |
| **T-FALLBACK** | If Connect not active or Terminal unavailable → deep-link to `/pay` or record cash/check | **Required** |

### 5.4 Adjacent (out of Stripe charge creation but must keep working)

| Cap | Behavior |
|-----|----------|
| M-CASH | Manual cash/check/other via `POST /api/payments` / voice `record_payment` |
| M-ACH | Async ACH on Connect-routed PIs |
| M-REF / M-DSP | Refunds + disputes reverse ledger |
| M-DEP-CREDIT | Deposit credit onto final invoice |

---

## 6. User stories (remaining)

### Epic A — Correct-account completion

1. **As an owner with Connect active**, when a customer pays on `/pay/:token`, the charge appears on **my** Stripe account and pays out to **my** bank.
2. **As an owner**, when I copy an operator payment link from the invoices UI, that link charges **my** Connect account.
3. **As a customer**, when I pay an estimate deposit, funds go to the contractor’s Connect account (same as invoice links).
4. **As Rivet**, SaaS subscription charges never use a tenant `Stripe-Account` header.

### Epic B — In-person collection

5. **As a tech**, after finishing a job I can tap “Collect payment,” enter/confirm the amount due, and take a card present (Tap to Pay or reader) without handing the customer my phone browser login.
6. **As a tech**, if Terminal fails or Connect isn’t ready, I can still open the SMS pay link or record cash/check.
7. **As an owner**, Terminal charges show up as ordinary payments on the invoice (same money loop / digest).

### Epic C — Ops & observability

8. **As Rivet ops**, Connect and platform webhooks are configured so payment + `account.updated` events are verified and idempotent.
9. **As engineering**, a matrix test proves each charge path includes `Stripe-Account` iff tenant Connect `charges_enabled`.

---

## 7. Functional requirements

| ID | Requirement |
|----|-------------|
| R1 | Shared Connect resolution: reuse `ConnectAccountResolver` (`accountId` + `chargesEnabled`); if not enabled, keep **documented** legacy platform fallback until Connect is active. |
| R2 | `createPaymentIntent` accepts optional `stripeAccountId` and sets `Stripe-Account` when present. Online PIs keep `automatic_payment_methods[enabled]=true` and **omit** `payment_method_types`. |
| R3 | `POST /api/public-payments/create-payment-intent` resolves Connect for the invoice’s tenant and returns `{ clientSecret, paymentIntentId, stripeAccountId | null }` so the client can init Stripe.js correctly. |
| R4 | `InvoicePaymentPage` and portal Elements init with `loadStripe(publishableKey, stripeAccountId ? { stripeAccount: stripeAccountId } : undefined)`. |
| R5 | Operator invoice payment-link minting uses the same Connect header pattern as `PublicInvoiceService.getOrCreateCheckoutUrl`. |
| R6 | Estimate deposit link minting uses the same Connect header pattern; deactivate stale links with the same account scope. |
| R7 | Terminal: connection token + card-present PaymentIntent created on the Connect account (direct charges). Amount is always server-derived from invoice/deposit due cents (integer cents). |
| R8 | Terminal settlement reuses existing webhook → `recordPayment` / deposit-credit paths (`metadata.invoice_id` / `deposit_for_job_id` + `tenant_id`). |
| R9 | No auto-execution of AI money proposals; Terminal collect is an explicit human action (tech or owner). |
| R10 | Audit events on Terminal collect attempts and Connect routing decisions (tenant_id, invoice/job id, account id or `platform_fallback`). |

---

## 8. Non-functional requirements

| ID | Requirement |
|----|-------------|
| N1 | Idempotent PI / link / Terminal intent creation (idempotency keys include account scope: `pi_{invoiceId}_{amount}_{acct|platform}`). |
| N2 | Integer cents only; no float money math. |
| N3 | Tenant isolation: never resolve another tenant’s Connect account from a view token / job id mismatch. |
| N4 | Build verification: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` before merge. |
| N5 | Unit tests for pure Connect header helpers; handler tests with mocked Stripe fetch; Docker-gated integration tests for DB columns touched. |
| N6 | Mobile tap targets ≥44px for Collect Payment controls; no horizontal overflow at 320px. |

---

## 9. Stripe best-practice constraints (binding)

From Stripe best practices skill (API **2026-06-24.dahlia**):

1. Prefer restricted API keys (`rk_`) in ops docs; never commit secrets.
2. **Never** set `payment_method_types` on online Checkout / PaymentIntent / Payment Link flows — exception: Terminal requires `payment_method_types: ['card_present']`.
3. Connect customer charges: continue **direct charges** via `Stripe-Account` (matches existing Express + Payment Link design). Do not silently switch to destination charges in this PRD.
4. Subscriptions for SaaS stay on Billing + Checkout Sessions on the **platform**.
5. Dashboard: enable listening to events on **Connected accounts** for the existing webhook endpoint (or add a dedicated Connect endpoint with the same handler + secret rotation story).

---

## 10. Rollout phases

| Phase | Scope | Exit criteria |
|-------|--------|---------------|
| **Phase 1** | Epic A — Connect routing on PI, operator links, deposits + Elements `stripeAccount` | Matrix: all three paths send `Stripe-Account` when Connect active; Elements confirms in test mode |
| **Phase 2** | Epic C — webhook/ops checklist + monitoring notes | Staging webhook receives connected-account `payment_intent.succeeded` |
| **Phase 3** | Epic B — Terminal connection token + card-present PI + mobile collect MVP | One happy-path Terminal payment in test mode credits invoice |
| **Phase 4** | Hardening — offline messaging, reader location UX, E2E | Field runbook + e2e stub coverage |

---

## 11. Metrics

- `% of customer charges` with `event.account` (Connect) vs platform for Connect-active tenants → target **≥99%** after Phase 1
- Time-to-cash for completed jobs (median) — expect improvement after Phase 3
- Terminal collect success rate / fallback rate
- Connect onboarding completion (`charges_enabled`) among active tenants

---

## 12. Risks

| Risk | Mitigation |
|------|------------|
| Existing platform-scoped Payment Links / PIs for Connect tenants | Mint new objects with Connect; deactivate stale platform links when reminting; document one-time migration note |
| Stripe.js confirm fails without `stripeAccount` | R3/R4 return and pass account id |
| Tap to Pay + Connect SDK limitations on some platforms | Prefer server-created PI + ConnectionToken on Connect; document supported devices; fallback to pay link |
| Double-charge if both Terminal and link live | Idempotent payment recording by `provider_reference`; disable link after paid; Terminal amount = outstanding only |
| Webhook misses Connect events | Ops checklist (Phase 2); alert on unpaid invoices with succeeded PI metadata |

---

## 13. Stripe MCP / Dashboard verification checklist

> Cloud agents cannot interactively authenticate the Stripe MCP. Owners should authenticate **Stripe MCP in Cursor desktop** (or use Stripe Dashboard / CLI) and verify:

- [ ] Platform webhook endpoint `POST /webhooks/stripe` exists (test + live as appropriate)
- [ ] Endpoint is set to receive events from **Connected accounts** (or separate Connect endpoint wired to same handler)
- [ ] Events enabled: `payment_intent.*`, `checkout.session.*`, `charge.refunded`, `charge.dispute.created`, `account.updated`, `setup_intent.succeeded`, `customer.subscription.*`
- [ ] Connect Express application has `card_payments` (+ Terminal capabilities when Phase 3 ships)
- [ ] Restricted key permissions cover PaymentIntents, Payment Links, Terminal, Connect read
- [ ] Test-mode end-to-end: Connect account charge appears under connected account in Dashboard

---

## 14. Acceptance (PRD-level)

This PRD is satisfied when:

1. For a tenant with Connect `charges_enabled`, paying an invoice via `/pay`, operator payment link, and deposit checkout all create Stripe objects on that tenant’s `acct_…`.
2. SaaS billing remains on the platform account.
3. A tech can complete at least one card-present collect against an open invoice in Stripe test mode, resulting in `invoice.status = paid` (or `partially_paid`) through the existing webhook ledger.
4. Cash/check recording remains available.
5. The companion implementation plan’s units are implemented or explicitly deferred with rationale.
