import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createFilesRouter } from '../../src/routes/files';
import {
  InMemoryFileRepository,
  MAX_FILE_SIZE,
  ObjectMetadata,
  StorageProvider,
} from '../../src/files/file-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { JobRepository } from '../../src/jobs/job';

const TENANT_ID = 'tenant-files-1';
const OTHER_TENANT_ID = 'tenant-files-2';
const BUCKET = 'serviceos-test';
const KNOWN_JOB_ID = '0f3c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/** Tenant-scoped stand-in for JobRepository.findById: one job, in TENANT_ID only. */
const oneJob: Pick<JobRepository, 'findById'> = {
  findById: async (tenantId: string, id: string) =>
    tenantId === TENANT_ID && id === KNOWN_JOB_ID
      ? ({ id, tenantId } as unknown as Awaited<ReturnType<JobRepository['findById']>>)
      : null,
};
const noJobs: Pick<JobRepository, 'findById'> = { findById: async () => null };

class FakeStorageProvider implements StorageProvider {
  generateUploadCalls: Array<{ bucket: string; key: string; contentType: string }> = [];
  generateDownloadCalls: Array<{ bucket: string; key: string }> = [];
  headResult: ObjectMetadata | null = { contentLength: 1234, contentType: 'audio/webm' };
  deleted: Array<{ bucket: string; key: string }> = [];

  async generateUploadUrl(bucket: string, key: string, contentType: string): Promise<string> {
    this.generateUploadCalls.push({ bucket, key, contentType });
    return `https://fake.storage/put/${bucket}/${key}?sig=up`;
  }

  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    this.generateDownloadCalls.push({ bucket, key });
    return `https://fake.storage/get/${bucket}/${key}?sig=dl`;
  }

  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return this.headResult;
  }
  async getObject(): Promise<Buffer | null> {
    return null;
  }
  async putObject(): Promise<void> {
    return;
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    this.deleted.push({ bucket, key });
  }
}

class ExplodingFileRepository extends InMemoryFileRepository {
  async create(): Promise<never> {
    throw new Error('database down');
  }
}

function createAuthedApp(tenantId: string, role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'session-1',
      tenantId,
      role,
    };
    next();
  });
  return app;
}

