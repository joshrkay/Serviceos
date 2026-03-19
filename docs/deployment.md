# Deployment Runbook (Railway)

## API startup contract

The API service **must not** run migrations in `startCommand`.

- `startCommand` is reserved for booting the HTTP server only:
  - `node packages/api/dist/src/index.js`
- Health checks remain on:
  - `/ready`

This keeps startup fast and prevents deployments from failing readiness checks while waiting for long-running migrations.

## Migration execution policy

Run database migrations as a **separate one-off/release step** before each API deploy.

Required migration command:

```bash
node packages/api/dist/src/db/migrate.js
```

In CI/CD (GitHub Actions), migrations are executed with Railway CLI before deploying the API service for each environment (`dev`, `staging`, `production`) using:

```bash
railway run --service api --environment <env> -- node packages/api/dist/src/db/migrate.js
```

## Guardrail for future changes

If deployment flow changes in the future, keep these invariants:

1. API `startCommand` starts the server only.
2. Migrations run in a separate one-off/release step.
3. `healthcheckPath` remains `/ready`.

Do not reintroduce migration-gated startup.
