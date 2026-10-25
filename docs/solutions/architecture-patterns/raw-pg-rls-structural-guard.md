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
a client that went through `applyTenantContext` (inside the tenant
transaction, one `SELECT set_config('app.current_tenant_id', $1, true),
set_config('role', 'rls_app_runtime', true)` when `RLS_RUNTIME_ROLE=true` —
`set_config('role', …, true)` is `SET LOCAL ROLE`). Anything else — a
`pool.query`, a raw `pool.connect()`, `PgBaseRepository.withClient`, a
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
  (no DB). Measured solo after the round-6 review fixes (69 tests): 67.4 s and
  65.5 s (vitest Duration) at load average ~16–17, against 60.0 s for the
  round-5 fixes' 66 tests timed back to back at the same load (39.4 s and
  37.3 s at load ~9–12 when they landed), 27.1 s and 26.5 s at load ~2–3 for
  the round-4 fixes' 63 tests, 28.5 s and 30.4 s at load ~4 for round 4's 59
  tests and 26.2–27.0 s at load ~2 in round 3. Building the ~1.3k-file
  Program and scanning it is most of the run, and the three planted
  negative-control trees add a few seconds each (the round-4, round-5 and
  round-6 reviews' controls are planted in the round-3 tree, so no fourth
  Program is built).

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
  (its `SET` list is joined at runtime), plus `deprovisionTenant`,
  `purgeTenantRows` and `deleteBatch` (also substituted table names); the
  sanctioned `tenantQuery`,
  `PgTenantTransactionRunner.run` (`SAVEPOINT ${name}`) and
  `verifyRlsRuntimeRole` (`SET ROLE ${role}`) are exempt from the tables
  check.
- A checkout (`pool.connect`), or a callback run on one (`withClient`,
  `checkout-callback`), claimed as `tenant_context_applied` must pass a context
  helper the client before its first query that is not transaction control
  (`BEGIN`, `SAVEPOINT`, `RELEASE SAVEPOINT`, `COMMIT`, `ROLLBACK`, `END`,
  `ABORT`) or an advisory lock (R-order). So a cleanup closure declared above
  `connect()` that only rolls back is not a first effect; one that reads is.
  `client.query`, `client['query']` and `client[K]` (a key typed as one
  literal) are all read. A named function handed the client before the
  context helper counts: if its body runs anything else on the client, that
  call is the first effect. R-order fails closed: a function handed the
  client before context whose body the scan cannot read is the first effect
  (`<unread delegate this.peeker.peek>`) — an interface-typed dependency
  (`this.peeker.peek(client)`), `new Thing(client)`, `peek.call(x, client)`,
  `peek.bind(x, client)()`, and a call that reaches the client only inside an
  object or array literal (at any depth) or a spread of one:
  `peek({ client })`, `peek.apply(x, [client])`,
  `Reflect.apply(peek, x, [client])`, `peek(...[client])`,
  `peek([client, 'x'])`, `peek({ all: [client] })` — also behind a ternary or
  `??` / `||` / `&&`: `peek(flag ? [client] : [])`, `peek(given ?? [client])`,
  `peek(flag ? { c: client } : other)`; and through an element or property
  access on anything that holds it, read the same way (so at any depth and on
  a branch): `peek([client][0])`, `peek((flag ? [client] : [client])[0])`,
  `peek((given ?? [client])[0])`, `peek((given || [client])[0])`,
  `peek((flag ? { c: client } : { c: client }).c)`, `peek([[client]][0][0])`,
  `peek({ all: [client] }.all[0])`. Which element or property is taken is not
  read, so `peek({ c: client, n: 1 }.n)` counts too. So is SQL that is not
  readable (`client.query(fresh ? 'BEGIN' : sql)`) or a statement list that
  only starts with transaction control (`'BEGIN; SELECT …'`). Apply context
  first, or move the call after it. Context counts only when the helper gets
  the client itself, or as a property of an object-literal argument
  (`executeAudited({ client, … })`): handed an element or property of a
  literal that holds it (`applyTenantContext([other, client][0], …)`,
  `applyTenantContext((flag ? [client] : [other])[0], …)`, which may be
  another client), the helper is an unread delegate like any other, a
  required `applyTenantContext` handoff and the first effect.
