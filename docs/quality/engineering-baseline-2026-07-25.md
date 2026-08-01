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
| Node pin declared in one place | **`.nvmrc`, 20 of 20 sites resolve it** | single source | **done** |
| Dockerfile base images pinned | **3 of 3** (`nginx` by digest) | maintained | **done** |
| GitHub Actions pinned by SHA | 0 of 57 | 57 of 57 | not started |
| Dependency audit gate | **present** | present | **done** |
| High prod vulns outside exceptions | **0** (1 excepted) | 0 | **done** |
| Migrations replayed per deploy | 265 (all, 210 ms) | 0 when none pending | not started |
| Migration ledger table | none | present | not started |
| Replay headroom vs 25s cap | **24.8 s (0.8% used)** | maintained | measured |

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
| `no-fallthrough` | 12 | error | **all 12 false positives** — see below |
| `@typescript-eslint/await-thenable` | 6 | error | `await` on a non-promise |

#### Correction: the "156 realistic blocking set" was wrong

An earlier revision of this section recommended making four rules blocking in
the order `await-thenable` (6) → `no-fallthrough` (12) → `no-floating-promises`
(75) → `require-atomic-updates` (63), and called those **156 findings** "the
realistic blocking set". That treated the four as equivalent signal without
checking where the findings were. Bucketing them by directory — the measurement
that should have come first — shows they are not:

| Rule | Total | Where the findings actually are |
|---|---|---|
| `no-floating-promises` | 75 | **73 in `packages/web/src`**, 2 in the API |
| `require-atomic-updates` | 63 | 21 `api/src` other, 22 web, 11 mobile, **8 on voice paths** |
| `no-fallthrough` | 12 | **all 12 false positives** |
| `await-thenable` | 6 | all 6 in `packages/web/src` |

`packages/api/src/billing`, `.../voice`, and `.../webhooks` contain **zero**
findings across all four rules. Any argument that this work protects the money
or voice paths has to survive that fact: those paths are already clean of this
bug class, and 73 of the 75 floating promises are in the client SPA, where an
unhandled rejection is a UI-robustness bug rather than a lost write.

**All 12 `no-fallthrough` findings were false positives.** Every one is a
grouped `case` label with an explanatory comment between the labels — 11 in
`proposals/proposal.ts:282–348` (the capture-class classifier: ~30 case labels
sharing one `return 'capture'`, each addition justified by a comment) and 1 in
`ai/skills/escalate-to-human.ts:105–109`. A comment between labels makes the
rule treat the case as non-empty and demand a `falls through` marker; the code
is correct. Measured: **12** findings with the rule's default options, **0** with
`allowEmptyCase: true`, which `eslint.config.mjs` now sets. The rule still
blocks on real fallthrough — a case with *statements* that flows into the next.

So the set worth human attention is **~28 findings, not 156**: the 8
`require-atomic-updates` on voice paths below, plus the ~21 elsewhere in
`packages/api/src`. The 101 web findings are a client-robustness pass, not a
correctness gate. `no-misused-promises` (718) remains its own project and the
two 900+ warn-level rules should stay warnings.

The 8 on voice paths are where this rule earns its keep — it flags
read-modify-write across an `await`, the real race class:

```
ai/voice-turn/create-voice-turn-processor.ts:2080, 2206, 2570
telephony/media-streams/mediastream-adapter.ts:1143
ai/agents/customer-calling/entity-resolution.ts:371
ai/tasks/invoice-edit-task.ts:241, 262
ai/gateway/readiness.ts:154
```

`entity-resolution.ts` has form here: it is the module that shipped with
nonexistent column names because its `Pool` was mocked. These 8 are worth
reading before real callers arrive; the other ~148 are not.

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

After: `20.20.2` (Node 20 LTS "Iron") is declared **once**, in `.nvmrc`. All 20
workflow sites resolve it via `node-version-file: '.nvmrc'`, and both Dockerfile
stages pin the same patch. `clean-install.yml` asserts the runner matches
`.nvmrc` exactly and installs twice from scratch to catch a lockfile that only
resolves with leftover state.

Staying on the 20 line is deliberate: 20 is what CI and the Railway image
already run, so this removes drift without changing the production runtime.

Three design points, all corrected after the first pass got them wrong:

- **One source of truth, not twenty.** The first version hardcoded `20.20.2` at
  18 workflow sites, which made a Node bump an 18-site edit — more drift
  surface, not less, while claiming the opposite. `node-version-file` reads
  `.nvmrc` directly, so the pin lives in exactly one place.
- **`engines.node` is a range (`^20.20.0`), not an exact pin.** `engines`
  conventionally expresses the *supported* range while `.nvmrc` expresses the
  *canonical* version; the first version conflated them, so every contributor on
  20.20.1 got an `EBADENGINE` warning for no reason.
- **`allExact: true` was measured from a subset that could only contain
  successes.** The collector matched `/^FROM (node:[^\s]+)/`, so it computed
  Dockerfile exactness from the Node stages alone and structurally could not see
  `nginx:alpine` — the image serving the web SPA — floating at `Dockerfile:68`.
  The artifact asserted full reproducibility while a base image drifted. A metric
  that can only observe the pins already correct is worse than no metric, because
  it reads as coverage. `auditDockerfileBaseImages()` now classifies every
  external base image (stage-alias aware, so `FROM base AS api` is not counted as
  a pull), reports a `floatingBaseImages` list so `allExact: false` says *which*,
  and refuses to call an empty Dockerfile exact. Pinned by 8 cases in
  `packages/api/test/scripts/collect-quality-metrics.test.ts`, one of which
  asserts the real Dockerfile has no floating image.

