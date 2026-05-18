# Technician Mobile App Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile-optimized experience for field technicians covering schedule visibility, job status updates, photo capture, and time logging. The app must remain usable under intermittent connectivity by buffering writes in an offline mutation queue and replaying them when the network returns. Phase 1 locks five architectural decisions before any code is written, ensuring the chosen stack is justified against real trade-offs rather than default assumptions.

**Architecture:** A PWA served from `packages/web` (new `/mobile` route group) backed by a dedicated `/api/mobile/*` namespace in `packages/api`. All mobile write endpoints accept an `Idempotency-Key` header; the server stores processed keys in a `mobile_idempotency_keys` table and returns the cached result on replay rather than a 409. A client-side sync worker (IndexedDB via Dexie + a `useSyncQueue` hook) processes the mutation queue on the `online` event and on a 30-second timer. Push notifications route through Firebase Cloud Messaging (FCM) for both Android and browser, with APNs bridged through FCM on iOS, using a `push_tokens` table registered via `POST /api/mobile/push-tokens`.

**Tech Stack:** TypeScript throughout; Express + pg on the API; React 18 + Tailwind + Workbox (PWA service worker) on the client; Dexie 3 for IndexedDB; Vitest for all unit & integration tests; Zod for API request validation.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `docs/mobile-app-assessment.md` | Phase 1 decision record — framework, offline storage, mutation queue, API namespace, push provider |
| `packages/api/src/mobile/schedule.ts` | Domain logic: fetch today's appointments for a technician, InMemory + Pg repos |
| `packages/api/src/mobile/status-events.ts` | Domain logic: appointment status event entity, validation, InMemory repo |
| `packages/api/src/mobile/push-tokens.ts` | Domain logic: push token entity, InMemory + Pg repos |
| `packages/api/src/mobile/idempotency.ts` | Server-side idempotency key store (InMemory + Pg), middleware helper |
| `packages/api/src/mobile/push-notification-service.ts` | `PushNotificationService` interface + NoopImpl; FCM impl in Phase 4 |
| `packages/api/src/routes/mobile.ts` | Express router for all `/api/mobile/*` endpoints |
| `packages/api/test/mobile/schedule.test.ts` | TDD tests for `GET /api/mobile/schedule` |
| `packages/api/test/mobile/status-events.test.ts` | TDD tests for `POST /api/mobile/appointments/:id/status` |
| `packages/api/test/mobile/push-tokens.test.ts` | TDD tests for `POST /api/mobile/push-tokens` |
| `packages/api/test/mobile/idempotency.test.ts` | TDD tests for idempotency key deduplication |
| `packages/api/test/mobile/push-notification.test.ts` | TDD tests for `PushNotificationService` triggers |
| `packages/web/src/pages/mobile/MobileSchedulePage.tsx` | Schedule list view — today's appointments with status chips |
| `packages/web/src/pages/mobile/MobileJobDetailPage.tsx` | Job detail — customer, address, notes, photos |
| `packages/web/src/pages/mobile/MobileStatusButtons.tsx` | Prominent en-route / arrived / complete action buttons |
| `packages/web/src/hooks/useSyncQueue.ts` | Dexie-backed mutation queue; processes on `online` + 30s timer |
| `packages/web/src/lib/mobileApi.ts` | Typed fetch wrappers for all `/api/mobile/*` endpoints |
| `packages/web/src/sw/mobile-sw.ts` | Workbox service worker: cache-first for assets, network-first for API |

### Modified files

**Phase 2** — `packages/api/src/app.ts`: mount `createMobileRouter()` at `/api/mobile`. `packages/api/src/db/schema.ts`: add migrations `041_create_push_tokens`, `042_create_appointment_status_events`, `043_create_mobile_idempotency_keys`.

**Phase 3** — `packages/api/src/routes/mobile.ts`: add `Idempotency-Key` middleware to all write routes. `packages/web/src/hooks/useSyncQueue.ts`: client-side queue integration.

**Phase 4** — `packages/api/src/appointments/appointment.ts`: emit push after assignment. `packages/api/src/app.ts`: wire `PushNotificationService` into appointment assignment handler.

**Phase 5** — `packages/web/src/App.tsx` (or router root): add `/mobile/*` React Router routes. `packages/web/vite.config.ts`: register Workbox plugin.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Discovery — Architectural Decisions

All five decisions below must be documented in `docs/mobile-app-assessment.md` and merged before any Phase 2 code lands. Tasks in this phase produce documents, not code. Each task ends with the decision recorded and rationale written.

### Task 1: Framework Decision

**Files:**
- Create: `docs/mobile-app-assessment.md` (initial skeleton with all 5 decision headings)

