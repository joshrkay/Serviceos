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

### Starting the API with environment variables

The API does **not** auto-load `.env` files (no dotenv). You must export variables before running, or prefix the command:

```bash
NODE_ENV=dev PORT=3000 CLERK_SECRET_KEY=$CLERK_SECRET_KEY \
  CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY \
  DEV_AUTH_BYPASS=true \
  npm run dev
```

The web server (Vite) **does** auto-load `packages/web/.env.local`.

### Clerk authentication in dev

- **Browser UI**: Requires `VITE_CLERK_PUBLISHABLE_KEY` in `packages/web/.env.local`. The Clerk SDK validates it against their backend — the placeholder from `.env.example` is rejected.
- **API auth (production path)**: Uses RS256 JWT verification via JWKS fetched from Clerk's `/.well-known/jwks.json`. Requires `CLERK_PUBLISHABLE_KEY` env var on the API.
- **API auth (dev bypass)**: Set `DEV_AUTH_BYPASS=true` + `NODE_ENV=dev`. This skips JWT signature verification, decodes the token body directly, and auto-bootstraps a tenant per user. Useful for API-level testing without real Clerk sessions.
- **Browser sign-in for testing**: Use the Clerk Backend API to create a sign-in token, then navigate to the token URL with `redirect_url=http://localhost:5173/`:
  ```bash
  curl -X POST https://api.clerk.com/v1/sign_in_tokens \
    -H "Authorization: Bearer $CLERK_SECRET_KEY" \
    -H "Content-Type: application/json" \
    -d '{"user_id": "<user_id>", "expires_in_seconds": 7200}'
  ```
  Then open: `https://<clerk-domain>/sign-in?__clerk_ticket=<token>&redirect_url=http://localhost:5173/`
- **Creating test users**: Use `POST https://api.clerk.com/v1/users` with the secret key to create users with pre-verified emails (bypasses email verification).

### Gotchas

- `NODE_ENV` is **not set** in the `.env.example` default — reads as `undefined`. The API boots fine (InMemory mode), but `validateFeatureRequiredConfig()` only enforces external keys in `prod`/`staging`.
- The web app (`main.tsx`) hard-crashes at module load if `VITE_CLERK_PUBLISHABLE_KEY` is missing or invalid.
- The voice CLI harness (`scripts/test-voice.ts`) is the fastest way to test the voice-to-action pipeline without external credentials. Use `MOCK_RESPONSES` env var (see `docs/local-dev-voice.md` Path A).
- `packages/shared` exists on disk but is **not** in the npm workspaces array — consumed via relative imports.
- The punycode deprecation warning from Node 22 is cosmetic.
- In InMemory mode, customer/job detail pages may show "not found" errors due to tenant context mismatches between the Clerk-authenticated browser session and the `DEV_AUTH_BYPASS` auto-bootstrap. This resolves with a Postgres-backed environment.
- The QA runner's redaction scanner may false-positive on phone numbers in test bodies (e.g., PORTAL-003/004).
