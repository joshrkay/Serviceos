# Behavior Taxonomy — Gap Analysis

Generated as part of the voice-corpus depth pass. Source of truth for the
taxonomy is `SUPPORTED_INTENTS` in
`packages/api/src/ai/orchestration/intent-classifier.ts`; the structured
taxonomy lives in `data/behaviors.yaml`.

## 1. "36 behaviors" vs. reality — the count is wrong

The goal repeatedly references **36 behaviors** in a
`packages/intent-classifier/behaviors.yaml`. Neither exists:

- There is **no `packages/intent-classifier/`** package and **no
  `behaviors.yaml`** anywhere in the repo (verified).
- The production model defines **41 intents** (the `IntentType` union /
  `SUPPORTED_INTENTS` array): **25 proposal-driving + 12 lookup + 2 signal +
  2 conversational**.

So the real taxonomy is **41**, not 36. `data/behaviors.yaml` enumerates all 41
and is integrity-checked against the code by
`scripts/data-pipeline/validate-behaviors.ts` (fails if the two drift).

## 2. Category breakdown

| Category | Count | Notes |
|---|---:|---|
| proposal-driving | 25 | Mutations. Never auto-executed — all require human approval (per CLAUDE.md). |
| lookup | 12 | Read-only; `isLookupIntent()` routes these straight to the lookup skill. |
| signal | 2 | `language_switch`, `operator_request` — session control, not proposals. |
| conversational | 2 | `confirm`, `unknown` (fallback / negative class). |

## 3. Coverage gaps & taxonomy risks surfaced

These are the behaviors most at risk of weak comprehension and the reasoning:

1. **High intra-pair confusability** — likely the biggest accuracy risk:
   - `create_invoice` ↔ `draft_estimate` ↔ `update_invoice` ↔ `update_estimate`
     (callers rarely distinguish "estimate" from "invoice"; "quote", "bill",
     "write it up" are ambiguous).
   - `create_appointment` ↔ `reschedule_appointment` ↔ `confirm_appointment` ↔
     `notify_delay` (all time/appointment oriented).
   - `lookup_balance` ↔ `lookup_invoices` ↔ `lookup_account_summary` (a caller
     asking "what do I owe?" could map to any of the three).
   - Recommendation: the eval harness reports a **per-intent confusion matrix**
     so these clusters are watched explicitly.

2. **Operator-only vs. inbound-customer ambiguity**: `log_expense`,
   `log_time_entry`, `reassign_appointment`, `mark_lead_lost`, `lookup_revenue`
   are realistically **operator** utterances, not inbound-customer speech.
   Mixing both registers in one flat intent set risks the agent accepting an
   operator-only action from an unauthenticated caller. Recommendation: tag a
   `speaker_role` (customer | operator) dimension in a future taxonomy revision.

3. **`emergency_dispatch` overlaps the triage layer**: emergency detection also
   lives in `corpus/data/triage-rules.json` (TIER_1/2). The intent and the
   triage tiers must agree; today they are independent. Recommendation: make
   `emergency_dispatch` utterances a superset of TIER_1/TIER_2 trigger phrases.

4. **`unknown` is doing double duty**: it is both "out of scope" and "not
   understood / low confidence". For eval these should be separable
   (out-of-scope is a correct refusal; not-understood is a miss). Recommendation:
   consider splitting `out_of_scope` from `unknown` in a future revision.

5. **No dedicated slot for `problem_description` quality**: several behaviors
   (`create_appointment`, `emergency_dispatch`, `create_job`) hinge on a free-text
   problem description that is the hardest slot to extract. It is a critical slot
   in the eval (`run-slot-eval.ts`).

## 4. Path-divergence note (goal vs. repo)

| Goal referenced | Actual artifact created |
|---|---|
| `packages/intent-classifier/behaviors.yaml` | `data/behaviors.yaml` (no such package exists) |
| "36 behaviors" | 41 intents documented |

## 5. Recommended next taxonomy revision (not done in this pass)

- Add `speaker_role` (customer | operator) and `out_of_scope` as a distinct class.
- Reconcile `emergency_dispatch` with `triage-rules.json` tiers.
- Consider merging `confirm_appointment` signal into the dialogue layer rather
  than the intent layer (it is highly context-dependent).