**Context:** Evaluate PWA (React + Workbox) vs React Native vs Expo against five axes: offline support quality, camera & GPS access, push notification path, app store distribution requirement, and code sharing with `packages/web`. The codebase already has `packages/web` with React 18 + Tailwind and an existing `MobileTechView.tsx` component — PWA re-uses that investment directly. React Native / Expo require a new `packages/native` package, separate build tooling, and a separate Clerk native SDK integration. App store distribution is explicitly out of scope (see Out of Scope). Push notifications via FCM work in PWA on Android and desktop Chrome; iOS PWA push requires iOS 16.4+ but is now supported without a native shell.

- [ ] **Step 1: Draft framework comparison table**

Populate the `## 1. Framework` section of `docs/mobile-app-assessment.md`:

```markdown
## 1. Framework Decision

| Criterion | PWA (React + Workbox) | React Native | Expo |
|-----------|----------------------|--------------|------|
| Offline support | Service worker + Workbox (cache-first) | AsyncStorage / SQLite | Expo SQLite |
| Camera access | `getUserMedia` / `<input capture>` | `react-native-camera` | `expo-camera` |
| Push notifications | FCM Web Push (VAPID) | FCM + APNs via notifee | FCM + APNs via expo-notifications |
| App store distribution | No (PWA install prompt only) | Yes | Yes |
| Shared code with packages/web | Full — same React components | Minimal | Minimal |
| Clerk auth | @clerk/react (already installed) | @clerk/clerk-expo | @clerk/clerk-expo |

**Decision: PWA (React + Workbox)**
Rationale: app store distribution is out of scope; full code sharing with packages/web reduces maintenance surface; Clerk integration is already present; Workbox provides battle-tested offline caching with cache-first strategies for static assets and network-first for API calls.
```

- [ ] **Step 2: Commit skeleton**

```bash
git add docs/mobile-app-assessment.md
git commit -m "docs(mobile): add assessment skeleton with framework decision — PWA chosen

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

### Task 2: Offline Storage & Mutation Queue Design

**Files:**
- Modify: `docs/mobile-app-assessment.md`

**Context:** Two candidates for offline storage: Dexie 3 (IndexedDB wrapper, works in all browsers, same-process as React) vs SQLite via Capacitor or Expo (native binary, stronger consistency guarantees, requires native shell). Since PWA was chosen, SQLite via Capacitor is possible but adds a Capacitor build layer. Dexie is simpler, well-typed, and sufficient for a mutation queue holding < 1000 pending operations. For idempotency key strategy: each mutation gets a client-generated UUID (`crypto.randomUUID()`), sent as `Idempotency-Key` header. The schema is `{ id: string, endpoint: string, method: string, payload: unknown, idempotencyKey: string, retryCount: number, status: 'pending' | 'inflight' | 'done' | 'failed', createdAt: number }`. The sync worker fires on `window.addEventListener('online', ...)` and every 30 seconds via `setInterval`. Inflight entries are locked for 60 seconds before re-attempt (prevents double-submit on slow connections).

- [ ] **Step 1: Document storage decision**

Add to `docs/mobile-app-assessment.md`:

```markdown
## 2. Offline Storage Decision

**Decision: Dexie 3 (IndexedDB)**
Rationale: PWA-native, no build-time native tooling required, 12 kB gzipped, full TypeScript generics, supports transactions for atomic queue operations.

## 3. Mutation Queue Design

Queue schema (IndexedDB store `mutationQueue`):
- `id` — auto-increment primary key
- `idempotencyKey` — `crypto.randomUUID()` generated at enqueue time, never changes on retry
- `endpoint` — e.g. `/api/mobile/appointments/abc/status`
- `method` — `POST` | `PATCH`
- `payload` — JSON-serialisable object
- `retryCount` — incremented on each failed attempt
- `status` — `pending` | `inflight` | `done` | `failed`
- `lockedUntil` — epoch ms; prevents double-submit while inflight
- `createdAt` — epoch ms

Sync trigger: `online` event + `setInterval(sync, 30_000)`.
Retry cap: 5 attempts; after 5 the entry moves to `failed` and surfaces in UI.
Server behaviour on duplicate key: returns `200` with cached response body — never `409`.
```

- [ ] **Step 2: Document API namespace & push provider decisions**

```markdown
## 4. API Namespace Decision

**Decision: Separate `/api/mobile/*` namespace**
Rationale: Mobile endpoints return slimmer response shapes (no nested relations that web uses), carry different rate limits (lower burst, higher sustained from background sync), and mobile auth will add device-context headers. Isolation prevents mobile-specific changes from breaking web callers and allows independent versioning.

## 5. Push Notification Provider Decision

**Decision: Firebase Cloud Messaging (FCM)**
Rationale: FCM bridges Android, Chrome PWA (VAPID), and iOS PWA (via APNs bridging) from a single provider. No separate APNs credential management is needed for Phase 4. The `push_tokens` table stores `platform` as an enum (`ios` | `android` | `web`) — FCM handles platform routing transparently. Direct APNs adds operational overhead with certificates that rotate annually.
```

- [ ] **Step 3: Commit decisions**

```bash
git add docs/mobile-app-assessment.md
git commit -m "docs(mobile): lock all 5 architectural decisions — Dexie, FCM, /api/mobile namespace

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

