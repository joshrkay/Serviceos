---
title: Owner-Operator Operational Workflows — Voice → Approve → Notify
status: workflow design (code-grounded)
persona: owner-operator tradesperson
companion: docs/mobile/owner-operator-app-spec.md, docs/plans/2026-06-19-001-feat-mobile-mvp-owner-operator-plan.md
last_updated: 2026-06-19
---

# Owner-Operator Operational Workflows

> "You learned the trade. We'll run the business." (`docs/decisions.md`, founding sentence)

The mobile app is **not** "a voice feature + an approvals feature + a notifications
feature." It is a set of **operational workflows** — the things a tradesperson actually
does to run the business — and *every one of them* is the same three beats: the owner (or
a customer, or a schedule) **triggers** something, the AI **drafts** it, the owner
**approves** it, and the system **does** it and **tells** the owner. Voice, approval, and
notification are those beats, not separate destinations.

This document works through those workflows end-to-end and grounds each one in the code
that already exists, so the app is built around journeys the owner completes — not screens
they visit.

---

## 1. The workflow spine (every journey runs through this)

Each workflow is an instance of one shared skeleton. Build the spine once; every workflow
is then a thin specialization of it.

```
 TRIGGER ──► CAPTURE ──► UNDERSTAND ──► PROPOSE ──► DECIDE ──► NOTIFY ──► EXECUTE ──► ACCOUNT
  (origin)   (voice)     (AI agent)     (typed)    (approve)   (push)    (determ.)   (audit)
```

| Beat | What happens | Where it lives in the code |
|---|---|---|
| **Trigger** | A job-to-be-done arises (owner speaks, customer calls, SMS reply, digest tap, schedule fires) | multiple origins → §2 |
| **Capture** | Owner-spoken: hold-to-talk → record → upload → transcribe | `routes/voice.ts` `POST /api/voice/recordings`; mirror `components/shared/VoiceBar.tsx` |
| **Understand** | Classify intent, resolve free-text refs to entities, ground prices in the catalog | `ai/orchestration/intent-classifier.ts` (`IntentType`, τ_int=0.75); `ai/resolution/entity-resolver.ts` (τ=0.80); `ai/resolution/catalog-resolver.ts` |
| **Propose** | Mint a typed, Zod-validated proposal carrying confidence + "what I wasn't sure about" markers | `ai/tasks/*` task handlers → `proposals/proposal.ts` (44 `ProposalType`s) |
| **Decide** | Auto-approve (only `capture` class, autonomous, conf ≥ mode threshold) or route to the owner; 5-second undo after approval | `proposals/auto-approve.ts` `decideInitialStatus`; never auto-execute (**D-004**) |
| **Notify** | Tell the owner it needs them / it's done | **net-new push** (M4) + existing SMS one-tap (`proposals/sms/*`) |
| **Execute** | Deterministic side-effect (write a row, send a message, issue an invoice) | `proposals/execution/handlers.ts` + per-type handlers |
| **Account** | Emit an audit event; every mutation is logged | `audit/audit.ts` `createAuditEvent` |

**The product promise lives in the Decide+Notify beats.** "We handle the rest" means the
owner only ever sees a one-tap decision and a confirmation — never a form to fill, never a
screen to hunt through.

---

## 2. One approval surface, many origination channels

A crucial design point: the same proposal/approval/notification spine is fed by **four
different triggers**, and the mobile app is the **single place** the owner reviews and is
notified across all of them. The app is the owner's "decision inbox" for the whole
business.

| Origination channel | How the proposal is born | What the owner does on mobile |
|---|---|---|
| **Owner speaks into the app** (primary) | Hold-to-talk → transcript → task handler → proposal | Reviews/approves the proposal they dictated |
| **AI answers an inbound customer call** | Customer-calling FSM (`ai/agents/customer-calling/state-machine.ts`) drafts a proposal during the call | Gets a push "new booking needs approval", approves it |
| **Owner replies to an SMS** | `proposals/sms/reply-handler.ts` (Y / N / EDIT) | Same proposal, approvable from the app *or* SMS — the app mirrors SMS state |
| **End-of-day digest / schedule** | Digest "invoice it" tap (`digest/*`, RV-065) or recurring agreement worker | Taps into the app to approve the batch |

The mobile app does not re-implement any of these — it **subscribes** to their output
(the proposal inbox `GET /api/proposals/inbox`) and adds the push channel the backend
lacks today.

---

## 3. Approval lanes (the rule that governs every workflow)

What the owner has to do to approve is **not per-screen** — it's determined by the
proposal's **action class** (`actionClassForProposalType`, `proposals/proposal.ts`). This
single rule governs every workflow's Decide beat:

| Lane | Action class | Owner effort | Examples |
|---|---|---|---|
| **Auto / one-tap** | `capture` | Auto-approves if autonomous + confidence ≥ mode threshold (supervisor **0.90** / both **0.92** / tech **0.95**); else one tap | create_customer, create_appointment, draft_estimate, draft_invoice, reschedule, add_note, log_time_entry |
| **Always review** | `comms` | Explicit on-screen confirm — never auto | send_invoice, send_estimate, notify_delay, request_feedback, send_payment_reminder, review_response |
| **Always review (money)** | `money` | Explicit confirm — never auto | issue_invoice, record_payment, apply_late_fee |
| **Always review (irreversible)** | `irreversible` | Explicit confirm — never auto | cancel_appointment, emergency_dispatch |

Hard gates that pull *any* proposal back to review (server-enforced, the client only
mirrors): `missingFields` present → `draft`; `_meta.overallConfidence ∈ {low, very_low}`
→ blocked (RV-007); owner-absent → `ready_for_review` for routing. And every approval
gets the **5-second undo** window (`UNDO_WINDOW_MS`, status `undone`).

---

## 4. The workflow catalog

Format per workflow: **trigger / example utterance → `intent` → `proposal_type` (lane) →
resolve → notify → execute. Screens.** All identifiers are real (see §1 sources).

### A. Money-in — "get paid for the work" (the core loop)

This is the heartbeat of the product. It chains four proposals; the owner taps through
them.

```
 "Just finished the Rodriguez job — 3 hours plus the water heater."
   → draft_invoice (capture)  ── catalog-grounds heater + labor, confidence bar
        approve/one-tap ─► draft invoice created
   → issue_invoice (money)    ── explicit confirm ─► invoice OPEN, due date stamped
   → send_invoice (comms)     ── explicit confirm ─► PDF sent to customer (push: "sent")
   ... later ...
   → record_payment (money)   ── "Rodriguez paid the $1,240" ─► payment recorded, balance closed
```

| # | Workflow | intent → proposal (lane) | Notes / resolve / execute |
|---|---|---|---|
| A1 | **Bill a finished job** | `create_invoice` → `draft_invoice` (capture) | entity(customer) + **catalog(line items)**; uncatalogued lines cap confidence ≤0.85 → review. Execute: INSERT draft invoice |
| A2 | **Issue the invoice** | `issue_invoice` → `issue_invoice` (money) | Always confirm. Execute: status→OPEN, stamp `issued_at`/`due_at`, update job money state |
| A3 | **Send it to the customer** | `send_invoice` → `send_invoice` (comms) | Always confirm. Execute: compose PDF, send SMS/email; **push: "invoice sent to Rodriguez"** |
| A4 | **Record a payment** | `record_payment` → `record_payment` (money) | entity(invoice); missingFields(amount) → draft. Execute: INSERT payment, recompute balance |
| A5 | **Quote a job (estimate)** | `draft_estimate` → `draft_estimate` (capture) | **catalog-grounded**; good/better/best lines. Execute: INSERT draft estimate |
| A6 | **Send the estimate** | `send_estimate` → `send_estimate` (comms) | Always confirm. Execute: send estimate link/PDF |
| A7 | **Nudge an unaccepted estimate** | `send_estimate_nudge` → `send_estimate_nudge` (comms) | Re-send existing link |
| A8 | **Chase an overdue invoice** | `send_payment_reminder` → `send_payment_reminder` (comms) | Compose overdue notice → customer |
| A9 | **Apply a late fee** | `apply_late_fee` → `apply_late_fee` (money) | Execute: synthetic line item + bump `amount_due` |
| A10 | **"Invoice everything I finished"** | `batch_invoice` → `batch_invoice` (capture) → fans out N `draft_invoice` | One utterance → a **chain** of drafts; **batch-approve** on mobile |

**Mobile screens:** Voice Capture → Approvals inbox (chain grouping for A10) → Proposal
review (line-item editor + `resolve-line` picker for catalog ambiguity) → Undo banner →
push on send/execute.

### B. Schedule & dispatch — "keep the day running"

| # | Workflow | intent → proposal (lane) | Notes |
|---|---|---|---|
| B1 | **Book a visit** | `create_appointment` → `create_appointment` (capture) | entity(customer); auto-approves when confident. Execute: INSERT appointment, hold slot, confirmation SMS |
| B2 | **Reschedule** ("move Miller to Thursday 2pm") | `reschedule_appointment` → (capture) | entity(appointment) + parse new time; feasibility check; notify customer of new time |
| B3 | **Cancel** | `cancel_appointment` → (**irreversible**) | Always confirm. Execute: status→CANCELED, release slot |
| B4 | **Confirm with customer** | `confirm_appointment` → (capture) | Execute: status→CONFIRMED |
| B5 | **Reassign / add / drop crew** | `reassign_appointment` / `add_crew_member` / `remove_crew_member` → (capture) | entity(appointment, technician); slot-conflict check |
| B6 | **"Running 30 late"** | `notify_delay` → `notify_delay` (**comms**) | entity(appointment); always confirm. Execute: SMS the customer |
| B7 | **Emergency on a live call** | `emergency_dispatch` (**irreversible**) | Inbound-call FSM global guard (gas/fire/no-heat keywords); speaks 911 script, escalates to on-call, **push the owner** |

