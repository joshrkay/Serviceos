---
title: "Derived (non-persisted) statuses belong in one shared rule, reused by every front-end"
date: 2026-06-24
track: knowledge
problem_type: architecture-patterns
module: packages/shared/src/contracts, packages/web/src/utils, packages/mobile/src/lib
tags: ["cross-package", "shared", "derived-status", "drift", "invoice", "overdue", "dead-code", "monorepo"]
related: ["docs/solutions/architecture-patterns/share-server-taxonomy-subset-parity-test.md", "docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md"]
---

## Context

"Overdue" is not a persisted invoice status — the canonical `InvoiceStatus` enum
has no such value. It's **derived** at presentation time: an `open` /
`partially_paid` invoice past its `dueDate`. Two front-ends had drifted on it:

- **mobile** derived it inline (`invoiceStatusBadge`: past-due → danger).
- **web** had a dead `'overdue' → 'Overdue'` entry in `normalizeInvoiceStatus`
  that the API never triggers (it never sends `overdue`), and web never derived
  it — so web's entire overdue UI (the warning banner, the "Send payment
  reminder" CTA, the destructive badge) was **unreachable code**. An owner on web
  never saw that an invoice was overdue.

The web redesign (a recolor) is what surfaced this: recoloring the `status ===
'Overdue'` branches made it obvious they never executed.

## Guidance

When a UI status/flag is **derived rather than persisted** (overdue, "expiring
soon", "needs attention", "stale"…), put the derivation **rule** in one shared
pure function and have *every* front-end call it. Don't let each platform inline
its own copy.

```ts
// packages/shared/src/contracts/invoice-status.ts — the single rule
const OVERDUE_ELIGIBLE = new Set<string>([InvoiceStatus.OPEN, InvoiceStatus.PARTIALLY_PAID]);
export function isInvoiceOverdue(status: string | undefined, dueDate?: string, now = Date.now()): boolean {
  if (!status || !OVERDUE_ELIGIBLE.has(status) || !dueDate) return false;
  const due = new Date(dueDate).getTime();
  return !Number.isNaN(due) && due < now;
}
```

```ts
// web: derive the UI status from it (there is no overdue API status)
export const deriveInvoiceUiStatus = (apiStatus: string, dueDate?: string, now = Date.now()) =>
  isInvoiceOverdue(apiStatus, dueDate, now) ? 'Overdue' : normalizeInvoiceStatus(apiStatus);

// mobile: the badge sources its overdue test from the same rule
if (isInvoiceOverdue(status, dueDate, now)) return { label: 'Overdue', tone: 'danger' };
```

Keep `now` injectable for deterministic tests; treat missing/unparseable inputs
as the safe default (not-overdue — never invent a status from bad data).

This is the front-end↔front-end sibling of the API→consumer
`share-server-taxonomy-subset-parity-test.md` pattern: there, a shared *subset*
of a server taxonomy; here, a shared *derivation rule* between peers.

## Why This Matters

Derived values inlined per-platform silently drift, and the worst case isn't a
cosmetic mismatch — it's that **one platform omits the derivation entirely**,
leaving UI that compiles, renders its container, and never fires. Money signals
(overdue → chase payment) are exactly where that silent gap costs the user. One
shared rule makes parity provable, and the *other* platform's existing test
guards the rule (mobile `entityStatus.test` stayed green when web adopted it).

## When to Apply

- Any presentation-time **derived** status/flag consumed by more than one
  front-end (web + mobile), especially when getting it wrong is a correctness or
  money signal.
- When a redesign/recolor/audit makes you touch status-branch code: check that
  every branch is actually *reachable*. A status the API never sends, matched by
  `===`, is a tell that the value must be **derived**, not awaited.

## Examples

`isInvoiceOverdue` (shared) ← `deriveInvoiceUiStatus` (web
`utils/statusNormalize`) + `invoiceStatusBadge` (mobile `lib/entityStatus`).
Cross-package note: after adding the shared helper, rebuild `packages/shared`'s
`dist` or web won't see it — see
`docs/solutions/build-errors/shared-package-dist-stale-after-new-export.md`.