## Phase 2: API Foundation — `/api/mobile/*` Routes

Three new database tables and three route groups. Every task follows: InMemory repo first, failing test, implementation, Pg repo, commit.

### Task 3: Schema Migrations (push_tokens, appointment_status_events, mobile_idempotency_keys)

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Three tables added in sequence. `push_tokens` links a device to a technician and stores the FCM token. `appointment_status_events` is an append-only audit trail for every mobile status transition (separate from the main `appointments.status` field, which is updated in place). `mobile_idempotency_keys` stores processed request fingerprints for 24 hours.

- [ ] **Step 1: Write the failing migration test**

```typescript
// packages/api/test/db/schema.test.ts — add inside existing describe block
it('migration 041 creates push_tokens table', () => {
  const sql = getMigrationSQL();
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS push_tokens');
  expect(sql).toContain('platform TEXT NOT NULL CHECK (platform IN');
});

it('migration 042 creates appointment_status_events table', () => {
  const sql = getMigrationSQL();
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS appointment_status_events');
  expect(sql).toContain('mobile_status TEXT NOT NULL CHECK');
});

it('migration 043 creates mobile_idempotency_keys table', () => {
  const sql = getMigrationSQL();
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS mobile_idempotency_keys');
  expect(sql).toContain('expires_at TIMESTAMPTZ');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/db/schema.test.ts -t "migration 041"`
Expected: FAIL — `push_tokens` table does not exist in migration SQL yet.

- [ ] **Step 3: Add migrations to schema.ts**

Append to the `MIGRATIONS` object in `/home/user/Serviceos/packages/api/src/db/schema.ts` after `'040_create_technician_location_pings'`:

```typescript
'041_create_push_tokens': `
  CREATE TABLE IF NOT EXISTS push_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    technician_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    push_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_push_tokens_technician
    ON push_tokens(tenant_id, technician_id);
  ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
  ALTER TABLE push_tokens FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_push_tokens ON push_tokens;
  CREATE POLICY tenant_isolation_push_tokens ON push_tokens
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,

