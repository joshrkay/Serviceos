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

**First live run: 2026-06-04** against Railway dev
(`serviceosapi-development`, deployed from PR #470 merge; local repo at
`3a0ff1e8`). Full report: [`qa/reports/2026-06-04/QA-REPORT.md`](../reports/2026-06-04/QA-REPORT.md).

Raw report counts: **40 pass · 7 partial · 26 fail · 1 n/a** (74 catalog
rows). The fail count overstates product defects — see the two harness
issues below before reading the table.

### Run prerequisites discovered (runbook corrections)

1. **`CLERK_DEV_HMAC_TOKENS=true` must be set on the dev API service.**
   The runbook claims matching `CLERK_SECRET_KEY` is sufficient; it is not —
   since P0-033 the API verifies RS256/JWKS by default and refuses minted
   HMAC tokens without this flag (every row 401s). Set on Railway dev
   2026-06-04; keep it out of prod (schema + runtime both refuse it there).
2. **Appendix C's quick fix breaks ISO-01.** Pointing `E2E_DB_URL_READONLY`
   at the default Railway `postgres` user means Agent C connects as a
   superuser with `rolbypassrls` — the no-GUC RLS check then always sees
   rows and ISO-01 false-fails. Verified manually 2026-06-04: RLS is
   enabled + FORCED on customers/jobs/estimates/invoices/notes, and a
   non-superuser role with no GUC **fails closed** (policy errors on the
   missing `app.current_tenant_id` parameter; per-tenant scoping correct
   with the GUC set). Fix tracked in
   [ISO-01-rls-probe-role](./ISO-01-rls-probe-role.md).
3. **node-pg vs Railway's self-signed cert:** use `?sslmode=no-verify` in
   both DB URLs (the runbook's `?sslmode=require` makes node-pg verify the
   chain and fail).

### Story-by-story: predicted vs live

| Story | Predicted | Live 2026-06-04 | Status |
|---|---|---|---|
| EST-03 PATCH alias | partial | **partial** (PUT-only confirmed; [artifact](../reports/2026-06-04/artifacts/EST-03/)) | Confirmed — story stands |
| INV-02 list endpoint | fail | **pass** ("List/filter invoices" green) | **Gap closed since 2026-04-22** — story can be archived |
| INV-05 stripe webhook | fail | not executed | Blocked by catalog drift (below); also needs `stripe listen` |
| INV-04 payment link | fail | not executed | Blocked by catalog drift |
| INV-03 invoice delivery | partial | not executed | Blocked by catalog drift; corroborating signal: PORT-01/02 `POST /:id/send` → 400, send service unwired on dev |
| AST-01/04/05/06/07 assistant intents | partial/fail | not executed | Blocked by catalog drift; classifier itself works (see CUST-02 note below) |
| INV-07 overdue cron | fail | **partial** under new id PAY-04: `money_state` stays `invoiced` after backdated `due_date` — overdue sweep not running on dev | Confirmed — story stands |
| EST-05 (note-only) | n/a | conversion path exercised by JRN-03 → **pass** | Resolution holds |
| INV-06 (note-only) | n/a | equivalent new row PAY-01 (idempotent webhook handling) → **pass** | Resolution holds — close once INV-05 wires the route |

### New defects found by the live run (stories created 2026-06-04)

| Story | Row | What broke |
|---|---|---|
| [PROP-01-reject-guard](./PROP-01-reject-guard.md) | PROP-01 | `POST /api/proposals/:id/reject` on a **draft** returns 200 + `status=rejected`; expected 409 (approval-state guard). Human-in-the-loop contract violation. |
| [JRN-02-estimate-accept-500](./JRN-02-estimate-accept-500.md) | JRN-02 | `POST /api/estimates/:id/transition {status:"accepted"}` → 500 INTERNAL_ERROR on JRN-02's estimate while JRN-01's identical transition passes. |
| [PROV-01-onboarding-configure-route](./PROV-01-onboarding-configure-route.md) | PROV-01/02 | `POST /api/onboarding/configure` → Express 404; route exists nowhere in `packages/api/src`. Matrix expectation vs API reality — decide build-or-rewrite. |
| [QA-MATRIX-catalog-drift](./QA-MATRIX-catalog-drift.md) | 15 tests | `matrix.ts` lacks rows EST-04..06, INV-03..07, AST-01..07 → those tests die on `Unknown matrix row` before producing evidence; 13 legacy rows (CUS/BILL/VOICE/PORTAL/ISO-02/LEGACY-…) have no implementing spec and always report fail/no-manifest. |
| [VOICE-intent-confirm-drift](./VOICE-intent-confirm-drift.md) | CUST-02, SCH-02, SCH-03 | Voice rows fail "no proposal", but evidence shows the LLM classified `create_customer` at 0.9 confidence and the session parked in `intent_confirm` awaiting caller confirmation. Harness sends one utterance and never confirms. Product contract changed or harness must drive the confirm turn. Report's "AI key unset" hypothesis is wrong — AI provider is live on dev. |
| [ISO-01-rls-probe-role](./ISO-01-rls-probe-role.md) | ISO-01 | Agent C must use a non-superuser probe role (or accept error-as-suppressed); with the superuser conn the no-GUC check can never pass. API-side isolation (B→A 404s, cross-tenant write blocked) passed. |

### Second pass — after fixes on `fix/qa-matrix-live-run-findings` (2026-06-04)

All six new stories plus the catalog restoration were built the same day;
counts moved **40/7/26/1 → 44 pass · 9 partial · 15 fail · 1 n/a**, with
zero harness-noise rows left (69 catalog rows, no orphans, every verdict
evidence-backed). Flipped live: ISO-01, JRN-02, EST-03..06, EST-05/06 +
INV-03..07 + AST-01..07 all produce real verdicts now (AST-01/03/06 and
INV row passes include: assistant create-customer proposal works with HITL
preserved; payment-link provider exists but is unmounted → INV-04 story
confirmed precise).

Still failing, **deploy-gated** (fixes are on this branch; dev runs
`cursor/qa-matrix-voice-gates-b78e` which predates them AND main's proposal
gate): PROV-01/02 (re-activation 500 → idempotent fix here), CUST-02 +
SCH-02/03 (voice `ai_run_id` FK fix here), PROP-01..04 (gate on main,
regression tests here). Merge + redeploy dev from main lineage, re-run
those rows, and the expected state is ~55+ pass with the remaining
fails/partials being real env/feature gaps (Stripe webhook secret, delivery
wiring, overdue sweep worker, AST-04/05/07 features).

### Remaining live partials (no story yet — verify on dev config first)

- SMS-01: no `appointment_confirmation` dispatch row from a REST-created
  appointment — confirmation may only fire via the `create_booking`
  proposal path, or Twilio is unconfigured on dev.
- VOX-02: Spanish utterance answered with canned `intent_confirm` prompt —
  i18n of the confirm turn.
- PORT-01/02: `send` → 400 (no view token mintable) — send service unwired
  on dev; same root cause as INV-03's delivery leg.
