# ServiceOS Manual QA — 107-item program

Authoritative acceptance criteria and resettable QA tooling for achieving
**107/107 PASS** with verifiable evidence.

> The original Mac-path accounting file
> (`serviceos-full-workflow-accounting-2026-07-25.md`) was not available in
> the cloud agent workspace. This ledger was reconstructed from:
>
> - `docs/beta-verification-runbook.md`
> - `e2e/qa-matrix/matrix.ts` (78 rows)
> - `docs/superpowers/specs/2026-05-24-platform-assessment-and-e2e-qa-50-workflows.md`
> - The 22-section dependency order from the 2026-07-25 QA goal

## Deliverables in this directory

| File | Purpose |
|------|---------|
| `ACCEPTANCE-CRITERIA.md` | Human-readable 107-item binary PASS/FAIL criteria |
| `acceptance-criteria-ledger.json` | Full structured criteria |
| `catalog.json` | Compact ID index for tooling |
| `execution-ledger.json` | Live status ledger (updated as tests run) |
| `fixture-manifest.json` | Created by `npm run qa:full:seed` (gitignored locally if secrets) |
| `DEFECT-LOG.md` | Defects found → fix → deploy → rerun |
| `DEPLOYMENT-MANIFEST.md` | Commit SHAs + Railway deployment IDs |
| `FINAL-REPORT.md` | Filled when PASS=107 / FAIL=0 |
| `REPRODUCTION.md` | How another tester resets and reruns all 107 |

Evidence lives in `/qa-evidence/` (recordings gitignored; manifest tracked when redacted).

## Quick start (Railway Development / dedicated QA)

```bash
# 1) Fill secrets locally (never commit)
cp .env.qa.example .env.qa
# Set E2E_DB_URL_READWRITE from Railway Postgres DATABASE_PUBLIC_URL
# Set E2E_CLERK_HMAC_SECRET = Railway API CLERK_SECRET_KEY
# Ensure Railway API has CLERK_DEV_HMAC_TOKENS=true (Development only)

# 2) Seed three tenants + fixtures
export QA_TARGET_ENV=development
export E2E_DB_ALLOW_UNSAFE=1   # only after confirming NOT production
npm run qa:full:seed
source .env.qa.full.local

# 3) Mint role JWTs
npm run qa:full:mint
source .env.qa.full.tokens

# 4) Preflight
npm run qa:full:preflight

# 5) Init evidence dirs
npm run qa:evidence:init -- --all

# 6) Execute QA-001…QA-107 in section order (see ACCEPTANCE-CRITERIA.md)
#    For each ID: record → run → API/DB assert → hard refresh → mark ledger

# 7) Reset between major sections / full reruns
export QA_RESET_CONFIRM=reset-qa-full
npm run qa:full:reset
npm run qa:full:seed
```

## Tenant legend

| Tenant | Purpose |
|--------|---------|
| **A** | Primary full-lifecycle workflows |
| **B** | Cross-tenant isolation / negative authz |
| **C** | Fresh onboarding / interrupted onboarding |

Roles on A: owner, dispatcher, technician. B: owner (+ technician). C: owner only.

## Safety rules

- Never seed/reset production customer data.
- Reset deletes only `owner_id LIKE 'qa:qa-full:%'`.
- Requires `QA_RESET_CONFIRM=reset-qa-full`.
- Evidence must redact tokens, passwords, payment PANs, live customer PII.
- “Not testable” = **FAIL** (never SKIPPED/ASSUMED/BLOCKED as success).
- Unit tests alone never count as PASS.

## Regenerating the ledger

```bash
node scripts/generate-qa-107-ledger.mjs
```

Must emit exactly 107 items or exit non-zero.