`nginx` is now pinned by digest —
`nginx:1.31.3-alpine@sha256:4a73073b…` — not merely by version tag. At the time
of pinning `alpine`, `1.31.3-alpine`, and `1.31.3-alpine3.24` all resolved to
that digest, so this is the image that was already shipping; the change is
determinism, not an upgrade. A digest pin does not self-update, which is how a
service ends up on an unpatched nginx for a year, so `.github/dependabot.yml`
gains a weekly `docker` ecosystem as the update path that makes the pin safe to
hold.

Still unpinned, and deliberately out of scope here: all **57** `uses:` in
`.github/workflows` reference mutable tags rather than commit SHAs, and they are
version-skewed (`checkout@v5` ×16 vs `@v4` ×4, `setup-node@v5` ×16 vs `@v4` ×4,
`upload-artifact@v4` ×9 vs `@v5` ×6). That is supply-chain hygiene worth doing,
but it does not gate launch.

Relatedly, `verify` now runs `doctor --warn-only`. Doctor checks the
environment; typecheck/lint/test check the code. Chaining them with `&&` meant a
machine whose Node differs from `.nvmrc` could not run the correctness gate at
all — which is the situation in the provided dev container, so `npm run verify`
was unusable there. Advisory mode keeps the drift visible without blocking
checks that do not depend on it; `npm run doctor` on its own still exits
non-zero.

### Migration detail — measured, and much less severe than first claimed

An earlier revision of this document called the migration path "the clearest
scaling cliff in the system" and said the corpus replays "on every boot".
**Both claims were wrong.** They were written from a code read; measuring
disproved them. The corrected picture:

**It runs once per deploy, not per boot.** `railway.toml:13` invokes
`migrate.js` as `preDeployCommand`; `startCommand` is `index.js`, and
`src/index.ts` contains no migration reference at all.
`railway.worker.toml:11` states explicitly that the worker has no
`preDeployCommand` because "migrations run exactly once, on the web service."
A crash-restart or a scale-up does not replay anything. The blast radius of a
failure is therefore "the deploy aborts and the old version keeps serving",
not "the fleet crash-loops".

**Replay costs 210 ms — 0.8% of the 25s budget.** Measured against
`pgvector/pgvector:pg16` via testcontainers, applying the real
`getMigrationSQL()` output (265 migrations, 266,594 chars):

| Pass | Wall clock |
|---|---|
| 1 — cold, empty database | 2,631 ms |
| 2 — replay against migrated DB | 210 ms |
| 3 — replay again | 187 ms |

Replay is cheap because nearly every statement is a catalog no-op
(`CREATE TABLE IF NOT EXISTS`, the `DROP POLICY IF EXISTS` / `DROP CONSTRAINT
IF EXISTS` rewrites). Headroom against the 25s cap is **24.8 s**; at the
measured 0.8 ms per migration the corpus would need roughly **31,500**
migrations to approach the timeout. There is no cliff at 265.

**What is actually true and worth fixing**, in order:

1. **A few migrations do data work on every deploy.** 12 `UPDATE` backfills,
   2 `DELETE`, 2 `INSERT`. All are self-limiting — guarded by predicates that
   match nothing after the first run (`WHERE review_request_sent_at IS NULL`,
   `WHERE NOT EXISTS (…)`) — so they write nothing on replay. But they still
   *scan* to discover that, and those scans scale with production row count
   rather than with migration count. `198` runs a `row_number()` window over
   open customer conversations each deploy; `214` scans `jobs` for NULLs.
   Modest today, and the only part of this that grows with the business.
2. **Idempotency rests on regex rewriting.** `getMigrationSQL` makes DDL
   re-runnable by string-substituting `CREATE POLICY` and `ADD CONSTRAINT`
   into drop-then-create pairs. A future migration written in a shape those
   two regexes do not match is silently non-idempotent, and the failure
   surfaces on the *next* deploy rather than the one that introduced it.
3. **No ledger means no record of what ran when.** That is a real diagnostic
   gap — nothing in the database says which migrations have been applied — but
   it is hygiene, not an outage risk.

Checked and *not* a problem: the 50 `ADD COLUMN … NOT NULL DEFAULT` statements
are metadata-only on PostgreSQL 11+ (this is PG16), so they do not rewrite
tables. `253`'s `_user_dup_victims` is a genuine `TEMP` table and is dropped.

The advisory lock at `migrate.ts:43-60` (`withMigrationAdvisoryLock`) is
genuinely valuable and must be preserved by any replacement.

**Revised priority: this is worth doing, but it is not the top risk and should
not displace the `app.ts` work.** See
`docs/plans/2026-07-25-001-migration-ledger-plan.md`.

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
- **Migration ledger** — worth doing for diagnostics and deploy speed, but the
  measurements above retired the urgency it was first assigned. Plan written at
  `docs/plans/2026-07-25-001-migration-ledger-plan.md`; it should queue behind
  the `app.ts` work, not ahead of it.
- **Making ESLint blocking** — this sprint measures. The counts above decide
  what can be enforced and in what order.
- **Deleting the 180 dead suppressions** — per-file, as each rule goes
  blocking. Deleting them in the same change that introduced the linter would
  conflate two things and make the diff unreviewable.

## Reproducing these numbers

```
npm run lint:eslint:report          # writes eslint-report.json (slow, type-aware)
npm run quality:metrics             # reads it; prints JSON
npm run quality:metrics -- --out quality-metrics.json
```

CI attaches `quality-metrics` and `eslint-report` artifacts to every PR.
