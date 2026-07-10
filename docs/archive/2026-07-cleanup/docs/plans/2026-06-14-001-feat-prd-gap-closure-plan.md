# feat: PRD-v3 gap closure — overclaims + roadmap items

**Created:** 2026-06-14
**Depth:** Deep
**Status:** plan

## Summary
Close the feature gaps surfaced by the 2026-06-14 PRD-vs-code audit. Two
buckets: (1) the three §5 **overclaims** now corrected to 🔧 in PRD-v3
(MMS-to-quote, B2B account recognition, ACH payments) and (2) three
**PRD-acknowledged specced** trust/value items (negotiation guardrail
P2-036, per-job profit P22-005, correction loop N-009). All work lands in
`/packages` and rides the existing proposal/approval/audit/gateway rails —
no new architecture, only new capabilities on proven seams.

## Problem Frame
The PRD presents these as shippable, and the personas' "bad days" depend on
several of them (Jenna: property-manager routing, photo→quote; trust story:
correction loop + negotiation guardrail). Today: photos only attach to jobs
(no estimate), `account_type` is a binary flag with no hierarchy/routing,
ACH is unhandled (card/links only), and the negotiation guardrail, per-job
profit, and correction loop are unbuilt. This plan builds them.

## Requirements
- **R1.** Customer-sent photo(s) → AI-drafted, catalog-grounded estimate
  **proposal** (never auto-issued), with confidence markers.
- **R2.** `account_type` supports `residential | commercial | property_manager`
  with `parent_account_id` sub-account hierarchy; inbound calls route by
  account type; unverified B2B claims raise a confidence marker.
- **R3.** ACH payments settle correctly through Stripe's async lifecycle
  (`processing → succeeded/failed`) with a durable in-flight state and no
  double-credit.
- **R4.** Negotiation intents (discount/scope/refund/escalate/deadline) are
  detected on text + voice; AI refuses, acknowledges in brand voice, and
  emits an owner `negotiation_response` proposal within 30s; no discount can
  be committed without that approved proposal.
- **R5.** "Did I make money on the <job>?" returns a spoken P&L (revenue −
  labor − materials − expenses) in integer cents, degrading gracefully when
  a labor rate is unset.
- **R6.** Owner proposal edits extract structured lessons (labor rate, part
  price, banned phrase, scope reclass), apply them forward same-day, surface
  in the digest's "what I learned today," and are undoable.
- **R7.** Every new mutation honors the repo invariants (below) and ships
  with tests in the same commit.

## Key Technical Decisions
- **Extend the LLM gateway to multimodal rather than bypass it** (U1) —
  invariant: all AI calls route through the gateway. `LLMMessage.content`
  becomes `string | ContentBlock[]`. (Alt: a side-channel vision client —
  rejected; violates the gateway chokepoint + AI-run logging.)
- **MMS-to-quote is a customer-intake path, distinct from the existing
  tech-photo path** (U2). The tech `mms-ingest` flow (clock-in gated, photo
  → job attachment) stays; customer MMS from a non-tech number → resolve/
  create customer → draft-estimate proposal. (Alt: overload the tech path —
  rejected; different identity, trigger, and output.)
- **Expand `account_type` enum and migrate `b2b → commercial`** (U3), adding
  `property_manager` + `parent_account_id`. Migration defaults existing rows
  safely (`b2b`→`commercial`, null→unchanged). (Alt: keep binary + side
  table — rejected; PRD models a first-class type + hierarchy.)
- **Add a `processing` PaymentStatus and treat it as "in flight," crediting
  invoice balance on `processing`** (U5), reconciling on `succeeded`,
  reversing on `failed`. (Alt: only record on `succeeded` — rejected; leaves
  the owner blind to days-long ACH settlement, and the digest/AR misreport.)
- **Negotiation guardrail is enforced at the proposal-execution boundary,
  not just by classifier** (U6) — a runtime guard + audit test proves no
  discount/scope mutation executes without an approved `negotiation_response`.
- **Per-job labor rate is a single tenant-settings field in V1** (U7),
  `laborRateCentsPerHour`; per-tech rates deferred. Unpriced labor returns
  minutes-only with an explicit spoken caveat.
- **Correction lessons apply forward within the same UTC tenant-day and are
  reversible** (U8); extraction is conservative (clear-pattern only).

## Scope Boundaries
**In scope:** R1–R7 across the 8 units below; unit + integration + handler
tests; PRD/story acceptance criteria for P2-036, P22-005, N-009.
**Non-goals:**
- Native mobile, offline capture, QuickBooks sync, equipment registry (P24),
  truck inventory (P14), tip capture / tap-to-pay — untouched.
