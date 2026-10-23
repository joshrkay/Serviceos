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
  (no DB). Measured solo with the round-4 rules and controls (59 tests): 28.5 s
  and 30.4 s (vitest Duration, load average ~4), and 45.0 s and 37.4 s with
  other jobs pushing the load to ~8.5, against 26.2–27.0 s at load ~2 in round
  3. Timed back to back at the same load, the round-4 scan of the
  real tree costs what round 3's did (18.8 s vs 18.5 s, 24.9 s vs 23.6 s):
  building the ~1.3k-file Program and scanning it is most of the run, and the
  three planted negative-control trees add a few seconds each.

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
- `dynamicSql: true` (and a `why` that says the SQL is dynamic) when the guard
  cannot read the tables: a table named through a substitution (`FROM
  "${table}"`), or SQL that is not readable. Readable is decided from the
  argument's structure, not from whether some literal turned up in it: a
  string or numeric literal, a `const` chain (two hops) ending in one, `+` or
  a ternary of readable parts, `{ text: <readable> }`, a template whose
  substitutions are all readable. Anything else is not — a caller-supplied
  `sql`, `sql + ' LIMIT 100'`, `` `${sql}` ``, `probe ? 'SELECT 1' : sql`,
  `claimSql(source)`, `parts.join(' ')`, `{ text: sql, values }`, a closure
  that runs whatever it is given. A delegate that runs one of its parameters
  verbatim (`queueStatement(c, sql, tenantId)`) is readable only where the
  call binds that parameter to readable SQL. Then `tables` is by review.
  Today the listed ones are `claimLease` and `PgVerticalPackRegistry.update`
  (its `SET` list is joined at runtime), plus `cleanSeed`,
  `deprovisionTenant`, `purgeTenantRows` and `deleteBatch` (also
  substituted table names); the sanctioned `tenantQuery`,
  `PgTenantTransactionRunner.run` (`SAVEPOINT ${name}`) and
  `verifyRlsRuntimeRole` (`SET ROLE ${role}`) are exempt from the tables
  check.
