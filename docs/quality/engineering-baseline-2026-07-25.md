# Engineering Quality Baseline — 2026-07-25

Measured baseline for the multi-week push from ~8/10 to 9+/10 engineering
quality. Every number here was produced by `npm run quality:metrics`, not
estimated. CI writes the same JSON as an artifact on every PR
(`quality-metrics`), so later work diffs against a record rather than
recollection.

This is the **engineering**-quality scorecard. It is distinct from
`architecture-regrade-2026-07-11.md`, which grades the nine layers of *voice
agent product capability* (action rail, in-call intelligence, learning loop, …).
Those are different axes and should not be conflated.

## What this sprint did and did not do

This sprint installed **safety rails only**. It does not shrink `app.ts` by one
line and does not touch migrations. That ordering is deliberate: the two
highest-impact workstreams are also the two riskiest, and both become far safer
once builds are deterministic, static analysis exists, and route/middleware
behavior is pinned by a characterization test.

## Corrections to the driving roadmap

Three of the roadmap's premises did not survive measurement. They are recorded
here because they change what the remaining work should be.

### 1. The `app.ts` problem is dependency wiring, not route sprawl

The roadmap frames the work as "extract route modules from `app.ts`" and
sequences it by route group. But routes are **already extracted**:

| Measure | Value |
|---|---|
| `packages/api/src/routes/*.ts` modules | **70** |
| `createXxxRouter(...)` calls in `app.ts` | 83 |
| `app.use(...)` mounts | 111 |
| Inline `app.get(` handlers | **2** |
| Inline `app.post/put/patch/delete` | **0** |
| `new *Repo*(...)` instantiations | **223** |
| `new *Service(...)` instantiations | 20 |
| `import` statements | 488 |

`createApp()` spans `app.ts:739–6881` (6,143 lines), and that bulk is
**dependency-injection wiring**: construct 223 repositories, then 20 services,
then pass them into 83 router factories as long positional argument lists —
e.g. `createJobRouter(jobRepo, timelineRepo, auditRepo, ownership, queue, feedbackDispatcher, customerRepo, locationRepo, {…})`.

So the fix is **repository/service factories plus per-domain registration
modules**, not route extraction. The roadmap's target shape
(`create-core-services.ts`, `registerXModule`) is right; its extraction *order
and rationale* need rewriting. Recorded as **D-022**.

### 2. The Clerk auth workstream was already done

