# Production Readiness Scope (confirmed)

**Date:** 2026-05-20  
**Status:** Active — drives the production-readiness TDD agent plan.

## Launch scope

**Private beta** — owner-operator HVAC/plumbing per [serviceos-launch-readiness-design](../superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md).

Out of scope for this tranche unless explicitly re-prioritized:

- Full Phase P7 integrations (QuickBooks, Zapier, feature-flag admin UI)
- Phase P8–P19 expansion epics beyond calling-agent hardening already on main

## Supabase track

**Track 1 + partial Track 2:**

1. **Supabase as Postgres host** — use `DATABASE_URL` pointing at Supabase Postgres; run canonical migrations via `packages/api` only (`npm --prefix packages/api run migrate:apply`).
2. **Do not** apply [supabase_migration.sql](../../experiments/supabase_migration.sql) on the production database (incompatible with [schema.ts](../../packages/api/src/db/schema.ts)).
3. **RLS hardening** — tighten `portal_sessions` policy to `app.portal_token_lookup` instead of permissive unset-tenant reads.
4. **Documentation** — [docs/supabase-host-setup.md](../supabase-host-setup.md) for operators.
5. **Legacy `service-os-app`** — defer full deprecation; document split-brain risk only.

**Not in scope:** Supabase Auth replacing Clerk, Realtime, Storage, or replacing `pg` with `@supabase/supabase-js` in the canonical API/web.

## Verification gates (every story)

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
npm test
npm run test:integration --workspace=packages/api
```

## Agent batching (reference)

| Batch | Stories / work |
|-------|----------------|
| A | Contract freeze F-1/F-2, QA EST-03 / INV-02 / INV-05 (verify), INV-04 |
| B | Web mock-data removal + guard test |
| C | Supabase host docs + portal_sessions migration |
| D | Voice §3B–3E verification tests |
| E | CI `check-coverage`, infra tests, ops runbooks, E2E secret docs |
