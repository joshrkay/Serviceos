/**
 * Route hardening tests: Job files (#1110, extends the #882 / #1096 sweep)
 *
 * Job files live in the `files` table (`entity_type = 'job'`). Of the four
 * handlers on the job-files router (mounted at `/api/jobs`), exactly one
 * reaches a uuid comparison with a route param:
 *
 *   - `DELETE /:id/files/:fileId` looks the file up by `:fileId`
 *     (`files.id uuid`, `PgJobFileRepository.findById`). A non-UUID `:fileId`
 *     reached Postgres, threw `invalid input syntax for type uuid`, and
 *     `asyncRoute` answered a bare `500 INTERNAL_ERROR`. → guarded here.
 *
 * Not converted, because they do not 500 today (#1110 converts only the bare
 * 500s): `POST /:id/files/upload-url`, `POST /:id/files/upload` and
 * `GET /:id/files` bind `:id` to `files.entity_id`, which is `TEXT`, so a
 * malformed `:id` is stored / compared as text. On `DELETE`, `:id` is
 * compared in JavaScript (`file.jobId !== req.params.id`) and already answers
 * `404 Job file not found` — pinned below.
 *
 * The PgLike subclass throws exactly what Postgres would for the columns that
 * are uuid (pattern: users-malformed-id.route.test.ts); the real-Postgres leg
 * is test/integration/malformed-id-404-seam.test.ts.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { ObjectMetadata, StorageProvider } from '../../src/files/file-service';
import { InMemoryJobFileRepository } from '../../src/files/job-file-repository';
import { createJobFilesRouter } from '../../src/routes/job-files';

const TENANT = 'tenant-job-files-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

/** `files.id` is uuid; `files.entity_id` (the job id) is TEXT, so only ids cast. */
class PgLikeJobFileRepository extends InMemoryJobFileRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async delete(tenantId: string, id: string) {
    castUuid(id);
    return super.delete(tenantId, id);
  }
}

class FakeStorageProvider implements StorageProvider {
  async generateUploadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/put/${bucket}/${key}`;
  }
  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    return `https://fake.local/get/${bucket}/${key}`;
  }
  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return null;
  }
  async getObject(): Promise<Buffer | null> {
    return null;
  }
  async putObject(): Promise<void> {
    return;
  }
  async deleteObject(): Promise<void> {
    return;
  }
}

function buildApp(repo: InMemoryJobFileRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-job-files-malformed',
        sessionId: 'sess-job-files-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/jobs',
    createJobFilesRouter({
      jobFileRepo: repo,
      storage: new FakeStorageProvider(),
      bucket: 'job-files-malformed-test',
      auditRepo: new InMemoryAuditRepository(),
    }),
  );
  return app;
}

const UPLOAD = { filename: 'permit.pdf', contentType: 'application/pdf', sizeBytes: 2048 };

const removeFile = (app: Express, jobId: string, fileId: string) =>
  request(app).delete(`/api/jobs/${jobId}/files/${fileId}`);

describe('job files: malformed :fileId never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeJobFileRepository;

  beforeEach(() => {
    repo = new PgLikeJobFileRepository();
  });

  it('DELETE /api/jobs/:id/files/:fileId with a malformed :fileId answers 404 NOT_FOUND, never a 500', async () => {
    const res = await removeFile(buildApp(repo), uuidv4(), 'not-a-uuid');
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job file not found' });
  });

  it('DELETE with a well-formed unknown :fileId still answers the identical 404', async () => {
    const res = await removeFile(buildApp(repo), uuidv4(), uuidv4());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job file not found' });
  });

  it('DELETE with a malformed :id (a JS comparison, no SQL) keeps its existing 404', async () => {
    const app = buildApp(repo);
    const upload = await request(app).post(`/api/jobs/${uuidv4()}/files/upload-url`).send(UPLOAD);
    expect(upload.status).toBe(201);

    const res = await removeFile(app, 'not-a-uuid', upload.body.fileId);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job file not found' });
  });

  it('a valid id is unaffected — upload, list and delete still apply', async () => {
    const jobId = uuidv4();
    const app = buildApp(repo);

    const upload = await request(app).post(`/api/jobs/${jobId}/files/upload-url`).send(UPLOAD);
    expect(upload.status).toBe(201);

    const list = await request(app).get(`/api/jobs/${jobId}/files`);
    expect(list.status).toBe(200);
    expect(list.body.map((f: { id: string }) => f.id)).toEqual([upload.body.fileId]);

    const removed = await removeFile(app, jobId, upload.body.fileId);
    expect(removed.status).toBe(204);
  });

  it('auth ordering: a caller whose role grants nothing gets 403 before any existence signal', async () => {
    const res = await removeFile(buildApp(repo, 'viewer'), uuidv4(), 'not-a-uuid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await removeFile(buildApp(repo, null), uuidv4(), 'not-a-uuid');
    expect(res.status).toBe(401);
  });
});