'042_create_appointment_status_events': `
  CREATE TABLE IF NOT EXISTS appointment_status_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    appointment_id UUID NOT NULL REFERENCES appointments(id),
    technician_id TEXT NOT NULL,
    mobile_status TEXT NOT NULL CHECK (mobile_status IN ('en_route', 'arrived', 'in_progress', 'completed')),
    previous_mobile_status TEXT CHECK (previous_mobile_status IN ('en_route', 'arrived', 'in_progress', 'completed')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    device_id TEXT,
    source TEXT NOT NULL DEFAULT 'mobile'
  );
  CREATE INDEX IF NOT EXISTS idx_ase_appointment
    ON appointment_status_events(tenant_id, appointment_id, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ase_technician
    ON appointment_status_events(tenant_id, technician_id, recorded_at DESC);
  ALTER TABLE appointment_status_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE appointment_status_events FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_appointment_status_events ON appointment_status_events;
  CREATE POLICY tenant_isolation_appointment_status_events ON appointment_status_events
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,

'043_create_mobile_idempotency_keys': `
  CREATE TABLE IF NOT EXISTS mobile_idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    idempotency_key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    UNIQUE (tenant_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_mik_key
    ON mobile_idempotency_keys(tenant_id, idempotency_key)
    WHERE expires_at > NOW();
  ALTER TABLE mobile_idempotency_keys ENABLE ROW LEVEL SECURITY;
  ALTER TABLE mobile_idempotency_keys FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation_mobile_idempotency_keys ON mobile_idempotency_keys;
  CREATE POLICY tenant_isolation_mobile_idempotency_keys ON mobile_idempotency_keys
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/db/schema.test.ts`
Expected: PASS — all three migration assertions found in SQL.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts
git commit -m "feat(mobile): add migrations 041-043 for push_tokens, appointment_status_events, mobile_idempotency_keys

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

### Task 4: GET /api/mobile/schedule — Technician Day View

**Files:**
- Create: `packages/api/src/mobile/schedule.ts`
- Create: `packages/api/src/routes/mobile.ts`
- Create: `packages/api/test/mobile/schedule.test.ts`
- Modify: `packages/api/src/app.ts`

**Context:** Returns today's appointments for the authenticated technician by joining `appointments` with `appointment_assignments` on `technician_id = req.auth.userId`. The response shape is slimmer than the web shape: `{ id, jobId, scheduledStart, scheduledEnd, status, mobileStatus, customerName, address, notes }`. `mobileStatus` is the latest entry from `appointment_status_events` (null if no mobile update yet). The InMemory implementation filters by `technicianId` and date range.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/mobile/schedule.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMobileScheduleRepository, getMobileSchedule } from '../../src/mobile/schedule';

describe('mobile schedule', () => {
  let repo: InMemoryMobileScheduleRepository;

  beforeEach(() => {
    repo = new InMemoryMobileScheduleRepository();
  });

  it('returns only appointments assigned to the requesting technician today', async () => {
    const today = new Date();
    today.setHours(9, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    await repo.seed({
      id: 'appt-1',
      tenantId: 'tenant-a',
      technicianId: 'tech-1',
      jobId: 'job-1',
      scheduledStart: today,
      scheduledEnd: new Date(today.getTime() + 3600_000),
      status: 'confirmed',
      mobileStatus: null,
      customerName: 'Alice',
      address: '123 Main St',
      notes: null,
    });

    const results = await getMobileSchedule('tenant-a', 'tech-1', new Date(), repo);
    expect(results).toHaveLength(1);
    expect(results[0].customerName).toBe('Alice');
  });

  it('excludes appointments for a different technician', async () => {
    const today = new Date();
    today.setHours(10, 0, 0, 0);
    await repo.seed({ id: 'appt-2', tenantId: 'tenant-a', technicianId: 'tech-2',
      jobId: 'job-2', scheduledStart: today, scheduledEnd: new Date(today.getTime() + 3600_000),
      status: 'confirmed', mobileStatus: null, customerName: 'Bob', address: '456 Oak Ave', notes: null });
    const results = await getMobileSchedule('tenant-a', 'tech-1', new Date(), repo);
    expect(results).toHaveLength(0);
  });

  it('excludes cancelled appointments', async () => {
    const today = new Date();
    today.setHours(11, 0, 0, 0);
    await repo.seed({ id: 'appt-3', tenantId: 'tenant-a', technicianId: 'tech-1',
      jobId: 'job-3', scheduledStart: today, scheduledEnd: new Date(today.getTime() + 3600_000),
      status: 'canceled', mobileStatus: null, customerName: 'Carol', address: '789 Pine Rd', notes: null });
    const results = await getMobileSchedule('tenant-a', 'tech-1', new Date(), repo);
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/mobile/schedule.test.ts`
Expected: FAIL — module `../../src/mobile/schedule` does not exist.

- [ ] **Step 3: Implement schedule domain + InMemory repo**

Create `packages/api/src/mobile/schedule.ts` with `MobileScheduleEntry` interface, `MobileScheduleRepository` interface, `InMemoryMobileScheduleRepository` (with a `.seed()` helper for tests), and `getMobileSchedule(tenantId, technicianId, date, repo)` that filters to same-calendar-day non-cancelled entries for the technician.

- [ ] **Step 4: Create mobile router skeleton and mount it**

Create `packages/api/src/routes/mobile.ts` with `createMobileRouter(deps)` function. Wire `GET /schedule` to call `getMobileSchedule`. In `packages/api/src/app.ts`, import and mount: `app.use('/api/mobile', createMobileRouter({ scheduleRepo, ... }))`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/mobile/schedule.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/mobile/schedule.ts packages/api/src/routes/mobile.ts \
        packages/api/src/app.ts packages/api/test/mobile/schedule.test.ts
git commit -m "feat(mobile): GET /api/mobile/schedule returns technician day view

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

### Task 5: POST /api/mobile/appointments/:id/status and POST /api/mobile/push-tokens

**Files:**
- Create: `packages/api/src/mobile/status-events.ts`
- Create: `packages/api/src/mobile/push-tokens.ts`
- Create: `packages/api/test/mobile/status-events.test.ts`
- Create: `packages/api/test/mobile/push-tokens.test.ts`
- Modify: `packages/api/src/routes/mobile.ts`

**Context:** Status events are append-only. Valid transitions are `null -> en_route -> arrived -> in_progress -> completed` in that direction only — backwards transitions are rejected. The Zod schema for the status body is `{ status: z.enum(['en_route','arrived','in_progress','completed']), deviceId: z.string().optional() }`. Push token upsert uses `UNIQUE (tenant_id, device_id)` to update `push_token` and `last_seen_at` on conflict; INSERT + ON CONFLICT DO UPDATE in Pg, map-overwrite in InMemory.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/api/test/mobile/status-events.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStatusEventRepository, recordStatusEvent, VALID_STATUS_TRANSITIONS } from '../../src/mobile/status-events';

describe('appointment status events', () => {
  let repo: InMemoryStatusEventRepository;
  beforeEach(() => { repo = new InMemoryStatusEventRepository(); });

  it('records a valid first status transition (en_route)', async () => {
    const event = await recordStatusEvent(
      { tenantId: 't1', appointmentId: 'a1', technicianId: 'tech-1', newStatus: 'en_route', deviceId: 'dev-1' },
      repo
    );
    expect(event.mobileStatus).toBe('en_route');
  });

  it('rejects a backwards status transition', async () => {
    await recordStatusEvent(
      { tenantId: 't1', appointmentId: 'a1', technicianId: 'tech-1', newStatus: 'completed', deviceId: 'dev-1' },
      repo
    );
    await expect(recordStatusEvent(
      { tenantId: 't1', appointmentId: 'a1', technicianId: 'tech-1', newStatus: 'en_route', deviceId: 'dev-1' },
      repo
    )).rejects.toThrow('Invalid status transition');
  });
});
```

```typescript
// packages/api/test/mobile/push-tokens.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPushTokenRepository, upsertPushToken } from '../../src/mobile/push-tokens';

