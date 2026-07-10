# feat: MMS image→estimate — hardening & §6.4-B closure

**Created:** 2026-06-20
**Depth:** Standard
**Status:** plan

## Summary
The MMS image→estimate pipeline (PRD-v3 §6.4 Workflow B) is **already built and wired
end-to-end** — inbound photo → vision analysis → catalog-grounded `draft_estimate` proposal →
approval flow, with the worker wired at bootstrap (`app.ts:3363`, `customerIntake` at `:3409`).
This plan closes the **verified gaps**, not a missing feature: pin vision routing, add §6.4-B
severity markers, surface the draft to the owner on success, prove the real vision path, render
the photo in the web card, and bound inbound cost/abuse.

## Problem Frame
PRD §5/§6.4 list MMS-to-quote as "🔧 Partial — image→estimate not built," but the code
(`ai/tasks/mms-estimate-task.ts`, `sms/customer-mms/customer-mms-intake.ts`,
`workers/mms-ingest-worker.ts`, gateway vision in `ai/gateway/*` + `config/ai-routing.ts`) shows
it is substantially built and the existing integration/unit tests pass — but they **mock the
gateway**, so the real vision call is unproven, and three §6.4-B/production gaps remain. Affects:
plumbing customers texting photos, owners who need the draft to reach them, and the trust/quality
of the differentiator.

## Requirements
- R1. `mms_estimate` reliably routes to a vision-capable model regardless of env tier overrides.
- R2. Drafts carry §6.4-B **severity** markers (alongside the existing confidence flags).
- R3. A **successful** MMS draft surfaces to the owner via the SMS approval transport.
- R4. The **real** vision path (image→model→parseable line items) is proven, not just mocked.
- R5. The web draft card renders the **source photo** + severity/confidence/pricing-source markers, mobile-safe.
- R6. Inbound MMS from unknown senders is cost/abuse-bounded.

## Key Technical Decisions
- **Pin `mms_estimate` → `complex` tier.** Today it's unmapped and falls through to `standard`,
  which defaults to `claude-sonnet-4-6` (vision-capable) — so it works, but an `AI_STANDARD_MODEL`
  override to a text model would trip the gateway vision failfast. Pinning removes that footgun.
  (Alt: new dedicated vision tier — rejected; `complex` is already Sonnet/vision.)
- **Reuse the existing triage severity vocabulary** (inbound-voice triage, `ai/skills/triage-rules.schema.ts`)
  rather than invent one — voice/MMS consistency.
- **Surface via the existing SMS approval transport (P2-034)**, not a bespoke MMS SMS — one
  approval channel. First verify whether new `pending` proposals already push globally.
- **Real-vision proof = gated smoke test** mirroring `.github/workflows/voice-smoke-real.yml` —
  keep the default CI lane keyless.
- **Reuse `shared/rate-limit/phone-rate-limit.ts`** for inbound gating — no new infra.

## Scope Boundaries
**In scope:** the 6 units below, canonical `/packages` only.
**Non-goals:** customer-facing auto-send (always proposal-gated — D-004); good/better/best tiering
for photo quotes; video/multi-image beyond current support; re-building the gateway vision
foundation (already built).
### Deferred to follow-up
- Reconcile PRD §5/§6.4 status "Partial/not built" → built (doc change, via the D-0xx protocol).
- Mark prior plans `2026-06-14-001/002` executed (they describe code that already shipped).
- Priority split: **U1–U4 are production-safety (do first); U5–U6 are completeness/guardrails.**

## Repository invariants touched
- **Integer cents** — estimate lines use `unitPrice` (cents) per
  `docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md`; grounding via
  `applyCatalogPricing(..., 'unitPrice')`.
- **RLS/tenant_id + audit** — proposals/files tenant-scoped; `customer_mms.estimate_drafted`
  audit already emitted; new owner-notification stays tenant-scoped.
- **LLM gateway only (D-005)** — vision stays in the gateway; no provider SDK outside it.
- **Zod proposals + human approval (D-004)** — `draft_estimate` stays non-auto-approved
  (uncatalogued cap 0.85 < 0.9).
- **Catalog resolver** — reused unchanged.

## Implementation Units

### U1. Pin `mms_estimate` to a vision-capable tier
- **Goal:** deterministic vision routing.
- **Requirements:** R1. **Dependencies:** none.
- **Files:** `packages/api/src/config/ai-routing.ts`; test `packages/api/test/config/ai-routing.test.ts`.
- **Approach:** add `'mms_estimate': 'complex'` to `taskTierMapping`; assert the resolved model
  passes `isVisionCapableModel`.
- **Patterns:** existing `'draft_estimate': 'complex'`.
- **Test scenarios:** resolveModelForTask('mms_estimate') → complex; `isVisionCapableModel(resolved)===true`;
  guard: with `AI_STANDARD_MODEL` set to a text model, `mms_estimate` still resolves vision-capable.
- **Verification:** routing unit test green.

### U2. Severity markers in the MMS vision draft
- **Goal:** §6.4-B severity flags on photo drafts.
- **Requirements:** R2. **Dependencies:** none.
- **Files:** `packages/api/src/ai/tasks/mms-estimate-task.ts` (system prompt + parse + payload
  `_meta`); test `packages/api/test/ai/tasks/mms-estimate-task.test.ts`.
- **Approach:** extend the system prompt to emit a `severity` field (reuse the triage enum —
  confirm in `ai/skills/triage-rules.schema.ts`); parse + stamp into payload `_meta` /
  `confidenceFactors`; informational/owner-facing only (does **not** gate auto-approve).
