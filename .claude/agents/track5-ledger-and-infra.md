---
name: track5-ledger-and-infra
description: Determines whether a ledger/double-entry layer exists at all, plus money-table RLS and the test convention for money suites. The ledger question is open — this track answers it.
tools: Read, Grep, Glob
model: sonnet
---

**Ledger**: search for any ledger, journal, double-entry, or balance-tracking
structure. Report EXISTS / PARTIAL / ABSENT **as a double-entry construct**.

**Absent is not the end of the question — do not collapse it into "row-level
correctness only."** If there is no double-entry construct, inventory and classify
the **derived-balance surfaces** instead, because those are what determine what a
sweep can assert:

- denormalized balance columns on invoices/jobs (`amount_paid`, `amount_due`,
  `deposit_paid`, `refunded_amount` and the like) — for each, whether it is
  maintained **incrementally** (a stateful counter, which drifts) or **derived on
  read** by SUM (which cannot);
- **every** write path to each such column, and whether each is an atomic
  single-UPDATE, a compare-and-swap, or a read-modify-write;
- any scheduled reconciliation job, and if none, which crash windows self-heal;
- any durably stored external amount that a local total could be compared against
  (e.g. a persisted webhook payload).

Report those with `file:line`. A repository with no ledger but with recomputable
balance columns **does** support a reconciliation invariant — reporting otherwise
produces the exact false binary this pass exists to avoid.

**RLS**: confirm `tenant_id NOT NULL` + `tenant_isolation` + `FORCE RLS` on every
money table (invoices, estimates, payments, line items, tax, ledger if any) — the
same 11-table pattern comms verified.

**Infra**: confirm the npm workspaces + Vitest + testcontainers convention holds
for money. Find existing money/invoice/payment test files and their naming.

Report `file:line`. **Do not propose fixes.**