describe('push token upsert', () => {
  let repo: InMemoryPushTokenRepository;
  beforeEach(() => { repo = new InMemoryPushTokenRepository(); });

  it('stores a new push token', async () => {
    const token = await upsertPushToken(
      { tenantId: 't1', technicianId: 'tech-1', deviceId: 'dev-1', platform: 'android', pushToken: 'fcm-abc' },
      repo
    );
    expect(token.pushToken).toBe('fcm-abc');
  });

  it('updates push token for same device_id', async () => {
    await upsertPushToken({ tenantId: 't1', technicianId: 'tech-1', deviceId: 'dev-1', platform: 'android', pushToken: 'fcm-old' }, repo);
    const updated = await upsertPushToken({ tenantId: 't1', technicianId: 'tech-1', deviceId: 'dev-1', platform: 'android', pushToken: 'fcm-new' }, repo);
    expect(updated.pushToken).toBe('fcm-new');
    const all = await repo.findByTechnician('t1', 'tech-1');
    expect(all).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run test/mobile/status-events.test.ts test/mobile/push-tokens.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement status-events domain**

Create `packages/api/src/mobile/status-events.ts`. Define `MobileStatus = 'en_route' | 'arrived' | 'in_progress' | 'completed'`, a `STATUS_ORDER` map `{ en_route: 0, arrived: 1, in_progress: 2, completed: 3 }`, `StatusEventRepository` interface with `getLatest(tenantId, appointmentId)` and `insert(event)`, `InMemoryStatusEventRepository`, and `recordStatusEvent` that fetches the latest, validates the order constraint, then inserts.

- [ ] **Step 4: Implement push-tokens domain**

Create `packages/api/src/mobile/push-tokens.ts`. Define `PushToken` entity, `PushTokenRepository` with `upsert(token)` and `findByTechnician(tenantId, technicianId)`, `InMemoryPushTokenRepository` (keyed by `device_id` within tenant), and `upsertPushToken` function.

- [ ] **Step 5: Wire routes**

Add to `packages/api/src/routes/mobile.ts`: `POST /:id/status` calling `recordStatusEvent`, `POST /push-tokens` calling `upsertPushToken`.

- [ ] **Step 6: Run tests**

Run: `cd packages/api && npx vitest run test/mobile/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/mobile/status-events.ts packages/api/src/mobile/push-tokens.ts \
        packages/api/test/mobile/status-events.test.ts packages/api/test/mobile/push-tokens.test.ts \
        packages/api/src/routes/mobile.ts
git commit -m "feat(mobile): POST appointment status events and push token upsert endpoints

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

## Phase 3: Offline Mutation Queue — Idempotency End-to-End

### Task 6: Server-Side Idempotency Middleware

**Files:**
- Create: `packages/api/src/mobile/idempotency.ts`
- Create: `packages/api/test/mobile/idempotency.test.ts`
- Modify: `packages/api/src/routes/mobile.ts`

**Context:** The middleware reads the `Idempotency-Key` header. If the key is found in `mobile_idempotency_keys` for this tenant and is not expired, it replays the stored `response_status` and `response_body` immediately without calling `next()`. If the key is absent, the middleware calls `next()` and after the handler responds, stores the response. The InMemory version uses a `Map<string, StoredResponse>` keyed by `${tenantId}:${key}`. Writes require the header; reads (`GET`) skip idempotency entirely.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/mobile/idempotency.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryIdempotencyStore, checkAndStore } from '../../src/mobile/idempotency';

describe('server-side idempotency', () => {
  let store: InMemoryIdempotencyStore;
  beforeEach(() => { store = new InMemoryIdempotencyStore(); });

  it('returns null on first request (key not seen)', async () => {
    const cached = await store.get('tenant-1', 'key-abc');
    expect(cached).toBeNull();
  });

  it('returns cached response on second request with same key', async () => {
    await store.set('tenant-1', 'key-abc', '/api/mobile/appointments/x/status', 200, { ok: true });
    const cached = await store.get('tenant-1', 'key-abc');
    expect(cached?.responseBody).toEqual({ ok: true });
    expect(cached?.responseStatus).toBe(200);
  });

  it('does not return cached response for a different tenant', async () => {
    await store.set('tenant-1', 'key-abc', '/api/mobile/appointments/x/status', 200, { ok: true });
    const cached = await store.get('tenant-2', 'key-abc');
    expect(cached).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/mobile/idempotency.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement idempotency store and Express middleware**

Create `packages/api/src/mobile/idempotency.ts`:

```typescript
export interface StoredResponse {
  endpoint: string;
  responseStatus: number;
  responseBody: unknown;
  expiresAt: Date;
}

export interface IdempotencyStore {
  get(tenantId: string, key: string): Promise<StoredResponse | null>;
  set(tenantId: string, key: string, endpoint: string, status: number, body: unknown): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, StoredResponse>();
  async get(tenantId: string, key: string): Promise<StoredResponse | null> {
    const entry = this.store.get(`${tenantId}:${key}`);
    if (!entry) return null;
    if (entry.expiresAt < new Date()) { this.store.delete(`${tenantId}:${key}`); return null; }
    return entry;
  }
  async set(tenantId: string, key: string, endpoint: string, status: number, body: unknown): Promise<void> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    this.store.set(`${tenantId}:${key}`, { endpoint, responseStatus: status, responseBody: body, expiresAt });
  }
}

// Express middleware factory — wrap write handlers with idempotency replay
export function withIdempotency(store: IdempotencyStore) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    if (!key || !req.auth?.tenantId) return next();
    const cached = await store.get(req.auth.tenantId, key);
    if (cached) { res.status(cached.responseStatus).json(cached.responseBody); return; }
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      store.set(req.auth!.tenantId, key, req.path, res.statusCode, body).catch(() => {});
      return originalJson(body);
    };
    next();
  };
}
```

- [ ] **Step 4: Apply middleware to write routes**

In `packages/api/src/routes/mobile.ts`, import `withIdempotency` and apply before each `POST` handler:

```typescript
router.post('/:id/status', requireAuth, requireTenant, withIdempotency(deps.idempotencyStore), ...handler);
router.post('/push-tokens', requireAuth, requireTenant, withIdempotency(deps.idempotencyStore), ...handler);
```

- [ ] **Step 5: Run full mobile test suite**

Run: `cd packages/api && npx vitest run test/mobile/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/mobile/idempotency.ts packages/api/test/mobile/idempotency.test.ts \
        packages/api/src/routes/mobile.ts
