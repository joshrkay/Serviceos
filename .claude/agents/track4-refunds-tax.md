---
name: track4-refunds-tax
description: Inventories the refund path and tax computation as they actually exist. Enumeration-heavier than tracing, but refund-over-original and tax rounding are real money defects.
tools: Read, Grep, Glob
model: sonnet
---

**Refund**: find the refund path if one exists.

- Can a refund exceed the original charge?
- Are partial refunds supported?
- Does a refund write back to invoice/payment state, and to any ledger?

**Tax**: find where tax is computed and stored.

- Is it a **stored line item** or **recomputed on read** (drift risk)?
- What **rounding rule** applies, and **at what point**? Per-line vs per-invoice
  rounding changes the total by cents.
- Is the rate **flat-per-jurisdiction**, or does it assume nexus/exemptions the
  code can't actually handle?

Report `file:line` and flag any tax logic that reads as more complete than a
flat rate. Report EXISTS / PARTIAL / ABSENT per item.
**Do not propose fixes.**
