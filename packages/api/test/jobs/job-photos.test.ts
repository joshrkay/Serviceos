/**
 * P12-001 — End-to-end route tests for the job-photos surface.
 *
 * Mirrors the supertest + FakeStorageProvider pattern from
 * test/routes/job-files.route.test.ts so behavior stays consistent
 * across the two photo/file pipelines.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryFileRepository,
  ObjectMetadata,
  StorageProvider,
} from '../../src/files/file-service';
import { InMemoryJobPhotoRepository } from '../../src/jobs/job-photo';
import { JobPhotoService } from '../../src/jobs/job-photo-service';
import { createJobPhotosRouter } from '../../src/routes/job-photos';

const TENANT_A = 'tenant-photos-a';
const TENANT_B = 'tenant-photos-b';
const BUCKET = 'serviceos-job-photos-test';

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
  async deleteObject(): Promise<void> {
    return;
  }
}

interface BuildOpts {
  tenantId: string;
  fileRepo: InMemoryFileRepository;
  photoRepo: InMemoryJobPhotoRepository;
}

function buildApp(opts: BuildOpts): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: `user-${opts.tenantId}`,
      sessionId: `session-${opts.tenantId}`,
      tenantId: opts.tenantId,
      role: 'owner',
    };
    next();
  });
  const storage = new FakeStorageProvider();
  app.use(
    '/api/jobs',
    createJobPhotosRouter({
      service: new JobPhotoService(opts.photoRepo, opts.fileRepo, storage),
      fileRepo: opts.fileRepo,
      storage,
      bucket: BUCKET,
      auditRepo: new InMemoryAuditRepository(),
    })
  );
  return app;
}

describe('job-photo router (P12-001)', () => {
  let fileRepo: InMemoryFileRepository;
  let photoRepo: InMemoryJobPhotoRepository;
  let app: Express;

  beforeEach(() => {
    fileRepo = new InMemoryFileRepository();
    photoRepo = new InMemoryJobPhotoRepository();
    app = buildApp({ tenantId: TENANT_A, fileRepo, photoRepo });
  });

  it('presign-upload validates content type, size, and returns fileId + uploadUrl', async () => {
    const jobId = 'job-presign-1';
    const ok = await request(app)
      .post(`/api/jobs/${jobId}/photos/presign-upload`)
      .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 1024 });
    expect(ok.status).toBe(201);
    expect(ok.body.fileId).toBeTruthy();
    expect(ok.body.uploadUrl).toContain('/put/');

    const tooBig = await request(app)
      .post(`/api/jobs/${jobId}/photos/presign-upload`)
      .send({ filename: 'huge.jpg', contentType: 'image/jpeg', sizeBytes: 11 * 1024 * 1024 });
    expect(tooBig.status).toBe(400);

    const wrongType = await request(app)
      .post(`/api/jobs/${jobId}/photos/presign-upload`)
      .send({ filename: 'movie.mp4', contentType: 'video/mp4', sizeBytes: 1024 });
    // video/mp4 is not in the generic allowed set, so validateUpload
    // rejects it before our content-type narrowing fires — both layers
    // produce 400, which is what we want.
    expect(wrongType.status).toBe(400);
  });

  it('attach + list + delete round-trips a job-photo', async () => {
    const jobId = 'job-attach-1';
    const presign = await request(app)
      .post(`/api/jobs/${jobId}/photos/presign-upload`)
      .send({ filename: 'after.png', contentType: 'image/png', sizeBytes: 2048 });
    expect(presign.status).toBe(201);
    const fileId = presign.body.fileId;

    const attach = await request(app)
      .post(`/api/jobs/${jobId}/photos`)
      .send({ fileId, category: 'after', notes: 'all done' });
    expect(attach.status).toBe(201);
    expect(attach.body.fileId).toBe(fileId);
    expect(attach.body.category).toBe('after');
    expect(attach.body.notes).toBe('all done');

    const list = await request(app).get(`/api/jobs/${jobId}/photos`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].downloadUrl).toContain('/get/');
    expect(list.body[0].filename).toBe('after.png');
    expect(list.body[0].contentType).toBe('image/png');

    const remove = await request(app).delete(`/api/jobs/${jobId}/photos/${attach.body.id}`);
    expect(remove.status).toBe(204);

    const after = await request(app).get(`/api/jobs/${jobId}/photos`);
    expect(after.body).toHaveLength(0);
  });

  it('attach rejects unknown fileId with 404', async () => {
    const jobId = 'job-bad-file';
    const r = await request(app)
      .post(`/api/jobs/${jobId}/photos`)
      .send({ fileId: 'no-such-file', category: 'before' });
    expect(r.status).toBe(404);
  });

  it('attach rejects bad category with 400', async () => {
    const jobId = 'job-bad-cat';
    const presign = await request(app)
      .post(`/api/jobs/${jobId}/photos/presign-upload`)
      .send({ filename: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(presign.status).toBe(201);
    const r = await request(app)
      .post(`/api/jobs/${jobId}/photos`)
      .send({ fileId: presign.body.fileId, category: 'invalid' });
    expect(r.status).toBe(400);
  });

  it('enforces tenant isolation for list + delete', async () => {
    const jobId = 'job-iso-1';
    const presign = await request(app)
      .post(`/api/jobs/${jobId}/photos/presign-upload`)
      .send({ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 200 });
    const attach = await request(app)
      .post(`/api/jobs/${jobId}/photos`)
      .send({ fileId: presign.body.fileId, category: 'before' });
    expect(attach.status).toBe(201);

    // Other tenant sharing the underlying repos sees nothing.
    const otherApp = buildApp({ tenantId: TENANT_B, fileRepo, photoRepo });
    const otherList = await request(otherApp).get(`/api/jobs/${jobId}/photos`);
    expect(otherList.status).toBe(200);
    expect(otherList.body).toHaveLength(0);

    const otherDelete = await request(otherApp).delete(
      `/api/jobs/${jobId}/photos/${attach.body.id}`
    );
    expect(otherDelete.status).toBe(404);

    // Original tenant still sees the photo.
    const ownList = await request(app).get(`/api/jobs/${jobId}/photos`);
    expect(ownList.body).toHaveLength(1);
  });
});
