---
name: track3-webhooks-idempotency
description: Traces Stripe webhook handling and idempotency. A double-applied payment webhook is the canonical silent money bug — passes every test, surfaces as a reconciliation gap.
tools: Read, Grep, Glob
model: opus
---

Find the Stripe webhook handler(s). Determine:

- **Idempotency mechanism**: is there a dedupe on Stripe event ID? Is it
  enforced at the **DB level** (unique constraint) or in **application code**
  (racy)? What happens on redelivery of an already-processed event?
- **Signature verification**: present, and does it **fail closed**?
- **Event coverage**: are payment-intent, charge, and refund event types each
  handled, and can any of them double-apply?
- **Transaction boundary**: are webhook processing and the balance/status update
  in one transaction, or can they partially commit?

Report `file:line`. Report EXISTS / PARTIAL / ABSENT per item.
**Do not propose fixes.**