- Per-technician labor rates; multi-brand voice; cross-tenant learning.
- ACH micro-deposit *manual* verification UX (rely on Stripe instant verify).
- `job_parts` table (P14): U7 reads materials defensively (0 when absent).
### Deferred to follow-up work
- Onboarding web wizard + test-call surface (audit "Partial"); 1 remaining
  table without `FORCE RLS`. Tracked separately from this feature plan.

## Repository invariants touched
- **Integer cents:** U5 (ACH amounts), U7 (P&L math) — cents end-to-end.
- **UTC / tenant tz:** U7 revenue windows, U8 same-day lesson scoping use
  tenant timezone over UTC storage.
- **tenant_id + RLS:** U3, U5, U7, U8 add columns/tables — all carry
  `tenant_id` + `FORCE` RLS; integration tests pin real columns.
- **Audit on mutation:** U3 (account changes), U5 (payment processing/
  settle/fail), U6 (negotiation proposal), U8 (lesson apply/undo) emit audit.
- **LLM gateway:** U1/U2/U6 route through the gateway only (CI guard intact).
- **Zod proposals + human approval:** U2 (draft_estimate), U6
  (negotiation_response) are typed, validated, never auto-executed.
- **Catalog resolver:** U2 grounds every AI-drafted line price; uncatalogued
  caps confidence < auto-approve.
- **Entity resolver:** U2 customer resolution from inbound MMS number;
  ambiguity → clarification, not a silent guess.

## High-Level Technical Design
```
U1 gateway multimodal ─► U2 MMS-to-quote (customer photo → draft_estimate proposal)
U3 account_type+parent ─► U4 B2B inbound recognition/routing
U5 ACH async lifecycle (independent)
U6 negotiation guardrail (independent)
U7 per-job profit + voice skill (independent; needs labor-rate setting)
U8 correction loop ─► digest "what I learned today" (independent; builds on edit-delta + digest)
```

## Implementation Units

### U1. LLM gateway multimodal (image) support
- **Goal:** Allow `LLMMessage.content` to carry image blocks so vision tasks
  route through the gateway with AI-run logging intact.
- **Requirements:** R1 (prereq).
- **Dependencies:** none.
- **Files:** `packages/api/src/ai/gateway/gateway.ts` (content union +
  `validateLLMRequest`), `packages/api/src/ai/providers/openai-compatible.ts`
  (pass content array to SDK), `packages/api/src/ai/pg-ai-run.ts` +
  `ai/ai-run.ts` (input snapshot accepts non-string content; redact image
  bytes/URLs in snapshot), `packages/api/test/ai/gateway/multimodal.test.ts`.
- **Approach:** Add `ContentBlock = {type:'text',text} | {type:'image_url',
  image_url:{url}}`; `content: string | ContentBlock[]`. Provider passes
  arrays unchanged (OpenAI SDK v4 native). Validation: non-empty; image
  blocks require a URL. AI-run input snapshot stores text parts + an
  `[image]` placeholder (never raw bytes) to avoid PII-at-rest.
- **Patterns to follow:** existing `LLMRequest`/`complete()` shape; provider
  passthrough in `openai-compatible.ts`.
- **Test scenarios:**
  - Happy: request with text+image blocks validates and the provider
    receives the array.
  - Edge: string content still valid (back-compat); empty content rejected;
    image block missing URL rejected.
  - Error: provider error still writes a `failed` AiRun.
  - Snapshot: AiRun input redacts image data, keeps text.
- **Verification:** a gateway call with an image block reaches the provider
  and logs one AiRun with redacted snapshot; all existing gateway tests pass.

### U2. MMS-to-quote — customer photo → draft estimate proposal
- **Goal:** Inbound customer MMS photo(s) → catalog-grounded `draft_estimate`
  proposal with confidence markers.
- **Requirements:** R1, R7.
- **Dependencies:** U1.
- **Files:** `packages/api/src/ai/tasks/mms-estimate-task.ts` (new; mirrors
  `estimate-task.ts`), inbound customer-MMS routing in
  `packages/api/src/sms/**` (branch non-tech sender → customer intake) +
  `packages/api/src/workers/mms-ingest-worker.ts` (trigger after store),
  customer resolution via `ai/resolution` entity resolver, image presign via
  `packages/api/src/files/file-service.ts`,
  `packages/api/test/ai/tasks/mms-estimate-task.test.ts`,
  `packages/api/test/integration/mms-to-quote.int.test.ts`.
