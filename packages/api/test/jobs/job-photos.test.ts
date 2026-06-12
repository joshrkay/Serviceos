/**
 * P12-001 — End-to-end route tests for the job-photos surface.
 *
 * Mirrors the supertest + FakeStorageProvider pattern from
 * test/routes/job-files.route.test.ts so behavior stays consistent
 * across the two photo/file pipelines.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryAttachmentRepository } from '../../src/attachments/attachment';
import {
  InMemoryFileRepository,
  ObjectMetadata,
  StorageProvider,
} from '../../src/files/file-service';
import { InMemoryJobPhotoRepository } from '../../src/jobs/job-photo';
import {
  JobPhotoService,
  mapJobPhotoCategoryToAttachmentCategory,
} from '../../src/jobs/job-photo-service';
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

describe('job-photo dual-write shadow into attachments (RV-005)', () => {
  const TENANT = 'tenant-photos-shadow';
  const JOB_ID = 'job-shadow-1';
  const USER_ID = 'user-shadow-1';

  async function seedFile(fileRepo: InMemoryFileRepository) {
    return fileRepo.create({
      id: 'file-shadow-1',
      tenantId: TENANT,
      filename: 'before.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      storageBucket: 'b',
      storageKey: 'k',
      uploadedBy: USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('also creates an attachments row when the optional repo is injected', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const attachmentRepo = new InMemoryAttachmentRepository();
    const service = new JobPhotoService(
      photoRepo,
      fileRepo,
      new FakeStorageProvider(),
      attachmentRepo
    );
    const file = await seedFile(fileRepo);

    const photo = await service.attachPhotoToJob(
      TENANT,
      JOB_ID,
      file.id,
      'before',
      'pipe before fix',
      undefined,
      USER_ID
    );
    expect(photo.id).toBeTruthy();

    const shadows = await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID);
    expect(shadows).toHaveLength(1);
    expect(shadows[0].fileId).toBe(file.id);
    expect(shadows[0].kind).toBe('photo');
    expect(shadows[0].source).toBe('app');
    expect(shadows[0].category).toBe('before');
    expect(shadows[0].caption).toBe('pipe before fix');
    expect(shadows[0].uploadedBy).toBe(USER_ID);
  });

  it('behaves exactly as before when the optional repo is absent', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const service = new JobPhotoService(photoRepo, fileRepo, new FakeStorageProvider());
    const file = await seedFile(fileRepo);

    const photo = await service.attachPhotoToJob(
      TENANT,
      JOB_ID,
      file.id,
      'after',
      undefined,
      undefined,
      USER_ID
    );
    expect(photo.category).toBe('after');
    expect(await photoRepo.findById(TENANT, photo.id)).not.toBeNull();
  });

  it('does not break the job-photo flow when the shadow write fails', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const failingRepo = new InMemoryAttachmentRepository();
    failingRepo.create = async () => {
      throw new Error('attachments table is on fire');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const service = new JobPhotoService(
        photoRepo,
        fileRepo,
        new FakeStorageProvider(),
        failingRepo
      );
      const file = await seedFile(fileRepo);

      const photo = await service.attachPhotoToJob(
        TENANT,
        JOB_ID,
        file.id,
        'completion',
        undefined,
        undefined,
        USER_ID
      );
      expect(await photoRepo.findById(TENANT, photo.id)).not.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('maps every job-photo category onto the attachments enum', () => {
    expect(mapJobPhotoCategoryToAttachmentCategory('before')).toBe('before');
    expect(mapJobPhotoCategoryToAttachmentCategory('after')).toBe('after');
    expect(mapJobPhotoCategoryToAttachmentCategory('problem')).toBe('problem');
    expect(mapJobPhotoCategoryToAttachmentCategory('completion')).toBe('completion');
    expect(mapJobPhotoCategoryToAttachmentCategory('other')).toBe('other');
  });

  it('archives the shadow attachment row when a job photo is deleted', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const attachmentRepo = new InMemoryAttachmentRepository();
    const service = new JobPhotoService(
      photoRepo,
      fileRepo,
      new FakeStorageProvider(),
      attachmentRepo
    );
    const file = await seedFile(fileRepo);

    const photo = await service.attachPhotoToJob(
      TENANT, JOB_ID, file.id, 'before', undefined, undefined, USER_ID
    );
    // Shadow row exists and is not archived yet.
    const shadowsBefore = await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID);
    expect(shadowsBefore).toHaveLength(1);

    const deleted = await service.deleteJobPhoto(TENANT, JOB_ID, photo.id);
    expect(deleted).toBe(true);

    // Shadow row should now be archived (excluded from default list).
    const shadowsAfter = await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID);
    expect(shadowsAfter).toHaveLength(0);

    const allShadows = await attachmentRepo.listByEntity(TENANT, 'job', JOB_ID, {
      includeArchived: true,
    });
    expect(allShadows).toHaveLength(1);
    expect(allShadows[0].archivedAt).toBeInstanceOf(Date);
  });

  it('delete succeeds when there is no matching shadow row', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const attachmentRepo = new InMemoryAttachmentRepository();
    const service = new JobPhotoService(
      photoRepo,
      fileRepo,
      new FakeStorageProvider(),
      attachmentRepo
    );
    const file = await seedFile(fileRepo);
    // Create job photo WITHOUT shadow write (call repo directly)
    const photo = await photoRepo.create({
      tenantId: TENANT,
      jobId: JOB_ID,
      uploadedByUserId: USER_ID,
      fileId: file.id,
      category: 'after',
    });

    // No shadow row exists — delete should still succeed
    const deleted = await service.deleteJobPhoto(TENANT, JOB_ID, photo.id);
    expect(deleted).toBe(true);
    expect(await photoRepo.findById(TENANT, photo.id)).toBeNull();
  });

  it('shadow-archive failure does not break job-photo delete', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const attachmentRepo = new InMemoryAttachmentRepository();
    const service = new JobPhotoService(
      photoRepo,
      fileRepo,
      new FakeStorageProvider(),
      attachmentRepo
    );
    const file = await seedFile(fileRepo);
    const photo = await service.attachPhotoToJob(
      TENANT, JOB_ID, file.id, 'before', undefined, undefined, USER_ID
    );

    // Make archive throw
    attachmentRepo.archive = async () => {
      throw new Error('archive is broken');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deleted = await service.deleteJobPhoto(TENANT, JOB_ID, photo.id);
      expect(deleted).toBe(true);
      expect(await photoRepo.findById(TENANT, photo.id)).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('job-photo image post-process enqueue (RV-006)', () => {
  const TENANT = 'tenant-photos-pipeline';
  const JOB_ID = 'job-pipeline-1';
  const USER_ID = 'user-pipeline-1';

  class FakeQueue {
    sent: Array<{ type: string; payload: unknown; idempotencyKey?: string }> = [];
    constructor(private readonly opts: { fail?: boolean } = {}) {}
    async send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string> {
      if (this.opts.fail) throw new Error('queue unavailable');
      this.sent.push({ type, payload, idempotencyKey });
      return `msg-${this.sent.length}`;
    }
  }

  async function seedFile(fileRepo: InMemoryFileRepository) {
    return fileRepo.create({
      id: 'file-pipeline-1',
      tenantId: TENANT,
      filename: 'before.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      storageBucket: 'b',
      storageKey: 'k',
      uploadedBy: USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('enqueues an image_post_process message after a successful photo attach', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const queue = new FakeQueue();
    const service = new JobPhotoService(
      photoRepo,
      fileRepo,
      new FakeStorageProvider(),
      undefined,
      queue
    );
    const file = await seedFile(fileRepo);

    await service.attachPhotoToJob(TENANT, JOB_ID, file.id, 'before', undefined, undefined, USER_ID);

    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0].type).toBe('image_post_process');
    expect(queue.sent[0].payload).toEqual({ tenantId: TENANT, fileId: file.id });
    expect(queue.sent[0].idempotencyKey).toBe(`image_post_process:${file.id}`);
  });

  it('photo attach succeeds even when the enqueue fails (failure-isolated)', async () => {
    const fileRepo = new InMemoryFileRepository();
    const photoRepo = new InMemoryJobPhotoRepository();
    const service = new JobPhotoService(
      photoRepo,
      fileRepo,
      new FakeStorageProvider(),
      undefined,
      new FakeQueue({ fail: true })
    );
    const file = await seedFile(fileRepo);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const photo = await service.attachPhotoToJob(
        TENANT, JOB_ID, file.id, 'before', undefined, undefined, USER_ID
      );
      expect(photo.id).toBeTruthy();
      expect(await photoRepo.findById(TENANT, photo.id)).not.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
