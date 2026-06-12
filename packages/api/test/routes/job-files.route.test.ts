import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryJobFileRepository } from '../../src/files/job-file-repository';
import { ObjectMetadata, StorageProvider } from '../../src/files/file-service';
import { createJobFilesRouter } from '../../src/routes/job-files';
import { buildTestApp } from './test-app';
import express, { type Express } from 'express';

const OTHER_TENANT_ID = 'tenant-jf-2';
const BUCKET = 'serviceos-job-files-test';

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

function buildOtherTenantApp(repo: InMemoryJobFileRepository): Express {
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => {
    req.auth = {
      userId: 'user-other-1',
      sessionId: 'session-other-1',
      tenantId: OTHER_TENANT_ID,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/jobs',
    createJobFilesRouter({
      jobFileRepo: repo,
      storage: new FakeStorageProvider(),
      bucket: BUCKET,
      auditRepo: new InMemoryAuditRepository(),
    })
  );

  return app;
}

describe('job files router', () => {
  let app: Express;
  let repo: InMemoryJobFileRepository;

  beforeEach(async () => {
    const built = await buildTestApp();
    repo = new InMemoryJobFileRepository();
    built.app.use(
      '/api/jobs',
      createJobFilesRouter({
        jobFileRepo: repo,
        storage: new FakeStorageProvider(),
        bucket: BUCKET,
        auditRepo: new InMemoryAuditRepository(),
      })
    );
    app = built.app;
  });

  it('mounts at /api/jobs and supports upload/list/delete through /:id/files paths', async () => {
    const createdJob = await request(app).post('/api/jobs').send({
      customerId: 'cust-photo-1',
      locationId: 'loc-photo-1',
      summary: 'Job with photo bucket',
    });
    expect(createdJob.status).toBe(201);

    const upload = await request(app)
      .post(`/api/jobs/${createdJob.body.id}/files/upload-url`)
      .send({
        filename: 'before.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      });

    expect(upload.status).toBe(201);
    expect(upload.body.fileId).toBeTruthy();
    expect(upload.body.fileRecord.jobId).toBe(createdJob.body.id);

    const list = await request(app).get(`/api/jobs/${createdJob.body.id}/files`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].jobId).toBe(createdJob.body.id);
    expect(list.body[0].downloadUrl).toContain('/get/');

    const remove = await request(app).delete(
      `/api/jobs/${createdJob.body.id}/files/${upload.body.fileId}`
    );
    expect(remove.status).toBe(204);

    const afterDelete = await request(app).get(`/api/jobs/${createdJob.body.id}/files`);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body).toHaveLength(0);
  });

  it('enforces tenant boundaries for list/delete', async () => {
    const createdJob = await request(app).post('/api/jobs').send({
      customerId: 'cust-photo-2',
      locationId: 'loc-photo-2',
      summary: 'Tenant isolation photo job',
    });
    expect(createdJob.status).toBe(201);

    const upload = await request(app)
      .post(`/api/jobs/${createdJob.body.id}/files/upload-url`)
      .send({ filename: 'photo.png', contentType: 'image/png', sizeBytes: 100 });
    expect(upload.status).toBe(201);

    const otherTenantApp = buildOtherTenantApp(repo);
    const list = await request(otherTenantApp).get(`/api/jobs/${createdJob.body.id}/files`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(0);

    const remove = await request(otherTenantApp).delete(
      `/api/jobs/${createdJob.body.id}/files/${upload.body.fileId}`
    );
    expect(remove.status).toBe(404);
  });
});