- A checkout (`pool.connect`), or a callback run on one (`withClient`,
  `checkout-callback`), claimed as `tenant_context_applied` must pass a context
  helper the client before its first non-`BEGIN`/lock query (R-order). A named
  function handed the client before the context helper counts: if its body runs
  anything but `BEGIN`/a lock on the client, that call is the first effect.
  R-order fails closed: a function handed the client before context whose
  body the scan cannot read — an interface-typed dependency
  (`this.peeker.peek(client)`), `new Thing(client)`, `.call` / `.apply` /
  `.bind`, the client passed only inside an object literal (`peek({ client
  })`) — is the first effect (`<unread delegate this.peeker.peek>`), and so is
  SQL that is not readable (`client.query(fresh ? 'BEGIN' : sql)`) or a
  statement list that only starts with `BEGIN` (`'BEGIN; SELECT …'`). Apply
  context first, or move the call after it.
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
  one hop (its SQL on the client becomes the entry's SQL), reads string
  literals passed alongside the client (`queueStatement(c, 'DELETE FROM …')`),
  and names where THAT body hands the client on, as `callee > next`
  (`runSteps > tryConsumeOn`): those must be listed too.
- **A closure over the client** — a function expression, object-literal method
  or nested function that uses it, a local bound to one, or an alias of that
  local (`const r = q`) — is a `<closure>` handoff when it is passed to a call,
  returned or stored (`res.end = endAfterSettling`, `{ lock: async () =>
  client.query(…) }`, `runWithSessionLease(lease, () => fn(client, lease))`),
  wherever in the function it is declared: above `connect()` (a hoisted
  function, a closure over a `let client` assigned later) or below its use.
  Its SQL is read either way. Called in place, run as an IIFE, or handed to a
  context helper (`executeAudited({ stateChange })`), it is not. Handed to a
  parameter callee before context (`fn((sql) => client.query(sql))`), it makes
  the function a raw-checkout helper like the client itself, and the
  callback's calls of what it was handed (`q('SELECT …')`) are read as its
  SQL. A built-in callee (`Array#map`, `Map#set`, `Promise.all`: declared only
  in TypeScript's default lib) is never that parameter callee, even on a
  parameter (`ids.map(…)`): an in-place `Promise.all(rows.map((r) =>
  client.query(…)))` is a plain `<closure>`, so its entry lists `<closure>` in
  `handsOffTo`, and its callers are not sites.
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

What the guard still does not see, so review has to. The round-3 negative
controls pin the unread R-guc spellings, the unread second-hop SQL, the class
expression and the unawaited IIFE, so fixing one means updating this list too.

- **Handoffs are named two hops deep and read one hop deep.** A named callee's
  body is read for SQL and for R-order, and every function IT hands the client
  to is a required `callee > next` name. The second hop's body is not read:
  `runStartTransaction` → `runSteps` → `tryConsumeOn` / `reserve` /
  `captureVisitorLead` have their tables listed by review. A third hop is not
  named at all: the round-2 plant (`runSteps` handing the client to a new
  `zzHop2`) now fails as `runSteps > zzHop2`, but the same `zzHop2` added
  inside `tryConsumeOn` would be silent. A callback the scan cannot open
  (`callback <text>`: a property of a local object, a spread argument) must be
  named in `handsOffTo`, and its SQL is not read. A callee reached through a
  local that is not a parameter path is reviewed at the handoff, not where it
  was injected.
- **R-order is positional, not flow-sensitive.** A context helper inside a
  closure defined before the first query but run after it counts as first; a
  context helper behind a condition counts; context applied inside a named
  callee does not (unless it is one of `CONTEXT_HELPERS`), nor does one inside
  a closure declared above `connect()`. SQL a delegate runs before the context
  helper counts at the call, one hop deep, and a delegate whose body is not
  read counts as an effect there (fails closed); but what the delegate's OWN
  delegates run before context is not read (a delegate of a delegate). SQL in
  a closure counts where the closure stands, not where it runs. An aliased
  client (`const c2 = client`) is a required `<alias c2>` handoff, but the
  alias's own queries are not read for SQL or R-order.
- **A `<closure>` is one name, not a timeline.** It says a function over the
  client leaves the checkout; whether it runs after `release()` (on a client
  another request may hold by then) or before context is review's. Once an
  entry lists `<closure>`, a second closure in the same function is silent.
  A closure over a client the scan does not track (an alias, a property of an
  object) is not seen, and neither is a class over the client — a class
  expression or nested class whose method uses it (`new (class { run() {
  return client.query(…) } })()`). An IIFE runs in place, so it is not a
  `<closure>` even unawaited (`void (async () => { … client.query(…) })()`
  may run after `release()`): by design, left to review.
- **Callers of a listed Pool-typed function are not sites.** The guard keys on
  where pg is touched, not on who supplies the pool. `saveVoiceConfig` (two
  `tenant_settings` statements, `tenant_context_applied`) is checked at its
  own body; its claim rests on its one caller, `PUT /api/onboarding/voice`
  (`routes/onboarding.ts`), passing `db = currentTenantContext()?.client ??
  pool` cast to `Pool`. The route is under the `/api` `withTenantTransaction`
  middleware and on neither of its skip lists, so in a served request `db` is
  the request client. With no tenant context active (the route moved onto a
  skip list, the middleware not mounted) `db` falls back to the raw principal
  pool and both statements run as the principal, where `WHERE tenant_id = $1`
  is the only boundary — the same latent `?? pool` fallback as the other
  onboarding entries claimed `tenant_context_applied`. A second caller passing
  the real pool would do the same, silently. That is by design (following
  every Pool argument would make each listed function's callers sites of their
  own), so a new caller of a listed Pool-typed function, or a route moved off
  the request transaction, is reviewed as if it were the site.
- **Structural escapes it does not follow:** a Pool stored in a structurally
  typed class field or constructor parameter property (`new Repo(pool)` with
  `constructor(private db: Queryable)`, then `this.db.query`), returned from a
  function typed structurally, or kept in an array, Map or closure variable
  assigned after its declaration. Casts are caught only at the `.query`
  receiver or at a call argument. A local look-alike of a raw-checkout helper's
  interface (`interface Locker { withLock(…) }` with the concrete
  `PgIdempotencyLockProvider` passed in) hides its calls from the helper rule,
  and `Reflect.get(pool, 'query')` hides the member from the typed rule.
- **The tables check's blind spots:** an item after a subquery or function in
  a comma join (`CROSS JOIN LATERAL (…) x, jobs`); SQL whose tables cannot be
  read (`dynamicSql`: a substituted table name, a caller-supplied or built
  SQL string — declared, then listed by review); SQL inside SECURITY DEFINER
  functions; SQL two or more hops away in named delegates. A delegate that runs
  a literal passed alongside the client (`queueStatement(c, 'DELETE …')`) is
  read as running that literal, not as non-literal SQL. (Comma joins, `DELETE
  … USING`, `TRUNCATE [TABLE]`, `COPY` and quoted or `public.`-qualified names
  are read.)
- **R-guc spellings it does not read:** an `E'…'`, `U&'…'` or `$$…$$` GUC
  name, `UPDATE pg_settings SET setting = … WHERE name = 'app.…'`, a
  `set_config(` split across concatenated literals, the name concatenated in
  SQL (`set_config('app.' || 'current_tenant_id', …)`), a GUC name built at
  runtime (`'app.' + NAME`, `` `app.${NAME}` ``), and a parameterised
  `set_config($1, …)` unless the literal `'app.<name>'` itself appears. R-guc
  watches the GUCs the policies in `db/schema.ts` read (pinned by a test); a
  deprecated GUC name no policy reads any more is not a site. (Read: any case,
  whitespace, a newline or a SQL comment before `(` or after `SET`, a
  `pg_catalog.` prefix, a quoted `"set_config"`, `SET [LOCAL|SESSION]`,
  `"app.name"` and `"app"."name"` quoting, and spaces around the dot.)
- **`pool.connect(callback)`** (the callback form) is a `pool.connect` site
  whose client is not bound to a variable: its SQL is read broadly, and it can
  never pass R-order as `tenant_context_applied`.
- `packages/api/scripts/` is outside `tsconfig.build.json` and not scanned, and
  SQL through anything other than a pg `query`/`connect` member (a future ORM,
  `pg-cursor`) is not seen.
