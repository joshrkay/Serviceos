# Design — Supervisor Agent Review Pass (N-004 / P2-037)

**Status:** design only (no product code)
**Story:** N-004 / P2-037 — Supervisor Agent Review Pass — `docs/PRD.md:671`
**AMEND:** P2-007 hand-off requirement — `docs/PRD.md:918`
**Author track:** design thread (Fable 5)
**Effort:** **L** (largest of the three Wave-2 supervisor-adjacent stories)
**Recommended rollout:** behind a **new, default-OFF** flag, **shadow mode first** (log reviews, no hold/alert) until the false-positive rate is validated on real traffic.

---

## 0. TL;DR

Insert a **second-pass, cheaper-tier LLM + deterministic classifier** between proposal
creation and owner dispatch. It runs the four PRD checks (missed urgency, pricing anomaly
>20% vs rolling average, brand-voice drift, account-routing residential↔B2B), turns every
finding into an **N-002 confidence marker**, logs each review to `ai_runs` + a new
`supervisor_reviews` table, and on a **critical** flag **holds** the proposal and fires a
**direct owner alert** (high-priority `escalation` notification) instead of the normal queue.

The hook point is the **outbound-dispatch chokepoint** `routeUnsupervisedProposal`
(`packages/api/src/proposals/auto-approve.ts:502`) — the exact "before SMS dispatch" moment
AMEND P2-007 names — gated from the orchestrated task path right after `createProposal`
persists.

> **Important scoping finding.** A module named "Supervisor Agent v1" **already ships**
> (`packages/api/src/proposals/supervisor/*`, `workers/supervisor-review-worker.ts`,
> migration `167_create_supervisor_policies`). It is a **different feature** — a deterministic
> *budget/volume policy* gate plus a *generic advisory annotator* — **not** the N-004 four-check
> reviewer. N-004 reuses its plumbing (marker writer, lightweight-tier routing, opt-out-flag
> pattern, sweep-worker skeleton) but adds the checks, the pre-dispatch gate, the hold/alert,
> the `supervisor_reviews` table, and `ai_runs` logging. Details in §1.

---

## 1. Current state vs N-004 gap (file:line)

### 1.1 What already exists (reusable)

