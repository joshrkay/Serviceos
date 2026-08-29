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

### D-022: The `app.ts` problem is dependency wiring, not route sprawl
**Date:** 2026-07-25
**Decision:** The `packages/api/src/app.ts` decomposition targets **dependency
construction**, not route extraction. Measurement shows routes are already
modular: 70 modules in `src/routes/`, 83 `createXxxRouter()` calls, 111
`app.use()` mounts, and only 2 inline `app.get` handlers with zero inline
post/put/patch/delete. What makes `createApp()` 6,143 lines (`app.ts:739–6881`)
is 223 repository instantiations, 20 service instantiations, and 488 imports,
handed to router factories as long positional argument lists. The target shape
is therefore repository/service factory modules plus per-domain
`registerXModule(app, deps)` functions; any plan sequenced by route group
(health → reporting → customers → jobs → …) is sequencing work that is already
done and must be rewritten before execution.
**Rationale:** The earlier roadmap prescribed extracting route modules, which
would have produced churn with no reduction in `app.ts` — the routers it names
are already separate files. Sequencing by dependency cluster instead attacks the
actual 6,143 lines. Doing this measurement first also revealed that
`packages/api/test/app/route-manifest.test.ts` is the prerequisite safety net:
the wiring order encodes an implicit security boundary (ten `/api/*` routers
mount ahead of `requireAuth`) that no test pinned before, and that a wiring
refactor could silently change.
**Story:** Quality Sprint 1 — safety rails (Node pinning, doctor, dependency
audit gate, ESLint report-only, route manifest, this baseline).
**Constraints:** The route manifest snapshot must be regenerated and reviewed
line-by-line in any commit that moves wiring, with particular attention to
exposure-class changes and to the pre-`requireAuth` `/api` allowlist. The
migration corpus (`db/schema.ts`, 265 migrations replayed per boot) is a
separate workstream and must not be bundled into this one.
**Alternatives rejected:** Extract by route group (the roadmap's ordering —
targets files that are already extracted); extract by file size alone (would
split `schema.ts` and `app.ts` in the same change, making the diff
unreviewable); leave `app.ts` alone (the 488-import, 223-instantiation single
function is the main obstacle to onboarding and to testing wiring in isolation).

### D-023: Part F ratified — F-1 two-step invoice issuance; F-2 brand-voice lock stays tap-only
**Date:** 2026-08-01
**Initiative:** Voice back-office workflows plan, U5 decision gate
(`docs/plans/2026-08-01-001-feat-voice-back-office-workflows-plan.md`); Part F register
(`docs/PRD-v4-part-F-decisions.md`).
**Decision:** The product owner ratified both PROPOSED Part F entries on 2026-08-01 (via
AskUserQuestion — recorded here as the provenance of the call):
- **F-1 (B9.1 issuance semantics) = the TWO-STEP reading.** One utterance + one tap yields an
  approvable `draft_invoice`; a second utterance ("issue it") + a second tap approves the
  separate `issue_invoice` proposal, which is money-class and never auto-approves. Single-
  utterance auto-issue is explicitly NOT built.
- **F-2 (B1.18) = amended to "captured by voice; locked by tap."** Brand-voice capture/edit is
  speakable (as an approval-gated `update_brand_voice` proposal); locking remains tap-only. The
  payload contract has no lock-shaped field, so a spoken "lock my brand voice" can never set
  `brand_voice_locked`.
