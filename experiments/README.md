# experiments/ — Quarantined non-production architectures

Everything in this directory is **NOT deployed and NOT production**. These
are experimental prototypes and abandoned alternatives, kept for reference
only. Do not run, deploy, or build on them as if they were the product.

The **only** deploy target for ServiceOS is **Railway**, defined by
`/railway.toml` + `/Dockerfile` at the repo root, which build and run the
canonical product in `/packages` (api, web, shared). See
`/docs/deployment.md`.

## Contents

- `infra/` — AWS CDK stacks (Fargate/RDS/S3/SQS). Well-formed but deployed
  by nothing; the ECR image it references is never pushed by CI.
- `service-os-app/` — Next.js prototype that writes directly to Supabase,
  bypassing the canonical proposal-approval/audit gate.
- `service-os-agent/` — Python LangGraph prototype with known defects:
  an **unauthenticated `/process` endpoint** and a **`NameError` crash at
  `clients/service_os_api.py:146`** (missing `import json`). Do not deploy.
- `supabase_migration.sql` — schema for the `service-os-app` prototype
  only; unrelated to the canonical in-code migrations
  (`packages/api/src/db/schema.ts`).

Each subdirectory has its own README with full details on why it is not
production.
