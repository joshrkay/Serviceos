# API Design Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Serviceos API into consistent alignment with REST design standards — unified response envelope, schema-validated pagination on all list endpoints, Zod validation at every boundary, and semantically correct HTTP status codes (409, 422, 204) — without breaking the web client.

**Architecture:** Three helper modules (`respond.ts`, `pagination.ts`, a client-side unwrap in `apiFetch`) anchor the refactor. Routes are migrated in waves by file. Breaking status-code changes ship behind a compatibility layer that normalizes responses on the client, so backend and frontend can merge independently. Every task is TDD: write the failing test against the new contract, migrate the route, confirm green.

**Tech Stack:** Express 4 + Zod + Vitest + supertest on the server; React + custom fetch hooks on the web client. No new dependencies.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/shared/respond.ts` | `respond(res, data, status?)` + `respondList(res, data, meta)` helpers — single source of truth for the success envelope. |
| `packages/api/src/shared/pagination.ts` | `paginationQuerySchema` (Zod) + `applyPagination(items, params)` — shared across list routes. |
| `packages/api/test/shared/respond.test.ts` | Unit tests for `respond` and `respondList`. |
| `packages/api/test/shared/pagination.test.ts` | Unit tests for pagination helpers. |

### Modified files (by wave)

**Wave 1 — infrastructure (no behavior change):**
- `packages/web/src/utils/api-fetch.ts` — unwrap `{ data }` envelope; preserve raw shape on non-enveloped responses.
- `packages/web/src/utils/api-fetch.test.ts` — new.
- `packages/api/src/shared/errors.ts` — add `UnprocessableEntityError` class.

**Wave 2 — envelope migration (high-churn routes first):**
- `packages/api/src/routes/files.ts` — worst offender (ad-hoc `{ fileId, uploadUrl, ... }` shape).
- `packages/api/src/routes/quality.ts` — ad-hoc `{ message: '...' }` shape.
- `packages/api/src/proposals/routes.ts` — already uses `{ data, total }`, standardize to `{ data, meta }`.
- Then: customers, jobs, appointments, estimates, invoices, payments, notes, conversations, locations, settings, pack-activation, verticals, templates, bundles, voice, assistant (16 files, mechanical).

**Wave 3 — pagination:**
- `packages/api/src/routes/customers.ts`, `jobs.ts`, `appointments.ts`, `estimates.ts`, `invoices.ts`, `notes.ts`, `files.ts`, `conversations.ts` — accept `limit`/`offset`/`cursor`, return `meta: { total, limit, offset }`.
- Corresponding tests in `packages/api/test/routes/*.route.test.ts`.

**Wave 4 — validation cleanup:**
- `packages/api/src/routes/appointments.ts:58-62` — replace `if (!jobId)` with Zod query schema.
- `packages/api/src/routes/notes.ts` — replace manual `if (!content)` check.
- `packages/api/src/routes/files.ts:46-51` — migrate `validateUpload()` to Zod.
- `packages/api/src/shared/contracts.ts` — add missing query schemas.

**Wave 5 — semantic status codes:**
- `packages/api/src/routes/customers.ts:116` — `POST /:id/archive` → `DELETE /:id` returning 204.
- All state-transition handlers (estimates/invoices/jobs `*/transition`) — throw `ConflictError` on invalid transitions (409), `UnprocessableEntityError` on semantic failures (422).
- `packages/web/src/**` — update clients that call the archive endpoint.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Infrastructure

### Task 1: Add `respond()` and `respondList()` helpers with tests

**Files:**
- Create: `packages/api/src/shared/respond.ts`
- Create: `packages/api/test/shared/respond.test.ts`

**Context:** Every current route calls `res.status(x).json(raw)` with inconsistent shapes (`raw`, `{ fileId, ... }`, `{ message: '...' }`, `{ data, total }`). These helpers become the single success contract, mirroring what `toErrorResponse` already does for errors. List responses use `{ data, meta: { total, limit, offset } }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/shared/respond.test.ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { respond, respondList } from '../../src/shared/respond';

describe('respond', () => {
  it('wraps scalar/object data in { data } with default 200', async () => {
    const app = express();
    app.get('/t', (_req, res) => respond(res, { id: 'abc', name: 'Alice' }));
    const r = await request(app).get('/t');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { id: 'abc', name: 'Alice' } });
  });

  it('honors explicit status code (e.g. 201 for create)', async () => {
    const app = express();
    app.post('/t', (_req, res) => respond(res, { id: 'abc' }, 201));
    const r = await request(app).post('/t');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ data: { id: 'abc' } });
  });

  it('returns 204 with no body when data is null', async () => {
    const app = express();
    app.delete('/t', (_req, res) => respond(res, null, 204));
    const r = await request(app).delete('/t');
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
  });
});

describe('respondList', () => {
  it('wraps arrays in { data, meta } with total/limit/offset', async () => {
    const app = express();
    app.get('/t', (_req, res) =>
      respondList(res, [{ id: '1' }, { id: '2' }], { total: 42, limit: 20, offset: 0 })
    );
    const r = await request(app).get('/t');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      data: [{ id: '1' }, { id: '2' }],
      meta: { total: 42, limit: 20, offset: 0 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/shared/respond.test.ts`
Expected: FAIL with "Cannot find module '../../src/shared/respond'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/api/src/shared/respond.ts
import type { Response } from 'express';

export interface ListMeta {
  total: number;
  limit: number;
  offset: number;
}

export function respond<T>(res: Response, data: T, status = 200): void {
  if (status === 204 || data === null) {
    res.status(204).end();
    return;
  }
  res.status(status).json({ data });
}

export function respondList<T>(res: Response, data: readonly T[], meta: ListMeta): void {
  res.status(200).json({ data, meta });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/shared/respond.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/shared/respond.ts packages/api/test/shared/respond.test.ts
git commit -m "feat(api): add respond/respondList envelope helpers"
```

---

### Task 2: Add pagination schema and `applyPagination` helper with tests

**Files:**
- Create: `packages/api/src/shared/pagination.ts`
- Create: `packages/api/test/shared/pagination.test.ts`

**Context:** Today, list routes either ignore pagination or hardcode it (`proposals/routes.ts:33` — `limit = 20`). This helper parses `limit`/`offset` from query params with Zod (coerces strings to numbers, enforces max 100), and slices an in-memory array. Repository-level DB pagination comes later route-by-route; this is the query contract.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/shared/pagination.test.ts
import { describe, it, expect } from 'vitest';
import { paginationQuerySchema, applyPagination } from '../../src/shared/pagination';

describe('paginationQuerySchema', () => {
  it('parses string query params into numbers', () => {
    expect(paginationQuerySchema.parse({ limit: '25', offset: '50' })).toEqual({
      limit: 25,
      offset: 50,
    });
  });

  it('applies defaults when params are absent', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it('clamps limit to max 100', () => {
    expect(() => paginationQuerySchema.parse({ limit: '500' })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => paginationQuerySchema.parse({ offset: '-1' })).toThrow();
  });
});

describe('applyPagination', () => {
  it('returns sliced page and meta', () => {
    const items = Array.from({ length: 55 }, (_, i) => ({ id: String(i) }));
    const { data, meta } = applyPagination(items, { limit: 20, offset: 40 });
    expect(data).toHaveLength(15);
    expect(data[0]?.id).toBe('40');
    expect(meta).toEqual({ total: 55, limit: 20, offset: 40 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/shared/pagination.test.ts`
Expected: FAIL with "Cannot find module '../../src/shared/pagination'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/api/src/shared/pagination.ts
import { z } from 'zod';
import type { ListMeta } from './respond';

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function applyPagination<T>(
  items: readonly T[],
  params: PaginationQuery
): { data: T[]; meta: ListMeta } {
  const { limit, offset } = params;
  return {
    data: items.slice(offset, offset + limit),
    meta: { total: items.length, limit, offset },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/shared/pagination.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/shared/pagination.ts packages/api/test/shared/pagination.test.ts
git commit -m "feat(api): add pagination query schema + applyPagination helper"
```

---

### Task 3: Add `UnprocessableEntityError` class

**Files:**
- Modify: `packages/api/src/shared/errors.ts`

**Context:** Today `ValidationError` returns 400 for both "malformed JSON" and "valid JSON, bad business rule". REST convention uses 422 for the latter. Adding a distinct class lets state-transition handlers throw `UnprocessableEntityError` instead of `ValidationError` without touching `toErrorResponse`.

- [ ] **Step 1: Write the failing test**

Add to `packages/api/test/shared/errors.test.ts` (create if missing):

```typescript
import { describe, it, expect } from 'vitest';
import { UnprocessableEntityError, toErrorResponse } from '../../src/shared/errors';

describe('UnprocessableEntityError', () => {
  it('maps to 422 with UNPROCESSABLE_ENTITY code', () => {
    const err = new UnprocessableEntityError('Customer already archived');
    const { statusCode, body } = toErrorResponse(err);
    expect(statusCode).toBe(422);
    expect(body).toMatchObject({
      error: 'UNPROCESSABLE_ENTITY',
      message: 'Customer already archived',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/shared/errors.test.ts`
Expected: FAIL with "UnprocessableEntityError is not exported"

- [ ] **Step 3: Add the class**

Insert after `ConflictError` at `packages/api/src/shared/errors.ts:46`:

```typescript
export class UnprocessableEntityError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('UNPROCESSABLE_ENTITY', message, 422, details);
    this.name = 'UnprocessableEntityError';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/shared/errors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/shared/errors.ts packages/api/test/shared/errors.test.ts
git commit -m "feat(api): add UnprocessableEntityError (422) for semantic failures"
```

---

### Task 4: Unwrap `{ data }` envelope in client `apiFetch`

**Files:**
- Modify: `packages/web/src/utils/api-fetch.ts`
- Create: `packages/web/src/utils/api-fetch.test.ts`

**Context:** `useListQuery.ts:52` already tolerates both shapes with `result.data ?? result`. But `useDetailQuery.ts:27` and `useMutation.ts:26` return the raw body. Rather than patch every hook, we intercept `.json()` at the fetch layer: if the parsed body is `{ data }` (envelope) OR `{ data, meta }` (list envelope), unwrap to the inner `data`. This keeps the unwrap backward-compatible and avoids touching N consumer sites. Error bodies (`{ error, message }`) are left untouched because error responses are surfaced via `!response.ok`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/utils/api-fetch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from './api-fetch';

describe('apiFetch envelope unwrap', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps { data } responses transparently', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'abc', name: 'Alice' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await apiFetch('/api/customers/abc');
    const body = await res.json();
    expect(body).toEqual({ id: 'abc', name: 'Alice' });
  });

  it('passes list envelope through with meta preserved', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: '1' }], meta: { total: 1, limit: 20, offset: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await apiFetch('/api/customers');
    const body = await res.json();
    // List envelope is preserved so useListQuery can read total/pagination
    expect(body).toEqual({ data: [{ id: '1' }], meta: { total: 1, limit: 20, offset: 0 } });
  });

  it('leaves non-enveloped responses untouched (backward compat)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ id: 'abc', name: 'Legacy' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await apiFetch('/api/legacy');
    const body = await res.json();
    expect(body).toEqual({ id: 'abc', name: 'Legacy' });
  });

  it('leaves error bodies untouched', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'x' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await apiFetch('/api/customers/bad');
    const body = await res.json();
    expect(body).toEqual({ error: 'NOT_FOUND', message: 'x' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/utils/api-fetch.test.ts`
Expected: FAIL — tests expect unwrap behavior, current impl just returns `fetch` result.

- [ ] **Step 3: Wrap fetch to unwrap envelopes**

Replace the body of `apiFetch` in `packages/web/src/utils/api-fetch.ts` after the `return fetch(...)` call:

```typescript
// packages/web/src/utils/api-fetch.ts
let getToken: (() => Promise<string | null>) | null = null;

export function setTokenGetter(fn: () => Promise<string | null>) {
  getToken = fn;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = getToken ? await getToken() : null;

  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (init.body && !(init.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const response = await fetch(input, { ...init, headers });
  return wrapJson(response);
}

function wrapJson(response: Response): Response {
  if (!response.ok) return response;
  const originalJson = response.json.bind(response);
  response.json = async () => {
    const body = await originalJson();
    if (isDetailEnvelope(body)) return body.data;
    return body;
  };
  return response;
}

function isDetailEnvelope(body: unknown): body is { data: unknown } {
  if (!body || typeof body !== 'object') return false;
  const keys = Object.keys(body);
  // Only detail envelopes are { data }. List envelopes have { data, meta }
  // and are preserved so list hooks can read meta.
  return keys.length === 1 && keys[0] === 'data';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && npx vitest run src/utils/api-fetch.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full web test suite to catch regressions**

Run: `cd packages/web && npx vitest run`
Expected: All tests green. If any fail, the fixture likely returns a raw body AND the test expects the raw body — these tests are already correct for the legacy shape (preserved branch).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/utils/api-fetch.ts packages/web/src/utils/api-fetch.test.ts
git commit -m "feat(web): transparently unwrap { data } envelope in apiFetch"
```

---

## Phase 2: Envelope Migration (routes → respond/respondList)

### Task 5: Migrate `files.ts` to respond envelope

**Files:**
- Modify: `packages/api/src/routes/files.ts:79-84, 119, 149-154, 188-192`
- Modify: `packages/api/test/routes/files.route.test.ts`

**Context:** `files.ts:79` returns `{ fileId, uploadUrl, downloadUrl, fileRecord }` — the worst shape violation. After this task it returns `{ data: { fileId, uploadUrl, downloadUrl, fileRecord } }`. The existing test is updated to read `res.body.data`.

- [ ] **Step 1: Write the failing test (update existing)**

In `packages/api/test/routes/files.route.test.ts`, update the upload happy-path assertion to expect the envelope:

```typescript
// Example shape — edit the matching existing test
it('returns 201 with data envelope containing fileId, uploadUrl, fileRecord', async () => {
  const res = await request(app).post('/api/files/upload-url').send({
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
  });
  expect(res.status).toBe(201);
  expect(res.body).toHaveProperty('data');
  expect(res.body.data).toMatchObject({
    fileId: expect.any(String),
    uploadUrl: expect.any(String),
    downloadUrl: expect.any(String),
    fileRecord: expect.objectContaining({ filename: 'photo.jpg' }),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/files.route.test.ts`
Expected: FAIL — current response is flat, `res.body.data` is undefined.

- [ ] **Step 3: Migrate route handlers**

In `packages/api/src/routes/files.ts`, import and use `respond`:

```typescript
// Top of file, add:
import { respond } from '../shared/respond';

// files.ts:79 — replace the res.status(201).json({...}) with:
respond(res, { fileId: saved.id, uploadUrl, downloadUrl, fileRecord: saved }, 201);

// files.ts:119 — replace res.json(record) with:
respond(res, record);

// files.ts:149 — replace res.status(200).json({ fileRecord: record, verified: false, reason: ... })
respond(res, { fileRecord: record, verified: false, reason: 'metadata_unavailable' });

// files.ts:188 — replace res.status(200).json({ fileRecord: updated ?? record, verified: true, ... })
respond(res, { fileRecord: updated ?? record, verified: true, actualSizeBytes: metadata.contentLength });
```

Also replace inline 404 JSON at `files.ts:116` and `files.ts:142`:

```typescript
// files.ts:116 (GET /:id not found)
throw new NotFoundError('File', req.params.id);
// Add to imports:
// import { AppError, NotFoundError, toErrorResponse } from '../shared/errors';

// Same at files.ts:142
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/files.route.test.ts`
Expected: PASS (all existing + updated tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/files.ts packages/api/test/routes/files.route.test.ts
git commit -m "refactor(api): migrate files routes to { data } envelope"
```

---

### Task 6: Migrate `quality.ts` to respond envelope

**Files:**
- Modify: `packages/api/src/routes/quality.ts:97, 100, 118+`
- Modify: `packages/api/test/routes/quality.route.test.ts`

**Context:** `quality.ts:97` returns `{ message: 'No metrics available yet' }` — an ad-hoc sentinel. After migration, this returns `{ data: null }` (meaning "no metrics") and the handler documents the semantics. The beta-readiness block at `:118+` also needs the envelope.

- [ ] **Step 1: Write the failing test**

Update existing test in `packages/api/test/routes/quality.route.test.ts`:

```typescript
it('returns { data: null } when no metrics exist', async () => {
  const res = await request(app).get('/api/quality/metrics');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ data: null });
});

it('returns { data: metrics } when metrics exist', async () => {
  // seed metrics, then...
  const res = await request(app).get('/api/quality/metrics');
  expect(res.body.data).toMatchObject({ /* ... */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/quality.route.test.ts`
Expected: FAIL — body currently has `message` not `data`.

- [ ] **Step 3: Migrate handlers**

```typescript
// quality.ts:95-100 — replace:
if (!metrics) {
  respond(res, null);  // 204-equivalent semantics: null data means "none yet"
  return;
}
respond(res, metrics);

