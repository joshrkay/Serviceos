# ServiceOS

AI service-business operating system. The production system is a TypeScript
monorepo deployed on **Railway**.

## Repository map

**Canonical product (this is what ships):**

- `packages/api` — backend API (Express, TypeScript). All mutations,
  AI calls, and proposals flow through here.
- `packages/web` — frontend (React, Vite, Tailwind).
- `packages/shared` — shared types, contracts, constants.

**Deployment / ops:**

- `railway.toml`, `Dockerfile` — the live Railway deployment.
- `docs/deployment.md` — deployment runbook.

**Not deployed / experimental (see each directory's README before touching):**

- `infra/` — AWS CDK stacks. Built, but **nothing deploys them**; Railway
  is the target. See [`infra/README.md`](infra/README.md).
- `service-os-app/` — Next.js prototype that bypasses the proposal/audit
  gate. Not production. See [`service-os-app/README.md`](service-os-app/README.md).
- `service-os-agent/` — Python LangGraph prototype with known defects. Not
  deployed. See [`service-os-agent/README.md`](service-os-agent/README.md).
- `supabase_migration.sql` — schema for the `service-os-app` prototype
  only; unrelated to the canonical in-code migrations
  (`packages/api/src/db/schema.ts`).

## Deployment

- Deployment docs: [`docs/deployment.md`](docs/deployment.md)