**Rationale:** Both ratifications adopt the register's own recommendations unchanged. F-1:
`issue_invoice` makes a customer-visible, money-bearing document real; the action-class ladder
(`actionClassForProposalType` → `money`) and the D-013 posture (approval is never
voice-reachable) both treat "make it real" transitions as human-gated, and an auto-issue-on-
approve tap doing double duty would be a new capability needing its own risk review. F-2: lock
is a control act freezing the tenant's outbound identity — same theory as D-013's approval
exception (control acts stay off the voice surface).
**Constraints:** No code was gated on these ratifications — the shipped implementation already
matches both readings (issue leg: `packages/api/src/ai/orchestration/task-router.ts`
`IssueInvoiceTaskHandler` + `packages/api/src/proposals/execution/issue-invoice-handler.ts`;
lock: `packages/api/src/proposals/contracts/brand-voice.ts` +
`packages/api/src/proposals/execution/brand-voice-handler.ts`). Chain-set approval sweeps
capture-class siblings only, so a chained issue leg still requires its own tap
(`proposals/actions.ts` `approveChainSet`). Rung-4→5 score flips in
`projects/rivet-voice-19/re-measurement.md` belong to that run's own process, not this entry.
**Alternatives rejected:** Single-utterance auto-issue (new capability; approval tap doing
double duty over a money transition); lock-by-voice (an utterance that irreversibly freezes
tenant config — its own risk review, deliberately unbuilt).

### D-024: `app.ts` decomposition is sequenced by construction kind, not by domain — D-022's per-domain half is deferred
**Date:** 2026-08-19
**Decision:** Execute the `packages/api/src/app.ts` decomposition in two stages and ship
only the first for now. **Stage 1** slices by construction *kind* —
`buildRepositories(pool)`, then `buildServices(repos, config)`, then the worker
constructions — and gives `createApp` an **optional** overrides parameter
(`createApp(overrides?: Partial<AppDeps>)`), so the production path is unchanged and the
18 test files that boot the app keep working untouched. **Stage 2** — D-022's per-domain
`registerXModule(app, deps)` functions — is explicitly deferred until Stage 1 has landed
and the shared-dependency surface is visible in a type rather than inferred from a
6,715-line function.
**Rationale:** D-022's target shape ("repository/service factory modules **plus** per-domain
`registerXModule(app, deps)` functions") names two pieces of work in one sentence, and
measurement taken 2026-08-19 shows they should not be attempted together. Fan-out inside
`createApp()` is extreme and cross-cutting: `auditRepo` has **90** distinct consumers
spanning every domain (its own comment at `app.ts:1152` records ~270 audit-write sites
threading through it), `pool` has 164, and eleven bindings exceed fifteen consumers
(`settingsRepo` 46, `customerRepo` 41, `jobRepo` 37, `proposalRepo` 31, `invoiceRepo` 23,
`appointmentRepo` 22, `messageDelivery` 20, `llmGateway` 19, `estimateRepo`/`userRepo`/`queue`
16). Cross-domain edges are the norm, not the tail: `createVoiceActionRouterWorker` receives
43 distinct bindings, `twilioAdapterDeps` 57, `createExecutionHandlerRegistry` 50, and only
three construction clusters are contiguous and self-contained (integrations `3436–3521`,
reputation `2148–2197`, media-streams `4427–4818`). A per-domain split executed today
therefore yields twelve modules that each import most of a shared core bag — churn against
the same 6,715 lines, which is the specific failure D-022 was written to prevent. Slicing by
kind instead attacks the largest measured mass (~150 `new PgX(pool)` constructions behind 74
`pool ? Pg : InMemory` ternaries), has a mechanical correctness criterion, and makes the core
bag explicit so the Stage 2 domain question can be answered from a type instead of a guess.
**Story:** Quality Sprint — `app.ts` wiring decomposition. Characterization groundwork landed
in PR #828 (`chore/app-wiring-characterization`).
**Constraints:**
- D-022's constraints carry over unchanged: the route-manifest snapshot
  (`test/app/route-manifest.test.ts`) must be regenerated and reviewed line-by-line in any
  commit that moves wiring, with particular attention to exposure-class changes and the
  pre-`requireAuth` `/api` allowlist; the migration corpus (`db/schema.ts`) stays a separate
  workstream.
- Two further characterization gates are prerequisites, added by PR #828:
  `test/app/interval-registration-count.test.ts` pins the exact gated background-interval
  count (`backgroundIntervalCount` is derived from registration *order* relative to the
  `observabilityIntervalCount` snapshot at `app.ts:2674`, so a reordering changes it with no
  type error), and `test/app/repository-instance-sharing.test.ts` pins per-boot construction
  counts for the hoisted repositories.
