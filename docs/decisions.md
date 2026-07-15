# AI Service OS — Architectural Decision Log

> Living document. Update when decisions are made or revised during implementation. Claude Code should reference this when encountering ambiguity.

## How to Use

When implementing a story and facing an architectural choice not covered by the PRD or CLAUDE.md, check this document first. If the answer isn't here, ask the human reviewer. Once decided, add the decision here with date and rationale.

---

## Locked Decisions (from PRD planning)

### D-001: Single-cloud AWS deployment
**Date:** Pre-Phase 0
**Decision:** AWS single-cloud SaaS with CDK in TypeScript
**Rationale:** Team expertise, ECS/Fargate simplicity, integrated services (RDS, S3, SQS, CloudWatch)
**Alternatives rejected:** Multi-cloud, Vercel+Supabase (original PRD baseline), GCP

### D-002: Clerk for auth, not custom
**Date:** Pre-Phase 0
**Decision:** Clerk for authentication with webhook-based tenant bootstrap
**Rationale:** Reduces auth surface area to zero custom code. Webhook model supports tenant creation on first signup without custom flows.
**Alternatives rejected:** Auth0 (more expensive for SMB), NextAuth (too lightweight), custom JWT

### D-003: Integer cents for all money
**Date:** Pre-Phase 0
**Decision:** All monetary values stored as integer cents (bigint in Postgres, number in TypeScript)
**Rationale:** Eliminates floating-point rounding errors in billing calculations. Standard practice for financial software.
**Constraints:** All API inputs/outputs use cents. Frontend handles display formatting (cents → dollars).

### D-004: Proposal-first AI safety model
**Date:** Pre-Phase 0
**Decision:** AI never writes directly to operational entities. All AI output goes through typed proposals that require human approval before deterministic execution.
**Rationale:** Trust is the product's core differentiator in a market where service businesses don't trust software with their money and schedules.
**Constraints:** No auto-execution in beta, even for high-confidence proposals.

### D-005: Provider-agnostic LLM gateway
**Date:** Phase 2 planning
**Decision:** All LLM calls route through a gateway with OpenAI-compatible internal API. Provider adapters handle the translation. Tiered routing by task complexity.
**Rationale:** Avoids vendor lock-in. Enables cost optimization via tiered models (8B for classification, 30B+ for proposals). Enables failover and shadow comparison.
**Constraints:** No module outside the gateway may import provider SDKs.

### D-006: Shared line-item schema for estimates and invoices
**Date:** Phase 1 planning
**Decision:** One line-item model used by both estimates and invoices, distinguished by parent_type.
**Rationale:** Reduces code duplication, ensures consistency when estimates convert to invoices.
**Constraints:** Line-item changes must be validated by both estimate and invoice business rules.

### D-007: Appointment-level assignment as truth
**Date:** Phase 1 planning
**Decision:** Technician assignment is tracked at the appointment level. Job-level assignment is a convenience derived from the most recent appointment.
**Rationale:** A job may have multiple appointments with different technicians. Appointment-level is the operational truth for dispatch.

### D-008: Vertical packs layered on shared core
**Date:** Phase 4 planning
**Decision:** HVAC and plumbing behavior are implemented as activatable packs on top of a shared platform core.
**Rationale:** Prevents vertical-specific logic from contaminating the core. Enables future verticals (painting, electrical) without re-architecture.

### D-009: Stripe payment links, not embedded checkout
**Date:** Phase 5 planning
**Decision:** Payment links generated only after invoice approval. No embedded checkout or card-on-file in beta.
**Rationale:** Minimizes PCI scope. Payment links are sufficient for invoice-based billing in home services.

### D-010: Manual-trigger QuickBooks sync
**Date:** Phase 7 planning
**Decision:** One-way invoice sync to QuickBooks, manually triggered by owner/dispatcher. No auto-sync in first beta.
**Rationale:** Reduces accounting risk. Service businesses need to verify invoices before they hit QuickBooks.

---

## Founding Sentence

**Locked: 2026-04-14** — from the Service OS Idea Crystallization document.

> **You learned the trade. We'll run the business.**

