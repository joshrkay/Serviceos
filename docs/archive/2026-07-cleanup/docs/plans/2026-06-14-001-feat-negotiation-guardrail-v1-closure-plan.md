# feat: Finish P2-036 negotiation guardrail to spec (LTV/recency + typed payload + brand voice + invariant test)

**Created:** 2026-06-14
**Depth:** Standard
**Status:** plan
**Story:** P2-036 / N-003 (V1 closure) — `docs/stories/wave-2-strategic-stories.md:211`, `docs/PRD.md:643`
**Sequenced with:** `docs/plans/2026-06-14-002-feat-negotiation-discount-policy-engine-plan.md` (V2 follow-on; build this V1 plan first)

## Summary
The P2-036 negotiation guardrail already ships in V1 form: deterministic ask-type
detection, a deflect-and-route posture, a brand-voiced SMS holding line, and an
owner `callback` proposal across three channels (live-call FSM, voice-action-router,
inbound SMS). This plan closes the remaining gaps between that implementation and the
story's V1 acceptance criteria — most importantly, the owner proposal must carry the
customer's **lifetime value + recency** (an unmet acceptance criterion *and* a required
test), the recommendation must be **value-aware**, the negotiation payload must be a
**Zod-typed contract** (it is currently `Record<string, unknown>`), the live-call
acknowledgment must use the **locked brand voice** (today it is a fixed script while SMS
is brand-voiced), and the "AI can't concede a discount/scope change without an approved
proposal" restriction must be **pinned by a test**.

