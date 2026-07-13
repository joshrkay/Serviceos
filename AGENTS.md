# AGENTS.md

General product/architecture orientation lives in `README.md`, `CLAUDE.md`,
and `docs/architecture.md`. This file only adds cloud-agent-specific setup and
run guidance.

## Cursor Cloud specific instructions

Monorepo (npm workspaces): `packages/api` (Express API, port 3000),
`packages/web` (React/Vite, port 5173), `packages/shared`. `packages/mobile`
(Expo) and `packages/voice-eval` are not workspace members.

### Environment / Node
- The update script runs `npm ci` at the repo root (installs api/web/shared).
- Repo `.nvmrc` pins Node 20, but the VM's default `node` is `/exec-daemon/node`
  (v22.x) and takes PATH precedence over nvm even after `nvm use`. Everything
  (lint, tests, prod typecheck, dev servers) works on it. `npm ci` prints a
  harmless `EBADENGINE` warning for `posthog-node` (wants `^20.20.0 || >=22.22.0`);
  ignore it. Node 20 is installed via nvm (`nvm use 20`) if you ever need an
  exact match.
- `packages/mobile` is isolated; run its own `npm install` inside that dir if
  you need it (not covered by the root install).

### Running API + web without Postgres/Clerk (the normal dev path here)
The authoritative recipes are the verify skills — read them before booting:
`packages/api/.claude/skills/verify/SKILL.md` and
`packages/web/.claude/skills/verify/SKILL.md`. Key points:
- API boots with **no `DATABASE_URL`** → in-memory repos (data does NOT persist
  across restarts) and a stub LLM/mock payments. Boot:
  `cd packages/api && NODE_ENV=dev DEV_AUTH_BYPASS=true PORT=3000 LOG_LEVEL=info TELEPHONY_ENABLED=false EMAIL_ENABLED=false STORAGE_ENABLED=false node -r ts-node/register src/index.ts`
  Health at `http://localhost:3000/health` (ready in ~15-20s).
- Web needs a git-ignored `packages/web/.env.local` with `VITE_AUTH_MODE=dev`
  (plus a placeholder `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL=http://localhost:3000`,
  `VITE_DEV_AUTH_SUB=dev_owner`, `VITE_DEV_AUTH_ROLE=owner`). This file is
  already present from setup. Boot: `cd packages/web && VITE_AUTH_MODE=dev npx vite --port 5173 --host 127.0.0.1`.
- The dev-auth shim and the API bypass share one identity (`sub=dev_owner`), so
  data seeded over HTTP is visible in the UI. Seed representative data with
  `cd packages/api && node scripts/verify-seed.mjs` (run AFTER the API is up and
  do not restart the API between seeding and driving the UI — in-memory only).
- A "What's new" modal opens on first web load; dismiss with "Got it".

### Lint / test / build (commands live in the root + package `package.json`)
- Lint: `npm run lint --workspace=packages/web` and `--workspace=packages/api`.
- Prod build typecheck (mandatory before pushing, per CLAUDE.md):
  `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
  (the default `tsconfig.json` includes tests and is NOT sufficient).
- Unit tests: `npm run test` (runs each workspace's `vitest run`).
- API integration/RLS tests (`npm run test:integration` / `test:rls`) use
  testcontainers by default (needs a Docker daemon, which is NOT installed
  here). Instead, this VM has PostgreSQL 16 + pgvector installed via apt, and
  `test/integration/global-setup.ts` honors `EXTERNAL_TEST_DB_URL` to skip
  testcontainers entirely. To run them:
  1. Start Postgres (it does not auto-start on boot):
     `sudo pg_ctlcluster 16 main start`
  2. Use a FRESH database each run (migrations are not re-runnable on a
     populated DB): `sudo -u postgres psql -c "DROP DATABASE IF EXISTS serviceos_test; CREATE DATABASE serviceos_test;"`
  3. `cd packages/api && EXTERNAL_TEST_DB_URL="postgresql://postgres:postgres@127.0.0.1:5432/serviceos_test" npm run test:integration`
  The connecting role must be a superuser (the `postgres` role, password
  `postgres`, is). pgvector is required by migration 062.