// quality.ts:117+ — wrap the beta-readiness payload:
respond(res, { isReady: false, /* ... */ });
```

Add import: `import { respond } from '../shared/respond';`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/quality.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/quality.ts packages/api/test/routes/quality.route.test.ts
git commit -m "refactor(api): migrate quality routes to { data } envelope"
```

---

### Task 7: Migrate proposals routes to `respondList` envelope

**Files:**
- Modify: `packages/api/src/proposals/routes.ts:30-36`
- Modify: `packages/api/test/proposals/*.test.ts`

**Context:** `proposals/routes.ts` returns `{ data, total }` — close to standard but uses a top-level `total` rather than nested `meta.total`. Align to `{ data, meta: { total, limit, offset } }`. Pagination already works here; just rewrap.

- [ ] **Step 1: Write the failing test**

Update proposals list test to expect `meta`:

```typescript
it('returns { data, meta: { total, limit, offset } } for list', async () => {
  const result = await listProposals(proposalRepo, tenantId, { limit: 10, offset: 0 }, 'owner');
  expect(result).toMatchObject({
    data: expect.any(Array),
    meta: { total: expect.any(Number), limit: 10, offset: 0 },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/proposals/`
Expected: FAIL — `total` is top-level, not nested.

- [ ] **Step 3: Update `listProposals` return shape**

