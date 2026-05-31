# Scheduling & Dispatch — "Make It Valuable" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Story bodies:** `docs/stories/scheduling-dispatch-value-stories.md` (SD-101…SD-108).
> **Dispatch metadata (waves, forbidden files, gates):** `docs/superpowers/contracts/scheduling-dispatch-addendum.md`.

**Goal:** Make scheduling/dispatch best-in-class by filling the highest-value gaps on the existing foundation: persist availability, model **skills + proficiency levels** and light up the already-wired feasibility skill seam, then (later phases) add "nearest qualified available tech" suggestions + a board map, disruption re-optimization, and the two-way communication loop.

**Architecture:** Phases 1–2 are the foundation and the focus of this plan's task-by-task detail. They are pure additive persistence + a one-method additive widening of the `SkillMatcher` seam. The keystone insight: `feasibility.ts`'s `partition()` already routes each `FeasibilityIssue` to `blocking`/`warning`/`info` **by its own `severity`** — so making skill `severity` a property of the returned `SkillGap` lights up skill matching across `/check-feasibility`, the drag preview, and the proposal-creation gate with **zero** changes to those callers, and leaves a clean path to flip licensed-skill gaps to `blocking` later. Phases 3–6 compose over this foundation and are specified at goal level here (detailed when their waves start).

**Tech Stack:** TypeScript, Node, Express, Vitest, React, Tailwind, Postgres (RLS via `PgBaseRepository.withTenant`). No new external services in Phases 1–2 (Phase 3 reuses the existing Google Distance Matrix key; Phase 4 reuses the LLM gateway).

**Reused, not rebuilt:** dispatch board + drag-drop→proposal (`packages/web/src/pages/dispatch/DispatchBoard.tsx`); feasibility composer (`packages/api/src/scheduling/feasibility.ts`); travel-time provider; proposal/approval gate (`packages/api/src/proposals/actions.ts`); audit (`createAuditEvent`); async worker + `WorkerRegistry`; webhook base; LLM gateway; the proven disruption→proposal pattern (`packages/api/src/scheduling/reschedule/from-tech-out.ts`); T-24h reminder sweep (`packages/api/src/workers/appointment-reminder-worker.ts`).

---

## Roadmap

| Phase | Theme | Status in this plan |
|---|---|---|
| **1** | Availability persistence (working-hours DB + mgmt API; blackout/capacity) | **Detailed (SD-101…SD-104)** |
| **2** | Skills + levels + real `SkillMatcher` | **Detailed (SD-105…SD-108)** |
| **3** | Suggestions ("nearest qualified available tech") + board map | Goal-level |
| **4** | Disruption re-optimization (late/emergency → ranked proposals) | Goal-level |
| **5** | Communication completion (T-2h reminder; two-way CONFIRM/RESCHEDULE SMS; per-tenant config) | Goal-level |
| **6** | Edge cases (recurring/PM, multi-day, formal crews, priority bump, preferred-tech, OT/callback) | Goal-level |

**Migrations reserved (head = `137_appointment_reschedule_audit`):** `138` working-hours · `139` blackout · `140` capacity · `141` skills model. See `freeze-list.md`.

**Locked decisions (from product owner):** Phase-1 anchor = skills foundation; skill depth = **tags + proficiency levels** (below-level/missing = *warning*; licensing/hard-blocking = fast-follow); re-optimization = both proactive + on-demand (on-demand first); this iteration delivers **plan + stories**, not feature code.

---

## File map (Phases 1–2)

### New (api)
| File | Responsibility |
|---|---|
| `packages/api/src/availability/pg-working-hours.ts` | Pg-backed `WorkingHoursRepository` (migration 138). |
| `packages/api/src/availability/blackout-period.ts` + `pg-blackout-period.ts` | Business blackout entity + repos (migration 139). |
| `packages/api/src/availability/daily-capacity.ts` + `pg-daily-capacity.ts` | Per-tech daily capacity (migration 140). |
| `packages/api/src/availability/routes.ts` | `createAvailabilityRouter` — working-hours/blackout/capacity mgmt API. |
| `packages/api/src/skills/{skill,technician-skill,job-required-skill}.ts` (+ `pg-*`) | Skills model entities + repos (migration 141). |
| `packages/api/src/skills/routes.ts` | `createSkillsRouter` — skills/tech-skill/job-required-skill mgmt API. |
| `packages/api/src/scheduling/real-skill-matcher.ts` | `RealSkillMatcher` (replaces stub). |
| `packages/api/test/{availability,skills,scheduling}/**` | Tests mirroring src. |

