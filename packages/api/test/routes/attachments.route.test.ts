/**
 * RV-005 — Route tests for the attachments surface.
 *
 * Mirrors the supertest + FakeStorageProvider pattern from
 * test/jobs/job-photos.test.ts (the presign → PUT → attach 3-step flow),
 * generalized to entityType/entityId.
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
} from '../../src/files/file-service';
import { InMemoryAttachmentRepository } from '../../src/attachments/attachment';
import { AttachmentService } from '../../src/attachments/attachment-service';
import { createAttachmentsRouter } from '../../src/routes/attachments';

const TENANT_A = uuidv4();
const TENANT_B = uuidv4();
const BUCKET = 'serviceos-attachments-test';

const JOB_ID = uuidv4();
const INVOICE_ID = uuidv4();

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
  attachmentRepo: InMemoryAttachmentRepository;
  auditRepo: InMemoryAuditRepository;
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
  const service = new AttachmentService(
    opts.attachmentRepo,
    opts.fileRepo,
    storage,
    opts.auditRepo,
    {
      job: async (_tenantId, id) => id === JOB_ID,
      invoice: async (_tenantId, id) => id === INVOICE_ID,
      estimate: async () => false,
    }
  );
  app.use(
    '/api/attachments',
    createAttachmentsRouter({
      service,
      fileRepo: opts.fileRepo,
      storage,
      bucket: BUCKET,
      auditRepo: opts.auditRepo,
    })
  );
  return app;
}

describe('attachments router (RV-005)', () => {
  let fileRepo: InMemoryFileRepository;
  let attachmentRepo: InMemoryAttachmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: Express;

  beforeEach(() => {
    fileRepo = new InMemoryFileRepository();
    attachmentRepo = new InMemoryAttachmentRepository();
    auditRepo = new InMemoryAuditRepository();
    app = buildApp({ tenantId: TENANT_A, fileRepo, attachmentRepo, auditRepo });
  });

  async function presign(overrides: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/attachments/presign')
      .send({
        entityType: 'job',
        entityId: JOB_ID,
        filename: 'before.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2048,
        ...overrides,
      });
  }

  async function attach(fileId: string, overrides: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/attachments')
      .send({
        fileId,
        entityType: 'job',
        entityId: JOB_ID,
        kind: 'photo',
        category: 'before',
        caption: 'Before the fix',
        ...overrides,
      });
  }

  describe('POST /presign', () => {
    it('creates a files row with a tenant-prefixed attachments key and returns an upload URL', async () => {
      const res = await presign();
      expect(res.status).toBe(201);
      expect(res.body.fileId).toBeTruthy();
      expect(res.body.uploadUrl).toContain('/put/');
      expect(res.body.fileRecord.storageKey).toContain(
        `${TENANT_A}/attachments/job/${JOB_ID}/`
      );
      expect(res.body.fileRecord.storageKey).toContain('-before.jpg');

      const stored = await fileRepo.findById(TENANT_A, res.body.fileId);
      expect(stored).not.toBeNull();

      const events = auditRepo.getAll().map((e) => e.eventType);
      expect(events).toContain('attachment.upload_requested');
    });

    it('rejects invalid entityType', async () => {
      const res = await presign({ entityType: 'spaceship' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects non-UUID entityId', async () => {
      const res = await presign({ entityId: 'job-1' });
      expect(res.status).toBe(400);
    });

    it('rejects disallowed content types', async () => {
      const res = await presign({ contentType: 'application/x-msdownload' });
      expect(res.status).toBe(400);
    });

    it('rejects path-traversal filenames', async () => {
      const res = await presign({ filename: '../../etc/passwd' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST / (attach)', () => {
    it('attaches a presigned file to a job and returns 201', async () => {
      const pre = await presign();
      const res = await attach(pre.body.fileId);

      expect(res.status).toBe(201);
      expect(res.body.fileId).toBe(pre.body.fileId);
      expect(res.body.entityType).toBe('job');
      expect(res.body.entityId).toBe(JOB_ID);
      expect(res.body.kind).toBe('photo');
      expect(res.body.category).toBe('before');
      expect(res.body.portalVisible).toBe(false);

      const events = auditRepo.getAll().map((e) => e.eventType);
      expect(events).toContain('attachment.uploaded');
    });

    it('rejects requests containing s3Key (cross-tenant exfiltration vector — fileId required)', async () => {
      // The attach endpoint accepts fileId only; s3Key is unknown and must be
      // rejected. Zod strict mode is not used here (the schema uses .object()
      // without .strict()), so unknown keys are stripped silently. The schema
      // requires fileId to be a valid UUID — a request without fileId (only
      // s3Key) therefore fails required-field validation.
      const res = await request(app)
        .post('/api/attachments')
        .send({
          s3Key: `${TENANT_A}/attachments/job/${JOB_ID}/external-upload.pdf`,
          filename: 'external-upload.pdf',
          contentType: 'application/pdf',
          sizeBytes: 4096,
          entityType: 'job',
          entityId: JOB_ID,
          kind: 'document',
        });
      expect(res.status).toBe(400);
    });

    it('404s when the fileId does not exist', async () => {
      const res = await attach(uuidv4());
      expect(res.status).toBe(404);
    });

    it('404s when the target entity does not exist', async () => {
      const pre = await presign();
      const res = await attach(pre.body.fileId, { entityId: uuidv4() });
      expect(res.status).toBe(404);
    });

    it('400s with NOT_SUPPORTED for entity types pending later tasks', async () => {
      const pre = await presign();
      const res = await attach(pre.body.fileId, { entityType: 'expense', entityId: uuidv4() });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NOT_SUPPORTED');
    });

    it('rejects invalid kind', async () => {
      const pre = await presign();
      const res = await attach(pre.body.fileId, { kind: 'video' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /', () => {
    it('lists attachments for an entity with presigned download URLs', async () => {
      const pre = await presign();
      await attach(pre.body.fileId);

      const res = await request(app)
        .get('/api/attachments')
        .query({ entityType: 'job', entityId: JOB_ID });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].downloadUrl).toContain('/get/');
      expect(res.body[0].filename).toBe('before.jpg');
    });

    it('requires entityType and entityId query params', async () => {
      const res = await request(app).get('/api/attachments');
      expect(res.status).toBe(400);
    });

    it('excludes archived attachments unless includeArchived=true', async () => {
      const pre = await presign();
      const attached = await attach(pre.body.fileId);
      await request(app).post(`/api/attachments/${attached.body.id}/archive`);

      const withoutArchived = await request(app)
        .get('/api/attachments')
        .query({ entityType: 'job', entityId: JOB_ID });
      expect(withoutArchived.body).toHaveLength(0);

      const withArchived = await request(app)
        .get('/api/attachments')
        .query({ entityType: 'job', entityId: JOB_ID, includeArchived: 'true' });
      expect(withArchived.body).toHaveLength(1);

      // 'false' as a query string must NOT be coerced to true.
      const explicitlyFalse = await request(app)
        .get('/api/attachments')
        .query({ entityType: 'job', entityId: JOB_ID, includeArchived: 'false' });
      expect(explicitlyFalse.body).toHaveLength(0);
    });

    it('does not leak another tenant attachments', async () => {
      const pre = await presign();
      await attach(pre.body.fileId);

      const appB = buildApp({
        tenantId: TENANT_B,
        fileRepo,
        attachmentRepo,
        auditRepo,
      });
      const res = await request(appB)
        .get('/api/attachments')
        .query({ entityType: 'job', entityId: JOB_ID });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('POST /:id/archive', () => {
    it('soft deletes the attachment and emits attachment.archived', async () => {
      const pre = await presign();
      const attached = await attach(pre.body.fileId);

      const res = await request(app).post(`/api/attachments/${attached.body.id}/archive`);
      expect(res.status).toBe(200);
      expect(res.body.archivedAt).toBeTruthy();

      const events = auditRepo.getAll().map((e) => e.eventType);
      expect(events).toContain('attachment.archived');
    });

    it('404s for attachments in another tenant', async () => {
      const pre = await presign();
      const attached = await attach(pre.body.fileId);

      const appB = buildApp({ tenantId: TENANT_B, fileRepo, attachmentRepo, auditRepo });
      const res = await request(appB).post(`/api/attachments/${attached.body.id}/archive`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /:id/visibility', () => {
    it('toggles portal visibility and emits attachment.visibility_changed', async () => {
      const pre = await presign();
      const attached = await attach(pre.body.fileId);

      const res = await request(app)
        .post(`/api/attachments/${attached.body.id}/visibility`)
        .send({ visible: true });
      expect(res.status).toBe(200);
      expect(res.body.portalVisible).toBe(true);

      const events = auditRepo.getAll().map((e) => e.eventType);
      expect(events).toContain('attachment.visibility_changed');
    });

    it('rejects a non-boolean visible payload', async () => {
      const pre = await presign();
      const attached = await attach(pre.body.fileId);
      const res = await request(app)
        .post(`/api/attachments/${attached.body.id}/visibility`)
        .send({ visible: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /:id/pair', () => {
    it('pairs two attachments of the same job with opposite roles', async () => {
      const pre1 = await presign();
      const before = await attach(pre1.body.fileId, { category: 'before' });
      const pre2 = await presign({ filename: 'after.jpg' });
      const after = await attach(pre2.body.fileId, { category: 'after' });

      const res = await request(app)
        .post(`/api/attachments/${before.body.id}/pair`)
        .send({ otherId: after.body.id, role: 'before' });

      expect(res.status).toBe(200);
      expect(res.body.pairGroupId).toBeTruthy();
      expect(res.body.attachment.pairRole).toBe('before');
      expect(res.body.other.pairRole).toBe('after');
      expect(res.body.attachment.pairGroupId).toBe(res.body.other.pairGroupId);

      const events = auditRepo.getAll().map((e) => e.eventType);
      expect(events).toContain('attachment.paired');
    });

    it('rejects pairing attachments of different entities', async () => {
      const pre1 = await presign();
      const jobAttachment = await attach(pre1.body.fileId);
      const pre2 = await presign({ entityType: 'invoice', entityId: INVOICE_ID });
      const invoiceAttachment = await attach(pre2.body.fileId, {
        entityType: 'invoice',
        entityId: INVOICE_ID,
        kind: 'document',
        category: 'receipt',
      });

      const res = await request(app)
        .post(`/api/attachments/${jobAttachment.body.id}/pair`)
        .send({ otherId: invoiceAttachment.body.id, role: 'before' });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid role', async () => {
      const pre = await presign();
      const attached = await attach(pre.body.fileId);
      const res = await request(app)
        .post(`/api/attachments/${attached.body.id}/pair`)
        .send({ otherId: uuidv4(), role: 'sideways' });
      expect(res.status).toBe(400);
    });

    it('404s when the other attachment belongs to a different tenant', async () => {
      const pre1 = await presign();
      const a = await attach(pre1.body.fileId);

      const appB = buildApp({ tenantId: TENANT_B, fileRepo, attachmentRepo, auditRepo });
      // Tenant B file + attachment on the same job id (ids are global, rows
      // are tenant-scoped).
      const preB = await request(appB).post('/api/attachments/presign').send({
        entityType: 'job',
        entityId: JOB_ID,
        filename: 'b.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
      });
      const attachedB = await request(appB).post('/api/attachments').send({
        fileId: preB.body.fileId,
        entityType: 'job',
        entityId: JOB_ID,
        kind: 'photo',
      });
      expect(attachedB.status).toBe(201);

      const res = await request(app)
        .post(`/api/attachments/${a.body.id}/pair`)
        .send({ otherId: attachedB.body.id, role: 'before' });
      expect(res.status).toBe(404);
    });
  });
});