- The hoisting invariant is **not uniform** and Stage 1 must preserve it exactly:
  `settingsRepo` (aliased `1106`), `jobRepo` (`1115`) and `pendingInvitationRepo` (`1119`) are
  single shared instances, while `invoiceRepo`/`estimateRepo`/`paymentRepo` are each
  constructed a second time for the webhook surface (`1108`–`1110`). The duplicates are
  harmless in production (two Pg repos read one database) but diverge in hermetic mode.
  Collapsing them is a behaviour change that must land on its own, never inside a wiring move.
- Process-global setters are **partially** in scope: the auth, owner-notification and
  supervisor-presence loaders become instance-scoped because last-write-wins is what currently
  prevents two `createApp()` calls in one process from being isolated
  (`configureSupervisorCreationHook`'s own comment records this, and the SMS keyword registry
  passes `{ overwrite: true }` from ten sites specifically to survive re-entry). `setDraining`
  and the `process.once` SIGTERM handler stay process-wide — that is correct behaviour.
- The ~10 late-bound `let` slots (e.g. `supervisorSpendRecorder` declared `2341`, consumed
  `2357`, assigned `7271`) become explicit providers so the ordering constraint is carried by
  a type rather than by line position. An eager factory extraction would silently turn them
  permanently `undefined`.
**Alternatives rejected:**
- Execute D-022 as one change (factories *and* per-domain registration). Rejected on the
  fan-out measurement above — the domain modules cannot be made independent while `auditRepo`
  has 90 consumers, so the split would move code without reducing coupling.
- Make the deps parameter required (`createApp(deps: AppDeps)`). Rejected for Stage 1: it
  forces all 18 booting test files to change in the same diff as the wiring move, which is the
  unreviewable-diff failure D-022 already called out. It stays available as a mechanical
  follow-up once every dependency is reachable through the overrides bag.
- Leave `app.ts` alone. Rejected — it has grown from the 6,143 lines D-022 measured on
  2026-07-25 to 6,715 (`app.ts:769–7484`), and the growth is per-feature wiring, so the cost
  compounds with every voice intent added.

### D-025: Owner voice approval is permitted — the "approval is never voice-reachable" posture was never decided
**Date:** 2026-08-19
**Initiative:** Voice-first on the phone (wayfinder map #833), ticket #834.
**Decision:** Approval of a proposal **by voice, by a human owner on a transport-identified
owner line, is permitted**. The shipped class boundary in `ai/tasks/proposal-approval-task.ts`
(RV-071) is ratified as-is:
- **capture / comms** — approve on a deterministic strict affirmative
  (`classifyStrictConfirm`, never an LLM), after a readback composed from the **proposal
  payload** rather than the owner's utterance.
- **money / irreversible** — additionally require a spoken challenge
  (`proposal-approval-task.ts:366`), with at most 3 failed attempts per voice session and a
  session-wide lockout on the third.

**Rationale:** D-023's rationale asserts "the D-013 posture (approval is never
voice-reachable)". **D-013 contains no such posture** — it is the §5 status correction about
QuickBooks sync and the correction loop, and mentions neither approval nor voice. The phrase
"voice-reachable" occurs exactly once in this entire log, in that citation. So there was no
decision to supersede: a posture was asserted in passing, attributed to an unrelated entry, and
then contradicted by shipped code that nobody flagged. This entry records the real posture for
the first time.

The substantive invariant is **D-019**, and it is about *actors*, not *channels*: no `system:`
actor may transition a proposal to `approved`, enforced structurally in
`proposals/lifecycle.ts` (`isSystemActor`). A human owner speaking on a caller-ID-identified
line is a human approving; it does not breach that invariant. Reading D-019 as a prohibition on
the voice *channel* confuses who is authorising with how they are speaking.