### Modified (api)
| File | Change |
|---|---|
| `packages/api/src/db/schema.ts` | Add `MIGRATIONS` keys `138_`…`141_`. |
| `packages/api/src/scheduling/skill-matcher.ts` | Additive: add `evaluateMatch` + `SkillGap`; update `StubSkillMatcher`. |
| `packages/api/src/scheduling/feasibility.ts` | `skillMatchIssues()` → use `evaluateMatch`, carry per-gap `severity`. |
| `packages/api/src/auth/rbac.ts` | Additive: `skills:view`/`skills:manage` on `owner`/`dispatcher`. |
| `packages/api/src/app.ts` | Wiring only: `workingHoursRepo`→Pg, blackout/capacity repos, `skillMatcher`→Real, mount `/api/availability` + `/api/skills`. |
| `packages/api/src/dispatch/board-query.ts` | Optional `skillBadges` on `BoardAppointment` (no-op when dep unset). |

### Modified (web)
| File | Change |
|---|---|
| `packages/web/src/types/dispatch.ts`, `components/dispatch/AppointmentCard.tsx`, `pages/dispatch/DispatchBoard.tsx` | Render skill chips; surface skill warnings via existing `useFeasibilityPreview`. |

### Out-of-scope deferrals (documented fast-follows)
- Licensing/certifications-with-expiry + `blocking` severity for licensed-skill gaps.
- `job_type_required_skills` template layer (needs a `jobs.job_type` column first).
- Split-shift working hours (v1 is one window/day).
- Capacity enforced in ranking (Phase 3) and blackout→feasibility (SD-104) — both optional/deferred.

---

# Phase 1 — Availability persistence

## Task 1.1 — `PgWorkingHoursRepository` + migration 138 (SD-101)

**Files:** create `packages/api/src/availability/pg-working-hours.ts`, `packages/api/test/availability/pg-working-hours.test.ts`; modify `packages/api/src/db/schema.ts`.

- [ ] **Step 1: Add migration `138_technician_working_hours`** to the `MIGRATIONS` object in `db/schema.ts` (mirror `116_tech_unavailable_blocks`):

```sql
'138_technician_working_hours': `
  CREATE TABLE IF NOT EXISTS technician_working_hours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    technician_id UUID NOT NULL REFERENCES users(id),
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TEXT NOT NULL,            -- 'HH:mm'
    end_time   TEXT NOT NULL,            -- 'HH:mm'
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, technician_id, day_of_week)
  );
  CREATE INDEX IF NOT EXISTS idx_twh_tenant_tech
    ON technician_working_hours (tenant_id, technician_id);
  ALTER TABLE technician_working_hours ENABLE ROW LEVEL SECURITY;
  ALTER TABLE technician_working_hours FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_technician_working_hours ON technician_working_hours;
  CREATE POLICY tenant_isolation_technician_working_hours ON technician_working_hours
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

- [ ] **Step 2: Write failing tests** (`pg-working-hours.test.ts`) — guard with skip-if-no-`DATABASE_URL` like other pg tests. Cover: create→`findByTechnicianAndDay` round-trip (start/end as `HH:mm` strings); `findByTechnician` sorted; `update` bumps `updated_at`; `delete`; cross-tenant isolation; UNIQUE(day) duplicate rejected.

- [ ] **Step 3: Implement `PgWorkingHoursRepository`** — `extends PgBaseRepository implements WorkingHoursRepository`, mirror `pg-unavailable-block.ts`. `mapRow` returns `start_time`/`end_time` as-is (TEXT), `is_active` as boolean, dates as `Date`. Every method inside `withTenant(tenantId, …)` with explicit `tenant_id = $1`. The interface to satisfy (unchanged):

```ts
// packages/api/src/availability/working-hours.ts — DO NOT modify
interface WorkingHoursRepository {
  create(hours: TechnicianWorkingHours): Promise<TechnicianWorkingHours>;
  findByTechnician(tenantId, technicianId): Promise<TechnicianWorkingHours[]>;
  findByTechnicianAndDay(tenantId, technicianId, dayOfWeek): Promise<TechnicianWorkingHours | null>;
  update(tenantId, id, updates): Promise<TechnicianWorkingHours | null>;
  delete(tenantId, id): Promise<boolean>;
}
```

- [ ] **Step 4: Run tests — PASS.** `cd packages/api && npx vitest run test/availability/pg-working-hours.test.ts`
- [ ] **Step 5: Build gate.** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- [ ] **Step 6: Commit** — `feat(availability): persist technician working hours (migration 138)`

## Task 1.2 — Blackout + capacity entities + migrations 139/140 (SD-102)

