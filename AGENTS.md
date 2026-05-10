# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

ServiceOS is an AI-powered field service management platform (monorepo with npm workspaces). See `CLAUDE.md` for architectural rules, `docs/local-dev-voice.md` for the voice pipeline dev guide, and `README.md` / `docs/deployment.md` for deployment.

### Services

| Service | Command | Port | Notes |
|---|---|---|---|
| API (Express) | `cd packages/api && npm run dev` | 3000 | Boots in InMemory mode without `DATABASE_URL`. Health: `/health`, Swagger: `/api-docs` |
| Web (Vite/React) | `cd packages/web && npm run dev` | 5173 | Proxies `/api` to the API. Requires `VITE_CLERK_PUBLISHABLE_KEY` in `packages/web/.env.local` for the Clerk auth gate |

### Environment files (not committed)

- `packages/api/.env` — copy from `packages/api/.env.example`. Set `NODE_ENV=dev` for local dev (already defaulted in the example).
- `packages/web/.env.local` — copy from `packages/web/.env.example`. Needs a real `VITE_CLERK_PUBLISHABLE_KEY` for the browser UI to render past the auth gate.

### Lint / typecheck / test

- **Build typecheck (mandatory before commits):** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` — uses the Railway deploy tsconfig, not the default that includes test files.
- **API lint:** `cd packages/api && npm run lint` (runs log-safety check + tsc via `tsconfig.lint.json`)
- **Web lint:** `cd packages/web && npm run lint` (tsc `--noEmit`)
- **API unit tests:** `cd packages/api && npm test` (Vitest, no Docker needed — integration tests excluded by default)
- **Web unit tests:** `cd packages/web && npm test` (Vitest with jsdom)
- **Integration tests:** `cd packages/api && npm run test:integration` (requires Docker for Testcontainers/PostgreSQL)

### QA runner harness

The `qa-runner/` directory contains an automated test harness for beta verification. See `docs/verification-runs/RUN-INSTRUCTIONS.md` for the full procedure. Key commands:
- `npm run qa:doctor` — prints env readiness
- `npm run qa:smoke-tools` — 3-check sanity probe (health, UI, DB)
- `npm run qa:run` — runs all 65 test cases from `qa-runner/config/test-plan.json`
- `npm run qa:report` — writes `qa-runner/reports/summary.md`

Required env vars: `BASE_URL`, `API_URL`, `AUTH_BEARER_TOKEN`. For cross-tenant isolation: also `TENANT_B_TOKEN` + `TENANT_A_*_ID` vars. See `qa-runner/config/env.example`.

### Gotchas

- `NODE_ENV` is **not set** in the `.env.example` default — it reads as `undefined` at startup. The API still boots fine (InMemory mode), but `validateFeatureRequiredConfig()` only enforces external keys in `prod`/`staging`, so dev mode is permissive.
- The web app (`main.tsx`) hard-crashes at module load if `VITE_CLERK_PUBLISHABLE_KEY` is missing or is the literal placeholder from `.env.example`. A real Clerk test key is needed for browser-based UI testing.
- The voice CLI harness (`scripts/test-voice.ts`) is the fastest way to exercise the core voice-to-action pipeline without any external credentials. Use `MOCK_RESPONSES` env var to script LLM outputs (see `docs/local-dev-voice.md` Path A).
- `packages/shared` exists on disk but is **not** in the npm workspaces array — it's consumed via relative imports, not as a workspace dependency.
- The punycode deprecation warning from Node 22 is cosmetic and does not affect functionality.
- The QA runner's redaction scanner may false-positive on phone numbers in test bodies (e.g., PORTAL-003/004). The `+1555*` test patterns trigger it.
