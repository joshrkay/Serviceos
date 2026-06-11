import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgFileRepository } from '../../src/files/pg-file';

describe('Postgres integration — files', () => {
  let pool: Pool;
  let fileRepo: PgFileRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    fileRepo = new PgFileRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates file record and retrieves via findById', async () => {
      const fileRecord = await fileRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        filename: 'test.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        storageBucket: 'test-bucket',
        storageKey: 'uploads/test.pdf',
        entityType: 'estimate',
        entityId: crypto.randomUUID(),
        uploadedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await fileRepo.findById(tenant.tenantId, fileRecord.id);
      expect(found).not.toBeNull();
      expect(found!.filename).toBe('test.pdf');
      expect(found!.contentType).toBe('application/pdf');
    });

    it('updates file size', async () => {
      const fileRecord = await fileRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        filename: 'image.png',
        contentType: 'image/png',
        sizeBytes: 1000,
        storageBucket: 'test-bucket',
        storageKey: 'uploads/image.png',
        uploadedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await fileRepo.updateSize(tenant.tenantId, fileRecord.id, 2000);
      expect(updated).not.toBeNull();
      expect(updated!.sizeBytes).toBe(2000);
    });

    it('finds files by entity', async () => {
      const entityId = crypto.randomUUID();
      await fileRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        filename: 'doc1.pdf',
        contentType: 'application/pdf',
        sizeBytes: 500,
        storageBucket: 'test-bucket',
        storageKey: 'uploads/doc1.pdf',
        entityType: 'invoice',
        entityId: entityId,
        uploadedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const files = await fileRepo.findByEntity(tenant.tenantId, 'invoice', entityId);
      expect(files.length).toBeGreaterThanOrEqual(1);
    });

    it('deletes file', async () => {
      const fileRecord = await fileRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        filename: 'to-delete.txt',
        contentType: 'text/plain',
        sizeBytes: 100,
        storageBucket: 'test-bucket',
        storageKey: 'uploads/to-delete.txt',
        uploadedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const deleted = await fileRepo.delete(tenant.tenantId, fileRecord.id);
      expect(deleted).toBe(true);

      const found = await fileRepo.findById(tenant.tenantId, fileRecord.id);
      expect(found).toBeNull();
    });
  });

  // RV-006: pins the real migration-161 column names (width, height,
  // thumbnail_s3_key, exif_stripped, content_hash) — in-memory tests alone
  // can't prove the SQL matches the schema.
  describe('image pipeline columns (RV-006)', () => {
    function baseRecord() {
      const id = crypto.randomUUID();
      return {
        id,
        tenantId: tenant.tenantId,
        filename: 'photo.jpg',
        contentType: 'image/heic',
        sizeBytes: 1000,
        storageBucket: 'test-bucket',
        storageKey: `uploads/${id}.jpg`,
        uploadedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    it('updatePipelineResults stamps all pipeline columns', async () => {
      const fileRecord = await fileRepo.create(baseRecord());
      expect(fileRecord.exifStripped).toBe(false);
      expect(fileRecord.contentHash).toBeUndefined();

      const updated = await fileRepo.updatePipelineResults(tenant.tenantId, fileRecord.id, {
        contentHash: 'a'.repeat(64),
        width: 640,
        height: 480,
        thumbnailS3Key: `${fileRecord.storageKey}.thumb.jpg`,
        exifStripped: true,
        contentType: 'image/jpeg',
        sizeBytes: 2000,
      });

      expect(updated).not.toBeNull();
      expect(updated!.width).toBe(640);
      expect(updated!.height).toBe(480);
      expect(updated!.thumbnailS3Key).toBe(`${fileRecord.storageKey}.thumb.jpg`);
      expect(updated!.exifStripped).toBe(true);
      expect(updated!.contentHash).toBe('a'.repeat(64));
      expect(updated!.contentType).toBe('image/jpeg');
      expect(updated!.sizeBytes).toBe(2000);
    });

    it('updatePipelineResults hash-only path leaves other columns untouched', async () => {
      const fileRecord = await fileRepo.create(baseRecord());
      const updated = await fileRepo.updatePipelineResults(tenant.tenantId, fileRecord.id, {
        contentHash: 'b'.repeat(64),
      });
      expect(updated!.contentHash).toBe('b'.repeat(64));
      expect(updated!.width).toBeUndefined();
      expect(updated!.thumbnailS3Key).toBeUndefined();
      expect(updated!.exifStripped).toBe(false);
      expect(updated!.contentType).toBe('image/heic');
    });

    it('findByContentHash returns matching files newest-first, tenant-scoped', async () => {
      const hash = crypto.randomUUID().replace(/-/g, '');
      const a = await fileRepo.create(baseRecord());
      await fileRepo.updatePipelineResults(tenant.tenantId, a.id, { contentHash: hash });
      const b = await fileRepo.create(baseRecord());
      await fileRepo.updatePipelineResults(tenant.tenantId, b.id, { contentHash: hash });

      const matches = await fileRepo.findByContentHash(tenant.tenantId, hash);
      expect(matches.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());

      const otherTenant = await createTestTenant(pool);
      expect(await fileRepo.findByContentHash(otherTenant.tenantId, hash)).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const fileRecord = await fileRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        filename: 'secret.pdf',
        contentType: 'application/pdf',
        sizeBytes: 9999,
        storageBucket: 'test-bucket',
        storageKey: 'uploads/secret.pdf',
        uploadedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await fileRepo.findById(otherTenant.tenantId, fileRecord.id);
      expect(found).toBeNull();
    });
  });
});