## Problem Frame
P2-036's V1 guardrail is built but incomplete against its own spec. The owner who
receives a "customer is haggling" callback gets a generic, static recommendation with no
signal about *who* is asking — yet the spec explicitly requires the proposal to include
"the customer history (lifetime value, recency)" so the owner can decide (e.g. "don't
discount: high-LTV customer who'll come back; offer a courtesy instead" vs. "first-timer,
hold firm"). Without LTV/recency the guardrail can't deliver the judgment the story
promises. Secondary gaps (untyped payload, channel-inconsistent brand voice, missing
invariant test) are correctness/spec-compliance debt on a money-adjacent, trust-critical
path.

## Requirements
- R1. The owner negotiation callback includes customer **lifetime value (cents)** and
  **recency** (last-seen), plus jobs-completed count where available. *(Acceptance
  criterion + required test: "Recommended response includes customer LTV and recency
  context.")*
- R2. The owner **recommendation is value/recency-aware** (deterministic), not a single
  static string per ask type. Still never recommends a concrete discount amount (V1
  blocks discounts; price floors are a V2 non-goal).
- R3. The negotiation callback payload is a **Zod-validated typed contract**
  (`packages/shared/src/contracts/negotiation-event.ts`, a spec'd allowed file), honoring
  the "all proposals are Zod-validated typed payloads" invariant.
- R4. The **acknowledgment uses the locked brand voice on both text and voice channels**
  (today: SMS brand-voiced, live-call fixed script). *(Acceptance criterion: "Acknowledgment
  message uses the locked brand voice"; "Detection on text and voice channels.")*
- R5. A test **proves the AI cannot emit a discount or scope-change commitment without an
  approved proposal**. *(Spec: "tests must prove the restriction"; "Discount cannot be
  applied to an estimate without an approved negotiation_response.")*
- R6. The owner callback continues to ride the existing SMS approval transport (P2-034)
  and never auto-executes (capture-class, lands in `draft`). *(Regression-protect; verify.)*

## Key Technical Decisions
- **Reuse the `callback` proposal type; do not mint a new type or migration.** The shipped
  design deliberately reuses capture-class `callback` (parity with the complaint handler),
  which guarantees `draft`/never-auto-execute. The Zod contract (R3) validates the *payload
  shape*, not a new proposal type. (Alternative: a dedicated `negotiation_response` type as
  the spec's prose names — rejected: needs a migration + execution wiring for no behavioral
  gain; the marker + capture-class already enforce the gate.)
- **LTV/recency computed from existing tables, no denormalized stats column.** LTV =
  `SUM(invoices.amount_paid_cents)` for the customer; recency = most recent of
  `appointments.scheduled_start` (via `jobs.customer_id`, the `match-customer.ts` join) or
  `payments.paid_at`. (Alternative: add a cached `customers.lifetime_value_cents` column —
  rejected for V1: premature denormalization + cache-invalidation burden; a scoped read is
  fine at call cadence.)
- **Recommendation and acknowledgment stay deterministic (no LLM).** Matches the existing
  module docs ("a classification that drives owner-facing routing must be a fixed,
  inspectable rule, not an LLM mood read") and keeps the holding line incapable of an
  accidental concession. Value tiers are auditable constants. (Alternative: LLM-composed
  recommendation — rejected: auditability + concession risk on a money path.)
- **Brand-voice reconciliation = compose the live-call holding line via the shared
  `composeNegotiationAcknowledgment`, at the layer that has tenant settings.** Keeps the
  pure FSM pure (it signals "speak holding line"; the voice-turn processor renders the
  text), and unifies brand voice across SMS + voice. (Alternative: document the fixed-script
  divergence as accepted — kept as a fallback only if settings can't reach the seam; see
  Open Questions.)

## Scope Boundaries
**In scope:** customer LTV/recency provider; value-aware deterministic recommendation;
Zod contract for the negotiation payload; threading customer context into all three
emission surfaces; brand-voice reconciliation of the live-call acknowledgment; the
no-discount-without-approval invariant test.

**Non-goals (V1 — explicitly deferred to the V2 plan):**
- Per-tenant discount policy / discount caps.
- Catalog-grounded price floor / margin floor / cost-basis schema.
- An `ALLOW`/auto-allow-within-policy branch or any path that *applies* a discount.
- Negotiation playbooks per tenant.
- Parsing a target price from the utterance ("I'll pay $200") — only needed for the V2
  evaluator; V1 stores the verbatim ask text only.

### Deferred to follow-up work
- Everything in `docs/plans/2026-06-14-002-feat-negotiation-discount-policy-engine-plan.md`.

## Repository invariants touched
- **Integer cents:** LTV is `SUM(amount_paid_cents)`; provider/contract carry only integer
  cents. No floats.
- **tenant_id + RLS:** the customer-context read is tenant-scoped via the `withTenant`
  pattern (`PgBaseRepository`); integration test asserts no cross-tenant leakage.
- **Audit events:** no new mutation is introduced — the read is not a mutation; the
  callback creation (the mutation) is already audited by the proposal layer. Honored
  unchanged.
- **LLM gateway:** no new LLM calls (recommendation + acknowledgment are deterministic).
- **Zod proposals:** the previously-untyped negotiation payload becomes a Zod-validated
  contract (R3) — moves this path *into* compliance.
- **Human-approval gate / never auto-execute:** unchanged; the callback stays capture-class
  and `draft`; R5/R6 pin it.
- **Entity resolver / catalog resolver:** untouched (no pricing/entity changes; customerId
  is already resolved upstream).

## Implementation Units

### U1. Customer negotiation-context provider (LTV + recency)
- **Goal:** a tenant-scoped read returning `{ lifetimeValueCents, lastSeenAt, jobsCompletedCount }`
  for a customer, plus a pure formatter for a human recency label ("3 weeks ago", "new
  customer").
- **Requirements:** R1
- **Dependencies:** none
- **Files:**
  - `packages/api/src/customers/customer-negotiation-context.ts` (interface
    `CustomerNegotiationContext`, provider interface, and pure formatting helpers)
  - Pg implementation: a `PgCustomerNegotiationContextProvider` (new file alongside, or
    extend the existing customers repo) using `PgBaseRepository` + `withTenant`
  - `packages/api/test/integration/customer-negotiation-context.test.ts` (Docker-gated)
  - `packages/api/test/customers/customer-negotiation-context.test.ts` (pure formatter unit)
- **Approach:** LTV = `SUM(amount_paid_cents)` over the customer's `invoices`
  (`schema.ts:620`; include `paid`/`partially_paid`/`open` as money actually collected —
  `amount_paid_cents`, not `total_cents`). Recency = `GREATEST(MAX(appointments.scheduled_start
  via jobs.customer_id), MAX(payments.paid_at))`; null when the customer has no history
  (brand-new caller). `jobsCompletedCount` from completed jobs. Keep all SQL in the Pg
  provider; keep the recency-label formatting in a pure exported function.
- **Patterns to follow:** `packages/api/src/reputation/match-customer.ts`
  (`PgCustomerLoader`: `PgBaseRepository`, `withTenant`, customers→jobs→appointments join,
  typed row interface); `packages/api/src/digest/digest-service.ts` for `jobsCompletedCount`.
- **Test scenarios:**
  - Integration (Docker-gated, **pins real columns**): seed a tenant with paid +
    partially-paid + draft invoices → LTV sums only collected `amount_paid_cents`; recency =
    latest appointment vs. latest payment; a second tenant's data never appears (RLS).
  - Integration: customer with zero history → `lifetimeValueCents: 0`, `lastSeenAt: null`,
    `jobsCompletedCount: 0`.
  - Unit (pure): recency formatter — null → "new customer"; recent/old dates → expected
    relative label (rendered in tenant timezone per the repo's UTC-store/tz-render rule).
- **Verification:** the provider returns correct cents + recency against a seeded Postgres,
  tenant-isolated, with the brand-new-customer case handled.

### U2. Typed negotiation payload contract (Zod)
- **Goal:** define and enforce a Zod schema for the negotiation callback payload; create the
  spec'd `negotiation-event.ts`.
- **Requirements:** R3
- **Dependencies:** none (define the `customerContext` sub-shape to match U1's interface)
- **Files:**
  - `packages/shared/src/contracts/negotiation-event.ts` (Zod `negotiationCallbackPayloadSchema`:
    `askType`, `askText`, `recommendation`, `customerContext` `{ lifetimeValueCents:int>=0,
    lastSeenAt: nullable ISO, recencyLabel, jobsCompletedCount:int>=0 }`, optional
    `transcript`/`conversationId`, and the `_meta` marker shape) + inferred type export
  - `packages/api/test/shared/contracts/negotiation-event.test.ts`
- **Approach:** model on existing per-type contracts; integer-cents fields use
  `z.number().int().min(0)`; keep the `_meta.markers` shape compatible with
  `NEGOTIATION_GUARDRAIL_MARKER_REASON`. `buildNegotiationCallbackContent` (U3) will parse
  its output through this schema so a malformed payload fails fast in tests/CI.
- **Patterns to follow:** `packages/api/src/proposals/contracts/reschedule.ts`,
  `packages/api/src/proposals/contracts/notes.ts`; `lineItemSchema` in
  `packages/shared/src/contracts/proposal.ts` (integer-cents conventions).
- **Test scenarios:**
  - Happy path: a fully-populated payload parses; inferred type matches U1's context shape.
  - Error paths: missing `askType`/`recommendation` rejected; negative/float
    `lifetimeValueCents` rejected; unknown `askType` rejected.
- **Verification:** schema accepts well-formed payloads and rejects each malformed case.

### U3. Value/recency-aware recommendation
- **Goal:** the owner recommendation factors in customer LTV + recency (deterministic),
  composing ask-type guidance with a value framing — never a concrete discount.
- **Requirements:** R2
- **Dependencies:** U1 (context shape), U2 (payload carries context)
- **Files:**
  - `packages/api/src/proposals/guardrails/negotiation-guardrail.ts` (extend
    `recommendNegotiationResponse` to take optional customer context, or add
    `buildOwnerRecommendation(askType, ctx)`; thread context through
    `buildNegotiationCallbackContent` and validate output via U2's schema)
  - `packages/api/test/proposals/guardrails/negotiation-guardrail.test.ts` (extend)
- **Approach:** deterministic value tiers as named constants (e.g. high-LTV-and-recent →
  "valued repeat customer — a small courtesy may be worth it; your call"; some-history →
  neutral; no-history/first-timer → "first-time caller — hold firm"). The final
  recommendation = ask-type base guidance + value framing. `null` context falls back to the
  current generic strings (backward compatible). No price/discount amounts.
- **Patterns to follow:** the existing `RECOMMENDATIONS` map + `complaintSeverity`
  determinism in `packages/api/src/ai/tasks/complaint-task.ts`.
- **Test scenarios:**
  - Happy path (golden): high-LTV + recent discount ask → recommendation mentions
    repeat/value and a courtesy framing; first-timer discount ask → "hold firm".
  - Edge: `null`/absent context → existing generic recommendation (regression-safe).
  - Edge: recommendation **never** contains a currency amount / "% off" (assert by regex)
    — preserves the V1 "blocks discounts" posture.
- **Verification:** recommendations differ by value tier and never emit a discount figure.

### U4. Wire customer context into all three emission surfaces
- **Goal:** fetch the customer context by `customerId` and thread it into the callback
  builder at every surface; graceful fallback for unknown callers.
- **Requirements:** R1, R6
- **Dependencies:** U1, U2, U3
- **Files:**
  - `packages/api/src/ai/tasks/negotiation-task.ts` (accept the provider as a dep; use
    `ee.customerId` → fetch context → pass to the builder)
  - `packages/api/src/workers/voice-action-router.ts` (construct/inject the provider into
    `NegotiationGuardrailTaskHandler` at registration)
  - `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts` (live-call path: fetch +
    pass context when building the owner callback)
  - `packages/api/src/sms/negotiation/inbound-negotiation-handler.ts` (SMS path: same)
  - `packages/api/src/app.ts` (construct the Pg provider; inject into the three surfaces)
  - `packages/api/test/ai/tasks/negotiation-task.test.ts`,
    `packages/api/test/ai/voice-turn/voice-turn-processor.test.ts`,
    `packages/api/test/sms/negotiation/inbound-negotiation-handler.test.ts` (extend)
- **Approach:** inject the provider via constructor/closure following existing DI in the
  router/app wiring. When `customerId` is absent (unknown caller) or the provider returns
  no history, pass `null` context → U3 falls back. Keep idempotency keys unchanged. The
  callback continues through the existing unsupervised-routing + SMS render path.
- **Patterns to follow:** how `ComplaintTaskHandler` receives `deps.proposalRepo`; existing
  provider injection in `app.ts`.
- **Test scenarios:**
  - Happy path (per surface, mocked provider): known customer → callback payload includes
    `customerContext` (LTV/recency) and the value-aware recommendation.
  - Edge: unknown caller / no `customerId` → callback still emits with `null` context and a
    generic recommendation; no throw.
  - Regression (R6): emitted proposal is `callback`, capture-class, status `draft`; routes
    through the SMS transport (assert the render/route call) — covers "owner proposal arrives
    via SMS".
  - Idempotency: same `recordingId` does not double-create.
- **Verification:** all three channels attach real customer context; unknown-caller path is
  graceful; no auto-execute.

### U5. Brand-voice reconciliation for the live-call acknowledgment
- **Goal:** the live-call holding line uses the locked brand voice (deterministic), matching
  the SMS channel, instead of a fixed script.
- **Requirements:** R4
- **Dependencies:** U4 (shares `create-voice-turn-processor.ts`; sequence after to avoid churn)
- **Files:**
  - `packages/api/src/ai/agents/customer-calling/transitions.ts` (FSM signals the holding
    line; remove the hardcoded brand-agnostic string from the rendered path)
  - `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts` (render the holding line
    via the shared composer using tenant brand voice + owner first name available here)
  - reuse `packages/api/src/conversations/negotiation/acknowledgment.ts`
    (`composeNegotiationAcknowledgment`)
  - `packages/api/test/ai/agents/customer-calling/negotiation-guardrail.test.ts` and/or a
    voice-turn test (extend)
- **Approach:** keep the FSM pure — it stays the source of the "negotiation → hold" signal;
  move the *text* to the settings-aware layer (voice-turn processor) and compose it with the
  shared deterministic brand-voice composer (formality + owner/business resolution). No LLM.
  If brand settings cannot reach the chosen seam cleanly, fall back to documenting the
  fixed-script divergence as an accepted decision (see Open Questions) rather than forcing
  an invasive FSM change.
- **Patterns to follow:** the SMS path already calls `composeNegotiationAcknowledgment`;
  mirror it. Threshold/settings are already resolved in the voice-turn processor
  (`resolveThresholdOverride`).
- **Test scenarios:**
  - Happy path: professional vs. casual brand voice produce the corresponding holding line;
    owner first name / business name appears.
  - Invariant: the rendered line contains no price, discount, scope, or person-promise
    commitment (golden assertions, mirroring `acknowledgment.test.ts`).
- **Verification:** both channels speak a brand-voiced, concession-free holding line.

### U6. Invariant test — AI can't concede a discount/scope change without approval
- **Goal:** pin the spec's hard restriction with a regression test.
- **Requirements:** R5
- **Dependencies:** U2, U4
- **Files:**
  - `packages/api/test/proposals/guardrails/negotiation-invariant.test.ts` (new)
- **Approach:** assert (a) every negotiation emission is a capture-class `callback` that
  lands in `draft` and never `approved`/`executed`; (b) the callback payload carries the
  verbatim ask + recommendation but **no committed price/discount amount** (regex/shape
  assertion against the U2 schema); (c) a guard over the proposal-type/intent maps
  (`INTENT_TO_PROPOSAL_TYPE`, `VALID_PROPOSAL_TYPES`) that fails if any AI-reachable path
  could emit a discount/scope-expansion commitment without a human-approved proposal —
  documenting the V1 "blocks discounts entirely" invariant so a future change can't silently
  break it.
- **Patterns to follow:** existing assertions in
  `packages/api/test/ai/tasks/negotiation-task.test.ts` (status `draft`, marker reason).
- **Test scenarios:**
  - Each ask type → `callback`/`draft`/capture-class, no priced concession in payload.
  - Guard: enumerated proposal types contain no AI-auto-executable discount path.
- **Verification:** the restriction is enforced and regression-protected.

## Risks & Dependencies
- **LTV column choice (collected vs. invoiced).** Using `amount_paid_cents` (money actually
  collected) is the defensible LTV; `total_cents` would over-count unpaid work. The
  integration test pins this — and pins that the columns exist (the entity-resolver
  nonexistent-column incident is the cautionary precedent).
- **U4/U5 both edit `create-voice-turn-processor.ts`** — sequence U5 after U4.
- **FSM purity vs. brand voice (U5)** — resolved by rendering text at the processor layer;
  fallback documented.

## Open Questions (deferred to implementation)
- Exact seam in `create-voice-turn-processor.ts` where the live-call holding-line text is
  emitted vs. where the FSM signals it — confirm during U5; if brand settings can't reach
  it without an invasive change, document the fixed-script divergence as accepted instead.
- Whether to also surface `jobsCompletedCount` in the SMS render or keep it
  callback-payload-only (cosmetic; decide when wiring U4).

## Sources & Research
- Spec: `docs/stories/wave-2-strategic-stories.md:211`, `docs/PRD.md:643` (acceptance
  criteria, required tests, allowed files, non-goals).
- Existing implementation: `packages/api/src/proposals/guardrails/negotiation-guardrail.ts`,
  `packages/api/src/ai/tasks/negotiation-task.ts`,
  `packages/api/src/conversations/negotiation/acknowledgment.ts`,
  `packages/api/src/ai/agents/customer-calling/transitions.ts`.
- Data source: `packages/api/src/db/schema.ts` (invoices `:620`, payments `:675`, customers
  `:306`), `packages/api/src/reputation/match-customer.ts` (join pattern),
  `packages/api/src/invoices/invoice.ts` (statuses).