```typescript
// packages/api/src/proposals/routes.ts:30-36 — replace:
const total = proposals.length;
const offset = validFilter.offset ?? 0;
const limit = validFilter.limit ?? 20;
const data = proposals.slice(offset, offset + limit);

return { data, meta: { total, limit, offset } };
```

Update the return type signature on line 12:

```typescript
): Promise<{ data: Proposal[]; meta: { total: number; limit: number; offset: number } }> {
```

- [ ] **Step 4: Update callers**

Find and update any caller of `listProposals` that reads `.total`:

Run: `Grep pattern: 'listProposals'` — if any caller does `result.total`, change to `result.meta.total`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/proposals/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/proposals/routes.ts packages/api/test/proposals/
git commit -m "refactor(api): align proposals list shape to { data, meta }"
```

---

### Task 8: Migrate remaining 15 route files to envelope

**Files:** (apply the same pattern mechanically)
- Modify: `packages/api/src/routes/customers.ts, jobs.ts, appointments.ts, estimates.ts, invoices.ts, payments.ts, notes.ts, conversations.ts, locations.ts, settings.ts, pack-activation.ts, verticals.ts, templates.ts, bundles.ts, voice.ts, assistant.ts`
- Modify: `packages/api/test/routes/*.route.test.ts` — update assertions to read `res.body.data`.

**Context:** The transformation is identical in every file: import `respond`/`respondList`, replace `res.status(x).json(result)` with `respond(res, result, x)`, replace `res.json(list)` with `respondList(res, list, meta)` where applicable. 404 branches throw `NotFoundError` instead of inline JSON. This task is mechanical but large — do one file per sub-commit so reverts stay surgical.

- [ ] **Step 1: Pick a file (start with `customers.ts`). Update its route tests first.**

Edit `packages/api/test/routes/customers.route.test.ts` — change every `expect(res.body.foo)` into `expect(res.body.data.foo)` for create/get/update responses. Example at `customers.route.test.ts:36-44`:

```typescript
expect(res.status).toBe(201);
const cust = res.body.data;          // was: res.body
expect(typeof cust.id).toBe('string');
expect(cust.firstName).toBe('Alice');
// ... etc
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/customers.route.test.ts`
Expected: FAIL — `res.body.data` is undefined.

- [ ] **Step 3: Migrate the route file**

Edit `packages/api/src/routes/customers.ts`:

```typescript
// Top of file
import { respond, respondList } from '../shared/respond';
import { NotFoundError } from '../shared/errors';  // if not already

// customers.ts:40 — replace res.status(201).json(result) with:
respond(res, result, 201);

// customers.ts:61 — replace res.json(result) with:
respondList(res, result, { total: result.length, limit: result.length, offset: 0 });
// NOTE: pagination comes in Task 10. Until then, echo the array length as total.

// customers.ts:78-79, 105-106, 131-132 — replace inline 404 JSON with:
throw new NotFoundError('Customer', req.params.id);

// customers.ts:81, 108, 134 — replace res.json(result) with:
respond(res, result);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/customers.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit customers migration**

```bash
git add packages/api/src/routes/customers.ts packages/api/test/routes/customers.route.test.ts
git commit -m "refactor(api): migrate customers routes to envelope"
```

- [ ] **Step 6: Repeat steps 1–5 for each remaining file**

Apply to: `jobs.ts`, `appointments.ts`, `estimates.ts`, `invoices.ts`, `payments.ts`, `notes.ts`, `conversations.ts`, `locations.ts`, `settings.ts`, `pack-activation.ts`, `verticals.ts`, `templates.ts`, `bundles.ts`, `voice.ts`, `assistant.ts`.

One commit per file, commit message `refactor(api): migrate <name> routes to envelope`.

- [ ] **Step 7: Run full API test suite**

Run: `cd packages/api && npx vitest run`
Expected: All green.

- [ ] **Step 8: Run full web test suite (client unwrap exercised here)**

Run: `cd packages/web && npx vitest run`
Expected: All green. If any component test fails, the component is reading an envelope field directly (e.g. `res.data`) instead of using `apiFetch`. Fix by routing through `apiFetch` or by reading `.data` locally.

- [ ] **Step 9: Verify build**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: Zero errors.

---

## Phase 3: Pagination on List Endpoints

### Task 9: Add pagination to `GET /api/customers` (reference implementation)

**Files:**
- Modify: `packages/api/src/customers/customer.ts` (`listCustomers` signature)
- Modify: `packages/api/src/routes/customers.ts:48-67`
- Modify: `packages/api/test/routes/customers.route.test.ts`
- Modify: `packages/api/src/customers/pg-customer.ts` — add LIMIT/OFFSET to SQL.

**Context:** `listCustomers` currently returns the full tenant's customer list in memory. Update the domain function to accept `{ limit, offset }` and return `{ data, total }`; the route parses the query with `paginationQuerySchema` and wraps in `respondList`. This task establishes the pattern; Task 10 applies it to the rest.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/customers.route.test.ts
describe('GET /api/customers with pagination', () => {
  it('returns { data, meta: { total, limit, offset } }', async () => {
    for (let i = 0; i < 30; i++) {
      await request(app).post('/api/customers').send({
        firstName: `User${i}`, lastName: 'Test', primaryPhone: '555-0000',
      });
    }
    const res = await request(app).get('/api/customers?limit=10&offset=5');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.meta).toEqual({ total: 30, limit: 10, offset: 5 });
  });

  it('uses default limit=20 offset=0 when omitted', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.body.meta).toMatchObject({ limit: 20, offset: 0 });
  });

  it('rejects limit > 100 with 400', async () => {
    const res = await request(app).get('/api/customers?limit=500');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/customers.route.test.ts`
Expected: FAIL — meta shape wrong, defaults not applied.

- [ ] **Step 3: Update the domain function**

In `packages/api/src/customers/customer.ts`, update `listCustomers`:

```typescript
// Before: listCustomers(tenantId, repo, { includeArchived, search }): Promise<Customer[]>
// After:
export interface ListCustomersOptions {
  includeArchived?: boolean;
  search?: string;
  limit: number;
  offset: number;
}
export async function listCustomers(
  tenantId: string,
  repo: CustomerRepository,
  opts: ListCustomersOptions
): Promise<{ data: Customer[]; total: number }> {
  const all = await repo.list(tenantId, { includeArchived: opts.includeArchived, search: opts.search });
  return {
    data: all.slice(opts.offset, opts.offset + opts.limit),
    total: all.length,
  };
}
```

Note: in-memory pagination is fine for now; `PgCustomerRepository.list` should later push LIMIT/OFFSET into SQL (track in a follow-up story).

- [ ] **Step 4: Update the route**

In `packages/api/src/routes/customers.ts:48-67`:

```typescript
import { paginationQuerySchema } from '../shared/pagination';
import { respond, respondList } from '../shared/respond';

router.get(
  '/',
  requireAuth, requireTenant, requirePermission('customers:view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const pagination = paginationQuerySchema.parse(req.query);
      const includeArchived = req.query.includeArchived === 'true';
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const { data, total } = await listCustomers(req.auth!.tenantId, customerRepo, {
        includeArchived, search, ...pagination,
      });
      respondList(res, data, { total, limit: pagination.limit, offset: pagination.offset });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  }
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/customers.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/customers.ts packages/api/src/customers/customer.ts packages/api/test/routes/customers.route.test.ts
git commit -m "feat(api): add limit/offset pagination to GET /api/customers"
```

---

### Task 10: Apply pagination pattern to remaining list endpoints

**Files:**
- Modify: `packages/api/src/routes/jobs.ts, appointments.ts, estimates.ts, invoices.ts, notes.ts, files.ts, conversations.ts`
- Modify: corresponding `src/<domain>/*.ts` `list*` functions
- Modify: corresponding route tests

**Context:** Repeat Task 9's pattern for each list endpoint. One commit per file.

- [ ] **Step 1: For each file above, write a pagination test analogous to Task 9 step 1**

Example for jobs:

```typescript
describe('GET /api/jobs with pagination', () => {
  it('returns { data, meta } with limit=20 offset=0 defaults', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.body.meta).toMatchObject({ limit: 20, offset: 0, total: expect.any(Number) });
  });
});
```

- [ ] **Step 2: Run tests, verify red, implement, verify green, commit**

Run per file: `cd packages/api && npx vitest run test/routes/<file>.route.test.ts`

Commit message template: `feat(api): add pagination to GET /api/<resource>`

---

## Phase 4: Validation Cleanup

### Task 11: Replace manual `if (!jobId)` in appointments with Zod query schema

**Files:**
- Modify: `packages/api/src/shared/contracts.ts` — add `listAppointmentsQuerySchema`
- Modify: `packages/api/src/routes/appointments.ts:56-64`
- Modify: `packages/api/test/routes/appointments.route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('rejects missing jobId with 400 VALIDATION_ERROR (not raw string)', async () => {
  const res = await request(app).get('/api/appointments');
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('VALIDATION_ERROR');
  expect(res.body.details).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/appointments.route.test.ts`
Expected: FAIL — `details` missing.

- [ ] **Step 3: Add schema and update route**

In `packages/api/src/shared/contracts.ts`:

```typescript
export const listAppointmentsQuerySchema = z.object({
  jobId: z.string().min(1),
});
```

In `packages/api/src/routes/appointments.ts:56-64`:

```typescript
import { listAppointmentsQuerySchema } from '../shared/contracts';
// ...
const { jobId } = listAppointmentsQuerySchema.parse(req.query);
const result = await listByJob(req.auth!.tenantId, jobId, appointmentRepo);
respondList(res, result, { total: result.length, limit: result.length, offset: 0 });
// (Zod throws ValidationError on failure, caught by existing try/catch path.)
```

Remove the `if (!jobId)` block.

Ensure `ZodError` maps to `VALIDATION_ERROR` with details. Check `packages/api/src/shared/errors.ts` `toErrorResponse`; if `ZodError` isn't mapped, add:

```typescript
import { ZodError } from 'zod';

// In toErrorResponse, before the AppError check:
if (err instanceof ZodError) {
  return {
    statusCode: 400,
    body: {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: { issues: err.issues },
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/appointments.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/appointments.ts packages/api/src/shared/contracts.ts packages/api/src/shared/errors.ts packages/api/test/routes/appointments.route.test.ts
git commit -m "refactor(api): validate appointments list query with Zod"
```

---

### Task 12: Replace manual validation in `notes.ts` and `files.ts`

**Files:**
- Modify: `packages/api/src/routes/notes.ts` — replace `if (!content)` with Zod.
- Modify: `packages/api/src/routes/files.ts:47-51` — swap `validateUpload()` for a Zod schema.
- Modify: `packages/api/src/shared/contracts.ts` — add `uploadFileSchema`.

**Context:** `files.ts:47` calls `validateUpload()` that returns an array of error strings. Replace with a Zod schema and let `toErrorResponse` handle ZodError → 400 uniformly.

- [ ] **Step 1: Write the failing test for files**

```typescript
it('rejects oversized file with 400 VALIDATION_ERROR + details', async () => {
  const res = await request(app).post('/api/files/upload-url').send({
    filename: 'big.mp4',
    contentType: 'video/mp4',
    sizeBytes: 999_999_999_999,
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('VALIDATION_ERROR');
  expect(res.body.details).toBeDefined();
});
```

- [ ] **Step 2: Run test, verify failure expectations match current behavior**

Run: `cd packages/api && npx vitest run test/routes/files.route.test.ts`
Expected: likely passes for 400 but details shape differs — inspect and adjust.

- [ ] **Step 3: Add schema**

In `packages/api/src/shared/contracts.ts`:

```typescript
import { MAX_FILE_SIZE } from '../files/file-service';

export const uploadFileSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.coerce.number().int().min(1).max(MAX_FILE_SIZE),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});
```

- [ ] **Step 4: Update `files.ts` upload handler**

In `packages/api/src/routes/files.ts:35-53`:

```typescript
import { uploadFileSchema } from '../shared/contracts';

const uploadHandler = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = uploadFileSchema.parse(req.body ?? {});
    const uploadRequest: UploadRequest = {
      tenantId: req.auth!.tenantId,
      uploadedBy: req.auth!.userId,
      ...parsed,
    };
    // ... rest unchanged, remove validateUpload() call
```

- [ ] **Step 5: Repeat for `notes.ts` — replace any `if (!content)` with schema enforcement.**

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/files.route.test.ts test/routes/notes.route.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/files.ts packages/api/src/routes/notes.ts packages/api/src/shared/contracts.ts packages/api/test/routes/
git commit -m "refactor(api): replace manual validation with Zod in files/notes"
```

---

## Phase 5: Semantic Status Codes

### Task 13: Rename `POST /api/customers/:id/archive` → `DELETE /api/customers/:id` (returns 204)

**Files:**
- Modify: `packages/api/src/routes/customers.ts:116-140`
- Modify: `packages/api/test/routes/customers.route.test.ts`
- Modify: any web client that calls archive — search with Grep.

**Context:** `POST /:id/archive` is an action URL — should be `DELETE /:id` returning 204 when archive is a soft delete. Keep the old route for one release cycle to avoid breaking any in-flight client deploys (add a `Sunset` header).

- [ ] **Step 1: Find web callers**

Run: `Grep pattern: '/archive' path: packages/web/src` — note every file that posts to `/archive`.

- [ ] **Step 2: Write failing tests**

```typescript
describe('DELETE /api/customers/:id', () => {
  it('returns 204 with empty body on successful archive', async () => {
    const create = await request(app).post('/api/customers').send({
      firstName: 'Del', lastName: 'Ete', primaryPhone: '555-1111',
    });
    const id = create.body.data.id;
    const res = await request(app).delete(`/api/customers/${id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('returns 404 on unknown id', async () => {
    const res = await request(app).delete('/api/customers/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});

describe('POST /api/customers/:id/archive (deprecated)', () => {
  it('still works and sets Sunset header', async () => {
    const create = await request(app).post('/api/customers').send({ /* ... */ });
    const id = create.body.data.id;
    const res = await request(app).post(`/api/customers/${id}/archive`);
    expect(res.status).toBe(204);
    expect(res.headers.sunset).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/customers.route.test.ts`
Expected: FAIL — no DELETE route.

- [ ] **Step 4: Add DELETE handler, keep POST as deprecation shim**

In `packages/api/src/routes/customers.ts`, replace the archive handler block with:

```typescript
const archiveHandler = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await archiveCustomer(
      req.auth!.tenantId, req.params.id, customerRepo, req.auth!.userId, auditRepo
    );
    if (!result) throw new NotFoundError('Customer', req.params.id);
    respond(res, null, 204);
  } catch (err) {
    const { statusCode, body } = toErrorResponse(err);
    res.status(statusCode).json(body);
  }
};

