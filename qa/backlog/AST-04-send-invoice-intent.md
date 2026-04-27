# AST-04 — Assistant intent: send invoice

**Matrix row:** AST-04 (Assistant · draft+send invoice)
**Current predicted verdict:** partial (draft works, send unreachable)
**Target verdict:** pass
**Effort:** M (3–5 hours)
**Depends on:** INV-03 (delivery side-effect of `/issue`)

## Problem

The assistant can draft an invoice (`draft_invoice` proposal) but has no
intent for "send invoice #12 to Acme" or "issue that invoice." After drafting,
the user must leave the chat to issue and deliver. The matrix row records
partial because the second half of the round-trip is unreachable.

## Evidence from code

- `packages/api/src/ai/orchestration/intent-classifier.ts:11` — comment
  acknowledges: "Phase 3/4 intents (send_invoice, query_*) still return
  'unknown' today".
- `packages/api/src/ai/orchestration/intent-classifier.ts:16-22` — no
  `send_invoice` / `issue_invoice` intent.
- `packages/api/src/proposals/proposal.ts:17` — no proposal type for issuing.

## Acceptance criteria

- [ ] New intent `issue_invoice` recognized from phrasings:
  - "Send invoice 1024 to the customer"
  - "Issue the Acme invoice"
  - "Send the invoice we just drafted"
- [ ] New proposal type `issue_invoice` with payload `{ invoiceId: string }`.
- [ ] Proposal handler calls `POST /api/invoices/:id/issue` which (per INV-03)
  triggers delivery. No direct DB write from the handler.
- [ ] Requires human approval before execution (core rule).
- [ ] If the invoice isn't in `draft`, proposal returns a validation failure
  with a friendly message, not a silent drop.
- [ ] Voice action router wires intent → proposal type.
- [ ] "The invoice we just drafted" context resolves via the conversation's
  recent proposals. If no recent invoice is referenced, proposal requires an
  explicit invoice number and asks for clarification.
- [ ] Unit test covers: happy path, missing invoice reference, wrong status.
- [ ] QA matrix `AST-04` flips from partial → pass.

## Allowed files

- `packages/api/src/ai/orchestration/intent-classifier.ts`
- `packages/api/src/ai/orchestration/voice-action-router.ts`
- `packages/api/src/proposals/proposal.ts` (extend union)
- `packages/api/src/proposals/contracts.ts` (add Zod schema)
- `packages/api/src/proposals/handlers/issue-invoice.ts` (new)
- `packages/api/src/proposals/__tests__/*`

## Out of scope

- Bulk send ("send all open invoices"). Future story.
- Scheduled send ("send this tomorrow at 9am").

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- issue-invoice
npm run e2e:qa-matrix -- --grep AST-04
```
