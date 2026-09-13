# §8.3 Book — local re-verification lane (ticket #1015, round 2)

Branch: `local/book-8-3-r2`, off `origin/main` (`d6e59ad19`). Running locally on
Josh's Mac in an isolated git worktree, Sonnet, TEST-ONLY per this lane's brief.

**Headline finding: this lane's assigned scope is already done.** The brief
asked for the same seven rows (3.2, 3.3, 3.4, 3.5, 3.6, 3.9, 3.12) with
essentially the same per-row criteria already delivered, gated, and merged by
a different Sonnet lane earlier the same day.

## What was checked before touching anything

- `gh issue view 1015 --comments -R joshrkay/Serviceos` shows: a cloud-sandbox
  Sonnet lane (`cloud/book-8-3`, session `cse_014sS887ZDmYDiA7EfyNXcc8`) did
  this exact row set, gated by Fable ("Local re-run 9 files 47 passed + 1
  expected fail at a kept Postgres"), landed via batch PR **#1047** (merge
  commit `137dc559e`). A separate Opus dormant-rows lane did 3.8/3.11
  (batch PR #1081). Further batches (#1091, #1094, #1097...) landed later
  work on other rows. A final issue comment ("🚀 Two cloud lanes launched at
  22:00Z") re-announces the identical row split (3.2/3.3/3.4/3.5/3.6/3.9/3.12
  → `cloud/book-8-3`) — this appears to be the dispatch that raced this local
  lane; the cloud copy finished and merged first.
- `docs/PRD-v5-as-built.md` §8.3 (`grep -n '^| \*\*3\.' docs/PRD-v5-as-built.md`)
  already carries "#1015 2026-09-12" annotations for all seven rows, each
  matching this lane's brief almost verbatim (e.g. 3.2's cell literally reads
  "the V17 business-hours/buffer unit half moved to real Postgres... T2 kept").
- `docs/audit/lane-reports/1015-book.md` (28 KB) already exists on
  `origin/main` — the report for exactly this scope, from the `cloud/book-8-3`
  lane, with RED/GREEN transcripts and row dumps for all seven rows.
- `git log --oneline` on this branch (= `origin/main`) already contains, e.g.:
  - `acafa192d test(book): 3.4 booking POST cannot take a held slot, proven at real Postgres`
  - `b0f3eff90 test(book): 3.12 honest test.fails — production hold path never surfaces the back-to-back travel warning`
  and the test files this brief asked for already exist and match the brief's
  criteria: `dispatch-availability.test.ts` (V17 real-DB half + T2),
  `dispatch-availability-stale-defaults.integration.test.ts` (3.3, T1),
  `public-booking-held-slot.integration.test.ts` (3.4, T1 held-slot +
  neighbour-hold-does-not-block), `hold-reaper.test.ts` (3.5, T2
  hold-visibility + cites `sweep-tenant-fanout.test.ts` T4),
  `technician-double-booking-race.test.ts` (3.6, T1 + audit read-back),
  `appointment-reminder-owner-push.integration.test.ts` +
  `sweep-tenant-fanout.test.ts` (3.9, T1·T3·T4),
  `place-hold-feasibility-gap.integration.test.ts` (3.12, real-Postgres
  control + honest `it.fails`, story-not-met, issue filed).

Given that, re-authoring these tests here would either be a byte-for-byte
duplicate or a needless variant of already-merged, already-gated work. This
lane did **not** re-plant RED/GREEN or add new assertions — there is nothing
un-met left in the brief's own criteria to plant. What follows instead is an
**independent local re-run** of the existing suite against a kept Postgres
container via colima on this Mac (not the cloud sandbox Fable used for its
gate), because per the "artifact before sign-off" standard, test output
alone — even someone else's gated test output — isn't a substitute for
watching it pass here, on this hardware, against a container this lane
started itself.

## Environment

