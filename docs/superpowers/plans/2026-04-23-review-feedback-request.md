# Review & Feedback Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a job is marked `completed`, the system automatically enqueues a deferred feedback request that sends an SMS to the customer. If the customer submits a rating >= 4, the response payload includes Google/Yelp review URLs drawn from tenant settings. Negative or neutral responses are collected silently for internal review.

**Architecture:** Two new database tables (`feedback_requests`, `feedback_responses`) plus two repository pairs (InMemory + Pg) follow the established pattern in this codebase. A `FeedbackRequestDispatcher` seam decouples `transitionJobStatus` from Twilio, so the dispatcher can be swapped from `NoopFeedbackRequestDispatcher` (tests/dev) to `SmsFeedbackRequestDispatcher` (prod) via dependency injection in `app.ts`. The Queue interface gains a `delaySeconds` parameter so feedback requests are enqueued with a 2-hour delay; `InMemoryQueue.send` uses `setTimeout`, and `PgQueue.send` sets `visible_at = NOW() + interval`. A public Express router mounted *before* the Clerk middleware handles the token-gated GET/POST endpoints.

**Tech Stack:** TypeScript, Express, Node.js, `pg` driver (API). React, TypeScript, Tailwind, Recharts (web). Vitest for all tests.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/feedback/feedback-request.ts` | `FeedbackRequest` entity, `FeedbackRequestRepository` interface, `InMemoryFeedbackRequestRepository`, domain helpers |
| `packages/api/src/feedback/feedback-response.ts` | `FeedbackResponse` entity, `FeedbackResponseRepository` interface, `InMemoryFeedbackResponseRepository` |
| `packages/api/src/feedback/pg-feedback-request.ts` | `PgFeedbackRequestRepository` backed by `feedback_requests` table |
| `packages/api/src/feedback/pg-feedback-response.ts` | `PgFeedbackResponseRepository` backed by `feedback_responses` table |
| `packages/api/src/feedback/dispatcher.ts` | `FeedbackRequestDispatcher` interface, `NoopFeedbackRequestDispatcher`, `SmsFeedbackRequestDispatcher` |
| `packages/api/src/feedback/worker.ts` | `feedback_send` queue worker — reads a pending request, sends SMS, marks `sent` |
| `packages/api/src/routes/public-feedback.ts` | `GET /public/feedback/:token` and `POST /public/feedback/:token` — no Clerk auth |
| `packages/web/src/components/customer/FeedbackPage.tsx` | Public star-rating form; shows Google/Yelp buttons on high rating |
| `packages/web/src/components/settings/FeedbackDashboard.tsx` | Admin page: average rating, distribution bar chart, comments list |
| `packages/api/test/feedback/feedback-request.test.ts` | Unit tests for InMemory repo & domain helpers |
| `packages/api/test/feedback/feedback-response.test.ts` | Unit tests for InMemory response repo |
| `packages/api/test/feedback/dispatcher.test.ts` | Tests for Noop dispatcher and job-completion hook |
| `packages/api/test/feedback/worker.test.ts` | Tests for the `feedback_send` queue worker |
| `packages/api/test/routes/public-feedback.route.test.ts` | Route-shape tests for public feedback endpoints |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1** modifies `packages/api/src/db/schema.ts` (migrations 041–043) and `packages/api/src/queues/queue.ts` + `packages/api/src/queues/pg-queue.ts` (add `delaySeconds` to `Queue.send`).

**Phase 3** modifies `packages/api/src/jobs/job-lifecycle.ts` (`transitionJobStatus` gains an optional `FeedbackRequestDispatcher` param) and `packages/api/src/routes/jobs.ts` (pass dispatcher from DI). Also modifies `packages/api/src/settings/settings.ts` and `packages/api/src/settings/pg-settings.ts` (add `googleReviewUrl`, `yelpReviewUrl` fields).

**Phase 4** modifies `packages/api/src/app.ts` (mount public router before Clerk middleware; wire feedback repos and worker into the queue registry) and `packages/web/src/routes.ts` (add `/public/feedback/:token` route outside ProtectedRoute).

**Phase 5** modifies `packages/web/src/routes.ts` (add `/settings/feedback` route inside Shell) and `packages/web/src/components/settings/SettingsPage.tsx` (link to FeedbackDashboard).

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database Migrations & Queue Delay Extension

Add the two new tables and extend the Queue abstraction to support deferred delivery.

### Task 1: Migrations for `feedback_requests` and `feedback_responses`

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Append two new entries after `'040_create_technician_location_pings'`. The `feedback_requests` table has `UNIQUE(tenant_id, job_id)` to enforce one request per job. The token column is a UUID indexed for fast public lookups. The `feedback_responses` table references `feedback_requests` via a FK.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/feedback/migrations.test.ts
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('feedback migrations', () => {
  it('defines 041_create_feedback_requests', () => {
    expect(MIGRATIONS).toHaveProperty('041_create_feedback_requests');
    expect(MIGRATIONS['041_create_feedback_requests']).toContain('feedback_requests');
    expect(MIGRATIONS['041_create_feedback_requests']).toContain('UNIQUE');
  });
  it('defines 042_create_feedback_responses', () => {
    expect(MIGRATIONS).toHaveProperty('042_create_feedback_responses');
    expect(MIGRATIONS['042_create_feedback_responses']).toContain('feedback_responses');
  });
  it('defines 043_add_review_urls_to_settings', () => {
    expect(MIGRATIONS).toHaveProperty('043_add_review_urls_to_settings');
    expect(MIGRATIONS['043_add_review_urls_to_settings']).toContain('google_review_url');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/feedback/migrations.test.ts`
