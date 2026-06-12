# Rivet

AI back office for owner-operator home-service shops. The production
system is a TypeScript monorepo deployed on **Railway**.

> Repository directories and npm package names still use the
> `serviceos` / `@serviceos` namespace internally. Renaming those is a
> separate, deliberate refactor (see `docs/launch/2026-06-03-rivet-gtm-brief.md`).

## Repository map

**Canonical product (this is what ships):**

- `packages/api` — backend API (Express, TypeScript). All mutations,
  AI calls, and proposals flow through here.
- `packages/web` — frontend (React, Vite, Tailwind).
- `packages/shared` — shared types, contracts, constants.

**Deployment / ops:**

- `railway.toml`, `Dockerfile` — the live Railway deployment.
- `docs/deployment.md` — deployment runbook.

**Not deployed / experimental — quarantined under
[`experiments/`](experiments/README.md) (see each directory's README before
touching):**

- `experiments/infra/` — AWS CDK stacks. Built, but **nothing deploys
  them**; Railway is the target. See
  [`experiments/infra/README.md`](experiments/infra/README.md).
- `experiments/service-os-app/` — Next.js prototype that bypasses the
  proposal/audit gate. Not production. See
  [`experiments/service-os-app/README.md`](experiments/service-os-app/README.md).
- `experiments/service-os-agent/` — Python LangGraph prototype with known
  defects. Not deployed. See
  [`experiments/service-os-agent/README.md`](experiments/service-os-agent/README.md).
- `experiments/supabase_migration.sql` — schema for the `service-os-app`
  prototype only; unrelated to the canonical in-code migrations
  (`packages/api/src/db/schema.ts`).

## Deployment

- Deployment docs: [`docs/deployment.md`](docs/deployment.md)