Every feature ships through this filter. Features that make the operator
work more *in* the business don't ship. Features that let the operator stay
*in the trade* do. This sentence is enforced in
`packages/api/test/decisions/decisions.test.ts` (see D12) so that
deleting it from the repo surface produces a failing test. The 12 founding
decisions from the same document are each encoded as their own acceptance
test in that file.

---

## Implementation Decisions (add during build)

### D-011: PRD v2 reframes the product as an AI back office for owner-operators
**Date:** 2026-05-17
**Decision:** The product is an **AI back office that the owner runs from
SMS**, not a CRM with AI assist. The canonical PRD is now `docs/PRD.md`
(v2.0); the prior phase-based execution document is preserved verbatim at
`docs/PRD-execution-catalog.md` as the source of truth for v1 stories that
v2 does not amend. The product is delivered in four waves rather than eight
phases; v1 phases P6 (dispatch board), P10-001 (customer portal), P10-002
(exec dashboard), P12 (field ops), P13 (multi-location), P14 (inventory),
and P15–P19 (premium tiers) are deferred to post-PMF or cut because they
violate locked decision #14 ("no feature ships that adds admin work to the
owner's day"). Eleven new stories are added to deliver the trust mechanisms
(supervisor agent, confidence markers, end-of-day digest with "what I
wasn't sure about" section, SMS approval transport, brand-voice
configurator, dropped-call recovery, vulnerability triage, correction-loop
UX, Google review monitoring, tech "I'm out" status, negotiation
guardrail) that the day-in-the-life requires.
**Rationale:** The v1 PRD optimized for engineering execution but implicitly
framed the product as a CRM with AI assist. The customer the founding
sentence commits to — the owner-operator who learned the trade — does not
want a CRM; they want their phone to stop ringing and their business side
to run itself. The trust differentiator (the AI tells the truth when it
is wrong) does not exist in any competitor and was absent from v1.
**Story:** Drives PRD v2 §9 stories N-001..N-011 (dispatch IDs P2-034,
P2-035, P2-036, P2-037, P2-038, P4-015, P5-020, P6-028, P7-026, P8-015,
P8-016) — see `docs/stories/wave-2-strategic-stories.md`.
**Alternatives rejected:**
- Keep v1 PRD as-is and layer the strategy on top. Rejected because the
  framing mismatch propagates through every downstream artifact (pitch
  deck, sales script, design system, onboarding).
- Cut v1 entirely and write from scratch. Rejected because the platform
  plumbing (P0, P1, P2 proposal engine, LLM gateway, P4 vertical packs)
  is correct and well-specified — only the surface and sequencing
  change.
**Companion documents:** `docs/strategy/day-in-the-life.md` (personas +
bad-day failure modes + the 14 locked product decisions),
`docs/strategy/roadmap-audit.md` (full mapping of v1 phases to v2 waves
with cut / defer / pull-forward rationale).

### D-012: V2 negotiation discount-policy + catalog-grounded floor engine
**Date:** 2026-06-14
**Decision:** Build a per-tenant discount-policy + catalog-grounded price-floor
engine on top of the shipped V1 negotiation guardrail (P2-036). A pure evaluator
classifies a haggling ask into ALLOW / NEEDS_APPROVAL / CLARIFY /
REJECT_WITH_COUNTER; even ALLOW is confidence-capped to a human tap (never
auto-executed). Policy lives on `tenant_settings` (deposit-rules-style columns)
and defaults **fail-closed** (`maxDiscountBps = 0`) so behavior is identical to
V1 until a tenant opts in.
**Rationale:** P2-036 V1 intentionally "blocks discounts entirely" and deferred
price-floor configuration + negotiation playbooks to V2 (the story's own
non-goals). This decision explicitly **lifts those V1 non-goals** as a separate,
reviewable story so the scope change is on the record. Fail-closed defaults make
the rollout behavior-neutral; the AI-never-concedes invariant holds because ALLOW
only changes whether an in-policy discount may be *proposed* (one tap, over the
existing approval transport), never applied silently.
**Story:** P2-036 V2 —
`docs/plans/2026-06-14-002-feat-negotiation-discount-policy-engine-plan.md`
(depends on the V1 closure, `…-001-…`).
**Alternatives rejected:**
- Keep V1's "always route to owner callback" (no policy). Rejected: tenants who
  want bounded self-service get all-or-nothing.