```
export DOCKER_HOST=unix:///Users/joshuakay/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 \
  pgvector/pgvector:pg16 -c max_connections=300
# → container b986efdfbf60, mapped port 32825
```

`packages/api/node_modules` was missing in this worktree; `npm install
--no-audit --no-fund` at the repo root was run once (826 packages, ~15s).
It touched `package-lock.json` (npm 11 vs. the pinned npm 10.x engine); that
incidental diff was reverted with `git checkout -- package-lock.json` since
it is not part of this lane's scope.

## Command run (one command, one container, per the concurrency rule)

```
cd packages/api
export EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32825/serviceos_test
export RLS_RUNTIME_ROLE=true
npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/dispatch-availability.test.ts \
  test/integration/dispatch-availability-stale-defaults.integration.test.ts \
  test/integration/public-booking-held-slot.integration.test.ts \
  test/integration/hold-reaper.test.ts \
  test/integration/technician-double-booking-race.test.ts \
  test/integration/appointment-reminder-owner-push.integration.test.ts \
  test/integration/sweep-tenant-fanout.test.ts \
  test/integration/place-hold-feasibility-gap.integration.test.ts
```

**Raw result:**

```
 Test Files  8 passed (8)
      Tests  50 passed | 1 expected fail (51)
   Duration  10.56s
```

