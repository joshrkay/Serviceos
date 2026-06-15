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

### D-012: PRD §5 status reconciled against the codebase
**Date:** 2026-06-14
**Decision:** The §5 Rivet-vs-Jobber parity map's Status column is the
canonical feature-status surface and must reflect what is actually wired +
tested in `/packages`, not aspirational status. Reconciliation on 2026-06-14,
verified by code inspection (wiring into `app.ts`/workers/registries +
presence of tests):
- **Downgraded ✅→🔧 (claimed built, only partial):**
  - **MMS-to-quote** — photos ingest and attach to jobs
    (`sms/tech-status/mms-ingest.ts`); no image-analysis → draft-estimate
    pipeline exists (no vision/multimodal code in `ai/`).
  - **ACH payments** — Stripe card + payment links + saved-card off-session
    are live; ACH origination/bank-debit is not configured or exercised.
  - **B2B account recognition** — `customers.account_type` is a binary
    `residential|b2b` flag (consumed only by vulnerability triage); no
    `property_manager` type, no `parent_account_id`/sub-account hierarchy,
    no dedicated B2B routing flow.
- **Upgraded 📋/🔧→✅ (shipped ahead of roadmap status):** memberships
  (auto-renew off-session + member pricing + priority booking), auto-invoice
  on completion, dunning/overdue cadence, late fees, estimate follow-up
  (reminder cadence), auto-pay/saved-card (membership dues).
- **Investigated, found already built (left ✅):** review-request gating
  (`routes/public-feedback.ts` gates ≥4★ → Google/Yelp links), voice
  en-route/ETA (`notifications/delay-notifications.ts` `enqueueEnRouteNotice`),
  voice dispatch reassignment (`reassign_appointment` intent + task).
**Rationale:** Status accuracy is a sales/credibility and planning input — the
PRD tells GTM what ships. Three differentiators were marked Built but only
partially implemented; six parity/closing items were under-reported as
Specced/Partial when already shipped.
**Story:** Status audit requested 2026-06-14; build work to close the three
confirmed gaps is planned separately under `docs/plans/`.
**Alternatives rejected:** Build the three gaps before correcting the doc —
rejected; the doc should tell the truth now, build is sequenced separately.

### D-013: Negotiation V2 — bounded, policy-gated discount self-service
**Date:** 2026-06-15
**Decision:** Lift the V1 P2-036 non-goals ("automatic price floors (V2)",
"per-tenant negotiation playbooks (V2)") behind an opt-in, fail-closed per-tenant
discount policy. A pure evaluator (`evaluateDiscountAsk`) classifies each haggling
ask into `ALLOW` / `NEEDS_APPROVAL` / `CLARIFY` / `REJECT_WITH_COUNTER` against a
catalog-grounded floor (`max(list−cap, optional margin floor, optional absolute
floor)`). The "AI never silently discounts" posture is preserved: even `ALLOW` is
confidence-capped (`_meta.overallConfidence:'low'`) so it routes to a one-tap human
approval over the existing transport — the engine only changes whether an in-policy
ask may be *proposed* without escalating to a full owner callback. Default
`maxDiscountBps: 0` ⇒ behavior-identical to V1 until a tenant opts in.
**Rationale:** V1 deliberately blocks every discount, so for tenants who want
bounded self-service every routine ask becomes a manual owner callback. A policy
ceiling + catalog-grounded floor turns in-policy asks into one-tap proposals
without ever letting the AI sell below margin or concede silently. Policy lives on
`tenant_settings` columns (deposit-rules precedent, migration `077`) for DB-level
money guards (`CHECK`s), not a JSONB grab-bag. All percentage math via the shared
`applyBps` (the single rounding home) — never `* 0.9`.
**Story:** V2 evolution of P2-036 / N-003 —
`docs/plans/2026-06-14-002-feat-negotiation-discount-policy-engine-plan.md`
(depends on the now-shipped V1 closure plan).
**Alternatives rejected:** (1) Keep V1 all-or-nothing — rejected: forces a manual
callback for every routine in-policy ask. (2) Let the AI auto-execute in-policy
discounts — rejected: violates the human-approval invariant; `ALLOW` stays
confidence-capped to a tap. (3) JSONB policy grab-bag — rejected: loses DB-level
`CHECK` money guards. (4) Embed discount logic in `decideInitialStatus` — rejected:
keeps the universal status gate money-agnostic; the money core is a pure,
exhaustively-tested standalone evaluator.

### D-014: [Template — copy for new decisions]
**Date:** YYYY-MM-DD
**Decision:** [What was decided]
**Rationale:** [Why this choice over alternatives]
**Story:** [Which story triggered this decision]
**Alternatives rejected:** [What else was considered]
