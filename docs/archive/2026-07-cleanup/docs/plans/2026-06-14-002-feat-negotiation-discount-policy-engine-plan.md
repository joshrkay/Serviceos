# feat: Negotiation discount-policy + catalog-grounded floor engine (V2)

**Created:** 2026-06-14
**Depth:** Deep
**Status:** plan (deferred follow-on — do NOT start until the V1 closure ships)
**Story:** V2 evolution of P2-036 / N-003 — a NEW story that deliberately lifts the V1
non-goals ("automatic price floors (V2)", "per-tenant negotiation playbooks (V2)").
**Depends on:** `docs/plans/2026-06-14-001-feat-negotiation-guardrail-v1-closure-plan.md`

> **Scope note:** This is intentionally *not* "finishing P2-036." P2-036's V1 spec says
> "V1 just blocks discounts entirely" and defers price-floor configuration + playbooks to
> V2. Building this lifts those non-goals as a separate, reviewable story. Record a
> decision (`docs/decisions.md`, D-series) before starting so the scope change is explicit.

## Summary
Add policy-bounded discount handling on top of the V1 guardrail: a per-tenant discount
policy, a catalog-grounded price floor, and a pure decision engine that classifies each
ask into `ALLOW` / `NEEDS_APPROVAL` / `CLARIFY` / `REJECT_WITH_COUNTER`. The guardrail
keeps the "AI never silently discounts" posture — even `ALLOW` is confidence-capped to a
human tap and routed over the existing approval transport; the engine only changes whether
a within-policy ask may be *proposed* without escalating to a full owner callback.

## Problem Frame
After V1, every haggling ask routes to an owner callback. For tenants who *want* bounded
self-service ("you may auto-propose up to X% off, never below the floor"), that is
all-or-nothing. V2 lets a tenant opt into a discount ceiling + floor so routine, in-policy
asks become a one-tap proposal instead of a manual callback — without ever letting the AI
sell below margin or concede silently.

## Requirements
- R1. Per-tenant discount policy: max discount (bps), optional absolute floor (cents),
  "never below catalog" flag; safe **fail-closed** defaults (unconfigured = behaves exactly
  like V1).
- R2. A pure decision engine maps a resolved ask to `ALLOW`/`NEEDS_APPROVAL`/`CLARIFY`/
  `REJECT_WITH_COUNTER`.
- R3. The price floor is catalog-grounded: `Math.max(list-minus-cap, optional margin floor,
  absolute floor)`; ungrounded (uncatalogued/ambiguous) scope forces `NEEDS_APPROVAL`.
- R4. A deterministic, conservative target-price parser; any uncertainty → `CLARIFY`
  (never a guess) via `voice_clarification`.
- R5. `ALLOW` is **confidence-capped** (`_meta.overallConfidence: 'low'`) so it never
  auto-executes; member-pricing never stacks below the floor.
- R6. Every decision branch emits an audit event; reuses the existing SMS transport,
  approval gate, and idempotency — no new executor.

## Key Technical Decisions
- **Pure standalone evaluator** (`evaluateDiscountAsk(input): DiscountDecision`), called by
  the handlers — not embedded in `decideInitialStatus` (keep the universal status gate
  money-agnostic) nor inlined in a handler (the money core needs exhaustive zero-mock unit
  tests and must run identically across three surfaces). Mirrors `catalog-resolver.ts` /
  `auto-approve.ts` / `member-pricing.ts` (pure logic + thin async caller).
- **Policy on `tenant_settings` columns, deposit-rules style** (discriminator + correlated
  numeric columns + `CHECK`s), not a new table (1:1 cardinality) and not the JSONB grab-bag
  (lose DB-level money guards).
- **Floor = stricter-of-both; cost term optional.** Ships on list-price-minus-cap (data
  exists today). A margin floor lights up later behind an optional `CatalogItem.unitCostCents`
  (confirmed absent today) + `min_margin_bps`.
- **All percentage math via `applyBps`** (`packages/api/src/shared/billing-engine.ts`) — the
  mandated single rounding home; never `* 0.9`.
- **Fail-closed default `maxDiscountBps: 0`** — V2 is behavior-identical to V1 until a
  tenant opts in (clean, reviewable rollout).

## Scope Boundaries
**In scope:** discount policy data plane; pure evaluator; target-price parser; wiring the
evaluator into the V1 handlers/FSM; `ALLOW` confidence-capped proposal path; settings UI;
audit coverage.
**Non-goals:** consumer financing; multi-currency; cost-basis data capture UX (only the
optional column + a later capture flow); changing the V1 deflect posture for non-discount
asks (refund/threat/escalation stay callback-only).

