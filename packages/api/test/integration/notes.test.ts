import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgNoteRepository } from '../../src/notes/pg-note';

describe('Postgres integration — notes', () => {
  let pool: Pool;
  let noteRepo: PgNoteRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    noteRepo = new PgNoteRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates note and retrieves via findById', async () => {
      const note = await noteRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        entityType: 'customer',
        entityId: crypto.randomUUID(),
        content: 'Test note content',
        authorId: tenant.userId,
        authorRole: 'owner',
        isPinned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await noteRepo.findById(tenant.tenantId, note.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe('Test note content');
      expect(found!.entityType).toBe('customer');
    });

    it('updates note and reflects in findById', async () => {
      const note = await noteRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        entityType: 'job',
        entityId: crypto.randomUUID(),
        content: 'Original content',
        authorId: tenant.userId,
        authorRole: 'owner',
        isPinned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await noteRepo.update(tenant.tenantId, note.id, {
        content: 'Updated content',
        isPinned: true,
      });

      expect(updated).not.toBeNull();
      expect(updated!.content).toBe('Updated content');
      expect(updated!.isPinned).toBe(true);
    });

    it('finds notes by entity', async () => {
      const entityId = crypto.randomUUID();
      await noteRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        entityType: 'customer',
        entityId: entityId,
        content: 'Note for entity',
        authorId: tenant.userId,
        authorRole: 'owner',
        isPinned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const notes = await noteRepo.findByEntity(tenant.tenantId, 'customer', entityId);
      expect(notes.length).toBeGreaterThanOrEqual(1);
    });

    it('deletes note', async () => {
      const note = await noteRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        entityType: 'invoice',
        entityId: crypto.randomUUID(),
        content: 'To be deleted',
        authorId: tenant.userId,
        authorRole: 'owner',
        isPinned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const deleted = await noteRepo.delete(tenant.tenantId, note.id);
      expect(deleted).toBe(true);

      const found = await noteRepo.findById(tenant.tenantId, note.id);
      expect(found).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const note = await noteRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        entityType: 'customer',
        entityId: crypto.randomUUID(),
        content: 'Secret note',
        authorId: tenant.userId,
        authorRole: 'owner',
        isPinned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await noteRepo.findById(otherTenant.tenantId, note.id);
      expect(found).toBeNull();
    });
  });
});