**Mobile screens:** Approvals inbox + review (slot picker for B2), push for B6/B7. B7 also
shows on Home as a high-urgency alert.

### C. Customers, leads & the human stuff

| # | Workflow | intent → proposal (lane) | Notes |
|---|---|---|---|
| C1 | **Add a customer** | `create_customer` → (capture) | Often auto-approves; clarification flow fills gaps |
| C2 | **Update a customer** | `update_customer` → (capture) | entity(customer) |
| C3 | **Add a service location** | `add_service_location` → (capture) | entity(customer) |
| C4 | **Convert a lead** | `convert_lead` → (capture) | entity(lead) → backfill customer, relink jobs |
| C5 | **Mark a lead lost** | `mark_lead_lost` → (capture) | records `lostReason` |
| C6 | **Jot a note** | `add_note` → (capture) | entity(target job/customer) |
| C7 | **Log a complaint** ("customer says we overcharged") | `complaint` → **two proposals**: `add_note` (pinned `[COMPLAINT]`) + `callback` (capture) | `complaint-task.ts`; severity → markers; owner gets a callback reminder |
| C8 | **Price pushback / haggle** | `negotiation` → `callback` (± `voice_clarification`) (capture) | `negotiation-task.ts` + guardrail (P2-036); AI never silently concedes — routes to the owner |

**Mobile screens:** Approvals inbox + review; Customers/Leads read screens for context.

### D. Field & costs — "what it cost me"

| # | Workflow | intent → proposal (lane) | Notes |
|---|---|---|---|
| D1 | **Log time on a job** | `log_time_entry` → (capture) | entity(job); entryType job/drive/break/admin |
| D2 | **Log an expense / materials** | `log_expense` → (capture) | entity(job); vendor, category, amount(cents) |
| D3 | **"How did I do on that job?"** | `lookup_job_profit` (read-only) | Instant spoken/onscreen answer; no proposal |

### E. Oversight & answers — "tell me what's going on"

Read-only, voice-first, **no proposal** — instant answers. This is half of "we handle the
rest": the owner asks, the app answers.

| # | Ask | intent (read-only) |
|---|---|---|
| E1 | "What's my balance / who owes me?" | `lookup_balance`, `lookup_invoices` |
| E2 | "What's on tomorrow?" | `lookup_appointments`, `lookup_availability`, `lookup_day_overview` |
| E3 | "What needs my approval?" | `lookup_pending_items` |
| E4 | "How's revenue this week?" | `lookup_revenue` |
| E5 | "Pull up the Henderson account" | `lookup_customer`, `lookup_jobs`, `lookup_estimates`, `lookup_agreements` |
| E6 | "Read me the digest" | `lookup_digest` |

| # | Workflow | Mechanism |
|---|---|---|
| E7 | **End-of-day digest** | `digest/*` builds the snapshot (revenue, pending approvals, unbilled jobs, schedule); a tap "invoice it" mints a `draft_invoice` (RV-065 one-tap, `action:'mint_draft_invoice'`). On mobile this is the **Home/Today + batch-approve** surface |
| E8 | **Post-job feedback / reviews** | `request_feedback` (comms) sends an NPS link; inbound 5-star → `review_response_proposal` (comms) to reply on Google Business |
| E9 | **Recurring maintenance billing** | `agreements/*` + recurring worker mints periodic invoice-schedule proposals; owner approves on cadence |

### F. Cross-cutting control workflows (how approval itself works)

These aren't domain actions — they're the *control* layer the owner uses across every
workflow above.

| # | Workflow | Mechanism | Mobile surface |
|---|---|---|---|
| F1 | **Disambiguate ("which Bob?")** | Entity resolver returns ambiguous → `voice_clarification` proposal with candidate chips; never a silent guess | One-tap chips on the proposal card |
| F2 | **Approve by voice** ("approve the Rodriguez estimate") | `proposal-approval-task.ts`: resolve pending proposal → spoken readback → strict-confirm; money/irreversible can require a spoken challenge | Optional — owner can approve hands-free; result still shows in inbox |
| F3 | **Owner away → routing** | `routeUnsupervisedProposal`: `queue_and_sms` (one-tap link, ≤30min, single-use) / `queue_only` / `escalate_to_oncall` | **Push** (M4) replaces/augments the SMS; deep-links to review |
| F4 | **Edit before approving** | SMS `EDIT` (10-min session, LLM interprets delta) or in-app edit → `PUT /api/proposals/:id` | Inline edit on the review screen |
| F5 | **Undo a mistake** | 5-second window after approve (`UNDO_WINDOW_MS`); `POST /:id/undo` → status `undone`; executor refuses to run inside the window | The Undo banner |
| F6 | **Correct the AI** (reject with reason) | `POST /:id/reject` with reason → feeds correction lessons | Reject action + reason |

