---
title: "Raw pg access is frozen by a type-checked guard — new tenant SQL goes through the context helpers, or gets a reviewed allowlist entry"
date: 2026-10-23
track: knowledge
problem_type: architecture-patterns
module: packages/api/src/db
tags: ["rls", "tenant-isolation", "postgres", "structural-guard", "invariants", "security"]
related:
  - "docs/solutions/architecture-patterns/rls-exempt-tables-read-before-tenant-context.md"
  - "docs/solutions/architecture-patterns/required-vs-optional-db-role-at-boot.md"
---

## Context

The app connects to Postgres as a privileged principal, so RLS enforces only on
a client that went through `applyTenantContext` (`SET LOCAL ROLE
rls_app_runtime` when `RLS_RUNTIME_ROLE=true`). Anything else — a `pool.query`,
a raw `pool.connect()`, `PgBaseRepository.withClient`, a
`currentTenantContext()?.client ?? pool` fallback, or a hand-set
`set_config('app.current_tenant_id', …)` without the role — runs as the
principal, where tenant isolation is only whatever `WHERE` clause the SQL
remembered.

The raw-pg audit (2026-10-23) classified every such site (no leak found; two
missing-tenant-filter sites fixed) and designed a guard so the surface cannot
grow silently. It lives in:

- `packages/api/test/support/pg-access-scan.ts` — `findPgAccess`, a TypeScript
  checker scan over `tsconfig.build.json`. A member counts when it resolves to
  `@types/pg` (so aliases, `Pick<Pool,'query'>`, `deps.pool`, `lockPool`,
  `pool[K]` with a literal-typed `K` are all caught). It also follows every
  checked-out client (see "Checkouts and callbacks" below), reads `pool.on(…)`
  listeners, finds a Pool reaching SQL through a structural type, and reports
  `any`-typed receivers, non-call references and policy-GUC literals.
- `packages/api/test/invariants/raw-pool-rls.allowlist.ts` — the reviewed
  entries (`RAW_PG_SITES`) and the sanctioned context helpers
  (`SANCTIONED_HELPERS`).
- `packages/api/test/invariants/raw-pool-rls.structural.test.ts` — the rules,
  the negative controls and the SQL-reader tests. Runs in the default unit lane
  (no DB). Measured solo: 25–28 s (24.9 s and 26.2 s on a loaded container,
  26–28 s in the round-1 review), dominated by building the ~1.3k-file Program
  once; the scan itself is a few seconds.

## Guidance

**Writing new tenant-scoped SQL: use a context helper, and the guard stays
silent.**

- In a repository: extend `PgBaseRepository` and use `withTenant` /
  `withTenantTransaction` (they reuse the request client when the tenant
  matches).
- Route or free-function code that writes SQL directly:
  `withTenantClient(pool, tenantId, fn)` (`db/tenant-transaction.ts`) — the
  request client inside a request, its own `withTenantConnection` otherwise.
  Off-request: `withTenantSession` / `withTenantConnection`.
- A hand-rolled `BEGIN`: call `applyTenantContext(client, tenantId, {
  transactional: true })` before the first statement that touches a table.
  Never `set_config('app.current_tenant_id', …)` on its own — that sets the
  GUC without the role, which looks scoped and is not.
- An intentional cross-tenant sweep: `withCrossTenantSweep` in a repository,
  or `BEGIN` + `applyCrossTenantRole(client, { transactional: true })`.

**When the guard fails**, the message prints `file:line [access] fn — snippet`.
The fix is almost always to move the SQL onto one of the helpers above. Only
when the site genuinely cannot (a pre-tenant lookup, a global table, a
deliberate cross-tenant sweep, a platform-constant write) add an entry:

```ts
{
  file: 'src/…/thing.ts', fn: 'ThingRepository.method', access: 'pool.query', count: 1,
  category: 'pre_tenant_lookup', tables: ['users'],
  why: 'Runs before any tenant is known; keyed by the verified Clerk subject …',
}
```

- `fn` is the scanner's name for the enclosing function (`Class.method`,
  `fnName`, `obj.method`, `POST /route`); copy it from the failure message.
- `count` is exact: a second statement in the same function fails until the
  count is raised in review.
- `tables` must cover every table the function's SQL names; the guard extracts
  them. `global_table` may not name a FORCE-RLS table; every other category must
  name at least one. Categorise an entry by the SQL it runs itself (a checkout
  that only hands its client on runs no table SQL: `global_table`).
- A checkout (`pool.connect`), or a callback run on one (`withClient`,
  `checkout-callback`), claimed as `tenant_context_applied` must pass a context
  helper the client before its first non-`BEGIN`/lock query (R-order).
- `tenant_filtered_no_rls` is debt: it needs `migrateBy` (the audit item or an
  issue) and raises `TFNR_CEILING`, which is visible in review. Migrating one
  means deleting the entry and lowering the ceiling — a stale entry fails.
- `why` is ≥ 40 characters and says why it is acceptable *today*.

### Checkouts and callbacks: who gets the client

For every checkout the scan follows the client through its function and
reports every call that receives it (as an argument, or inside an object
literal argument) other than a context helper, `.query` and `.release`, and
every other escape (`<alias x>`, `<object>`, `<return>`).

