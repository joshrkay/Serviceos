---
title: "Recovering a long-lived feature branch from main-merge damage"
date: 2026-06-22
track: knowledge
problem_type: workflow-issues
module: packages/api/src/db/schema.ts
tags: ["git-merge", "migrations", "migration-immutability", "node-postgres", "jsonb", "ci", "long-lived-branch", "parallel-branches"]
related: ["docs/solutions/workflow-issues/verify-roadmap-epic-not-already-on-main.md"]
---

## Context
Claude feature branches here are long-lived: `main` keeps advancing as other
parallel branches merge (Epics land via their own PRs), so the branch is
periodically reconciled with `git merge origin/main`. That auto-merge produces
a class of **silent damage** that either fails to compile or — worse — compiles
but breaks CI further down the pipeline. PR #611 (Epic 3) hit this **four CI
cycles in a row**; each round looked different because fixing one layer
unblocked the next. This is the playbook so the next reconciliation is minutes.

The tell: `mergeable_state` flips to `behind` → `dirty` (conflict) and CI goes
red. Note these transitions do **not** arrive as PR webhooks (CI-success, new
pushes, and conflict transitions aren't delivered), so a watcher must poll on a
timer to catch them.

## Guidance
Work the failure modes in this order — earlier ones mask later ones, so expect
to re-diagnose after each push rather than assume one fix = green.

### 1. Migration collisions & dropped migrations (`packages/api/src/db/schema.ts`)
The biggest repeat offender. `MIGRATIONS` is one object literal; when two
branches both add the next number (e.g. both add `204_*`), the auto-merge keeps
**one** and silently **drops the other(s)** — and may drop the loser's snapshot
entry too, so `migration-immutability` stays green while real migrations vanish.

Symptom (CI integration step): `column "speed_to_lead_enabled" does not exist`,
`column "auth_token_primary_enc" does not exist` — a column whose migration was
dropped.

Diagnose — compare migration keys, branch vs main:
```bash
git show origin/main:packages/api/src/db/schema.ts | grep -oE "^  '[0-9]{3}_[a-z0-9_]+':" | sed "s/[': ]//g" | sort -u > /tmp/main.txt
git show HEAD:packages/api/src/db/schema.ts        | grep -oE "^  '[0-9]{3}_[a-z0-9_]+':" | sed "s/[': ]//g" | sort -u > /tmp/mine.txt
comm -23 /tmp/main.txt /tmp/mine.txt   # in main, MISSING from branch = dropped by the merge
comm -13 /tmp/main.txt /tmp/mine.txt   # branch-only = your migration(s) that collided
```

Fix — let main win, then renumber yours to the next free slot:
```bash
git checkout --theirs packages/api/src/db/schema.ts \
                      packages/api/test/db/migration-immutability.test.ts
```
Re-append your migration to the END of `MIGRATIONS` with `<main_highest+1>` and
add the matching snapshot row. **The SQL body is unchanged, so its immutability
hash is unchanged** — reuse the existing hash; only the key number changes
(verify the body has no internal reference to the old number). Bump any
`migration NNN` doc comments in the repo/pg/test files for accuracy.

Verify without a DB (integration is Docker-gated and often can't run locally —
Hub rate limits / no daemon):
```bash
npm run migrate:dryrun --workspace=packages/api      # validates concatenated SQL, lists each key
npx vitest run packages/api/test/db/migration-immutability.test.ts
# prove the dropped columns are back:
npx tsx -e "import {getMigrationSQL} from './packages/api/src/db/schema'; const s=getMigrationSQL(); for (const c of ['speed_to_lead_enabled','auth_token_primary_enc']) console.log((s.includes(c)?'OK ':'MISSING ')+c)"
```

### 2. Import loss / duplication (auto-merge artifacts)
When both sides edit a file's import block, the merge can **drop** an import the
code still uses or **duplicate** one. These aren't flagged as conflicts.

Symptoms: `error TS2304: Cannot find name 'logger' / 'toErrorResponse'` (dropped
import — main switched `console.error`→`logger` and added the import, merge kept
the usage but lost the import); or a duplicated `import { x } from '...'`.

Catch them with the **build** tsc (not the default config) and re-add/dedupe:
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```
The `playwright` job also surfaces these because it boots the API dev server via
`ts-node` — a compile error there fails playwright with the same TS message.

### 3. Latent bugs the unblocked pipeline finally reveals
A compile/migration fix lets later CI steps run for the first time, exposing
**pre-existing** failures. PR #611's migration fix unblocked the integration
suite, which then surfaced a real bug in the branch's own new code. Lesson:
treat each red CI as a fresh diagnosis; "I fixed the build" ≠ "CI is green".

### 4. node-postgres auto-parses `jsonb` — never `JSON.parse` it again
The specific latent bug above, worth its own note. node-pg's default type
parser already converts a `jsonb` column to a JS value (object/array/**string**/
number/bool/null). A `mapRow` helper that does `typeof v === 'string' ?
JSON.parse(v) : v` works only while the column always holds an *object* (the
string branch is dead) — but a `jsonb` column holding a primitive string `"A"`
comes back as the JS string `'A'`, and `JSON.parse('A')` throws
`SyntaxError: "A" is not valid JSON`.
```ts
// WRONG for jsonb that can hold primitives:
return typeof raw === 'string' ? JSON.parse(raw) : raw;
// RIGHT — node-pg already parsed it:
return raw === undefined ? null : raw;
```

## Why This Matters
Each of these cost a full CI round-trip on PR #611 (build → migrations →
integration → a latent bug), because every fix revealed the next layer. The
diagnose-in-order recipe + the local proxies for the Docker-gated integration
step (`migrate:dryrun`, `getMigrationSQL` grep) turn a multi-hour, multi-push
slog into a single reconciliation pass.

## When to Apply
- `mergeable_state` is `dirty`/`behind`, or CI went red right after a
  `git merge origin/main` on a long-lived branch.
- Any conflict in `schema.ts` or `migration-immutability.test.ts`.
- A repo with many concurrent branches all appending migrations (the collision
  is structural, not a one-off).

## Examples
PR #611 reconciliation, end to end:
- main added `207_jobs_status_canonical_lifecycle`; branch had
  `207_create_corrections` → renumbered branch's to `208_create_corrections`
  (same SQL → same immutability hash `37eac96b…`), took main's `schema.ts`/
  snapshot via `--theirs`, re-appended `208`.
- Earlier round: merge had dropped main's `204/205/206` entirely (collision at
  204) → restored them verbatim, renumbered corrections `204→205→…→207→208`
  across successive merges.
- Fixed a dropped `logger`/`toErrorResponse` import (TS2304) and a duplicated
  `toErrorResponse` import.
- Fixed the `parseJsonb` double-parse exposed once integration ran.
- Verified each push with build tsc + lint + `migrate:dryrun` + full unit
  suites; integration ran in CI.

Related: `verify-roadmap-epic-not-already-on-main.md` (the *pre-build* side of
the same parallel-branch reality — an epic may already be shipped on main).