The roadmap asks for four new auth tests. All already existed. What was real
was a **stale comment** at `app.ts:4475` claiming `verifyClerkSession` "uses
HMAC-SHA256 (not Clerk's real signing algorithm) — tracked as a production
bug". That describes a bug P0-033 already fixed: RS256 + JWKS is attempted
first, and HMAC is a dev-only fallback refused in production at both boot and
request time. A reader auditing auth would have drawn a false conclusion. Fixed
as a comment-only change; no tests added, because these already pin it:

| Invariant | Pinned at |
|---|---|
| RS256 attempted before HMAC | `test/auth/clerk-rs256.test.ts:323` |
| HMAC refused in production | `test/auth/clerk-rs256.test.ts:446` |
| …and under `NODE_ENV=prod` | `test/auth/clerk-rs256.test.ts:480` |
| `DEV_AUTH_BYPASS` prod-refused | `test/shared/config.test.ts:854` |
| `CLERK_DEV_HMAC_TOKENS` prod-refused | `test/shared/config.test.ts:860` |

### 3. Two roadmap tasks did not reproduce

- **The `@rolldown/binding-linux-x64-gnu` install step.** No `rolldown`
  reference exists in any `package.json` or workflow, and the lockfile already
  resolves every platform binding. `npm ci` installs the right one. Dropped.
- **"Mobile is never typechecked in CI."** False —
  `pr-checks.yml` has had a `mobile-typecheck` job that installs both the root
  and mobile lockfiles and runs `tsc --noEmit`. This sprint added only a local
  `npm run typecheck:mobile` convenience that delegates to the same script.
  No CI gap was closed here.

## Baseline metrics

| Metric | Baseline | 9+ target | Status |
|---|---|---|---|
| `app.ts` lines | 6,882 | <1,500 | not started |
| `createApp()` lines | 6,143 (`:739–6881`) | <500 | not started |
| `db/schema.ts` lines | 6,448 | registry + helpers only | not started |
| Repository instantiations in `app.ts` | 223 | 0 (moved to factories) | not started |
| Service instantiations in `app.ts` | 20 | 0 | not started |
| Extracted route modules | 70 | maintained | already done |
| Route-manifest coverage | **120 layers pinned** | maintained | **done** |
| ESLint config present | **yes** | yes, blocking | **report-only** |
| ESLint errors | 1,213 | 0 | measured |
| ESLint warnings | 2,154 | triaged | measured |
| `eslint-disable` comments | 202 (180 provably dead) | <25 justified | measured |
| Exactly-pinned Node environments | **20 of 20** | 20 of 20 | **done** |
| Dependency audit gate | **present** | present | **done** |
| High prod vulns outside exceptions | **0** (1 excepted) | 0 | **done** |
| Migrations replayed per boot | 265 (all) | 0 when none pending | not started |
| Migration ledger table | none | present | not started |

### Static analysis detail

The repo had **no ESLint at all** — no config file and no dependency in any
package. `npm run lint` is `scripts/check-log-safety.js` plus `tsc --noEmit`.
Consequence: all 202 `eslint-disable` comments were inert, suppressing rules
from a linter that was never installed.

Turning ESLint on makes them *actively* noisy, which is useful — it is the
cleanup inventory:

| Category | Count |
|---|---|
| `Definition for rule … was not found` (references `eslint-plugin-import`, never installed) | **77** |
| `Unused eslint-disable directive` (suppresses a rule that reports nothing) | **103** |
| Total provably dead | **180 of 202** |

Findings by rule, over the 3,295 linted source files:

| Rule | Count | Severity | Notes |
|---|---|---|---|
| `@typescript-eslint/require-await` | 1,106 | warn | mostly `async` with no `await`; low risk, high volume |
| `@typescript-eslint/no-unnecessary-condition` | 926 | warn | many are defensive checks against `any`-typed input |
| `@typescript-eslint/no-misused-promises` | 718 | error | **needs triage** — async handlers passed where void expected |
| `no-promise-executor-return` | 236 | error | mostly `new Promise(r => setTimeout(r, n))`, benign |
| `@typescript-eslint/no-floating-promises` | **75** | error | **highest-value target** — unawaited promises |
| `require-atomic-updates` | 63 | error | possible real race conditions |
| `react-hooks/exhaustive-deps` | 19 | warn | stale-closure risk |
| `no-fallthrough` | 12 | error | likely real switch bugs |
| `@typescript-eslint/await-thenable` | 6 | error | `await` on a non-promise |

**Recommended order for making rules blocking**, cheapest real signal first:
`await-thenable` (6) → `no-fallthrough` (12) → `no-floating-promises` (75) →
`require-atomic-updates` (63). Those four total **156 findings** and are the
realistic blocking set. `no-misused-promises` (718) is a separate project, and
the two 900+ warn-level rules should stay warnings.

### Cost, and the honest case against report-only

A full type-aware run takes **178s**. That is ~3 minutes added to the
critical-path `test` job on every PR, in exchange for a `continue-on-error`
artifact containing 3,367 findings. Nobody reads a 3,367-finding report, so as
configured this step costs real wall-clock and changes no behaviour.

The defensible end state is the inverse of what shipped: block on the 156
findings above, scoped to `packages/api/src` and `packages/web/src`, and never
enable the high-volume rules at all. Report-only over everything was chosen to
avoid wedging PRs on day one; it should not be the steady state. Treat the
numbers in this section as the input to that decision, not as a result worth
recomputing every PR.

Two scoping notes, both found by measuring rather than assuming:

- `projects/**` (stored audit-run artifacts) and `figma-export/**` (a design
  export, 94 files, zero imports from `packages/`) were being linted despite
  not being source. Ignoring them dropped the file count 3,384 → 3,295 and
  eliminated the run's only genuine `Parsing error` — a top-level `return` in
  `projects/serviceos-audit/run-1/discovery-workflow.js`, which is legal in the
  async-wrapped executor those scripts are written for.
- ESLint reports unused-disable directives with `ruleId: null`, which is easy to
  mistake for a parse failure when grouping findings by rule. After the ignore
  fix the run has **0** parse errors and **103** unused-disable directives.

ESLint runs as `npm run lint:eslint` and as a `continue-on-error` CI step. It is
deliberately **not** wired into `npm run lint`. Do not remove
`continue-on-error` without first driving the relevant rule to zero.

### Reproducibility detail

Before: `.nvmrc` pinned a bare `20`, 18 workflow sites pinned `'20'`, both
Dockerfile stages used `node:20-alpine`, and no `engines` field existed — so
every environment resolved its own patch. This container was running Node
**22.22.2** against a CI and deploy image on 20.

After: `20.20.2` (Node 20 LTS "Iron") in `.nvmrc`, `engines.node`, all 18
workflow sites, and both Dockerfile stages. `clean-install.yml` asserts the
runner matches `.nvmrc` exactly and installs twice from scratch to catch a
lockfile that only resolves with leftover state.

Staying on the 20 line is deliberate: 20 is what CI and the Railway image
already run, so this removes drift without changing the production runtime.

### Migration detail (highest remaining risk)

`migrate.ts:142-148` runs `client.query(getMigrationSQL())` — all **265**
migrations concatenated into a single query, on **every boot**, under
`statement_timeout = '25s'`. There is no ledger; `scripts/prod-schema-probe.sql:3`
states outright that "there is no schema_migrations version table on the deploy
path."

Re-runnability is achieved by rewriting DDL (`getMigrationSQL`'s
`DROP CONSTRAINT IF EXISTS` rewriter). The advisory lock at `migrate.ts:43-60`
(`withMigrationAdvisoryLock`) is genuinely valuable and must be preserved by any
replacement.

The 25s timeout against a linearly growing corpus is the clearest scaling
cliff in the system. **This should be the next plan written** — it changes
production startup, so it needs its own baselining strategy for existing
databases, not an incremental commit.

## Route manifest

`packages/api/test/app/route-manifest.test.ts` boots `createApp()` hermetically
and snapshots all **120** layers in registration order with an exposure class
per mount. This is what makes the `app.ts` work reviewable: a dropped mount,
reordered middleware, or a route changing exposure class shows up as a diff
rather than as a production incident.

Layer counts pinned: 83 routers, 29 middleware, 8 direct routes —
78 authenticated, 21 open, 12 public-token, 9 webhook.

Writing it surfaced a security-relevant fact that nothing previously pinned:
**ten `/api/*` routers are mounted ahead of `requireAuth`** and are therefore
reachable without a Clerk session. All ten are intentional — OAuth callbacks,
telephony provider callbacks, and customer-facing portal/booking/payment
surfaces that authenticate by their own token or provider signature — but the
list was implicit in 6,000 lines of wiring. It is now an explicit allowlist
asserted by the test, so adding an eleventh requires a deliberate decision:

```
/api/public/portal      /api/calendar-integrations
/api/public/booking     /api/integrations
/api/public-payments    /api/telephony  (×2)
/api/calls
```

Three consequences worth carrying forward:

- The classifier must check `/api/public…` **before** `/api`, or those
  customer-facing surfaces get misreported as authenticated.
- The classifier must be **segment-aware**, not a string-prefix test.
  `app.use('/api', …)` matches `/api` and `/api/…` but *not* `/api-docs` —
  verified against Express 4, not assumed. A naive `startsWith('/api')`
  labelled the Swagger UI as authenticated when it is mounted ahead of the
  auth chain and reachable without a session. Caught in review of PR #748;
  fixing it reclassified 7 of the 120 layers (3 `/api-docs` → open,
  4 `/api/public*` → public-token).
- Only `requireAuth` and `resolveAuthorization` are identifiable by layer name.
  `verifyClerkSession(secret)`, `devAuthBypass({…})`, and
  `withTenantTransaction(pool)` are closures returned from factories, so
  Express records `<anonymous>`; their positions are pinned by the snapshot
  rather than asserted by name.

## Deferred, with reasons

- **`app.ts` decomposition** — blocked on nothing technically, but its plan
  needs rewriting first per Correction 1. The route manifest is now in place as
  the safety net.
- **Migration ledger** — highest-risk change in the programme; needs its own
  plan (see above).
- **Making ESLint blocking** — this sprint measures. The counts above decide
  what can be enforced and in what order.
- **Deleting the 182 dead suppressions** — per-file, as each rule goes
  blocking. Deleting them in the same change that introduced the linter would
  conflate two things and make the diff unreviewable.

## Reproducing these numbers

```
npm run lint:eslint:report          # writes eslint-report.json (slow, type-aware)
npm run quality:metrics             # reads it; prints JSON
npm run quality:metrics -- --out quality-metrics.json
```

CI attaches `quality-metrics` and `eslint-report` artifacts to every PR.