- **A callee that is a parameter of an enclosing function** (`run(client)` in
  `systemLookup(pool, run)`, `fn(client, lease)` in `withLock`,
  `options.beforeStep(client)`, `deps.hooks.insideFence(client)`), reached
  before any context helper took the client, makes that function a
  **raw-checkout helper**: it hands its principal checkout to code its CALLER
  supplies. Every call that resolves to the helper by declaration — directly,
  through an import alias, or through an interface or base-class member it
  implements (`this.lock.withLock` on an `IdempotencyLockProvider`) — is a
  site of its own, `checkout-callback` (`withClient` for
  `PgBaseRepository.withClient`), whose SQL, R-order and handoffs come from the
  callback the caller passes. List each caller exactly like a `withClient`
  call. A caller that passes its own parameter straight through
  (`lookupVia(pool, run) { return systemLookup(pool, run) }`) becomes a helper
  too, and so does a callback that hands the client to its caller's parameter
  (`checkAndExecute` → `executeFn(client)`), to a fixpoint. A helper taken by
  reference instead of called (`const f = systemLookup`, `this.withClient.call`)
  is `indirect` and never allowlistable.
- **Any other callee** (a named function, `this.ensureTable`, `new Thing`) is a
  handoff: name it in the entry's `handsOffTo`. The list is exact — a new
  handoff and a stale one both fail. The scan also opens a named callee's body
  one hop (its SQL on the client becomes the entry's SQL), and reads string
  literals passed alongside the client (`queueStatement(c, 'DELETE FROM …')`).
- A Pool event listener that receives a client (`pool.on('connect' |
  'acquire' | 'remove' | 'release' | 'error', …)`) is a `checkout-callback` site
  too.

### Sanctioned helpers are keyed like entries

`SANCTIONED_HELPERS` lists the context helpers themselves (the
`withTenantTransaction` family, `applyTenantContext`'s GUC, `setTenantContext`,
the migrator, `tenantQuery`, the request middleware) by (file, fn, access) with
an exact count and `handsOffTo`. They are exempt from the tables/category
checks only: a second raw function in one of their files is unlisted, a
second checkout in one of them is a count failure, a removed one is stale, and
`contextFirst: true` re-checks R-order on each.

### Pool escapes are frozen

A Pool that reaches a `.query`/`.connect` the typed rule cannot classify is a
`pool-escape` site: an `as unknown as …` cast at the receiver, a local
`const db: Queryable = pool`, or a Pool passed into a function whose parameter
(or a property of it, through object-literal arguments and pass-through
parameters) is structurally typed (`{ query }`, a local interface,
`ClientBase`) and queried. The escaped SQL is the site's SQL. Today's five
(`routes/onboarding.ts` passing `db` to `isBillingLive` / `markPickPending`)
are listed.

## Known limits

What the guard still does not see, so review has to:

- **Structural escapes it does not follow:** a Pool stored in a structurally
  typed class field or constructor parameter property (`new Repo(pool)` with
  `constructor(private db: Queryable)`, then `this.db.query`), returned from a
  function typed structurally, or kept in an array, Map or closure variable
  assigned after its declaration. Casts are caught only at the `.query`
  receiver or at a call argument.
- **R-order is positional, not flow-sensitive:** a context helper inside a
  closure defined before the first query but run after it counts as first;
  a context helper behind a condition counts; context applied
  inside a named callee does not (unless it is one of `CONTEXT_HELPERS`). An
  aliased client (`const c2 = client`) is a required `<alias c2>` handoff, but
  the alias's own queries are not read for SQL or R-order.
- **Handoffs are one hop:** a named callee's body is read for SQL, but the
  functions IT hands the client to are not followed (`runStartTransaction` →
  `runSteps` → `tryConsumeOn`: those tables are listed by review). A callback
  the scan cannot open (`callback <text>`: a property of a local object, a
  spread argument) must be named in `handsOffTo`, and its SQL is not read. A
  callee reached through a local that is not a parameter path is reviewed at
  the handoff, not where it was injected.
- **The tables check's blind spots:** an item after a subquery or function in
  a comma join (`CROSS JOIN LATERAL (…) x, jobs`); table names built at runtime
  (`dynamicSql` must be declared, and its tables are by review); SQL returned
  by a function (`claimSql(source)`); SQL inside SECURITY DEFINER functions;
  SQL two or more hops away in named delegates. (Comma joins, `DELETE … USING`,
  `TRUNCATE [TABLE]`, `COPY` and quoted or `public.`-qualified names are read.)
- **GUC names built at runtime** (`'app.' + 'current_tenant_id'`,
  `` `app.${NAME}` ``) are not R-guc sites. A parameterised `set_config($1, …)`
  is caught only when the literal `'app.<name>'` itself appears.
- **`pool.connect(callback)`** (the callback form) is a `pool.connect` site
  whose client is not bound to a variable: its SQL is read broadly, and it can
  never pass R-order as `tenant_context_applied`.
- `packages/api/scripts/` is outside `tsconfig.build.json` and not scanned, and
  SQL through anything other than a pg `query`/`connect` member (a future ORM,
  `pg-cursor`) is not seen.
