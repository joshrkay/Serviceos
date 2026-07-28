---
title: "Which actions get a manual button vs. stay AI/voice-only (the proposal-mint boundary)"
date: 2026-07-20
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/routes/proposals.ts, packages/api/src/proposals/proposal.ts, packages/mobile/app"
tags: ["proposals", "mobile", "action-class", "rbac", "voice", "ui-affordance", "authorization"]
related:
  - "docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md"
  - "docs/solutions/architecture-patterns/share-server-taxonomy-subset-parity-test.md"
---

## Context

When adding a UI affordance (a button/form) for a business action on
mobile or web, the recurring question is: *does the client call a direct
route, mint a proposal, or is there no client path at all?* Getting this
wrong wastes a build cycle two ways — a button that 400s at runtime, or a
new un-gated server route that quietly crosses an authorization boundary.

This came up in **five** mobile units in one build (invoice issue/late-fee/
reminder, estimate nudge, lead convert/note, expense logging, feedback
request). The decision rule is stable and worth internalizing before
writing the affordance.

## Guidance

Every write action falls into one of three buckets. Determine which
**before** building the UI:

**1. Direct human-initiated route exists → build the button.**
Grep `packages/api/src/routes/<domain>.ts` for the verb. These are
audited, permission-gated, and meant for a person clicking. Examples that
shipped as buttons: `POST /api/invoices/:id/issue`, `.../send`,
`POST /api/appointments`, `PUT /api/appointments/:id` (cancel/confirm),
`POST /api/leads/:id/convert|lose`, `POST /api/locations`, `POST /api/notes`,
`POST /api/appointments/:id/running-late`. Wrap money/comms/irreversible
ones in the client lane-confirm (see the action-class rule below).

**2. Proposal type is on the mint whitelist → mint + route to Approvals.**
`POST /api/proposals` (`packages/api/src/routes/proposals.ts:~105`)
accepts **only four** types — `reschedule_appointment`,
`reassign_appointment`, `add_crew_member`, `remove_crew_member` — and
returns `400 UNSUPPORTED_PROPOSAL_TYPE` for anything else. Its own comment:
*"AI-originated proposal types are created via the LLM gateway, not this
HTTP path."* For these four, the client mints and the item lands in the
approvals inbox.

**3. Neither → the action is AI/voice-only by design. Do NOT add a route
to force a button.** Membership here is defined by "**no direct route AND
not on the mint whitelist**" — it is *not* an action-class property. Most
of these are comms/money types (`apply_late_fee`, `send_payment_reminder`,
`request_feedback`, `review_response_proposal`, …), but a **capture-class**
type lands here too: `log_expense` is `capture` in
`actionClassForProposalType`, yet has no direct route and isn't
whitelisted, so it is just as voice-only as the rest. They are *meant* to
originate only from voice/AI or a background worker (dunning sweep,
review-request sweep, recurring agreement worker) — each carrying a
human-approval gate. The right affordance is a **voice hint** ("say it —
it'll land in Approvals"), not a synthesized button. (Do not assume the
inverse either: being capture-class does **not** make a type client-mintable
— the whitelist is the only gate for `POST /api/proposals`.)

The confirming signal for bucket 3: there is usually **no RBAC permission**
for the direct action either (e.g. no `expenses:*` permission — every
expense is written through an approved `log_expense` proposal). Adding the
first client-reachable, un-gated write route would introduce a new
authorization surface the rest of the system deliberately doesn't have.
That is not "a thin helper route" — it's an architecture change, and it
belongs in its own reviewed unit, not smuggled into a UI task.

**Companion rule — the action-class lane** (`actionClassForProposalType`,
`packages/api/src/proposals/proposal.ts`; mirrored client-side via the
shared `proposal-action-class` contract): `capture` is one-tap/batch-safe;
`comms`/`money`/`irreversible` always require an explicit on-screen
confirm. Apply the same confirm treatment to **direct** comms/money routes
(bucket 1), not just proposals — a "Send invoice" button should confirm
just like a `send_invoice` proposal would. The batch-approve endpoint now
enforces capture-only server-side, so the client filter is a mirror, not
the only guard.

## Why This Matters

- **Saves a build cycle.** A 5-minute grep of the domain route file + the
  whitelist tells you button vs. mint vs. voice-hint before you write a
  line of UI. Skipping it means shipping a button that 400s.
- **Protects the human-approval invariant (D-004).** The reason money/
  comms actions lack manual mint paths is that they must be reviewed
  against fresh data at approval time. A button that mints-and-executes, or
  a new un-gated route, erodes that gate.
- **Keeps deferrals honest.** "No button here — say it by voice" is a real,
  working path (the voice-quality corpus already exercises these), not a
  stopgap. Shipping a voice hint is correct product behavior for a
  voice-first app, not a compromise.

## When to Apply

Any time you add a UI action for a domain write on mobile or web — before
writing the affordance. Also when reviewing a PR that adds a new
`POST /api/proposals` type or a new "manual" write route: confirm it isn't
punching a hole in bucket 3's deliberate authz boundary.

## Examples

Decision table from the build that produced this doc:

| Action | Bucket | Affordance shipped |
|---|---|---|
| Issue invoice | 1 (direct `POST /:id/issue`) | Button + money confirm |
| Send invoice / estimate | 1 (direct `/:id/send`) | Button + comms confirm |
| Estimate nudge | 1 (re-send via `/:id/send`, `sentAt` set-once) | "Nudge customer" + comms confirm |
| Reschedule / crew change | 2 (whitelisted proposal) | Mint → Approvals (slot/tech picker) |
| Cancel / confirm appointment | 1 (direct `PUT status`) | Button (cancel = irreversible confirm) |
| Convert / lose lead, note, location | 1 (direct routes) | Buttons/forms |
| Running late | 1 (`/:id/running-late`) | Duration chips (chips = the comms confirm) |
| **Late fee / payment reminder** | **3** (no route, not whitelisted, no perm) | **Voice hint → Approvals** |
| **Request feedback** | **3** (auto-asked 24h post-completion) | **Voice hint on completed jobs** |
| **Log expense** | **3** (no route, no `expenses:*` perm) | **Voice capture pre-scoped to the job** |

The three bucket-3 rows are where a naive "just add the button" would have
either 400'd or forced an un-gated `POST /api/expenses`. Each was deferred
with an in-code `// <ID> … DEFERRED` note pointing at the follow-up (a
direct audited route + permission + integration test) if a manual button
is ever genuinely wanted.