router.delete(
  '/:id',
  requireAuth, requireTenant, requirePermission('customers:delete'),
  archiveHandler
);

// Deprecated — remove after 2026-07-01 sunset
router.post(
  '/:id/archive',
  requireAuth, requireTenant, requirePermission('customers:delete'),
  async (req: AuthenticatedRequest, res: Response, next) => {
    res.setHeader('Sunset', 'Wed, 01 Jul 2026 00:00:00 GMT');
    res.setHeader('Deprecation', 'true');
    return archiveHandler(req, res);
  }
);
```

- [ ] **Step 5: Update web callers to use DELETE**

For each file from Step 1, change `apiFetch('/api/customers/${id}/archive', { method: 'POST' })` to `apiFetch('/api/customers/${id}', { method: 'DELETE' })`. Update tests accordingly.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/customers.route.test.ts && cd ../web && npx vitest run`
Expected: PASS on both sides.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/customers.ts packages/api/test/routes/customers.route.test.ts packages/web/src
git commit -m "feat(api): expose DELETE /api/customers/:id (204); deprecate POST /archive"
```

---

### Task 14: Use 409 for invalid state transitions, 422 for semantic failures

**Files:**
- Modify: `packages/api/src/estimates/estimate.ts` (and/or `routes/estimates.ts`) — transition handlers
- Modify: `packages/api/src/invoices/invoice.ts`
- Modify: `packages/api/src/jobs/job-lifecycle.ts`
- Corresponding test files.

**Context:** Today, transitioning an already-approved estimate to `DRAFT` probably throws `ValidationError` (400) or an untyped `Error` (500). The domain should throw `ConflictError` ("cannot transition from APPROVED to DRAFT") — that's already 409 in `toErrorResponse`. Semantic rule failures (e.g. "invoice total must be > 0") should throw `UnprocessableEntityError` (422, added in Task 3).

- [ ] **Step 1: Write failing tests**

```typescript
// estimates.route.test.ts
it('returns 409 CONFLICT when transitioning APPROVED -> DRAFT', async () => {
  const created = await request(app).post('/api/estimates').send({ /* ... */ });
  const id = created.body.data.id;
  await request(app).post(`/api/estimates/${id}/transition`).send({ state: 'approved' });
  const res = await request(app).post(`/api/estimates/${id}/transition`).send({ state: 'draft' });
  expect(res.status).toBe(409);
  expect(res.body.error).toBe('CONFLICT');
});

