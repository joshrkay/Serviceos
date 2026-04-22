# QA Matrix — 4-agent swarm harness

Cross-layer QA for **Estimates**, **Invoices**, and **Assistant** (see the matrix
in `/root/.claude/plans/detailed-qa-matrix-whimsical-scroll.md`).

Each matrix row is executed by a 4-agent swarm inside a single Playwright test:

- **Agent A — API Verifier** (`e2e/qa-matrix/helpers/api-verifier.ts`)
  Issues the API call, captures request + response to `artifacts/<row>/api/`.
- **Agent B — UI Verifier** (the Playwright `page` fixture in each spec)
  Takes before/after screenshots into `artifacts/<row>/ui/`.
- **Agent C — DB Verifier** (`e2e/qa-matrix/helpers/db-verifier.ts`)
  Runs SQL (with optional `SET LOCAL app.current_tenant_id` for RLS) and
  writes row dumps + the literal SQL to `artifacts/<row>/db/`.
- **Agent D — Evidence Assembler** (`e2e/qa-matrix/helpers/report-builder.ts`)
  Runs from Playwright `globalTeardown`. Walks artifacts and emits
  `qa/reports/<date>/QA-REPORT.md` with a summary table, per-row detail, and
  a backlog section for every fail.

## Run order

`precheck.spec.ts` → `estimates.spec.ts` → `invoices.spec.ts` → `assistant.spec.ts` (FINAL).

The assistant module is always last because it must be able to drive the
domain objects the prior two suites exercise.

## Quick start

```bash
# 1) Seed the two fixtures into Railway dev. Re-runnable (idempotent).
E2E_DB_URL_READWRITE=postgres://service-role@... \
  npx tsx e2e/qa-matrix/fixtures/seed.ts

# Copy the printed `export ...` lines into your shell.

# 2) Export the rest of the env (see below), then run the matrix:
npm run e2e:qa-matrix

# 3) Open the report:
ls qa/reports/         # latest run dir
open qa/reports/*/QA-REPORT.md
```

## Required env

| Var | Purpose |
|-----|---------|
| `E2E_BASE_URL` | Railway dev web URL (e.g. `https://serviceos-dev.up.railway.app`) |
| `E2E_API_URL` | Railway dev API URL (e.g. `https://serviceos-api-dev.up.railway.app`) |
| `E2E_DB_URL_READONLY` | Direct PG read connection for Agent C |
| `E2E_DB_URL_READWRITE` | Service-role PG connection (for `fixtures/seed.ts` only) |
| `E2E_CLERK_TEST_TOKEN_A` | Clerk test-mode session JWT for Tenant A |
| `E2E_CLERK_TEST_TOKEN_B` | Clerk test-mode session JWT for Tenant B |
| `E2E_TENANT_A_ID` | UUID of QA Tenant A (from seeder output) |
| `E2E_TENANT_A_CUSTOMER_ID` | Tenant A's seeded customer |
| `E2E_TENANT_A_JOB_ID` | Tenant A's seeded job |
| `E2E_TENANT_B_ID` / `E2E_TENANT_B_CUSTOMER_ID` / `E2E_TENANT_B_JOB_ID` | Same for Tenant B |

Clerk testing-tokens setup: https://clerk.com/docs/testing/playwright

Stripe for INV-05/06: use `stripe listen --forward-to $E2E_API_URL/webhooks/stripe`
during the run. The harness constructs a synthetic payload with an
`evt_qa_*` id so idempotency is exercised across two identical POSTs.

## Run a single row

```bash
npm run e2e:qa-matrix -- --grep EST-01
npm run e2e:qa-matrix -- --grep "INV-0[357]"
```

The report builder still runs in teardown and writes a partial report.

## What "pass / partial / fail" mean in this harness

- **pass** — API + UI + DB evidence aligned and meets the row's Pass Criteria.
- **partial** — Pass Criteria substantially met but with a documented deviation
  (e.g., PUT instead of PATCH; status `open` instead of `sent`). Note is
  embedded in the report row.
- **fail** — Pass Criteria not met. Evidence captures the missing-route /
  wrong-status / absent-row that blocked the row. Fails become the backlog.
- **n/a** — Harness couldn't execute (e.g., dependency row failed to seed).

## Output layout

```
qa/
├── README.md                     # this file
├── artifacts/                    # transient — wiped between runs
└── reports/
    └── 2026-04-22/
        ├── QA-REPORT.md
        └── artifacts/
            ├── EST-01/
            │   ├── api/01-create.json
            │   ├── ui/01-list-before.png
            │   ├── ui/01-list-after.png
            │   ├── db/01-row.json
            │   ├── db/01-row.sql
            │   └── manifest.json
            ├── EST-02/...
            └── ...
```

## Expected verdicts against current main (as of 2026-04-22)

Based on Phase-1 exploration — verdicts at run time may differ if gaps have
been closed since:

- **7 pass** — EST-01, EST-02, EST-04, EST-06, INV-01, AST-02, AST-03
- **7 partial** — EST-03, EST-05, INV-03, INV-06, AST-01, AST-04, AST-06
- **5 fail** — INV-02, INV-04, INV-05, INV-07, AST-05, AST-07
  *(6 if AST-07 is not interpreted leniently)*

Fail count is the production backlog until closed.

## Re-running after fixing a gap

Close the gap on main, redeploy to Railway dev, re-run the matrix. The
report writes to a new dated directory, so you can diff two reports to see
only the rows that changed.
