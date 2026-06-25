# Unblock the full QA matrix (QA-008)

One-page operator guide for going from zero local env to a green
`npm run qa:doctor` and then running either the **matrix-only** or
**full beta runbook** path.

## Prerequisites

| Item | Where to get it | Notes |
|------|-----------------|-------|
| `E2E_BASE_URL` | Railway → web service → Networking | e.g. `https://serviceosweb-development.up.railway.app` |
| `E2E_API_URL` | Railway → API service → Networking | e.g. `https://serviceosapi-development.up.railway.app` |
| `E2E_DB_URL_READWRITE` | Railway → Postgres → `DATABASE_PUBLIC_URL` | Service-role; used by seed scripts |
| `E2E_DB_URL_READONLY` | Same host, `qa_readonly` role if available | ISO-01 RLS probe; defaults to READWRITE if unset |
| `E2E_CLERK_HMAC_SECRET` | Railway → API → `CLERK_SECRET_KEY` | Copy the **value**, not a reference |
| `CLERK_DEV_HMAC_TOKENS=true` | Railway → API → Variables | **Deploy-side** flag; without it minted JWTs return 401 |
| GitHub `E2E_*` secrets | See [qa-github-secrets.md](./qa-github-secrets.md) | Required for nightly `qa-matrix-gate.yml` CI |

Optional deploy flags for voice/matrix rows: `AI_PROVIDER_API_KEY`, execution worker running.

## Quick start (~15 min dashboard + one command)

```bash
cp .env.qa.example .env.qa
# Uncomment and fill E2E_DB_URL_READWRITE + E2E_CLERK_HMAC_SECRET in .env.qa

npm run qa:setup          # auto-sources .env.qa; seed → mint → doctor

npm run qa:matrix:run     # auto-sources .env.qa + .env.qa.local
# OR
npm run qa:runbook
```

`npm run` scripts auto-source `.env.qa` — no need to `source .env.qa` first.
After `qa:setup`, matrix tenant UUIDs are written to `.env.qa.local`.

Mid-bootstrap (secrets filled, tenants not seeded yet):

```bash
npm run qa:doctor:bootstrap   # URLs + DB + HMAC secret only
```

## Matrix vs full runbook

| Path | Command | Time | Artifacts | When to use |
|------|---------|------|-----------|-------------|
| **Matrix only** | `npm run qa:matrix:run` | ~30–60 min | `qa/reports/*/QA-REPORT.md`, Playwright HTML | Nightly gate, tenant isolation, voice rows |
| **Full beta** | `npm run qa:runbook` | ~90–120 min | Above + `qa-runner/reports/` | Pre-release sign-off, §1–17 API/UI stages |

Both paths share the same bootstrap (`npm run qa:setup`). Setup seeds **two**
fixture sets against the same Postgres:

- **Journey** (`e2e/fixtures/seed-journey-fixtures.ts`) — `qa-journey-*` tenants;
  IDs written to `e2e/fixtures/.journey-fixtures.env`; used by qa-runner
  (`AUTH_BEARER_TOKEN` minted against these UUIDs).
- **Matrix** (`e2e/qa-matrix/fixtures/seed.ts`) — `qa-matrix-*` tenants;
  IDs exported as `E2E_TENANT_*` for Playwright matrix + full doctor.

The UUIDs differ by design. Do not mix journey IDs into matrix env or vice versa.

## Required env vars (full doctor)

All checked by `scripts/qa-matrix-doctor.ts`:

| Variable | Purpose |
|----------|---------|
| `E2E_BASE_URL` | Web deploy reachability |
| `E2E_API_URL` | API `/health` |
| `E2E_DB_URL_READONLY` | Agent C DB reads |
| `E2E_DB_URL_READWRITE` | Seed scripts |
| `E2E_CLERK_HMAC_SECRET` | HMAC JWT signing |
| `E2E_TENANT_A_ID` / `E2E_TENANT_A_CUSTOMER_ID` / `E2E_TENANT_A_JOB_ID` | Matrix Tenant A |
| `E2E_TENANT_B_ID` / `E2E_TENANT_B_CUSTOMER_ID` / `E2E_TENANT_B_JOB_ID` | Matrix Tenant B |

Bootstrap mode (`npm run qa:doctor:bootstrap`) checks only the first five.

## Troubleshooting

### `E2E_DB_URL_READWRITE` empty or not set

`.env.qa` still has commented-out placeholders from `.env.qa.example`.
Uncomment and paste real Railway values:

```bash
export E2E_DB_URL_READWRITE="postgres://…@shinkansen.proxy.rlwy.net:…/railway"
export E2E_CLERK_HMAC_SECRET="sk_test_…"
```

Do **not** use `export VAR=""` — empty strings block URL defaults and fail
with a confusing "not set" error.

### HMAC probe returns 401

`GET $E2E_API_URL/api/me` with a minted bearer token must return **200** before
matrix or runbook execution.

1. **`CLERK_DEV_HMAC_TOKENS=true`** not set on the deployed API (Railway →
   Variables → redeploy).
2. **`E2E_CLERK_HMAC_SECRET` drift** — must equal the API's `CLERK_SECRET_KEY`.
3. **`NODE_ENV=production`** on the API — HMAC dev path is refused in prod.

See `packages/api/src/auth/clerk.ts` (~line 347).

### Stale tenant IDs

Re-run `npm run qa:setup` (idempotent seeds). Matrix IDs are re-exported to
your shell; update GitHub secrets if CI tenant UUIDs changed (see
[qa-github-secrets.md](./qa-github-secrets.md)).

### RLS / `qa_readonly` missing

ISO-01 rows need a read-only Postgres role. On a fresh DB clone, create
`qa_readonly` per [qa/backlog/ISO-01-rls-probe-role.md](../../qa/backlog/ISO-01-rls-probe-role.md).
Until then, set `E2E_DB_URL_READONLY` to the read-write URL (ISO-01 may partial).

### API 502 / unreachable

Run `npm run qa:doctor:bootstrap` — checks `E2E_BASE_URL` and `E2E_API_URL/health`.
Confirm Railway services are deployed and URLs match Networking tab.

### Stripe optional rows

`INV-05` / `INV-06` need Stripe CLI locally; absent CLI → rows marked `na`.
Not required for gate bootstrap.

## CI

- **Nightly matrix gate:** `.github/workflows/qa-matrix-gate.yml` (schedule +
  `workflow_dispatch`). Secrets: [qa-github-secrets.md](./qa-github-secrets.md).
- **Manual full runbook:** `.github/workflows/qa-runbook.yml` (`workflow_dispatch`
  only; not a required PR check).

## Deep dives

- [qa-matrix-live-runbook.md](../../qa/reports/2026-05-11/qa-matrix-live-runbook.md) — matrix appendices
- [clerk-testing-tokens-runbook.md](../../qa/reports/2026-05-11/clerk-testing-tokens-runbook.md) — Clerk UI journeys
- [qa-runner/README.md](../../qa-runner/README.md) — §1–17 stages
- [qa/README.md](../../qa/README.md) — matrix harness overview
- [`.env.qa.example`](../../.env.qa.example) — local env template
