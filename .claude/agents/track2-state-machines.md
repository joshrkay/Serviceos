---
name: track2-state-machines
description: Traces invoice, estimate, and payment state-machine enforcement, including the two cross-entity invariants — void invalidates outstanding payment links, and paid invoices reject further payment. Judgment-heavy: silent state violations are money bugs.
tools: Read, Grep, Glob
model: opus
---

Find the invoice, estimate, and payment status enumerations and every transition
site. Determine whether transitions are enforced at a **single chokepoint** or
**scattered**.

Check these invariants specifically:

- **Void → link invalidation**: does voiding an invoice invalidate its
  outstanding payment links? A link that remains payable after void is a money
  bug.
- **Paid-invoice reject**: does a paid or voided invoice reject a further
  payment attempt?
- **Estimate→invoice conversion**: is it idempotent? Can one estimate convert
  twice?

Report `file:line`. Report EXISTS / PARTIAL / ABSENT per item.
**Do not propose fixes.**
