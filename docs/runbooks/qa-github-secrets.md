# GitHub Actions secrets for QA matrix CI

Manifest for repository secrets used by `.github/workflows/qa-matrix-gate.yml`
and `.github/workflows/qa-runbook.yml`. Operators provision these manually —
there is no Railway → GitHub auto-sync.

Canonical bootstrap: [qa-full-matrix-unblock.md](./qa-full-matrix-unblock.md).

## Secret checklist

| GitHub secret | Source of truth | Static vs rotated | Verification |
|---------------|-----------------|-------------------|--------------|
| `E2E_BASE_URL` | Railway → web → Networking | Static per environment | `curl -sf "$E2E_BASE_URL" -o /dev/null` |
| `E2E_API_URL` | Railway → API → Networking | Static per environment | `curl -sf "$E2E_API_URL/health"` |
| `E2E_DB_URL_READWRITE` | Railway → Postgres → `DATABASE_PUBLIC_URL` | Rotates on password reset | `npm run qa:doctor:bootstrap` DB probe |
| `E2E_DB_URL_READONLY` | Postgres `qa_readonly` role URL, or same as RW | Rotates with role password | Doctor readonly probe |
| `E2E_CLERK_HMAC_SECRET` | Railway → API → `CLERK_SECRET_KEY` | Rotates with Clerk key rotation | Doctor HMAC length + setup HMAC probe |
| `E2E_TENANT_A_ID` | `e2e/qa-matrix/fixtures/seed.ts` output | Static until DB re-seeded | `npm run qa:doctor` tenant check |
| `E2E_TENANT_A_CUSTOMER_ID` | Matrix seed output | Static until re-seed | Doctor |
| `E2E_TENANT_A_JOB_ID` | Matrix seed output | Static until re-seed | Doctor |
| `E2E_TENANT_B_ID` | Matrix seed output | Static until re-seed | Doctor |
| `E2E_TENANT_B_CUSTOMER_ID` | Matrix seed output | Static until re-seed | Doctor |
| `E2E_TENANT_B_JOB_ID` | Matrix seed output | Static until re-seed | Doctor |

**Total: 11 secrets** — identical set for matrix gate and full runbook workflows.

### Obtaining tenant UUID secrets

After `npm run qa:setup` or `npx tsx e2e/qa-matrix/fixtures/seed.ts`:

```bash
E2E_DB_URL_READWRITE='postgres://…' npx tsx e2e/qa-matrix/fixtures/seed.ts
# Copy the six export lines into GitHub → Settings → Secrets → Actions
```

Re-seeding is idempotent (`qa-matrix-A` / `qa-matrix-B` owner_ids); UUIDs stay
stable unless tenants were deleted from Postgres.

### Deploy-side (not GitHub secrets)

| Railway API variable | Value | Why |
|---------------------|-------|-----|
| `CLERK_DEV_HMAC_TOKENS` | `true` | Enables HMAC JWT verification on dev/staging |
| `CLERK_SECRET_KEY` | (Clerk dashboard) | Must match `E2E_CLERK_HMAC_SECRET` in GitHub |

## Workflows

### QA Matrix Gate (`qa-matrix-gate.yml`)

- **Triggers:** nightly `0 2 * * *` UTC, `workflow_dispatch`
- **Timeout:** 90 minutes
- **Steps:** doctor → matrix seed → `e2e:qa-matrix` → gate → upload `qa/reports/`
- **Manual rerun:** Actions → QA Matrix Gate → Run workflow

### QA Runbook (`qa-runbook.yml`)

- **Triggers:** `workflow_dispatch` only (not on PR)
- **Timeout:** 120 minutes
- **Steps:** doctor → `npm run qa:runbook` → upload qa-runner + matrix + Playwright artifacts
- **Manual run:** Actions → QA Runbook → Run workflow

Neither workflow is a required PR check.

## Local verification before wiring CI

```bash
source .env.qa
npm run qa:setup
npm run qa:doctor        # expect all OK
```

Compare local `E2E_TENANT_*` values to GitHub secrets; update any drift.

## Related secrets (other workflows)

These are **not** used by `qa-matrix-gate.yml` but appear in journey/e2e CI:

| Secret | Workflow | Purpose |
|--------|----------|---------|
| `E2E_CLERK_PUBLISHABLE_KEY` | `e2e.yml` | Clerk testing mode UI |
| `E2E_CLERK_SECRET_KEY` | `e2e.yml` | Clerk testing mode |
| `VITE_CLERK_PUBLISHABLE_KEY` | web build | Same pk as above |

See [clerk-testing-tokens-runbook.md](../../qa/reports/2026-05-11/clerk-testing-tokens-runbook.md).