Expected: FAIL — keys `041_create_feedback_requests`, `042_create_feedback_responses`, `043_add_review_urls_to_settings` do not exist in `MIGRATIONS`.

- [ ] **Step 3: Implement — append to MIGRATIONS in `schema.ts`**

Add after the `'040_...'` entry:

```sql
-- 041_create_feedback_requests
CREATE TABLE IF NOT EXISTS feedback_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  job_id UUID NOT NULL REFERENCES jobs(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  token UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','responded','skipped')),
  delay_seconds INTEGER NOT NULL DEFAULT 7200,
  sent_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_fr_token ON feedback_requests(token);
CREATE INDEX IF NOT EXISTS idx_fr_tenant_status ON feedback_requests(tenant_id, status);
ALTER TABLE feedback_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_feedback_requests ON feedback_requests;
CREATE POLICY tenant_isolation_feedback_requests ON feedback_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- 042_create_feedback_responses
CREATE TABLE IF NOT EXISTS feedback_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  feedback_request_id UUID NOT NULL REFERENCES feedback_requests(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  review_platform_prompted BOOLEAN NOT NULL DEFAULT false,
  review_platform_clicked BOOLEAN NOT NULL DEFAULT false,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_frs_request ON feedback_responses(feedback_request_id);
CREATE INDEX IF NOT EXISTS idx_frs_tenant ON feedback_responses(tenant_id);
ALTER TABLE feedback_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_responses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_feedback_responses ON feedback_responses;
CREATE POLICY tenant_isolation_feedback_responses ON feedback_responses
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- 043_add_review_urls_to_settings
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS google_review_url TEXT,
  ADD COLUMN IF NOT EXISTS yelp_review_url TEXT;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/feedback/migrations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/test/feedback/migrations.test.ts
git commit -m "feat(feedback): add feedback_requests, feedback_responses migrations and review URL columns (041-043)"
```

---

### Task 2: Extend Queue interface with `delaySeconds`

**Files:**
- Modify: `packages/api/src/queues/queue.ts`
- Modify: `packages/api/src/queues/pg-queue.ts`

**Context:** `Queue.send` gains an optional fourth parameter `delaySeconds?: number`. `InMemoryQueue` uses `setTimeout` to defer insertion so the message isn't visible until after the delay. `PgQueue.send` passes `visible_at = NOW() + (delaySeconds || ' seconds')::interval`. This is backward-compatible: all existing callers that pass three arguments continue to work because the fourth parameter defaults to `0`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/queues/queue-delay.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryQueue } from '../../src/queues/queue';