git commit -m "feat(mobile): server-side idempotency middleware replays on duplicate Idempotency-Key

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

### Task 7: Client-Side Mutation Queue (useSyncQueue)

**Files:**
- Create: `packages/web/src/hooks/useSyncQueue.ts`
- Create: `packages/web/src/lib/mobileApi.ts`

**Context:** The Dexie database is initialised once per app session. `useSyncQueue` returns `{ enqueue, queueLength, failedCount }`. `enqueue` writes a pending mutation to IndexedDB and immediately triggers `flushQueue`. `flushQueue` locks inflight entries (sets `lockedUntil = now + 60s`), POSTs each with its `Idempotency-Key` header, marks done or increments `retryCount`. After 5 failures the entry moves to `status: 'failed'`. The hook attaches a `window` `online` listener and a 30-second interval on mount, both calling `flushQueue`.

- [ ] **Step 1: Write the test**

```typescript
// packages/web/src/hooks/useSyncQueue.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSyncQueue } from './useSyncQueue';

// Dexie is mocked in vitest.setup.ts with an in-memory adapter
describe('useSyncQueue', () => {
  it('enqueue increases queueLength', async () => {
    const { result } = renderHook(() => useSyncQueue());
    await act(async () => {
      await result.current.enqueue({ endpoint: '/api/mobile/appointments/a1/status', method: 'POST', payload: { status: 'en_route' } });
    });
    expect(result.current.queueLength).toBe(1);
  });

  it('successful flush marks entry done and decrements queueLength', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const { result } = renderHook(() => useSyncQueue());
    await act(async () => {
      await result.current.enqueue({ endpoint: '/api/mobile/appointments/a1/status', method: 'POST', payload: { status: 'en_route' } });
    });
    await act(async () => { await result.current.flush(); });
    expect(result.current.queueLength).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/hooks/useSyncQueue.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement useSyncQueue**

Create `packages/web/src/hooks/useSyncQueue.ts` using Dexie for IndexedDB. Expose `enqueue`, `flush`, `queueLength`, `failedCount`. Wire `online` event listener and `setInterval(flush, 30_000)` in `useEffect`.

- [ ] **Step 4: Create typed API client**

Create `packages/web/src/lib/mobileApi.ts` with typed wrappers: `getSchedule()`, `getJobDetail(id)`, `updateStatus(appointmentId, status, idempotencyKey)`, `registerPushToken(token)`. Each wrapper adds the `Idempotency-Key` header when provided.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/useSyncQueue.ts packages/web/src/lib/mobileApi.ts \
        packages/web/src/hooks/useSyncQueue.test.ts
git commit -m "feat(mobile): client-side Dexie mutation queue with online event + 30s flush

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

## Phase 4: Push Notifications

### Task 8: PushNotificationService + FCM Integration

**Files:**
- Create: `packages/api/src/mobile/push-notification-service.ts`
- Create: `packages/api/test/mobile/push-notification.test.ts`
- Modify: `packages/api/src/appointments/assignment.ts` (emit push after create)
- Modify: `packages/api/src/app.ts` (wire FCM or Noop push service)

**Context:** `PushNotificationService` is a thin interface so tests can inject `NoopPushNotificationService`. The FCM implementation uses the `firebase-admin` SDK (`messaging().sendEachForMulticast`). Two triggers: (1) when an appointment is assigned to a technician — call `pushService.send(technicianId, { title: 'New job assigned', body: appointmentSummary, data: { appointmentId } })`; (2) when the job chat receives a dispatcher message (handled in the conversations route — out of Phase 4 scope, noted in plan). The `PushNotificationService.send` method looks up all non-expired push tokens for the technician and fans out.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/mobile/push-notification.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NoopPushNotificationService } from '../../src/mobile/push-notification-service';

describe('PushNotificationService', () => {
  it('NoopImpl.send resolves without throwing', async () => {
    const svc = new NoopPushNotificationService();
    await expect(svc.send('tech-1', { title: 'Test', body: 'Hello', data: {} })).resolves.not.toThrow();
  });

  it('NoopImpl records sent notifications for test inspection', async () => {
    const svc = new NoopPushNotificationService();
    await svc.send('tech-1', { title: 'A', body: 'B', data: { appointmentId: 'x' } });
    expect(svc.sent).toHaveLength(1);
    expect(svc.sent[0].technicianId).toBe('tech-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/mobile/push-notification.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement push service**

Create `packages/api/src/mobile/push-notification-service.ts`:

```typescript
export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushNotificationService {
  send(technicianId: string, payload: PushPayload): Promise<void>;
}