| Concern | Where | What it does | Reuse for N-004 |
|---|---|---|---|
| **createProposal seam** | `packages/api/src/proposals/proposal.ts:669` (`createProposal`), consults `getSupervisorCreationHook()` at `:685` | Module-level sync hook installed once from `app.ts`; null-safe (byte-identical when unconfigured). | The **sync** seam is wrong for N-004 (LLM can't run synchronously) — but the install/opt-out pattern is the model to copy. |
| **Policy engine (deterministic)** | `packages/api/src/proposals/supervisor/policy.ts` (`evaluateSupervisorPolicy`, `capInitialStatus`) | Budget caps + blocked-type rules; can only **downgrade** (`allow`→`force_review`→`block`). | Adjacent, **not** the four checks. N-004 sits alongside it, not inside it. |
| **Policy service (async cache)** | `packages/api/src/proposals/supervisor/service.ts` (`SupervisorPolicyService`) | Per-tenant snapshot cache, fail-open. | Pattern for the per-tenant rolling-average/brand-voice snapshot cache (§3.2). |
| **Marker writer** | `packages/api/src/proposals/supervisor/marker.ts` (`payloadWithSupervisorMarker`, `SUPERVISOR_MARKER_PATH='_supervisor'`) | Appends `_meta.markers[]` entries with `{path, reason}`, preserving the confidence-meta envelope. | **Directly reused** to turn flags into N-002 markers (§3.6). |
| **Advisory annotator worker** | `packages/api/src/workers/supervisor-review-worker.ts` | 1-min cross-tenant sweep; one lightweight-tier gateway call per recent `ready_for_review` proposal → free-form `{riskSummary, flags}` into `_meta.supervisorAnnotation`. **Never** changes status, **never** holds, **no** `ai_runs` row, **not** pre-dispatch. | Skeleton for the shadow/batch path; N-004 replaces the generic prompt with the four structured checks and adds the gate. |
| **Cheaper-tier routing** | `packages/api/src/config/ai-routing.ts` — `supervisor_annotate` in `TASK_TYPES`, mapped to `lightweight` in `DEFAULT_TASK_TIER_MAPPING`; `lightweight` = `AI_LIGHTWEIGHT_MODEL` default `claude-haiku-4-5-20251001` | Existing proof that a supervisor task can be pinned to Tier-1. | Add `supervisor_review` the same way (§5). |
| **Opt-out flag** | `packages/api/src/proposals/supervisor/hook.ts:33` (`SUPERVISOR_DISABLED_FLAG='supervisor_agent_disabled'`) | Default-ON via inverted opt-out flag for the **policy** engine. | Copy the mechanism but use a **separate** key defaulting the N-004 reviewer **OFF** (§7). |
| **Outbound dispatch chokepoint** | `packages/api/src/proposals/auto-approve.ts:502` (`routeUnsupervisedProposal`), called from `packages/api/src/ai/tasks/proposal-approval-task.ts:403` | `queue_and_sms` mints the one-tap link, sends the approval SMS, pushes devices. | **The AMEND P2-007 "before SMS dispatch" gate** — supervisor runs before this (§2). |
| **Direct owner alert** | `packages/api/src/proposals/auto-approve.ts:528` (`notifyOwner(tenantId,'escalation',…)`); type set in `packages/shared/src/contracts/notification.ts:29` (`'escalation'`) + `:58` `HIGH_PRIORITY_NOTIFICATION_TYPES` | High-priority push = foreground alert + sound. | **Reused** for the critical-flag direct alert (§2.3). |
| **ai_runs logging** | `packages/api/src/ai/ai-run.ts:64` (`createAiRun`), `:79` `startAiRun`, `:83`/`:99` complete/fail; table migration `008_create_ai_runs` (`schema.ts:174`) | Standard AI-run ledger with input/output snapshots + RLS. | Each supervisor check logs one `ai_runs` row (§4.2). |
| **N-002 marker schema** | `packages/api/src/proposals/contracts.ts:64` (`proposalConfidenceMetaSchema`): `markers: [{path:min(1), reason:min(1)}]`, `severity` on `TIER_KEYS`, `overallConfidence` required | The typed marker envelope validated on every edit. | Flags land here; keeps proposals editable. |

### 1.2 What is missing (the N-004 build)

1. **The four checks.** The annotator emits generic `{riskSummary, flags}` — no missed-urgency,
   no >20% pricing rule, no brand-voice-drift, no account-routing logic. (`supervisor-review-worker.ts:106` `annotationPrompt`.)
2. **`supervisor_reviews` table.** Confirmed absent (`grep supervisor_reviews packages/api` → no match). PRD data catalog lists it as owed (`docs/PRD.md:1130`).
3. **`ai_runs` logging of reviews.** The annotator calls the gateway but writes **no** `ai_runs` row. Acceptance criterion "all reviews logged to AI runs" (`docs/PRD.md:702`) is unmet.
4. **Pre-dispatch hand-off.** The annotator is a decoupled 1-min sweep — it can annotate a proposal **after** its approval SMS already went out. AMEND P2-007 requires the review **before** dispatch (`docs/PRD.md:920`).
5. **Critical-flag HOLD + direct alert.** The annotator is advisory-only ("NEVER a status change" — `supervisor-review-worker.ts:80`). No hold, no `escalation` alert.
6. **Rolling averages for pricing.** No per-tenant "similar jobs" baseline table or query exists (§3.3).
7. **60s P95 budget.** No latency instrumentation/timeout on the review path.
8. **"Different model than primary task" guard.** No assertion that the supervisor model ≠ the drafting model (§5).

---

## 2. Architecture — where the hook inserts and how it holds

### 2.1 The chokepoint

Every orchestrated task that produces a proposal ends the same way: build via
`createProposal`, persist, then **dispatch** to the owner. Dispatch is
`routeUnsupervisedProposal` (`auto-approve.ts:502`) for the active-notify path
(`queue_and_sms`), reached from `proposal-approval-task.ts:403`. This is the single
"before SMS dispatch" seam AMEND P2-007 targets.

N-004 inserts a **gate immediately before** that call:

```
orchestrated task (estimate/invoice/booking)
  → createProposal (proposal.ts:669)         [existing sync policy hook still runs here]
  → proposalRepo.create(...)                  [persist ready_for_review / approved]
  → ★ supervisorReview(proposal)              [NEW — async, cheaper tier, ≤60s budget]
        ├─ pass/flag → attach markers → proceed
        └─ CRITICAL → HOLD (do not dispatch) + notifyOwner('escalation')
  → routeUnsupervisedProposal(...)            [existing dispatch — SKIPPED on hold]
```

Skip rule (AMEND P2-007): the gate is bypassed only when the proposal is tagged
`tier=internal` (a `sourceContext.tier === 'internal'` marker on the proposal) — mirror the
existing tier check the orchestration layer already threads.

### 2.2 Running async within the 60s budget

The review is **awaited inline** in the orchestration hand-off — it is not the 1-min sweep.
Rationale: AMEND P2-007 says "hand off … before SMS dispatch," which is a happens-before
ordering, and the checks are cheap (one lightweight-tier call + three deterministic DB/rule
checks — target P50 ≈ 2–4s, well inside the 60s P95 budget). Design points:

- Wrap `supervisorReview` in a **hard timeout = `SUPERVISOR_REVIEW_BUDGET_MS` (60_000)**.
- **Fail-open on timeout/error**: dispatch proceeds, and a `supervisor_reviews` row is written
  with `verdict='timeout'` (never blocks the money loop — same discipline as the policy
  service's fail-open, `service.ts` header). A held proposal is the *only* path that suppresses
  dispatch; every other outcome (pass, flag, timeout, error) dispatches normally.
- The three deterministic checks (pricing, account-routing, banned-phrase half of brand-voice)
  run **first and concurrently**; the LLM call (missed-urgency + register drift) runs once with
  the deterministic results as context, so a deterministic critical (e.g. account-routing
  mismatch) can short-circuit and skip the LLM entirely.
- Install via the same module-level pattern as `configureSupervisorCreationHook`
  (`hook.ts`): `configureSupervisorReviewGate(gate)` from `app.ts`; unconfigured → no-op
  (dispatch byte-identical to today), so every test/dev path that doesn't opt in is unaffected.

**Shadow-mode variant (default, §7):** when the flag is in shadow, `supervisorReview`
computes + logs everything (markers, `supervisor_reviews`, `ai_runs`) but **never holds and
never alerts** — dispatch always proceeds. This can reuse the annotator worker as the batch
carrier so shadow mode adds zero latency to the dispatch path.

### 2.3 Critical flag → hold + direct alert (vs normal queue)

- **Normal queue** = proposal sits in `ready_for_review`; owner is nudged via
  `routeUnsupervisedProposal` (`proposal_needs_approval` push + optional SMS).
- **Hold** = proposal is moved/kept in a non-dispatchable state and dispatch is skipped:
  - Reuse the existing downgrade machinery — a critical review forces the proposal to
    `draft` (the same terminal the policy engine's `block` verdict uses, `policy.ts`
    `capInitialStatus`), so no one-tap link is minted and no approval SMS goes out.
  - Fire `notifyOwner(tenantId, 'escalation', { reason, proposalId, screen:'/proposals/:id' })`
    — `escalation` is in `HIGH_PRIORITY_NOTIFICATION_TYPES`
    (`packages/shared/src/contracts/notification.ts:58`), so it interrupts with a foreground
    alert + sound rather than a badge. Best-effort/failure-isolated like the existing
    escalation push (`auto-approve.ts:528`).
  - PRD acceptance: "critical-flag holds reach owner via direct alert (not just queued)"
    (`docs/PRD.md:701`) and, from the negotiation story, "within 30 seconds of detection"
    (`docs/PRD.md:663`) — the inline call satisfies both.
- Emit an audit event (`supervisor.review_held`) alongside the existing
  `SUPERVISOR_BLOCKED_EVENT` / `SUPERVISOR_FORCED_REVIEW_EVENT` vocabulary (`service.ts`).

---

## 3. The four checks — detection logic

Each check returns `{ id, verdict: 'pass'|'flag'|'critical', reason, evidence }`. `flag` →
marker only; `critical` → marker + hold + alert. LLM vs deterministic split below.

### 3.1 Missed urgency — **LLM (lightweight) + deterministic pre-filter**

- **Deterministic pre-filter:** the payload already carries triage context —
  `_meta.severity` on the `TIER_KEYS` urgency scale (`contracts.ts:64`), set by voice
  triage / MMS vision. If `severity ∈ {emergency, urgent}` **and** the booking's scheduled
  appointment start is > N hours out (tenant-configurable, default same-day), raise a flag
  before touching the LLM.
- **LLM confirmation (`supervisor_review` task):** pass the operator-facing summary, the
  urgency tier, scheduled time, and the caller-signal features already extracted
  (vocabulary/age/weather/medical mentions — the emergency-detector features in
  `ai/agents/customer-calling/emergency-detector.ts`). The model returns
  `{ missedUrgency: bool, medicalMentionUnescalated: bool, rationale }`.
- **Critical when** `medicalMentionUnescalated === true` (PRD's named critical example,
  `docs/PRD.md:698`) — the flat-voice-elder / medical-mention case. Everything else is a flag.
- **PII discipline:** send derived features + summary, never raw transcript (mirror the
  annotator's discipline, `supervisor-review-worker.ts:20`).

### 3.2 Pricing anomaly >20% — **deterministic**

- Compute the proposal's headline total via `payloadHeadlineCents`
  (`proposals/payload-money.ts`, already used by the annotator and policy hook).
- Compare to a **rolling average for similar jobs** (§3.3). Flag when
  `abs(total - avg) / avg > 0.20`; `critical` reserved for extreme deviation
  (e.g. > 50%) or a zero/near-zero total on a money-class proposal.
- Marker reason cites both numbers: `"total $X is Y% above the $Z avg for <category>"`.
- Cold-start: when the baseline sample size `< MIN_SAMPLES` (default 5), **no flag** (return
  `pass` with `evidence.insufficientHistory=true`). Avoids punishing new tenants (risk §7).

### 3.3 Rolling-average data source

No baseline table exists today. Grounding options found:

- **Estimates / invoices totals:** `estimates.total_cents` (`schema.ts:534`, migration
  `020_create_estimates`) and `invoices.total_cents` (`schema.ts:632`, migration
  `024_create_invoices`) are the realized-price signals. Prefer **accepted** estimates and
  **paid** invoices for the average (excludes rejected/void).
- **"Similar jobs" grouping key:** jobs have **no** service-category column
  (`jobs`, `schema.ts:367`). The available grouping keys are the estimate/quote **template
  category** (`estimate_templates.category_id`, `schema.ts:842`) and the **catalog line-item
  category** resolved by `ai/resolution/catalog-resolver.ts`. Recommendation: group by the
  dominant resolved catalog category of the proposal's line items, falling back to
  tenant-wide average when no category resolves.
- **Two implementations, phased:**
  1. **On-the-fly query (ship first):** `AVG(total_cents)` over accepted estimates / paid
     invoices in the trailing window (default 180 days), grouped by resolved category, with a
     supporting index. Simple, always fresh; acceptable at Wave-2 volumes.
  2. **Snapshot table (optimization, optional migration 238):** a
     `supervisor_pricing_baselines(tenant_id, category, avg_cents, sample_size, window_start,
     computed_at)` refreshed by a daily sweep (reuse the P0-009 sweep pattern the annotator
     already follows). Recommended once per-tenant volume makes the live query hot.

### 3.4 Brand-voice drift — **deterministic (banned phrases) + LLM (register)**

- **Deterministic half:** run the customer-facing text of the proposal
  (`summary` / rendered SMS body) through the tenant's **banned-phrase / locked brand-voice**
  list in `packages/api/src/ai/brand-voice`. A banned-phrase hit is a deterministic flag —
  no model needed. (Brand voice is a Wave-2 sibling; the routing table already has
  `brand_voice_v1` — `config/ai-routing.ts`.) Consume its locked profile, don't re-implement.
- **LLM half:** fold an "unusual register vs the tenant's locked voice" question into the
  same `supervisor_review` call (returns `{ registerDrift: bool, rationale }`).
- Always a **flag**, never critical (brand tone is not customer-harm-critical).

### 3.5 Account-routing residential↔B2B — **deterministic**

- Look up the proposal's customer `account_type` — `customers.account_type`
  (`schema.ts:2905`, values `residential | b2b | property_manager` after migration
  `183_customers_account_type_property_manager`, `schema.ts:4554`).
- Flag when the proposal's routing/template implies the **wrong** segment: a residential-only
  template/flow on a `b2b`/`property_manager` account, or a B2B-terms proposal (e.g. NET-30,
  PO-required) on a `residential` account.
- `critical` when the mismatch changes money terms (e.g. applying B2B tax-exempt / NET terms
  to a residential caller); otherwise a flag.

### 3.6 Flags → confidence markers (N-002)

Every non-`pass` check appends a marker through the **existing**
`payloadWithSupervisorMarker(payload, reasons)` (`marker.ts`), which:
- writes to `_meta.markers[]` with `path='_supervisor'` (the schema requires non-empty
  `path`, `contracts.ts:64`), and
- synthesizes `overallConfidence='medium'` if absent, never inventing a "high" badge
  (marker.ts rationale). This keeps the proposal valid against
  `proposalConfidenceMetaSchema` and therefore still editable.

The markers surface in the review queue, the SMS render (`proposals/sms/render.ts`), and the
end-of-day digest's "what I wasn't sure about" section (N-005, `digest-service.ts`) — the same
consumers the annotator already feeds.

---

## 4. Data model

### 4.1 `supervisor_reviews` (new — migration **237**)

```sql
'237_create_supervisor_reviews': `
  CREATE TABLE IF NOT EXISTS supervisor_reviews (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    proposal_id   UUID NOT NULL REFERENCES proposals(id),
    ai_run_id     UUID REFERENCES ai_runs(id) ON DELETE SET NULL,  -- nullable: deterministic-only reviews
    model         TEXT NOT NULL,                                    -- resolved supervisor model id
    verdict       TEXT NOT NULL
                  CHECK (verdict IN ('pass','flag','hold','timeout','error')),
    critical      BOOLEAN NOT NULL DEFAULT false,
    checks        JSONB NOT NULL DEFAULT '{}',    -- per-check {verdict,reason,evidence}
    flags         JSONB NOT NULL DEFAULT '[]',    -- markers written (audit of what surfaced)
    latency_ms    INTEGER,                        -- for the 60s-P95 metric
    shadow        BOOLEAN NOT NULL DEFAULT false, -- true = computed but not enforced
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_supervisor_reviews_tenant   ON supervisor_reviews(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_reviews_proposal ON supervisor_reviews(proposal_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_reviews_created  ON supervisor_reviews(tenant_id, created_at);
  ALTER TABLE supervisor_reviews ENABLE ROW LEVEL SECURITY;
  ALTER TABLE supervisor_reviews FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation_supervisor_reviews ON supervisor_reviews
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`
```

- Key must be **lexicographically greatest** in `MIGRATIONS` (`schema.ts`) and inserted last —
  the runner concatenates in insertion order (immutability-test rule). Current head is
  `234_tenant_settings_vapi_webhook_secret`; the task pins new numbers **above 236**, so `237`
  leaves room for any in-flight `235`/`236` from sibling threads.
- Follows the `supervisor_policies` shape (migration `167`, `schema.ts:4170`): FORCE RLS +
  tenant-isolation policy.

### 4.2 `ai_runs` logging

Each LLM-bearing review creates one `ai_runs` row via `createAiRun`
(`ai/ai-run.ts:64`) → `startAiRun` → `completeAiRun`/`failAiRun`:
- `taskType='supervisor_review'`, `model=` resolved lightweight model,
  `input_snapshot` = the derived (PII-safe) check inputs, `output_snapshot` = per-check verdicts.
- `supervisor_reviews.ai_run_id` FKs the row (nullable for deterministic-only reviews that
  never called a model). Satisfies "all reviews logged to AI runs" (`docs/PRD.md:702`) and
  feeds the FP/FN measurement harness (§6).

### 4.3 Optional migration **238** — `supervisor_pricing_baselines`

Only if the §3.3 snapshot optimization is adopted; otherwise omit. Same RLS shape.

### 4.4 Immutability snapshot update (mandatory)

Adding `237` (and `238` if used) requires appending the matching SHA-256 entries to the
`SNAPSHOT` array in `packages/api/test/db/migration-immutability.test.ts` (regenerate with the
one-liner documented in that file's header). Reviewer must confirm the migration hasn't
deployed. Without this the immutability test fails CI by design.

---

## 5. Model routing — force cheaper Tier-1, keep it ≠ primary

1. Add `'supervisor_review'` to `TASK_TYPES` and map it to `'lightweight'` in
   `DEFAULT_TASK_TIER_MAPPING` (`config/ai-routing.ts`). `lightweight` resolves to
   `AI_LIGHTWEIGHT_MODEL` (default `claude-haiku-4-5-20251001`). The compiler enforces every
   `TaskType` has a tier, so the new type can't silently fall back to `standard`.
2. **"Different model than the primary task" (acceptance, `docs/PRD.md:703`)** is satisfied
   *structurally* because the primary drafting tasks — `draft_estimate`, `draft_invoice`,
   `update_estimate`, `mms_estimate` — are pinned to `'complex'` (Sonnet), while the reviewer
   is `'lightweight'` (Haiku). To make it a **guaranteed invariant** rather than a
   coincidence of env config:
   - Resolve the primary model from the proposal's originating `ai_runs` row (the drafting run)
     and compare to the resolved supervisor model.
   - If they are equal (an `AI_LIGHTWEIGHT_MODEL`/`AI_COMPLEX_MODEL` misconfiguration), **log a
     loud warning and still run the review** (a same-model reviewer is degraded, not broken).
     A boot-time assertion in `app.ts` (lightweight ≠ complex model id) is the cheaper guard.
3. Keep `temperature: 0` (lightweight tier default) so the classifier is deterministic and the
   FP/FN harness (§6) is stable across runs.

---

## 6. Test plan

### 6.1 Bad-day simulations (PRD §12, `docs/PRD.md:1238`)

- **Flat-voice elder caller** → missed-urgency check returns `critical`
  (`medicalMentionUnescalated`); assert proposal **held** (not dispatched via
  `routeUnsupervisedProposal`), `notifyOwner('escalation')` fired, `supervisor_reviews.verdict='hold'`.
- **Pricing anomaly** → total 30% above the seeded category rolling average → `flag`, marker
  written to `_meta.markers[]`, proposal still dispatched, no alert.

### 6.2 60s-budget test

- Stub the gateway to return within budget → review completes, `latency_ms` recorded.
- Stub the gateway to hang past `SUPERVISOR_REVIEW_BUDGET_MS` → **fail-open**: proposal
  dispatched, `supervisor_reviews.verdict='timeout'`, no hold. Assert the money loop is never
  blocked by a slow/broken model.

### 6.3 Critical-flag hold + alert test

- Handler-level test with mocked gateway + repos (per CLAUDE.md voice/AI rule): critical verdict
  ⇒ dispatch skipped, `escalation` notification enqueued, audit `supervisor.review_held` emitted,
  proposal lands in `draft` (no one-tap token minted).

### 6.4 Deterministic-check unit tests (same commit as logic — CLAUDE.md)

- Pricing: boundary at exactly 20%, cold-start `< MIN_SAMPLES` → no flag, zero-total critical.
- Account-routing: residential template on `b2b`/`property_manager` account → flag/critical matrix.
- Brand-voice: banned-phrase hit → flag without a model call.

### 6.5 FP/FN harness (Wave-2 exit gate)

- Labeled fixture set of proposals (good + each failure mode). Run the full reviewer, compare
  verdicts to labels. Assert **critical-flag FP < 5%** and **FN < 2%**
  (`docs/PRD.md:1194`–`1195`). Emit a report so the number is tracked over time; this harness is
  the gate that flips the flag from shadow → enforce (§7).

### 6.6 Integration test (Docker-gated, PR CI — CLAUDE.md)

- Real Postgres: create `supervisor_reviews`, insert a review, assert every column + RLS
  isolation (mocked-DB alone is insufficient per the entity-resolver lesson). Exercise the
  live rolling-average query against seeded estimates/invoices to pin the real column names
  (`total_cents`, `account_type`).

---

## 7. Effort, risks, rollout

### Effort — **L**

New reviewer module (`ai/supervisor/**` per the PRD Allowed-Files, `docs/PRD.md:678`), four
checks (one LLM + three deterministic), rolling-average query + optional snapshot, the
pre-dispatch gate wiring across the orchestrated task paths, `supervisor_reviews` +
`ai_runs` logging, the hold/alert path, the FP/FN harness, and the flag/shadow machinery.
Largest of the three supervisor-adjacent Wave-2 stories, as the PRD flags
(`docs/PRD.md:563`).

### Risks

| Risk | Mitigation |
|---|---|
| **False-positive alert fatigue** (PRD risk #5, `docs/PRD.md:1276`) | Shadow-mode first; ship enforce only after FP < 5% on real traffic; per-tenant calibration in Wave 3. |
| **Pricing baseline cold-start** (new tenants, sparse categories) | `MIN_SAMPLES` gate → no flag until enough history; tenant-wide fallback average. |
| **Medical-mention false-negative** (the scariest — a real emergency dispatched slow) | FN target < 2%; deterministic severity pre-filter backstops the LLM; keep the emergency-detector feature extraction as a second signal. |
| **Latency on the money loop** | Hard 60s timeout + fail-open; deterministic checks run first and can short-circuit the LLM. |
| **Same-model misconfig** defeats the "different model" criterion | Boot-time assertion + per-review warning (§5). |
| **Double supervisor confusion** | Clearly separate namespaces: policy engine stays `proposals/supervisor/*`; N-004 reviewer lives in `ai/supervisor/*` (its PRD Allowed path). Retire the generic annotator once the structured reviewer covers it (CLAUDE.md dead-code rule). |

### Rollout / flagging (recommended)

- **New flag, separate key** (do **not** overload `supervisor_agent_disabled`, which is the
  policy engine's default-ON opt-out). Suggest `supervisor_review_mode ∈ {off, shadow, enforce}`
  per tenant, **default `off`**, promoted to `shadow` platform-wide first.
- **Shadow mode**: compute checks, write `supervisor_reviews` (`shadow=true`) + `ai_runs`,
  attach markers *optionally* — but **never hold, never alert**. Drives the FP/FN harness on
  live data.
- **Enforce** only per-tenant after the FP gate passes. This is the safe reading of the hard
  gate "cannot ship to customers without this" (`docs/PRD.md:551`): the *capability* must exist
  and be measured before GA, but holds/alerts turn on only once the FP rate is trusted.

---

## 8. Owner decisions (open questions)

1. **Default-on vs shadow-first?** Recommendation: **shadow-first**, given the FP-fatigue risk
   and that holds actively block the money loop. Owner may prefer enforce-from-day-one for the
   medical-mention critical path only (a narrow enforce carve-out) — acceptable if FN is the
   dominant fear.
2. **Medical-mention criticality threshold** — is *any* unescalated medical mention a hard hold,
   or only when combined with a same-day-emergency signal? (Affects FN vs FP trade.)
3. **Pricing baseline cold-start** — silent `pass` until `MIN_SAMPLES`, or fall back to a
   vertical-pack default price band? (New-tenant experience.)
4. **Grouping key for "similar jobs"** — resolved catalog category vs estimate-template category
   vs tenant-wide only, for v1?
5. **Separate flag vs reuse** — confirm the new `supervisor_review_mode` key rather than
   folding into the existing policy opt-out (they have opposite defaults).
6. **Enforce scope** — hold *all* four criticals, or only urgency/routing (customer-harm) while
   pricing/brand-voice stay flag-only even in enforce mode?

---

*References are file:line into `packages/api`, `packages/shared`, and `docs/PRD.md` at design time.*
