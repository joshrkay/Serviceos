# QA Matrix — 4-agent swarm harness

**Unblock the matrix:** [docs/runbooks/qa-full-matrix-unblock.md](../docs/runbooks/qa-full-matrix-unblock.md)
— `npm run qa:setup` from a filled `.env.qa`, then `npm run qa:matrix:run` or
`npm run qa:runbook`. CI secrets: [docs/runbooks/qa-github-secrets.md](../docs/runbooks/qa-github-secrets.md).

Cross-layer QA for the full product surface: provisioning, customers, estimates,
billing journeys, scheduling, SMS, payments, voice, proposals, isolation, and
public portal. Each matrix row is executed by a 4-agent swarm inside a single
Playwright test:

- **Agent A — API Verifier** (`e2e/qa-matrix/helpers/api-verifier.ts`)
- **Agent B — UI Verifier** (Playwright `page` fixture)
- **Agent C — DB Verifier** (`e2e/qa-matrix/helpers/db-verifier.ts`)
- **Agent D — Evidence Assembler** (`e2e/qa-matrix/helpers/report-builder.ts`)

## Production gates

Two enforced gate lists live in [`e2e/qa-matrix/gates.ts`](../e2e/qa-matrix/gates.ts):

| Gate | Rule |
|------|------|
| **Voice-Critical (20 rows)** | 20/20 must be `pass`; `partial`/`fail`/`na`/missing = fail |
| **Business-Critical (30 rows)** | ≥27/30 must pass; up to 3 documented waivers in [`qa/gate-exceptions.json`](gate-exceptions.json) |

After a matrix run, enforce gates with:

```bash
npm run qa:matrix:gate
# or voice-only:
npm run qa:matrix:gate -- --voice-only
```

Set `QA_GATE_STRICT=1` to make Playwright fail when a row's harness verdict is not `pass`.

## Run order

`precheck.spec.ts` runs first (fail-fast env/API/DB/voice/worker checks). Voice and
assistant specs run late in the Playwright project list so domain fixtures exist.

Recommended full pipeline:

```bash
npm run qa:matrix:run   # doctor → seed → matrix → report → gate
```

## Quick start

```bash
# 1) Seed Tenant A + B (idempotent). Requires read-write DB URL.
E2E_DB_URL_READWRITE=postgres://service-role@... \
  npx tsx e2e/qa-matrix/fixtures/seed.ts

# Copy the printed export lines into your shell (or source .env.qa).

# 2) Export remaining env (see below), then run:
npm run qa:matrix:run

# 3) Open the report:
ls qa/reports/
cat qa/reports/*/QA-REPORT.md
```

## Required env

| Var | Purpose |
|-----|---------|
| `E2E_BASE_URL` | Railway dev web URL |
| `E2E_API_URL` | Railway dev API URL |
| `E2E_DB_URL_READONLY` | Direct PG read connection for Agent C |
| `E2E_DB_URL_READWRITE` | Service-role PG (seeder + DNC/deposit edge rows) |
| `E2E_CLERK_HMAC_SECRET` | Same value deployed API reads as `CLERK_SECRET_KEY` |
| `E2E_TENANT_A_ID` / `E2E_TENANT_A_CUSTOMER_ID` / `E2E_TENANT_A_JOB_ID` | Tenant A fixtures (from seeder) |
| `E2E_TENANT_B_ID` / `E2E_TENANT_B_CUSTOMER_ID` / `E2E_TENANT_B_JOB_ID` | Tenant B fixtures |

**Deploy-side (Railway API):**

- `CLERK_DEV_HMAC_TOKENS=true`
- `AI_PROVIDER_API_KEY` set (voice rows are Real-LLM-only)
- Execution worker running (proposals must reach `executed` after approve)

**Optional:**

- Stripe CLI for `INV-05`/`INV-06` webhook rows
- `QA_RUN_ID` — custom report directory name
- `QA_GATE_STRICT=1` — fail Playwright when harness verdict ≠ pass

See [`.env.qa.example`](../.env.qa.example) for a fill-in template.

## Voice-Critical subset (fast iteration)

```bash
npm run e2e:qa-matrix -- --grep "CUST-02|SCH-02|SCH-03|VOX-01|VOX-02|VOX-03|VOX-05|VOX-11"
npm run qa:matrix:gate -- --voice-only
```

Single row:

```bash
npm run e2e:qa-matrix -- --grep VOX-01
```

## What pass / partial / fail / na mean

- **pass** — API + UI + DB evidence meets the row's Pass Criteria
- **partial** — Substantially met with documented deviation (counts as **fail** on Voice-Critical gate)
- **fail** — Pass Criteria not met; captured in report backlog
- **na** — Could not execute (counts as **fail** on Voice-Critical gate)

## Output layout

```
qa/
├── README.md
├── gate-exceptions.json          # soft-gate waivers (owner, ticket, expiry)
└── reports/
    └── 2026-05-27/
        ├── QA-REPORT.md
        └── artifacts/
            ├── CUST-02/
            │   ├── api/
            │   ├── ui/
            │   ├── db/
            │   └── manifest.json
            └── ...
```

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run qa:doctor` | Preflight env + reachability (full 11 vars) |
| `npm run qa:doctor:bootstrap` | URLs + DB + HMAC secret only (pre-seed) |
| `npm run qa:setup` | One-shot bootstrap (seed → mint → doctor) |
| `npm run qa:matrix:run` | Full pipeline including gate |
| `npm run e2e:qa-matrix` | Matrix only |
| `npm run qa:matrix:gate` | Post-run gate enforcement |
