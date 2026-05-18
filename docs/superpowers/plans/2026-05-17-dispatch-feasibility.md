# Dispatch Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three write-side gaps on the Dispatch Board — server-side overlap pre-check, travel-time awareness, and optimistic-concurrency protection at proposal creation — while stubbing a seam for technician skill matching.

**Architecture:** A new `packages/api/src/scheduling/` module hosts a `checkFeasibility(...)` composer that runs four independent sub-checks (overlap, availability, travel-time, skill-match) and returns a unified `{ blocking, warnings, info }` partition. A new `POST /api/dispatch/check-feasibility` endpoint lets the UI preview during drag (debounced 150 ms). A new bare `POST /api/proposals` endpoint enforces the same gate at submit time, plus an `If-Match` header against `appointment.updatedAt` for optimistic concurrency. The two existing execution handlers (`reschedule-handler.ts`, `reassignment-handler.ts`) are refactored to delegate to the same composer so creation- and execution-time gates are guaranteed identical.

**Tech Stack:** TypeScript, Node, Express, Vitest, React, Tailwind. Google Distance Matrix HTTP API (with in-memory LRU cache + haversine fallback). No DB migration.

**Reviewer fixes folded in (vs. the brainstorming spec):**

1. `FeasibilityIssue.severity` includes `'info'` and `FeasibilityResult` carries an `info[]` array so the missing-coords signal has a transport channel. (gemini R136 + codex R270)
2. The overlap sub-check **does not cap** the sibling-appointment list. Overlap is the only blocking check; capping would let real conflicts pass both gates. (codex R225a)
3. The overlap sub-check queries siblings across a `[proposedStart - 24h, proposedEnd + 24h]` window, not "same day," so cross-midnight overlaps are detected. (codex R225b)
4. The `GoogleDistanceMatrixProvider` LRU cache key includes a 15-minute departure-time bucket so traffic-aware estimates aren't reused across rush vs. off-peak. (gemini R255)
5. The `/check-feasibility` route handler does an explicit `userRepo.findById(...)` existence check before invoking the composer, so an unknown `proposedTechnicianId` returns `404` deterministically. (codex R162)
6. The bare `POST /api/proposals` route is **created in this plan** (it does not exist on the server today — the web hook `useCreateScheduleProposal.ts` currently issues a request the server doesn't handle). Initial scope: `reschedule_appointment` and `reassign_appointment` only; other types `400`.

---

## File map

### New files (api)

| File | Responsibility |
|---|---|
| `packages/api/src/scheduling/feasibility-types.ts` | `FeasibilityIssue`, `FeasibilityResult`, `FeasibilityInput`, `FeasibilityDependencies`, `TravelTimeSummary`. |
| `packages/api/src/scheduling/feasibility.ts` | `checkFeasibility(...)` composer. Pure function over deps. |
| `packages/api/src/scheduling/travel-time/provider.ts` | `TravelTimeProvider` interface + `TravelTimeEstimate`, `LatLng` types. |
| `packages/api/src/scheduling/travel-time/haversine-fallback.ts` | `HaversineFallbackProvider`. Pure math. |
| `packages/api/src/scheduling/travel-time/google-provider.ts` | `GoogleDistanceMatrixProvider`. HTTP + LRU + haversine fallback on failure. |
| `packages/api/src/scheduling/travel-time/factory.ts` | `createTravelTimeProvider(env)` returning google or haversine. |
| `packages/api/src/scheduling/skill-matcher.ts` | `SkillMatcher` interface + `StubSkillMatcher`. |
| `packages/api/src/scheduling/routes.ts` | `createSchedulingRouter(deps)` → `POST /check-feasibility`. |
| `packages/api/src/proposals/create-scheduling.ts` | Helper that runs the version-check + feasibility gate and creates the proposal. Called from the new route. |
| `packages/api/test/scheduling/...` | Tests, mirroring the src tree. |
| `packages/api/test/proposals/scheduling-create.test.ts` | Integration test for the bare `POST /api/proposals` route. |
| `packages/api/test/dispatch/check-feasibility-route.test.ts` | Integration test for the preview route. |

### New files (web)

| File | Responsibility |
|---|---|
| `packages/web/src/components/dispatch/useFeasibilityPreview.ts` | Debounced (150 ms) hook calling `POST /api/dispatch/check-feasibility`. |
| `packages/web/src/components/dispatch/useFeasibilityPreview.test.ts` | Unit test for the debounce + result shape. |

### Modified files

| File | Change |
|---|---|
| `packages/api/src/dispatch/board-query.ts` | `BoardAppointment` gains `updatedAt: string`; `toBoardAppointment` surfaces it. |
| `packages/api/src/dispatch/routes.ts` | (No edits — feasibility route lives in its own router.) |
| `packages/api/src/routes/proposals.ts` | New bare `POST /` handler scoped to the two scheduling proposal types. |
| `packages/api/src/proposals/execution/reschedule-handler.ts` | Replace the inline overlap block (lines ~74–104) with a `checkFeasibility(...)` call. |
| `packages/api/src/proposals/execution/reassignment-handler.ts` | Same delegation. |
| `packages/api/src/app.ts` | Construct `TravelTimeProvider`, `SkillMatcher`, `UserRepository`, wire `FeasibilityDependencies`, mount the new router. |
| `packages/web/src/components/dispatch/useCreateScheduleProposal.ts` | Accept `appointmentVersion`; send `If-Match`; classify 409 / 422 / 400 responses. |
| `packages/web/src/components/dispatch/useCreateScheduleProposal.test.ts` | Cover the new branches. |
| `packages/web/src/pages/dispatch/DispatchBoard.tsx` | Route the inline `apiFetch('/api/proposals', ...)` through `useCreateScheduleProposal`; wire `useFeasibilityPreview`. |
| `packages/web/src/components/dispatch/TechnicianLane.tsx` | Color drop zones from preview feasibility result. |

### Out-of-scope deferrals

- `technician_skills` data model (separate spec — `StubSkillMatcher` stays the wired implementation).
- Tenant overrides for travel-time defaults.
- Pessimistic "Alex is editing this card" UX.
- Realtime push of competing dispatcher edits.

---

## Task 1: Shared feasibility types

**Files:**
- Create: `packages/api/src/scheduling/feasibility-types.ts`

- [ ] **Step 1: Write the type file**

```typescript
// packages/api/src/scheduling/feasibility-types.ts
import { Appointment, AppointmentRepository } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { JobRepository } from '../jobs/job';
import { LocationRepository } from '../locations/location';
import { WorkingHoursRepository } from '../availability/working-hours';
import { UnavailableBlockRepository } from '../availability/unavailable-block';
import { TravelTimeProvider } from './travel-time/provider';
import { SkillMatcher } from './skill-matcher';

export type FeasibilitySeverity = 'blocking' | 'warning' | 'info';

export type FeasibilityCheck =
  | 'overlap'
  | 'working_hours'
  | 'unavailable_block'
  | 'travel_time'
  | 'skill_match';

export interface FeasibilityIssue {
  check: FeasibilityCheck;
  severity: FeasibilitySeverity;
  message: string;
  conflictingEntityId?: string;
  metadata?: Record<string, unknown>;
}

export interface TravelTimeSummary {
  fromPrevSeconds: number | null;
  toNextSeconds: number | null;
  estimateSource: 'google' | 'haversine' | 'unknown';
  degraded: boolean;
}

export interface FeasibilityResult {
  feasible: boolean;
  blocking: FeasibilityIssue[];
  warnings: FeasibilityIssue[];
  info: FeasibilityIssue[];
  travelTime: TravelTimeSummary | null;
}

export interface FeasibilityInput {
  tenantId: string;
  /** Pre-loaded by the caller — never re-fetched inside the composer. Closes a TOCTOU window. */
  appointment: Appointment;
  proposedTechnicianId: string;
  proposedScheduledStart: Date;
  proposedScheduledEnd: Date;
}

export interface FeasibilityDependencies {
  assignmentRepo: AssignmentRepository;
  appointmentRepo: AppointmentRepository;
  jobRepo: JobRepository;
  locationRepo: LocationRepository;
  workingHoursRepo: WorkingHoursRepository;
  unavailableBlockRepo: UnavailableBlockRepository;
  travelTimeProvider: TravelTimeProvider;
  skillMatcher: SkillMatcher;
  timezone?: string;
  clock?: () => Date;
}
```

- [ ] **Step 2: Verify build**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS (will fail at the imports for `travel-time/provider` and `skill-matcher` — that's fine, those land in the next tasks). Defer the build check until Task 5.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/scheduling/feasibility-types.ts
git commit -m "feat(scheduling): add feasibility result + dependency types"
```

---

## Task 2: HaversineFallbackProvider (pure math, TDD)

**Files:**
- Create: `packages/api/src/scheduling/travel-time/provider.ts`
- Create: `packages/api/src/scheduling/travel-time/haversine-fallback.ts`
- Test: `packages/api/test/scheduling/travel-time/haversine-fallback.test.ts`

- [ ] **Step 1: Write the provider interface**

```typescript
// packages/api/src/scheduling/travel-time/provider.ts
export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface TravelTimeEstimate {
  seconds: number;
  source: 'google' | 'haversine';
  degraded: boolean;
}

export interface TravelTimeProvider {
  estimateDriveTime(
    origin: LatLng,
    destination: LatLng,
    departAt?: Date,
  ): Promise<TravelTimeEstimate>;
}
```

- [ ] **Step 2: Write failing tests**

```typescript
// packages/api/test/scheduling/travel-time/haversine-fallback.test.ts
import { describe, it, expect } from 'vitest';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

describe('HaversineFallbackProvider', () => {
  const provider = new HaversineFallbackProvider();

  it('returns 0 seconds for identical coordinates', async () => {
    const p = { latitude: 37.7749, longitude: -122.4194 };
    const result = await provider.estimateDriveTime(p, p);
    expect(result.seconds).toBe(0);
    expect(result.source).toBe('haversine');
    expect(result.degraded).toBe(false);
  });

  it('estimates ~roughly known distance between SF and Oakland', async () => {
    const sf = { latitude: 37.7749, longitude: -122.4194 };
    const oak = { latitude: 37.8044, longitude: -122.2712 };
    // Great-circle ~13.4 km, at 13.4 m/s ≈ 1000s. Allow ±20% slack.
    const result = await provider.estimateDriveTime(sf, oak);
    expect(result.seconds).toBeGreaterThan(800);
    expect(result.seconds).toBeLessThan(1200);
    expect(result.source).toBe('haversine');
  });

  it('produces a finite seconds value for antipodal coordinates', async () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 0, longitude: 180 };
    const result = await provider.estimateDriveTime(a, b);
    expect(Number.isFinite(result.seconds)).toBe(true);
    expect(result.seconds).toBeGreaterThan(0);
  });

  it('throws when an input coordinate is non-finite', async () => {
    const ok = { latitude: 37.7, longitude: -122.4 };
    const bad = { latitude: Number.NaN, longitude: 0 };
    await expect(provider.estimateDriveTime(ok, bad)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/travel-time/haversine-fallback.test.ts`
Expected: FAIL — "Cannot find module …/haversine-fallback".

- [ ] **Step 4: Implement**

```typescript
// packages/api/src/scheduling/travel-time/haversine-fallback.ts
import { LatLng, TravelTimeEstimate, TravelTimeProvider } from './provider';

const EARTH_RADIUS_METERS = 6_371_000;
const DRIVE_SPEED_METERS_PER_SECOND = 13.4; // ~30 mph

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function greatCircleMeters(a: LatLng, b: LatLng): number {
  if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)
   || !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)) {
    throw new Error('haversine: coordinates must be finite numbers');
  }
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class HaversineFallbackProvider implements TravelTimeProvider {
  async estimateDriveTime(origin: LatLng, destination: LatLng): Promise<TravelTimeEstimate> {
    const meters = greatCircleMeters(origin, destination);
    return {
      seconds: Math.round(meters / DRIVE_SPEED_METERS_PER_SECOND),
      source: 'haversine',
      degraded: false,
    };
  }
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/travel-time/haversine-fallback.test.ts`
Expected: PASS (all 4).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/scheduling/travel-time/provider.ts \
        packages/api/src/scheduling/travel-time/haversine-fallback.ts \
        packages/api/test/scheduling/travel-time/haversine-fallback.test.ts
git commit -m "feat(scheduling): add haversine travel-time fallback provider"
```

---

## Task 3: GoogleDistanceMatrixProvider with departAt-aware LRU cache

**Files:**
- Create: `packages/api/src/scheduling/travel-time/google-provider.ts`
- Test: `packages/api/test/scheduling/travel-time/google-provider.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/api/test/scheduling/travel-time/google-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDistanceMatrixProvider } from '../../../src/scheduling/travel-time/google-provider';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

const origin = { latitude: 37.7749, longitude: -122.4194 };
const destination = { latitude: 37.8044, longitude: -122.2712 };

function googleOk(seconds: number) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      status: 'OK',
      rows: [{ elements: [{ status: 'OK', duration: { value: seconds } }] }],
    }),
  } as unknown as Response;
}

describe('GoogleDistanceMatrixProvider', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns google-sourced seconds on the happy path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(googleOk(1234));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const r = await provider.estimateDriveTime(origin, destination, new Date('2026-05-17T09:00:00Z'));
    expect(r.source).toBe('google');
    expect(r.seconds).toBe(1234);
    expect(r.degraded).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('serves a cache hit without calling fetch a second time (same departAt bucket)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(googleOk(900));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const depart = new Date('2026-05-17T09:03:00Z'); // 15-min bucket = 09:00
    const departSameBucket = new Date('2026-05-17T09:14:00Z');
    await provider.estimateDriveTime(origin, destination, depart);
    await provider.estimateDriveTime(origin, destination, departSameBucket);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT serve a cache hit across departAt buckets (traffic-aware)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(googleOk(900));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    await provider.estimateDriveTime(origin, destination, new Date('2026-05-17T09:00:00Z'));
    await provider.estimateDriveTime(origin, destination, new Date('2026-05-17T17:00:00Z'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to haversine with degraded:true when Google throws', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network'));
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const r = await provider.estimateDriveTime(origin, destination);
    expect(r.source).toBe('haversine');
    expect(r.degraded).toBe(true);
    expect(Number.isFinite(r.seconds)).toBe(true);
  });

  it('falls back to haversine with degraded:true when Google returns non-OK row', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        status: 'OK', rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }],
      }),
    } as unknown as Response);
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'k', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    const r = await provider.estimateDriveTime(origin, destination);
    expect(r.source).toBe('haversine');
    expect(r.degraded).toBe(true);
  });

  it('never logs the API key on failure', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new GoogleDistanceMatrixProvider({
      apiKey: 'SECRET-XYZ', fetch: fetchSpy, fallback: new HaversineFallbackProvider(),
    });
    await provider.estimateDriveTime(origin, destination);
    const allLogs = warn.mock.calls.flat().map(String).join('\n');
    expect(allLogs).not.toContain('SECRET-XYZ');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/travel-time/google-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/api/src/scheduling/travel-time/google-provider.ts
import { LatLng, TravelTimeEstimate, TravelTimeProvider } from './provider';
import { HaversineFallbackProvider } from './haversine-fallback';

const DEFAULT_CACHE_TTL_SECONDS = Number(process.env.TRAVEL_TIME_CACHE_TTL_SECONDS ?? 300);
const DEFAULT_CACHE_MAX = Number(process.env.TRAVEL_TIME_CACHE_MAX_ENTRIES ?? 1000);
const DEPART_BUCKET_MINUTES = 15;

export interface GoogleProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  fallback?: TravelTimeProvider;
  cacheTtlSeconds?: number;
  cacheMaxEntries?: number;
  clock?: () => number;
  logger?: { warn: (msg: string) => void };
}

interface CacheEntry { value: TravelTimeEstimate; expiresAtMs: number; }

function round4(n: number): string { return n.toFixed(4); }

function bucketDepart(d: Date | undefined): string {
  if (!d) return 'none';
  const ms = d.getTime();
  const bucket = Math.floor(ms / (DEPART_BUCKET_MINUTES * 60_000));
  return String(bucket);
}

function cacheKey(o: LatLng, d: LatLng, depart: Date | undefined): string {
  return `${round4(o.latitude)},${round4(o.longitude)}->${round4(d.latitude)},${round4(d.longitude)}@${bucketDepart(depart)}`;
}

export class GoogleDistanceMatrixProvider implements TravelTimeProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: TravelTimeProvider;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly logger: { warn: (m: string) => void };
  private readonly cache = new Map<string, CacheEntry>(); // insertion-order = LRU eviction order

  constructor(opts: GoogleProviderOptions) {
    if (!opts.apiKey) throw new Error('GoogleDistanceMatrixProvider: apiKey required');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.fallback = opts.fallback ?? new HaversineFallbackProvider();
    this.ttlMs = (opts.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1000;
    this.maxEntries = opts.cacheMaxEntries ?? DEFAULT_CACHE_MAX;
    this.clock = opts.clock ?? (() => Date.now());
    this.logger = opts.logger ?? { warn: (m) => console.warn(m) };
  }

  async estimateDriveTime(origin: LatLng, destination: LatLng, departAt?: Date): Promise<TravelTimeEstimate> {
    const key = cacheKey(origin, destination, departAt);
    const now = this.clock();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAtMs > now) {
      this.cache.delete(key);
      this.cache.set(key, hit); // refresh LRU position
      return hit.value;
    }
    try {
      const seconds = await this.callGoogle(origin, destination, departAt);
      const value: TravelTimeEstimate = { seconds, source: 'google', degraded: false };
      this.put(key, { value, expiresAtMs: now + this.ttlMs });
      return value;
    } catch (err) {
      this.logger.warn(`travel-time: google distance-matrix failed; falling back to haversine (host=maps.googleapis.com): ${(err as Error).message}`);
      const fb = await this.fallback.estimateDriveTime(origin, destination, departAt);
      return { ...fb, degraded: true };
    }
  }

  private async callGoogle(origin: LatLng, destination: LatLng, departAt?: Date): Promise<number> {
    const params = new URLSearchParams({
      origins: `${origin.latitude},${origin.longitude}`,
      destinations: `${destination.latitude},${destination.longitude}`,
      mode: 'driving',
      key: this.apiKey,
    });
    if (departAt) params.set('departure_time', String(Math.floor(departAt.getTime() / 1000)));
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const resp = await this.fetchImpl(url);
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const body = await resp.json() as {
      status: string;
      rows?: Array<{ elements?: Array<{ status: string; duration?: { value: number }; duration_in_traffic?: { value: number } }> }>;
    };
    if (body.status !== 'OK') throw new Error(`google status=${body.status}`);
    const el = body.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') throw new Error(`element status=${el?.status ?? 'missing'}`);
    const seconds = el.duration_in_traffic?.value ?? el.duration?.value;
    if (typeof seconds !== 'number') throw new Error('no duration in response');
    return seconds;
  }

  private put(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/travel-time/google-provider.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/scheduling/travel-time/google-provider.ts \
        packages/api/test/scheduling/travel-time/google-provider.test.ts
git commit -m "feat(scheduling): add Google Distance Matrix provider with departAt-bucketed LRU cache"
```

---

## Task 4: TravelTimeProvider factory

**Files:**
- Create: `packages/api/src/scheduling/travel-time/factory.ts`
- Test: `packages/api/test/scheduling/travel-time/factory.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/api/test/scheduling/travel-time/factory.test.ts
import { describe, it, expect } from 'vitest';
import { createTravelTimeProvider } from '../../../src/scheduling/travel-time/factory';
import { GoogleDistanceMatrixProvider } from '../../../src/scheduling/travel-time/google-provider';
import { HaversineFallbackProvider } from '../../../src/scheduling/travel-time/haversine-fallback';

describe('createTravelTimeProvider', () => {
  it('returns haversine-only when GOOGLE_MAPS_API_KEY is unset', () => {
    const p = createTravelTimeProvider({});
    expect(p).toBeInstanceOf(HaversineFallbackProvider);
  });

  it('returns a Google provider when GOOGLE_MAPS_API_KEY is set', () => {
    const p = createTravelTimeProvider({ GOOGLE_MAPS_API_KEY: 'k' });
    expect(p).toBeInstanceOf(GoogleDistanceMatrixProvider);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/travel-time/factory.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// packages/api/src/scheduling/travel-time/factory.ts
import { TravelTimeProvider } from './provider';
import { HaversineFallbackProvider } from './haversine-fallback';
import { GoogleDistanceMatrixProvider } from './google-provider';

export function createTravelTimeProvider(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TravelTimeProvider {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return new HaversineFallbackProvider();
  return new GoogleDistanceMatrixProvider({ apiKey: key });
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/travel-time/factory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/scheduling/travel-time/factory.ts \
        packages/api/test/scheduling/travel-time/factory.test.ts
git commit -m "feat(scheduling): add travel-time provider factory"
```

---

## Task 5: SkillMatcher interface + StubSkillMatcher

**Files:**
- Create: `packages/api/src/scheduling/skill-matcher.ts`
- Test: `packages/api/test/scheduling/skill-matcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/api/test/scheduling/skill-matcher.test.ts
import { describe, it, expect } from 'vitest';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';

describe('StubSkillMatcher', () => {
  const m = new StubSkillMatcher();

  it('returns empty required skills for any job', async () => {
    expect(await m.requiredSkillsForJob('t', 'j')).toEqual([]);
  });

  it('returns empty held skills for any technician', async () => {
    expect(await m.skillsForTechnician('t', 'u')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/skill-matcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// packages/api/src/scheduling/skill-matcher.ts
export interface SkillMatcher {
  requiredSkillsForJob(tenantId: string, jobId: string): Promise<string[]>;
  skillsForTechnician(tenantId: string, technicianId: string): Promise<string[]>;
}

export class StubSkillMatcher implements SkillMatcher {
  async requiredSkillsForJob(): Promise<string[]> { return []; }
  async skillsForTechnician(): Promise<string[]> { return []; }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/skill-matcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the whole `scheduling/` tree compiles**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS (types from Task 1 now resolve).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/scheduling/skill-matcher.ts \
        packages/api/test/scheduling/skill-matcher.test.ts
git commit -m "feat(scheduling): add SkillMatcher interface and stub implementation"
```

---

## Task 6: Feasibility composer — overlap sub-check (windowed, no cap, cross-midnight)

**Files:**
- Create: `packages/api/src/scheduling/feasibility.ts`
- Test: `packages/api/test/scheduling/feasibility-overlap.test.ts`

> **Design note:** The overlap sibling query uses a `[proposedStart − 24h, proposedEnd + 24h]` window (catches cross-midnight neighbors) and **does NOT cap the result set**. Overlap is the only `blocking` check; capping siblings would silently let conflicts pass both creation and execution gates. The same window is reused by the travel-time sub-check in Task 8 — its 50-cap from the spec is also dropped because the time window already bounds the load (immediate neighbors only).

- [ ] **Step 1: Write failing test (TDD red)**

```typescript
// packages/api/test/scheduling/feasibility-overlap.test.ts
import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

// Minimal in-memory stubs for the repos we don't exercise here.
const noopAssignmentRepo: any = { findByTechnician: async () => [] };
const noopJobRepo: any = { findById: async () => null };
const noopLocationRepo: any = { findById: async () => null };
const noopWorkingHoursRepo: any = { findByTechnicianAndDay: async () => null };
const noopUnavailableBlockRepo: any = { findByTechnicianInRange: async () => [] };

function mkAppt(over: Partial<Appointment> = {}): Appointment {
  const start = new Date('2026-05-17T09:00:00Z');
  const end = new Date('2026-05-17T10:00:00Z');
  return {
    id: 'a-1', tenantId: 't-1', jobId: 'j-1',
    scheduledStart: start, scheduledEnd: end,
    timezone: 'UTC', status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u-1', createdAt: start, updatedAt: start,
    ...over,
  };
}

function depsWith(siblings: Appointment[], technicianId: string): FeasibilityDependencies {
  const assignmentRepo: any = {
    findByTechnician: async () => siblings.map((s) => ({
      id: `as-${s.id}`, tenantId: s.tenantId, appointmentId: s.id,
      technicianId, isPrimary: true, assignedBy: 'u-1', assignedAt: s.createdAt,
    })),
    findByAppointment: async () => [],
  };
  const appointmentRepo: any = {
    findById: async (_t: string, id: string) => siblings.find((s) => s.id === id) ?? null,
  };
  return {
    assignmentRepo, appointmentRepo,
    jobRepo: noopJobRepo, locationRepo: noopLocationRepo,
    workingHoursRepo: noopWorkingHoursRepo, unavailableBlockRepo: noopUnavailableBlockRepo,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
  };
}

describe('checkFeasibility — overlap sub-check', () => {
  it('returns feasible with no issues when the technician is free', async () => {
    const appt = mkAppt();
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt], 'tech-1'),
    );
    expect(r.feasible).toBe(true);
    expect(r.blocking).toHaveLength(0);
  });

  it('blocks when another sibling on the same technician overlaps', async () => {
    const appt = mkAppt({ id: 'a-target' });
    const conflict = mkAppt({
      id: 'a-conflict',
      scheduledStart: new Date('2026-05-17T09:30:00Z'),
      scheduledEnd: new Date('2026-05-17T10:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt, conflict], 'tech-1'),
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].check).toBe('overlap');
    expect(r.blocking[0].severity).toBe('blocking');
    expect(r.blocking[0].conflictingEntityId).toBe('a-conflict');
  });

  it('detects a cross-midnight overlap (proposed 23:30→00:30 vs sibling 00:00→01:00 next day)', async () => {
    const appt = mkAppt({
      id: 'a-target',
      scheduledStart: new Date('2026-05-17T23:30:00Z'),
      scheduledEnd: new Date('2026-05-18T00:30:00Z'),
    });
    const conflict = mkAppt({
      id: 'a-next',
      scheduledStart: new Date('2026-05-18T00:00:00Z'),
      scheduledEnd: new Date('2026-05-18T01:00:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt, conflict], 'tech-1'),
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking[0].conflictingEntityId).toBe('a-next');
  });

  it('does NOT count the appointment-being-moved as its own conflict', async () => {
    const appt = mkAppt({ id: 'a-self' });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt], 'tech-1'),
    );
    expect(r.blocking).toHaveLength(0);
  });

  it('does NOT cap the sibling list — finds an overlap that would be missed by a small cap', async () => {
    const appt = mkAppt({
      id: 'a-target',
      scheduledStart: new Date('2026-05-17T15:00:00Z'),
      scheduledEnd: new Date('2026-05-17T16:00:00Z'),
    });
    // 100 non-overlapping siblings earlier in the day, then one overlapping sibling at the end.
    const noise = Array.from({ length: 100 }, (_, i) => mkAppt({
      id: `noise-${i}`,
      scheduledStart: new Date(`2026-05-17T${String(i % 24).padStart(2, '0')}:00:00Z`),
      scheduledEnd: new Date(`2026-05-17T${String(i % 24).padStart(2, '0')}:15:00Z`),
    }));
    const conflict = mkAppt({
      id: 'a-conflict-late',
      scheduledStart: new Date('2026-05-17T15:30:00Z'),
      scheduledEnd: new Date('2026-05-17T16:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      depsWith([appt, ...noise, conflict], 'tech-1'),
    );
    expect(r.feasible).toBe(false);
    expect(r.blocking.some((b) => b.conflictingEntityId === 'a-conflict-late')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/feasibility-overlap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `checkFeasibility` with overlap-only behavior first**

```typescript
// packages/api/src/scheduling/feasibility.ts
import { detectOverlappingAppointments } from '../dispatch/validation';
import {
  FeasibilityInput, FeasibilityDependencies, FeasibilityResult,
  FeasibilityIssue, TravelTimeSummary,
} from './feasibility-types';
import { Appointment } from '../appointments/appointment';

const WINDOW_MS = 24 * 60 * 60 * 1000;

async function loadTechnicianAppointmentsInWindow(
  deps: FeasibilityDependencies,
  tenantId: string,
  technicianId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Array<Appointment & { technicianId: string }>> {
  const assignments = await deps.assignmentRepo.findByTechnician(tenantId, technicianId);
  const appts = await Promise.all(
    assignments.map((a) => deps.appointmentRepo.findById(tenantId, a.appointmentId)),
  );
  return appts
    .filter((a): a is Appointment => a !== null)
    .filter((a) => a.scheduledEnd > windowStart && a.scheduledStart < windowEnd)
    .map((a) => ({ ...a, technicianId }));
}

async function overlapIssues(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityIssue[]> {
  const windowStart = new Date(input.proposedScheduledStart.getTime() - WINDOW_MS);
  const windowEnd = new Date(input.proposedScheduledEnd.getTime() + WINDOW_MS);
  const siblings = await loadTechnicianAppointmentsInWindow(
    deps, input.tenantId, input.proposedTechnicianId, windowStart, windowEnd,
  );
  const conflicts = detectOverlappingAppointments(
    input.proposedTechnicianId,
    input.proposedScheduledStart,
    input.proposedScheduledEnd,
    siblings,
    input.appointment.id,
  );
  return conflicts.map((c) => ({
    check: 'overlap',
    severity: 'blocking',
    message: c.message,
    conflictingEntityId: c.conflictingEntityId,
  }));
}

function partition(issues: FeasibilityIssue[], travelTime: TravelTimeSummary | null): FeasibilityResult {
  const blocking = issues.filter((i) => i.severity === 'blocking');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const info = issues.filter((i) => i.severity === 'info');
  return {
    feasible: blocking.length === 0,
    blocking, warnings, info,
    travelTime,
  };
}

export async function checkFeasibility(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityResult> {
  const all = await overlapIssues(input, deps);
  return partition(all, null);
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/feasibility-overlap.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/scheduling/feasibility.ts \
        packages/api/test/scheduling/feasibility-overlap.test.ts
git commit -m "feat(scheduling): add overlap sub-check (windowed, uncapped, cross-midnight aware)"
```

---

## Task 7: Feasibility composer — availability sub-check

**Files:**
- Modify: `packages/api/src/scheduling/feasibility.ts`
- Create: `packages/api/test/scheduling/feasibility-availability.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/api/test/scheduling/feasibility-availability.test.ts
import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

function mkAppt(): Appointment {
  return {
    id: 'a-1', tenantId: 't-1', jobId: 'j-1',
    scheduledStart: new Date('2026-05-17T19:00:00Z'), // 12:00 PT
    scheduledEnd: new Date('2026-05-17T20:00:00Z'),
    timezone: 'America/Los_Angeles', status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  };
}

function deps(workingHours: any, unavailableBlocks: any[] = []): FeasibilityDependencies {
  const technicianId = 'tech-1';
  return {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: { findById: async () => null } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => workingHours } as any,
    unavailableBlockRepo: { findByTechnicianInRange: async () => unavailableBlocks } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
    timezone: 'America/Los_Angeles',
  };
}

describe('checkFeasibility — availability sub-check', () => {
  it('emits a working-hours warning when the proposal is outside hours', async () => {
    const appt = mkAppt(); // 12:00–13:00 PT
    const wh = { id: 'wh', tenantId: 't-1', technicianId: 'tech-1',
                 dayOfWeek: 0, startTime: '14:00', endTime: '17:00', isActive: true,
                 createdAt: new Date(), updatedAt: new Date() };
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps(wh),
    );
    expect(r.feasible).toBe(true);                  // warning, not blocking
    expect(r.warnings.some((w) => w.check === 'working_hours')).toBe(true);
  });

  it('emits an unavailable-block warning when the proposal overlaps a block', async () => {
    const appt = mkAppt();
    const blocks = [{
      id: 'b-1', tenantId: 't-1', technicianId: 'tech-1',
      startTime: new Date('2026-05-17T19:30:00Z'),
      endTime: new Date('2026-05-17T20:30:00Z'),
      reason: 'PTO', createdAt: new Date(), updatedAt: new Date(),
    }];
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt.scheduledStart, proposedScheduledEnd: appt.scheduledEnd },
      deps(null, blocks),
    );
    expect(r.feasible).toBe(true);
    expect(r.warnings.some((w) => w.check === 'unavailable_block')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/feasibility-availability.test.ts`
Expected: FAIL — availability sub-check not present yet.

- [ ] **Step 3: Add availability sub-check to `feasibility.ts`**

Add this to `packages/api/src/scheduling/feasibility.ts`:

```typescript
import { detectAvailabilityConflicts } from '../dispatch/validation';

async function availabilityIssues(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityIssue[]> {
  const dayOfWeek = input.proposedScheduledStart.getUTCDay();
  const wh = await deps.workingHoursRepo.findByTechnicianAndDay(
    input.tenantId, input.proposedTechnicianId, dayOfWeek,
  );
  const blocks = await deps.unavailableBlockRepo.findByTechnicianInRange(
    input.tenantId, input.proposedTechnicianId,
    input.proposedScheduledStart, input.proposedScheduledEnd,
  );
  const conflicts = detectAvailabilityConflicts(
    input.proposedScheduledStart, input.proposedScheduledEnd,
    wh, blocks, deps.timezone ?? input.appointment.timezone ?? 'UTC',
  );
  return conflicts.map((c) => ({
    check: c.type === 'outside_working_hours' ? 'working_hours' : 'unavailable_block',
    severity: 'warning',
    message: c.message,
    conflictingEntityId: c.conflictingEntityId,
  }));
}
```

Update `checkFeasibility` to call both:

```typescript
export async function checkFeasibility(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityResult> {
  const [overlap, availability] = await Promise.all([
    overlapIssues(input, deps),
    availabilityIssues(input, deps),
  ]);
  return partition([...overlap, ...availability], null);
}
```

> Repository method names assumed: `WorkingHoursRepository.findByTechnicianAndDay(tenantId, technicianId, dayOfWeek)` and `UnavailableBlockRepository.findByTechnicianInRange(tenantId, technicianId, start, end)`. If the existing names differ, adapt the call sites; do not change the repos. If a method doesn't exist yet, add the smallest wrapper in the composer file rather than reshaping the repo interface in this task.

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/feasibility-availability.test.ts test/scheduling/feasibility-overlap.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/scheduling/feasibility.ts \
        packages/api/test/scheduling/feasibility-availability.test.ts
git commit -m "feat(scheduling): add availability sub-check (working-hours, unavailable-blocks)"
```

---

## Task 8: Feasibility composer — travel-time sub-check (warn on tight, info on missing coords)

**Files:**
- Modify: `packages/api/src/scheduling/feasibility.ts`
- Create: `packages/api/test/scheduling/feasibility-travel-time.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/api/test/scheduling/feasibility-travel-time.test.ts
import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { TravelTimeProvider } from '../../src/scheduling/travel-time/provider';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

const SF = { latitude: 37.7749, longitude: -122.4194 };
const OAK = { latitude: 37.8044, longitude: -122.2712 };

function mkAppt(over: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a-target', tenantId: 't-1', jobId: 'j-target',
    scheduledStart: new Date('2026-05-17T10:00:00Z'),
    scheduledEnd: new Date('2026-05-17T11:00:00Z'),
    timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function depsWithNeighbor(opts: {
  neighbor?: Appointment & { locationId?: string };
  targetLocationId?: string;
  locations?: Record<string, { latitude?: number; longitude?: number }>;
  jobs?: Record<string, { locationId?: string }>;
  travelSeconds?: number;
}): FeasibilityDependencies {
  const technicianId = 'tech-1';
  const jobs = opts.jobs ?? {};
  const locations = opts.locations ?? {};
  const provider: TravelTimeProvider = {
    estimateDriveTime: async () => ({ seconds: opts.travelSeconds ?? 0, source: 'haversine', degraded: false }),
  };
  return {
    assignmentRepo: {
      findByTechnician: async () => opts.neighbor
        ? [{ id: 'as-n', tenantId: 't-1', appointmentId: opts.neighbor.id,
             technicianId, isPrimary: true, assignedBy: 'u-1', assignedAt: new Date() }]
        : [],
    } as any,
    appointmentRepo: {
      findById: async (_t: string, id: string) =>
        opts.neighbor && opts.neighbor.id === id ? opts.neighbor : null,
    } as any,
    jobRepo: { findById: async (_t: string, id: string) => jobs[id] ?? null } as any,
    locationRepo: { findById: async (_t: string, id: string) => locations[id] ?? null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
    unavailableBlockRepo: { findByTechnicianInRange: async () => [] } as any,
    travelTimeProvider: provider,
    skillMatcher: new StubSkillMatcher(),
  };
}

describe('checkFeasibility — travel-time sub-check', () => {
  it('emits a travel_time warning when the gap to the previous neighbor is shorter than the drive', async () => {
    const target = mkAppt({ jobId: 'j-target' });
    const prev = mkAppt({
      id: 'a-prev', jobId: 'j-prev',
      scheduledStart: new Date('2026-05-17T08:30:00Z'),
      scheduledEnd: new Date('2026-05-17T09:55:00Z'), // 5-min gap before target
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        neighbor: prev,
        jobs: { 'j-target': { locationId: 'L-target' }, 'j-prev': { locationId: 'L-prev' } },
        locations: { 'L-target': SF, 'L-prev': OAK },
        travelSeconds: 1200, // 20 min — does not fit in the 5-min gap
      }),
    );
    expect(r.warnings.some((w) => w.check === 'travel_time')).toBe(true);
    expect(r.travelTime?.fromPrevSeconds).toBe(1200);
  });

  it('emits an info entry (not a warning) when neighbor location coords are missing', async () => {
    const target = mkAppt({ jobId: 'j-target' });
    const prev = mkAppt({
      id: 'a-prev', jobId: 'j-prev',
      scheduledStart: new Date('2026-05-17T08:00:00Z'),
      scheduledEnd: new Date('2026-05-17T09:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        neighbor: prev,
        jobs: { 'j-target': { locationId: 'L-target' }, 'j-prev': { locationId: 'L-prev' } },
        locations: { 'L-target': SF, 'L-prev': { latitude: undefined, longitude: undefined } },
        travelSeconds: 99999,
      }),
    );
    expect(r.warnings.some((w) => w.check === 'travel_time')).toBe(false);
    expect(r.info.some((i) => i.check === 'travel_time' && (i.metadata as any)?.reason === 'missing_coords')).toBe(true);
  });

  it('returns travelTime null when there are no neighbors', async () => {
    const target = mkAppt({ jobId: 'j-target' });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        jobs: { 'j-target': { locationId: 'L-target' } },
        locations: { 'L-target': SF },
      }),
    );
    expect(r.travelTime).toEqual({
      fromPrevSeconds: null, toNextSeconds: null,
      estimateSource: 'unknown', degraded: false,
    });
  });

  it('uses a [start-24h, end+24h] window so cross-midnight neighbors are considered', async () => {
    const target = mkAppt({
      scheduledStart: new Date('2026-05-17T23:30:00Z'),
      scheduledEnd: new Date('2026-05-18T00:30:00Z'),
    });
    const next = mkAppt({
      id: 'a-next', jobId: 'j-next',
      scheduledStart: new Date('2026-05-18T00:35:00Z'),
      scheduledEnd: new Date('2026-05-18T01:30:00Z'),
    });
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: target, proposedTechnicianId: 'tech-1',
        proposedScheduledStart: target.scheduledStart, proposedScheduledEnd: target.scheduledEnd },
      depsWithNeighbor({
        neighbor: next,
        jobs: { 'j-target': { locationId: 'L-target' }, 'j-next': { locationId: 'L-next' } },
        locations: { 'L-target': SF, 'L-next': OAK },
        travelSeconds: 900, // 15-min drive vs. 5-min gap
      }),
    );
    expect(r.warnings.some((w) => w.check === 'travel_time')).toBe(true);
    expect(r.travelTime?.toNextSeconds).toBe(900);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/feasibility-travel-time.test.ts`
Expected: FAIL — sub-check not yet present.

- [ ] **Step 3: Add the travel-time sub-check to `feasibility.ts`**

Add to `packages/api/src/scheduling/feasibility.ts`:

```typescript
import { LatLng, TravelTimeProvider } from './travel-time/provider';

async function locationCoordsFor(
  deps: FeasibilityDependencies,
  tenantId: string,
  jobId: string,
): Promise<{ coords: LatLng | null }> {
  const job = await deps.jobRepo.findById(tenantId, jobId);
  const locationId = (job as any)?.locationId as string | undefined;
  if (!locationId) return { coords: null };
  const loc = await deps.locationRepo.findById(tenantId, locationId);
  const lat = (loc as any)?.latitude;
  const lng = (loc as any)?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return { coords: null };
  return { coords: { latitude: lat, longitude: lng } };
}

async function travelTimeIssues(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<{ issues: FeasibilityIssue[]; summary: TravelTimeSummary }> {
  const windowStart = new Date(input.proposedScheduledStart.getTime() - WINDOW_MS);
  const windowEnd = new Date(input.proposedScheduledEnd.getTime() + WINDOW_MS);
  const siblings = (await loadTechnicianAppointmentsInWindow(
    deps, input.tenantId, input.proposedTechnicianId, windowStart, windowEnd,
  )).filter((a) => a.id !== input.appointment.id)
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());

  const prev = [...siblings].reverse().find((a) => a.scheduledEnd <= input.proposedScheduledStart) ?? null;
  const next = siblings.find((a) => a.scheduledStart >= input.proposedScheduledEnd) ?? null;

  const summary: TravelTimeSummary = {
    fromPrevSeconds: null, toNextSeconds: null,
    estimateSource: 'unknown', degraded: false,
  };
  const issues: FeasibilityIssue[] = [];
  if (!prev && !next) return { issues, summary };

  const target = await locationCoordsFor(deps, input.tenantId, input.appointment.jobId);

  for (const [neighbor, kind] of [
    [prev, 'fromPrev'] as const,
    [next, 'toNext'] as const,
  ]) {
    if (!neighbor) continue;
    const neighborCoords = await locationCoordsFor(deps, input.tenantId, neighbor.jobId);
    if (!target.coords || !neighborCoords.coords) {
      issues.push({
        check: 'travel_time', severity: 'info',
        message: 'Travel-time unverified — neighbor or target location is missing coordinates.',
        conflictingEntityId: neighbor.id,
        metadata: { reason: 'missing_coords', neighborAppointmentId: neighbor.id, kind },
      });
      continue;
    }
    const [origin, destination] = kind === 'fromPrev'
      ? [neighborCoords.coords, target.coords]
      : [target.coords, neighborCoords.coords];
    const departAt = kind === 'fromPrev' ? neighbor.scheduledEnd : input.proposedScheduledEnd;
    const est = await deps.travelTimeProvider.estimateDriveTime(origin, destination, departAt);
    summary.estimateSource = est.source;
    summary.degraded ||= est.degraded;
    if (kind === 'fromPrev') summary.fromPrevSeconds = est.seconds;
    else summary.toNextSeconds = est.seconds;

    const gapSeconds = kind === 'fromPrev'
      ? Math.floor((input.proposedScheduledStart.getTime() - neighbor.scheduledEnd.getTime()) / 1000)
      : Math.floor((neighbor.scheduledStart.getTime() - input.proposedScheduledEnd.getTime()) / 1000);
    if (gapSeconds < est.seconds) {
      issues.push({
        check: 'travel_time', severity: 'warning',
        message: `Travel from ${kind === 'fromPrev' ? 'previous appointment' : 'this appointment'} requires ~${est.seconds}s but only ${gapSeconds}s available.`,
        conflictingEntityId: neighbor.id,
        metadata: { neighborAppointmentId: neighbor.id, gapSeconds, travelSeconds: est.seconds, source: est.source, kind },
      });
    }
  }
  return { issues, summary };
}
```

Update `checkFeasibility`:

```typescript
export async function checkFeasibility(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityResult> {
  const [overlap, availability, travel] = await Promise.all([
    overlapIssues(input, deps),
    availabilityIssues(input, deps),
    travelTimeIssues(input, deps),
  ]);
  return partition([...overlap, ...availability, ...travel.issues], travel.summary);
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/feasibility-travel-time.test.ts test/scheduling/feasibility-overlap.test.ts test/scheduling/feasibility-availability.test.ts`
Expected: PASS (all 11).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/scheduling/feasibility.ts \
        packages/api/test/scheduling/feasibility-travel-time.test.ts
git commit -m "feat(scheduling): add travel-time sub-check with info-severity missing-coords signal"
```

---

## Task 9: Feasibility composer — skill match sub-check

**Files:**
- Modify: `packages/api/src/scheduling/feasibility.ts`
- Create: `packages/api/test/scheduling/feasibility-skill.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/api/test/scheduling/feasibility-skill.test.ts
import { describe, it, expect } from 'vitest';
import { checkFeasibility } from '../../src/scheduling/feasibility';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { SkillMatcher, StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import { Appointment } from '../../src/appointments/appointment';

function appt(): Appointment {
  return {
    id: 'a-1', tenantId: 't-1', jobId: 'j-1',
    scheduledStart: new Date('2026-05-17T10:00:00Z'),
    scheduledEnd: new Date('2026-05-17T11:00:00Z'),
    timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
    createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  };
}

function deps(matcher: SkillMatcher): FeasibilityDependencies {
  return {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: { findById: async () => null } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
    unavailableBlockRepo: { findByTechnicianInRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: matcher,
  };
}

describe('checkFeasibility — skill match sub-check', () => {
  it('produces no issue when StubSkillMatcher is wired (required=[])', async () => {
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(new StubSkillMatcher()),
    );
    expect(r.warnings.some((w) => w.check === 'skill_match')).toBe(false);
  });

  it('warns when the technician is missing a required skill', async () => {
    const matcher: SkillMatcher = {
      requiredSkillsForJob: async () => ['hvac', 'electrical'],
      skillsForTechnician: async () => ['hvac'],
    };
    const r = await checkFeasibility(
      { tenantId: 't-1', appointment: appt(), proposedTechnicianId: 'tech-1',
        proposedScheduledStart: appt().scheduledStart, proposedScheduledEnd: appt().scheduledEnd },
      deps(matcher),
    );
    const issue = r.warnings.find((w) => w.check === 'skill_match');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect((issue?.metadata as any).missingSkills).toEqual(['electrical']);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/feasibility-skill.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the skill sub-check to `feasibility.ts`**

```typescript
async function skillMatchIssues(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityIssue[]> {
  const required = await deps.skillMatcher.requiredSkillsForJob(input.tenantId, input.appointment.jobId);
  if (required.length === 0) return [];
  const held = await deps.skillMatcher.skillsForTechnician(input.tenantId, input.proposedTechnicianId);
  const missing = required.filter((s) => !held.includes(s));
  if (missing.length === 0) return [];
  return [{
    check: 'skill_match',
    severity: 'warning',
    message: `Technician is missing required skill(s): ${missing.join(', ')}`,
    metadata: { missingSkills: missing },
  }];
}
```

Update `checkFeasibility`:

```typescript
export async function checkFeasibility(
  input: FeasibilityInput,
  deps: FeasibilityDependencies,
): Promise<FeasibilityResult> {
  const [overlap, availability, travel, skill] = await Promise.all([
    overlapIssues(input, deps),
    availabilityIssues(input, deps),
    travelTimeIssues(input, deps),
    skillMatchIssues(input, deps),
  ]);
  return partition([...overlap, ...availability, ...travel.issues, ...skill], travel.summary);
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/`
Expected: PASS (all scheduling tests green; ≥13 cases).

- [ ] **Step 5: Build verification**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/scheduling/feasibility.ts \
        packages/api/test/scheduling/feasibility-skill.test.ts
git commit -m "feat(scheduling): add skill-match sub-check (warning severity, stub-friendly)"
```

---

## Task 10: Expose `updatedAt` on the dispatch board response

**Files:**
- Modify: `packages/api/src/dispatch/board-query.ts`
- Modify: `packages/api/test/dispatch/board-query.test.ts` (if it asserts the response shape — extend; otherwise add a focused test)

> **Why:** The dispatcher UI needs `appointment.updatedAt` as the `If-Match` token at drag-time. Without surfacing it on the board response, every `POST /api/proposals` would 400 on missing version.

- [ ] **Step 1: Add a failing assertion**

Open `packages/api/test/dispatch/board-query.test.ts`, find a test that builds a `BoardAppointment`, add:

```typescript
expect(boardAppt.updatedAt).toBeDefined();
expect(typeof boardAppt.updatedAt).toBe('string');
expect(() => new Date(boardAppt.updatedAt!).toISOString()).not.toThrow();
```

(If no test exists that ergonomically exercises this, add a small dedicated test below the others.)

- [ ] **Step 2: Run tests — verify failure**

Run: `cd packages/api && npx vitest run test/dispatch/board-query.test.ts`
Expected: FAIL — `updatedAt` is undefined.

- [ ] **Step 3: Update the type + mapper**

In `packages/api/src/dispatch/board-query.ts`:

```typescript
export interface BoardAppointment {
  // ...existing fields...
  updatedAt: string;
}
```

In `toBoardAppointment(...)`:

```typescript
return {
  // ...existing fields...
  updatedAt: toISOString(appointment.updatedAt),
};
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/dispatch/board-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/dispatch/board-query.ts packages/api/test/dispatch/board-query.test.ts
git commit -m "feat(dispatch): surface appointment.updatedAt on board response (If-Match token)"
```

---

## Task 11: `POST /api/dispatch/check-feasibility` route

**Files:**
- Create: `packages/api/src/scheduling/routes.ts`
- Create: `packages/api/test/scheduling/check-feasibility-route.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/api/test/scheduling/check-feasibility-route.test.ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSchedulingRouter } from '../../src/scheduling/routes';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { Appointment } from '../../src/appointments/appointment';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

function fakeAuth(req: any, _res: any, next: any) {
  req.auth = { tenantId: 't-1', userId: 'u-1', role: 'dispatcher' };
  next();
}

function makeApp(appts: Appointment[], technicians: { id: string; role: string }[]) {
  const deps: FeasibilityDependencies = {
    assignmentRepo: { findByTechnician: async () => [] } as any,
    appointmentRepo: {
      findById: async (_t: string, id: string) => appts.find((a) => a.id === id) ?? null,
    } as any,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
    unavailableBlockRepo: { findByTechnicianInRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
  };
  const userRepo = {
    findById: async (_t: string, id: string) => technicians.find((u) => u.id === id) ?? null,
  } as any;
  const app = express();
  app.use(express.json());
  app.use(fakeAuth);
  app.use((req: any, _res, next) => { req.tenantId = req.auth.tenantId; next(); });
  app.use('/api/dispatch', createSchedulingRouter(deps, userRepo));
  return app;
}

const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: 'a-1', tenantId: 't-1', jobId: 'j-1',
  scheduledStart: new Date('2026-05-17T10:00:00Z'),
  scheduledEnd: new Date('2026-05-17T11:00:00Z'),
  timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
  createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
  ...over,
});

describe('POST /api/dispatch/check-feasibility', () => {
  it('returns 200 with feasible:true on a clean proposal', async () => {
    const app = makeApp([appt()], [{ id: 'tech-1', role: 'technician' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.feasible).toBe(true);
    expect(Array.isArray(res.body.blocking)).toBe(true);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(Array.isArray(res.body.info)).toBe(true);
  });

  it('returns 404 when the appointment does not exist', async () => {
    const app = makeApp([], [{ id: 'tech-1', role: 'technician' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'missing', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('APPOINTMENT_NOT_FOUND');
  });

  it('returns 404 when the technician does not exist', async () => {
    const app = makeApp([appt()], []);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'unknown',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TECHNICIAN_NOT_FOUND');
  });

  it('returns 404 when the user exists but is not a technician', async () => {
    const app = makeApp([appt()], [{ id: 'tech-1', role: 'dispatcher' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: '2026-05-17T10:00:00Z',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TECHNICIAN_NOT_FOUND');
  });

  it('returns 400 when scheduledStart/End are not valid ISO dates', async () => {
    const app = makeApp([appt()], [{ id: 'tech-1', role: 'technician' }]);
    const res = await request(app).post('/api/dispatch/check-feasibility').send({
      appointmentId: 'a-1', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: 'not-a-date',
      proposedScheduledEnd: '2026-05-17T11:00:00Z',
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd packages/api && npx vitest run test/scheduling/check-feasibility-route.test.ts`
Expected: FAIL — module not present.

- [ ] **Step 3: Implement the router**

```typescript
// packages/api/src/scheduling/routes.ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';
import { UserRepository } from '../users/user';
import { FeasibilityDependencies } from './feasibility-types';
import { checkFeasibility } from './feasibility';

const bodySchema = z.object({
  appointmentId: z.string().min(1),
  proposedTechnicianId: z.string().min(1),
  proposedScheduledStart: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid ISO date'),
  proposedScheduledEnd: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid ISO date'),
});

export function createSchedulingRouter(
  deps: FeasibilityDependencies,
  userRepo: UserRepository,
): Router {
  const router = Router();

  router.post(
    '/check-feasibility',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = validate(bodySchema, req.body);
        const tenantId = req.auth!.tenantId;

        const appointment = await deps.appointmentRepo.findById(tenantId, parsed.appointmentId);
        if (!appointment) {
          res.status(404).json({ error: 'APPOINTMENT_NOT_FOUND' });
          return;
        }

        const tech = await userRepo.findById(tenantId, parsed.proposedTechnicianId);
        if (!tech || tech.role !== 'technician') {
          res.status(404).json({ error: 'TECHNICIAN_NOT_FOUND' });
          return;
        }

        const result = await checkFeasibility(
          {
            tenantId,
            appointment,
            proposedTechnicianId: parsed.proposedTechnicianId,
            proposedScheduledStart: new Date(parsed.proposedScheduledStart),
            proposedScheduledEnd: new Date(parsed.proposedScheduledEnd),
          },
          deps,
        );

        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/scheduling/check-feasibility-route.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/scheduling/routes.ts \
        packages/api/test/scheduling/check-feasibility-route.test.ts
git commit -m "feat(dispatch): add POST /api/dispatch/check-feasibility preview endpoint"
```

---

## Task 12: Refactor `reschedule-handler.ts` to delegate to `checkFeasibility`

**Files:**
- Modify: `packages/api/src/proposals/execution/reschedule-handler.ts`
- Modify: `packages/api/test/proposals/execution/reschedule-handler.test.ts`

> **Behavioral delta:** the handler now runs all four sub-checks instead of just overlap. Only `blocking[]` short-circuits execution (today that's overlap only). The other sub-checks produce telemetry that did not exist before. The string returned in `result.error` becomes the first blocking issue's `message` to match the prior shape; warnings/info ride along in a new `result.warnings` field (additive — existing callers ignoring it are unaffected).

- [ ] **Step 1: Update test assertions and add new ones**

In `packages/api/test/proposals/execution/reschedule-handler.test.ts`:

```typescript
it('rejects when feasibility reports a blocking overlap', async () => {
  // existing overlap test body, plus:
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/Overlaps with/);
});

it('passes feasibility (warnings only) — execution proceeds and warnings are surfaced', async () => {
  // Set up: working-hours violation only (warning, not blocking).
  // ...build context...
  const result = await handler.execute(proposal, context);
  expect(result.success).toBe(true);
  expect(result.warnings?.some((w: any) => w.check === 'working_hours')).toBe(true);
});
```

- [ ] **Step 2: Run tests — verify failures point at the new structure**

Run: `cd packages/api && npx vitest run test/proposals/execution/reschedule-handler.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Refactor `reschedule-handler.ts`**

Replace the inline overlap block (the `if (this.assignmentRepo) { ... }` section after the freshness check) with:

```typescript
// Feasibility gate — delegates to scheduling/feasibility.ts so creation- and
// execution-time checks are guaranteed identical. Only `blocking[]` short-circuits.
const feasibility = await checkFeasibility(
  {
    tenantId: context.tenantId,
    appointment,
    proposedTechnicianId: primary?.technicianId ?? appointment.technicianId ?? '',
    proposedScheduledStart: startDate,
    proposedScheduledEnd: endDate,
  },
  this.feasibilityDeps,
);
if (feasibility.blocking.length > 0) {
  return {
    success: false,
    error: feasibility.blocking[0].message,
    warnings: feasibility.warnings,
  } as any;
}
const trailingWarnings = feasibility.warnings;
```

Update the success-return path to include `warnings: trailingWarnings`:

```typescript
return { success: true, /* existing fields */, warnings: trailingWarnings };
```

Add `feasibilityDeps: FeasibilityDependencies` to the handler's constructor options. Keep the existing `assignmentRepo` / `appointmentRepo` properties for the freshness path (they remain in use upstream).

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/proposals/execution/reschedule-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Build verification**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS (some app.ts wiring will be missing — defer to Task 14, where `feasibilityDeps` is constructed and injected).

If the build fails on `feasibilityDeps` not being injected: thread the param through the handler constructor signature only; the call site is updated in Task 14.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/proposals/execution/reschedule-handler.ts \
        packages/api/test/proposals/execution/reschedule-handler.test.ts
git commit -m "refactor(proposals): delegate reschedule overlap check to checkFeasibility"
```

---

## Task 13: Refactor `reassignment-handler.ts` to delegate to `checkFeasibility`

**Files:**
- Modify: `packages/api/src/proposals/execution/reassignment-handler.ts`
- Modify: `packages/api/test/proposals/execution/reassignment-handler.test.ts`

- [ ] **Step 1: Mirror the reschedule-handler changes**

Apply the same pattern from Task 12 to `reassignment-handler.ts`:
- Replace inline overlap with `checkFeasibility(...)`.
- Take `feasibilityDeps` in the constructor.
- Return `warnings` on both success and failure paths.

For the proposed times, use the appointment's current `scheduledStart`/`scheduledEnd` (a reassignment keeps the times; only the technician changes). The proposed technician comes from the proposal payload.

- [ ] **Step 2: Mirror the test changes**

Add the same two test cases (blocking overlap; warnings-only passes through).

- [ ] **Step 3: Run tests**

Run: `cd packages/api && npx vitest run test/proposals/execution/reassignment-handler.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/proposals/execution/reassignment-handler.ts \
        packages/api/test/proposals/execution/reassignment-handler.test.ts
git commit -m "refactor(proposals): delegate reassignment overlap check to checkFeasibility"
```

---

## Task 14: Bare `POST /api/proposals` with `If-Match` + feasibility gate (scheduling types only)

**Files:**
- Create: `packages/api/src/proposals/create-scheduling.ts`
- Modify: `packages/api/src/routes/proposals.ts`
- Create: `packages/api/test/proposals/scheduling-create.test.ts`

> **Why a new endpoint:** `useCreateScheduleProposal.ts` calls `POST /api/proposals` already, but the server does not handle the bare path — only `/approve-batch`, `/:id/approve`, `/:id/reject`, `/:id/undo`, `PUT /:id`. The web call returns 404 in production today. This task adds the missing route, scoped to the two scheduling proposal types from day one (the only paths needed for this feature).

- [ ] **Step 1: Write failing integration tests**

```typescript
// packages/api/test/proposals/scheduling-create.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';

// (Use the same fakeAuth + tenant context middleware as the route test in Task 11.)

describe('POST /api/proposals — scheduling create with version + feasibility gates', () => {
  let app: express.Express;
  let proposalRepo: InMemoryProposalRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let appointment: any;
  let feasibilityDeps: FeasibilityDependencies;

  beforeEach(async () => {
    proposalRepo = new InMemoryProposalRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    appointment = await appointmentRepo.create({
      id: 'a-1', tenantId: 't-1', jobId: 'j-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
      createdBy: 'u-1', createdAt: new Date('2026-05-16T00:00:00.000Z'),
      updatedAt: new Date('2026-05-16T00:00:00.000Z'),
    });
    feasibilityDeps = {
      assignmentRepo: { findByTechnician: async () => [] } as any,
      appointmentRepo,
      jobRepo: { findById: async () => null } as any,
      locationRepo: { findById: async () => null } as any,
      workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
      unavailableBlockRepo: { findByTechnicianInRange: async () => [] } as any,
      travelTimeProvider: new HaversineFallbackProvider(),
      skillMatcher: new StubSkillMatcher(),
    };
    const userRepo = { findById: async () => ({ id: 'tech-1', role: 'technician' }) } as any;
    app = express();
    app.use(express.json());
    app.use((req: any, _r, n) => { req.auth = { tenantId: 't-1', userId: 'u-1', role: 'dispatcher' }; n(); });
    app.use('/api/proposals', createProposalsRouter(proposalRepo, appointmentRepo, undefined, feasibilityDeps, userRepo));
  });

  function send(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return request(app).post('/api/proposals').set(headers).send({
      proposalType: 'reschedule_appointment',
      payload: {
        appointmentId: 'a-1',
        newScheduledStart: '2026-05-17T12:00:00Z',
        newScheduledEnd: '2026-05-17T13:00:00Z',
      },
      summary: 'reschedule via test',
      ...over,
    });
  }

  it('creates a proposal when If-Match matches updatedAt', async () => {
    const res = await send({}, { 'If-Match': appointment.updatedAt.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  it('returns 409 STALE_APPOINTMENT when If-Match does not match', async () => {
    const res = await send({}, { 'If-Match': '2020-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('STALE_APPOINTMENT');
    expect(res.body.currentVersion).toBe(appointment.updatedAt.toISOString());
    expect(res.body.providedVersion).toBe('2020-01-01T00:00:00.000Z');
  });

  it('returns 400 MISSING_VERSION when neither header nor body version is present', async () => {
    const res = await send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_VERSION');
  });

  it('returns 400 INVALID_VERSION when If-Match is not a valid ISO date', async () => {
    const res = await send({}, { 'If-Match': 'not-an-iso-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_VERSION');
  });

  it('prefers If-Match over body.appointmentVersion when both are present and differ', async () => {
    const res = await send(
      { appointmentVersion: '2020-01-01T00:00:00.000Z' },          // body says stale
      { 'If-Match': appointment.updatedAt.toISOString() },          // header says current
    );
    expect(res.status).toBe(200);
  });

  it('returns 404 before the version check when the appointment does not exist', async () => {
    const res = await request(app).post('/api/proposals')
      .set('If-Match', '2026-01-01T00:00:00.000Z')
      .send({
        proposalType: 'reschedule_appointment',
        payload: { appointmentId: 'missing', newScheduledStart: '2026-05-17T12:00:00Z', newScheduledEnd: '2026-05-17T13:00:00Z' },
        summary: 'x',
      });
    expect(res.status).toBe(404);
  });

  it('returns 422 INFEASIBLE with the full FeasibilityResult when overlap blocks', async () => {
    // Inject a conflicting sibling
    await appointmentRepo.create({
      id: 'a-conflict', tenantId: 't-1', jobId: 'j-1',
      scheduledStart: new Date('2026-05-17T12:30:00Z'),
      scheduledEnd: new Date('2026-05-17T13:30:00Z'),
      timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
      createdBy: 'u-1', createdAt: new Date(), updatedAt: new Date(),
    });
    feasibilityDeps.assignmentRepo = {
      findByTechnician: async () => [
        { id: 'as1', tenantId: 't-1', appointmentId: 'a-1', technicianId: 'tech-1', isPrimary: true, assignedBy: 'u-1', assignedAt: new Date() },
        { id: 'as2', tenantId: 't-1', appointmentId: 'a-conflict', technicianId: 'tech-1', isPrimary: true, assignedBy: 'u-1', assignedAt: new Date() },
      ],
    } as any;
    const res = await send(
      { payload: { appointmentId: 'a-1', toTechnicianId: 'tech-1', newScheduledStart: '2026-05-17T12:00:00Z', newScheduledEnd: '2026-05-17T13:00:00Z' } },
      { 'If-Match': appointment.updatedAt.toISOString() },
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INFEASIBLE');
    expect(res.body.blocking.length).toBeGreaterThan(0);
    expect(res.body.feasible).toBe(false);
  });

  it('returns 400 for proposal types other than reschedule/reassign', async () => {
    const res = await send({ proposalType: 'create_customer', payload: {} }, { 'If-Match': appointment.updatedAt.toISOString() });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Implement `create-scheduling.ts`**

```typescript
// packages/api/src/proposals/create-scheduling.ts
import { v4 as uuidv4 } from 'uuid';
import { ProposalRepository, Proposal } from './proposal';
import { AppointmentRepository } from '../appointments/appointment';
import { FeasibilityDependencies, FeasibilityResult } from '../scheduling/feasibility-types';
import { checkFeasibility } from '../scheduling/feasibility';

export type CreateSchedulingProposalResult =
  | { kind: 'created'; proposal: Proposal }
  | { kind: 'stale'; currentVersion: string; providedVersion: string }
  | { kind: 'infeasible'; feasibility: FeasibilityResult }
  | { kind: 'missing_version' }
  | { kind: 'invalid_version' }
  | { kind: 'not_found'; entity: 'appointment' };

export interface CreateSchedulingInput {
  tenantId: string;
  actorId: string;
  proposalType: 'reschedule_appointment' | 'reassign_appointment';
  payload: {
    appointmentId: string;
    newScheduledStart?: string;
    newScheduledEnd?: string;
    toTechnicianId?: string;
    fromTechnicianId?: string;
    reason?: string;
  };
  summary?: string;
  expectedVersion: string | null;
}

function parseVersion(v: string | null): { ok: true; date: Date } | { ok: false; reason: 'missing' | 'invalid' } {
  if (!v) return { ok: false, reason: 'missing' };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { ok: false, reason: 'invalid' };
  return { ok: true, date: d };
}

export async function createSchedulingProposal(
  input: CreateSchedulingInput,
  proposalRepo: ProposalRepository,
  appointmentRepo: AppointmentRepository,
  feasibilityDeps: FeasibilityDependencies,
): Promise<CreateSchedulingProposalResult> {
  const parsed = parseVersion(input.expectedVersion);
  if (!parsed.ok) {
    return parsed.reason === 'missing'
      ? { kind: 'missing_version' }
      : { kind: 'invalid_version' };
  }

  const appointment = await appointmentRepo.findById(input.tenantId, input.payload.appointmentId);
  if (!appointment) return { kind: 'not_found', entity: 'appointment' };

  const currentIso = appointment.updatedAt.toISOString();
  if (currentIso !== parsed.date.toISOString()) {
    return { kind: 'stale', currentVersion: currentIso, providedVersion: parsed.date.toISOString() };
  }

  const proposedStart = input.payload.newScheduledStart ? new Date(input.payload.newScheduledStart) : appointment.scheduledStart;
  const proposedEnd = input.payload.newScheduledEnd ? new Date(input.payload.newScheduledEnd) : appointment.scheduledEnd;
  const proposedTechnicianId = input.payload.toTechnicianId
    ?? input.payload.fromTechnicianId
    ?? ''; // for in-lane reschedules, primary tech is unchanged — composer treats '' as a no-tech skip; callers that need overlap MUST supply a tech id.

  const feasibility = await checkFeasibility(
    {
      tenantId: input.tenantId, appointment,
      proposedTechnicianId, proposedScheduledStart: proposedStart, proposedScheduledEnd: proposedEnd,
    },
    feasibilityDeps,
  );
  if (feasibility.blocking.length > 0) return { kind: 'infeasible', feasibility };

  const now = new Date();
  const proposal: Proposal = {
    id: uuidv4(),
    tenantId: input.tenantId,
    proposalType: input.proposalType,
    payload: input.payload,
    summary: input.summary ?? null,
    status: 'pending',
    createdBy: input.actorId,
    createdAt: now,
    updatedAt: now,
  } as Proposal;
  const stored = await proposalRepo.create(proposal);
  return { kind: 'created', proposal: stored };
}
```

> Adjust the `Proposal` literal above if the existing `proposal.ts` model requires additional fields. Use `createProposal(...)` from `../proposals/proposal` if it already builds a fully-typed Proposal — the helper is preferred over hand-rolling.

- [ ] **Step 3: Extend `createProposalsRouter` to take the new deps and mount the bare POST**

In `packages/api/src/routes/proposals.ts`:

```typescript
import { FeasibilityDependencies } from '../scheduling/feasibility-types';
import { UserRepository } from '../users/user';
import { createSchedulingProposal } from '../proposals/create-scheduling';

export function createProposalsRouter(
  proposalRepo: ProposalRepository,
  appointmentRepo?: AppointmentRepository,
  auditRepo?: AuditRepository,
  feasibilityDeps?: FeasibilityDependencies,
  userRepo?: UserRepository,
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as { proposalType?: string; payload?: any; summary?: string; appointmentVersion?: string };
        if (body.proposalType !== 'reschedule_appointment' && body.proposalType !== 'reassign_appointment') {
          res.status(400).json({ error: 'UNSUPPORTED_PROPOSAL_TYPE', proposalType: body.proposalType });
          return;
        }
        if (!appointmentRepo || !feasibilityDeps) {
          res.status(500).json({ error: 'SCHEDULING_DEPS_UNCONFIGURED' });
          return;
        }
        const headerVersion = req.header('If-Match') ?? null;
        const expectedVersion = headerVersion ?? body.appointmentVersion ?? null;

        const result = await createSchedulingProposal(
          {
            tenantId: req.auth!.tenantId,
            actorId: req.auth!.userId,
            proposalType: body.proposalType,
            payload: body.payload,
            summary: body.summary,
            expectedVersion,
          },
          proposalRepo, appointmentRepo, feasibilityDeps,
        );

        switch (result.kind) {
          case 'created': res.status(200).json(result.proposal); return;
          case 'missing_version': res.status(400).json({ error: 'MISSING_VERSION' }); return;
          case 'invalid_version': res.status(400).json({ error: 'INVALID_VERSION' }); return;
          case 'not_found': res.status(404).json({ error: 'APPOINTMENT_NOT_FOUND' }); return;
          case 'stale': res.status(409).json({
            error: 'STALE_APPOINTMENT',
            currentVersion: result.currentVersion,
            providedVersion: result.providedVersion,
          }); return;
          case 'infeasible': res.status(422).json({
            error: 'INFEASIBLE',
            ...result.feasibility,
          }); return;
        }
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // existing handlers below (router.get('/'), router.get('/inbox'), router.get('/:id'), router.post('/approve-batch'), etc.) unchanged
  // ...
  return router;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/api && npx vitest run test/proposals/scheduling-create.test.ts`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proposals/create-scheduling.ts \
        packages/api/src/routes/proposals.ts \
        packages/api/test/proposals/scheduling-create.test.ts
git commit -m "feat(proposals): add POST /api/proposals with If-Match + feasibility gate (scheduling types)"
```

---

## Task 15: Wire feasibility deps in `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Construct `feasibilityDeps`**

Near where other repos are constructed (around the proposals + dispatch wiring), add:

```typescript
import { createTravelTimeProvider } from './scheduling/travel-time/factory';
import { StubSkillMatcher } from './scheduling/skill-matcher';
import { createSchedulingRouter } from './scheduling/routes';
import { FeasibilityDependencies } from './scheduling/feasibility-types';

const travelTimeProvider = createTravelTimeProvider(process.env);
const skillMatcher = new StubSkillMatcher();
const feasibilityDeps: FeasibilityDependencies = {
  assignmentRepo,
  appointmentRepo,
  jobRepo,
  locationRepo,
  workingHoursRepo,
  unavailableBlockRepo,
  travelTimeProvider,
  skillMatcher,
};
```

- [ ] **Step 2: Inject into the existing handler constructors (Task 12 + 13)**

Wherever `RescheduleHandler` / `ReassignmentHandler` are constructed (in `createExecutionHandlerRegistry(...)` or directly in `app.ts`), pass `feasibilityDeps`.

- [ ] **Step 3: Mount the new router and update the proposals router call**

```typescript
app.use('/api/dispatch', createSchedulingRouter(feasibilityDeps, userRepo));
app.use(
  '/api/proposals',
  createProposalsRouter(proposalRepo, appointmentRepo, auditRepo, feasibilityDeps, userRepo),
);
```

- [ ] **Step 4: Build verification**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Full API test run**

Run: `cd packages/api && npx vitest run`
Expected: PASS (or the only failures should be Task-16+ web-side coupling, which are addressed next).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "feat(api): wire feasibility dependencies and mount scheduling router"
```

---

## Task 16: Web — `useCreateScheduleProposal` sends `If-Match`, handles 409/422/400

**Files:**
- Modify: `packages/web/src/components/dispatch/useCreateScheduleProposal.ts`
- Modify: `packages/web/src/components/dispatch/useCreateScheduleProposal.test.ts`

- [ ] **Step 1: Update tests with new branches**

Add cases to the existing test:

```typescript
it('forwards the appointmentVersion as the If-Match header and body field', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: () => Promise.resolve({ id: 'p-1' }),
  });
  const { result } = renderHook(() => useCreateScheduleProposal());
  await act(async () => {
    await result.current.createProposal({
      appointmentId: 'a-1',
      appointmentVersion: '2026-05-16T12:00:00.000Z',
      sourceType: 'lane',
      sourceTechnicianId: 'tech-1',
      targetTechnicianId: 'tech-2',
      targetPosition: null,
    } as any);
  });
  const call = (global.fetch as any).mock.calls[0];
  expect(call[1].headers['If-Match']).toBe('2026-05-16T12:00:00.000Z');
  const body = JSON.parse(call[1].body);
  expect(body.appointmentVersion).toBe('2026-05-16T12:00:00.000Z');
});

it('returns { success:false, error:"STALE" } on 409', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false, status: 409,
    json: () => Promise.resolve({ error: 'STALE_APPOINTMENT', currentVersion: 'x', providedVersion: 'y' }),
    text: () => Promise.resolve(''),
  });
  const { result } = renderHook(() => useCreateScheduleProposal());
  let r: any;
  await act(async () => {
    r = await result.current.createProposal({
      appointmentId: 'a-1', appointmentVersion: 'old',
      sourceType: 'queue', sourceTechnicianId: null, targetTechnicianId: 'tech-1', targetPosition: null,
    } as any);
  });
  expect(r.success).toBe(false);
  expect(r.error).toBe('STALE');
});

it('returns { success:false, error:"INFEASIBLE", blocking } on 422', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false, status: 422,
    json: () => Promise.resolve({ error: 'INFEASIBLE', blocking: [{ check: 'overlap', severity: 'blocking', message: 'x' }], warnings: [], info: [] }),
    text: () => Promise.resolve(''),
  });
  const { result } = renderHook(() => useCreateScheduleProposal());
  let r: any;
  await act(async () => {
    r = await result.current.createProposal({
      appointmentId: 'a-1', appointmentVersion: 'v',
      sourceType: 'queue', sourceTechnicianId: null, targetTechnicianId: 'tech-1', targetPosition: null,
    } as any);
  });
  expect(r.success).toBe(false);
  expect(r.error).toBe('INFEASIBLE');
  expect(r.blocking).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests — verify failures**

Run: `cd packages/web && npx vitest run src/components/dispatch/useCreateScheduleProposal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update the hook**

In `packages/web/src/components/dispatch/useCreateScheduleProposal.ts`:

```typescript
import { FeasibilityIssue } from './feasibility-types'; // re-export from web side; see note below

export interface ScheduleProposalResult {
  success: boolean;
  proposalId?: string;
  error?: 'STALE' | 'INFEASIBLE' | 'MISSING_VERSION' | 'INVALID_VERSION' | 'NOT_FOUND' | 'NETWORK' | string;
  blocking?: FeasibilityIssue[];
  warnings?: FeasibilityIssue[];
}
```

(Define `feasibility-types.ts` on the web side as a structural mirror of the api types — duplicate the small set of shapes; do not import across packages.)

Extend `DragResult` (in `useDragDrop.ts`) with `appointmentVersion?: string`.

Update the fetch call:

```typescript
const response = await apiFetch('/api/proposals', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(dragResult.appointmentVersion ? { 'If-Match': dragResult.appointmentVersion } : {}),
  },
  body: JSON.stringify({
    proposalType, payload, summary,
    ...(dragResult.appointmentVersion ? { appointmentVersion: dragResult.appointmentVersion } : {}),
  }),
});

if (!response.ok) {
  if (response.status === 409) {
    setLastResult({ success: false, error: 'STALE' });
    return { success: false, error: 'STALE' };
  }
  if (response.status === 422) {
    const body = await response.json().catch(() => ({}));
    const result = { success: false, error: 'INFEASIBLE', blocking: body.blocking ?? [], warnings: body.warnings ?? [] };
    setLastResult(result);
    return result;
  }
  // existing fall-through
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/web && npx vitest run src/components/dispatch/useCreateScheduleProposal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/dispatch/useCreateScheduleProposal.ts \
        packages/web/src/components/dispatch/useCreateScheduleProposal.test.ts \
        packages/web/src/components/dispatch/useDragDrop.ts \
        packages/web/src/components/dispatch/feasibility-types.ts
git commit -m "feat(web/dispatch): send If-Match and classify 409/422 responses in schedule proposal hook"
```

---

## Task 17: Web — `useFeasibilityPreview` hook (debounced 150 ms)

**Files:**
- Create: `packages/web/src/components/dispatch/useFeasibilityPreview.ts`
- Create: `packages/web/src/components/dispatch/useFeasibilityPreview.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/web/src/components/dispatch/useFeasibilityPreview.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFeasibilityPreview } from './useFeasibilityPreview';

describe('useFeasibilityPreview', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.useFakeTimers(); });

  it('does not fire fetch until the debounce window elapses', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ feasible: true, blocking: [], warnings: [], info: [], travelTime: null }),
    });
    global.fetch = fetchSpy as any;
    const { result, rerender } = renderHook(({ input }) => useFeasibilityPreview(input), {
      initialProps: { input: { appointmentId: 'a-1', proposedTechnicianId: 'tech-1', proposedScheduledStart: '2026-05-17T10:00:00Z', proposedScheduledEnd: '2026-05-17T11:00:00Z' } },
    });
    // Fire rapid updates within the debounce window
    rerender({ input: { appointmentId: 'a-1', proposedTechnicianId: 'tech-1', proposedScheduledStart: '2026-05-17T10:01:00Z', proposedScheduledEnd: '2026-05-17T11:01:00Z' } });
    rerender({ input: { appointmentId: 'a-1', proposedTechnicianId: 'tech-1', proposedScheduledStart: '2026-05-17T10:02:00Z', proposedScheduledEnd: '2026-05-17T11:02:00Z' } });
    act(() => { vi.advanceTimersByTime(149); });
    expect(fetchSpy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });

  it('exposes the latest feasibility result', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ feasible: false, blocking: [{ check: 'overlap', severity: 'blocking', message: 'x' }], warnings: [], info: [], travelTime: null }),
    }) as any;
    const { result } = renderHook(() => useFeasibilityPreview({
      appointmentId: 'a-1', proposedTechnicianId: 'tech-1',
      proposedScheduledStart: '2026-05-17T10:00:00Z', proposedScheduledEnd: '2026-05-17T11:00:00Z',
    }));
    act(() => { vi.advanceTimersByTime(200); });
    await waitFor(() => expect(result.current.preview?.feasible).toBe(false));
  });

  it('returns null preview while input is null (idle)', () => {
    const { result } = renderHook(() => useFeasibilityPreview(null));
    expect(result.current.preview).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `cd packages/web && npx vitest run src/components/dispatch/useFeasibilityPreview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// packages/web/src/components/dispatch/useFeasibilityPreview.ts
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { FeasibilityResult } from './feasibility-types';

export interface FeasibilityPreviewInput {
  appointmentId: string;
  proposedTechnicianId: string;
  proposedScheduledStart: string;
  proposedScheduledEnd: string;
}

const DEBOUNCE_MS = 150;

export function useFeasibilityPreview(input: FeasibilityPreviewInput | null): {
  preview: FeasibilityResult | null;
  isLoading: boolean;
} {
  const [preview, setPreview] = useState<FeasibilityResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!input) { setPreview(null); return; }
    timerRef.current = setTimeout(async () => {
      const myReqId = ++reqIdRef.current;
      setIsLoading(true);
      try {
        const res = await apiFetch('/api/dispatch/check-feasibility', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (myReqId !== reqIdRef.current) return; // stale response
        if (!res.ok) { setPreview(null); return; }
        setPreview(await res.json());
      } finally {
        if (myReqId === reqIdRef.current) setIsLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [input?.appointmentId, input?.proposedTechnicianId, input?.proposedScheduledStart, input?.proposedScheduledEnd]);

  return { preview, isLoading };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd packages/web && npx vitest run src/components/dispatch/useFeasibilityPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/dispatch/useFeasibilityPreview.ts \
        packages/web/src/components/dispatch/useFeasibilityPreview.test.ts
git commit -m "feat(web/dispatch): add useFeasibilityPreview hook (150ms debounced)"
```

---

## Task 18: Web — `DispatchBoard.tsx` routes through the hook + wires the preview

**Files:**
- Modify: `packages/web/src/pages/dispatch/DispatchBoard.tsx`

- [ ] **Step 1: Replace the inline `apiFetch('/api/proposals', ...)` with `useCreateScheduleProposal`**

Around line 318, replace the inline fetch with:

```typescript
const { createProposal } = useCreateScheduleProposal();

// inside the drop handler:
const proposalResult = await createProposal({
  appointmentId: source.appointmentId,
  appointmentVersion: appointment?.updatedAt,
  sourceType: source.sourceType,
  sourceTechnicianId: source.sourceTechnicianId,
  targetTechnicianId: target.targetTechnicianId,
  targetPosition: target.targetPosition,
  proposedScheduledStart: proposedStart,
  proposedScheduledEnd: proposedEnd,
} as any);

if (!proposalResult.success) {
  if (proposalResult.error === 'STALE') {
    toast.warning('Someone else updated this appointment — refresh and try again.');
  } else if (proposalResult.error === 'INFEASIBLE') {
    toast.error(`Cannot schedule: ${proposalResult.blocking?.[0]?.message ?? 'feasibility check failed'}`);
  } else {
    toast.error(proposalResult.error ?? 'Could not create proposal');
  }
  return;
}
```

- [ ] **Step 2: Wire `useFeasibilityPreview`**

Add state for the in-flight drag preview and pipe its result into the drop-zone highlighting (consumed by `TechnicianLane` in the next task):

```typescript
const [previewInput, setPreviewInput] = useState<FeasibilityPreviewInput | null>(null);
const { preview } = useFeasibilityPreview(previewInput);

// in the drag-over handler:
setPreviewInput({
  appointmentId: source.appointmentId,
  proposedTechnicianId: target.technicianId,
  proposedScheduledStart: target.scheduledStart,
  proposedScheduledEnd: target.scheduledEnd,
});

// when drag ends or cancels:
setPreviewInput(null);
```

Pass `preview` down to each `TechnicianLane` (only the lane currently under the drag actually renders feedback).

- [ ] **Step 3: Update or add a focused test**

Use the existing `DispatchBoard.test.tsx` pattern (mock fetch + `useDragDrop`) to assert:
- `If-Match` is forwarded on the proposal request.
- A 409 surfaces the "Someone else updated this appointment" toast.
- A 422 surfaces the blocking message.

- [ ] **Step 4: Run tests**

Run: `cd packages/web && npx vitest run src/pages/dispatch/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/dispatch/DispatchBoard.tsx \
        packages/web/src/pages/dispatch/DispatchBoard.test.tsx
git commit -m "feat(web/dispatch): route board proposals through hook and wire feasibility preview"
```

---

## Task 19: Web — `TechnicianLane.tsx` colors drop zones from the preview result

**Files:**
- Modify: `packages/web/src/components/dispatch/TechnicianLane.tsx`
- Modify: `packages/web/src/components/dispatch/TechnicianLane.test.tsx`

- [ ] **Step 1: Add a failing test for the drop-zone state**

```typescript
it('renders drop zone in danger state when preview.feasible is false', () => {
  render(<TechnicianLane
    {...baseProps}
    dragPreview={{ targetTechnicianId: baseProps.technicianId, preview: {
      feasible: false, blocking: [{ check: 'overlap', severity: 'blocking', message: 'x' }],
      warnings: [], info: [], travelTime: null,
    }}}
  />);
  expect(screen.getByTestId('drop-zone')).toHaveClass('drop-zone--blocking');
});

it('renders drop zone in caution state when preview has warnings only', () => {
  render(<TechnicianLane
    {...baseProps}
    dragPreview={{ targetTechnicianId: baseProps.technicianId, preview: {
      feasible: true, blocking: [], warnings: [{ check: 'travel_time', severity: 'warning', message: 'tight' }],
      info: [], travelTime: null,
    }}}
  />);
  expect(screen.getByTestId('drop-zone')).toHaveClass('drop-zone--warning');
});
```

- [ ] **Step 2: Implement**

Add a `dragPreview?: { targetTechnicianId: string; preview: FeasibilityResult | null }` prop. Compute drop-zone class:

```typescript
const dropZoneState =
  dragPreview && dragPreview.targetTechnicianId === technicianId && dragPreview.preview
    ? (dragPreview.preview.feasible
        ? (dragPreview.preview.warnings.length > 0 ? 'drop-zone--warning' : 'drop-zone--ok')
        : 'drop-zone--blocking')
    : 'drop-zone--idle';
```

Apply to the drop-zone element with `data-testid="drop-zone"`. Use existing Tailwind colors for `--blocking` (red), `--warning` (amber), `--ok` (green), `--idle` (default).

- [ ] **Step 3: Run tests**

Run: `cd packages/web && npx vitest run src/components/dispatch/TechnicianLane.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/dispatch/TechnicianLane.tsx \
        packages/web/src/components/dispatch/TechnicianLane.test.tsx
git commit -m "feat(web/dispatch): color technician-lane drop zones from feasibility preview"
```

---

## Task 20: Final build verification and docs

**Files:** N/A (verification step)

- [ ] **Step 1: API build verification (per CLAUDE.md, mandatory before complete)**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS.

- [ ] **Step 2: Web build / typecheck**

Run: `cd packages/web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Full test suite (api + web)**

Run: `cd packages/api && npx vitest run`
Expected: PASS.

Run: `cd packages/web && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Manual smoke (only if the dev stack is already running)**

Drag an appointment across the board in the running web app:
- Drop zone briefly shows green/amber/red based on preview.
- Drop on a clearly overlapping slot → toast says "Cannot schedule: Overlaps with appointment …".
- Open the board in two tabs, accept a proposal in tab A, attempt the same in tab B → tab B sees "Someone else updated this appointment".

- [ ] **Step 5: Commit any doc updates (if needed)**

If `docs/PRD.md` or a deployment doc needs the new env vars (`GOOGLE_MAPS_API_KEY`, `TRAVEL_TIME_CACHE_TTL_SECONDS`, `TRAVEL_TIME_CACHE_MAX_ENTRIES`), add a one-line entry where the existing env section lives. Otherwise skip.

```bash
git add docs/<file-touched>
git commit -m "docs: note travel-time env vars for dispatch feasibility"
```

---

## Self-review

**Spec coverage (each spec section → tasks that implement it):**

| Spec section | Tasks |
|---|---|
| 3. Architecture — composer + sub-checks | 1, 6, 7, 8, 9 |
| 3. Module layout — `scheduling/` tree | 1–5, 11 |
| 4. New `POST /api/dispatch/check-feasibility` | 11 |
| 4. Extended `POST /api/proposals` + If-Match + 409/422/400 | 14 |
| 4. Board response gains `updatedAt` | 10 |
| 5. `feasibility.ts` composer | 6, 7, 8, 9 (incremental) |
| 5. TravelTimeProvider — Google + haversine + factory | 2, 3, 4 |
| 5. SkillMatcher + Stub | 5 |
| 5. Optimistic concurrency wiring | 14 |
| 5. Refactor execution handlers | 12, 13 |
| 5. Web wiring (`useCreateScheduleProposal`, `useFeasibilityPreview`, `DispatchBoard`, `TechnicianLane`) | 16, 17, 18, 19 |
| 5. `app.ts` wiring | 15 |
| 6. Configuration env vars | 3 (read), 15 (wired), 20 (documented) |
| 7. Tests — unit + integration | All TDD tasks |
| 8. Risks — version-precision, malformed If-Match, missing coords | 14 (precision + 400 INVALID_VERSION), 8 (missing coords as info) |

**Reviewer-fix coverage:**

| Reviewer flag | Folded into |
|---|---|
| `'info'` severity | Task 1 type + Task 8 missing-coords test |
| `info[]` transport on result | Task 1 type + Task 11 route response shape |
| Technician existence check (404) | Task 11 route handler (uses `userRepo.findById`) |
| Drop 50-cap on overlap (correctness) | Task 6 (test asserts ≥100 siblings still finds conflict) |
| Cross-midnight window for overlap | Task 6 (dedicated test) |
| `departAt`-bucketed cache key | Task 3 (dedicated tests for same-bucket hit + cross-bucket miss) |

**Placeholder scan:** none — every code step contains a complete snippet, every `Run:` includes the exact command, every test has a concrete assertion.

**Type consistency:** `FeasibilityResult.feasible/blocking/warnings/info/travelTime`, `FeasibilityIssue.check/severity/message/conflictingEntityId/metadata`, `TravelTimeSummary.{fromPrevSeconds,toNextSeconds,estimateSource,degraded}`, `TravelTimeEstimate.{seconds,source,degraded}`, `CreateSchedulingProposalResult.kind` discriminators — all consistent across tasks.
