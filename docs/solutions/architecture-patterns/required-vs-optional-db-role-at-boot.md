---
title: "Don't gate a security rollout on a SUPERUSER-only audit role: required vs optional capabilities at boot"
date: 2026-06-26
track: knowledge
problem_type: architecture-patterns
module: packages/api/src/db/rls-runtime-role.ts
tags: ["rls", "postgres", "roles", "bypassrls", "boot-probe", "graceful-degradation", "feature-flag"]
related:
  - docs/solutions/architecture-patterns/rls-exempt-tables-read-before-tenant-context.md
---

## Context
RLS runtime-role enforcement (flag `RLS_RUNTIME_ROLE`) uses two Postgres roles:
- `rls_app_runtime` — the **enforcement** role: a least-privilege, RLS-subject
  role the app drops into for tenant-scoped queries. This is the actual security
  property.
- `rls_cross_tenant` — an **auditability-only** role (BYPASSRLS) for intentional
  cross-tenant sweeps, so that access is attributable in DB logs. BYPASSRLS is
  the *same capability* the connection principal already has, so it buys no
  privilege reduction — only a named, auditable identity.

The boot probe (`verifyRlsRuntimeRole`) originally refused to boot if **either**
role was unassumable. But creating a `BYPASSRLS` role requires **SUPERUSER**,
which managed Postgres often withholds. So turning the flag on would have crashed
boot on exactly the target platform — contradicting the "sweeps fall back to the
connection principal" contract documented in the migration and runbook. A code
review caught this before it shipped.

## Guidance
When a feature provisions multiple capabilities at boot, classify each as
**required** (the actual safety property — fail closed, refuse to start) or
**optional** (a nicety like auditability/telemetry — warn and degrade). Don't let
an optional capability block the required one, especially if the optional one has
a *harder* provisioning requirement (here: SUPERUSER vs CREATEROLE).

```ts
// required: enforcement role — throw (refuse boot) if not assumable
await probeRoleAssumable(client, RLS_ROLE, { required: true });
// optional: auditability-only role — warn + continue; sweeps degrade to principal
await probeRoleAssumable(client, CROSS_TENANT_ROLE, { required: false });
```
Make the degraded path *real*, not just documented — the runtime helper must
actually tolerate the missing capability:
```ts
export async function applyCrossTenantRole(client: PoolClient): Promise<void> {
  if (!isRlsRuntimeRoleEnabled()) return;
  try {
    await client.query(`SET ROLE ${CROSS_TENANT_ROLE}`);
  } catch {
    // role unprovisioned → run as the connection principal (documented fallback).
    // SET ROLE fails before any statement and opens no transaction, so the
    // pooled client is safe to reuse as the principal.
  }
}
```

## Why This Matters
Coupling a real security rollout (RLS enforcement) to an audit-only role would
have made the feature un-shippable on managed Postgres — the worst kind of
failure: a safety improvement that bricks the deploy and so never gets turned on.
The contradiction also lived *inside the same change* (a boot probe that hard-
failed vs. docs promising graceful fallback), which is the tell: when the code
and its own runbook disagree about a failure mode, one of them is a bug.

## When to Apply
Any boot-time / startup probe that asserts the presence of multiple external
resources (DB roles, extensions, buckets, secrets, downstream services). Ask of
each: *is this the safety property, or a nicety?* Fail closed on the former, warn
and degrade on the latter — and verify the degraded path actually runs.

## Examples
- Boot probe: `packages/api/src/db/rls-runtime-role.ts` (`verifyRlsRuntimeRole`,
  `probeRoleAssumable`, `applyCrossTenantRole`).
- Provisioning + self-degrading migration: `MIGRATIONS['220_create_rls_cross_tenant_role']`
  (CREATE ROLE … BYPASSRLS guarded by `EXCEPTION WHEN insufficient_privilege`).
- Operator procedure: `docs/runbooks/rls-runtime-role-rollout.md` (step 4 +
  "three runtime access modes").
