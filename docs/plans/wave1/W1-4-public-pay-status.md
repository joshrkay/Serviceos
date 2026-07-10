# W1-4 — Hermetic: public pay page `/pay/:id` status

**Thread ID:** W1-4  
**Parent:** [Wave 1 index](./README.md) · [umbrella plan](../2026-07-10-001-feat-wave1-prove-money-loop-followup-plan.md)  
**Status:** ready to pick up  
**Branch:** `feat/w1-4-public-pay-status`  
**PR title:** `test(e2e): public pay page status poll (W1-4)`  
**Estimate:** 0.5–1 day  
**Parallel with:** W1-3

---

## Goal

Prove the public invoice pay page updates payment status **in place** (via `useInvoiceStatus` polling) without blanking the page — status poll proof only.

## Why this thread exists

Cash collection UX depends on `/pay/:id`. Elements card entry is brittle in CI; the status transition after settlement is the part we can and should prove hermetically.

## In scope

- Load `/pay/:id` with mocked invoice/payment status APIs
- Assert initial unpaid/open (or equivalent) UI
- Trigger/advance poll; assert transition to `paid` without full-page spinner wipe
- Document that Stripe Elements card entry is **out of scope** for this thread

## Out of scope

- Real Stripe Elements / PaymentIntent confirmation UI
- Webhook settlement itself (that’s **W1-2**)
- Partial payments / tips / surcharges
- Wave 2/3

## Approach

1. Read `packages/web/src/hooks/useInvoiceStatus.ts` + pay page component.
2. Add `e2e/public/invoice-pay-status.spec.ts`.
3. Mock status endpoint: first response open, second paid (gate second response to assert mid-poll UI still mounted — same idea as `render-stability`).
4. Prefer visibility/timer patterns that don’t freeze SPA boot (`page.clock.install()` before boot is hazardous).
5. Keep spec always-on (no Clerk secrets).

## Expected files

| Path | Action |
|------|--------|
| `e2e/public/invoice-pay-status.spec.ts` | Create |
| `e2e/README.md` | Document |

## Done when

- [ ] Spec green without Clerk/Stripe secrets
- [ ] Mid-poll: page content stays mounted (no blank flash)
- [ ] Final state shows paid
- [ ] PR description states Elements is out of scope
- [ ] PR links this thread doc

## Handoff prompt (paste into new agent thread)

```text
Implement W1-4 only: docs/plans/wave1/W1-4-public-pay-status.md
Branch: feat/w1-4-public-pay-status from main.
Do not implement other Wave 1 threads.
Hermetic /pay/:id status poll → paid in place; no Stripe Elements.
```
