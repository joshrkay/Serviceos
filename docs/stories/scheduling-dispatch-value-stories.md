# Scheduling & Dispatch — "Make It Valuable" Gap Stories (Phases 1–2)

> **8 stories** | Companion plan: `docs/superpowers/plans/2026-05-31-scheduling-dispatch-value.md`
> Dispatch metadata (waves, forbidden files, verification gates): `docs/superpowers/contracts/scheduling-dispatch-addendum.md`

---

## Purpose

The dispatch board, feasibility engine, travel-time provider, proposal/approval gate, and SMS/email comms are already built. Two foundational gaps keep the high-value features (skill-aware "nearest tech" suggestions, disruption re-optimization, availability enforcement) from working in production:

1. **Working hours are in-memory only** (`InMemoryWorkingHoursRepository`) — every availability warning silently never fires once the server restarts.
2. **Skills are a stub** (`StubSkillMatcher` returns `[]`) — the feasibility engine's skill-match check is wired but inert.

These 8 stories deliver the **persistence foundation** (Phase 1) and the **skills + levels model with a real matcher** (Phase 2). Skill depth for v1 is **tags + proficiency levels**; below-required-level and missing-skill are **warnings** (licensing/hard-blocking is a documented fast-follow). The matcher is built so a future gap can flip specific gaps to `blocking` with no caller change.

## Exit Criteria

- Technician working hours, business blackout periods, and per-tech daily capacity persist in Postgres with RLS and are manageable via API.
- Skills, technician proficiency levels, and per-job required skills exist and are manageable via API.
- `RealSkillMatcher` replaces `StubSkillMatcher`; a job whose assigned tech lacks a required skill (or is below the required proficiency) shows a **warning** chip on the board and in the live drag `useFeasibilityPreview`.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| SD-101 | Persist technician working hours (PG repo + migration 136) | S | Availability / Data | High | Moderate | — |
| SD-102 | Business blackout periods + per-tech daily capacity (repos + migrations 137–138) | S | Availability / Data | High | Moderate | — |
| SD-103 | Availability management API + persist wiring | M | Availability / API | Medium | Moderate | SD-101, SD-102 |
| SD-104 | *(DEFER)* Blackout periods feed feasibility warnings | S | Scheduling | High | Light | SD-102 |
| SD-105 | Skills data model — skills, technician_skills (proficiency), job_required_skills (migration 139) | M | Skills / Data | High | Moderate | — |
| SD-106 | Skills management API (+ `skills:*` permissions) | M | Skills / API | Medium | Moderate | SD-105 |
| SD-107 | `RealSkillMatcher` + feasibility severity-as-data (keystone wiring) | M | Scheduling | Medium | Heavy | SD-105 |
| SD-108 | Surface skill match/badges on the dispatch board | S | Dispatch UI | High | Moderate | SD-107 |

---

## Story Specifications

### SD-101 — Persist technician working hours (PG repo + migration 136)

> **Size:** S | **Layer:** Availability / Data | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** none

**Allowed files:** `packages/api/src/availability/pg-working-hours.ts`, `packages/api/test/availability/pg-working-hours.test.ts`, `packages/api/src/db/schema.ts` (migration `136_*` only)

