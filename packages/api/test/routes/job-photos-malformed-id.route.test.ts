/**
 * Route hardening tests: Job photos (#1110, extends the #882 / #1096 sweep)
 *
 * The job-photos router (mounted at `/api/jobs`) reaches `job_photos` uuid
 * columns with three route params:
 *
 *   - `POST /:id/photos` — `PgJobPhotoRepository.create` inserts `:id` into
 *     `job_photos.job_id uuid` once the file lookup succeeds;
 *   - `GET /:id/photos` — `listByJob` compares `:id` to `job_photos.job_id`;
 *   - `DELETE /:id/photos/:photoId` — `findById` compares `:photoId` to
 *     `job_photos.id` (`:id` is then compared in JavaScript and already
 *     answers `404 Job photo not found`, pinned below).
 *
 * A non-UUID value reached Postgres, threw `invalid input syntax for type
 * uuid`, and `asyncRoute` answered a bare `500 INTERNAL_ERROR`. The #1096 sweep
 * found this router masked by synthetic `job-…` fixtures in
 * test/jobs/job-photos.test.ts; those fixtures now use real uuids.
 *
 * Not converted by #1110 (it did not 500 then): `POST /:id/photos/presign-upload`
 * stores `:id` in `files.entity_id`, which is TEXT.
 *
 * #1187 (extends this sweep): `POST /:id/photos` and `POST
 * /:id/photos/presign-upload` now look the job up through a tenant-scoped
 * `jobRepo.findById` before writing — the FK-backed `POST /:id/photos` used
 * to hit `job_photos.job_id`'s foreign key as a bare 500 on a well-formed
 * but unknown job id, and `presign-upload` (TEXT `entity_id`, no FK) used to
 * write an orphan `files` row and 201 (real-Postgres leg: test/integration/
 * unknown-parent-id-404.test.ts). A malformed `:id` would reach that
 * lookup's uuid-typed column comparison and 500, so `notFoundOnMalformedId`
 * now guards `presign-upload` too — pinned below. The `jobRepo` double here
 * always resolves any well-formed id as found; well-formed-*unknown* job
 * ids are #1187's integration leg, not this file's concern.
 *
 * The PgLike subclasses throw exactly what Postgres would for the uuid columns
 * (pattern: users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryFileRepository,
  ObjectMetadata,
  StorageProvider,
  createFileRecord,
} from '../../src/files/file-service';
import { CreateJobPhotoInput, InMemoryJobPhotoRepository } from '../../src/jobs/job-photo';
import { JobPhotoService } from '../../src/jobs/job-photo-service';
import type { Job, JobRepository } from '../../src/jobs/job';
import { createJobPhotosRouter } from '../../src/routes/job-photos';

// #1187 — this file is about :id / :photoId malformed-value handling, not
// job existence, so the double resolves any well-formed job id as found
// (well-formed-*unknown* job ids are proven at real Postgres in
// test/integration/unknown-parent-id-404.test.ts).
const alwaysFoundJobRepo: Pick<JobRepository, 'findById'> = {
  findById: async () => ({} as Job),
};

const TENANT = 'tenant-job-photos-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeJobPhotoRepository extends InMemoryJobPhotoRepository {
  async create(input: CreateJobPhotoInput) {
    castUuid(input.jobId);
    castUuid(input.fileId);
    return super.create(input);
  }

  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async listByJob(tenantId: string, jobId: string) {
    castUuid(jobId);
    return super.listByJob(tenantId, jobId);
  }

  async delete(tenantId: string, id: string) {
    castUuid(id);
    return super.delete(tenantId, id);
  }
}

class PgLikeFileRepository extends InMemoryFileRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
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

function buildApp(
  photoRepo: InMemoryJobPhotoRepository,
  fileRepo: InMemoryFileRepository,
  role: string | null = 'owner',
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-job-photos-malformed',
        sessionId: 'sess-job-photos-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  const storage = new FakeStorageProvider();
  app.use(
    '/api/jobs',
    createJobPhotosRouter({
      service: new JobPhotoService(photoRepo, fileRepo, storage),
      fileRepo,
      storage,
      bucket: 'job-photos-malformed-test',
      auditRepo: new InMemoryAuditRepository(),
      jobRepo: alwaysFoundJobRepo,
    }),
  );
  return app;
}

async function seedFile(fileRepo: InMemoryFileRepository): Promise<string> {
  const record = await fileRepo.create(
    createFileRecord(
      {
        tenantId: TENANT,
        uploadedBy: 'user-job-photos-malformed',
        filename: 'before.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      },
      'job-photos-malformed-test',
    ),
  );
  return record.id;
}

describe('job photos: malformed :id / :photoId never reach Postgres as a raw uuid comparison (#1110)', () => {
  let photoRepo: PgLikeJobPhotoRepository;
  let fileRepo: PgLikeFileRepository;
  let fileId: string;

  beforeEach(async () => {
    photoRepo = new PgLikeJobPhotoRepository();
    fileRepo = new PgLikeFileRepository();
    fileId = await seedFile(fileRepo);
  });

  const HANDLERS: Array<{
    route: string;
    message: string;
    send: (app: Express, bad: string) => request.Test;
  }> = [
    {
      route: 'POST /api/jobs/:id/photos',
      message: 'Job not found',
      send: (app, bad) => request(app).post(`/api/jobs/${bad}/photos`).send({ fileId, category: 'before' }),
    },
    {
      route: 'GET /api/jobs/:id/photos',
      message: 'Job not found',
      send: (app, bad) => request(app).get(`/api/jobs/${bad}/photos`),
    },
    {
      route: 'DELETE /api/jobs/:id/photos/:photoId (malformed :photoId)',
      message: 'Job photo not found',
      send: (app, bad) => request(app).delete(`/api/jobs/${uuidv4()}/photos/${bad}`),
    },
    {
      // #1187 — presign-upload now looks the job up before writing (see
      // file header), so it needs the same malformed-:id guard.
      route: 'POST /api/jobs/:id/photos/presign-upload',
      message: 'Job not found',
      send: (app, bad) =>
        request(app)
          .post(`/api/jobs/${bad}/photos/presign-upload`)
          .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 1024 }),
    },
  ];

  for (const handler of HANDLERS) {
    it(`${handler.route} with a malformed value answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await handler.send(buildApp(photoRepo, fileRepo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: handler.message });
    });
  }

  it('GET /api/jobs/:id/photos with a well-formed unknown id keeps its existing 200 []', async () => {
    const res = await request(buildApp(photoRepo, fileRepo)).get(`/api/jobs/${uuidv4()}/photos`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('DELETE with a well-formed unknown :photoId still answers the identical 404', async () => {
    const res = await request(buildApp(photoRepo, fileRepo)).delete(
      `/api/jobs/${uuidv4()}/photos/${uuidv4()}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job photo not found' });
  });

  it('DELETE with a malformed :id (a JS comparison, no SQL) keeps its existing 404', async () => {
    const jobId = uuidv4();
    const app = buildApp(photoRepo, fileRepo);
    const attach = await request(app).post(`/api/jobs/${jobId}/photos`).send({ fileId, category: 'before' });
    expect(attach.status).toBe(201);

    const res = await request(app).delete(`/api/jobs/not-a-uuid/photos/${attach.body.id}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job photo not found' });
  });

  it('a valid id is unaffected — attach, list and delete still apply', async () => {
    const jobId = uuidv4();
    const app = buildApp(photoRepo, fileRepo);

    const attach = await request(app).post(`/api/jobs/${jobId}/photos`).send({ fileId, category: 'after' });
    expect(attach.status).toBe(201);

    const list = await request(app).get(`/api/jobs/${jobId}/photos`);
    expect(list.status).toBe(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([attach.body.id]);

    const removed = await request(app).delete(`/api/jobs/${jobId}/photos/${attach.body.id}`);
    expect(removed.status).toBe(204);
  });

  it('auth ordering: a caller whose role grants nothing gets 403 before any existence signal', async () => {
    const app = buildApp(photoRepo, fileRepo, 'viewer');
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const app = buildApp(photoRepo, fileRepo, null);
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(401);
    }
  });
});
