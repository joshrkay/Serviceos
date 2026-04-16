import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createFilesRouter } from '../../src/routes/files';
import { InMemoryFileRepository, StorageProvider } from '../../src/files/file-service';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-files-1';
const OTHER_TENANT_ID = 'tenant-files-2';
const BUCKET = 'serviceos-test';

class FakeStorageProvider implements StorageProvider {
  generateUploadCalls: Array<{ bucket: string; key: string; contentType: string }> = [];
  generateDownloadCalls: Array<{ bucket: string; key: string }> = [];

  async generateUploadUrl(bucket: string, key: string, contentType: string): Promise<string> {
    this.generateUploadCalls.push({ bucket, key, contentType });
    return `https://fake.storage/put/${bucket}/${key}?sig=up`;
  }

  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    this.generateDownloadCalls.push({ bucket, key });
    return `https://fake.storage/get/${bucket}/${key}?sig=dl`;
  }

  async deleteObject(): Promise<void> {}
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
  let storage: FakeStorageProvider;

  beforeEach(() => {
    app = createAuthedApp(TENANT_ID);
    fileRepo = new InMemoryFileRepository();
    storage = new FakeStorageProvider();
    app.use('/api/files', createFilesRouter({ fileRepo, storage, bucket: BUCKET }));
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
      expect(res.body.audioUrl).toContain('/get/');
      expect(res.body.fileRecord.tenantId).toBe(TENANT_ID);
      expect(res.body.fileRecord.storageKey).toContain(TENANT_ID);
      expect(res.body.fileRecord.storageKey).toContain('voice-123.webm');
      expect(storage.generateUploadCalls).toHaveLength(1);
      expect(storage.generateUploadCalls[0].contentType).toBe('audio/webm');
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

    it('does not leak records across tenants', async () => {
      const create = await request(app)
        .post('/api/files/upload-url')
        .send({ filename: 'a.webm', contentType: 'audio/webm', sizeBytes: 1 });
      const fileId = create.body.fileId as string;

      const otherApp = createAuthedApp(OTHER_TENANT_ID);
      otherApp.use('/api/files', createFilesRouter({ fileRepo, storage, bucket: BUCKET }));

      const res = await request(otherApp).get(`/api/files/${fileId}`);
      expect(res.status).toBe(404);
    });
  });
});