**Build prompt:** Working hours currently live only in `InMemoryWorkingHoursRepository` (`packages/api/src/availability/working-hours.ts`), so availability warnings never fire in production. Add a Postgres-backed `PgWorkingHoursRepository` that satisfies the **existing** `WorkingHoursRepository` interface unchanged (`create`, `findByTechnician`, `findByTechnicianAndDay`, `update`, `delete`). Mirror the template at `packages/api/src/availability/pg-unavailable-block.ts`: `extends PgBaseRepository`, every query inside `withTenant(tenantId, …)`, an explicit `tenant_id = $1` predicate (defense-in-depth alongside RLS), a `mapRow` helper, never concatenate `tenantId` into SQL, never call `pool.connect()` directly. Add migration `136_technician_working_hours` to the `MIGRATIONS` object in `db/schema.ts` mirroring `116_tech_unavailable_blocks` (tenant_id FK, `ENABLE`/`FORCE ROW LEVEL SECURITY`, `DROP POLICY IF EXISTS` + `CREATE POLICY tenant_isolation_technician_working_hours`). Columns: `id`, `tenant_id`, `technician_id`, `day_of_week SMALLINT 0–6`, `start_time TEXT` (`HH:mm`), `end_time TEXT`, `is_active BOOLEAN`, `created_at`, `updated_at`, plus `UNIQUE (tenant_id, technician_id, day_of_week)` (the repo's `findByTechnicianAndDay` assumes ≤1 row/day — single window for v1). `start_time`/`end_time` map as TEXT, not Date.

**Review prompt:** Verify the interface is satisfied with zero signature changes (InMemory contract is locked). Verify every query is tenant-scoped both by RLS GUC and explicit predicate. Verify the migration is idempotent (`IF NOT EXISTS` + `DROP/CREATE POLICY`) so the whole-string runner replays on boot. Verify the `UNIQUE` constraint matches the single-window assumption. Confirm `start_time`/`end_time` are stored/returned as `HH:mm` strings.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --run -t "SD-101|PgWorkingHours"
```

**Required tests:**
- [ ] Create + findByTechnicianAndDay round-trips a row
- [ ] findByTechnician returns all days for a tech, sorted
- [ ] update mutates and bumps `updated_at`; delete removes
- [ ] Tenant isolation — a second tenant cannot read tenant A's rows
- [ ] UNIQUE(tenant, tech, day) rejects a duplicate day
- [ ] Skips gracefully when `DATABASE_URL` unset (guard like other pg tests)

---

### SD-102 — Business blackout periods + per-tech daily capacity (repos + migrations 137–138)

> **Size:** S | **Layer:** Availability / Data | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** none

**Allowed files:** `packages/api/src/availability/blackout-period.ts`, `packages/api/src/availability/pg-blackout-period.ts`, `packages/api/src/availability/daily-capacity.ts`, `packages/api/src/availability/pg-daily-capacity.ts`, `packages/api/test/availability/blackout-period.test.ts`, `packages/api/test/availability/daily-capacity.test.ts`, `packages/api/src/db/schema.ts` (migrations `137_*`, `138_*`)

**Build prompt:** Add two new availability entities following the exact shape of `unavailable-block.ts` + `pg-unavailable-block.ts` (interface + Zod `validate*Input` + `create*` factory + `InMemory*` + `Pg*`, `tenantId`-first methods, `withTenant` + explicit predicate). (1) **Business blackout periods** — tenant-wide unavailability (holidays, maintenance windows): `business_blackout_periods (id, tenant_id, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, reason TEXT, created_by TEXT NOT NULL, created_at, CHECK end_time > start_time)`, migration `137_business_blackout_periods`. Repo methods: `create`, `findByTenant(tenantId)`, `findOverlapping(tenantId, start, end)`, `delete(tenantId, id)`. (2) **Per-tech daily capacity**: `technician_daily_capacity (tenant_id, technician_id, day_of_week SMALLINT 0–6, max_appointments SMALLINT NULL, max_work_minutes INTEGER NULL, PRIMARY KEY (tenant_id, technician_id, day_of_week))`, migration `138_technician_daily_capacity`. Repo methods: `upsert`, `findByTechnician(tenantId, technicianId)`, `findByTechnicianAndDay(tenantId, technicianId, day)`. Both migrations include `ENABLE`/`FORCE ROW LEVEL SECURITY` + `tenant_isolation_*` policy. Nullable capacity = unlimited.

**Review prompt:** Verify both follow repository-conventions (tenantId first, async, `T | null` single reads, `T[]` multi reads). Verify RLS on both tables. Verify `findOverlapping` uses `start < $end AND end > $start` (strict). Verify capacity nullable columns mean "unlimited" (documented). No wiring into `app.ts` in this story.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --run -t "SD-102|Blackout|DailyCapacity"
```

**Required tests:**
- [ ] Blackout create + findOverlapping detects an overlapping window, ignores a non-overlapping one
- [ ] Blackout boundary — abutting windows (end == start) do not overlap
- [ ] Capacity upsert is idempotent on (tenant, tech, day); second upsert updates
- [ ] Tenant isolation on both tables
- [ ] Validation rejects end ≤ start (blackout) and day_of_week out of 0–6

---

### SD-103 — Availability management API + persist wiring

> **Size:** M | **Layer:** Availability / API | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** SD-101, SD-102

**Allowed files:** `packages/api/src/availability/routes.ts`, `packages/api/test/availability/routes.test.ts`, `packages/api/src/app.ts` (working-hours/blackout/capacity **+ existing unavailable-block** wiring + router mount **only**)

**Build prompt:** Expose management endpoints and flip working hours to the Pg repo. (1) New `createAvailabilityRouter(deps)` in `packages/api/src/availability/routes.ts` with: `GET/PUT /working-hours/:technicianId`, `GET /blackouts`, `POST /blackouts`, `DELETE /blackouts/:id`, `GET/PUT /capacity/:technicianId`. Gate reads with `hasPermission(role, 'availability:view')` and writes with `'availability:manage'` (both already in `rbac.ts`). Validate bodies with the entities' Zod schemas. Emit `createAuditEvent` on every mutation (`eventType` like `availability.working_hours.updated`). (2) In `app.ts`, change `const workingHoursRepo = pool ? new PgWorkingHoursRepository(pool) : new InMemoryWorkingHoursRepository();` (the `pool ? Pg : InMemory` idiom on adjacent lines), construct the blackout + capacity repos the same way, **and flip the existing `unavailableBlockRepo` (currently hardcoded `new InMemoryUnavailableBlockRepository()` at ~app.ts:999) to `pool ? new PgUnavailableBlockRepository(pool) : new InMemoryUnavailableBlockRepository()`** — `PgUnavailableBlockRepository` already exists (`packages/api/src/availability/pg-unavailable-block.ts`, table `tech_unavailable_blocks`); without this, SMS tech-out and PTO blocks vanish on restart and Phase-1's "warnings fire against real data" done-when isn't met. Then `app.use('/api/availability', createAvailabilityRouter({...}))`. Do not modify feasibility logic here.

**Review prompt:** Verify RBAC gates on every route. Verify audit events on mutations. Verify `app.ts` change is wiring-only (no refactor) and uses the existing `pool ? Pg : InMemory` pattern. Verify the router is tenant-scoped via the existing auth/tenant middleware (no manual tenant_id from the body).

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --run -t "SD-103|availability-routes"
```

**Required tests:**
- [ ] PUT working-hours upserts a day window; GET returns it
- [ ] POST/GET/DELETE blackout lifecycle
- [ ] PUT/GET capacity round-trip
- [ ] (wiring) with a Postgres pool, `unavailableBlockRepo` resolves to `PgUnavailableBlockRepository` (not InMemory)
- [ ] Permission — a `technician` role without `availability:manage` gets 403 on writes
- [ ] Audit — a mutation emits an audit event
- [ ] Validation — malformed `HH:mm` / inverted range rejected with 422

---

### SD-104 — *(DEFER)* Blackout periods feed feasibility warnings

> **Size:** S | **Layer:** Scheduling | **AI Build:** High | **Human Review:** Light | **Status:** DEFER — ship SD-101–103 first

**Dependencies:** SD-102

**Allowed files:** `packages/api/src/scheduling/feasibility.ts`, `packages/api/src/scheduling/feasibility-types.ts`, `packages/api/src/app.ts` (feasibility deps only), `packages/api/test/scheduling/feasibility-blackout.test.ts`

**Build prompt:** Extend `feasibility.ts:availabilityIssues()` so a proposed slot overlapping a `business_blackout_periods` row emits a `warning`. Add an **optional** `blackoutRepo?` to `FeasibilityDependencies` (optional ⇒ composer no-ops when absent, so no caller ripple); add `'business_blackout'` to the `FeasibilityCheck` union in `feasibility-types.ts`. Wire the optional dep in `app.ts:feasibilityDeps`.

**Review prompt:** Verify the dep is optional and the composer degrades to current behavior when unset. Verify the warning (not blocking) severity. Verify existing feasibility tests stay green.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --run -t "SD-104|feasibility-blackout"
```

**Required tests:**
- [ ] Overlapping blackout → one `business_blackout` warning, `feasible` stays true
- [ ] No blackoutRepo provided → identical result to before (no throw)

---

### SD-105 — Skills data model (migration 139)

> **Size:** M | **Layer:** Skills / Data | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** none

**Allowed files:** `packages/api/src/skills/skill.ts`, `packages/api/src/skills/pg-skill.ts`, `packages/api/src/skills/technician-skill.ts`, `packages/api/src/skills/pg-technician-skill.ts`, `packages/api/src/skills/job-required-skill.ts`, `packages/api/src/skills/pg-job-required-skill.ts`, `packages/api/test/skills/**`, `packages/api/src/db/schema.ts` (migration `139_*`)

**Build prompt:** Create the skills model as three entities, each following the `unavailable-block.ts` pattern (interface + Zod + factory + InMemory + Pg, `tenantId`-first, `withTenant` + explicit predicate). Migration `139_skills_model` adds four-or-fewer tables (all with `ENABLE`/`FORCE ROW LEVEL SECURITY` + `tenant_isolation_*`):
- `skills (id, tenant_id, name TEXT, category TEXT, created_at, UNIQUE(tenant_id, name))`
- `technician_skills (id, tenant_id, technician_id REFERENCES users(id), skill_id REFERENCES skills(id), proficiency SMALLINT NOT NULL DEFAULT 1 CHECK (proficiency BETWEEN 1 AND 3), created_at, UNIQUE(tenant_id, technician_id, skill_id))` — proficiency 1=apprentice, 2=journeyman, 3=master.
- `job_required_skills (id, tenant_id, job_id REFERENCES jobs(id), skill_id REFERENCES skills(id), min_proficiency SMALLINT NOT NULL DEFAULT 1 CHECK (min_proficiency BETWEEN 1 AND 3), is_required BOOLEAN NOT NULL DEFAULT true, UNIQUE(tenant_id, job_id, skill_id))`.

Repo methods (per entity): `create`/`upsert`, `findByTenant`, `findByTechnician`/`findByJob`, `delete`. **Do NOT** add licensing/cert/expiry columns or `job_type_required_skills` — those are documented fast-follows. **Do NOT** wire into `app.ts` or touch `feasibility.ts`/`skill-matcher.ts` (SD-107 owns the seam).

**Review prompt:** Verify proficiency is constrained 1–3. Verify all three tables are tenant-scoped + RLS. Verify UNIQUE constraints. Verify no licensing columns crept in (v1 scope is tags + levels only). Verify no `app.ts`/`feasibility.ts` edits.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --run -t "SD-105|Skill"
```

**Required tests:**
- [ ] Skill create + UNIQUE(tenant, name) rejects duplicate name
- [ ] Technician skill upsert with proficiency; findByTechnician returns it
- [ ] proficiency CHECK rejects 0 and 4 (technician_skills)
- [ ] min_proficiency CHECK rejects 0 and 4 (job_required_skills)
- [ ] Job required-skill create + findByJob
- [ ] Tenant isolation across all three tables

---

### SD-106 — Skills management API (+ `skills:*` permissions)

> **Size:** M | **Layer:** Skills / API | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** SD-105

**Allowed files:** `packages/api/src/skills/routes.ts`, `packages/api/test/skills/routes.test.ts`, `packages/api/src/auth/rbac.ts` (add `skills:view`/`skills:manage` — additive only), `packages/api/src/app.ts` (router mount **only**)

**Build prompt:** Add `skills:view` and `skills:manage` to the `Permission` union and to the `owner` + `dispatcher` role arrays in `rbac.ts` (additive — do not rename or reorder existing permissions). New `createSkillsRouter(deps)`: CRUD on `skills`; assign/remove a technician skill with proficiency (`PUT/DELETE /technicians/:id/skills`); set/clear a job's required skills (`PUT /jobs/:id/required-skills`). Gate reads with `skills:view`, writes with `skills:manage`; validate with the SD-105 Zod schemas; audit each mutation. Mount `app.use('/api/skills', createSkillsRouter({...}))` in `app.ts`.

**Review prompt:** Verify the rbac change is purely additive (Tier 1 surface — adding a permission is allowed, renaming is not). Verify RBAC gates + audit. Verify `app.ts` change is mount-only.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --run -t "SD-106|skills-routes"
```

**Required tests:**
- [ ] CRUD skill lifecycle
- [ ] Assign tech skill with proficiency; reflected in GET
- [ ] Set job required-skills; reflected in GET
- [ ] Permission — role without `skills:manage` gets 403 on writes
- [ ] Audit on mutations

---

### SD-107 — `RealSkillMatcher` + feasibility severity-as-data (keystone wiring)

> **Size:** M | **Layer:** Scheduling | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** SD-105

**Allowed files:** `packages/api/src/scheduling/real-skill-matcher.ts`, `packages/api/src/scheduling/skill-matcher.ts`, `packages/api/src/scheduling/feasibility.ts`, `packages/api/test/scheduling/real-skill-matcher.test.ts`, `packages/api/test/scheduling/feasibility-skill.test.ts`, `packages/api/src/app.ts` (skillMatcher wiring **only**)

**Build prompt:** Replace the inert stub with a real matcher and make skill severity **data, not control flow**. (1) **Widen the `SkillMatcher` interface additively** in `skill-matcher.ts`: keep `requiredSkillsForJob`/`skillsForTechnician`, add `evaluateMatch(tenantId, jobId, technicianId): Promise<SkillGap[]>` where `SkillGap = { skillId: string; skillName: string; reason: 'missing_skill' | 'below_proficiency'; severity: 'warning' }`. Update `StubSkillMatcher.evaluateMatch` to return `[]` in the **same commit** so the build never breaks. (2) New `RealSkillMatcher` (backed by the SD-105 repos) implements all three methods; `evaluateMatch` returns a `missing_skill` warning when the tech lacks a required skill and a `below_proficiency` warning when their proficiency < `min_proficiency`. (3) Modify `feasibility.ts:skillMatchIssues()` to call `evaluateMatch` and map each `SkillGap` to a `FeasibilityIssue` carrying **its own `severity`** (and `metadata`). The existing `partition()` already routes by `severity`, so no change is needed in `/check-feasibility` or `create-scheduling.ts`. (4) The single wiring change in `app.ts`: `const skillMatcher = pool ? new RealSkillMatcher(skillRepo, techSkillRepo, jobReqSkillRepo) : new StubSkillMatcher();` (`feasibilityDeps` already references `skillMatcher`).

**Review prompt:** Verify the interface widening is additive and `StubSkillMatcher` is updated in the same commit (no mid-phase build break). Verify severity flows as data through the unchanged `partition()`. Verify a below-proficiency gap lands in `warnings` (not `blocking`) and `feasible` stays true. Verify the seam supports a future `blocking` severity with zero caller changes. Verify `app.ts` change is wiring-only.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --run -t "SD-107|RealSkillMatcher|feasibility"
```

**Required tests:**
- [ ] `RealSkillMatcher.evaluateMatch` — missing required skill → one `missing_skill` warning
- [ ] below `min_proficiency` → one `below_proficiency` warning
- [ ] meets/exceeds requirement → no gaps
- [ ] `feasibility.checkFeasibility` routes a skill gap into `warnings`, `feasible` stays true
- [ ] `StubSkillMatcher.evaluateMatch` returns `[]` (back-compat)
- [ ] Existing feasibility tests unchanged/green

---

### SD-108 — Surface skill match/badges on the dispatch board

> **Size:** S | **Layer:** Dispatch UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** SD-107

**Allowed files:** `packages/api/src/dispatch/board-query.ts`, `packages/api/src/dispatch/routes.ts` (wire `getAppointmentSkillStatus` into `boardDeps`), `packages/api/src/app.ts` (pass the skill-status provider into the dispatch router deps — one line), `packages/api/test/dispatch/board-query.test.ts`, `packages/web/src/pages/dispatch/DispatchBoard.tsx`, `packages/web/src/components/dispatch/**`, `packages/web/src/types/dispatch.ts`

**Build prompt:** Show skill match status on the board. (1) Add optional `skillBadges?: { skillName: string; matched: boolean; severity?: 'warning' }[]` to `BoardAppointment` in `board-query.ts`, populated via a new **optional** dep `getAppointmentSkillStatus?` (mirror the optional `getPendingChangeRequests` pattern so behavior is unchanged when unset). (2) Render skill chips on `AppointmentCard` (amber when a gap exists). (3) The drag-time preview already calls `useFeasibilityPreview`, which returns skill warnings from SD-107 — ensure those surface in the existing `ConflictDisplay`/drop-zone coloring (no new write path). (4) **Wire the dep into production:** add `getAppointmentSkillStatus` to the `boardDeps: BoardQueryDependencies` object in `packages/api/src/dispatch/routes.ts` (where `getPendingChangeRequests` is already wired, ~line 53), sourcing per-appointment match from the `RealSkillMatcher` (SD-107) threaded through `app.ts` into the dispatch router deps — otherwise `GET /api/dispatch/board` omits `skillBadges` in production.

**Review prompt:** Verify the board-query dep is optional (no behavior change when unset). Verify chips come from API data, not client computation. Verify the drag preview shows skill warnings via the existing feasibility path. Verify mobile/degraded rendering.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd ../web && npm test -- --run -t "SD-108|skillBadge"
```

**Required tests:**
- [ ] board-query includes `skillBadges` when the dep is provided; omits cleanly when not
- [ ] AppointmentCard renders an amber chip for a gap, none when matched
- [ ] Drag preview surfaces a skill warning (feasibility path)
