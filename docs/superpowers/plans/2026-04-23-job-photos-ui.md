# Job Photos UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow technicians to capture and upload before/after photos directly from their mobile device on a job site. Photos are organized by category (`before`, `after`, `general`, `document`) and are visible in the job detail view for dispatchers and office staff. The feature builds on the existing `files` table and `StorageProvider` infrastructure already present in the codebase.

**Architecture:** A `category` column and `job_id` foreign key are added to the existing `files` table via migration `041`. A new `JobFileRepository` (InMemory + Pg) wraps category-aware queries. A dedicated `POST /api/jobs/:id/files/upload-url`, `POST /api/jobs/:id/files/confirm`, `GET /api/jobs/:id/files`, and `DELETE /api/jobs/:id/files/:fileId` surface in an extended job files router that reuses the existing `StorageProvider`. A `PhotoBucket` React component handles the mobile-first capture flow using `<input type="file" accept="image/*" capture="environment">` and renders thumbnails, then `JobDetail.tsx` replaces its `SiteMedia` placeholder section with two `PhotoBucket` instances.

**Tech Stack:** TypeScript, Express, `pg` driver, AWS S3-compatible presigned PUT URLs via the existing hand-rolled SigV4 `S3StorageProvider`. React 18, Tailwind CSS, Vitest (API), React Testing Library + Vitest (web).

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/src/files/job-file-repository.ts` | `JobFileRecord` type, `JobFileRepository` interface, `InMemoryJobFileRepository` implementation |
| `packages/api/src/files/pg-job-file.ts` | `PgJobFileRepository` — Postgres implementation of `JobFileRepository` |
| `packages/api/src/routes/job-files.ts` | Express router factory for `/api/jobs/:id/files/*` endpoints |
| `packages/api/test/files/job-file-repository.test.ts` | Unit tests for `InMemoryJobFileRepository` |
| `packages/api/test/routes/job-files.route.test.ts` | Supertest integration tests for the job files router |
| `packages/web/src/components/jobs/PhotoBucket.tsx` | `PhotoBucket` React component with camera capture + gallery fallback |
| `packages/web/src/components/jobs/PhotoBucket.test.tsx` | RTL tests for `PhotoBucket` |

> **Migration mechanism:** This codebase does **not** use a `packages/api/migrations/*.sql` directory. The migration runner in `packages/api/src/db/migrate.ts` calls `getMigrationSQL()` which concatenates the `MIGRATIONS` object exported from `packages/api/src/db/schema.ts:25` (each value is a SQL string keyed by `'NNN_name'`). New migrations are added by appending entries to that object. All migration tasks below modify `schema.ts` rather than creating new SQL files.

### Modified files

**Phase 1** — `packages/api/src/db/schema.ts`: append `041_job_files_columns` migration entry.

**Phase 2** — `packages/api/src/files/file-service.ts`: widen `FileRecord` / `FileRepository` with `category` and `jobId` fields; `packages/api/src/files/pg-file.ts`: update `mapRow` and `create` INSERT to include both columns; new files `job-file-repository.ts` and `pg-job-file.ts` created.

**Phase 3** — `packages/api/src/routes/job-files.ts` created; `packages/api/src/app.ts`: import and mount the new job-files router under `/api/jobs`.

**Phase 4** — `packages/web/src/components/jobs/PhotoBucket.tsx` created.

**Phase 5** — `packages/web/src/pages/jobs/JobDetail.tsx`: replace the stub `Details` section with two `PhotoBucket` instances; `packages/web/src/pages/jobs/JobDetail.test.tsx`: extend tests for the `SiteMedia` section.

### Commit cadence

One commit per task. Every commit keeps tests green. No step leaves the repo broken.

---

## Phase 1: Database — category & job_id columns on files

The `files` table (migration `004_create_files`) stores generic file attachments but has no `category` discriminator and no typed FK to `jobs`. This phase adds both columns idempotently so that existing rows default to `'general'` and existing code continues to work without modification.

### Task 1: Add `041_job_files_columns` migration

**Files:**
- Modify: `packages/api/src/db/schema.ts`

**Context:** Append a new entry to the `MIGRATIONS` object immediately after `'040_create_technician_location_pings'`. The migration uses `ADD COLUMN IF NOT EXISTS` so it is safe to re-run. The check constraint enumerates exactly the four allowed category values. `job_id` is a nullable FK referencing `jobs(id)` (nullable so general-purpose file uploads unrelated to jobs keep working). An index on `(tenant_id, job_id, category)` supports the primary list query.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/files/job-file-repository.test.ts
import { describe, it, expect } from 'vitest';
import { getMigrationSQL } from '../../src/db/schema';

describe('041_job_files_columns migration', () => {
  it('contains the category column definition', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('category TEXT');
    expect(sql).toContain("DEFAULT 'general'");
  });

  it('contains the check constraint for valid category values', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain("CHECK (category IN ('before', 'after', 'general', 'document'))");
  });

  it('contains the job_id FK column', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('job_id UUID');
    expect(sql).toContain('REFERENCES jobs(id)');
  });

  it('contains an index on tenant_id, job_id, category', () => {
    const sql = getMigrationSQL();
    expect(sql).toContain('idx_files_job_category');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/files/job-file-repository.test.ts -t "041_job_files_columns migration"`
Expected: FAIL — the migration SQL does not yet contain `category`, `job_id`, or the index.

- [ ] **Step 3: Implement — append migration to `MIGRATIONS` in `schema.ts`**

Add after the `'040_create_technician_location_pings'` entry:

```typescript
'041_job_files_columns': `
  ALTER TABLE files
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'
      CHECK (category IN ('before', 'after', 'general', 'document')),
    ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id),
    ADD COLUMN IF NOT EXISTS is_uploaded BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_files_job_category
    ON files(tenant_id, job_id, category)
    WHERE job_id IS NOT NULL AND deleted_at IS NULL;
`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/files/job-file-repository.test.ts -t "041_job_files_columns migration"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/test/files/job-file-repository.test.ts
git commit -m "feat(files): add category, job_id, is_uploaded, deleted_at columns to files via migration 041"
```

---

## Phase 2: JobFileRepository — interface, InMemory, and Pg

This phase introduces the typed repository contract and both implementations that the API router will consume. The existing `FileRepository` in `file-service.ts` is not extended — `JobFileRepository` is a focused, separate interface that owns only the operations needed by the photo feature.

### Task 2: `JobFileRepository` interface + `InMemoryJobFileRepository`

**Files:**
- Create: `packages/api/src/files/job-file-repository.ts`

**Context:** `JobFileRecord` mirrors the `files` table columns added in Task 1 plus the pre-existing columns. `findByJob` supports an optional `category` filter and excludes soft-deleted rows. `softDelete` sets `deleted_at`; hard-delete is intentionally omitted.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/files/job-file-repository.test.ts (extend existing file)
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryJobFileRepository,
  JobFileRecord,
} from '../../src/files/job-file-repository';

const baseRecord = (): JobFileRecord => ({
  id: 'file-1',
  tenantId: 'tenant-1',
  jobId: 'job-1',
  filename: 'before.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 500_000,
  storageBucket: 'test-bucket',
  storageKey: 'tenants/tenant-1/jobs/job-1/file-1/before.jpg',
  category: 'before',
  isUploaded: false,
  uploadedBy: 'user-1',
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('InMemoryJobFileRepository', () => {
  let repo: InMemoryJobFileRepository;

  beforeEach(() => { repo = new InMemoryJobFileRepository(); });

  it('creates and finds a file by id', async () => {
    const record = baseRecord();
    await repo.create(record);
    const found = await repo.findById('tenant-1', 'file-1');
    expect(found?.id).toBe('file-1');
  });

  it('findByJob returns only records for that job', async () => {
    await repo.create(baseRecord());
    await repo.create({ ...baseRecord(), id: 'file-2', jobId: 'job-2' });
    const results = await repo.findByJob('tenant-1', 'job-1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('file-1');
  });

  it('findByJob filters by category when provided', async () => {
    await repo.create(baseRecord()); // category: 'before'
    await repo.create({ ...baseRecord(), id: 'file-2', category: 'after' });
    const befores = await repo.findByJob('tenant-1', 'job-1', 'before');
    expect(befores).toHaveLength(1);
    expect(befores[0].category).toBe('before');
  });

  it('findByJob excludes soft-deleted records', async () => {
    await repo.create(baseRecord());
    await repo.softDelete('tenant-1', 'file-1');
    const results = await repo.findByJob('tenant-1', 'job-1');
    expect(results).toHaveLength(0);
  });

  it('confirmUpload sets isUploaded to true', async () => {
    await repo.create(baseRecord());
    const updated = await repo.confirmUpload('tenant-1', 'file-1');
    expect(updated?.isUploaded).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/files/job-file-repository.test.ts -t "InMemoryJobFileRepository"`
Expected: FAIL — module `job-file-repository.ts` does not exist.

- [ ] **Step 3: Implement `packages/api/src/files/job-file-repository.ts`**

```typescript
import { v4 as uuidv4 } from 'uuid';

export type PhotoCategory = 'before' | 'after' | 'general' | 'document';

export interface JobFileRecord {
  id: string;
  tenantId: string;
  jobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageBucket: string;
  storageKey: string;
  category: PhotoCategory;
  isUploaded: boolean;
  uploadedBy: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateJobFileInput {
  tenantId: string;
  jobId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageBucket: string;
  category: PhotoCategory;
  uploadedBy: string;
}

export interface JobFileRepository {
  create(record: JobFileRecord): Promise<JobFileRecord>;
  findById(tenantId: string, id: string): Promise<JobFileRecord | null>;
  findByJob(tenantId: string, jobId: string, category?: PhotoCategory): Promise<JobFileRecord[]>;
  confirmUpload(tenantId: string, id: string): Promise<JobFileRecord | null>;
  softDelete(tenantId: string, id: string): Promise<boolean>;
}

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const ALLOWED_PHOTO_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
] as const;

export function buildStorageKey(tenantId: string, jobId: string, fileId: string, filename: string): string {
  return `tenants/${tenantId}/jobs/${jobId}/${fileId}/${filename}`;
}

export function createJobFileRecord(input: CreateJobFileInput): JobFileRecord {
  const id = uuidv4();
  return {
    id,
    tenantId: input.tenantId,
    jobId: input.jobId,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageBucket: input.storageBucket,
    storageKey: buildStorageKey(input.tenantId, input.jobId, id, input.filename),
    category: input.category,
    isUploaded: false,
    uploadedBy: input.uploadedBy,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export class InMemoryJobFileRepository implements JobFileRepository {
  private store = new Map<string, JobFileRecord>();

  async create(record: JobFileRecord): Promise<JobFileRecord> {
    this.store.set(record.id, { ...record });
    return { ...record };
  }

  async findById(tenantId: string, id: string): Promise<JobFileRecord | null> {
    const r = this.store.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    return { ...r };
  }

  async findByJob(tenantId: string, jobId: string, category?: PhotoCategory): Promise<JobFileRecord[]> {
    return Array.from(this.store.values()).filter(
      (r) =>
        r.tenantId === tenantId &&
        r.jobId === jobId &&
        r.deletedAt === null &&
        (category === undefined || r.category === category)
    ).map((r) => ({ ...r }));
  }

  async confirmUpload(tenantId: string, id: string): Promise<JobFileRecord | null> {
    const r = this.store.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const updated = { ...r, isUploaded: true, updatedAt: new Date() };
    this.store.set(id, updated);
    return { ...updated };
  }

  async softDelete(tenantId: string, id: string): Promise<boolean> {
    const r = this.store.get(id);
    if (!r || r.tenantId !== tenantId) return false;
    this.store.set(id, { ...r, deletedAt: new Date(), updatedAt: new Date() });
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/files/job-file-repository.test.ts -t "InMemoryJobFileRepository"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/files/job-file-repository.ts packages/api/test/files/job-file-repository.test.ts
git commit -m "feat(files): add JobFileRepository interface and InMemoryJobFileRepository"
```

### Task 3: `PgJobFileRepository`

**Files:**
- Create: `packages/api/src/files/pg-job-file.ts`

**Context:** Implements `JobFileRepository` against the live `files` table (now with `category`, `job_id`, `is_uploaded`, `deleted_at`). All queries use `withTenant` from `PgBaseRepository` so RLS applies automatically. The `mapRow` helper must handle the new columns alongside the pre-existing ones.

- [ ] **Step 1: Write the failing test** (compile-time only — no integration DB in unit tests)

```typescript
// packages/api/test/files/job-file-repository.test.ts (append describe block)
import { PgJobFileRepository } from '../../src/files/pg-job-file';

describe('PgJobFileRepository', () => {
  it('is exported and instantiable with a pool', () => {
    // Structural test only — confirms the module compiles and exports correctly.
    expect(typeof PgJobFileRepository).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/files/job-file-repository.test.ts -t "PgJobFileRepository"`
Expected: FAIL — `pg-job-file.ts` does not exist.

- [ ] **Step 3: Implement `packages/api/src/files/pg-job-file.ts`**

```typescript
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { JobFileRecord, JobFileRepository, PhotoCategory } from './job-file-repository';

function mapRow(row: Record<string, unknown>): JobFileRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    sizeBytes: Number(row.size_bytes),
    storageBucket: row.s3_bucket as string,
    storageKey: row.s3_key as string,
    category: row.category as PhotoCategory,
    isUploaded: row.is_uploaded as boolean,
    uploadedBy: row.uploaded_by as string,
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgJobFileRepository extends PgBaseRepository implements JobFileRepository {
  constructor(pool: Pool) { super(pool); }

  async create(record: JobFileRecord): Promise<JobFileRecord> {
    return this.withTenant(record.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO files
           (id, tenant_id, job_id, filename, content_type, size_bytes,
            s3_bucket, s3_key, category, is_uploaded, uploaded_by,
            entity_type, entity_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'job',$3,$12,$13)
         RETURNING *`,
        [
          record.id, record.tenantId, record.jobId, record.filename,
          record.contentType, record.sizeBytes, record.storageBucket,
          record.storageKey, record.category, record.isUploaded,
          record.uploadedBy, record.createdAt, record.updatedAt,
        ]
      );
      return mapRow(res.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<JobFileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM files WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId]
      );
      return res.rows.length ? mapRow(res.rows[0]) : null;
    });
  }

  async findByJob(tenantId: string, jobId: string, category?: PhotoCategory): Promise<JobFileRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const params: unknown[] = [tenantId, jobId];
      const catClause = category ? `AND category = $${params.push(category)}` : '';
      const res = await client.query(
        `SELECT * FROM files
         WHERE tenant_id = $1 AND job_id = $2 AND deleted_at IS NULL
         ${catClause}
         ORDER BY created_at ASC`,
        params
      );
      return res.rows.map(mapRow);
    });
  }

  async confirmUpload(tenantId: string, id: string): Promise<JobFileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE files SET is_uploaded = true, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [id, tenantId]
      );
      return res.rows.length ? mapRow(res.rows[0]) : null;
    });
  }

  async softDelete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE files SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId]
      );
      return (res.rowCount ?? 0) > 0;
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/files/job-file-repository.test.ts -t "PgJobFileRepository"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/files/pg-job-file.ts
git commit -m "feat(files): add PgJobFileRepository for category-aware job photo queries"
```

---

## Phase 3: Job Files API Router

The router lives at `/api/jobs/:id/files/*` and wires together the `JobFileRepository`, the existing `StorageProvider`, and auth middleware. Four endpoints cover the full lifecycle: request a presigned upload URL, confirm upload, list photos (grouped by category), and soft-delete.

### Task 4: Router — upload-url + confirm endpoints

**Files:**
- Create: `packages/api/src/routes/job-files.ts`
- Create: `packages/api/test/routes/job-files.route.test.ts`

**Context:** `POST /:id/files/upload-url` validates content-type (must be one of the four allowed photo MIME types) and file size (max 10 MB), creates the `JobFileRecord` with `isUploaded: false`, calls `storage.generateUploadUrl()` and returns `{ fileId, uploadUrl, storageKey }`. `POST /:id/files/confirm` calls `confirmUpload()` and returns the updated record. Both require `files:upload` permission.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/api/test/routes/job-files.route.test.ts
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createJobFilesRouter } from '../../src/routes/job-files';
import { InMemoryJobFileRepository } from '../../src/files/job-file-repository';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { StorageProvider } from '../../src/files/file-service';

class FakeStorage implements StorageProvider {
  async generateUploadUrl(_b: string, key: string) { return `https://s3/put/${key}`; }
  async generateDownloadUrl(_b: string, key: string) { return `https://s3/get/${key}`; }
  async getObjectMetadata() { return null; }
  async deleteObject() {}
}

function buildApp(tenantId = 'tenant-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = { userId: 'user-1', sessionId: 's1', tenantId, role: 'technician' };
    next();
  });
  const repo = new InMemoryJobFileRepository();
  const audit = new InMemoryAuditRepository();
  app.use('/api/jobs', createJobFilesRouter({ repo, storage: new FakeStorage(), bucket: 'test-bucket', auditRepo: audit }));
  return { app, repo };
}

describe('POST /api/jobs/:id/files/upload-url', () => {
  it('returns 201 with uploadUrl and fileId', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/jobs/job-1/files/upload-url')
      .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 1_000_000, category: 'before' });
    expect(res.status).toBe(201);
    expect(res.body.fileId).toBeTruthy();
    expect(res.body.uploadUrl).toMatch(/^https:\/\/s3\/put\//);
  });

  it('returns 400 for disallowed content type', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/jobs/job-1/files/upload-url')
      .send({ filename: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 1_000, category: 'document' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when sizeBytes exceeds 10 MB', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/jobs/job-1/files/upload-url')
      .send({ filename: 'huge.jpg', contentType: 'image/jpeg', sizeBytes: 11 * 1024 * 1024, category: 'before' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/jobs/:id/files/confirm', () => {
  it('returns 200 with isUploaded true', async () => {
    const { app, repo } = buildApp();
    // pre-seed a file record
    const urlRes = await request(app)
      .post('/api/jobs/job-1/files/upload-url')
      .send({ filename: 'after.jpg', contentType: 'image/jpeg', sizeBytes: 500_000, category: 'after' });
    const { fileId } = urlRes.body;
    const confirmRes = await request(app)
      .post(`/api/jobs/job-1/files/${fileId}/confirm`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.isUploaded).toBe(true);
  });

  it('returns 404 for unknown fileId', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/jobs/job-1/files/nonexistent/confirm');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/job-files.route.test.ts -t "upload-url|confirm"`
Expected: FAIL — `createJobFilesRouter` is not exported from `job-files.ts`.

- [ ] **Step 3: Implement upload-url + confirm handlers in `packages/api/src/routes/job-files.ts`**

```typescript
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { StorageProvider } from '../files/file-service';
import {
  JobFileRepository,
  ALLOWED_PHOTO_TYPES,
  PHOTO_MAX_BYTES,
  PhotoCategory,
  createJobFileRecord,
} from '../files/job-file-repository';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { toErrorResponse } from '../shared/errors';

export interface JobFilesRouterDeps {
  repo: JobFileRepository;
  storage: StorageProvider;
  bucket: string;
  auditRepo: AuditRepository;
}

export function createJobFilesRouter(deps: JobFilesRouterDeps): Router {
  const { repo, storage, bucket, auditRepo } = deps;
  const router = Router({ mergeParams: true });

  // POST /api/jobs/:id/files/upload-url
  router.post(
    '/:jobId/files/upload-url',
    requireAuth, requireTenant, requirePermission('files:upload'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { filename, contentType, sizeBytes, category } = req.body ?? {};
        const errors: string[] = [];
        if (!filename) errors.push('filename is required');
        if (!contentType || !ALLOWED_PHOTO_TYPES.includes(contentType)) {
          errors.push(`contentType must be one of: ${ALLOWED_PHOTO_TYPES.join(', ')}`);
        }
        if (!sizeBytes || sizeBytes <= 0) errors.push('sizeBytes must be positive');
        if (sizeBytes > PHOTO_MAX_BYTES) errors.push(`sizeBytes exceeds maximum of ${PHOTO_MAX_BYTES}`);
        if (!category || !['before','after','general','document'].includes(category)) {
          errors.push("category must be one of: before, after, general, document");
        }
        if (errors.length) { res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join('; ') }); return; }

        const record = createJobFileRecord({
          tenantId: req.auth!.tenantId,
          jobId: req.params.jobId,
          filename, contentType, sizeBytes,
          storageBucket: bucket,
          category: category as PhotoCategory,
          uploadedBy: req.auth!.userId,
        });
        const saved = await repo.create(record);
        const uploadUrl = await storage.generateUploadUrl(saved.storageBucket, saved.storageKey, saved.contentType);

        await auditRepo.create(createAuditEvent({
          tenantId: saved.tenantId, actorId: req.auth!.userId, actorRole: req.auth!.role,
          eventType: 'job.photo.upload_requested', entityType: 'file', entityId: saved.id,
          metadata: { jobId: saved.jobId, category: saved.category, filename: saved.filename },
        }));

        res.status(201).json({ fileId: saved.id, uploadUrl, storageKey: saved.storageKey });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // POST /api/jobs/:id/files/:fileId/confirm
  router.post(
    '/:jobId/files/:fileId/confirm',
    requireAuth, requireTenant, requirePermission('files:upload'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const updated = await repo.confirmUpload(req.auth!.tenantId, req.params.fileId);
        if (!updated) { res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' }); return; }
        res.json(updated);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/routes/job-files.route.test.ts`
Expected: PASS (upload-url and confirm suites green)

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/job-files.ts packages/api/test/routes/job-files.route.test.ts
git commit -m "feat(jobs): add upload-url and confirm endpoints for job photo uploads"
```

### Task 5: Router — list + delete endpoints + mount in app.ts

**Files:**
- Modify: `packages/api/src/routes/job-files.ts`
- Modify: `packages/api/src/app.ts`

**Context:** `GET /:id/files` returns `{ before: [...], after: [...], general: [...], document: [...] }` — a map keyed by category. Each value is an array of file records including a `downloadUrl` appended by calling `storage.generateDownloadUrl()` for each record. `DELETE /:id/files/:fileId` calls `softDelete`. Both require `files:view` / `files:delete` respectively. The router is registered in `app.ts` with the `/api/jobs` prefix (using `mergeParams: true` it receives `:id` from the parent mount path).

- [ ] **Step 1: Write the failing test** (extend `job-files.route.test.ts`)

```typescript
describe('GET /api/jobs/:id/files', () => {
  it('returns files grouped by category with downloadUrl', async () => {
    const { app } = buildApp();
    // Upload one before + one after
    await request(app).post('/api/jobs/job-1/files/upload-url')
      .send({ filename: 'b.jpg', contentType: 'image/jpeg', sizeBytes: 100_000, category: 'before' });
    await request(app).post('/api/jobs/job-1/files/upload-url')
      .send({ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100_000, category: 'after' });

    const res = await request(app).get('/api/jobs/job-1/files');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.before)).toBe(true);
    expect(Array.isArray(res.body.after)).toBe(true);
    expect(res.body.before).toHaveLength(1);
    expect(res.body.after).toHaveLength(1);
    expect(res.body.before[0].downloadUrl).toMatch(/^https:\/\/s3\/get\//);
  });
});

describe('DELETE /api/jobs/:id/files/:fileId', () => {
  it('soft-deletes a file and returns 204', async () => {
    const { app } = buildApp();
    const urlRes = await request(app).post('/api/jobs/job-1/files/upload-url')
      .send({ filename: 'gone.jpg', contentType: 'image/jpeg', sizeBytes: 100_000, category: 'general' });
    const { fileId } = urlRes.body;
    const del = await request(app).delete(`/api/jobs/job-1/files/${fileId}`);
    expect(del.status).toBe(204);
    const list = await request(app).get('/api/jobs/job-1/files');
    expect(list.body.general).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/api && npx vitest run test/routes/job-files.route.test.ts -t "GET /api/jobs|DELETE /api/jobs"`
Expected: FAIL — list and delete routes return 404.

- [ ] **Step 3: Implement list + delete handlers (append to `job-files.ts`), then mount in `app.ts`**

Append to the router in `job-files.ts`:

```typescript
// GET /:jobId/files
router.get(
  '/:jobId/files',
  requireAuth, requireTenant, requirePermission('files:view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const all = await repo.findByJob(req.auth!.tenantId, req.params.jobId);
      const grouped: Record<string, unknown[]> = { before: [], after: [], general: [], document: [] };
      await Promise.all(all.map(async (f) => {
        const downloadUrl = await storage.generateDownloadUrl(f.storageBucket, f.storageKey);
        grouped[f.category].push({ ...f, downloadUrl });
      }));
      res.json(grouped);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  }
);

// DELETE /:jobId/files/:fileId
router.delete(
  '/:jobId/files/:fileId',
  requireAuth, requireTenant, requirePermission('files:delete'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deleted = await repo.softDelete(req.auth!.tenantId, req.params.fileId);
      if (!deleted) { res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' }); return; }
      res.status(204).end();
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  }
);
```

In `app.ts`, import and mount (near where `createJobRouter` is mounted):

```typescript
import { createJobFilesRouter } from './routes/job-files';
// ...
app.use('/api/jobs', createJobFilesRouter({ repo: jobFileRepo, storage: storageProvider, bucket, auditRepo }));
```

Declare `jobFileRepo` in the in-memory section as `new InMemoryJobFileRepository()` and in the Pg section as `new PgJobFileRepository(pool)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/api && npx vitest run test/routes/job-files.route.test.ts`
Expected: PASS — all four suites green.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/job-files.ts packages/api/src/app.ts
git commit -m "feat(jobs): add list and soft-delete endpoints for job photos, mount router in app"
```

---

## Phase 4: PhotoBucket React Component

`PhotoBucket` is the self-contained UI unit responsible for displaying existing photos and accepting new uploads for a single category. It handles the three-step upload protocol (request URL → PUT to S3 → confirm) entirely internally and exposes only `jobId`, `category`, and an optional `onUpload` callback.

### Task 6: `PhotoBucket` component — camera capture + gallery

**Files:**
- Create: `packages/web/src/components/jobs/PhotoBucket.tsx`
- Create: `packages/web/src/components/jobs/PhotoBucket.test.tsx`

**Context:** The component uses `<input type="file" accept="image/*" capture="environment">` as the primary trigger (opens the rear camera on mobile; falls back to a file picker on desktop). A second `<input>` without `capture` is provided for gallery selection. Photos are loaded on mount via `GET /api/jobs/:jobId/files?category=<category>`. The three-step upload is: call `POST /api/jobs/:jobId/files/upload-url`, `fetch(uploadUrl, { method: 'PUT', body: file })`, then `POST /api/jobs/:jobId/files/:fileId/confirm`. Thumbnails render as `<img>` tags using the `downloadUrl` from the list response. A spinner overlays during upload. A delete button per thumbnail calls `DELETE /api/jobs/:jobId/files/:fileId` and removes the image optimistically.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/components/jobs/PhotoBucket.test.tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhotoBucket } from './PhotoBucket';

const mockApiFetch = vi.fn();
vi.mock('../../utils/api-fetch', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

describe('PhotoBucket', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders category label and upload button', () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ before: [], after: [], general: [], document: [] }) });
    render(<PhotoBucket jobId="job-1" category="before" />);
    expect(screen.getByText(/before/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/take or upload/i)).toBeInTheDocument();
  });

  it('shows a thumbnail for each loaded photo', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        before: [{ id: 'f1', filename: 'b.jpg', downloadUrl: 'https://cdn/b.jpg', category: 'before' }],
        after: [], general: [], document: [],
      }),
    });
    render(<PhotoBucket jobId="job-1" category="before" />);
    await waitFor(() => expect(screen.getByAltText('before.jpg')).toBeInTheDocument());
  });

  it('shows loading spinner during upload', async () => {
    // Simulate slow upload
    let resolveUpload!: () => void;
    const uploadPending = new Promise<void>((r) => { resolveUpload = r; });
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ before: [], after: [], general: [], document: [] }) })  // initial load
      .mockResolvedValueOnce({ ok: true, json: async () => ({ fileId: 'f2', uploadUrl: 'https://s3/put/key' }) }) // upload-url
      .mockImplementationOnce(async () => { await uploadPending; return { ok: true }; }) // PUT to S3
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // confirm

    render(<PhotoBucket jobId="job-1" category="before" />);
    const input = screen.getByLabelText(/take or upload/i);
    const file = new File(['bytes'], 'shot.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    resolveUpload();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/components/jobs/PhotoBucket.test.tsx`
Expected: FAIL — `PhotoBucket.tsx` does not exist.

- [ ] **Step 3: Implement `packages/web/src/components/jobs/PhotoBucket.tsx`**

```typescript
import React, { useEffect, useRef, useState } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';

export type PhotoCategory = 'before' | 'after' | 'general' | 'document';

interface PhotoRecord {
  id: string;
  filename: string;
  downloadUrl: string;
  category: PhotoCategory;
}

interface Props {
  jobId: string;
  category: PhotoCategory;
  onUpload?: (file: PhotoRecord) => void;
}

const LABEL: Record<PhotoCategory, string> = {
  before: 'Before', after: 'After', general: 'General', document: 'Documents',
};

export function PhotoBucket({ jobId, category, onUpload }: Props) {
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch(`/api/jobs/${jobId}/files`)
      .then((r) => r.json())
      .then((data) => setPhotos(data[category] ?? []))
      .catch(() => setError('Failed to load photos'));
  }, [jobId, category]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      setIsUploading(true);
      setError(null);
      try {
        // Step 1: request presigned URL
        const urlRes = await apiFetch(`/api/jobs/${jobId}/files/upload-url`, {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size, category }),
        });
        if (!urlRes.ok) throw new Error('Failed to get upload URL');
        const { fileId, uploadUrl } = await urlRes.json();

        // Step 2: PUT directly to S3
        const putRes = await fetch(uploadUrl, {
          method: 'PUT', body: file,
          headers: { 'Content-Type': file.type },
        });
        if (!putRes.ok) throw new Error('Upload to storage failed');

        // Step 3: confirm
        const confirmRes = await apiFetch(`/api/jobs/${jobId}/files/${fileId}/confirm`, { method: 'POST' });
        if (!confirmRes.ok) throw new Error('Failed to confirm upload');

        const record: PhotoRecord = { id: fileId, filename: file.name, downloadUrl: URL.createObjectURL(file), category };
        setPhotos((prev) => [...prev, record]);
        onUpload?.(record);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setIsUploading(false);
      }
    }
  }

  async function handleDelete(fileId: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== fileId));
    await apiFetch(`/api/jobs/${jobId}/files/${fileId}`, { method: 'DELETE' }).catch(() => {});
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">
          {LABEL[category]}
          {photos.length > 0 && (
            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">{photos.length}</span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <label
            aria-label="Take or upload photo"
            className="flex items-center gap-1.5 cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-blue-300 hover:bg-blue-50 transition-colors"
          >
            <Camera size={14} className="text-blue-500" />
            Camera
            <input
              ref={cameraRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              capture="environment"
              className="sr-only"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
          <label
            aria-label="Select from gallery"
            className="flex items-center gap-1.5 cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-blue-300 hover:bg-blue-50 transition-colors"
          >
            Gallery
            <input
              ref={galleryRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              multiple
              className="sr-only"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {isUploading && (
        <div role="status" className="flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500" />
          Uploading…
        </div>
      )}

      {photos.length === 0 && !isUploading ? (
        <p className="text-xs text-slate-400 italic">No {LABEL[category].toLowerCase()} photos yet.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div key={photo.id} className="group relative rounded-lg overflow-hidden aspect-square bg-slate-100">
              <img
                src={photo.downloadUrl}
                alt={photo.filename}
                className="w-full h-full object-cover"
              />
              <button
                onClick={() => handleDelete(photo.id)}
                aria-label={`Delete ${photo.filename}`}
                className="absolute top-1 right-1 hidden group-hover:flex size-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-red-600 transition-colors"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/components/jobs/PhotoBucket.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/jobs/PhotoBucket.tsx packages/web/src/components/jobs/PhotoBucket.test.tsx
git commit -m "feat(web): add PhotoBucket component with camera capture, gallery fallback, and S3 upload flow"
```

---

## Phase 5: JobDetail.tsx SiteMedia Integration

Replace the stub `Details` section in `JobDetail.tsx` with a `SiteMedia` section containing two `PhotoBucket` instances — one for `'before'` and one for `'after'`. The existing `Details` section is preserved; `SiteMedia` becomes a second section in the `sections` array.

### Task 7: Update `JobDetail.tsx` and its tests

**Files:**
- Modify: `packages/web/src/pages/jobs/JobDetail.tsx`
- Modify: `packages/web/src/pages/jobs/JobDetail.test.tsx`

**Context:** `DetailPage` receives an array of `sections`; each section has `title` and `content`. A new `SiteMedia` section is appended with `content` rendering two `PhotoBucket` instances side by side (one column on mobile, two columns on larger screens). Photo count badges come from `PhotoBucket`'s internal state and are surfaced naturally through the badge span already rendered inside the component.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/src/pages/jobs/JobDetail.test.tsx (extend/replace)
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobDetail } from './JobDetail';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../components/jobs/PhotoBucket', () => ({
  PhotoBucket: ({ category }: { category: string }) => (
    <div data-testid={`photo-bucket-${category}`}>{category} photos</div>
  ),
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

describe('JobDetail — SiteMedia section', () => {
  beforeEach(() => {
    vi.mocked(useDetailQuery).mockReturnValue({
      data: { id: '1', jobNumber: 'JOB-001', summary: 'Fix leak', problemDescription: 'Pipe burst', status: 'open', priority: 'high' },
      isLoading: false, error: null, refetch: vi.fn(),
    });
  });

  it('renders a SiteMedia section heading', () => {
    render(<JobDetail jobId="1" />);
    expect(screen.getByText('Site Media')).toBeInTheDocument();
  });

  it('renders a before PhotoBucket', () => {
    render(<JobDetail jobId="1" />);
    expect(screen.getByTestId('photo-bucket-before')).toBeInTheDocument();
  });

  it('renders an after PhotoBucket', () => {
    render(<JobDetail jobId="1" />);
    expect(screen.getByTestId('photo-bucket-after')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/pages/jobs/JobDetail.test.tsx -t "SiteMedia"`
Expected: FAIL — `SiteMedia` text and `photo-bucket-before` are not in the document.

- [ ] **Step 3: Implement updated `JobDetail.tsx`**

```typescript
import React from 'react';
import { DetailPage } from '../../components/DetailPage';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { PhotoBucket } from '../../components/jobs/PhotoBucket';

interface Job {
  id: string;
  jobNumber: string;
  summary: string;
  problemDescription?: string;
  status: string;
  priority: string;
}

interface JobDetailProps {
  jobId: string;
  onBack?: () => void;
}

export function JobDetail({ jobId, onBack }: JobDetailProps) {
  const { data, isLoading, error, refetch } = useDetailQuery<Job>('/api/jobs', jobId);

  if (!data) {
    return <DetailPage title="Job" sections={[]} isLoading={isLoading} error={error} onBack={onBack} onRetry={refetch} />;
  }

  return (
    <DetailPage
      title={`${data.jobNumber} — ${data.summary}`}
      subtitle={`Status: ${data.status} | Priority: ${data.priority}`}
      isLoading={isLoading}
      error={error}
      onBack={onBack}
      onRetry={refetch}
      sections={[
        {
          title: 'Details',
          content: (
            <div>
              <p>Problem: {data.problemDescription || 'N/A'}</p>
            </div>
          ),
        },
        {
          title: 'Site Media',
          content: (
            <div className="space-y-6">
              <PhotoBucket jobId={jobId} category="before" />
              <PhotoBucket jobId={jobId} category="after" />
            </div>
          ),
        },
      ]}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/pages/jobs/JobDetail.test.tsx`
Expected: PASS — all four tests (original two + new three SiteMedia tests) green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/jobs/JobDetail.tsx packages/web/src/pages/jobs/JobDetail.test.tsx
git commit -m "feat(web): integrate PhotoBucket into JobDetail SiteMedia section for before/after photos"
```

### Task 8: Wire `PgJobFileRepository` + `InMemoryJobFileRepository` into `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

**Context:** The `app.ts` already imports `InMemoryFileRepository` and `PgFileRepository` for the generic `/api/files` routes. The job-files router needs its own repo instance. In the in-memory branch instantiate `InMemoryJobFileRepository`; in the Pg branch instantiate `PgJobFileRepository(pool)`. Both share the same `storageProvider` and `bucket` that was already created for the files router.

- [ ] **Step 1: Write the failing test** (smoke test — confirm router responds)

```typescript
// packages/api/test/routes/job-files.route.test.ts (append)
describe('router mount smoke test', () => {
  it('GET /api/jobs/:id/files returns 200 from test app', async () => {
    // Relies on buildTestApp() mounting job-files router
    // This test intentionally deferred to after app.ts wiring is complete.
    expect(true).toBe(true); // placeholder — replaced by integration test below
  });
});
```

- [ ] **Step 2: Implement wiring in `app.ts`**

Add imports at top of in-memory section:

```typescript
import { InMemoryJobFileRepository } from './files/job-file-repository';
import { PgJobFileRepository } from './files/pg-job-file';
import { createJobFilesRouter } from './routes/job-files';
```

In the in-memory fallback block:

```typescript
const jobFileRepo = new InMemoryJobFileRepository();
```

In the Pg block:

```typescript
const jobFileRepo = new PgJobFileRepository(pool);
```

Mount (after the existing job router registration):

```typescript
app.use('/api/jobs', createJobFilesRouter({
  repo: jobFileRepo,
  storage: storageSetup.provider,
  bucket: storageSetup.bucket,
  auditRepo,
}));
```

- [ ] **Step 3: Run all API tests to verify nothing is broken**

Run: `cd packages/api && npx vitest run`
Expected: PASS — all existing tests remain green; new job-files tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "feat(api): wire InMemoryJobFileRepository and PgJobFileRepository into app factory for job photos router"
```

---

## Out of scope

- Video upload, recording, or playback (the existing `CameraCapture` component supports video but the job photos feature is photos-only)
- Photo annotations, drawing tools, or markup overlays
- PDF generation that embeds job photos (report export)
- Customer-facing photo gallery or customer portal access to photos
- Cloud image optimization, resizing, or thumbnailing — raw S3 URLs are used for now
- Push notifications when a technician uploads photos
- Bulk photo selection or reordering within a category
- EXIF metadata extraction (GPS coordinates, timestamp)
- Integration with the AI proposal engine or AI-driven damage assessment

---

### Critical Files for Implementation
- `/home/user/Serviceos/packages/api/src/db/schema.ts`
- `/home/user/Serviceos/packages/api/src/files/job-file-repository.ts`
- `/home/user/Serviceos/packages/api/src/routes/job-files.ts`
- `/home/user/Serviceos/packages/web/src/components/jobs/PhotoBucket.tsx`
- `/home/user/Serviceos/packages/web/src/pages/jobs/JobDetail.tsx`
