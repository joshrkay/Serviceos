# AST-05 — Read/query intents (answer, don't propose)

**Matrix row:** AST-05 (Assistant · read-only queries)
**Current predicted verdict:** fail (no intents, silent drop)
**Target verdict:** pass
**Effort:** L (1–2 days)

## Problem

The assistant can't answer questions. "When was invoice 1024 paid?" or "show
me open invoices over $500" classify as `unknown` and vanish. Read is
intentionally unbuilt — Phase 3/4 per the classifier's own comment — but the
matrix treats this as a production gap.

## Evidence from code

- `packages/api/src/ai/orchestration/intent-classifier.ts:11` — comment:
  "Phase 3/4 intents (send_invoice, query_*) still return 'unknown' today".
- No query-intent handlers anywhere in `packages/api/src/ai/`.
- `/api/assistant/chat` response shape has no field for an answer distinct
  from a proposal — this story extends it.

## Design decision — answers vs proposals

Queries do **not** become proposals. They go down a separate path that returns
a read-only answer inline. Introduce an `AssistantAnswer` contract:

```ts
type AssistantAnswer = {
  kind: 'answer';
  answer: string;               // rendered natural-language reply
  data: Record<string, unknown>; // structured payload for UI to format
  sources: Array<{ type: 'invoice'|'customer'|'estimate'|'job'; id: string }>;
};
```

The chat response becomes a discriminated union of `proposal | answer |
clarification | unknown`.

## Acceptance criteria

### Intents (minimum set)

- [ ] `query_invoice_status` — "is invoice 1024 paid?", "what's the status of Acme's invoice?"
- [ ] `query_invoice_list` — "show me open invoices", "list overdue invoices over $500"
- [ ] `query_customer` — "who is customer Acme?", "what's Acme's phone number?"
- [ ] `query_payment` — "when was invoice 1024 paid?", "what did Acme pay last month?"

### Handlers

- [ ] Each handler queries via existing repositories (no raw SQL in handlers).
- [ ] Tenant scope enforced — handlers never return cross-tenant data.
- [ ] Limit results to 25 by default; offer "show more" as a clarification.
- [ ] If the query matches no rows, return a friendly "no invoices match"
  answer, not `unknown`.

### Chat surface

- [ ] `/api/assistant/chat` response supports `kind: 'answer'`.
- [ ] Web chat component renders answers as a formatted block (links to
  referenced entities).
- [ ] Proposals still work unchanged.

### Testing

- [ ] Unit tests per handler + per phrasing above.
- [ ] Integration test asserts cross-tenant isolation: Tenant B asking about
  Tenant A's invoice number gets "no match", not Tenant A's data.
- [ ] QA matrix `AST-05` flips from fail → pass.

## Allowed files

- `packages/api/src/ai/orchestration/intent-classifier.ts`
- `packages/api/src/ai/handlers/query-*.ts` (new)
- `packages/api/src/routes/assistant.ts` (wire handlers)
- `packages/api/src/ai/__tests__/*`
- `packages/shared/src/ai.ts` (answer contract)
- `packages/web/src/assistant/*` (render answer blocks)

## Out of scope

- Free-text search inside invoice line items.
- Analytics-grade aggregations ("total revenue this quarter"). Future story.
- Voice surface — voice-action-router keeps dropping queries for now.

## Verify

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm run test -w packages/api -- query-
npm run e2e:qa-matrix -- --grep AST-05
```