- **Approach:** Worker stores photo (existing), then for a customer-sourced
  MMS: resolve/create customer from sender number (entity resolver;
  ambiguity → voice/SMS clarification), presign image URL(s), call
  `MmsEstimateTask` (image blocks + property/customer context) → JSON line
  items → `catalog-resolver` grounding → `assessConfidence` (cap uncatalogued
  at 0.85) → supervisor hook → `createProposal('draft_estimate', …,
  sourceTrustTier:'autonomous')`. Photo-sourced drafts will rarely clear
  auto-approve; they land in the owner queue by design.
- **Patterns to follow:** `ai/tasks/estimate-task.ts` (grounding + confidence
  + proposal), `sms/tech-status/mms-ingest.ts` (media handling).
- **Test scenarios:**
  - Happy: photo + known customer → proposal with grounded line items +
    confidence markers.
  - Edge: unknown sender → new customer prefilled; ambiguous match →
    clarification, no silent guess; image URL expiry handled.
  - Error: vision parse failure → safe fallback (no proposal, owner notice),
    not a crash.
  - Integration (Docker): full inbound-MMS → proposal row persisted with
    `tenant_id`, audit emitted.
- **Verification:** sending a test MMS from a customer number yields a
  draft_estimate proposal in the owner queue, prices catalog-grounded.

### U3. B2B account model — account_type + parent_account_id
- **Goal:** First-class account types and sub-account hierarchy.
- **Requirements:** R2 (schema half).
- **Dependencies:** none.
- **Files:** `packages/api/src/db/schema.ts` (migration: widen
  `account_type` CHECK to `residential|commercial|property_manager`, migrate
  `b2b→commercial`; add `parent_account_id UUID NULL REFERENCES customers`,
  indexed; `FORCE` RLS preserved), `packages/shared/src/contracts/customer.ts`
  (enum + `parentAccountId`), `packages/api/src/customers/customer.ts` +
  `pg-customer.ts` (field mapping), `packages/shared/src/contracts/customer.test.ts`,
  `packages/api/test/integration/customer-account-type.int.test.ts`.
- **Approach:** Forward-only migration; existing `b2b` rows → `commercial`.
  `parent_account_id` nullable self-FK; guard against cycles at write time.
  Keep `property-type-detector` (vulnerability) consuming the value — update
  its `b2b` check to `commercial|property_manager`.
- **Patterns to follow:** existing `account_type` migration block in
  `schema.ts`; `pg-customer.ts` column mapping.
- **Test scenarios:**
  - Happy: create `property_manager` with sub-accounts; read back hierarchy.
  - Edge: cycle prevention (A→B→A rejected); legacy `b2b` migrates to
    `commercial`.
  - Integration (Docker): real columns/constraints exist; RLS isolates
    parent/child across tenants (pins the "mocked-pool" failure mode).
- **Verification:** migration applies cleanly on data with legacy `b2b`;
  repo round-trips type + parent.

### U4. B2B inbound recognition + routing
- **Goal:** Route inbound contacts by account type; flag unverified B2B
  claims.
- **Requirements:** R2 (routing half).
- **Dependencies:** U3.
- **Files:** account recognition in
  `packages/api/src/ai/agents/customer-calling/**` (or voice intake),
  sub-account association + priority/occupied flags, confidence marker on
  unverified claim (reuse `ai/guardrails/confidence`),
  `packages/api/test/ai/agents/b2b-recognition.test.ts`.
- **Approach:** On identification, branch: `property_manager`/`commercial` →
  load parent + sub-accounts, set priority + occupied-property context for
  triage/booking; phone-unmatched caller claiming a B2B account → confidence
  marker (no silent association). Feed account context into prompt assembly.
- **Patterns to follow:** existing caller-identity + context assembly in
  `ai/agents/customer-calling`; confidence-marker emission.
- **Test scenarios:**
  - Happy: known PM number → routed with sub-accounts + priority.
  - Edge: unknown number claiming a PM account → confidence marker, manual
    confirm path.
  - Error: missing parent → graceful (treat as standalone), logged.
- **Verification:** a PM-number call surfaces account context + priority; an
  unverified claim raises a marker rather than associating.

### U5. ACH payments — Stripe async lifecycle
- **Goal:** Correct ACH settlement with an in-flight state and no
  double-credit.
- **Requirements:** R3, R7.
- **Dependencies:** none (PaymentIntent already sets
  `automatic_payment_methods`).
