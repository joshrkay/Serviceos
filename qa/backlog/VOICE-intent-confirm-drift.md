# VOICE — harness doesn't drive the intent_confirm turn

**Matrix rows:** CUST-02, SCH-02, SCH-03 (voice → proposal rows)
**Live verdict (2026-06-04):** fail ("no proposal produced")
**Target verdict:** pass
**Effort:** S (harness) — pending a product-contract decision

## Problem

All three voice rows fail with "no proposal — AI pipeline not ready", but
the evidence contradicts that diagnosis: the LLM is live on dev and the
session works — it just stops one turn short. The conversation engine now
parks in `intent_confirm` and waits for the caller to confirm before a
proposal is drafted. The harness sends a single utterance and immediately
polls for a proposal, so it never arrives.

## Evidence from the live run

- `qa/reports/2026-06-04/artifacts/CUST-02/api/02-vinput.json` — response
  `state: "proposal_draft"` flow shows
  `intent_classified` → `intentType: "create_customer", confidence: 0.9` →
  `entity_resolved` → `toState: "intent_confirm"`. Real LLM classification,
  no proposal row yet.
- VOX-02 partial corroborates: response `ttsText="intent_confirm"` (the
  canned confirm prompt — also not localized for Spanish input).
- The report's hypothesis "AI_PROVIDER_API_KEY is likely unset (mock LLM)"
  is wrong: the key is set on Railway dev and classification clearly ran.

## Acceptance criteria

- [ ] Decide: is the confirm turn the intended contract? If yes, harness
      sends the confirmation utterance ("yes, book it") and then asserts the
      proposal; if no, the engine should draft the proposal at
      `intent_confirm` and the product is the fix.
- [ ] CUST-02, SCH-02, SCH-03 flip fail → pass.
- [ ] Update precheck "voice utterance generates proposal IDs" the same way
      (currently fails 404 on its own utterance endpoint — align it with the
      `/api/voice/sessions/:id/input` path the specs use).

## Allowed files

- `e2e/qa-matrix/helpers/voice-flow.ts`, the three specs, `precheck.spec.ts`

## Verify

```bash
npm run e2e:qa-matrix -- --grep "CUST-02|SCH-02|SCH-03"
```