- `tenant_filtered_no_rls` is debt: it needs `migrateBy` (the audit item or an
  issue) and raises `TFNR_CEILING`, which is visible in review. Migrating one
  means deleting the entry and lowering the ceiling — a stale entry fails.
  Prove each migration at real Postgres under `RLS_RUNTIME_ROLE=true` the way
  the voice-path batch did (`test/integration/{ai-skills,telephony,
  voice-path}-tenant-context.test.ts`): `probeStatementRoles` shows every
  statement ran as `rls_app_runtime` with the caller's GUC;
  `widenTenantPredicates` (`test/integration/tenant-predicate-probe.ts`)
  takes the WHERE clause's tenant pin away and the answer must not change,
  with an `asPrincipal` control proving the widened statement does reach the
  other tenant; `runtimeRoleGrantsMissingAfter219` replays migration 219 in a
  rolled-back transaction, because the suite's setup re-grants the role on
  every table. On a per-call path, pin the cost with `countPoolTraffic`: the
  helpers add BEGIN, the GUC + role statement and COMMIT (three round trips)
  to a lone read, so fold neighbouring reads into the one tenant session
  instead of wrapping each.
- `why` is ≥ 40 characters and says why it is acceptable *today*.
- Keep the commit point the raw statement had. A bare `pool.query` commits on
  a connection of its own, even inside a request; `withTenantClient` would
  move it into the request transaction. Where that matters — the send-claim
  ledger (batch 2, P1.6): a claim stands if the request rolls back, and
  `'sending'` is durable before the provider call — use `withTenantSession`
  / `withTenantConnection`, and pin it: another connection sees each step's
  row before the next step, the rows survive the request's ROLLBACK, the
  request client runs none of the statements
  (`test/integration/send-claim-ledger-tenant-context.test.ts`; the
  lifecycle_emails claim/release ledger, batch 3, P2.4, the same way in
  `test/integration/lifecycle-email-tenant-context.test.ts`). The same holds
  for a write the owner has not yet decided should join the request: the
  `/api/me/mode` switch (P2.1) keeps its own session. So does a best-effort
  write after a network call: the Google OAuth callback's availability seed
  (P2.5) fetches free/busy with no connection held, then UPDATEs in a
  `withTenantSession` of its own, so a failed seed never touches the
  credential and audit rows written before it
  (`test/integration/availability-seed-tenant-context.test.ts`).
- An INSERT has no `tenant_id = $n` pin to widen; its backstop is the
  policy's WITH CHECK. Probe it by re-stamping the VALUES tenant with the
  other tenant (`restampClaims` in the same suite): refused under the role,
  landed as the principal (the control).
- Never hold a tenant session across an LLM/gateway call. The gateway's
  in-transaction guard reads `tenantContextStore` only, and a
  `withTenantSession` / `withTenantConnection` callback does not publish
  there: a gateway call inside one holds a pooled connection idle in
  transaction where the guard cannot see it. Split the work into one session
  per stage around the call (the verify-ai worker, P1.9) and pin that no
  checkout is open when the gateway is called
  (`test/integration/verify-ai-tenant-context.test.ts`).
- One entry can hold statements of different categories. Migrate the tenant
  ones and re-categorise what is left: POST /stripe's remaining four
  `pool.query` calls touch only the tenants registry, so after the AI-model
  seed moved into a session (P1.10) the entry is `global_table`, not debt.
- A `currentTenantContext()?.client ?? pool` fallback becomes
  `withTenantClient(pool, tenantId, fn)`: the request client when the
  request's tenant matches (it did not check that), one tenant session
  otherwise. Run a repository read the function also makes before the
  session, not beside it in a `Promise.all`, so off-request it never holds
  two connections; and await the session's own reads one after another: a
  pg client runs one query at a time, so a `Promise.all` on it gains nothing
  and pg 8 deprecates it (loadOnboardingFacts, P1.11).