- **Files:** `packages/api/src/invoices/payment.ts` (add `'processing'` to
  `PaymentStatus`; `recordPayment`/processing handling), `packages/api/src/
  payments/payment-service.ts` (state transitions + reversal guards),
  `packages/api/src/webhooks/routes.ts` (handle `payment_intent.processing`,
  `.succeeded` ACH path, `.payment_failed`/return), migration for status
  enum/`processingAt` if persisted, `packages/api/test/invoices/ach-lifecycle.test.ts`,
  `packages/api/test/integration/ach-webhook.int.test.ts`.
- **Approach:** `processing` → create payment row `status:'processing'`,
  credit `amountPaidCents` (in-flight), audit `payment.processing`.
  `succeeded` → flip to `completed` (idempotent; dedupe vs prior
  `checkout.session.completed`). `payment_failed`/return → if was
  `processing/completed`, reverse credit + reopen invoice + audit
  `payment.failed`. All keyed on Stripe `event.id` (existing webhook dedup) +
  payment provider reference.
- **Patterns to follow:** existing Stripe handlers in `webhooks/routes.ts`
  (`payment_intent.succeeded`, `.payment_failed`), `recordPayment`/
  `reversePayment` in `payment-service.ts`.
- **Test scenarios:**
  - Happy: `processing → succeeded` credits once; invoice → paid.
  - Edge: duplicate `processing`/`succeeded` events idempotent; partial ACH
    + card mix.
  - Error: `processing → failed` reverses credit, reopens invoice; late
    return after `completed` reverses with audit.
  - Integration (Docker): webhook sequence persists correct payment rows +
    invoice balance + audit trail.
- **Verification:** simulated ACH event sequence yields one net credit and a
  complete audit chain; failures reverse cleanly.

### U6. Negotiation guardrail (P2-036 / N-003)
- **Goal:** Detect negotiation intents, refuse safely, route an owner
  proposal; block discounts without approval.
- **Requirements:** R4, R7.
- **Dependencies:** none.
- **Files:** `packages/api/src/ai/intent/negotiation-classifier.ts` (new; 5
  intents), `packages/api/src/proposals/contracts/negotiation-event.ts` (new
  Zod contract), `packages/api/src/proposals/execution/**` (handler +
  discount/scope execution guard), brand-voice ack via
  `ai/brand-voice/composer.ts`, wiring on inbound text (`sms/**`) + voice
  (`ai/voice-turn/**`), `packages/api/test/ai/intent/negotiation-classifier.test.ts`,
  `packages/api/test/proposals/negotiation-guardrail.test.ts`.
