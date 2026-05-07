# AST-01 — Assistant intent: create customer

**Matrix row:** AST-01 (Assistant · create customer)
**Current predicted verdict:** partial (proposal handler exists, classifier returns `unknown`)
**Target verdict:** pass
**Effort:** M (2–4 hours)

## Problem

The assistant cannot create customers from chat. "Create a new customer named
Alex" classifies as `unknown` and is silently dropped. The downstream
`create_customer` proposal type already exists, so the only gap is the
classifier + router wiring.

## Evidence from code

- `packages/api/src/ai/orchestration/intent-classifier.ts:16-22` — supported
  intents: `create_invoice | draft_estimate | create_appointment |
  update_invoice | update_estimate | unknown`. No `create_customer`.
- `packages/api/src/ai/orchestration/intent-classifier.ts:60-114` — system
  prompt has zero customer examples.
- `packages/api/src/ai/orchestration/intent-classifier.ts:170-176` — fallback
  returns `unknown` for unmatched inputs.
- `packages/api/src/proposals/proposal.ts:17` — `create_customer` proposal
  type exists. Handler already built.
- Voice action router (grep for `voice-action-router.ts`) maps intents to
  proposals; needs an entry for `create_customer` → `create_customer`.

## Acceptance criteria

- [ ] Classifier recognizes `create_customer` with at least these phrasings:
  - "Create a new customer named Alex"
  - "Add customer Acme Corp, email alex@acme.com"
  - "New customer: Sarah, phone 555-0100"
- [ ] System prompt includes 3–5 customer-creation examples to steer the LLM.
- [ ] Returned intent includes parsed fields: `displayName`, `email` (optional),
  `phone` (optional). Missing fields fall through to the existing clarification
  flow, not to `unknown`.
- [ ] Voice action router maps `create_customer` intent → `create_customer`
  proposal type.
- [ ] `/api/assistant/chat` returns a proposal preview (not an error, not
  `unknown`). Proposal requires human approval before creating the customer
  (core rule — no auto-execute).
- [ ] Unit test covers all three phrasings + one ambiguous input that should
  still fall through to clarification.
- [ ] QA matrix `AST-01` flips from partial → pass.

## Allowed files

- `packages/api/src/ai/orchestration/intent-classifier.ts`
- `packages/api/src/ai/orchestration/voice-action-router.ts`
- `packages/api/src/ai/orchestration/__tests__/*`
- `packages/shared/src/ai.ts` or `packages/api/src/ai/types.ts` (if intent
  union type lives there)

## Out of scope

- Other new intents (update_customer, delete_customer). Separate stories.
- UI changes to the chat surface.
- Tuning LLM provider/model routing.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- intent-classifier
npm run e2e:qa-matrix -- --grep AST-01
```