The one expected fail is `place-hold-feasibility-gap.integration.test.ts`'s
honest `it.fails` for 3.12 ("STORY-NOT-MET... `placeAppointmentHold` never
calls `checkFeasibility`") — pinning the still-open gap, not a regression.

## Per-row result of this independent re-run

| Row | File(s) | Evidence class (observed) | Tenant grade (observed) | Notes |
|---|---|---|---|---|
| 3.2 | `dispatch-availability.test.ts` | PROVEN-REAL-DB | T2 | 4/4 incl. "does not let tenant A's appointment block tenant B's availability" and the V17 real-DB business-hours/buffer case |
| 3.3 | `dispatch-availability-stale-defaults.integration.test.ts` | PROVEN-REAL-DB | T1 | 2/2: cold tenant told its offers are defaults; a configured neighbour is told its own, cold neighbour unaffected |
| 3.4 | `public-booking-held-slot.integration.test.ts` | PROVEN-REAL-DB | T1 | 2/2: real hold blocks a same-tenant second POST with an audited winner; a neighbour's hold on the identical instant does not block this tenant |
| 3.5 | `hold-reaper.test.ts` | PROVEN-REAL-DB | T2 (T4 cited in `sweep-tenant-fanout.test.ts`) | 3/3: expiry+audit, idempotent re-sweep, and the added T2 hold-visibility assertion (tenant B's live hold untouched, no audit leak) |
| 3.6 | `technician-double-booking-race.test.ts` | PROVEN-REAL-DB | T1 | 6/6: real `EXCLUDE`-constraint race (one winner), the added T1 (neighbour tenant's technician/window untouched), plus the pre-existing control and ghost-double-booking cases |
| 3.9 | `appointment-reminder-owner-push.integration.test.ts` + `sweep-tenant-fanout.test.ts` | PROVEN-REAL-DB | T1 · T3 · T4 | owner-push file 5/5 (incl. audit read-back, T1 fan-out, T3 two-timezones-one-instant); fan-out file's `appointment-reminder sweep` block runs on the real enumerator and survives one tenant throwing |
| 3.12 | `place-hold-feasibility-gap.integration.test.ts` | PROVEN-REAL-DB (control) + honest `it.fails` | N/A — story-not-met, not T-graded (matches brief: "pin it as dormant... and say so") | control: `checkFeasibility` genuinely flags the back-to-back pair as `travel_time`; `it.fails`: the production hold path never calls it |

Tenant-grade grep (`grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant" <file>`)
was re-run per file; hits confirmed in `dispatch-availability.test.ts` (`tenantB`),
`dispatch-availability-stale-defaults.integration.test.ts` (cross-tenant
comment), `hold-reaper.test.ts` (`tenantB`), `technician-double-booking-race.test.ts`
(T1 case name), `appointment-reminder-owner-push.integration.test.ts`
(`otherTenant`). `public-booking-held-slot.integration.test.ts` uses
"cross-tenant" in comments rather than a `tenantB`/`otherTenant` identifier —
consistent with the merged report. `place-hold-feasibility-gap.integration.test.ts`
has no match, consistent with it being a single-tenant control + `it.fails`,
not a T-graded row.

## Row dumps (from the kept container, this run)

`audit_events` grouped by tenant/event (31 rows across the run's fixtures —
includes rows from all eight files, since they share one container/schema):
one `appointment.hold_expired` row for the reaper's tenant, `appointment.created`
rows for four distinct tenants (3.4/3.9 fixtures), `appointment.technician_assigned`
for the double-booking-race tenant, `estimate.expired` for an unrelated
fan-out fixture. No event type appears under more than one tenant it wasn't
seeded for.

`appointments` grouped by tenant/status: 22 rows, 21 distinct tenants (one
tenant, the double-booking-race tenant, legitimately owns 11 rows —
2 canceled ghost-check + 9 scheduled from its own concurrency cases). Every
other tenant owns exactly 1-2 rows, matching each test's own fixture — no
tenant's row count includes another tenant's appointment.

`message_dispatches` grouped by tenant/entity_type: 9 tenants, each with
exactly 2 `appointment_reminder` rows (owner push + customer reminder, or the
sweep's own idempotency-check pair) — no tenant has a dispatch row belonging
to another tenant's appointment id (this is exactly what
`appointment-reminder-owner-push.integration.test.ts`'s cross-tenant leak
check at `:308-310` asserts programmatically, reconfirmed here as raw rows).

## Build check

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
Exit 0, no output — clean.

## Diff against origin/main

```
git diff --stat origin/main...HEAD -- packages/api/src packages/web/src
```
Empty — no product code touched. `docs/PRD-v5-as-built.md` was not edited (no
rung claimed by this lane). The only new file in this branch is this report.

## Judgment calls

1. **Did not re-author already-merged tests.** The brief's per-row criteria
   (e.g. "3.2... move the unit-only half to real Postgres", "3.12... if the
   seam is dormant, pin it... and say so") are already satisfied byte-for-byte
   by the merged `cloud/book-8-3` lane. Re-doing it would mean either
   colliding with existing file names and producing a no-op diff, or writing
   a second, redundant test for an already-proven claim. Neither adds
   evidence; both waste review time. I chose to re-verify instead of
   re-author.
2. **Reverted the incidental `package-lock.json` change** from `npm install`
   (npm 11.6.2 installed against a lockfile pinned to npm 10.x) rather than
   commit it — it's unrelated to this ticket and not requested by the brief.
3. **No new commit per row.** The brief's "commit per row" instruction
   presumes new row work; there was none to commit. This report is the one
   commit for the whole lane.

## Not done / open items

- Nothing new found in these seven rows beyond what `docs/audit/lane-reports/1015-book.md`
  already documents. 3.12 remains STORY NOT MET (rung 2, per the already-merged
  finding) pending Josh's wire-or-park decision, already tracked outside this
  lane.
- **Process note for whoever dispatches lanes:** this ticket's row set
  (3.2/3.3/3.4/3.5/3.6/3.9/3.12) was dispatched twice — once to a cloud
  Sonnet lane (`cloud/book-8-3`, merged via PR #1047) and once to this local
  lane (`local/book-8-3-r2`) — per the issue's own "🚀 Two cloud lanes
  launched at 22:00Z" comment, which re-announces the identical split after
  it had already landed. No harm done here (this lane detected it before
  writing any test code and pivoted to independent verification instead) but
  flagging so the dispatcher can avoid re-issuing an already-merged row set.

No rung is claimed by this lane — only the orchestrator states rungs.