- Embed discount math in the proposal engine's `decideInitialStatus`. Rejected:
  couples a domain rule to the universal status gate; the evaluator is a pure
  module the handlers call.
- Store policy in the `escalation_settings` JSONB grab-bag or a new table.
  Rejected: JSONB loses the DB-level money CHECK guards; a table is over-built
  for 1:1 cardinality. `tenant_settings` columns mirror the deposit-rules
  precedent.

### D-013: §5 status correction — QuickBooks sync and Correction loop are Built
**Date:** 2026-06-20
**Decision:** Reconcile two §5 parity-map rows in `docs/PRD-v3.md` from 📋 Specced to
✅ Built after verifying both against the canonical `/packages` codebase:
- **QuickBooks sync** → "✅ Built (one-way)". One-way push of paid invoices is wired:
  `app.ts` imports and runs `workers/accounting-sync-worker` under a leader-elected sweep
  (`runAsLeader(SWEEP_LOCK.accountingSync, …)`) with an `accounting_sync_log` repo. Two-way
  reconciliation remains out of scope (hence the "(one-way)" qualifier).
- **Correction loop** → "✅ Built". `learning/corrections/*` (lesson extraction,
  `lesson-applicator`, `record-on-execution`, `apply-undo`) is wired into
  `proposals/actions.ts` and surfaced in `digest-builder.ts` ("what I learned today").
**Rationale:** Both shipped ahead of their roadmap slots (QuickBooks under the F17 / P15-001
work, not the P23 label; the correction loop under N-009 / P2-038), so the §5 status lagged
the code. The 2026-06-14 reconciliation pass missed both. The parity map is the sales/strategy
source of truth — a false "not built" understates the product.
**Story:** Status reconciliation — see `docs/prd-v3-code-status.md` (2026-06-20).
**Alternatives rejected:**
- Leave both as 📋 Specced. Rejected: keeps the canonical comparison wrong.
- Mark QuickBooks plain "✅ Built". Rejected: it is one-way only; the qualifier prevents
  over-claiming two-way reconciliation (still Wave 3+).
**Follow-up:** §6.5, §6.12, and §8 (P23) still call QuickBooks "Wave 3" — refresh for
internal consistency in a later pass.

### D-014: [Template — copy for new decisions]
**Date:** YYYY-MM-DD
**Decision:** [What was decided]
**Rationale:** [Why this choice over alternatives]
**Story:** [Which story triggered this decision]
**Alternatives rejected:** [What else was considered]

### D-015: Autonomous booking lane — scoped exception to the unsupervised auto-approve block
**Date:** 2026-07-02
**Decision:** Per-tenant, default-OFF setting (tenant_settings.autonomous_booking_enabled)
allowing create_appointment/create_booking proposals from the inbound receptionist to
auto-approve while no supervisor is present, when ALL of: confidence >=
autonomous_booking_threshold (default 0.95, floor 0.90 enforced in code), entity resolution
clean (no pending references / missing fields, verified customer), a live held slot within
business hours, and no vulnerability/emergency/negotiation flag on the session. The customer
receives the standard confirmation after the existing 5-second undo window; the owner
receives an immediate SMS with a one-tap signed UNDO that cancels the appointment and sends
a fixed-template apology. Money-, comms-, and irreversible-class proposals are structurally
unaffected (actionClassForProposalType unchanged; proposals/auto-approve.ts unchanged).
**Rationale:** D-004 established proposal-first because trust is the product; Phase 12
hard-blocked unsupervised auto-approval. For a solo owner-operator on a roof, every booking
waiting for a tap is a lost booking — the highest-value calls arrive precisely when no one
is watching the wall. This lane trades a bounded, reversible, capture-class action (a
booking with a compensating cancellation path) for call conversion, under explicit tenant
opt-in and a stricter dedicated threshold. It is an amendment scoped to two proposal types,
not a change to D-004's posture.
**Story:** UB-D (agent wave plan, docs/plans/2026-07-02-001-feat-rivet-jobber-agent-wave-plan.md)
**Alternatives rejected:**
- (a) Global threshold lowering — touches every proposal type.
- (b) A silent grace window before customer confirmation — degrades the core value while
  still requiring the cancellation path.