describe('files router', () => {
  let app: express.Express;
  let fileRepo: InMemoryFileRepository;
  let auditRepo: InMemoryAuditRepository;
  let storage: FakeStorageProvider;

  beforeEach(() => {
    app = createAuthedApp(TENANT_ID);
    fileRepo = new InMemoryFileRepository();
    auditRepo = new InMemoryAuditRepository();
    storage = new FakeStorageProvider();
    app.use('/api/files', createFilesRouter({ fileRepo, storage, bucket: BUCKET, auditRepo, jobRepo: noJobs }));
  });

  describe('#1200 item 3 — a job-scoped generic upload must name a real job in this tenant', () => {
    function appFor(tenantId: string) {
      const a = createAuthedApp(tenantId);
      a.use('/api/files', createFilesRouter({ fileRepo, storage, bucket: BUCKET, auditRepo, jobRepo: oneJob }));
      return a;
    }
    const body = (entityId: string) => ({
      filename: 'site.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 100,
      entityType: 'job',
      entityId,
    });

    it('404s and writes no files row for a well-formed unknown job id', async () => {
      const res = await request(appFor(TENANT_ID)).post('/api/files/upload-url').send(body('7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e'));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await fileRepo.findByEntity(TENANT_ID, 'job', '7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e')).toEqual([]);
      expect(storage.generateUploadCalls).toHaveLength(0);
    });

    it("404s for another tenant's job id (tenant-scoped lookup)", async () => {
      const res = await request(appFor(OTHER_TENANT_ID)).post('/api/files/upload').send(body(KNOWN_JOB_ID));
      expect(res.status).toBe(404);
      expect(await fileRepo.findByEntity(OTHER_TENANT_ID, 'job', KNOWN_JOB_ID)).toEqual([]);
    });

    it('404s (not 500) for a malformed job id', async () => {
      const res = await request(appFor(TENANT_ID)).post('/api/files/upload-url').send(body('not-a-uuid'));
      expect(res.status).toBe(404);
      expect(await fileRepo.findByEntity(TENANT_ID, 'job', 'not-a-uuid')).toEqual([]);
    });

    it('still 201s for a real job in this tenant, and for uploads with no job linkage', async () => {
      const ok = await request(appFor(TENANT_ID)).post('/api/files/upload-url').send(body(KNOWN_JOB_ID));
      expect(ok.status).toBe(201);
      expect(ok.body.fileRecord).toMatchObject({ entityType: 'job', entityId: KNOWN_JOB_ID });
      const loose = await request(appFor(TENANT_ID))
        .post('/api/files/upload-url')
        .send({ filename: 'a.webm', contentType: 'audio/webm', sizeBytes: 5, entityType: 'voice_recording' });
      expect(loose.status).toBe(201);
    });
  });

  describe('POST /api/files/upload-url', () => {
    it('creates a file record and returns a signed PUT url', async () => {
      const res = await request(app)
        .post('/api/files/upload-url')
        .send({
          filename: 'voice-123.webm',
          contentType: 'audio/webm',
          sizeBytes: 12345,
          entityType: 'voice_recording',
        });

      expect(res.status).toBe(201);
      expect(res.body.fileId).toBeTruthy();
      expect(res.body.uploadUrl).toContain('/put/');
      expect(res.body.downloadUrl).toContain('/get/');
      expect(res.body.fileRecord.tenantId).toBe(TENANT_ID);
      expect(res.body.fileRecord.storageKey).toContain(TENANT_ID);
      expect(res.body.fileRecord.storageKey).toContain('voice-123.webm');
      expect(storage.generateUploadCalls).toHaveLength(1);
      expect(storage.generateUploadCalls[0].contentType).toBe('audio/webm');
    });

    it('emits an audit event for the upload request', async () => {
      const res = await request(app)
        .post('/api/files/upload-url')
        .send({
          filename: 'voice-audit.webm',
          contentType: 'audio/webm',
          sizeBytes: 100,
        });
      expect(res.status).toBe(201);
      const events = auditRepo.getAll();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantId: TENANT_ID,
        actorId: 'user-1',
        eventType: 'file.upload_requested',
        entityType: 'file',
        entityId: res.body.fileId,
      });
    });

    it('returns a typed error when the repo throws', async () => {
      const brokenApp = createAuthedApp(TENANT_ID);
      const brokenRepo = new ExplodingFileRepository();
      brokenApp.use(
        '/api/files',
        createFilesRouter({ fileRepo: brokenRepo, storage, bucket: BUCKET, auditRepo, jobRepo: noJobs })
      );
      const res = await request(brokenApp)
        .post('/api/files/upload-url')
        .send({
          filename: 'x.webm',
          contentType: 'audio/webm',
          sizeBytes: 10,
        });
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });

    it('rejects unsupported content types', async () => {
      const res = await request(app)
        .post('/api/files/upload-url')
        .send({
          filename: 'evil.exe',
          contentType: 'application/x-msdownload',
          sizeBytes: 100,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects filenames with path traversal', async () => {
      const res = await request(app)
        .post('/api/files/upload-url')
        .send({
          filename: '../../etc/passwd',
          contentType: 'text/plain',
          sizeBytes: 10,
        });
      expect(res.status).toBe(400);
    });

    it('rejects payloads over 100MB', async () => {
      const res = await request(app)
        .post('/api/files/upload-url')
        .send({
          filename: 'huge.webm',
          contentType: 'audio/webm',
          sizeBytes: 200 * 1024 * 1024,
        });
      expect(res.status).toBe(400);
    });

    it('/upload alias returns the same shape', async () => {
      const res = await request(app)
        .post('/api/files/upload')
        .send({
          filename: 'voice-alias.webm',
          contentType: 'audio/webm',
          sizeBytes: 512,
        });
      expect(res.status).toBe(201);
      expect(res.body.uploadUrl).toBeTruthy();
      expect(res.body.downloadUrl).toBeTruthy();
    });
  });

  describe('GET /api/files/:id', () => {
    it('returns the file record for the owning tenant', async () => {
      const create = await request(app)
        .post('/api/files/upload-url')
        .send({ filename: 'a.webm', contentType: 'audio/webm', sizeBytes: 1 });
      const fileId = create.body.fileId as string;

      const res = await request(app).get(`/api/files/${fileId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(fileId);
    });

    it('404s for a missing id', async () => {
      const res = await request(app).get('/api/files/does-not-exist');
      expect(res.status).toBe(404);
    });

    it('does not leak records across tenants', async () => {
      const create = await request(app)
        .post('/api/files/upload-url')
        .send({ filename: 'a.webm', contentType: 'audio/webm', sizeBytes: 1 });
      const fileId = create.body.fileId as string;

      const otherApp = createAuthedApp(OTHER_TENANT_ID);
      otherApp.use(
        '/api/files',
        createFilesRouter({ fileRepo, storage, bucket: BUCKET, auditRepo, jobRepo: noJobs })
      );

      const res = await request(otherApp).get(`/api/files/${fileId}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/files/:id/verify', () => {
    it('reconciles sizeBytes against the HEAD result', async () => {
      const create = await request(app)
        .post('/api/files/upload-url')
        .send({ filename: 'v.webm', contentType: 'audio/webm', sizeBytes: 100 });
      const fileId = create.body.fileId as string;
      storage.headResult = { contentLength: 5000, contentType: 'audio/webm' };

      const res = await request(app).post(`/api/files/${fileId}/verify`);
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.actualSizeBytes).toBe(5000);
      expect(res.body.fileRecord.sizeBytes).toBe(5000);
    });

    it('rejects and deletes objects larger than MAX_FILE_SIZE', async () => {
      const create = await request(app)
        .post('/api/files/upload-url')
        .send({ filename: 'big.webm', contentType: 'audio/webm', sizeBytes: 100 });
      const fileId = create.body.fileId as string;
      storage.headResult = { contentLength: MAX_FILE_SIZE + 1, contentType: 'audio/webm' };

      const res = await request(app).post(`/api/files/${fileId}/verify`);
      expect(res.status).toBe(413);
      expect(storage.deleted).toHaveLength(1);
      const after = await fileRepo.findById(TENANT_ID, fileId);
      expect(after).toBeNull();
    });

    it('skips reconciliation when metadata is unavailable (dev provider)', async () => {
      const create = await request(app)
        .post('/api/files/upload-url')
        .send({ filename: 'dev.webm', contentType: 'audio/webm', sizeBytes: 200 });
      const fileId = create.body.fileId as string;
      storage.headResult = null;

      const res = await request(app).post(`/api/files/${fileId}/verify`);
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(false);
      expect(res.body.reason).toBe('metadata_unavailable');
      const after = await fileRepo.findById(TENANT_ID, fileId);
      expect(after?.sizeBytes).toBe(200);
    });

    it('404s for a missing file id', async () => {
      const res = await request(app).post('/api/files/nope/verify');
      expect(res.status).toBe(404);
    });
  });
});