- A page that reads several of one tenant's rows through different modules
  (a repository's settings read, then `resolvePublicBusinessPhone`, then its
  own reads) takes `withTenantScope(pool, tenantId, fn)`: the request
  transaction when it is for that tenant, otherwise one
  `PgTenantTransactionRunner` session published to `tenantContextStore`, so
  the repository and every `withTenantClient` inside join it. One checkout and
  one BEGIN / context / COMMIT for the page, fewer round trips than the
  repository's own session plus the bare reads (a repository session also
  runs `clearTenantContext`'s two RESETs). Run a global read that takes its
  own checkout (the pack catalog's `withClient`) after the scope, never inside
  it or beside it (the public intake header and the tenant site view, P2.6,
  `test/integration/public-intake-tenant-context.test.ts`). A sweep's
  per-tenant reads take one scope per tenant, inside the per-tenant try and
  closed before any external call: the overage reconciliation's covering
  read, metered usage and overage cap (P2.7,
  `test/integration/overage-reconciliation-tenant-context.test.ts`) end
  their session before `settlePeriod` posts to Stripe.
- A bare `pool.query` READ on an /api request path is a second connection
  held next to the request's. Find where it runs relative to the
  `withTenantTransaction` middleware first: route gates such as
  `requireTenant` are per-route, inside routers mounted after it, so the
  request transaction is already open for `req.auth.tenantId` (except on the
  SSE and long-LLM skip lists). `withTenantClient` then costs the read no
  checkout and no extra round trip; off the request it is one session. One
  trade-off to state: a read that fails on the request client aborts the
  request's transaction, where on its own connection the failure stayed
  local (the mode loader, P2.1, swallows its errors into the supervisor
  default; the request then fails on its next statement). Pin both shapes
  with an express harness in the /api order
  (`test/integration/user-mode-tenant-context.test.ts`; resolveOwnerEmail's
  three billing callers, P2.3, in
  `test/integration/resolve-owner-email-tenant-context.test.ts`).
- A hand-rolled `BEGIN` + GUC-only `set_config` block (a `pool.connect`
  entry plus a `guc-only` one) becomes `withTenantSession`: the same four
  round trips (the context is one statement, #1823) and now the role, so the
  policy's WITH CHECK applies to the INSERT. Probe a guard subquery such as
  `WHERE NOT EXISTS (… tenant_id = $1 …)` by widening it: as the principal it
  sees the subject's membership in another tenant and silently skips the
  insert (the Clerk owner row, P2.2,
  `test/integration/clerk-webhook-tenant-context.test.ts`). The same swap on
  a read whose answer drives an external side effect: deprovision's Twilio
  credential read (P2.8) picks the subaccount to close, and widened as the
  principal it hands another tenant's SID to `closeSubaccount`
  (`test/integration/deprovision-tenant-context.test.ts`). A session-level
  `set_config(…, false)` with no `BEGIN` (the seed CLI's owner INSERT, P2.9)
  takes the same swap: one more round trip (BEGIN and COMMIT in place of the
  RESET), and nothing left on the connection.
- A transaction that must keep a global-table statement beside its tenant
  ones keeps them in one `withTenantSession` and drops back to the
  principal for the global one, last: `cleanSeed` (P2.9) deletes each seeded
  tenant's child rows under the role and then, after `SET LOCAL ROLE NONE`
  (transaction-local, ended by the COMMIT like the role), the tenants
  registry row (no tenant_id, no RLS), so children and registry row still go
  together or not at all. The guard does not read the switch back (see
  Known limits), so pin which statement runs as whom with
  `probeStatementRoles`, and the atomicity with a registry DELETE that fails
  (`test/integration/seed-runner-tenant-context.test.ts`).

### Checkouts and callbacks: who gets the client

For every checkout the scan follows the client through its function and
reports every call that receives it (as an argument, or inside an object or
array literal argument, at any depth, or a spread of one, also behind a
ternary or `??` / `||` / `&&` or through an element or property access on
one) other than a
context helper, `.query` and `.release`, and every other escape: `<alias x>`;
`<object>`, for the client in an array literal or in an object literal that is
not itself an argument; `<return>`.

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
  (`lookupVia(pool, run) { return systemLookup(pool, run) }`, or in a
  property of an object argument, longhand or shorthand: `withOpts(pool, {
  run: run })`, `withOpts(pool, { run })`) becomes a helper too, and so does
  a callback that hands the client to its caller's parameter
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
  `handsOffTo`, and its callers are not sites. Function.prototype's `call`,
  `apply` and `bind` are the exception: `fn.call(undefined, (sql) =>
  client.query(sql))`, `fn.apply(undefined, [cb])` and `fn.bind(undefined,
  cb)` on a parameter run the caller's `fn`, so they make a raw-checkout
  helper and each caller is a site (its callback is named, not read: see
  Known limits).
- A Pool event listener that receives a client (`pool.on('connect' |
  'acquire' | 'remove' | 'release' | 'error', …)`, or `once`, `addListener`,
  `prependListener`, `prependOnceListener`; spelled `pool.on`, `pool['on']`,
  `pool[K]` with `K` typed as one literal, or `pool?.['on']`, and any of
  those in parentheses, behind `!` or cast: `(pool.on)(…)`,
  `(pool['on'])(…)`, `pool.on!(…)`, `(pool['on'] as Pool['on'])(…)`) is a
  `checkout-callback` site too.

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
`ClientBase`) and queried. The escaped SQL is the site's SQL. None is listed
today: the five there were (`routes/onboarding.ts`'s phone routes passing their
`currentTenantContext()?.client ?? pool` to `isBillingLive` /
`markPickPending`) went when those routes moved onto `withTenantClient` to
enqueue their provisioning job on the request client.

## Known limits

What the guard still does not see, so review has to. The round-3 negative
controls pin the unread R-guc spellings, the unread second-hop SQL, the class
expression and the unawaited IIFE, and a round-4 control pins the context
credit for the client on a ternary branch, so fixing one means updating this
list too. The evasions the round-4 to round-7 reviews left open (judged
obfuscation-only) are listed too, and no other control pins them: the R-order
evasions, a closure handed through `fn[K]`, `Reflect.apply`, `fn.bind(x)(cb)`
or `(void 0, fn)(cb)`, the structural escapes through a local object, a
const-key path, a member taken by reference, a nested parameter pattern or a
three-`const` chain, an `any` receiver run through Function.prototype,
readability decided from declarations, and a pool listener registered through
Function.prototype.

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
  alias's own queries are not read for SQL or R-order. Only the first effect
  is checked: context that a later `COMMIT` / `ROLLBACK` ends
  (`applyTenantContext` is transaction-local) still counts for the SQL after
  it, and so does context a later `SET LOCAL ROLE NONE` drops (cleanSeed's
  registry DELETE, which is meant to run as the principal).
- **R-order evasions it does not read** (a delegate's own SQL is read through
  its named parameters, from its declared body): a rest-parameter delegate
  (`peek(...cs)` running `cs[0].query(…)`); a reassigned `let` delegate
  (`let peek = noop; peek = realPeek; peek(client)` reads `noop`'s body); a
  lock statement that embeds a read (`SELECT
  pg_advisory_xact_lock(hashtext((SELECT id::text FROM customers LIMIT 1)))`)
  and `SAVEPOINT ${NAME}` with a const `NAME` that carries SQL (`'sp; SELECT
  …'`), which read as a lock and a `SAVEPOINT`, not as effects (the tables
  they name still feed the tables check); the client boxed in a local first
  (`const args = [client]; peek.apply(x, args)`, `const box = { client };
  peek(box)`), a required `<object>` handoff whose later call is not read
  for R-order; the client in a literal reached through a method call or a
  comma (`peek([client].at(0))`, `peek((noop(), [client])[0])`): the literal
  is a required `<object>` handoff, but `peek` is not a handoff at all and
  R-order passes; `hooks.forEach((h) => h(client))` on a parameter `hooks`:
  `h` is an anonymous callback's parameter, so the checkout lists `h` and
  `<closure>` in `handsOffTo`, but it is not a raw-checkout helper and the
  callers that supply `hooks` are not sites; and the client on a branch
  handed straight to the context helper
  (`applyTenantContext(flag ? client : other, …)`,
  `applyTenantContext(given ?? client, …)`), which counts as context although
  the branch taken may be another client (read as `isClientExpr` reads the
  client everywhere else; pinned for the ternary). The same holds inside an
  object-literal argument: any property that holds the client counts, not only
  the `client` key the helper reads, so `executeAudited({ ...r, [k]: client,
  client: other })`, `executeAudited({ ...r, client: other, extra: client })`
  and `executeAudited({ client: flag ? client : other, … })` count as context,
  as they do on main.
- **A closure handed through `fn.call` / `fn.apply` / `fn.bind` on a
  parameter** makes the helper slot `fn.call` (`.apply`, `.bind`), not `fn`:
  each caller is a site, but its callback is the handoff `callback <text>.call`
  (named for review, so its SQL and tables are not read). With the key in a
  const (`fn[K]`, `K = 'call'`: a helper slot's path takes literal keys only)
  the closure is a plain `<closure>` and the callers are not sites, and the
  same holds when it is handed through `Reflect.apply(fn, x, [cb])` (the
  callee is `Reflect.apply`, not `fn`), `fn.bind(x)(cb)` (bound first, called
  after) or `(void 0, fn)(cb)` (a comma expression, not `fn`) on a parameter
  `fn`.
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
  assigned after its declaration; a Pool boxed in a local object before the
  call (`const deps = { db: pool }; read(deps)`: only an object-literal
  argument is matched); a property path through a const key
  (`deps[K].query(…)` with `K = 'db'`: the path takes literal keys only); a
  nested destructuring pattern in the parameter list (`async function f({
  deps: { db } }) { return db.query(…) }`: one level, `{ db }`, is followed);
  a chain of three `const`s (`const x = deps.a; const y = x.b; const db =
  y.db; db.query(…)`: two are followed); and a structural `query` taken by
  reference (`const q = db.query; q.call(db, sql)`). Casts are caught only at
  the `.query` receiver or at a call argument. A local look-alike of a
  raw-checkout helper's interface (`interface Locker { withLock(…) }` with the
  concrete `PgIdempotencyLockProvider` passed in) hides its calls from the
  helper rule, `Reflect.get(pool, 'query')` hides the member from the typed
  rule, and an `any` receiver whose member runs through Function.prototype
  (`(pool as any).query.call(pool, sql)`) is no site at all: R-any looks only
  at a `query` / `connect` called directly on an `any` receiver (the member
  called here is `call`), and the pool-escape rule leaves `any` receivers to
  R-any.
- **The tables check's blind spots:** an item after a subquery or function in
  a comma join (`CROSS JOIN LATERAL (…) x, jobs`); SQL whose tables cannot be
  read (`dynamicSql`: a substituted table name, a caller-supplied or built
  SQL string — declared, then listed by review); SQL inside SECURITY DEFINER
  functions; SQL two or more hops away in named delegates. A delegate that runs
  a literal passed alongside the client (`queueStatement(c, 'DELETE …')`) is
  read as running that literal, not as non-literal SQL. (Comma joins, `DELETE
  … USING`, `TRUNCATE [TABLE]`, `COPY` and quoted or `public.`-qualified names
  are read.)
- **Readable is decided from declarations, so two spellings read as literal
  SQL that is not:** a property read as its initializer although it is
  reassigned later (`const cfg = { text: 'SELECT 1' }; cfg.text = sql;
  pool.query(cfg.text)`, or a mutable class field), and a spread that
  overrides `text` (`{ text: 'SELECT 1', ...{ text: sql } }` reads the first
  `text`). The other way round it is stricter than needed: a lookup table
  indexed by a variable (`QUERIES[k]`), an `IN (${ids.map(…).join(', ')})`
  list, `LIMIT ${n}` with a `number` parameter and a shorthand `{ text }` are
  not readable, so their entries need `dynamicSql` (and tables by review) even
  where what they add is fixed (a key into a const table, `$1, $2, …`
  placeholders, a number).
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
- **A pool listener registered through Function.prototype or `Reflect.apply`**
  (`pool.on.call(pool, 'connect', cb)`, `pool.on.apply(pool, ['connect', cb])`,
  `pool.on.bind(pool)('connect', cb)`, `Reflect.apply(pool.on, pool, ['connect',
  cb])`) is no site at all: the listener rule matches a call whose callee is the
  listener method itself (bracketed, parenthesised, asserted or cast), and
  here the callee is `.call` on it, or the function `.bind` returns.
- **Two fail-closed spellings**, the same on main and absent from the real
  tree: a command built in a local first (`const cmd = { ...r, client }; await
  executeAudited(cmd)`) and a context helper called through a local alias
  (`const f = applyTenantContext; await f(client, …)`) get no context credit,
  so R-order fails. List the site, or pass the literal inline.
- **`pool.connect(callback)`** (the callback form) is a `pool.connect` site
  whose client is not bound to a variable: its SQL is read broadly, and it can
  never pass R-order as `tenant_context_applied`.
- `packages/api/scripts/` is outside `tsconfig.build.json` and not scanned, and
  SQL through anything other than a pg `query`/`connect` member (a future ORM,
  `pg-cursor`) is not seen.