- (c) Treating supervisorPresent as true when the flag is on — would leak permissiveness
  into all capture types.

**Amendment (2026-07-11):** Added a platform-wide kill switch,
`AUTONOMOUS_BOOKING_DISABLED=true`, checked in `evaluateAutonomousBookingLane`
before the per-tenant opt-in gate (reason `platform_disabled`, distinct from
`tenant_not_opted_in` in the audit trail and the sourceContext stamp) — an
operator-level shutoff for every tenant simultaneously, independent of each
tenant's `autonomous_booking_enabled` setting, for incident response without a
per-tenant settings sweep. Also added digest visibility: the nightly owner
digest now reports "Auto-booked: N appointment(s)" — a count of the day's
proposals whose `sourceContext.autonomousLaneEvaluation.eligible = true` —
mirroring the WS6 supervisorChecks reflection so autonomous activity is never
silent even when nothing goes wrong.

### D-016: Railway supersedes AWS (D-001) — CDK prototype removed
**Date:** 2026-07-11
**Decision:** D-001's single-cloud AWS/CDK deployment was never carried into production.
The actual deploy target is **Railway** (`/railway.toml` + `/Dockerfile`), running the
canonical monorepo under `/packages`. The AWS CDK stacks that implemented D-001
(`experiments/infra/`) were quarantined as non-deployed in an earlier cleanup pass and have
now been **removed entirely**, along with the rest of `/experiments`
(`service-os-app/`, `service-os-agent/`, `supabase_migration.sql`) — none of it was ever
wired into CI or the Railway build, and it had drifted too far from the shipping schema to
be a safe reference. Two CI-run test files that pinned "founding decisions" against the
quarantined Python prototype (`service-os-agent`) were deleted/surgically trimmed in the
same pass: `packages/api/test/contracts/python-agent-contract.test.ts` (fully
experiments-dependent, deleted) and `packages/api/test/decisions/decisions.test.ts`
(D9/A1 trimmed to their non-experiments assertions; A2 deleted — it had no assertions left
once its experiments-dependent tests were removed).
**Rationale:** A decision record should reflect what actually ships. D-001 is superseded
by the Railway deploy target that has been true since before this repo's current history;
keeping a dead AWS prototype and tests that graded a never-deployed Python service against
"founding decisions" gave false signal — CI could stay green on a decision the product
doesn't implement, and a real regression in the Python prototype would never be caught
because nothing runs it.
**Story:** 2026-07 repo-cleanup sweep.
**Alternatives rejected:**
- Keep `/experiments` quarantined indefinitely — rejected: zero live references after the
  prior pass, and its presence kept inviting new "founding decision" tests to be written
  against it (see D9/A1/A2 history) instead of the real product.
- Keep the CDK stack in case AWS is revisited — rejected: nothing in the current
  architecture (Railway/Supabase/Clerk/Twilio) depends on it; reviving AWS deployment would
  start from a fresh CDK design against the current schema, not from a two-generations-old
  prototype.

### D-017: One consent model — revoke-anywhere-suppress-everywhere, grants never cross channels
**Date:** 2026-07-11
**Decision:** Both outbound gates (voice `checkOutboundConsent`, SMS `GatedMessageDelivery`)
now derive their decision through a single shared resolver
(`packages/api/src/compliance/resolve-outbound-consent.ts`) on top of the append-only
`consent_events` ledger (migration 168). The rule is deliberately asymmetric:
- A standing revocation of a CONTACT consent kind (`sms` | `marketing`) — SMS STOP,
  portal/manual opt-out — blocks BOTH voice and SMS, regardless of what
  `customers.consent_status` or `sms_consent` read.
