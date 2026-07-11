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
2. **Do not** apply the old prototype's `supabase_migration.sql` on the production database — it targeted the `service-os-app` prototype's schema and is incompatible with [schema.ts](../../packages/api/src/db/schema.ts). The prototype and its migration file were removed entirely in 2026-07 (see [`docs/decisions.md`](../decisions.md) D-016); this note is kept as a historical warning in case it resurfaces from git history.
3. **RLS hardening** — tighten `portal_sessions` policy to `app.portal_token_lookup` instead of permissive unset-tenant reads.
4. **Documentation** — [docs/supabase-host-setup.md](../supabase-host-setup.md) for operators.
5. **Legacy `service-os-app`** — removed 2026-07 along with the rest of `/experiments`; split-brain risk is moot.

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