describe('InMemoryQueue delaySeconds', () => {
  it('message is not visible before the delay has elapsed', async () => {
    const q = new InMemoryQueue();
    await q.send('test_type', { x: 1 }, 'key-1', 0.05); // 50ms delay
    const immediate = await q.receive();
    expect(immediate).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    const deferred = await q.receive();
    expect(deferred).not.toBeNull();
    expect(deferred?.type).toBe('test_type');
  });

  it('zero delay is immediate (backward-compatible)', async () => {
    const q = new InMemoryQueue();
    await q.send('test_type', { y: 2 }, 'key-2');
    const msg = await q.receive();
    expect(msg).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/queues/queue-delay.test.ts`
Expected: FAIL — `send` signature does not accept a fourth argument; immediate receive returns the message even when delay is intended.

- [ ] **Step 3: Implement in `queue.ts`**

Update the `Queue` interface:
```typescript
send<T>(type: string, payload: T, idempotencyKey?: string, delaySeconds?: number): Promise<string>;
```

Update `InMemoryQueue.send` to insert the message into a private `pending` array, schedule a `setTimeout(delaySeconds * 1000)` that moves it to `this.messages`, and skip insertion into `this.messages` when `delaySeconds > 0`.

- [ ] **Step 4: Implement in `pg-queue.ts`**

Update `PgQueue.send` insert to use `visible_at = NOW() + ($7 || ' seconds')::interval` where `$7 = String(delaySeconds ?? 0)`.

- [ ] **Step 5: Run tests**

Run: `cd packages/api && npx vitest run test/queues/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/queues/queue.ts packages/api/src/queues/pg-queue.ts packages/api/test/queues/queue-delay.test.ts
git commit -m "feat(queue): add delaySeconds param to Queue.send for deferred delivery"
```

---

## Phase 2: Repositories

Build InMemory and Pg implementations for both new tables.

### Task 3: `FeedbackRequest` entity & InMemory repository

**Files:**
- Create: `packages/api/src/feedback/feedback-request.ts`
- Create: `packages/api/test/feedback/feedback-request.test.ts`

**Context:** The `FeedbackRequestRepository` interface needs `create`, `findByToken`, `findByJob`, `findByTenantAndStatus`, and `updateStatus`. The `create` method must throw a conflict error if a row already exists for `(tenant_id, job_id)` to enforce idempotency at the domain layer. `token` is a `crypto.randomUUID()` assigned at creation.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/feedback/feedback-request.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryFeedbackRequestRepository, createFeedbackRequest } from '../../src/feedback/feedback-request';

describe('InMemoryFeedbackRequestRepository', () => {
  let repo: InMemoryFeedbackRequestRepository;

  beforeEach(() => { repo = new InMemoryFeedbackRequestRepository(); });

  it('creates a feedback request and returns it with a token', async () => {
    const req = await createFeedbackRequest(
      { tenantId: 't1', jobId: 'j1', customerId: 'c1' },
      repo
    );
    expect(req.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.status).toBe('pending');
  });

  it('enforces uniqueness on (tenantId, jobId)', async () => {
    await createFeedbackRequest({ tenantId: 't1', jobId: 'j1', customerId: 'c1' }, repo);
    await expect(
      createFeedbackRequest({ tenantId: 't1', jobId: 'j1', customerId: 'c1' }, repo)
    ).rejects.toThrow('already exists');
  });

  it('findByToken returns the request', async () => {
    const req = await createFeedbackRequest({ tenantId: 't1', jobId: 'j2', customerId: 'c1' }, repo);
    const found = await repo.findByToken(req.token);
    expect(found?.id).toBe(req.id);
  });

  it('updateStatus transitions the status field', async () => {
    const req = await createFeedbackRequest({ tenantId: 't1', jobId: 'j3', customerId: 'c1' }, repo);
    await repo.updateStatus(req.id, 'sent', new Date());
    const updated = await repo.findByToken(req.token);
    expect(updated?.status).toBe('sent');
    expect(updated?.sentAt).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/feedback/feedback-request.test.ts`
Expected: FAIL — module `../../src/feedback/feedback-request` does not exist.

- [ ] **Step 3: Implement `feedback-request.ts`**

Define `FeedbackRequest` interface with all columns from migration 041. Define `FeedbackRequestRepository` interface. Implement `InMemoryFeedbackRequestRepository` with a `Map<string, FeedbackRequest>` keyed by `id`, a secondary index `tokenIndex: Map<string, string>` (token -> id), and a `jobIndex: Set<string>` (tenantId+jobId composite). Implement `createFeedbackRequest` domain helper.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/feedback/feedback-request.ts packages/api/test/feedback/feedback-request.test.ts
git commit -m "feat(feedback): FeedbackRequest entity and InMemory repository"
```

---

### Task 4: `FeedbackResponse` entity & InMemory repository

**Files:**
- Create: `packages/api/src/feedback/feedback-response.ts`
- Create: `packages/api/test/feedback/feedback-response.test.ts`

**Context:** `FeedbackResponseRepository` needs `create`, `findByRequestId`, `listByTenant` (for the dashboard). `listByTenant` accepts optional `limit` and `offset` for pagination and returns rows ordered by `submitted_at DESC`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/feedback/feedback-response.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryFeedbackResponseRepository } from '../../src/feedback/feedback-response';

describe('InMemoryFeedbackResponseRepository', () => {
  let repo: InMemoryFeedbackResponseRepository;

  beforeEach(() => { repo = new InMemoryFeedbackResponseRepository(); });

  it('creates a response and finds it by requestId', async () => {
    const resp = await repo.create({
      tenantId: 't1', feedbackRequestId: 'fr1', rating: 5,
      comment: 'Great!', reviewPlatformPrompted: true, reviewPlatformClicked: false,
    });
    expect(resp.id).toBeDefined();
    const found = await repo.findByRequestId('fr1');
    expect(found?.rating).toBe(5);
  });

  it('listByTenant returns ordered results', async () => {
    for (let i = 1; i <= 3; i++) {
      await repo.create({ tenantId: 't1', feedbackRequestId: `fr${i}`, rating: i, reviewPlatformPrompted: false, reviewPlatformClicked: false });
    }
    const list = await repo.listByTenant('t1', { limit: 10, offset: 0 });
    expect(list).toHaveLength(3);
    expect(list[0].rating).toBeGreaterThanOrEqual(list[1].rating);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/feedback/feedback-response.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `feedback-response.ts`**

Define `FeedbackResponse` interface and `CreateFeedbackResponseInput`. Implement `InMemoryFeedbackResponseRepository` with in-memory array storage.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/feedback/feedback-response.ts packages/api/test/feedback/feedback-response.test.ts
git commit -m "feat(feedback): FeedbackResponse entity and InMemory repository"
```

---

### Task 5: Pg implementations for both repositories

**Files:**
- Create: `packages/api/src/feedback/pg-feedback-request.ts`
- Create: `packages/api/src/feedback/pg-feedback-response.ts`

**Context:** Both extend `PgBaseRepository`. `PgFeedbackRequestRepository.create` uses `INSERT ... ON CONFLICT (tenant_id, job_id) DO NOTHING RETURNING *` — if `rowCount` is 0 it throws a conflict error matching the InMemory contract. Token lookup bypasses RLS (token is globally unique) so it uses `withClient` rather than `withTenant`. `PgFeedbackResponseRepository.listByTenant` uses `withTenant` with `ORDER BY submitted_at DESC LIMIT $2 OFFSET $3`.

- [ ] **Step 1: Write the failing test**

No integration test against a real DB is required here — the InMemory tests from Tasks 3 & 4 act as the contract. Write a structural compile-time check:

```typescript
// packages/api/test/feedback/pg-feedback-repos.test.ts
import { describe, it, expect } from 'vitest';
import { PgFeedbackRequestRepository } from '../../src/feedback/pg-feedback-request';
import { PgFeedbackResponseRepository } from '../../src/feedback/pg-feedback-response';
import { FeedbackRequestRepository } from '../../src/feedback/feedback-request';
import { FeedbackResponseRepository } from '../../src/feedback/feedback-response';

describe('Pg repo structural contracts', () => {
  it('PgFeedbackRequestRepository satisfies FeedbackRequestRepository interface', () => {
    // TypeScript compile-time check — if this file compiles, the contract is satisfied.
    const check: FeedbackRequestRepository = {} as PgFeedbackRequestRepository;
    expect(check).toBeDefined();
  });
  it('PgFeedbackResponseRepository satisfies FeedbackResponseRepository interface', () => {
    const check: FeedbackResponseRepository = {} as PgFeedbackResponseRepository;
    expect(check).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/feedback/pg-feedback-repos.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement Pg repositories**

`pg-feedback-request.ts`: Extend `PgBaseRepository`. Map snake_case columns to camelCase in a `mapRow` helper. Handle the `ON CONFLICT` idempotency throw.

`pg-feedback-response.ts`: Extend `PgBaseRepository`. `listByTenant` uses `withTenant` so RLS is enforced.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/feedback/pg-feedback-request.ts packages/api/src/feedback/pg-feedback-response.ts packages/api/test/feedback/pg-feedback-repos.test.ts
git commit -m "feat(feedback): PgFeedbackRequestRepository and PgFeedbackResponseRepository"
```

---

## Phase 3: Dispatcher & Job Completion Hook

Wire the dispatcher into the status-transition path and add the queue worker that sends the SMS.

### Task 6: `FeedbackRequestDispatcher` interface + Noop implementation

**Files:**
- Create: `packages/api/src/feedback/dispatcher.ts`
- Create: `packages/api/test/feedback/dispatcher.test.ts`

**Context:** The dispatcher interface is the seam that keeps `transitionJobStatus` decoupled from Twilio. `NoopFeedbackRequestDispatcher.onJobCompleted` does nothing and is the default in dev/test. `SmsFeedbackRequestDispatcher` creates a `FeedbackRequest` in the repo and enqueues a `feedback_send` message with a 2-hour (7200 second) delay. The queue payload is `{ tenantId, feedbackRequestId, token, customerPhone }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/feedback/dispatcher.test.ts
import { describe, it, expect } from 'vitest';
import { NoopFeedbackRequestDispatcher, SmsFeedbackRequestDispatcher } from '../../src/feedback/dispatcher';
import { InMemoryFeedbackRequestRepository } from '../../src/feedback/feedback-request';
import { InMemoryQueue } from '../../src/queues/queue';

describe('NoopFeedbackRequestDispatcher', () => {
  it('onJobCompleted does not throw', async () => {
    const d = new NoopFeedbackRequestDispatcher();
    await expect(d.onJobCompleted('t1', 'j1', 'c1')).resolves.toBeUndefined();
  });
});

describe('SmsFeedbackRequestDispatcher', () => {
  it('creates a feedback_request and enqueues feedback_send with 7200s delay', async () => {
    const repo = new InMemoryFeedbackRequestRepository();
    const queue = new InMemoryQueue();
    const dispatcher = new SmsFeedbackRequestDispatcher(repo, queue, async () => '+15551234567');

    await dispatcher.onJobCompleted('t1', 'j1', 'c1');

    expect(queue.size()).toBe(0); // deferred — not yet visible
    const allPending = repo['items'] ?? repo['store'] ?? (repo as any).requests;
    expect(Object.values(allPending ?? {}).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/feedback/dispatcher.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `dispatcher.ts`**

```typescript
export interface FeedbackRequestDispatcher {
  onJobCompleted(tenantId: string, jobId: string, customerId: string): Promise<void>;
}

export class NoopFeedbackRequestDispatcher implements FeedbackRequestDispatcher {
  async onJobCompleted(_tenantId: string, _jobId: string, _customerId: string): Promise<void> {}
}

export class SmsFeedbackRequestDispatcher implements FeedbackRequestDispatcher {
  constructor(
    private readonly requestRepo: FeedbackRequestRepository,
    private readonly queue: Queue,
    private readonly resolvePhone: (customerId: string) => Promise<string | undefined>,
    private readonly delaySeconds = 7200,
  ) {}

  async onJobCompleted(tenantId: string, jobId: string, customerId: string): Promise<void> {
    const req = await createFeedbackRequest({ tenantId, jobId, customerId }, this.requestRepo);
    const phone = await this.resolvePhone(customerId);
    if (!phone) return;
    await this.queue.send(
      'feedback_send',
      { tenantId, feedbackRequestId: req.id, token: req.token, customerPhone: phone },
      `feedback:${tenantId}:${jobId}`,
      this.delaySeconds,
    );
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/feedback/dispatcher.ts packages/api/test/feedback/dispatcher.test.ts
git commit -m "feat(feedback): FeedbackRequestDispatcher interface, Noop and Sms implementations"
```

---

### Task 7: `feedback_send` queue worker

**Files:**
- Create: `packages/api/src/feedback/worker.ts`
- Create: `packages/api/test/feedback/worker.test.ts`

**Context:** The worker receives `feedback_send` messages, looks up the request, sends the SMS via a `SmsProvider` interface (analogous to `InvoiceDeliveryProvider`), and marks the request `sent`. A `NoopSmsProvider` is used in tests. The SMS body is: `"How was your service today? Tap to rate: https://app.example.com/public/feedback/{token}"`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/feedback/worker.test.ts
import { describe, it, expect } from 'vitest';
import { createFeedbackSendWorker } from '../../src/feedback/worker';
import { InMemoryFeedbackRequestRepository, createFeedbackRequest } from '../../src/feedback/feedback-request';
import { createLogger } from '../../src/logging/logger';

describe('feedback_send worker', () => {
  it('marks request as sent after processing', async () => {
    const repo = new InMemoryFeedbackRequestRepository();
    const req = await createFeedbackRequest({ tenantId: 't1', jobId: 'j1', customerId: 'c1' }, repo);
    const sent: string[] = [];
    const worker = createFeedbackSendWorker(repo, { send: async (to, _body) => { sent.push(to); } }, 'https://app.example.com');

    await worker.handle({
      id: 'msg-1', type: 'feedback_send',
      payload: { tenantId: 't1', feedbackRequestId: req.id, token: req.token, customerPhone: '+15559999' },
      attempts: 1, maxAttempts: 3, idempotencyKey: 'k1', createdAt: new Date().toISOString(),
    }, createLogger({ service: 'test', environment: 'test' }));

    expect(sent).toContain('+15559999');
    const updated = await repo.findByToken(req.token);
    expect(updated?.status).toBe('sent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/feedback/worker.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `worker.ts`**

Export `createFeedbackSendWorker(repo, smsProvider, baseUrl)` returning a `WorkerHandler<FeedbackSendPayload>`. The handler fetches the request by id, sends the SMS, then calls `repo.updateStatus(id, 'sent', new Date())`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/feedback/worker.ts packages/api/test/feedback/worker.test.ts
git commit -m "feat(feedback): feedback_send queue worker with NoopSmsProvider for tests"
```

---

### Task 8: Hook dispatcher into `transitionJobStatus` & tenant settings review URLs

**Files:**
- Modify: `packages/api/src/jobs/job-lifecycle.ts`
- Modify: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/settings/settings.ts`
- Modify: `packages/api/src/settings/pg-settings.ts`

**Context:** `transitionJobStatus` gains an optional last parameter `dispatcher?: FeedbackRequestDispatcher`. When `newStatus === 'completed'`, it calls `dispatcher.onJobCompleted(tenantId, jobId, job.customerId)`. This is fire-and-forget (`void`) so a dispatcher failure does not roll back the status change. `settings.ts` adds `googleReviewUrl?: string` and `yelpReviewUrl?: string` to `TenantSettings` and related interfaces.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/feedback/job-completion-hook.test.ts
import { describe, it, expect } from 'vitest';
import { transitionJobStatus } from '../../src/jobs/job-lifecycle';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { NoopFeedbackRequestDispatcher } from '../../src/feedback/dispatcher';
import { createJob } from '../../src/jobs/job';

describe('transitionJobStatus — feedback hook', () => {
  it('calls onJobCompleted when transitioning to completed', async () => {
    const jobRepo = new InMemoryJobRepository();
    const timelineRepo = new InMemoryJobTimelineRepository();
    const calls: string[] = [];
    const dispatcher = { onJobCompleted: async (_t: string, jobId: string) => { calls.push(jobId); } };

    const { job } = await createJob({ tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Test', createdBy: 'u1' }, jobRepo);
    await transitionJobStatus('t1', job.id, 'scheduled', 'u1', 'owner', jobRepo, timelineRepo);
    await transitionJobStatus('t1', job.id, 'in_progress', 'u1', 'owner', jobRepo, timelineRepo);
    await transitionJobStatus('t1', job.id, 'completed', 'u1', 'owner', jobRepo, timelineRepo, undefined, dispatcher);

    expect(calls).toContain(job.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/feedback/job-completion-hook.test.ts`
Expected: FAIL — `transitionJobStatus` does not accept a dispatcher argument; `calls` stays empty.

- [ ] **Step 3: Implement**

In `job-lifecycle.ts`, add `dispatcher?: FeedbackRequestDispatcher` as the last parameter of `transitionJobStatus`. After `timelineRepo.create(entry)`, add:

```typescript
if (newStatus === 'completed' && dispatcher) {
  void dispatcher.onJobCompleted(tenantId, jobId, job.customerId);
}
```

In `routes/jobs.ts`, update `createJobRouter` to accept an optional `dispatcher?: FeedbackRequestDispatcher` param and pass it through to `transitionJobStatus`.

In `settings.ts`, add `googleReviewUrl?: string` and `yelpReviewUrl?: string` to `TenantSettings`, `CreateSettingsInput`, and `UpdateSettingsInput`. In `pg-settings.ts`, add the two new columns to the `mapRow` function and the INSERT/UPDATE queries.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd packages/api && npx vitest run test/feedback/ test/jobs/`

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/jobs/job-lifecycle.ts packages/api/src/routes/jobs.ts packages/api/src/settings/settings.ts packages/api/src/settings/pg-settings.ts packages/api/test/feedback/job-completion-hook.test.ts
git commit -m "feat(feedback): hook FeedbackRequestDispatcher into transitionJobStatus on completion"
```

---

## Phase 4: Public API & Frontend Feedback Page

### Task 9: Public feedback API routes (no Clerk auth)

**Files:**
- Create: `packages/api/src/routes/public-feedback.ts`
- Create: `packages/api/test/routes/public-feedback.route.test.ts`

**Context:** `GET /public/feedback/:token` returns `{ jobId, status, expiresAt }` — does not return PII. `POST /public/feedback/:token` accepts `{ rating: number, comment?: string }`, creates a `FeedbackResponse`, marks the request `responded`, and returns `{ reviewUrls?: { google?: string, yelp?: string } }` when `rating >= 4` and the tenant has configured URLs. The router must be mounted in `app.ts` *before* the `verifyClerkSession` middleware. Rate limiting should be applied: 10 requests per 15 minutes per IP on the POST route.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/public-feedback.route.test.ts
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { createPublicFeedbackRouter } from '../../src/routes/public-feedback';
import { InMemoryFeedbackRequestRepository, createFeedbackRequest } from '../../src/feedback/feedback-request';
import { InMemoryFeedbackResponseRepository } from '../../src/feedback/feedback-response';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const requestRepo = new InMemoryFeedbackRequestRepository();
  const responseRepo = new InMemoryFeedbackResponseRepository();
  const settingsRepo = new InMemorySettingsRepository();

  const settings: TenantSettings = {
    id: 's1', tenantId: 't1', businessName: 'Test Co', timezone: 'UTC',
    estimatePrefix: 'EST-', invoicePrefix: 'INV-',
    nextEstimateNumber: 1, nextInvoiceNumber: 1, defaultPaymentTermDays: 30,
    googleReviewUrl: 'https://g.page/test', yelpReviewUrl: 'https://yelp.com/biz/test',
    createdAt: new Date(), updatedAt: new Date(),
  };
  await settingsRepo.create(settings);

  const fr = await createFeedbackRequest({ tenantId: 't1', jobId: 'j1', customerId: 'c1' }, requestRepo);
  app.use('/public/feedback', createPublicFeedbackRouter(requestRepo, responseRepo, settingsRepo));
  return { app, fr };
}

describe('GET /public/feedback/:token', () => {
  it('returns 200 with request metadata', async () => {
    const { app, fr } = await buildApp();
    const res = await request(app).get(`/public/feedback/${fr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
  });

  it('returns 404 for unknown token', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/public/feedback/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('POST /public/feedback/:token', () => {
  it('creates a response and returns reviewUrls for high rating', async () => {
    const { app, fr } = await buildApp();
    const res = await request(app)
      .post(`/public/feedback/${fr.token}`)
      .send({ rating: 5, comment: 'Excellent!' });
    expect(res.status).toBe(200);
    expect(res.body.reviewUrls.google).toContain('g.page');
    expect(res.body.reviewUrls.yelp).toContain('yelp.com');
  });

  it('does not return reviewUrls for low rating', async () => {
    const { app, fr } = await buildApp();
    const res = await request(app).post(`/public/feedback/${fr.token}`).send({ rating: 2 });
    expect(res.status).toBe(200);
    expect(res.body.reviewUrls).toBeUndefined();
  });

  it('rejects invalid rating values', async () => {
    const { app, fr } = await buildApp();
    const res = await request(app).post(`/public/feedback/${fr.token}`).send({ rating: 6 });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/public-feedback.route.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `public-feedback.ts`**

`createPublicFeedbackRouter(requestRepo, responseRepo, settingsRepo)` returns an Express `Router`. GET handler: `findByToken` or 404. POST handler: validate `rating` is 1–5, call `responseRepo.create(...)`, call `requestRepo.updateStatus(id, 'responded')`, fetch tenant settings, build `reviewUrls` if `rating >= 4`.

- [ ] **Step 4: Mount in `app.ts` before Clerk middleware**

In `app.ts`, import `createPublicFeedbackRouter` and mount it before the `app.use('/api', verifyClerkSession(...))` line:

```typescript
app.use('/public/feedback', createPublicFeedbackRouter(feedbackRequestRepo, feedbackResponseRepo, settingsRepo));
```

Also wire up `feedbackRequestRepo`, `feedbackResponseRepo`, `dispatcher`, and the `feedback_send` worker in `app.ts` following the same InMemory/Pg pattern as other repos.

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/public-feedback.ts packages/api/test/routes/public-feedback.route.test.ts packages/api/src/app.ts
git commit -m "feat(feedback): public GET/POST /public/feedback/:token routes (no Clerk auth required)"
```

---

### Task 10: Frontend feedback page

**Files:**
- Create: `packages/web/src/components/customer/FeedbackPage.tsx`
- Modify: `packages/web/src/routes.ts`

**Context:** The page lives at `/public/feedback/:token`. On mount it calls `GET /public/feedback/:token`. On submit it posts `{ rating, comment }` to `POST /public/feedback/:token`. After successful submit it shows a thank-you message and, if `reviewUrls` is present, renders two CTA buttons (Google and Yelp). The star rating uses five clickable SVG star icons. No Clerk token is sent — the `fetch` call omits the `Authorization` header.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/customer/FeedbackPage.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { FeedbackPage } from './FeedbackPage';

const TOKEN = 'abc-token-123';

describe('FeedbackPage', () => {
  it('renders star rating UI after loading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending', jobId: 'j1' }),
    }));
    render(
      <MemoryRouter initialEntries={[`/public/feedback/${TOKEN}`]}>
        <Routes><Route path="/public/feedback/:token" element={<FeedbackPage />} /></Routes>
      </MemoryRouter>
    );
    await waitFor(() => screen.getByTestId('star-rating'));
    expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/customer/FeedbackPage.test.tsx`
Expected: FAIL — `FeedbackPage` does not exist.

- [ ] **Step 3: Implement `FeedbackPage.tsx`**

A functional React component with three states: `loading`, `rating`, `submitted`. Uses `useState` for `rating` (1-5) and `comment`. On submit, POSTs to the API and transitions to `submitted`. If response includes `reviewUrls`, renders `<a href={reviewUrls.google}>` and `<a href={reviewUrls.yelp}>` buttons. Styled with Tailwind, no Shell wrapper, mobile-friendly.

- [ ] **Step 4: Add route in `routes.ts`**

Add before the auth-gated section:
```typescript
{ path: '/public/feedback/:token', Component: FeedbackPage },
```

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/customer/FeedbackPage.tsx packages/web/src/routes.ts
git commit -m "feat(feedback): public FeedbackPage React component with star rating and review prompt"
```

---

## Phase 5: Feedback Dashboard & Tenant Settings

### Task 11: Tenant settings review URL fields in admin UI

**Files:**
- Modify: `packages/web/src/components/settings/SettingsPage.tsx`

**Context:** Add a new "Reviews" section to `SettingsPage` with two text inputs: Google Review URL and Yelp Review URL. These PATCH `PATCH /api/settings` with `{ googleReviewUrl, yelpReviewUrl }`. The existing `PATCH /api/settings` handler already routes through `updateSettings` which now accepts those fields (added in Task 8). Display a helper text beneath each field: "Customers with a 4+ rating will see a button linking here."

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/settings/ReviewUrlSettings.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { MemoryRouter } from 'react-router';

describe('SettingsPage review URLs section', () => {
  it('renders Google Review URL input', () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByLabelText(/google review url/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/settings/ReviewUrlSettings.test.tsx`
Expected: FAIL — no element with label "Google Review URL".

- [ ] **Step 3: Implement in `SettingsPage.tsx`**

Add a "Reviews" section containing two `<input type="url">` fields with IDs `google-review-url` and `yelp-review-url`, wired to local state and a save button that calls `PATCH /api/settings`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/settings/SettingsPage.tsx packages/web/src/components/settings/ReviewUrlSettings.test.tsx
git commit -m "feat(feedback): add Google/Yelp review URL settings fields to SettingsPage"
```

---

### Task 12: `FeedbackDashboard` component

**Files:**
- Create: `packages/web/src/components/settings/FeedbackDashboard.tsx`
- Modify: `packages/web/src/routes.ts`
- Modify: `packages/web/src/components/settings/SettingsPage.tsx`

**Context:** The dashboard calls `GET /api/feedback/responses?limit=50&offset=0` (a new authenticated route added in this task). It renders: average rating (large number), a bar chart of rating distribution using Recharts `BarChart`, and a scrollable list of comments with rating, date, and excerpt. The Recharts chart wrapper component from `packages/web/src/components/ui/chart.tsx` should be used for consistent styling.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/settings/FeedbackDashboard.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { FeedbackDashboard } from './FeedbackDashboard';

describe('FeedbackDashboard', () => {
  it('shows average rating after loading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        responses: [
          { id: '1', rating: 5, comment: 'Great!', submittedAt: new Date().toISOString() },
          { id: '2', rating: 3, comment: null, submittedAt: new Date().toISOString() },
        ],
        total: 2,
      }),
    }));
    render(<MemoryRouter><FeedbackDashboard /></MemoryRouter>);
    await waitFor(() => screen.getByTestId('average-rating'));
    expect(screen.getByTestId('average-rating').textContent).toContain('4.0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/settings/FeedbackDashboard.test.tsx`
Expected: FAIL — `FeedbackDashboard` does not exist.

- [ ] **Step 3: Implement `FeedbackDashboard.tsx`**

Fetch on mount. Compute `avgRating = (sum of ratings) / count`. Render a `BarChart` from Recharts with 5 bars (one per star value). Render a list of `comment` entries filtered to non-null. A `data-testid="average-rating"` span shows the rounded average.

- [ ] **Step 4: Add API route `GET /api/feedback/responses`**

Create `packages/api/src/routes/feedback.ts` with a single `GET /` handler that calls `responseRepo.listByTenant(tenantId, { limit, offset })` and returns `{ responses, total }`. Mount it in `app.ts` under `/api/feedback/responses` (inside the Clerk middleware block).

- [ ] **Step 5: Add route to `routes.ts` and link from `SettingsPage`**

Add `{ path: 'settings/feedback', Component: FeedbackDashboard }` inside the Shell children. Add a "Feedback & Reviews" row in the `SettingsPage` sections that calls `navigate('settings/feedback')`.

- [ ] **Step 6: Run tests — expect PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/settings/FeedbackDashboard.tsx packages/web/src/components/settings/FeedbackDashboard.test.tsx packages/api/src/routes/feedback.ts packages/web/src/routes.ts
git commit -m "feat(feedback): FeedbackDashboard with average rating, Recharts distribution, and comments list"
```

---

### Task 13: Wire everything into `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

**Context:** This is the DI assembly task. Add `feedbackRequestRepo`, `feedbackResponseRepo`, `dispatcher`, and the `feedback_send` worker to `app.ts`. The dispatcher is `NoopFeedbackRequestDispatcher` when `process.env.TWILIO_AUTH_TOKEN` is absent, otherwise `SmsFeedbackRequestDispatcher`. The `feedback_send` worker is registered in `workerRegistry`. Pass `dispatcher` into `createJobRouter`.

- [ ] **Step 1: Write the failing test**

The existing decisions test in `packages/api/test/decisions/decisions.test.ts` guards that `/public/feedback/...` is reachable without Clerk auth (D6 invariant: all `/api/*` routes require auth; public routes must not use the `/api/` prefix). Verify this passes after the wiring.

Run: `cd packages/api && npx vitest run test/decisions/`
Expected: PASS (no regression).

- [ ] **Step 2: Implement wiring in `app.ts`**

Follow the existing pattern precisely:
1. `feedbackRequestRepo = pool ? new PgFeedbackRequestRepository(pool) : new InMemoryFeedbackRequestRepository()`
2. `feedbackResponseRepo = pool ? new PgFeedbackResponseRepository(pool) : new InMemoryFeedbackResponseRepository()`
3. Mount `/public/feedback` router before `verifyClerkSession`.
4. Create `dispatcher` — Noop unless Twilio env vars present.
5. Register `feedback_send` worker in `workerRegistry`.
6. Pass `dispatcher` to `createJobRouter`.
7. Mount `GET /api/feedback/responses` inside Clerk-auth block.

- [ ] **Step 3: Run full test suite**

Run: `cd packages/api && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "feat(feedback): wire feedback repos, dispatcher, and worker into app.ts DI assembly"
```

---

## Out of scope

- Email delivery of feedback requests (SMS only for beta, email delivery is a follow-up)
- Automated responses to negative feedback (e.g., auto-scheduling a follow-up call)
- NPS (Net Promoter Score) scoring — only star rating 1–5 is collected
- Review gating: showing customers with low ratings an internal-only feedback form while hiding the Google/Yelp prompt (intentionally excluded — this practice is against Google's review policy)
- Multi-step or branching surveys
- Opt-out / unsubscribe flow for SMS (must be added before production launch per TCPA; tracked as a separate compliance slice)
- Twilio provider implementation (`SmsFeedbackRequestDispatcher` is wired but the HTTP call to Twilio's Messages API is stubbed as a `NoopSmsProvider` until the Twilio plan is in place)
- Analytics beyond average rating and distribution (e.g., trend charts over time, cohort analysis)
- Admin ability to manually trigger or resend a feedback request

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/queues/queue.ts`
- `/home/user/Serviceos/packages/api/src/jobs/job-lifecycle.ts`
- `/home/user/Serviceos/packages/api/src/app.ts`
- `/home/user/Serviceos/packages/api/src/routes/public-feedback.ts`
