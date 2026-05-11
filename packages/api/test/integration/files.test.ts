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