- A GRANT never crosses channels. Each channel keeps its own affirmative signal
  (voice: `consent_status = 'granted'`, written only by the voice capture seam
  `recordCustomerConsent`; SMS: `sms_consent = true`). A ledger grant can only CLEAR a
  prior revocation of the SAME kind (STOP → START), never create consent elsewhere.
- Kind `recording` is NOT a contact kind: a "stop recording" objection keeps blocking
  outbound VOICE (via the existing `consent_status = 'revoked'` rollup) but does NOT
  suppress SMS — a caller who objected to being recorded still gets appointment texts.
To enforce the grant asymmetry, `deriveConsentStatus` was deliberately tightened
(partially reversing Story 10.6's rollup): ledger grants no longer roll
`consent_status = 'granted'`, so an SMS START can no longer manufacture TCPA consent for
autodialed voice calls. Manual `sms_consent` toggles (dashboard PUT /api/customers/:id)
now also append a `consent_events` row (kind `sms`, source `manual`), making the ledger
the source of truth for consent changes going forward. No migration: the ledger already
carries kind/state/phone/tenant — cross-channel derivation is computed, not stored.
**Rationale:** Voice read `customers.consent_status`, SMS read `sms_consent` — two
unrelated fields with no cross-enforcement, so a customer who revoked by phone could
still be texted. TCPA voice-call consent and SMS consent are formally distinct, so the
unification must be conservative in exactly one direction: honoring a revocation
everywhere is always safe; propagating a grant across channels would fabricate consent.
**Story:** WS12 (safety-rails scorecard, item 2 — one consent model).
**Alternatives rejected:**
- Widening `consent_status` into a shared both-channels rollup — a single mutable field
  cannot encode per-kind grant/revoke history, and any shared "granted" value would leak
  consent across channels (the exact TCPA failure mode).
- A new derived cross-channel column + migration — redundant: the ledger already carries
  enough to derive the decision at the gates; a stored rollup would be a second source
  of truth that can drift.
- Letting `recording` revocations suppress SMS — objecting to being recorded is not a
  revocation of contact consent; suppressing confirmations would punish the customer for
  a privacy preference.

### D-018: Autonomous close lane — sanctioned on-call sale-closing with owner UNDO
**Date:** 2026-07-11
**Superseded by D-019** (2026-07-12): the system-approval + undo-window backdating described
below were REVOKED as a human-authority violation. On-call close now only STAGES proposals for
explicit owner one-tap approval; the historical record is kept as written.
**Decision:** A per-tenant opt-in (default OFF), stricter SIBLING of the D-015 booking
lane (`packages/api/src/proposals/autonomous-close-lane.ts`) that authorizes the live
voice agent to CLOSE the sale on the call: a three-member chain
`draft_estimate → send_estimate($ref estimateId) → create_booking`, assembled on the live
path via `applyChainMetadata`. `send_estimate` is comms-class and
`decideInitialStatus`/`actionClassForProposalType` are deliberately UNCHANGED — a comms
proposal is still born blocked. Instead the close flow performs an explicit SYSTEM
APPROVAL of each chain member under the D-018 sanction (the analog of an owner's one-tap),
stamped + audited; the create-time comms block stays. Every member carries
`sourceContext.autonomousCloseEvaluation`.
`evaluateAutonomousCloseLane` gates in order (first-failing wins): `platform_disabled`
(`AUTONOMOUS_CLOSE_DISABLED`, checked FIRST and independently of
`AUTONOMOUS_BOOKING_DISABLED`) → `tenant_not_opted_in`
(`tenant_settings.autonomous_close_enabled`) → `quote_not_grounded_clean` (every line a
clean catalog match — no LLM price is ever auto-sent) → `above_close_cap`
(`tenant_settings.autonomous_close_max_cents`) → `not_strict_confirmed` (the authoritative
strict `confirmIntent` gate; the deterministic pre-check is necessary, not sufficient) →
`sms_consent_not_captured` (the on-call TCPA capture must succeed via
`recordSmsConsentFromVoice`) → `scheduling_incomplete`/`hold_not_placed`/`hold_expired` →
`booking_lane_ineligible` (the composed D-015 evaluation) → `session_flagged`
(vulnerability/emergency/negotiation, checked last). Migration 247 adds the two
`tenant_settings` columns.
**Rationale:** Booking a held slot (D-015) and closing a sale (drafting + SENDING a
priced quote/deposit link to the customer) are different risk tiers, so the close needs
its own opt-in, its own cap, and its own kill switch — never a widening of D-015's gate
set. A caller-initiated, strict-confirmed, consent-gated close warrants IMMEDIATE
execution rather than D-015's 5-second undo delay: the sanction backdates `approvedAt`
by UNDO_WINDOW_MS at approval time (audited as `undoWindowBypassed: true`) so the
executor's D-009 gate treats the window as elapsed — the executor itself is unmodified.
The safety net is the strict confirm gate plus an owner UNDO (`create_booking` → compensating cancellation + apology;
`send_estimate` → the estimate is withdrawn/voided so its approval link stops accepting
and no deposit can be taken — the quote TEXT itself cannot be recalled, and the UNDO copy
says so).
**Story:** WS18 (close the sale on the call).
**Alternatives rejected:**
- Teaching `decideInitialStatus` to auto-approve comms — would weaken the WS12 gate
  platform-wide; the sanction is a scoped explicit approval, not a rule change.
- Bypassing the `GatedMessageDelivery` / consent gate for the deposit text — the on-call
  SMS consent capture is what makes the gate pass legitimately.
- Reusing `AUTONOMOUS_BOOKING_DISABLED` — an operator must be able to freeze on-call
  sale-closing while leaving autonomous booking live (and vice-versa), so the close needs
  its own independent kill switch.

### D-019: On-call close requires explicit owner approval — D-018 system approval revoked
**Date:** 2026-07-12
**Initiative:** QUALITY-2026-07-12 (Restore human-authority invariants), Workstream 2.
**Decision:** The D-018 "sanctioned autonomous close" is revoked. No proposal may ever be
approved by a system actor: `system:autonomous-close` (and any `system:` actor) can CREATE
and stage proposals but can NEVER transition one to `approved`. Approval — the point at which
canonical writes, customer communication, booking confirmation, and money movement become
authorized — belongs to a human (the owner). Concretely:
- Deleted `sanctionCloseChain` (the explicit per-member system approval), `executeCloseChain`
  (the synchronous in-order executor), `sendCloseUndoSms` (the after-the-fact owner UNDO), and
  `assembleCloseChain` (the pre-approval 3-member assembler) from
  `proposals/autonomous-close-execution.ts`.
- Removed the undo-window backdating entirely: nothing writes `approvedAt` in the past
  (`new Date(Date.now() - UNDO_WINDOW_MS)` is gone), so the D-009 5-second undo window is
  honored on every close proposal the owner approves.
- A caller's confirmed, consent-gated, catalog-clean close now HOLDS the slot and STAGES a
  DRAFT chain — `draft_estimate → send_estimate($ref estimateId) → create_booking` (the held
  slot as a concrete `create_booking` DRAFT) — then sends the owner ONE `renderChainSms`
  one-tap approval SMS. The owner's tap (routes/one-tap-approve.ts → `approveChainSet`)
  approves the capture-class head + the capture-class booking in one action (the comms-class
  `send_estimate` follows separately, exactly as the chain legend says); the D-009 undo window
  and the standard executor are unchanged. The one-tap owner-approval fallback is preserved and
  is now the ONLY close path.
- The lane evaluation (`evaluateAutonomousCloseLane`) is retained as telemetry and to decide
  whether the held booking is staged in the owner chain (eligible) or the hold is released and
  a two-member estimate+send chain is staged (ineligible) — it no longer gates any autonomous
  execution.
- Structural guard: `transitionProposal` (proposals/lifecycle.ts) rejects any transition to
  `approved` by a `system:` actor, so the invariant cannot be reintroduced by a future caller.
- Removed the D-018-specific close-chain compensation from the one-tap UNDO route (siblings
  are no longer system-approved, and no close UNDO token is minted); the generic D-015 booking
  undo is unchanged.
- `AUTONOMOUS_CLOSE_DISABLED` (env) is deprecated but still accepted as a platform-wide off
  switch for even PREPARING the owner chain; `tenant_settings.autonomous_close_enabled` /
  `autonomous_close_max_cents` columns are retained (migration 247 is immutable) but now only
  govern whether the held booking is included in the owner-approval chain — never autonomous
  execution.
**Rationale:** "Never auto-execute proposals — all require human approval" (CLAUDE.md) is a
hard product invariant. D-018's system approval + undo-window backdating let the platform
confirm a booking, text a customer, and stand up a deposit link with no human in the loop —
a governance violation that no gate ladder makes acceptable. Holding a slot and preparing
proposals on caller confirmation is fine; authorizing them is the owner's, and only the
owner's, act.
**Story:** QUALITY-2026-07-12 WS2 (restore human-authority invariants).
**Alternatives rejected:**
- Keeping system approval behind a stricter gate — any system approval violates the invariant;
  the gate strength is irrelevant.
- Dropping the held booking entirely on caller confirmation — the goal explicitly permits
  holding a slot and preparing proposals; staging the booking as a DRAFT under owner approval
  preserves the product outcome without the violation.

### D-020: Sent-estimate retract is soft-delete (UI: Withdraw) — no void status
**Date:** 2026-07-15
**Initiative:** CRM QA QA-MANUAL-0730 (EST-0002 sent; no Cancel/Void/Withdraw control).
**Decision:** Owners retract a sent estimate by soft-deleting it. The web UI labels that
action **Withdraw** for `status === 'sent'` (including the UI-derived "Viewed" state, which
is still `sent` underneath). Soft-delete sets `deleted_at`, emits audit event
`estimate.deleted` (metadata includes the prior status), removes the row from list/get
paths, and stops the public approval link (`findById` filters `deleted_at IS NULL`). Draft,
`ready_for_review`, `rejected`, and `expired` keep the **Delete** label for the same
`DELETE /api/estimates/:id` path. Accepted estimates remain non-deletable (clone instead).
There is **no** estimate `voided` / `canceled` / `withdrawn` status; invoice void stays
invoice-only.
**Rationale:** Retractability already shipped via soft-delete (`softDeleteEstimate` in
`packages/api/src/estimates/estimate.ts`, migration `125_estimates_deleted_at`). QA found a
discoverability gap — the control only said "Delete" and the confirm copy never named the
customer-link effect. Renaming/clarifying the UX closes the finding without a status-machine
migration or a parallel audit event.
**Story:** QA-MANUAL-0730 / EST withdraw UX.
**Alternatives rejected:**
- First-class `voided` status mirroring invoices — expands shared enums, DB CHECK, public
  approve/decline gates, and money-state for Medium-priority discoverability; deferred.
- Document-only "sent estimates are immutable" — false; soft-delete already retracts.

### D-021: One Expo app serves supervisor and technician field personas
**Date:** 2026-07-15
**Decision:** The App Store and Play Store clients ship from the existing
`packages/mobile` Expo + React Native codebase as one binary. The authenticated
user's DB-authoritative role and `current_mode` select the surface: supervisors
land on voice, approvals, and money; technicians land on Today, assigned work,
field status, voice notes, and job photos; owner-operators in `both` mode receive
the combined surface. Administration remains web-first. AI, proposal execution,
tenant authorization, and canonical writes remain server-side.
**Rationale:** The supervisor voice-to-approval loop, camera, push, Clerk auth,
Stripe Terminal, and shared TypeScript contracts already run in Expo. The
technician day APIs also already exist. A Swift or Flutter rewrite would discard
that leverage, duplicate security-sensitive API clients and proposal UX, and
create a second implementation before native-only requirements justify it.
**Constraints:** Mobile navigation is permission- and mode-aware; technician
ownership checks resolve Clerk subjects to canonical `users.id` values; voice and
AI calls continue through the API gateway; proposals still require human approval;
camera, microphone, location, and notification permissions must match actual use.
**Alternatives rejected:** Swift/SwiftUI (iOS-only rewrite plus separate Android
client), Flutter (Dart rewrite with no direct shared-contract reuse), and a
Capacitor/WebView wrapper (weaker field media, push, and payment integration).