**Files:** create `availability/{blackout-period,pg-blackout-period,daily-capacity,pg-daily-capacity}.ts` + tests; modify `db/schema.ts`.

- [ ] **Step 1: Migrations** — `139_business_blackout_periods` and `140_technician_daily_capacity` (DDL in SD-102 story body; both `ENABLE`/`FORCE RLS` + `tenant_isolation_*`).
- [ ] **Step 2: Failing tests** — blackout `findOverlapping` (strict `start < $end AND end > $start`, abutting≠overlap); capacity `upsert` idempotent on PK; tenant isolation; validation (end>start, day 0–6).
- [ ] **Step 3: Implement** following the `unavailable-block.ts` + `pg-unavailable-block.ts` pattern (interface + Zod `validate*Input` + factory + InMemory + Pg). `tenantId`-first; nullable capacity = unlimited.
- [ ] **Step 4–5: Tests PASS + build gate.**
- [ ] **Step 6: Commit** — `feat(availability): add blackout periods and per-tech daily capacity (migrations 139-140)`

## Task 1.3 — Availability management API + persist wiring (SD-103)

**Files:** create `availability/routes.ts` + test; modify `app.ts` (wiring + mount only).

- [ ] **Step 1: Failing route tests** — PUT/GET working-hours; POST/GET/DELETE blackout; PUT/GET capacity; 403 without `availability:manage`; audit emitted; 422 on bad input.
- [ ] **Step 2: Implement `createAvailabilityRouter(deps)`** — RBAC gate (`availability:view`/`availability:manage`, already in `rbac.ts`), Zod-validate bodies, `createAuditEvent` on mutations.
- [ ] **Step 3: Wire `app.ts`** (the `pool ? Pg : InMemory` idiom on adjacent lines):

```ts
const workingHoursRepo = pool ? new PgWorkingHoursRepository(pool) : new InMemoryWorkingHoursRepository();
const blackoutRepo     = pool ? new PgBlackoutPeriodRepository(pool) : new InMemoryBlackoutPeriodRepository();
const capacityRepo     = pool ? new PgDailyCapacityRepository(pool) : new InMemoryDailyCapacityRepository();
const unavailableBlockRepo = pool ? new PgUnavailableBlockRepository(pool) : new InMemoryUnavailableBlockRepository(); // flip the existing hardcoded InMemory at app.ts ~999
app.use('/api/availability', createAvailabilityRouter({ workingHoursRepo, blackoutRepo, capacityRepo, auditRepo }));
```

- [ ] **Step 4–5: Tests PASS + build gate.**
- [ ] **Step 6: Commit** — `feat(availability): management API + persist working hours`

## Task 1.4 — *(DEFER)* Blackout → feasibility warning (SD-104)

Optional, low-risk. Add optional `blackoutRepo?` to `FeasibilityDependencies` (composer no-ops when absent), `'business_blackout'` to the `FeasibilityCheck` union, warn on overlap. Ship 1.1–1.3 first.

---

# Phase 2 — Skills + levels + real matcher

## Task 2.1 — Skills data model + migration 141 (SD-105)

**Files:** create `skills/{skill,technician-skill,job-required-skill}.ts` (+ `pg-*`) + tests; modify `db/schema.ts`.

- [ ] **Step 1: Migration `141_skills_model`** — `skills`, `technician_skills` (`proficiency SMALLINT CHECK 1..3`), `job_required_skills` (`min_proficiency`, `is_required`). All `ENABLE`/`FORCE RLS` + `tenant_isolation_*`. DDL in SD-105 story body. **No** licensing columns (fast-follow).
- [ ] **Step 2: Failing tests** — UNIQUE(name); proficiency CHECK rejects 0/4; job required-skill findByJob; tenant isolation.
- [ ] **Step 3: Implement** three entities following the `unavailable-block.ts` pattern (interface + Zod + factory + InMemory + Pg, `tenantId`-first, `withTenant` + explicit predicate).
- [ ] **Step 4–5: Tests PASS + build gate.**
- [ ] **Step 6: Commit** — `feat(skills): skills + proficiency + job-required-skill model (migration 141)`

## Task 2.2 — Skills management API (SD-106)

**Files:** create `skills/routes.ts` + test; modify `rbac.ts` (additive), `app.ts` (mount only).

- [ ] **Step 1:** Add `skills:view`/`skills:manage` to the `Permission` union and `owner`+`dispatcher` arrays in `rbac.ts` (additive — do not rename/reorder).
- [ ] **Step 2: Failing route tests** — CRUD skill; assign tech-skill w/ proficiency; set job required-skills; 403 without `skills:manage`; audit.
- [ ] **Step 3: Implement `createSkillsRouter`** + `app.use('/api/skills', …)`.
- [ ] **Step 4–5: Tests PASS + build gate.**
- [ ] **Step 6: Commit** — `feat(skills): management API + skills permissions`

