# Scheduling & Dispatch "Make It Valuable" — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/scheduling-dispatch-value-stories.md` with the metadata needed to dispatch each story (SD-101…SD-108) to a Claude agent in an isolated worktree. The story file is the canonical "what to build"; the plan (`docs/superpowers/plans/2026-05-31-scheduling-dispatch-value.md`) is the task-by-task "how"; this file is "how to launch the agent and how to verify it succeeded".

For every story, the agent prompt should include: the full story body, this addendum's per-story block, and `repository-conventions.md` + `freeze-list.md`.

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| SD-1A | SD-101, SD-102, SD-105 | parallel (3 agents, isolated worktrees) | SD-1B |
| SD-1B | SD-103, then SD-106, then SD-107 | **serial** (each merges before the next) | SD-1C |
| SD-1C | SD-108 | single agent, after SD-107 merges | — |
| *(defer)* | SD-104 | single, after SD-103 merges | — |

**Why SD-1B serializes:** SD-103, SD-106, and SD-107 all edit `packages/api/src/app.ts` (wiring), and SD-107 also edits `feasibility.ts` — the runbook's "two agents collide on a shared file" hazard. Within SD-1B, order is SD-103 → SD-106 → SD-107 (SD-106/SD-107 both depend on SD-105 from SD-1A; SD-107 is last because it touches the locked feasibility seam).

**Migration reservations (refresh against `db/schema.ts` head before dispatch):** SD-101 = `134`; SD-102 = `135` + `136`; SD-105 = `137`. Current head: `133_payments_reversal_tracking`.

---

## SD-101 — Persist technician working hours

**Wave:** SD-1A · **Migration reserved:** `134_technician_working_hours`

**Allowed files (concrete):**
- `packages/api/src/availability/pg-working-hours.ts` (new)
- `packages/api/test/availability/pg-working-hours.test.ts` (new)
- `packages/api/src/db/schema.ts` (add key `134_*` only)

