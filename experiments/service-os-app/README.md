# service-os-app/ — Prototype (NOT production, NOT deployed)

> **Status: experimental prototype. Not the canonical product, not wired
> to any deployment target.**

This is a Next.js 15 prototype (Supabase + Clerk + Deepgram) exploring an
alternative front-of-house for ServiceOS. It is **not** referenced by
`railway.toml`, the root `Dockerfile`, the root `package.json` workspaces,
or any CI workflow — so it ships nowhere today.

## Why it is not production

- **It bypasses the core safety model.** `src/app/api/agent/route.ts`
  writes **directly to Supabase**, skipping the canonical API's
  proposal-approval + audit-event gate that CLAUDE.md mandates ("never
  auto-execute proposals; all mutations emit audit events"). The real
  product routes every mutation through `packages/api`.
- It is internally inconsistent about its backend: a client in
  `src/lib/service-os-api-client.ts` targets the canonical Express API,
  while the agent route writes to Supabase.
- Its schema lives in `/supabase_migration.sql` (run by hand in the
  Supabase SQL editor) — a **second, orphaned** schema unrelated to the
  canonical in-code migrations in `packages/api/src/db/schema.ts`.

## The canonical product

The production app is **`packages/web`** (React/Vite) talking to
**`packages/api`** (Express), deployed via Railway. See
[`/docs/deployment.md`](../docs/deployment.md).

## Before relying on this

Decide explicitly whether to promote or retire it. If promoted, it must be
re-pointed at `packages/api` so all mutations pass through the
proposal/audit gate, and given a real deployment + migration story.