## Repository invariants touched
Integer cents + bps throughout (`applyBps`); RLS on the new settings columns + policy read;
audit event per evaluator branch (incl. `REJECT`/`CLARIFY`); proposals stay Zod-validated
and human-approved (even `ALLOW`); catalog-grounding enforced before any `ALLOW`; ambiguity
→ `voice_clarification`.

## Implementation Units
(Carried from the validated strategy; refine when this story is activated.)

- **U1. Discount policy data plane** — `discount_max_bps` / `discount_floor_cents` /
  `discount_never_below_catalog` columns on `tenant_settings` (inline `ALTER TABLE` +
  `CHECK`, deposit-rules style); `TenantSettings`/`UpdateSettingsInput`/validation;
  `resolveDiscountPolicy(settings)` fail-closed defaults. Files: `packages/api/src/db/schema.ts`,
  `packages/api/src/settings/settings.ts`, the Pg settings repo, settings route.
  **Tests:** unit (resolver/validation/CHECK ranges) + **Docker-gated** migration/round-trip.
- **U2. Typed contracts** — `packages/shared/src/contracts/negotiation-event.ts` extended
  with the `DiscountDecision` discriminated union (all-cents); add
  `'ambiguous_discount_target'` to the `voice_clarification` reason enum in
  `packages/api/src/proposals/contracts.ts`. **Tests:** unit (accept/reject, exhaustiveness).
- **U3. Pure decision evaluator** — `packages/api/src/proposals/guardrails/discount-evaluator.ts`:
  stricter-of-both floor via `applyBps`, member-stacking defense (member bps is an input,
  floor measured against the member-adjusted base), `Math.max(0, …)` guards, `catalogGrounded`
  forces `NEEDS_APPROVAL`. **Tests:** unit only — exhaustive boundary table (at-floor,
  one-cent-below, member-stack, zero/negative, 100% policy, ungrounded, every branch).
- **U4. Deterministic target-price parser** — conservative spoken/text → cents/bps |
  ambiguous; in `packages/api/src/conversations/negotiation/`. **Tests:** unit (golden
  phrasings: "knock off", "match their quote", "$200 not $250"; false positives like "how
  much?").
- **U5. Wire evaluator into handlers + extend the callback builder** — extend
  `buildNegotiationCallbackContent` with decision/counter/floor; `NegotiationGuardrailTaskHandler`
  + `inbound-negotiation-handler` call parser → fetch catalog/settings/agreements/quote →
  `evaluateDiscountAsk` → branch (callback / `voice_clarification` / capped `ALLOW` proposal);
  audit each branch; reuse idempotency. **Tests:** unit (branch coverage) + **Docker-gated
  integration** (catalog-resolved quote → ask → owner SMS render → no auto-execute, RLS).
- **U6. Live-call FSM branch** — extend `customer-calling/transitions.ts` +
  `create-voice-turn-processor.ts` so a mid-call discount ask runs the evaluator and speaks
  the right scripted/clarification line, idempotently. **Tests:** unit (deflect/clarify/
  no-escalate/idempotent/terminal no-op).
- **U7. Settings UI + audit-coverage closeout** — surface the policy fields in
  `packages/web/src/components/settings/`; assert every evaluator branch emits its event.
  **Tests:** unit/component.

## Risks & Dependencies
- Depends on the V1 contract/payload + customer-context wiring landing first.
- Margin floor blocked on cost data (`CatalogItem.unitCostCents` absent) — ships on the
  list-cap floor; margin term is additive later.
- Highest-risk unit is U3 (money correctness) — heaviest unit coverage, zero mocks.

## Sources & Research
- Validated implementation strategy (this session's Plan agent) — pure-evaluator seam,
  deposit-rules policy precedent, stricter-of-both floor, `applyBps` mandate, member-stacking
  defense, fail-closed defaults, `ALLOW` confidence cap.
- `packages/api/src/proposals/auto-approve.ts` (`confidenceMetaBlocksAutoApprove`),
  `packages/api/src/shared/billing-engine.ts` (`applyBps`),
  `packages/api/src/agreements/member-pricing.ts` (`resolveMemberDiscountBps`),
  `packages/api/src/ai/resolution/catalog-resolver.ts` (grounding).
