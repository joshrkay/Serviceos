# AST-06 — Friendly reply for `unknown` intents

**Matrix row:** AST-06 (Assistant · error handling)
**Current predicted verdict:** partial (chat returns typed error; voice drops silently)
**Target verdict:** pass
**Effort:** S (< 2 hours)

## Problem

When the classifier returns `unknown`, the voice action router silently
no-ops. On chat the behavior is slightly better (a typed error surfaces), but
neither path gives the user actionable feedback like "I didn't catch that —
try 'Create an estimate for [customer]'."

## Evidence from code

- `packages/api/src/ai/orchestration/intent-classifier.ts:170-176` — fallback
  to `unknown` with `confidence: 0`.
- `packages/api/src/ai/orchestration/voice-action-router.ts:85-91` — unknown
  branch logs and returns, no user-visible reply.
- `packages/api/src/routes/assistant.ts:168-171` — typed error surfaces in
  chat, but message is internal-flavored, not a friendly clarification.

## Acceptance criteria

- [ ] New response kind `clarification` in the assistant contract:
  ```ts
  { kind: 'clarification'; message: string; suggestions: string[]; }
  ```
- [ ] When classifier returns `unknown`, the chat and voice paths both return
  a `clarification` with a friendly message and 3 suggestion prompts tailored
  to the tenant's recent activity (e.g., if tenant has estimates in draft,
  include "Send my last estimate" as a suggestion).
- [ ] Suggestions come from a small pure helper (`buildSuggestions(context)`)
  that reads recent proposal history for this tenant — no LLM call on the
  unknown path (keep it cheap and deterministic).
- [ ] Voice surface speaks the clarification message aloud (existing TTS path).
- [ ] Unit test covers empty-context (no prior proposals) — returns a set of
  generic suggestions.
- [ ] QA matrix `AST-06` flips from partial → pass.

## Allowed files

- `packages/api/src/ai/orchestration/voice-action-router.ts`
- `packages/api/src/routes/assistant.ts`
- `packages/api/src/ai/orchestration/build-suggestions.ts` (new, small helper)
- `packages/shared/src/ai.ts` (contract additions)
- `packages/api/src/ai/__tests__/*`

## Out of scope

- LLM-driven clarification ("did you mean…?"). This is a static suggestion
  list.
- Rewriting the web chat component — the existing message renderer handles
  generic text blocks and suggestion chips.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- build-suggestions
npm run e2e:qa-matrix -- --grep AST-06
```