it('returns 422 UNPROCESSABLE_ENTITY when submitting an empty estimate', async () => {
  const created = await request(app).post('/api/estimates').send({ /* lineItems: [] */ });
  const id = created.body.data.id;
  const res = await request(app).post(`/api/estimates/${id}/transition`).send({ state: 'approved' });
  expect(res.status).toBe(422);
  expect(res.body.error).toBe('UNPROCESSABLE_ENTITY');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/estimates.route.test.ts`
Expected: FAIL — current code likely returns 400 or 500.

- [ ] **Step 3: Update the transition logic**

In `packages/api/src/estimates/estimate.ts` (or the lifecycle module — Grep for the transition function):

```typescript
import { ConflictError, UnprocessableEntityError } from '../shared/errors';

export function transitionEstimate(current: Estimate, next: EstimateState): Estimate {
  if (!isValidTransition(current.state, next)) {
    throw new ConflictError(
      `Cannot transition estimate from ${current.state} to ${next}`
    );
  }
  if (next === 'approved' && current.lineItems.length === 0) {
    throw new UnprocessableEntityError('Cannot approve an empty estimate');
  }
  return { ...current, state: next };
}
```

Replicate in `invoices` and `jobs` lifecycle modules.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run test/routes/estimates.route.test.ts test/routes/invoices.route.test.ts test/routes/jobs.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/estimates packages/api/src/invoices packages/api/src/jobs packages/api/test/routes/
git commit -m "feat(api): use 409 CONFLICT + 422 UNPROCESSABLE_ENTITY for state transitions"
```

---

## Phase 6: Verification

### Task 15: Full verification pass

- [ ] **Step 1: Full API test suite**

Run: `cd packages/api && npx vitest run`
Expected: All green.

- [ ] **Step 2: Full web test suite**

Run: `cd packages/web && npx vitest run`
Expected: All green.

- [ ] **Step 3: Production build check (CLAUDE.md mandate)**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: Zero errors.

- [ ] **Step 4: Manual smoke test of web app against migrated API**

Run the API locally, navigate to the customer list, create a customer, archive it via DELETE, confirm the list reflects the change. Spot-check jobs, estimates, invoices.

- [ ] **Step 5: Update OpenAPI spec**

Edit `packages/api/src/swagger/spec.ts` — update list endpoint schemas to reference `{ data, meta }`, detail endpoints to reference `{ data }`.

- [ ] **Step 6: Final commit**

```bash
git add packages/api/src/swagger/spec.ts
git commit -m "docs(api): update OpenAPI spec for envelope + pagination"
```

---

## Self-Review Notes

**Spec coverage vs audit punch list:**
| Audit finding | Task(s) |
|---|---|
| No pagination on list endpoints (critical) | 2, 9, 10 |
| Response envelope drift (critical) | 1, 4, 5–8 |
| Hardcoded pagination in proposals (critical) | 7, applied via 9/10 pattern |
| Missing 409 Conflict on invalid transitions (high) | 14 |
| Manual validation instead of Zod (high) | 11, 12 |
| `POST /:id/archive` → `DELETE /:id` (high) | 13 |
| 422 vs 400 distinction (medium) | 3, 14 |
| Action routes use 200 (medium) | 13 (DELETE returns 204), 14 (transitions documented) |

**Risks:**
1. Task 8 touches 15 files — highest rebase surface. Do it on a dedicated branch; merge fast.
2. Task 4 (client unwrap) is the load-bearing piece that decouples server migration from breaking the client. Land it FIRST and verify with the full web test suite before any route migration.
3. The deprecation shim in Task 13 needs a reminder: add a TODO commit with a sunset date (2026-07-01) and delete the shim after.

**Not in scope (deliberate):**
- Cursor-based pagination (offset is fine for current dataset sizes; upgrade when any resource crosses ~10k rows).
- URL versioning to `/api/v1/` (no external consumers yet; premature).
- Field-level sparse fieldsets / `include` expansion (no reported need).
- Rate-limit-per-user (current IP-based limit is sufficient for the current auth model).
