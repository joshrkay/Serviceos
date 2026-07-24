---
name: track5-ledger-and-infra
description: Determines whether a ledger/double-entry layer exists at all, plus money-table RLS and the test convention for money suites. The ledger question is open — this track answers it.
tools: Read, Grep, Glob
model: sonnet
---

**Ledger**: search for any ledger, journal, double-entry, or balance-tracking
structure. Report EXISTS / PARTIAL / ABSENT. If **absent**, state plainly that
money state is invoice+payment rows only — which determines whether `/goal money`
can assert a reconciliation invariant or only row-level correctness.

**RLS**: confirm `tenant_id NOT NULL` + `tenant_isolation` + `FORCE RLS` on every
money table (invoices, estimates, payments, line items, tax, ledger if any) — the
same 11-table pattern comms verified.

**Infra**: confirm the npm workspaces + Vitest + testcontainers convention holds
for money. Find existing money/invoice/payment test files and their naming.

Report `file:line`. **Do not propose fixes.**