export class NoopPushNotificationService implements PushNotificationService {
  public sent: Array<{ technicianId: string; payload: PushPayload }> = [];
  async send(technicianId: string, payload: PushPayload): Promise<void> {
    this.sent.push({ technicianId, payload });
  }
}

// FcmPushNotificationService is conditionally constructed in app.ts
// when FIREBASE_SERVICE_ACCOUNT_JSON env var is present.
export class FcmPushNotificationService implements PushNotificationService {
  constructor(
    private readonly pushTokenRepo: PushTokenRepository,
    private readonly messaging: admin.messaging.Messaging
  ) {}

  async send(technicianId: string, payload: PushPayload): Promise<void> {
    // Implementation: look up tokens, fan out via messaging().sendEachForMulticast
  }
}
```

- [ ] **Step 4: Wire push into assignment**

In `packages/api/src/appointments/assignment.ts`, update `createAssignment` to accept an optional `PushNotificationService` dep and call `pushService?.send(technicianId, { title: 'New job assigned', ... })` after a successful create.

- [ ] **Step 5: Run tests**

Run: `cd packages/api && npx vitest run test/mobile/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/mobile/push-notification-service.ts \
        packages/api/test/mobile/push-notification.test.ts \
        packages/api/src/appointments/assignment.ts packages/api/src/app.ts
git commit -m "feat(mobile): PushNotificationService interface + Noop/FCM impls, trigger on assignment

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

## Phase 5: Mobile UI Skeleton — PWA

### Task 9: Schedule View + Job Detail View

**Files:**
- Create: `packages/web/src/pages/mobile/MobileSchedulePage.tsx`
- Create: `packages/web/src/pages/mobile/MobileJobDetailPage.tsx`
- Create: `packages/web/src/pages/mobile/MobileStatusButtons.tsx`
- Modify: `packages/web/src/App.tsx` (add `/mobile/*` routes)

**Context:** `MobileSchedulePage` calls `mobileApi.getSchedule()` on mount, renders a list of `AppointmentCard` components with status chips colour-coded by `mobileStatus` (`en_route`=blue, `arrived`=amber, `in_progress`=orange, `completed`=green). Tapping a card navigates to `MobileJobDetailPage`. `MobileStatusButtons` renders three buttons beneath the job detail: "I'm on my way", "I've arrived", "Job complete". Clicking enqueues the mutation via `useSyncQueue`. The existing `MobileTechView.tsx` covers voice recording — these new pages sit alongside it. All touch targets are >= 44px (matching the `MIN_TOUCH_TARGET_PX` constant already in `MobileTechView.tsx`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/pages/mobile/MobileSchedulePage.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileSchedulePage } from './MobileSchedulePage';
import * as mobileApi from '../../lib/mobileApi';

vi.mock('../../lib/mobileApi');

