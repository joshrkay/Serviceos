---
title: "RLS-exempt tenant tables are deliberate — recognize the read-before-tenant-context pattern before adding a policy"
date: 2026-06-25
track: knowledge
problem_type: architecture-patterns
module: packages/api/src/db
tags: ["rls", "tenant-isolation", "postgres", "oauth", "security", "migrations"]
related: ["docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md"]
---

## Context

Almost every table here carries `tenant_id` + an RLS policy
(`tenant_id = current_setting('app.current_tenant_id')::uuid`). It's tempting,
when "closing RLS coverage gaps", to add that policy to *every* `tenant_id`
table. That is wrong for a small set of tables that are **deliberately
RLS-exempt** — and adding a policy to one of them ships a latent outage.

This was hit on 2026-06-25: a migration put `oauth_states` under `FORCE ROW
LEVEL SECURITY`. It passed CI (the app connects as a `BYPASSRLS` superuser, so
RLS is inert) but would have broken **every OAuth callback** the moment the app
ran under a non-bypass role — which is the explicit end-state of the
RLS-runtime-role feature being built in the same change.

## Guidance

Before adding `ENABLE/FORCE ROW LEVEL SECURITY` + a `tenant_isolation_*` policy
to a `tenant_id` table, do two checks:

1. **Check the exemption allowlist tests.** `packages/api/test/db/schema.test.ts`
   pins `RLS_EXEMPT_TABLES` (currently `oauth_states`, `platform_deprovision_log`)
   and `packages/api/test/integration/rls-runtime-audit.test.ts` pins the same.
   If the table is listed there, it is exempt **on purpose** — read the comment
   for the rationale before touching it. (These tests assert "every tenant table
   has FORCE RLS *except* the allowlist", so they do NOT fail if you wrongly ADD
   a policy to an exempt table — they only catch a *missing* one. The allowlist
   is documentation of intent, not a tripwire against over-coverage.)

2. **Trace the table's READ access pattern.** A `current_tenant_id` policy
   requires the GUC to be set *before* the read. A table is exempt when a read
   path **discovers** the tenant from the row instead of being scoped by it.
   The tell: a repo method that uses raw `pool.query(...)` (NOT `withTenant`)
   and `RETURNING tenant_id` — it recovers the tenant from an unguessable
   capability (a nonce/token), because the caller doesn't know the tenant yet.

   ```ts
   // CalendarOauthStateRepository.consume() — OAuth /callback, NO tenant context:
   // the nonce id IS the capability; the row hands back the tenant_id.
   await this.pool.query(
     `UPDATE oauth_states SET ... WHERE id = $1
      RETURNING tenant_id, user_id, provider, redirect_after`, [id]);
   ```
   An RLS policy keyed on `app.current_tenant_id` would filter this to 0 rows
   (GUC unset → the `::uuid` cast on `''` even throws), breaking the callback.

If a table has BOTH a tenant-scoped path (`withTenant`) AND a
discover-the-tenant path (raw `pool.query`, returns `tenant_id`), the
discover path wins: it must stay RLS-exempt. Isolation for these tables comes
from the unguessable id (a capability), exactly like the public estimate/invoice
view-token `SECURITY DEFINER` functions.

## Why This Matters

The exemption is invisible under today's `BYPASSRLS` connection principal — a
wrong policy "works" in dev/CI and only breaks once enforcement is real (the
RLS-runtime-role rollout, or any move off a bypass principal). That's the worst
kind of latent bug: green now, outage later, in a flow (OAuth callbacks) that
isn't on the common test path. Recognizing the access pattern up front avoids
shipping it.

## When to Apply

- Authoring any migration that adds RLS to a `tenant_id` table ("closing a
  coverage gap").
- Reviewing a diff that adds `ENABLE/FORCE ROW LEVEL SECURITY` or a
  `tenant_isolation_*` policy.
- Building anything that drops the app to a non-`BYPASSRLS` role
  (see `docs/runbooks/rls-runtime-role-rollout.md`).

## Examples

The two current exemptions and *why* (recorded as `COMMENT ON TABLE` in
migration 218 and in the allowlist tests):

- **`oauth_states`** — OAuth state nonces; `consume()` reads the row to recover
  `tenant_id` in the provider callback, before any tenant context exists.
- **`platform_deprovision_log`** — ops/audit log, no tenant FK, written via the
  privileged connection, must survive a tenant purge.

How both bugs in this episode were caught (and a process note): the wrong
`oauth_states` policy was found by **code review** tracing the real access
path, and confirmed by the **full Docker-gated integration suite**
(`npm run test:integration`, which includes `rls-runtime-audit.test.ts`). The
original change had run only the targeted integration test, not the full suite —
the exemption guard lives in a file that the shortcut skipped. For DB-touching
changes, run the whole integration suite, not just the new test.