**Constraints:**
- Gated on `ownerSession` (RV-070 caller-ID identity), re-checked inside the task as defence in
  depth; blocked while `hasUnappliedEditRequest` holds, matching the SMS and one-tap paths.
- **Money-class voice approval is NOT to be considered shipped** until the spoken challenge is
  excluded from the stored transcript and every derived summary (#850). A static per-tenant PIN
  re-spoken on every approval accumulates exposure with each recorded call.
- **Not viable on the Gather transport.** An approval exchange costs ~5–7s against a `noHang` of
  5s soft / 7s hard, so the approval turn trips the hang timer before any work runs (~2–3s on
  Media Streams). Which transport carries voice approval is #838.
- Recorded reservation: `comms` sits on the soft side of the boundary. An approved
  `send_invoice` or `send_customer_message` is customer-visible and effectively not undoable,
  yet needs no challenge. Ratified deliberately, not overlooked.

**Alternatives rejected:**
- *Gate the shipped voice-approval path off to match D-023's wording.* Rejected: it would delete
  a carefully-designed capability on the strength of a parenthetical that cites a decision
  saying something else.
- *Require the challenge for `comms` as well.* Rejected for now — it would put a PIN in front of
  routine customer messages, which is the friction voice-first exists to remove. Revisit if the
  undo window proves insufficient for outbound comms.
- *Leave the contradiction unrecorded.* Rejected: a reader of this log would conclude a live,
  security-reviewed feature should not exist.

### D-026: The phone authorises lookups by a caller-ID-resolved actor's DB role, through the shared dispatch
**Date:** 2026-08-26
**Initiative:** Voice-first on the phone (wayfinder map #833), Phase 0 of #852; spec #866, closes #843.
**Decision:** The live phone is the third caller of the shared lookup dispatch
(`workers/voice-lookup-answer.ts`); its private switch is deleted. Authorization on the phone is
the shared module's DB-authoritative RBAC gate applied to an **actor** resolved **once at
session establishment** from caller-ID (`telephony/phone-actor.ts`: registered mobile → active
user, and a matched-but-inactive user resolves nothing; else owner line → the tenant's single
active owner; else none), never from utterance content. The `ownerSession && extendedIntents`
dispatch-side gate is removed; the tenant flag continues to gate only whether the classifier
*offers* the owner-extended intents. One phone-specific rule remains at dispatch, stated as an
**allowlist** (default-deny): with **no resolved actor** the phone answers only the caller's own
customer-scoped records and tenant-public lookups (`lookup_availability`); every other lookup is
refused with the shared module's refusal copy (`lookup_my_day` gets an identity-flavoured line).
The phone is the only surface with anonymous/customer callers, and `lookup_day_overview` /
`lookup_materials` carry no permission entry on purpose (any signed-in operator may hear them on
memo/chat) — a denylist over the owner-extended set would have read the tenant's shopping list to
any identified caller. `PHONE_PUBLIC_LOOKUP_INTENTS` has exactly one member, `lookup_availability`:
it is the one lookup a customer legitimately asks ("when could you come out?"), it answered to
customers before #866, and it reveals only aggregate booking density; anything added to that set
must be argued for in this log. A table-driven pin over all 20 lookup intents makes the 21st fail
loudly.
**Rationale:** Five lookups were unreachable on the phone because the phone carried its own
14-case copy of a 20-case switch (#843). The shared module's gate and `lookup_my_day`'s
self-scoping both require an actor, so the "minimal fix" was not available through the shared
path. Verified while specifying: `lookup_revenue` and `lookup_leads` sit in the base classifier
prompt and the phone's dispatch applied no authorization after customer identification — an
identified customer could be read the tenant's revenue. RBAC at dispatch is the missing
defence-in-depth layer behind the prompt.
**Constraints:** Caller-ID is the *authentication factor* that mints the phone actor. It is
transport-level recognition, spoofable by design, and no stronger than the RV-070 owner-line
check that already gated owner lookups and voice approval — `actorUserId` must never be read
as a verified subject the way `req.auth.userId` is; note the blast radius widened from the owner
line to any employee mobile on file (spoofing a dispatcher's number yields owner-grade reports),
which is still a net tightening because revenue and leads previously had no gate at all. A spoken
challenge for owner-grade lookups is a follow-up. No classifier prompt / taxonomy / cassette
change. `ownerSession` keeps its RV-071 approval role unchanged (D-025). Customer-name resolution
on the phone stays undecided (#833 "entity resolution per surface"). #860 step 2 (media-streams)
calls the same surface adapter from `speechTurn`; the actor is already stamped for that transport by the
shared establishment core, so step 2 adds the dispatch call and nothing about identity. It is not
wired here.

### D-027: A live-call complaint escalates to a human; bare confirm re-prompts; language_switch ships on Gather
**Date:** 2026-08-28
**Initiative:** Voice Phase 0 of #852; #846, review-fix pass on PR #883.
**Decision:** Three behaviors from #846's Gather-path intent handling, ratified by the owner on
2026-08-28 after the two-axis code review of PR #883:
1. **Complaint escalates.** A `complaint` classified on a live call is handled like
   `operator_request`: the FSM's global guard speaks a fixed acknowledgment
   (`COMPLAINT_ESCALATION_LINE`) and fast-paths to `escalating` (audit log + `notify_oncall`,
   `escalationReason: 'complaint'`). This SUPERSEDES the first cut, which deflected and continued
   the call negotiation-style. The one-shot owner `callback` proposal is RETAINED as the
   escalation's paper trail (idempotent via `complaintFlagged`), carrying the recorded-memo
   path's deterministic severity markers — severity detection runs over the caller's raw
   utterance, threaded through the `intent_classified` event, not just classifier-extracted
   entities. On the untrusted S1 live-caller surface it stays a `callback` and never an
   `add_note` (operator-only; coercion would reproduce the silent-degrade bug #846 fixed).
   Unlike `operator_request` there is no `escalationTriggers` deflect branch: no tenant toggle
   maps to complaints, and an unhappy caller always reaches a person.
2. **Bare confirm re-prompts, in speech.** A bare `confirm` ("yes") with nothing pending is
   answered by the FSM's spoken re-prompt (`CONFIRM_NOTHING_PENDING_LINE`) — never persisted as
   a `voice_clarification` card. The guard covers BOTH states the adapters classify in,
   `intent_capture` AND `closing` (the adapters gate on `intent_capture || closing`, so
   covering only one left the closing "yes" minting cards); `intent_confirm`'s
   intent-classified-as-correction handling is untouched, and a live post-quote "yes" is still
   consumed by the deterministic pendingQuote pre-check before the classifier runs.
3. **language_switch ships on Gather notwithstanding open #838.** The adapter-level Gather
   branch (flip `session.language`, re-resolve the TTS voice, tenant `supported_languages`
   gate, shared `MAX_LANGUAGE_SWITCHES_PER_CALL` flap cap) is live; whatever #838 decides about
   the broader language posture applies on top of it rather than blocking it.
**Rationale:** The review surfaced that "I've flagged this for the owner, anything else?" reads
as a brush-off to a caller angry enough to say "complaint" — the cost of a wrongly-escalated call
is one human minute, the cost of a wrongly-deflected complaint is a churned customer and an
unheard refund/legal threat. Escalation with a paper-trail proposal keeps both: the human gets
the call, the owner gets the severity-marked follow-up card.
**Alternatives considered:**
- *Deflect-and-continue (the first cut).* Rejected by the owner: a complaint is a request for a
  person, not context to file.
- *Escalate without the callback proposal.* Rejected: the on-call transfer is ephemeral; the
  proposal is the reviewable record and carries the severity markers the digest/cards key on.
- *Gate complaint escalation on an `escalationTriggers` toggle.* Rejected: `trigger_explicit_request`
  means "caller asked for a person" and its deflect line ("I can help with scheduling…") would be
  absurd against a complaint; adding a new toggle would default some tenants into the brush-off.