describe('MobileSchedulePage', () => {
  it('renders appointment cards returned from the API', async () => {
    vi.mocked(mobileApi.getSchedule).mockResolvedValue([
      { id: 'a1', jobId: 'j1', scheduledStart: new Date().toISOString(), scheduledEnd: new Date().toISOString(),
        status: 'confirmed', mobileStatus: null, customerName: 'Dana', address: '1 River St', notes: null },
    ]);
    render(<MobileSchedulePage />);
    await waitFor(() => expect(screen.getByText('Dana')).toBeInTheDocument());
    expect(screen.getByText('1 River St')).toBeInTheDocument();
  });

  it('shows empty state when no appointments', async () => {
    vi.mocked(mobileApi.getSchedule).mockResolvedValue([]);
    render(<MobileSchedulePage />);
    await waitFor(() => expect(screen.getByText(/no appointments/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/pages/mobile/MobileSchedulePage.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement schedule page**

Create `packages/web/src/pages/mobile/MobileSchedulePage.tsx`. Use `useEffect` + `mobileApi.getSchedule()`. Render a `<ul>` of appointment cards. Each card shows `customerName`, `address`, formatted `scheduledStart`, and a coloured status chip. Empty state renders "No appointments today".

- [ ] **Step 4: Implement job detail + status buttons**

Create `packages/web/src/pages/mobile/MobileJobDetailPage.tsx`. Uses `mobileApi.getJobDetail(id)` from URL param. Renders customer name, address, notes, photos (using existing `FileRecord` shape). Below the detail, renders `<MobileStatusButtons appointmentId={id} currentStatus={mobileStatus} />`.

Create `packages/web/src/pages/mobile/MobileStatusButtons.tsx`. Maps `currentStatus` to the next valid action label. On press, calls `useSyncQueue().enqueue(...)` and optimistically updates local state.

- [ ] **Step 5: Wire routes in App.tsx**

Add to the React Router config: `<Route path="/mobile/schedule" element={<MobileSchedulePage />} />` and `<Route path="/mobile/jobs/:id" element={<MobileJobDetailPage />} />`. Wrap in the existing Clerk auth guard.

- [ ] **Step 6: Run tests**

Run: `cd packages/web && npx vitest run src/pages/mobile/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/pages/mobile/ packages/web/src/App.tsx
git commit -m "feat(mobile): schedule view, job detail view, and status action buttons (PWA)

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

### Task 10: Workbox Service Worker

**Files:**
- Create: `packages/web/src/sw/mobile-sw.ts`
- Modify: `packages/web/vite.config.ts`

**Context:** The service worker uses Workbox's `CacheFirst` strategy for all static assets (`/mobile/*.js`, `*.css`, fonts) and `NetworkFirst` (with a 3-second timeout falling back to cache) for all `/api/mobile/schedule` GET requests. Write endpoints (`POST`) are never cached — they go through the mutation queue. The Vite plugin is `vite-plugin-pwa` with `injectRegister: 'auto'`.

- [ ] **Step 1: Write the service worker**

```typescript
// packages/web/src/sw/mobile-sw.ts
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

precacheAndRoute(self.__WB_MANIFEST);

// Cache-first for static assets
registerRoute(
  ({ request }) => request.destination === 'script' || request.destination === 'style',
  new CacheFirst({ cacheName: 'mobile-static-v1', plugins: [new ExpirationPlugin({ maxEntries: 60 })] })
);

// Network-first for schedule GET (falls back to cache when offline)
registerRoute(
  ({ url }) => url.pathname === '/api/mobile/schedule',
  new NetworkFirst({ cacheName: 'mobile-schedule-v1', networkTimeoutSeconds: 3 })
);
```

- [ ] **Step 2: Wire Vite plugin**

Add `VitePWA({ srcDir: 'src/sw', filename: 'mobile-sw.ts', strategies: 'injectManifest', injectRegister: 'auto' })` to `packages/web/vite.config.ts` plugins array.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/sw/mobile-sw.ts packages/web/vite.config.ts
git commit -m "feat(mobile): Workbox service worker — cache-first assets, network-first schedule

https://claude.ai/code/session_016CkAAycFBx79GgNPtjf3gS"
```

---

## Out of Scope

- Native app store distribution (iOS App Store, Google Play) — PWA install prompt only in this plan; native shell can be layered on top via Capacitor once PWA is stable
- Billing, payments, or invoice creation from the mobile UI
- Full offline CRM — customer creation, editing, or search while offline
- Technician-to-technician messaging — the push notification trigger for job chat covers dispatcher-to-technician only
- Time logging / clock-in clock-out with payroll integration — time capture is noted as a goal but the data model and reporting hooks are deferred to a subsequent slice
- Background geofence triggers — the existing `technician_location_pings` table collects GPS, but triggering status updates automatically based on proximity is not covered here
- APNs direct integration — FCM bridges to APNs; direct APNs certificate management is not part of this plan
- Offline photo capture — the camera flow uses the `FileRecord` + `StorageProvider` pattern from `packages/api/src/files/`; the upload itself requires connectivity and is not queued through the mutation queue in this plan (upload queue is a follow-on slice)

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/routes/mobile.ts`
- `/home/user/Serviceos/packages/api/src/mobile/idempotency.ts`
- `/home/user/Serviceos/packages/web/src/hooks/useSyncQueue.ts`
- `/home/user/Serviceos/packages/api/src/app.ts`