## Task 2.3 — `RealSkillMatcher` + feasibility severity-as-data (SD-107) — KEYSTONE

**Files:** create `scheduling/real-skill-matcher.ts` + tests; modify `scheduling/skill-matcher.ts`, `scheduling/feasibility.ts`, `app.ts` (wiring only).

- [ ] **Step 1: Widen the seam additively** in `skill-matcher.ts` (update `StubSkillMatcher` in the SAME commit so the build never breaks):

```ts
export type SkillGapReason = 'missing_skill' | 'below_proficiency';
export interface SkillGap {
  skillId: string;
  skillName: string;
  reason: SkillGapReason;
  severity: 'warning';          // licensing fast-follow may add 'blocking'
}
export interface SkillMatcher {
  requiredSkillsForJob(tenantId: string, jobId: string): Promise<string[]>;      // unchanged
  skillsForTechnician(tenantId: string, technicianId: string): Promise<string[]>; // unchanged
  evaluateMatch(tenantId: string, jobId: string, technicianId: string): Promise<SkillGap[]>; // NEW
}
export class StubSkillMatcher implements SkillMatcher {
  async requiredSkillsForJob(): Promise<string[]> { return []; }
  async skillsForTechnician(): Promise<string[]> { return []; }
  async evaluateMatch(): Promise<SkillGap[]> { return []; }  // additive
}
```

- [ ] **Step 2: Failing tests** for `RealSkillMatcher.evaluateMatch`: missing required skill → one `missing_skill` warning; proficiency < `min_proficiency` → one `below_proficiency` warning; meets/exceeds → `[]`.

- [ ] **Step 3: Implement `RealSkillMatcher`** (backed by SD-105 repos): load `job_required_skills` for the job + `technician_skills` for the tech; for each required skill, emit `missing_skill` if absent, else `below_proficiency` if held proficiency `< min_proficiency`. All `severity: 'warning'` for v1.

- [ ] **Step 4: Carry severity through `feasibility.ts`** — replace `skillMatchIssues()` body to call `evaluateMatch` and map each gap to a `FeasibilityIssue` with **its own `severity`**:

```ts
async function skillMatchIssues(input, deps): Promise<FeasibilityIssue[]> {
  const gaps = await deps.skillMatcher.evaluateMatch(
    input.tenantId, input.appointment.jobId, input.proposedTechnicianId,
  );
  return gaps.map((g) => ({
    check: 'skill_match' as const,
    severity: g.severity,                 // data, not hardcoded — partition() routes it
    message: g.reason === 'missing_skill'
      ? `Technician is missing required skill: ${g.skillName}`
      : `Technician is below the required level for: ${g.skillName}`,
    metadata: { skillId: g.skillId, reason: g.reason },
  }));
}
```

The existing `partition()` (routes by `issue.severity`) and `checkFeasibility`'s `Promise.all` need **no** change.

- [ ] **Step 5: Single wiring change** in `app.ts`: `const skillMatcher = pool ? new RealSkillMatcher(skillRepo, techSkillRepo, jobReqSkillRepo) : new StubSkillMatcher();` (`feasibilityDeps` already references `skillMatcher`).
- [ ] **Step 6: Tests PASS + build gate** (include a `feasibility` test proving a below-proficiency gap lands in `warnings`, `feasible === true`).
- [ ] **Step 7: Commit** — `feat(scheduling): real skill matcher with severity-as-data feasibility`

## Task 2.4 — Surface skill badges on the board (SD-108)

**Files:** modify `dispatch/board-query.ts` (+ test), `web/.../AppointmentCard.tsx`, `DispatchBoard.tsx`, `types/dispatch.ts`.

- [ ] **Step 1:** Optional `skillBadges?` on `BoardAppointment`, populated via an optional `getAppointmentSkillStatus?` dep (mirror `getPendingChangeRequests` — no behavior change when unset).
- [ ] **Step 2:** Render amber chips on `AppointmentCard`; ensure the drag preview's existing `useFeasibilityPreview` skill warnings surface in `ConflictDisplay`/drop coloring (no new write).
- [ ] **Step 2.5: Wire the dep in production** — add `getAppointmentSkillStatus` to the `boardDeps` object in `packages/api/src/dispatch/routes.ts` (next to `getPendingChangeRequests`), sourced from the `RealSkillMatcher` threaded via `app.ts`; without this `GET /api/dispatch/board` never emits `skillBadges`.
- [ ] **Step 3: Tests + build gate. Commit** — `feat(dispatch): surface skill match badges on the board`

