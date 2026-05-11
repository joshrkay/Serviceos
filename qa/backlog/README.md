# QA Matrix Gap Backlog

Stories in this folder each close a gap surfaced by the `qa-matrix` harness.
They were drafted 2026-04-22 by grounding the plan's predicted verdicts in
actual code inspection (routes, schema, classifier) — the matrix run itself
is pending a live Railway dev execution.

Completing a story should flip its matrix row from `partial`/`fail` → `pass`.
Verify with:

```bash
npm run e2e:qa-matrix -- --grep <STORY-ID>
```

## Priority order

Stories are ordered so each unblocks the next. Do them top-down. Within a
tier, parallel-safe stories are grouped.

### Tier 1 — small, isolated, no dependencies

| Story | Title | Effort | Matrix row |
|---|---|---|---|
| [EST-03](./EST-03-patch-estimates.md) | Add `PATCH /api/estimates/:id` alias | S | EST-03 partial → pass |
| [INV-02](./INV-02-list-invoices.md) | Add `GET /api/invoices` list endpoint | M | INV-02 fail → pass |
| [INV-05](./INV-05-wire-stripe-webhook-route.md) | Wire `POST /webhooks/stripe` route | S | INV-05 fail → pass |

### Tier 2 — new features, single-surface

| Story | Title | Effort | Matrix row |
|---|---|---|---|
| [INV-04](./INV-04-payment-link-route.md) | Expose payment-link provider via HTTP | S | INV-04 fail → pass |
| [INV-03](./INV-03-invoice-delivery.md) | Deliver invoice on issue (email/SMS) | M | INV-03 partial → pass |
| [AST-01](./AST-01-customer-intent.md) | Assistant intent: create customer | M | AST-01 partial → pass |
| [AST-06](./AST-06-unknown-intent-ux.md) | Friendly reply for `unknown` intents | S | AST-06 partial → pass |

### Tier 3 — depends on Tier 1/2

| Story | Title | Effort | Matrix row |
|---|---|---|---|
| [AST-04](./AST-04-send-invoice-intent.md) | Assistant intent: send invoice (needs INV-03) | M | AST-04 partial → pass |
| [INV-07](./INV-07-overdue-cron.md) | Overdue status + nightly cron | L | INV-07 fail → pass |

### Tier 4 — architectural, defer until scoped

| Story | Title | Effort | Matrix row |
|---|---|---|---|
| [AST-05](./AST-05-query-intents.md) | Read/query intents (answer, don't propose) | L | AST-05 fail → pass |
| [AST-07](./AST-07-multi-step-chaining.md) | Multi-step proposal chaining | XL | AST-07 fail → pass |

### Rows that are already fine (note-only)

| Matrix row | Resolution |
|---|---|
| EST-05 | No dedicated convert endpoint; `POST /api/invoices { estimateId }` works. Document in matrix as intended. |
| INV-06 | Webhook idempotency is already DB-backed (`WebhookRepository`). Will flip to pass once INV-05 wires the route. |

## How to execute one

1. Read the story file end-to-end.
2. Branch off `main` (not this QA branch).
3. Implement only inside the story's **Allowed files**.
4. Run `npm run e2e:qa-matrix -- --grep <ID>` — expect the row to flip.
5. Run `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`.
6. Ship via the normal review flow.

## Observed verdicts (live)

_This section gets filled in after the first real matrix run against Railway
dev (blocked on `.env.qa` + password rotation as of 2026-04-22). Update the
predicted column in each story if live verdicts differ._