**Forbidden files:**
- `packages/api/src/availability/working-hours.ts` (the interface + InMemory contract is locked — implement, don't change)
- `packages/api/src/app.ts` (SD-103 wires it)
- `packages/api/src/db/pg-base.ts`, `packages/shared/**` (Tier 1 locked)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "SD-101|PgWorkingHours" && \
  git diff --name-only origin/HEAD... | grep -vE "^(packages/api/src/availability/pg-working-hours\.ts|packages/api/src/db/schema\.ts|packages/api/test/availability/)" | (! grep . )
```
**Pre-flight:** clean tree; `tsc` green on branch; migration `134` free in `schema.ts`.

---

## SD-102 — Blackout periods + per-tech daily capacity

**Wave:** SD-1A · **Migration reserved:** `135_business_blackout_periods`, `136_technician_daily_capacity`

**Allowed files (concrete):**
- `packages/api/src/availability/{blackout-period,pg-blackout-period,daily-capacity,pg-daily-capacity}.ts` (new)
- `packages/api/test/availability/{blackout-period,daily-capacity}.test.ts` (new)
- `packages/api/src/db/schema.ts` (add keys `135_*`, `136_*`)

**Forbidden files:**
- `packages/api/src/app.ts` (SD-103 wires these)
- `packages/api/src/availability/pg-unavailable-block.ts` (template — read, don't edit)
- `packages/api/src/db/pg-base.ts`, `packages/shared/**`

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "SD-102|Blackout|DailyCapacity" && \
  git diff --name-only origin/HEAD... | grep -vE "^(packages/api/src/availability/(blackout-period|pg-blackout-period|daily-capacity|pg-daily-capacity)\.ts|packages/api/src/db/schema\.ts|packages/api/test/availability/)" | (! grep . )
```
**Pre-flight:** clean tree; `tsc` green; migrations `135`/`136` free.

---

## SD-103 — Availability management API + persist wiring

**Wave:** SD-1B (first) · **Migration reserved:** none

**Allowed files (concrete):**
- `packages/api/src/availability/routes.ts` (new)
- `packages/api/test/availability/routes.test.ts` (new)
- `packages/api/src/app.ts` (working-hours/blackout/capacity repo wiring + `/api/availability` mount **only**)

**Forbidden files:**
- any `pg-*.ts` (built by SD-101/SD-102)
- `packages/api/src/scheduling/**` (no feasibility changes here)
- `packages/api/src/auth/rbac.ts` (`availability:*` already exist)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "SD-103|availability-routes"
```
**Pre-flight:** SD-101 + SD-102 merged to main.

---

## SD-104 — *(DEFER)* Blackout → feasibility warning

**Wave:** defer (single, after SD-103) · **Migration reserved:** none

**Allowed files (concrete):**
- `packages/api/src/scheduling/feasibility.ts`, `packages/api/src/scheduling/feasibility-types.ts`
- `packages/api/test/scheduling/feasibility-blackout.test.ts` (new)
- `packages/api/src/app.ts` (add optional `blackoutRepo` to `feasibilityDeps` only)

**Forbidden files:** `packages/api/src/availability/**` (consume, don't change); `packages/shared/**`.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "SD-104|feasibility-blackout"
```
**Risk note:** `FeasibilityDependencies` is a near-locked seam. Make `blackoutRepo` **optional** so the composer degrades to current behavior when unset — this avoids re-merging every feasibility caller/fake.

---

## SD-105 — Skills data model

**Wave:** SD-1A · **Migration reserved:** `137_skills_model`

**Allowed files (concrete):**
- `packages/api/src/skills/{skill,pg-skill,technician-skill,pg-technician-skill,job-required-skill,pg-job-required-skill}.ts` (new)
- `packages/api/test/skills/**` (new)
- `packages/api/src/db/schema.ts` (add key `137_*`)

**Forbidden files:**
- `packages/api/src/scheduling/**` (SD-107 owns the matcher seam)
- `packages/api/src/app.ts` (SD-106/SD-107 wire it)
- `packages/api/src/db/pg-base.ts`, `packages/shared/**`

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "SD-105|Skill" && \
  git diff --name-only origin/HEAD... | grep -vE "^(packages/api/src/skills/|packages/api/src/db/schema\.ts|packages/api/test/skills/)" | (! grep . )
```
**Risk note:** v1 is **tags + levels only** — no licensing/cert/expiry columns and no `job_type_required_skills` (those are documented fast-follows). A reviewer should reject any license column added here.

---

## SD-106 — Skills management API

**Wave:** SD-1B (after SD-103) · **Migration reserved:** none

**Allowed files (concrete):**
- `packages/api/src/skills/routes.ts` (new)
- `packages/api/test/skills/routes.test.ts` (new)
- `packages/api/src/auth/rbac.ts` (add `skills:view`/`skills:manage` — **additive** to the `Permission` union + `owner`/`dispatcher` arrays)
- `packages/api/src/app.ts` (`/api/skills` mount **only**)

**Forbidden files:** any `skills/pg-*.ts` or entity file (built by SD-105); `packages/shared/**`.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "SD-106|skills-routes"
```
**Pre-flight:** SD-105 merged.
**Risk note:** `rbac.ts` is Tier 1 — adding a permission is allowed, renaming/removing is not. Touch only the two new entries.

---

## SD-107 — RealSkillMatcher + feasibility severity-as-data (KEYSTONE)

**Wave:** SD-1B (last) · **Migration reserved:** none

**Allowed files (concrete):**
- `packages/api/src/scheduling/real-skill-matcher.ts` (new)
- `packages/api/src/scheduling/skill-matcher.ts` (additive widening — keep existing methods; update `StubSkillMatcher` in the same commit)
- `packages/api/src/scheduling/feasibility.ts` (`skillMatchIssues()` only)
- `packages/api/test/scheduling/{real-skill-matcher,feasibility-skill}.test.ts` (new)
- `packages/api/src/app.ts` (`skillMatcher` wiring **only**)

**Forbidden files:**
- `packages/api/src/scheduling/feasibility-types.ts` (no shape change needed — `FeasibilityIssue.severity` already exists)
- `packages/api/src/proposals/**`, `packages/api/src/scheduling/create-scheduling.ts` (must NOT need changes — that's the whole point of severity-as-data)
- `packages/api/src/skills/**` (consume the repos, don't change them)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "SD-107|RealSkillMatcher|feasibility"
```
**Pre-flight:** SD-105 merged.
**Risk note (Heavy review):** widening `SkillMatcher` touches a locked seam. The change MUST be additive and `StubSkillMatcher.evaluateMatch` MUST be updated in the same commit, or the build breaks mid-phase for every feasibility consumer. Confirm a below-proficiency gap lands in `warnings` (not `blocking`) and `feasible` stays true, and that neither `/check-feasibility` nor `create-scheduling.ts` required edits.

---

## SD-108 — Surface skill badges on the board

**Wave:** SD-1C · **Migration reserved:** none

**Allowed files (concrete):**
- `packages/api/src/dispatch/board-query.ts` (optional `skillBadges` + optional dep)
- `packages/api/test/dispatch/board-query.test.ts`
- `packages/web/src/pages/dispatch/DispatchBoard.tsx`, `packages/web/src/components/dispatch/**`, `packages/web/src/types/dispatch.ts`

**Forbidden files:** `packages/api/src/scheduling/**`; `packages/api/src/app.ts`.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/web -- --run --grep "SD-108|skillBadge"
```
**Pre-flight:** SD-107 merged.
**Risk note:** keep the `board-query.ts` dep **optional** (mirror `getPendingChangeRequests`) so the board is unchanged when the dep is unset — no behavior regression for tenants without skills configured.

---

## Universal pre-flight (run before launching any SD agent)

1. `git fetch origin && git rev-parse origin/HEAD` — fresh base.
2. Working tree clean (`git status --porcelain` empty).
3. `npx tsc --project packages/api/tsconfig.build.json --noEmit` passes on the current branch.
4. All `Pre-flight` dependencies for the story have merged.
5. Reserved migration numbers are still free in `packages/api/src/db/schema.ts` (refresh `freeze-list.md` if main advanced).