---

# Phases 3–6 (goal-level; detail when their waves start)

**Phase 3 — Suggestions + Map.** `scheduling/suggest-technicians.ts`: pre-filter candidates by required skills, run `checkFeasibility` + `evaluateMatch` per candidate, score lexicographically (drop `blocking` → fewer/lighter skill gaps & higher proficiency → no availability warning → ascending travel seconds from last GPS ping/appointment). `POST /api/dispatch/suggest-technicians` (gate `dispatch:view`), board "Suggest tech" pre-fills the existing `ConfirmProposalDialog`. `GET /api/dispatch/map` + `DispatchMap.tsx` (Google Maps JS, reuse `GOOGLE_MAPS_API_KEY`). Risk: bound `limit` (default 10) + skill pre-filter before the feasibility loop.

**Phase 4 — Disruption re-optimization** (generalize `from-tech-out.ts`; never auto-execute). `scheduling/reoptimize/reoptimize.ts` (`trigger: tech_unavailable|tech_late|emergency_insert`) reuses `findRemainingAppointmentsToday` → Phase-3 `suggestTechnicians` → `checkFeasibility` → `reassign/reschedule_appointment` proposals at `ready_for_review`. `reoptimize/rank-options.ts` calls the LLM gateway (`taskType: 'dispatch_reoptimization'`, tier `standard`, register in `routing-config.ts`) to **rank/explain only** — `checkFeasibility` stays authoritative. `workers/reoptimization-worker.ts` (`type:'dispatch.reoptimize'`, idempotency `${tenant}:${trigger}:${tech}:${date}`). On-demand "Re-optimize" board action ships first; proactive triggers (lateness threshold; `emergency_dispatch` handler) follow. Tag `sourceContext.source='reoptimization'` so `pending-changes.ts` badges them. Risks: proposal storms (caps + idempotency); LLM strictly async + non-authoritative.

**Phase 5 — Communication completion.** Parameterize lead time in `appointment-reminder-worker.ts` for a T-2h sweep (distinct idempotency key per lead; reuse templates + `transactionalComms.notifyReminder`). `sms/customer-reply/handler.ts` on the inbound dispatcher: CONFIRM → proposal-gated confirm; RESCHEDULE/CANCEL → proposal w/ `sourceContext.source='customer_sms'` (board badge via `pending-changes.ts`); reuse webhook base + anti-spoof mobile→customer. Per-tenant travel buffer (replace hardcoded `DEFAULT_BUFFER_MS`) + reminder-lead config in settings.

**Phase 6 — Edge cases** (independently dispatchable; defer the heavy ones): recurring/PM series (defer — largest), multi-day jobs, formal crews/teams (promote implicit `is_primary`; `crew-handler.ts` exists), priority/emergency bumping (`emergency_dispatch` exists; v1 = displace-lowest-overlap), preferred-tech boost in ranking, OT/callback flags.

---

## Wave plan (per `multi-agent-runbook.md`)

Chokepoints that MUST serialize (shared files): `app.ts`, `feasibility.ts`/`feasibility-types.ts`, `board-query.ts`, `rbac.ts`.

| Wave | Stories | Mode | Notes |
|---|---|---|---|
| **SD-1A** | SD-101, SD-102, SD-105 | parallel (3 agents) | Disjoint new files; migrations 138 / 139-140 / 141. |
| **SD-1B** | SD-103 → SD-106 → SD-107 | serial (each merges before next) | All touch `app.ts`; SD-107 also touches `feasibility.ts`. |
| **SD-1C** | SD-108 | single | Board surfacing (needs SD-107). |
| *(defer)* | SD-104 | single, after SD-103 | Optional blackout→feasibility. |

## Verification

- **Per task:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run <task test>` (web tasks, from repo root: `npm test --workspace=packages/web -- --run -t <id>`).
- **Phase 1 done-when:** working hours survive a server restart (pg test); availability warnings fire against real data on the board.
- **Phase 2 done-when:** a job tagged with a skill the assigned tech lacks (or is under-level for) shows a **warning** chip on the board and in the live drag preview; `RealSkillMatcher` + feasibility tests prove a below-proficiency gap lands in `warnings` and the seam supports a future `blocking` with no caller change.
- **Migration safety:** confirm `138`–`141` are still free in `db/schema.ts` immediately before dispatching SD-1A (refresh `freeze-list.md` if main advanced).
