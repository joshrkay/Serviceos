# W1-2 — Hermetic: invoice → Stripe webhook → paid

**Thread ID:** W1-2  
**Parent:** [Wave 1 index](./README.md) · [umbrella plan](../2026-07-10-001-feat-wave1-prove-money-loop-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w1-2-invoice-webhook-paid`  
**PR title:** `test(e2e): invoice webhook → paid proof (W1-2)`  
**Estimate:** 1–1.5 days  
**Parallel with:** W1-1

---

## Goal

Prove **“did we get the money?”** in CI without driving Stripe Checkout/Elements:

`open invoice → signed Stripe webhook → invoice status paid`

## Why this thread exists

Journey 3 (`e2e/journeys/invoice-to-payment.spec.ts`) is skipped. Webhook handlers and billing engine are well unit-tested; the continuous browser/API proof of settlement is missing.

## In scope

- Skip Stripe-hosted UI / Elements (explicit non-goal for this thread)
- Seed or mock an `open` invoice with known id + amount cents
- POST signed `checkout.session.completed` or `charge.succeeded` using in-repo signing helpers (`packages/api/test/webhooks/` or payments helpers)
- Assert `paid` via API and/or UI (`/invoices/:id` or public `/pay/:id`)
- Prefer: hermetic UI path **plus** one API integration hitting real webhook handler + durable idempotency

## Out of scope

- Live Stripe test-mode network (optional stretch only)
- Stripe Elements card entry (Wave 1.1 / later)
- Refunds, partial payments, Connect onboarding
- Wave 2/3 product work

## Approach

1. Read Journey 3 skeleton + Stripe webhook signing tests.
2. Rewrite/unskip into `e2e/money-loop/invoice-webhook-paid.spec.ts` (or keep journey path).
3. For hermetic UI: mock invoice detail + status; fire webhook against local API **or** fully mock if API not up — document which mode CI uses.
4. Strongest proof: local API + signed webhook + DB/InMemory invoice flips to paid, then UI reload shows Paid.
5. Assert idempotency: second identical webhook does not double-apply.

## Expected files

| Path | Action |
|------|--------|
| `e2e/money-loop/invoice-webhook-paid.spec.ts` | Create |
| `e2e/journeys/invoice-to-payment.spec.ts` | Rewrite/unskip or delegate |
| `packages/api/test/...` webhook signing reuse | Reference |
| Optional API integration sibling | Add if hermetic-only is too weak |

## Done when

- [ ] CI proves webhook → `paid` without live Stripe dashboard
- [ ] Idempotent replay covered (test or assertion)
- [ ] Spec does not require Elements
- [ ] PR links this thread doc

## Handoff prompt (paste into new agent thread)

```text
Implement W1-2 only: docs/plans/wave1/W1-2-invoice-webhook-paid.md
Branch: feat/w1-2-invoice-webhook-paid from main.
Do not implement W1-1/W1-3/W1-4/W1-5 or Wave 2/3.
Prove signed Stripe webhook → invoice paid; skip Elements/Checkout UI.
```
