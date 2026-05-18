# Dispatch Feasibility — Design Spec

**Date:** 2026-05-17
**Status:** Draft
**Scope:** Close the three documented write-side gaps in Dispatch + Scheduling — server-side overlap check, travel-time, and concurrent-edit protection — plus a stubbed seam for technician skill matching.

---

## 1. Background

The dispatch + scheduling read-side is complete:

- `packages/api/src/dispatch/board-query.ts` and `routes.ts` (`GET /api/dispatch/board`)
- `packages/web/src/pages/dispatch/DispatchBoard.tsx` + `components/dispatch/*` (technician lanes, drag-drop, conflict badges)

The write-side currently routes every dispatcher edit through the proposal system: the UI builds a `reschedule_appointment` or `reassign_appointment` proposal and `POST`s it to `/api/proposals`. The proposal sits pending until a human approves it; the approval calls into `proposals/execution/{reschedule,reassignment}-handler.ts`, which already runs an overlap check via `dispatch/validation.ts:detectOverlappingAppointments` before mutating.

Three gaps remain:

1. **No overlap pre-check at creation.** A dispatcher can drag a card onto a slot that will obviously fail at approval time, and not learn until approval.
2. **No travel-time awareness.** Two appointments scheduled 9:00–10:00 and 10:00–11:00 across town are flagged as fine by the overlap check (they don't overlap) but are physically impossible.
3. **No concurrent-edit protection at creation time.** Two dispatchers can grab the same card and create competing proposals. Today the *execution* `checkSchedulingProposalFreshness` catches stale proposals at approval, but at *creation* there's no version check — two pending proposals can stack on the same appointment.

A fourth dimension — **technician skill matching** — comes from product intent. The codebase has no skill data model today; this spec adds a seam for it and defers the data model to a follow-up spec.

## 2. Goals & non-goals

**Goals**

- Server-side overlap check at proposal creation (blocking)
- Travel-time awareness using a real routing provider (warning, with graceful fallback)
- Optimistic concurrency at proposal creation via `If-Match` against `appointment.updatedAt`
- Live "feasibility preview" endpoint the UI calls during drag for instant red/yellow drop-zone feedback
- A `SkillMatcher` interface in place, with a no-op stub implementation. Composition logic is real; data model is deferred.
- No regression in existing execution-time checks (`detectOverlappingAppointments`, `checkSchedulingProposalFreshness`).

**Non-goals**

- The actual technician-skill data model (separate spec).
- Pessimistic "lock the card while I'm dragging it" UX (considered, dropped — the optimistic `If-Match` provides correctness; the UX badge can be added later if dispatchers ask).
- Realtime push of other dispatchers' changes (separate spec).
- Tenant-level overrides for travel-time defaults (defaults are global env-level; revisit if demand appears).
- Changes to the proposal types or approval workflow themselves.

## 3. Architecture

Four independent checks composed into the proposal-create path:

```
                 ┌────────────────────┐
                 │ Web dispatch board │
                 │   (drag drop)      │
                 └─────────┬──────────┘
                           │ during drag (debounced)
                           ▼
          POST /api/dispatch/check-feasibility   (read-only preview)
                           │
                           ▼
                  ┌─────────────────────────┐
                  │ scheduling/             │
                  │   feasibility.ts        │  ← composes 4 checks
                  └─┬──────┬──────┬──────┬──┘
                    │      │      │      │
                    │      │      │      └─→ SkillMatcher        (stub today)
                    │      │      └────────→ TravelTimeProvider  (Google + haversine fallback)
                    │      └───────────────→ availability (working-hours, unavailable-block)
                    └──────────────────────→ existing dispatch/validation.ts (overlap)

           ─── on drop / submit ─────────────────────────────────────────

                  POST /api/proposals       (existing endpoint, extended)
                  • body now requires `appointmentVersion`
                  • header `If-Match: <appointment.updatedAt ISO>`
                  • server runs feasibility.ts as authoritative gate
                  • 409 STALE_APPOINTMENT on version mismatch
                  • 422 INFEASIBLE on blocking issues
```

### Module layout

```
packages/api/src/scheduling/                      ← NEW
├── feasibility.ts            ← composer
├── travel-time/
│   ├── provider.ts           ← TravelTimeProvider interface
│   ├── google-provider.ts    ← Google Distance Matrix impl
│   └── haversine-fallback.ts
├── skill-matcher.ts          ← SkillMatcher interface + StubSkillMatcher
└── routes.ts                 ← /check-feasibility endpoint
```

### Design principles

- All four checks return a unified `FeasibilityResult` with `blocking[] | warnings[]`.
- `dispatch/validation.ts` (overlap primitive) stays put; `scheduling/` is the composer + new infrastructure.
- `proposals/execution/{reschedule,reassignment}-handler.ts` is refactored to delegate to `feasibility.ts` instead of calling `detectOverlappingAppointments` directly, so creation-time and execution-time checks are guaranteed identical.
- `SkillMatcher` is a real interface but `StubSkillMatcher` always returns `[]`, so the check is a no-op today. A follow-up spec drops in a real implementation backed by a `technician_skills` table; no callsite in `feasibility.ts` changes.

## 4. API surface

### New endpoint: `POST /api/dispatch/check-feasibility`

Read-only, idempotent. UI calls this during drag (debounced ~150ms).

**Auth:** `requireAuth + requireTenant` (same as other dispatch routes).

**Request body:**

```typescript
{
  appointmentId: string;
  proposedTechnicianId: string;
  proposedScheduledStart: string;   // ISO 8601
  proposedScheduledEnd: string;     // ISO 8601
}
```

**Response (200, even when infeasible — body says so):**

```typescript
{
  feasible: boolean;                // false iff blocking.length > 0
  blocking: FeasibilityIssue[];
  warnings: FeasibilityIssue[];
  travelTime: {
    fromPrevSeconds: number | null; // null when no neighbor or coords missing
    toNextSeconds: number | null;
    estimateSource: 'google' | 'haversine' | 'unknown';
    degraded: boolean;              // true if google failed and we fell back
  } | null;
}

interface FeasibilityIssue {
  check: 'overlap' | 'working_hours' | 'unavailable_block'
       | 'travel_time' | 'skill_match';
  severity: 'blocking' | 'warning';
  message: string;
  conflictingEntityId?: string;
  metadata?: Record<string, unknown>;
}
```

**Severity routing:**

| Check                   | Severity   |
|-------------------------|------------|
| Overlap (same tech)     | blocking   |
| Working-hours violation | warning    |
| Unavailable block       | warning    |
| Travel-time too tight   | warning    |
| Skill mismatch          | warning    |

Concurrent-edit is not part of the feasibility preview — it's detected only at submit time via `If-Match`, where the actor is committing to a write.

**Error responses:**

| Code | Meaning |
|------|---------|
| 400  | Malformed request, invalid ISO dates |
| 404  | Appointment or technician not found |

### Extended endpoint: `POST /api/proposals` (existing)

Backwards-incompatible additions for `proposalType ∈ {reschedule_appointment, reassign_appointment}` only. Other proposal types are unchanged.

**New required inputs:**

- Header `If-Match: <appointment.updatedAt as ISO 8601>` (preferred)
- Body field `appointmentVersion: string` (mirror of `If-Match`; required so JSON parsing alone is sufficient on the server. If both are present and disagree, header wins.)

**Server flow for these proposal types:**

1. Load the appointment referenced by `payload.appointmentId`.
2. Compare expected version to `appointment.updatedAt.toISOString()` (millisecond precision, see §8 risks).
3. Mismatch → `409 Conflict` with body `{ error: 'STALE_APPOINTMENT', currentVersion, providedVersion }`.
4. Run `feasibility.checkFeasibility(...)`.
5. `blocking.length > 0` → `422 Unprocessable Entity` with full `FeasibilityResult` in body and `{ error: 'INFEASIBLE' }`.
6. Otherwise: create the proposal as today.

### Read path: board response unchanged

No new fields on `GET /api/dispatch/board`. (The dropped lease/lock UX would have added one; without it the board response stays as-is.)

## 5. Components

### `feasibility.ts` — the composer

```typescript
export interface FeasibilityInput {
  tenantId: string;
  appointmentId: string;
  proposedTechnicianId: string;
  proposedScheduledStart: Date;
  proposedScheduledEnd: Date;
}

export interface FeasibilityDependencies {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
  jobRepo: JobRepository;
  locationRepo: LocationRepository;
  workingHoursRepo: WorkingHoursRepository;
  unavailableBlockRepo: UnavailableBlockRepository;
  travelTimeProvider: TravelTimeProvider;
  skillMatcher: SkillMatcher;
  timezone?: string;          // tenant default; falls back to 'UTC'
  clock?: () => Date;         // injectable for tests
}

export async function checkFeasibility(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityResult>;
```

Pure composer. Each sub-check returns `FeasibilityIssue[]`; the composer concatenates and partitions into `blocking[] | warnings[]`. No side effects.

Composition order (each runs independently, all results aggregated):

1. Load the proposed appointment via `appointmentRepo.findById(tenantId, appointmentId)`. If absent → return `{ feasible: false, blocking: [{ check: 'overlap', severity: 'blocking', message: 'Appointment not found' }], warnings: [], travelTime: null }` (route surfaces this as 404). The loaded appointment is reused by steps 5 and 6.
2. Overlap — `dispatch/validation.detectOverlappingAppointments` (existing).
3. Availability — `dispatch/validation.detectAvailabilityConflicts` (existing) using working-hours + unavailable-blocks.
4. Travel-time — see §5.2.
5. Skill match — see §5.3. Uses `appointment.jobId` to query `skillMatcher.requiredSkillsForJob`.

### TravelTimeProvider

```typescript
export interface TravelTimeProvider {
  estimateDriveTime(
    origin: LatLng,
    destination: LatLng,
    departAt?: Date,            // for traffic-aware providers
  ): Promise<TravelTimeEstimate>;
}

export interface TravelTimeEstimate {
  seconds: number;
  source: 'google' | 'haversine';
  degraded: boolean;
}

export interface LatLng { latitude: number; longitude: number; }
```

**`GoogleDistanceMatrixProvider`:**

- Constructor reads `GOOGLE_MAPS_API_KEY` from env.
- Every call is `try`/`catch`. On error → delegates to `HaversineFallbackProvider` and sets `degraded: true`.
- Logs each fallback at WARN level (via the existing logger) so ops can spot sustained outages.
- In-memory LRU cache keyed by `${originLat},${originLng}→${destLat},${destLng}` with coords rounded to 4 decimals (~11m). TTL `TRAVEL_TIME_CACHE_TTL_SECONDS` (default 300). Keeps the Google bill bounded for a board that issues a preview per drag-move.
- Wired through a `createTravelTimeProvider(env)` factory in `app.ts`: if `GOOGLE_MAPS_API_KEY` is unset, the factory returns a `HaversineFallbackProvider` instead of a Google one (acceptable for local dev; deployment docs call this out).

**`HaversineFallbackProvider`:**

- Great-circle distance ÷ 13.4 m/s (≈30 mph).
- Pure function. Always succeeds when both coords are present.
- Used both as the fallback and as the primary provider when Google is intentionally disabled.

**Travel-time check inside the composer:**

1. Read the technician's other appointments on the same date, sorted by `scheduledStart`.
2. Find `prev` (latest end ≤ proposed start) and `next` (earliest start ≥ proposed end) for the *same technician on the same date*.
3. For each neighbor that exists *and has lat/lng on its location*, call `estimateDriveTime` and compare against the gap.
4. If `gap < travelSeconds` → emit warning with `metadata: { neighborAppointmentId, gapSeconds, travelSeconds, source }`.
5. If a neighbor exists but lat/lng is missing on either end, emit `metadata: { reason: 'missing_coords', neighborAppointmentId }` as an info-level entry — surfaced so the UI can show "travel-time unverified," not a warning that blocks anything.

### SkillMatcher (stub)

```typescript
export interface SkillMatcher {
  requiredSkillsForJob(tenantId: string, jobId: string): Promise<string[]>;
  skillsForTechnician(tenantId: string, technicianId: string): Promise<string[]>;
}

export class StubSkillMatcher implements SkillMatcher {
  async requiredSkillsForJob(): Promise<string[]> { return []; }
  async skillsForTechnician(): Promise<string[]> { return []; }
}
```

Composer's skill check:

1. `required = await skillMatcher.requiredSkillsForJob(tenantId, jobId)`.
2. If `required.length === 0` → no issue (the stub always hits this path).
3. `held = await skillMatcher.skillsForTechnician(tenantId, technicianId)`.
4. `missing = required.filter(s => !held.includes(s))`.
5. If `missing.length > 0` → warning with `metadata: { missingSkills: missing }`.

A follow-up spec replaces `StubSkillMatcher` with a real implementation backed by a `technician_skills` table and a job-side `requiredSkills` field. No code in `feasibility.ts` changes when that lands.

### Optimistic concurrency wiring

In the existing `POST /api/proposals` handler, for the two scheduling proposal types:

1. Resolve `expectedVersion` from `If-Match` header (preferred) or `body.appointmentVersion`.
2. If neither present → `400 { error: 'MISSING_VERSION' }`.
3. Load appointment; compare `expectedVersion` to `appointment.updatedAt.toISOString()`.
4. Mismatch → `409 { error: 'STALE_APPOINTMENT', currentVersion, providedVersion }`.
5. Run `feasibility.checkFeasibility(...)`.
6. `blocking.length > 0` → `422 { error: 'INFEASIBLE', ...feasibilityResult }`.
7. Proceed with existing proposal creation.

The existing `checkSchedulingProposalFreshness` (used at *execution* time) stays as-is. It guards the case where a proposal sits pending and the underlying appointment moves before approval. The new `If-Match` covers the same race at *creation* time.

### Refactor of existing execution handlers

`proposals/execution/reschedule-handler.ts` and `proposals/execution/reassignment-handler.ts` currently call `detectOverlappingAppointments` directly. They will be refactored to call `feasibility.checkFeasibility(...)` and reject on `blocking.length > 0`. This guarantees creation-time and execution-time check identity. No behavioral change expected; tests assert this.

### Web-side wiring (minimal)

- `useCreateScheduleProposal.ts` — extended to send `If-Match` and `appointmentVersion`; new branches: 409 returns `{ success: false, error: 'STALE' }`; 422 returns `{ success: false, error, blocking[] }`.
- `useFeasibilityPreview.ts` — new hook, debounced 150ms, feeds the existing `ConflictDisplay` component.
- `DispatchBoard.tsx` / `TechnicianLane.tsx` — color drop zones from `feasibility.feasible` + `warnings[]`.

### Wiring (`app.ts`)

`app.ts` constructs `GoogleDistanceMatrixProvider` (or haversine-only if no API key), `StubSkillMatcher`, and a single `FeasibilityDependencies` instance. Both `/check-feasibility` and the proposals route consume the same deps so behavior is identical.

## 6. Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | unset | When unset, provider falls back to haversine-only. Required for production. |
| `TRAVEL_TIME_CACHE_TTL_SECONDS` | `300` | LRU cache TTL for Google responses. |

No DB migration required.

## 7. Testing

Per project standard (80% coverage minimum), TDD throughout.

**Unit** (`packages/api/test/scheduling/`):

| File | Coverage |
|---|---|
| `feasibility.test.ts` | All-stub deps. Clean, blocking-overlap, warning-availability, warning-travel-time, warning-skill-mismatch, multiple combined, missing coords skips travel-time. ~15 cases. |
| `travel-time/google-provider.test.ts` | Mocked HTTP. Happy path returns google, cache hit doesn't re-call, transient failure falls back with `degraded: true`, missing API key constructs haversine-only. |
| `travel-time/haversine-fallback.test.ts` | Pure math. Known city pairs, antipodal, identical coords (0s), missing-coord throws. |
| `skill-matcher.test.ts` | `StubSkillMatcher` returns `[]`. |

**Integration:**

| File | Coverage |
|---|---|
| `check-feasibility-route.test.ts` (new, in `test/dispatch/`) | 200-with-feasible-false shape, FeasibilityIssue serialization, missing-tenant 400, missing-appointment 404. |
| `proposal-create-version-check.test.ts` (new, in `test/proposals/`) | Correct `If-Match` succeeds, mismatched returns 409, blocking feasibility returns 422 with body, header-vs-body precedence (header wins), missing-both returns 400. |
| Existing `reschedule-handler.test.ts` / `reassignment-handler.test.ts` | Updated to assert delegation to `feasibility.ts` (behavioral assertions unchanged). |

**Web:** existing tests in `packages/web/src/components/dispatch/` updated for the new hook signatures; new test for `useFeasibilityPreview`.

**Out of scope for the test plan:**

- No E2E against the real Google API; we mock the HTTP boundary.
- No load test for `/check-feasibility`. Caching + early-exit on missing coords should keep p95 tight; revisit if instrumentation shows otherwise.

**Build verification** (per project CLAUDE.md, mandatory before commit):

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Google bill surprise from a busy board (drag fires N preview calls). | LRU cache + 4-decimal coord rounding + 150ms UI debounce. |
| Locations missing lat/lng silently let bad schedules through. | Info-level entry with `metadata.reason: 'missing_coords'` in response so the UI can show "travel-time unverified" affordance. |
| Duplicated overlap computation (handlers + feasibility). | Refactor handlers to call `feasibility.ts` so the check runs once and is identical at both creation and execution. |
| `updatedAt` precision drift: Postgres `timestamptz` is microsecond, `Date.toISOString()` is millisecond. Could cause spurious 409s. | Compare at millisecond precision on both sides (server truncates `currentVersion` the same way before compare). |
| Google API key leaked in logs. | Provider never logs the key; only logs status code + URL host on failure. Standard secret hygiene. |
| Proposals stacking — N pending proposals on the same appointment because each one's `If-Match` was valid when created. | Out of scope. The execution-time `checkSchedulingProposalFreshness` catches it at approval. If product wants creation-time stacking prevention, that's a follow-up — server can reject if there's a pending proposal for the same appointment. |

## 9. Open questions / explicit deferrals

Flagged so they're not lost:

1. **Skill data model.** Separate spec. Trigger: when product wants real skill matching to land, replace `StubSkillMatcher`.
2. **Working-hours / unavailable-block: warn vs block.** Today they're warnings. If product later decides "outside working hours should block," it's a one-line severity change in the composer.
3. **Tenant override of travel-time defaults** (heuristic mph, cache TTL, warn-vs-block). Settings infrastructure exists (`packages/api/src/settings/`); punt until there's demand.
4. **Realtime board updates** when another dispatcher's proposal lands. Today, the second dispatcher learns about conflict on next manual refresh or at submit. Pusher/SSE channel is its own spec.
5. **"Alex is editing this" UX (advisory lease).** Considered and dropped. Optimistic `If-Match` provides correctness; revisit only if dispatchers actually report being surprised by 409s.
6. **`/check-feasibility` rate-limit.** Inherits `requireAuth + requireTenant`. No bespoke limit; revisit if hot.

## 10. Rollout

Single PR; no flags. The new endpoint is additive. The breaking change is on `POST /api/proposals` for the two scheduling types — the web client is updated in the same PR. Other callers (AI tasks, voice) of those proposal types are audited in the PR description.

---

**Next step:** This spec is closed. Implementation is out of scope per the brainstorming brief. A separate session can pick up the implementation plan via the writing-plans skill.
