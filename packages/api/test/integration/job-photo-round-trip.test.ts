/**
 * §8.5 row 5.2 (ticket #1018) — before/after photos attached to a job, at
 * REAL Postgres.
 *
 * G1 (#1006, PR #1027): 5.2 was 3 — the only proofs were in-memory
 * (test/jobs/job-photos.test.ts, test/attachments/*, test/routes/
 * attachments.route.test.ts). No integration test opened a real pool. This
 * file exercises the real path end to end:
 *
 *   real createJobPhotosRouter (routes/job-photos.ts) + JobPhotoService
 *   + PgJobPhotoRepository + PgFileRepository + PgAttachmentRepository
 *   (RV-005 shadow write) + PgAuditRepository
 *     → presign-upload → attach → a real `job_photos` row, a real shadow
 *       `attachments` row, and a real `audit_events` row read back through
 *       PgAuditRepository.findByEntity (not an InMemoryAuditRepository).
 *
 * T1: a neighbour tenant cannot receive the photo (attach 404s — the file
 * row is invisible under RLS) and cannot list it (listing scoped by
 * tenant_id returns empty), and direct repo reads (job_photos, attachments,
 * audit_events) for the neighbour tenant come back empty/null.
 *
 * CLAUDE.md: tests that mock the DB are never the only proof a query
 * works. Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
} from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgFileRepository } from '../../src/files/pg-file';
import { PgAttachmentRepository } from '../../src/attachments/pg-attachment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobPhotoRepository } from '../../src/jobs/pg-job-photo';
import { JobPhotoService } from '../../src/jobs/job-photo-service';
import { createJobPhotosRouter } from '../../src/routes/job-photos';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { ObjectMetadata, StorageProvider } from '../../src/files/file-service';

const BUCKET = 'serviceos-job-photos-it';

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

function buildApp(pool: Pool, tenantId: string, userId: string) {
  const fileRepo = new PgFileRepository(pool);
  const photoRepo = new PgJobPhotoRepository(pool);
  const attachmentRepo = new PgAttachmentRepository(pool);
  const auditRepo = new PgAuditRepository(pool);
  const storage = new FakeStorageProvider();
  const service = new JobPhotoService(photoRepo, fileRepo, storage, attachmentRepo);

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId,
      sessionId: `session-${userId}`,
      tenantId,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use('/api/jobs', createJobPhotosRouter({ service, fileRepo, storage, bucket: BUCKET, auditRepo }));
  return { app, auditRepo, photoRepo, attachmentRepo, fileRepo };
}

async function createTestJob(
  pool: Pool,
  tenantId: string,
  userId: string,
): Promise<string> {
  const customerRepo = new PgCustomerRepository(pool);
  const locationRepo = new PgLocationRepository(pool);
  const jobRepo = new PgJobRepository(pool);

  const customerId = crypto.randomUUID();
  await customerRepo.create({
    id: customerId,
    tenantId,
    firstName: 'Photo',
    lastName: 'Customer',
    displayName: 'Photo Customer',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const locationId = crypto.randomUUID();
  await locationRepo.create({
    id: locationId,
    tenantId,
    customerId,
    street1: '1 Photo Way',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'USA',
    isPrimary: true,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const jobId = crypto.randomUUID();
  await jobRepo.create({
    id: jobId,
    tenantId,
    customerId,
    locationId,
    jobNumber: 'JOB-PHOTO-1',
    summary: 'Photo round trip job',
    status: 'scheduled',
    priority: 'normal',
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return jobId;
}

describe('Postgres integration — job-photo round trip (§8.5 5.2, #1018)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;
  let fileId: string;
  let photoId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    jobId = await createTestJob(pool, tenant.tenantId, tenant.userId);

    const { app } = buildApp(pool, tenant.tenantId, tenant.userId);

    const presign = await request(app)
      .post(`/api/jobs/${jobId}/photos/presign-upload`)
      .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 2048 });
    expect(presign.status).toBe(201);
    fileId = presign.body.fileId as string;

    const attach = await request(app)
      .post(`/api/jobs/${jobId}/photos`)
      .send({ fileId, category: 'before', notes: 'front of unit' });
    expect(attach.status).toBe(201);
    photoId = attach.body.id as string;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a real job_photos row (read back directly from Postgres)', async () => {
    const { rows } = await pool.query(
      `SELECT tenant_id, job_id, file_id, category, notes FROM job_photos WHERE id = $1`,
      [photoId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].job_id).toBe(jobId);
    expect(rows[0].file_id).toBe(fileId);
    expect(rows[0].category).toBe('before');
    expect(rows[0].notes).toBe('front of unit');
  });

  it('RV-005 shadow-writes a real attachments row for the same file + job', async () => {
    const attachmentRepo = new PgAttachmentRepository(pool);
    const shadow = await attachmentRepo.findByFileId(tenant.tenantId, fileId, 'job', jobId);
    expect(shadow).not.toBeNull();
    expect(shadow!.entityType).toBe('job');
    expect(shadow!.entityId).toBe(jobId);
    expect(shadow!.kind).toBe('photo');
    expect(shadow!.category).toBe('before');
  });

  it('reads the attachment audit event back through PgAuditRepository.findByEntity', async () => {
    const auditRepo = new PgAuditRepository(pool);
    const events = await auditRepo.findByEntity(tenant.tenantId, 'job', jobId);
    const attached = events.filter((e) => e.eventType === 'job.photo.attached');
    expect(attached).toHaveLength(1);
    expect(attached[0].actorId).toBe(tenant.userId);
    expect(attached[0].metadata).toMatchObject({ photoId, fileId, category: 'before' });
  });

  it('lists the photo back through the real service (GET /photos)', async () => {
    const { app } = buildApp(pool, tenant.tenantId, tenant.userId);
    const res = await request(app).get(`/api/jobs/${jobId}/photos`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(photoId);
    expect(res.body[0].category).toBe('before');
    expect(res.body[0].downloadUrl).toContain('/get/');
  });

  describe('T1 — a neighbour tenant', () => {
    it('cannot list the photo (cross-tenant listing is empty)', async () => {
      const other = await createTestTenant(pool);
      const { app } = buildApp(pool, other.tenantId, other.userId);
      const res = await request(app).get(`/api/jobs/${jobId}/photos`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('cannot receive the photo (attach with the same fileId 404s — file invisible under RLS)', async () => {
      const other = await createTestTenant(pool);
      const otherJobId = await createTestJob(pool, other.tenantId, other.userId);
      const { app } = buildApp(pool, other.tenantId, other.userId);

      const attach = await request(app)
        .post(`/api/jobs/${otherJobId}/photos`)
        .send({ fileId, category: 'before' });
      expect(attach.status).toBe(404);
    });

    it('cannot read the job_photos row directly (PgJobPhotoRepository.findById scoped by tenant)', async () => {
      const other = await createTestTenant(pool);
      const photoRepo = new PgJobPhotoRepository(pool);
      const found = await photoRepo.findById(other.tenantId, photoId);
      expect(found).toBeNull();
    });

    it('cannot read the shadow attachments row directly (PgAttachmentRepository.listByEntity scoped by tenant)', async () => {
      const other = await createTestTenant(pool);
      const attachmentRepo = new PgAttachmentRepository(pool);
      const rows = await attachmentRepo.listByEntity(other.tenantId, 'job', jobId);
      expect(rows).toEqual([]);
    });

    it('cannot read the audit event directly (PgAuditRepository.findByEntity scoped by tenant)', async () => {
      const other = await createTestTenant(pool);
      const auditRepo = new PgAuditRepository(pool);
      const events = await auditRepo.findByEntity(other.tenantId, 'job', jobId);
      expect(events).toEqual([]);
    });
  });
});