- **Approach:** Classifier distinguishes negotiation from legitimate price
  Q&A (prompt rules + threshold). On detection: brand-voice ack ("Let me
  check with <owner first name>"), emit `negotiation_response` proposal
  (detected intent, verbatim message, customer LTV/recency, recommendation)
  within 30s. Add a runtime guard so any discount/scope-change execution
  requires a linked approved `negotiation_response`.
- **Patterns to follow:** `intent-classifier.ts` (intent + prompt), proposal
  contract + handler pattern, `brand-voice/composer.ts`.
- **Test scenarios:**
  - Happy: "knock 10% off?" → ack + owner proposal; no discount applied.
  - Edge: "how much is it?" → NOT flagged (legitimate Q&A).
  - Error/guard: attempt to execute a discount without approved
    `negotiation_response` is rejected (the restriction test).
  - Both channels: text and voice detection.
- **Verification:** negotiation message produces an owner proposal and no
  autonomous discount; guard test proves the restriction.

### U7. Per-job profit by voice (P22-005)
- **Goal:** Spoken per-job P&L.
- **Requirements:** R5, R7.
- **Dependencies:** none (labor-rate setting added here).
- **Files:** `packages/api/src/jobs/job-profit.ts` (new `getJobProfit`),
  labor rate on tenant settings (`packages/api/src/settings/settings.ts`
  `laborRateCentsPerHour`), `packages/api/src/ai/skills/lookup-job-profit.ts`
  (new; mirrors `lookup-revenue.ts`), `lookup_job_profit` intent in
  `ai/orchestration/intent-classifier.ts`, `GET /api/reports/job-profit/:jobId`
  route, `packages/api/test/jobs/job-profit.test.ts`,
  `packages/api/test/integration/job-profit.int.test.ts`.
- **Approach:** revenue = invoices linked to job (paid + open);
  labor = `time_entries` (entry_type='job') minutes × `laborRateCentsPerHour`
  (or minutes-only + `laborUnpriced:true`); materials = `job_parts` if present
  else 0; expenses = job-scoped `expenses`. margin = revenue − costs (cents).
  Skill formats TTS-friendly answer; unpriced labor → spoken caveat.
- **Patterns to follow:** `ai/skills/lookup-revenue.ts` (skill shape + event
  logging), `expenses/expense.ts` (`findByTenant({jobId})`), billing engine
  for totals.
- **Test scenarios:**
  - Happy: priced labor + expenses → correct margin + pct (cents-exact).
  - Edge: no labor rate → minutes-only + caveat; no expenses → 0; missing
    `job_parts` table → materials 0.
  - Integration (Docker): real `time_entries`/`expenses`/invoice columns
    aggregate correctly per job + tenant isolation.
- **Verification:** voice query returns a correct, cents-exact P&L; unpriced
  case degrades with caveat.

### U8. Correction loop (N-009 / P2-038)
- **Goal:** Owner edits → structured lessons → forward-applied + digest
  "what I learned today" + undo.
- **Requirements:** R6, R7.
- **Dependencies:** digest (exists), edit-delta infra (exists); benefits from
  U6/U7 only loosely.
- **Files:** `packages/api/src/learning/corrections/**` (extractor + repo +
  apply/undo), `correction_lessons` migration in `db/schema.ts`, brand-voice
  negative-prompt update in `ai/prompts/**`, digest section in
  `packages/api/src/digest/digest-builder.ts` + `digest-types.ts` +
  `digest-renderer.ts`, `packages/api/test/learning/correction-extract.test.ts`,
  `packages/api/test/integration/correction-loop.int.test.ts`.
- **Approach:** On proposal edit, compute deltas (reuse
  `ai/evaluation/invoice-edit-delta.ts` / `diff-analysis.ts`); extract four
  lesson types conservatively (clear-pattern only). Persist to
  `correction_lessons` (tenant_id + RLS + audit). Apply forward within the
  same tenant-day: labor rate → tenant default; part price → tenant SKU
  price; banned phrase → brand-voice negative prompt; scope reclass →
  template weight. Add digest "what I learned today" (one aggregated line per
  lesson). Undo reverses lesson + cascaded config (audited).
- **Patterns to follow:** `ai/evaluation/invoice-edit-delta.ts` (typed
  deltas), `digest/digest-builder.ts` (section composition), audit emission.
- **Test scenarios:**
  - Happy: labor-rate edit → lesson persisted, next same-day draft uses new
    rate, digest shows the line.
  - Edge: ambiguous edit → no lesson (conservative); two edits same field →
    last-writer with audit; lesson after digest already ran → next-day
    surfacing.
  - Error/undo: undo reverses lesson + config, audited.
  - Integration (Docker): `correction_lessons` columns/RLS real; forward
    application observed on a second draft.
- **Verification:** an owner labor-rate edit changes the next same-day
  estimate and appears in the digest; undo reverts it.

## Risks & Dependencies
- **U1 multimodal + AI-run snapshot PII:** never persist raw image bytes;
  redact in snapshot (pairs with the existing transcript-KMS concern).
- **U2 image URL TTL:** Twilio/S3 URLs are short-lived; presign at task time.
- **U5 ACH accounting:** crediting on `processing` trades certainty for
  visibility; reversal paths must be airtight (covered by tests) — this is
  the highest-risk unit.
- **U6 false positives:** over-flagging normal price questions causes owner
  alert fatigue; tune classifier with the edge test as a gate.
- **Sequencing:** U1→U2 and U3→U4 are hard ordered; U5/U6/U7/U8 parallelize.

## Open Questions (deferred to implementation)
- Exact `ContentBlock` field names to match the installed OpenAI SDK version.
- Whether `processingAt` is a column or derived from the payment row status
  (settle during U5 once the payment schema is in front of you).
- Final correction-lesson "clear pattern" thresholds (e.g., rate repeated in
  ≥2 line items) — calibrate against real edit deltas in U8.
- Whether per-tenant labor rate needs a backfill default or stays null-=-
  unpriced (U7).

## Sources & Research
- 2026-06-14 PRD-vs-code audit (this session); `docs/decisions.md` D-012.
- Story specs: `docs/stories/wave-2-strategic-stories.md` (N-003, N-009),
  `docs/stories/phase-22-gap-stories.md` (P22-005); `docs/PRD-v3.md` §5/§6.
- Code seams verified: gateway text-only (`ai/gateway/gateway.ts`),
  `estimate-task.ts`, `mms-ingest`, Stripe webhooks (`webhooks/routes.ts`),
  `payment-service.ts`, `digest/*`, `ai/skills/lookup-revenue.ts`,
  `intent-classifier.ts`, `brand-voice/composer.ts`, edit-delta/diff infra.
