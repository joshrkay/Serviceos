/**
 * RV-005 — Unit tests for AttachmentService.
 *
 * In-memory deps throughout (attachment repo, file repo, audit repo, fake
 * storage). Covers audit emission for every mutation, entity-validation
 * paths (supported, missing, NOT_SUPPORTED), and pair validation failures
 * (self, cross-entity, cross-tenant).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  AttachmentService,
  EntityLookupMap,
} from '../../src/attachments/attachment-service';
import { InMemoryAttachmentRepository } from '../../src/attachments/attachment';
import {
  InMemoryFileRepository,
  ObjectMetadata,
  StorageProvider,
  FileRecord,
} from '../../src/files/file-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AppError, NotFoundError, ValidationError } from '../../src/shared/errors';

const TENANT_A = uuidv4();
const TENANT_B = uuidv4();
const ACTOR = { userId: 'user-a-1', role: 'owner' };

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

function makeFileRecord(
  tenantId: string,
  entityType = 'job',
  entityId = 'x',
  overrides: Partial<FileRecord> = {}
): FileRecord {
  const id = overrides.id ?? uuidv4();
  return {
    id,
    tenantId,
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    storageBucket: 'test-bucket',
    storageKey: `${tenantId}/attachments/${entityType}/${entityId}/${id}-photo.jpg`,
    entityType,
    entityId,
    uploadedBy: ACTOR.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AttachmentService', () => {
  let attachmentRepo: InMemoryAttachmentRepository;
  let fileRepo: InMemoryFileRepository;
  let auditRepo: InMemoryAuditRepository;
  let service: AttachmentService;
  let jobId: string;
  let invoiceId: string;
  let knownJobs: Set<string>;
  let knownInvoices: Set<string>;

  beforeEach(() => {
    attachmentRepo = new InMemoryAttachmentRepository();
    fileRepo = new InMemoryFileRepository();
    auditRepo = new InMemoryAuditRepository();
    jobId = uuidv4();
    invoiceId = uuidv4();
    knownJobs = new Set([jobId]);
    knownInvoices = new Set([invoiceId]);
    const lookups: EntityLookupMap = {
      job: async (_tenantId, id) => knownJobs.has(id),
      invoice: async (_tenantId, id) => knownInvoices.has(id),
      estimate: async () => true,
    };
    service = new AttachmentService(
      attachmentRepo,
      fileRepo,
      new FakeStorageProvider(),
      auditRepo,
      lookups
    );
  });

  async function seedFile(
    tenantId = TENANT_A,
    entityType = 'job',
    entityId = jobId
  ): Promise<FileRecord> {
    return fileRepo.create(makeFileRecord(tenantId, entityType, entityId));
  }

  describe('attach', () => {
    it('creates an attachment and emits attachment.uploaded', async () => {
      const file = await seedFile();
      const attachment = await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
        category: 'before',
        caption: 'Leaky valve',
      });

      expect(attachment.tenantId).toBe(TENANT_A);
      expect(attachment.fileId).toBe(file.id);
      expect(attachment.uploadedBy).toBe(ACTOR.userId);
      expect(attachment.source).toBe('app');
      expect(attachment.portalVisible).toBe(false);

      const events = auditRepo.getAll();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('attachment.uploaded');
      expect(events[0].entityType).toBe('job');
      expect(events[0].entityId).toBe(jobId);
      expect(events[0].metadata).toMatchObject({
        attachmentId: attachment.id,
        fileId: file.id,
        kind: 'photo',
        category: 'before',
        source: 'app',
      });
    });

    it('rejects when the file does not exist in this tenant', async () => {
      const fileInB = await fileRepo.create(makeFileRecord(TENANT_B));
      await expect(
        service.attach(TENANT_A, ACTOR, {
          fileId: fileInB.id,
          entityType: 'job',
          entityId: jobId,
          kind: 'photo',
        })
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(auditRepo.getAll()).toHaveLength(0);
      expect(await attachmentRepo.listByEntity(TENANT_A, 'job', jobId)).toHaveLength(0);
    });

    it('rejects when the target entity does not exist', async () => {
      // Seed the file for the nonexistent job so the entity-mismatch guard
      // passes and the entity-existence check fires instead.
      const unknownJobId = uuidv4();
      const file = await seedFile(TENANT_A, 'job', unknownJobId);
      await expect(
        service.attach(TENANT_A, ACTOR, {
          fileId: file.id,
          entityType: 'job',
          entityId: unknownJobId,
          kind: 'photo',
        })
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(auditRepo.getAll()).toHaveLength(0);
    });

    it('validates invoice entities through the invoice lookup', async () => {
      const file = await seedFile(TENANT_A, 'invoice', invoiceId);
      const attachment = await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'invoice',
        entityId: invoiceId,
        kind: 'document',
        category: 'receipt',
      });
      expect(attachment.entityType).toBe('invoice');
    });

    it('returns NOT_SUPPORTED for entity types without a wired lookup', async () => {
      // Seed the file for the same expense entity so the entity-mismatch guard
      // passes and assertEntityExists fires to give NOT_SUPPORTED.
      const expenseId = uuidv4();
      const file = await seedFile(TENANT_A, 'expense', expenseId);
      const err = await service
        .attach(TENANT_A, ACTOR, {
          fileId: file.id,
          entityType: 'expense',
          entityId: expenseId,
          kind: 'photo',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('NOT_SUPPORTED');
      expect((err as AppError).statusCode).toBe(400);
      expect(auditRepo.getAll()).toHaveLength(0);
    });

    it('rejects a file presigned for job A when attached to job B (entity mismatch → ValidationError, no attachment created)', async () => {
      const jobA = jobId; // already in knownJobs
      const jobB = uuidv4();
      knownJobs.add(jobB);
      // File was presigned for job A
      const file = await seedFile(TENANT_A, 'job', jobA);
      await expect(
        service.attach(TENANT_A, ACTOR, {
          fileId: file.id,
          entityType: 'job',
          entityId: jobB, // different job
          kind: 'photo',
        })
      ).rejects.toBeInstanceOf(ValidationError);
      // No audit event, no attachment row
      expect(auditRepo.getAll()).toHaveLength(0);
      expect(await attachmentRepo.listByEntity(TENANT_A, 'job', jobB)).toHaveLength(0);
    });

    it('accepts a file when entity type and entity id both match the presigned values (control case)', async () => {
      const file = await seedFile(TENANT_A, 'job', jobId);
      const attachment = await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });
      expect(attachment.fileId).toBe(file.id);
      expect(attachment.entityId).toBe(jobId);
      expect(auditRepo.getAll()).toHaveLength(1);
    });
  });

  describe('listForEntity', () => {
    it('returns attachments with presigned download URLs and file metadata', async () => {
      const file = await seedFile();
      await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });

      const listed = await service.listForEntity(TENANT_A, 'job', jobId);
      expect(listed).toHaveLength(1);
      expect(listed[0].downloadUrl).toContain(`/get/test-bucket/${file.storageKey}`);
      expect(listed[0].filename).toBe('photo.jpg');
      expect(listed[0].contentType).toBe('image/jpeg');
      expect(listed[0].sizeBytes).toBe(1024);
    });

    it('surfaces a placeholder when the underlying file row is gone', async () => {
      const file = await seedFile();
      await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });
      await fileRepo.delete(TENANT_A, file.id);

      const listed = await service.listForEntity(TENANT_A, 'job', jobId);
      expect(listed).toHaveLength(1);
      expect(listed[0].downloadUrl).toBe('');
      expect(listed[0].filename).toBe('');
    });

    it('excludes archived attachments unless includeArchived is set', async () => {
      const file = await seedFile();
      const attachment = await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });
      await service.archive(TENANT_A, ACTOR, attachment.id);

      expect(await service.listForEntity(TENANT_A, 'job', jobId)).toHaveLength(0);
      const withArchived = await service.listForEntity(TENANT_A, 'job', jobId, {
        includeArchived: true,
      });
      expect(withArchived).toHaveLength(1);
      expect(withArchived[0].archivedAt).toBeInstanceOf(Date);
    });
  });

  describe('archive', () => {
    it('soft deletes and emits attachment.archived', async () => {
      const file = await seedFile();
      const attachment = await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });

      const archived = await service.archive(TENANT_A, ACTOR, attachment.id);
      expect(archived.archivedAt).toBeInstanceOf(Date);
      // Underlying file row is untouched (soft delete only).
      expect(await fileRepo.findById(TENANT_A, file.id)).not.toBeNull();

      const events = auditRepo.getAll().map((e) => e.eventType);
      expect(events).toContain('attachment.archived');
    });

    it('throws NOT_FOUND for an attachment in another tenant', async () => {
      const file = await seedFile();
      const attachment = await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });
      await expect(service.archive(TENANT_B, ACTOR, attachment.id)).rejects.toBeInstanceOf(
        NotFoundError
      );
    });
  });

  describe('setPortalVisibility', () => {
    it('updates visibility and emits attachment.visibility_changed', async () => {
      const file = await seedFile();
      const attachment = await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });

      const updated = await service.setPortalVisibility(TENANT_A, ACTOR, attachment.id, true);
      expect(updated.portalVisible).toBe(true);

      const event = auditRepo
        .getAll()
        .find((e) => e.eventType === 'attachment.visibility_changed');
      expect(event).toBeDefined();
      expect(event!.metadata).toMatchObject({
        attachmentId: attachment.id,
        portalVisible: true,
      });
    });

    it('throws NOT_FOUND for unknown attachments', async () => {
      await expect(
        service.setPortalVisibility(TENANT_A, ACTOR, uuidv4(), true)
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('pair', () => {
    async function seedAttachment(entityId: string, entityType: 'job' | 'invoice' = 'job') {
      const file = await seedFile(TENANT_A, entityType, entityId);
      return service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType,
        entityId,
        kind: 'photo',
      });
    }

    it('assigns a shared pair_group_id with opposite roles and emits attachment.paired', async () => {
      const before = await seedAttachment(jobId);
      const after = await seedAttachment(jobId);

      const result = await service.pair(TENANT_A, ACTOR, before.id, after.id, 'before');
      expect(result.pairGroupId).toBeTruthy();
      expect(result.attachment.pairGroupId).toBe(result.pairGroupId);
      expect(result.other.pairGroupId).toBe(result.pairGroupId);
      expect(result.attachment.pairRole).toBe('before');
      expect(result.other.pairRole).toBe('after');

      const event = auditRepo.getAll().find((e) => e.eventType === 'attachment.paired');
      expect(event).toBeDefined();
      expect(event!.metadata).toMatchObject({ pairGroupId: result.pairGroupId });
    });

    it('assigns the opposite roles when called with role=after', async () => {
      const a = await seedAttachment(jobId);
      const b = await seedAttachment(jobId);
      const result = await service.pair(TENANT_A, ACTOR, a.id, b.id, 'after');
      expect(result.attachment.pairRole).toBe('after');
      expect(result.other.pairRole).toBe('before');
    });

    it('rejects pairing an attachment with itself', async () => {
      const a = await seedAttachment(jobId);
      await expect(service.pair(TENANT_A, ACTOR, a.id, a.id, 'before')).rejects.toBeInstanceOf(
        ValidationError
      );
    });

    it('rejects pairing across different entities', async () => {
      const a = await seedAttachment(jobId, 'job');
      const b = await seedAttachment(invoiceId, 'invoice');
      await expect(service.pair(TENANT_A, ACTOR, a.id, b.id, 'before')).rejects.toBeInstanceOf(
        ValidationError
      );
      expect(auditRepo.getAll().some((e) => e.eventType === 'attachment.paired')).toBe(false);
    });

    it('rejects pairing across different entity ids of the same type', async () => {
      const otherJobId = uuidv4();
      knownJobs.add(otherJobId);
      const a = await seedAttachment(jobId);
      const b = await seedAttachment(otherJobId);
      await expect(service.pair(TENANT_A, ACTOR, a.id, b.id, 'before')).rejects.toBeInstanceOf(
        ValidationError
      );
    });

    it('treats cross-tenant attachments as not found', async () => {
      const a = await seedAttachment(jobId);
      // Tenant B attachment, created directly through the repo (lookups are
      // tenant-agnostic stubs here; the tenant boundary is what we test).
      const fileB = await fileRepo.create(makeFileRecord(TENANT_B, 'job', jobId));
      const b = await attachmentRepo.create(TENANT_B, {
        fileId: fileB.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });

      await expect(service.pair(TENANT_A, ACTOR, a.id, b.id, 'before')).rejects.toBeInstanceOf(
        NotFoundError
      );
      // No partial pairing happened.
      const reloaded = await attachmentRepo.findById(TENANT_A, a.id);
      expect(reloaded!.pairGroupId).toBeUndefined();
    });

    it('clears pair fields on orphaned members when re-pairing (A-B paired, pair(A,C) → B has null pair fields)', async () => {
      const a = await seedAttachment(jobId);
      const b = await seedAttachment(jobId);
      const c = await seedAttachment(jobId);

      // First pair: A-B
      await service.pair(TENANT_A, ACTOR, a.id, b.id, 'before');
      const bAfterFirst = await attachmentRepo.findById(TENANT_A, b.id);
      expect(bAfterFirst!.pairGroupId).toBeTruthy();

      // Re-pair: A-C (B should be orphaned and have null pair fields)
      const result = await service.pair(TENANT_A, ACTOR, a.id, c.id, 'before');
      expect(result.attachment.pairGroupId).toBe(result.pairGroupId);
      expect(result.other.pairGroupId).toBe(result.pairGroupId);

      const bAfterRePair = await attachmentRepo.findById(TENANT_A, b.id);
      expect(bAfterRePair!.pairGroupId).toBeUndefined();
      expect(bAfterRePair!.pairRole).toBeUndefined();
    });
  });

  describe('listForEntity (portalVisibleOnly)', () => {
    it('filters to only portal-visible attachments when portalVisibleOnly is true', async () => {
      const fileA = await seedFile();
      const fileB = await seedFile();
      const attA = await service.attach(TENANT_A, ACTOR, {
        fileId: fileA.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });
      await service.attach(TENANT_A, ACTOR, {
        fileId: fileB.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });
      // Make only attA portal-visible
      await service.setPortalVisibility(TENANT_A, ACTOR, attA.id, true);

      const visible = await service.listForEntity(TENANT_A, 'job', jobId, {
        portalVisibleOnly: true,
      });
      expect(visible).toHaveLength(1);
      expect(visible[0].id).toBe(attA.id);

      const all = await service.listForEntity(TENANT_A, 'job', jobId);
      expect(all).toHaveLength(2);
    });

    it('returns all non-archived when portalVisibleOnly is false or omitted', async () => {
      const file = await seedFile();
      await service.attach(TENANT_A, ACTOR, {
        fileId: file.id,
        entityType: 'job',
        entityId: jobId,
        kind: 'photo',
      });
      const result = await service.listForEntity(TENANT_A, 'job', jobId, {
        portalVisibleOnly: false,
      });
      expect(result).toHaveLength(1);
    });
  });
});
