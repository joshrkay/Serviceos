# ADR — Outbound message proposals expire after 48h (story 10.4)

## Status

Accepted — 2026-06-22. Refines the inline decision (formerly in
`packages/api/src/proposals/proposal.ts`) that outbound comms proposals persist
indefinitely.

## Context

The Interaction Model v2 (`interaction-model.md` §10, §18) and PRD story **10.4
"Message cards 48h expiry"** specify that **schedule *and* message proposals
expire at 48h** (re-proposable), while everything else persists.

Story **5.5** had already shipped the schedule half (commit `eff5e724`): only
`SCHEDULE_PROPOSAL_TYPES` (`create_appointment`, `create_booking`,
`reschedule_appointment`) received a 48h `expiresAt` at creation, and the
`proposal-expiry-worker` sweeps any pending proposal whose `expiresAt` has
passed. The message half was deliberately deferred with an in-code note arguing
that outbound comms (e.g. `send_estimate`, `send_invoice`) "intentionally
persist until an operator acts."

That note left a real correctness gap: time-sensitive customer-facing comms go
stale. A `notify_delay` ("running late") card approved two days late is actively
wrong; a `request_feedback` ask is pointless weeks later.

## Decision

**Outbound-message (comms-class) proposals expire 48h after creation** and
become re-proposable — **except** the comms types that an automated, once-only
sweep raises and marks "done" on raise, which stay **persistent**.

- `MESSAGE_PROPOSAL_TYPES` (expire at 48h): `notify_delay`, `request_feedback`,
  `send_invoice`, `send_estimate`, `send_estimate_nudge`. These are
  operator/voice-initiated or self-correcting — if the proposal lapses, the
  action can simply be re-issued, and a stale card is worse than no card.
- `PERSISTENT_COMMS_PROPOSAL_TYPES` (do NOT expire): `send_payment_reminder`,
  `review_response_proposal`. See *Why two types are excluded*.
- `EXPIRING_PROPOSAL_TYPES = SCHEDULE ∪ MESSAGE`; `defaultProposalExpiry` applies
  the shared `PROPOSAL_EXPIRY_MS` (48h) to both. All other types persist.
- A unit-test **drift guard** asserts `MESSAGE_PROPOSAL_TYPES` and
  `PERSISTENT_COMMS_PROPOSAL_TYPES` **partition the `comms` action class exactly**,
  so a new outbound-message type added to `actionClassForProposalType` is forced
  into one bucket or the other and cannot silently skip the expiry decision.
- The expiry worker needs no logic change — it already sweeps anything carrying
  an `expiresAt` in a pending status. The inbox's re-proposable list and the
  `repropose` guard were widened from "schedule" to "expiring".

### Why two comms types are excluded (the regression this avoids)

The initial cut expired **all** comms proposals. A behavioral review found that
two are raised by automated sweeps whose idempotency ledger marks a step "done"
when the proposal is **raised**, not when it is **delivered** — so expiring the
proposal would permanently drop the action, because the sweep never re-raises it:

- **`send_payment_reminder`** — `overdue-invoice-worker.raiseDunningProposals`
  writes the `invoice_dunning_events` ledger row *before* `createProposal`
  ("at most one proposal is ever created per (invoice, kind, step)"). An expired
  reminder leaves the ledger row in place, so `selectDueReminderSteps` filters
  that step out forever and **the overdue customer is never reminded** for it.
- **`review_response_proposal`** — `google-reviews` emits the draft once per
  review, gated on the review row's `inserted` flag with a permanent
  idempotency key (`review-response:<reviewId>`). An expired draft is never
  regenerated, leaving the review **unanswered by the automated path**.

Keeping these two persistent (the pre-10.4 behavior for them) preserves the
collections and reputation guarantees. Making them expire-and-re-raise instead
(gating the ledgers on "delivered") is the more product-correct long-term fix
but is a multi-worker change across invoicing + reputation — deferred.

### Why not narrow further to only "time-sensitive" comms

Considered expiring only `notify_delay` / `request_feedback`. Rejected: a
48h-stale "send this estimate/invoice" card is also a poor prompt, and those
sends are operator-initiated with no automated once-only ledger, so re-issuing
is cheap and nothing is dropped. The dividing line is **not** "time-sensitive"
but **"would an automated once-only upstream permanently lose this?"**

## Consequences

- An unapproved *expiring* message card auto-expires at 48h and surfaces in the
  inbox as re-proposable; no customer is contacted without an explicit, fresh
  approval — the human-approval gate is unchanged (comms never auto-execute).
- Dunning reminders and automated review drafts keep their existing
  raise-once-persist semantics; their proposals do not lapse.
- A previously-dead, unwired competing expiry module (`ai/guardrails/expiration.ts`,
  a 24h-TTL model) was removed as part of this change to leave a single source of
  truth for proposal expiry.

## References

- Story 10.4; `interaction-model.md` §10 (lifecycle), §18 (acceptance).
- Schedule precedent: story 5.5, commit `eff5e724`.
- Excluded-type evidence: `packages/api/src/workers/overdue-invoice-worker.ts`
  (`raiseDunningProposals`), `packages/api/src/workers/google-reviews.ts`.
- Code: `packages/api/src/proposals/proposal.ts`,
  `packages/api/src/workers/proposal-expiry-worker.ts`,
  `packages/api/src/proposals/actions.ts`,
  `packages/api/src/routes/proposals.ts`.
