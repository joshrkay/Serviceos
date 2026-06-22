---
title: "Giving a proposal type a TTL breaks automated sweeps that raise it once and gate on 'raised'"
date: 2026-06-22
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/proposals/proposal.ts, packages/api/src/workers/proposal-expiry-worker.ts, packages/api/src/workers/overdue-invoice-worker.ts, packages/api/src/workers/google-reviews.ts"
tags: ["proposals", "expiry", "ttl", "idempotency", "dunning", "reputation", "lifecycle", "regression", "silent-failure"]
related: ["docs/solutions/architecture-patterns/per-tenant-job-shared-idempotency-key.md", "docs/decisions/2026-06-22-message-proposal-expiry.md"]
---

## Context

Story 10.4 broadened `defaultProposalExpiry` to give outbound *message*
(comms-class) proposals a 48h TTL, matching the schedule-proposal expiry shipped
in 5.5. The expiry worker (`proposal-expiry-worker.ts`) sweeps any **pending**
proposal whose `expiresAt` has passed → `status='expired'` (terminal,
re-proposable).

That looks safe — until you notice some proposal types are created by
**automated sweeps that record "this step is done" the moment the proposal is
*raised*, independent of whether it is ever approved/sent**:

- **Dunning** — `overdue-invoice-worker.raiseDunningProposals` writes the
  `invoice_dunning_events` ledger row *before* `createProposal`, by design
  ("at most one proposal is ever created per (invoice, kind, step)"). The next
  sweep computes due steps from that ledger (`selectDueReminderSteps`).
- **Reputation** — `google-reviews` emits a `review_response_proposal` once per
  review, gated on the review row's `inserted` flag plus a permanent idempotency
  key (`review-response:<reviewId>`).

Give those types a TTL and the regression is **silent**: the card expires
unapproved → the ledger/flag still says "done" → the sweep **never re-raises
it** → the overdue customer is never reminded / the review is never answered.
No error, no failing test — the action just vanishes. It surfaced only because a
behavioral cross-file tracer ran in code review.

## Guidance

**Before giving any proposal type an `expiresAt`/TTL, grep its creators and
check the idempotency model.** If an automated sweep raises it *exactly once*
and gates re-creation on a **"raised"** ledger/flag (rather than "delivered"),
expiry will permanently drop the action. Two safe options:

1. **Keep that type persistent** (no `expiresAt`). Partition the candidate set
   explicitly and pin it with a drift-guard test, so a *new* type can't silently
   inherit the wrong behavior:
   ```ts
   export const MESSAGE_PROPOSAL_TYPES = [/* expire at 48h */];
   export const PERSISTENT_COMMS_PROPOSAL_TYPES = [   // automated once-only → never expire
     'send_payment_reminder', 'review_response_proposal',
   ];
   // test: MESSAGE ∪ PERSISTENT === the comms action-class set, and disjoint
   ```
2. **Make the sweep expiry-aware** — gate its ledger on *delivered* (proposal
   executed), not *raised*, or roll the ledger row back on expiry, so an expired
   proposal is re-raised next cycle. More product-correct, but a per-worker
   change across each affected domain.

**Detection technique (cheap, high recall):** for every proposal type whose
*lifecycle* you change, grep its creators — both `proposalType: '<type>'`
literals and the voice tasks / workers that build it — and ask: *"does an
automated sweep treat 'I created this once' as a permanent done-marker?"* If the
creator is operator/voice-initiated (no automated once-only gate), expiry is
safe; if an automated sweep owns it, it is not.

## Why This Matters

Expiry and "raise-once" are two idempotency models with **opposite**
assumptions:

- **Expiry:** *if you don't act, it lapses and you re-propose.*
- **Raise-once:** *I create this exactly once; its existence IS the permanent
  record that the step is handled.*

Broadening expiry quietly deletes the "it exists" guarantee the sweep relied on.
The failure throws nothing and breaks no test, and it lands on money/reputation
paths (collections, reviews) — exactly the profile that warrants a
forcing-function partition test rather than a comment.

## When to Apply

- Adding or extending proposal `expiresAt` (or any "auto-expire pending X"
  worker) to more proposal/entity types.
- More generally: adding a TTL / auto-expire to any record that **another
  component creates once and treats as a permanent "done" marker** — ledgers,
  `inserted`/`sent` flags, dedupe/idempotency keys.

## Examples

10.4 final partition — comms proposals expire **except** the two automated
once-only types:

```ts
// proposal.ts — expire (operator/voice-initiated, self-correcting)
MESSAGE_PROPOSAL_TYPES = [
  'notify_delay', 'request_feedback', 'send_invoice', 'send_estimate', 'send_estimate_nudge',
];
// persist (automated, raised-once, gated on 'raised')
PERSISTENT_COMMS_PROPOSAL_TYPES = ['send_payment_reminder', 'review_response_proposal'];
```

Safe counter-example: `send_estimate_nudge`'s automated path
(`estimate-reminder-worker`) sends **directly** and records bookkeeping on
*send* (`last_reminder_at`), so its user-initiated *proposal* can expire freely
— nothing gates on the proposal existing.

Full decision + the two excluded types' evidence:
`docs/decisions/2026-06-22-message-proposal-expiry.md`.