- **Patterns:** existing confidence-marker stamping in the same file.
- **Test scenarios:** happy (StubProvider returns severity → surfaces in payload); missing severity
  → graceful default (no crash); high severity (active leak) flagged.
- **Verification:** unit test asserts severity in proposal payload.

### U3. Surface successful MMS draft to the owner
- **Goal:** owner learns a photo-quote is ready (not only on failure).
- **Requirements:** R3. **Dependencies:** none.
- **Files:** `packages/api/src/sms/customer-mms/customer-mms-intake.ts`; the SMS approval transport
  module (P2-034); test `packages/api/test/integration/mms-to-quote.int.test.ts` (extend).
- **Approach:** first verify whether new `pending` proposals already push to the owner via the
  global SMS approval transport. If yes → document + drop this unit. If per-path → on success,
  enqueue an owner notice via that transport (not a bespoke SMS), tenant-scoped, idempotent on
  proposalId.
- **Patterns:** existing `notifyOwner` (failure path) + the SMS approval transport.
- **Test scenarios:** success draft → owner notice once; idempotent on retry; tenant-scoped.
- **Verification:** integration test asserts the owner surface on success.

### U4. Real-vision smoke test (gated)
- **Goal:** prove image→vision→parseable estimate against a real model (existing tests mock the gateway).
- **Requirements:** R4. **Dependencies:** U1 (routing); U2 (severity, soft).
- **Files:** `packages/api/test/smoke/mms-vision-real.test.ts` (new, gated); fixture
  `packages/api/test/fixtures/plumbing-leak.jpg`; `.github/workflows/mms-vision-smoke.yml`
  (mirror `voice-smoke-real.yml`).
- **Approach:** gate on an env/secret (skip when absent); send a real fixture photo through the
  real gateway+vision model; assert valid JSON + ≥1 line item (+ severity if U2). Kept out of the
  default unit/integration lane.
- **Patterns:** `voice-smoke-real.yml` + its test.
- **Test scenarios:** real photo → ≥1 line item; non-plumbing/garbled image → safe `parse_failed`.
- **Verification:** gated smoke lane passes with a live key.

### U5. Web — render photo + severity/confidence on the MMS draft card
- **Goal:** owner sees the photo + markers when reviewing.
- **Requirements:** R5. **Dependencies:** U2.
- **Files:** `packages/web/src/components/shared/AIProposalCard.tsx` (+ estimate review surface);
  jsdom class-contract test alongside it; `e2e/estimate-approval-mobile.spec.ts` (extend/mirror).
- **Approach:** when `sourceContext.source === 'customer_mms'`, render the source photo thumbnail
  (file/presigned URL) + severity badge + pricing-source/confidence markers. Mobile: ≥44px
  (`min-h-11`), no 320px overflow.
- **Patterns:** existing `AIProposalCard` rendering; `e2e/estimate-approval-mobile.spec.ts`.
- **Test scenarios:** MMS-source card renders photo + severity; non-MMS draft unchanged; jsdom
  ≥44px class-contract; Playwright 320/390px no-overflow.
- **Verification:** jsdom + Playwright viewport tests green.

### U6. Cost/abuse gating on inbound MMS
- **Goal:** bound vision-LLM cost + unknown-sender customer auto-creation.
- **Requirements:** R6. **Dependencies:** none.
- **Files:** `packages/api/src/sms/customer-mms/customer-mms-intake.ts` (or the worker); reuse
  `packages/api/src/shared/rate-limit/phone-rate-limit.ts`; Docker-gated integration test in
  `packages/api/test/integration/`.
- **Approach:** before the vision call, apply a per-tenant + per-sender-phone sliding-window cap
  (existing limiter); over-limit → skip vision (optional polite SMS), no proposal, no auto-create;
  keep messageSid idempotency.
- **Patterns:** `phone-rate-limit.ts` usage on other SMS/voice paths.
- **Test scenarios:** within limit → draft; over limit → skipped (no proposal/customer);
  per-tenant isolation. (DB-touching → Docker-gated integration test, real columns.)
- **Verification:** integration test asserts the cap.

## Risks & Dependencies
- Mocked tests give false confidence → U4 mitigates.
- U3 may be a no-op if the global transport already covers new proposals → verify first (avoid double-notify).
- Severity vocabulary must match the voice triage enum.
- Every unknown-sender photo is a Sonnet vision call → U6 is the cost guard.

## Open Questions (deferred to implementation)
- Is the SMS approval transport global (any new `pending` proposal → owner SMS) or per-path? (U3)
- Exact severity enum in `ai/skills/triage-rules.schema.ts`? (U2)
- Does `AIProposalCard` already resolve file/attachment URLs, or is an owner-side presign endpoint needed? (U5)

## Sources & Research
- Prior plans: `docs/plans/2026-06-14-002-feat-gateway-multimodal-vision-plan.md` (vision
  foundation — code shows it shipped despite "plan" status), `docs/plans/2026-06-14-001-feat-prd-gap-closure-roadmap-plan.md` (E1 roadmap).
- Decisions: D-003 (cents), D-004 (proposal-first), D-005 (gateway), D-006 (shared line-item).
- Learning: `docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md`.
- Key code: `ai/tasks/mms-estimate-task.ts`, `sms/customer-mms/customer-mms-intake.ts`,
  `workers/mms-ingest-worker.ts` (+ `app.ts:3363/3409`), `ai/gateway/gateway.ts`,
  `config/ai-routing.ts`, `ai/resolution/catalog-resolver.ts`,
  tests `test/integration/mms-to-quote.int.test.ts`, `test/ai/tasks/mms-estimate-task.test.ts`.