---

## 5. Mobile surfaces, mapped to workflows

A small number of screens host every workflow above. The screens are *workflow beats*, not
feature pages.

| Screen | Workflow beat it serves | Used by |
|---|---|---|
| **Voice Capture** | Trigger + Capture | every owner-spoken workflow (A–F) and every read-only ask (E1–E6) |
| **Home / Today** | Trigger (digest) + oversight | E7 digest, E2 day overview, approvals summary |
| **Approvals inbox** | Decide (queue) | every proposal-producing workflow; chain grouping for A10/batch |
| **Proposal review** | Decide (detail) | per-type affordances: line-item editor (A1/A5), `resolve-line` picker (F1 catalog), slot picker (B2), confirm gates (comms/money/irreversible) |
| **Undo banner** | Decide (reverse) | F5 across all approvals |
| **Notifications** | Notify | F3 needs-approval, A3/execute confirmations, B7 emergency |
| **Read screens** (Customers/Jobs/Estimates/Invoices/Schedule) | context for Decide + the E-lane answers | E1–E5 |

---

## 6. Delivering the product as workflow slices (not feature layers)

The implementation plan (`docs/plans/2026-06-19-001-…`) is organized by technical layer
because that's how you *build* safely. But we **validate and ship by workflow** — each
slice is "the owner can do this whole journey, by voice, end-to-end." Because the backend
handlers/execution already exist for every workflow in §4, once the **spine** is real on
mobile, each workflow slice is mostly an acceptance test + the per-type review affordance.

**Slice 0 — The spine (foundation).** Auth, the proposal inbox, the generic review card,
the 5-second undo, and push registration/delivery. (Plan units U1, U2, U4, U5, U6, U7,
U8.) *Acceptance:* a proposal created by any channel can be reviewed, approved, undone, and
push-confirmed on the phone.

**Slice V — Owner voice capture.** Hold-to-talk → recording → transcript → proposal. (Plan
unit U3.) *Acceptance:* the owner speaks an action and it appears in the inbox.

Then the domain slices — each is "spine + voice + the per-type affordance," shippable and
demoable on its own:

| Slice | Workflows | Per-type work added | Acceptance ("by voice, end-to-end") |
|---|---|---|---|
| **S1 Money-in** | A1–A4 | invoice line-item editor + `resolve-line` picker + confirm gates | "Bill the Rodriguez job" → issue → send → record payment, all from the phone |
| **S2 Quoting** | A5–A7, A10 | estimate tiers + batch/chain approve | "Quote the Henderson roof" → send; "invoice everything I finished" → batch approve |
| **S3 Schedule** | B1–B6 | slot picker, conflict surface | "Move Miller to Thursday 2pm" → customer notified |
| **S4 Money-chasing** | A8, A9, E8 | overdue/late-fee confirm, feedback link | "Remind the Smiths they owe me" |
| **S5 Customers & leads** | C1–C8 | clarification chips, complaint/callback, negotiation routing | "New customer Dave at 12 Oak, books Tuesday" |
| **S6 Field & costs** | D1–D3 | time/expense entry review | "Log 2 hours and $80 of fittings on the Lee job" |
| **S7 Oversight** | E1–E7, E9 | read-screens + digest home + batch approve | "What needs my approval?" → approve all |

Control workflows (F1–F6) are built **into the spine** (Slice 0) and exercised by every
slice — they're not a separate feature.

**Sequencing recommendation:** Slice 0 → Slice V → **S1 Money-in** (the promise that pays
for the app: get paid without paperwork) → S3 Schedule → S2 Quoting → then S4–S7 as
demand dictates. The backend already supports all of them, so slice order is a product
decision, not an engineering dependency.

---

## 7. Sources

Intents `ai/orchestration/intent-classifier.ts`; proposal types + action classes
`proposals/proposal.ts`; task handlers `ai/tasks/*` (`task-handlers.ts`,
`voice-extended-tasks.ts`, `full-app-voice-handlers.ts`, `complaint-task.ts`,
`negotiation-task.ts`, `proposal-approval-task.ts`); inbound FSM
`ai/agents/customer-calling/*`; auto-approve + routing `proposals/auto-approve.ts`; SMS
reply `proposals/sms/reply-handler.ts`; execution `proposals/execution/*`; supporting
`digest/*`, `notifications/*`, `agreements/*`, `time-tracking/*`. Approval/undo lifecycle
`proposals/lifecycle.ts`. Companion: `docs/mobile/owner-operator-app-spec.md`.
