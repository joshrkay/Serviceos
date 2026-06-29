---
title: "Self-degrading migrations: provision privileged objects without bricking deploys on managed Postgres"
date: 2026-06-26
track: knowledge
problem_type: architecture-patterns
module: packages/api/src/db/schema.ts
tags: ["postgres", "migrations", "roles", "grants", "bypassrls", "managed-postgres", "graceful-degradation", "idempotent"]
related:
  - docs/solutions/architecture-patterns/required-vs-optional-db-role-at-boot.md
  - docs/solutions/test-failures/shared-db-integration-test-grant-pollution.md
---

## Context
This repo's migration runner re-executes **every** migration on **every** boot
(there is no applied-migrations ledger; statements are written idempotent —
`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.). That's fine for
DDL the app's DB principal owns. But some provisioning needs privileges that
**managed Postgres often withholds** from the app principal:
- `CREATE ROLE` needs `CREATEROLE`.
- `CREATE ROLE … BYPASSRLS` / `ALTER ROLE … BYPASSRLS` needs **SUPERUSER**.
- `REVOKE`/`GRANT` on an object you don't own, `CREATE EXTENSION`, `ALTER SYSTEM`.

If such a statement runs unguarded and the principal lacks the privilege, it
raises (`42501 insufficient_privilege`) and — because the runner re-runs all
migrations on every boot — **bricks every deploy**, not just the first.

## Guidance
Wrap privileged provisioning in a `DO` block that catches the privilege error,
logs a `NOTICE`, and lets the deploy continue. The feature ships **dormant** and
an admin activates it later by provisioning the object once (runbook fallback).

```sql
DO $rls$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_app_runtime') THEN
    CREATE ROLE rls_app_runtime NOLOGIN;          -- needs CREATEROLE
  END IF;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_app_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rls_app_runtime;
  EXECUTE format('GRANT rls_app_runtime TO %I', current_user);  -- self-membership
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'rls_app_runtime not provisioned (insufficient privilege); stays disabled until an admin provisions it';
END
$rls$;
```

Three companion pieces make the pattern complete:
1. **Idempotent guards** inside the block (`IF NOT EXISTS … CREATE ROLE`) so an
   admin-pre-created object doesn't make the re-run throw `duplicate_object`.
2. **A runbook admin-fallback** — the exact SQL an admin/superuser runs once when
   the migrate principal can't (see `docs/runbooks/rls-runtime-role-rollout.md`).
3. **A boot probe that fails closed on the REQUIRED capability** (so you never
   serve with a security feature silently half-applied) but degrades on
   optional ones — see the related boot-probe doc.

## Why This Matters
A migration that hard-fails on a privilege the principal lacks doesn't fail
"once" — the ledger-less runner re-runs it on every boot, so the whole service
can't start. Self-degrading provisioning lets a security/infra feature land in
code, ship dormant on environments that can't provision it, and switch on the
moment an admin does — with no code redeploy and no risk to unrelated deploys.

## When to Apply
Any migration that needs a privilege the app's DB principal may not hold:
`CREATE ROLE`, `… BYPASSRLS` (SUPERUSER), `CREATE EXTENSION`, `ALTER SYSTEM`,
or `GRANT`/`REVOKE` on objects of uncertain ownership. Pair every one with a
runbook fallback and a test that asserts the **end state**, not just that the
migration "ran".

## Examples
- `MIGRATIONS['217_create_rls_app_runtime_role']` — CREATEROLE-gated role +
  grants, `EXCEPTION WHEN insufficient_privilege`.
- `MIGRATIONS['220_create_rls_cross_tenant_role']` — SUPERUSER-gated
  (`CREATE ROLE … BYPASSRLS`), same self-degrading shape.
- `MIGRATIONS['219_rls_app_runtime_revoke_exempt']` — dynamic `REVOKE` loop with
  `EXCEPTION WHEN undefined_object` (role absent) `/ insufficient_privilege`.

### Caveat — one EXCEPTION around a multi-statement block swallows partial failures
A single handler wrapping the whole `DO` block means if statement *k* raises, the
block jumps to the handler and statements *k+1…n* are **skipped**, yet the
migration reports success (a `NOTICE`, not an error). That's acceptable here
because **one** migrate principal owns all `public` tables, so the grant/revoke
either all-succeed or all-fail together. If objects could have split ownership,
either scope the EXCEPTION per statement or — better — **pin the end state with a
real-Postgres integration test** (e.g. the migration-219 deny-list test) so a
silently-partial run is caught. A migration that "succeeded with a NOTICE" is not
proof the privileged change actually took effect; only the catalog is.
