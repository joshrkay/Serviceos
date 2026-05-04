# QA Runner (Model 2)

This runner executes four-agent style checks (API/UI/DB + assembler) and produces evidence + summary reports.

## What this now includes

- Stage gating (`assistant` runs only when dependent stages pass)
- Real CLI filters (`--stage`, `--test`)
- Env prerequisite checks (`qa:doctor`)
- API checks with templated payload support (`{{timestamp}}`, `{{rand4}}`)
- Optional auth header (`AUTH_BEARER_TOKEN`)
- UI evidence:
  - Playwright screenshot if `playwright` package is available
  - HTML snapshot fallback if browser tooling is unavailable
- DB checks through configurable `DB_CHECK_COMMAND`

## Quick start (takeover flow)

1. Set env vars:

```bash
export BASE_URL=https://serviceosweb-development.up.railway.app
export API_URL=https://serviceosapi-development.up.railway.app
# Required for authenticated API cases:
# export AUTH_BEARER_TOKEN=...
# Optional DB verifier command:
# export DB_CHECK_COMMAND='psql "$DATABASE_URL_READONLY" -c'
```

2. Validate setup:

```bash
npm run qa:doctor
```

3. Run smoke checks:

```bash
npm run qa:smoke-tools
```

4. Run full staged plan or narrowed scope:

```bash
npm run qa:run
npm run qa:run -- --stage estimates
npm run qa:run -- --test EST-CREATE-CUSTOMER
```

5. Build summary:

```bash
npm run qa:report
```

Outputs:
- Artifacts: `qa-runner/artifacts/*`
- Test rows: `qa-runner/reports/test_results.json`
- Summary: `qa-runner/reports/summary.md`

## Phase 12 — Mode switching launch gate

Per-PR gate (lightweight, no LLM): `packages/api/test/integration/mode-switch-no-bleed.test.ts` runs in CI on every push.

Soak / launch-gate (real LLM, opt-in): `qa-runner/scenarios/concurrent-supervisor.md` documents the 4-concurrent-session × 50-mode-flip scenario. Gated by `ENABLE_REAL_LLM_HARNESS=1` + `LLM_BUDGET_USD_CEIL` to prevent runaway cost. See that file for env + invariants.
