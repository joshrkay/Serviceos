/**
 * RV-005 — Attachment service.
 *
 * Orchestrates the AttachmentRepository + the existing files pipeline
 * (FileRepository + StorageProvider), validates that the target entity
 * actually exists via a per-type lookup map, and emits audit events for
 * every mutation (`attachment.uploaded`, `attachment.archived`,
 * `attachment.visibility_changed`, `attachment.paired`).
 *
 * Entity validation: lookups for 'job', 'invoice', 'estimate' are wired in
 * app.ts against the existing repos. The remaining entity types
 * ('form_response', 'expense', 'agreement_run', 'customer') return a clear
 * NOT_SUPPORTED error until later tasks wire their lookups.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  Attachment,
  AttachmentEntityType,
  AttachmentPairRole,
  AttachmentPairTargetNotFoundError,
  AttachmentRepository,
  CreateAttachmentInput,
  ListByEntityOptions,
} from './attachment';
import { FileRepository, StorageProvider } from '../files/file-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { AppError, NotFoundError, ValidationError } from '../shared/errors';
import { Queue } from '../queues/queue';
import {
  IMAGE_POST_PROCESS_TYPE,
  imagePostProcessIdempotencyKey,
} from '../workers/image-post-process-worker';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'attachments.attachment-service',
  environment: process.env.NODE_ENV || 'development',
});

/** RV-006: window for the attach-time content-hash dedupe. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AttachmentActor {
  userId: string;
  role: string;
}

/** Returns true when `entityId` exists for the tenant. */
export type EntityLookup = (tenantId: string, entityId: string) => Promise<boolean>;
export type EntityLookupMap = Partial<Record<AttachmentEntityType, EntityLookup>>;

export interface AttachmentWithUrl extends Attachment {
  downloadUrl: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /**
   * RV-006: presigned URL for the 480px thumbnail, present once the image
   * post-process pipeline has stored one (same TTL as downloadUrl).
   */
  thumbnailUrl?: string;
}

export interface AttachmentPair {
  pairGroupId: string;
  attachment: Attachment;
  other: Attachment;
}

export class AttachmentService {
  constructor(
    private readonly repo: AttachmentRepository,
    private readonly fileRepo: FileRepository,
    private readonly storage: StorageProvider,
    private readonly auditRepo: AuditRepository,
    private readonly entityLookups: EntityLookupMap,
    // RV-006: optional queue for the image post-process pipeline — same
    // optional-dependency pattern as the dual-write attachmentRepo in
    // JobPhotoService. When absent (existing call sites / tests), attach
    // behaves exactly as before; when present, every successful attach
    // enqueues a failure-isolated image_post_process message.
    private readonly queue?: Pick<Queue, 'send'>
  ) {}

  async attach(
    tenantId: string,
    actor: AttachmentActor,
    input: CreateAttachmentInput
  ): Promise<Attachment> {
    if (!tenantId) throw new ValidationError('tenantId is required');
    if (!input.fileId) throw new ValidationError('fileId is required');

    // Confirm the file row exists in this tenant before linking. The FK in
    // Postgres would fail anyway, but resolving here gives a 404 instead of
    // a 500 and keeps in-memory tests honest. (Same rationale as
    // JobPhotoService.attachPhotoToJob.)
    const file = await this.fileRepo.findById(tenantId, input.fileId);
    if (!file) throw new NotFoundError('File', input.fileId);

    // Enforce the invariant that a file may only be attached to the entity it
    // was presigned for. A file presigned for job A but attached to job B
    // would resolve as a false orphan placeholder in listForEntity (which uses
    // fileRepo.findByEntity scoped to the target entity). Reject at write time
    // so callers get a clear error rather than a silent empty downloadUrl.
    if (file.entityType !== input.entityType || file.entityId !== input.entityId) {
      throw new ValidationError(
        'File was presigned for a different entity and cannot be attached here',
        {
          file: { entityType: file.entityType, entityId: file.entityId },
          requested: { entityType: input.entityType, entityId: input.entityId },
        }
      );
    }

    await this.assertEntityExists(tenantId, input.entityType, input.entityId);

    // RV-006 dedupe groundwork: if a file with the same (tenant,
    // content_hash) was attached to the SAME entity within 24h, return that
    // attachment instead of creating a duplicate — the offline-outbox retry
    // case where the client re-uploads + re-attaches the same photo.
    // LIMITATION: content_hash is only stamped by the async post-process
    // pipeline, so this can only dedupe re-attaches of already-processed
    // files; a brand-new upload (hash still NULL) always creates a fresh
    // attachment even if its bytes duplicate an existing object.
    if (file.contentHash) {
      const duplicate = await this.findRecentDuplicateAttachment(
        tenantId,
        file.contentHash,
        input.entityType,
        input.entityId
      );
      if (duplicate) return duplicate;
    }

    const attachment = await this.repo.create(tenantId, {
      ...input,
      uploadedBy: input.uploadedBy ?? actor.userId,
    });

    await this.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        eventType: 'attachment.uploaded',
        entityType: attachment.entityType,
        entityId: attachment.entityId,
        metadata: {
          attachmentId: attachment.id,
          fileId: attachment.fileId,
          kind: attachment.kind,
          category: attachment.category ?? null,
          source: attachment.source,
        },
      })
    );

    // RV-006: kick the image post-process pipeline. Failure-isolated — an
    // attach must never fail because the queue is down; the worker's
    // content_hash idempotency marker also makes duplicate enqueues safe.
    if (this.queue) {
      try {
        await this.queue.send(
          IMAGE_POST_PROCESS_TYPE,
          { tenantId, fileId: attachment.fileId },
          imagePostProcessIdempotencyKey(attachment.fileId)
        );
      } catch (err) {
        logger.error('RV-006 image post-process enqueue failed', {
          fileId: attachment.fileId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return attachment;
  }

  /**
   * RV-006: most-recent attachment (within 24h) on the same entity whose
   * file shares this content hash, or null.
   */
  private async findRecentDuplicateAttachment(
    tenantId: string,
    contentHash: string,
    entityType: AttachmentEntityType,
    entityId: string
  ): Promise<Attachment | null> {
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    const matchingFiles = await this.fileRepo.findByContentHash(tenantId, contentHash);
    for (const candidate of matchingFiles) {
      const existing = await this.repo.findByFileId(tenantId, candidate.id, entityType, entityId);
      if (existing && existing.createdAt.getTime() >= cutoff) {
        return existing;
      }
    }
    return null;
  }

  async listForEntity(
    tenantId: string,
    entityType: AttachmentEntityType,
    entityId: string,
    options?: ListByEntityOptions
  ): Promise<AttachmentWithUrl[]> {
    // Fetch attachments and all files for this entity in two queries (not N+1).
    // findByEntity returns all file rows for the entity in a single query;
    // we build a lookup map so each attachment can resolve its file in O(1).
    const [attachments, fileRows] = await Promise.all([
      this.repo.listByEntity(tenantId, entityType, entityId, options),
      this.fileRepo.findByEntity(tenantId, entityType, entityId),
    ]);
    const fileMap = new Map(fileRows.map((f) => [f.id, f]));

    return Promise.all(
      attachments.map(async (attachment) => {
        const file = fileMap.get(attachment.fileId) ?? null;
        if (!file) {
          // File was deleted out from under us — surface a placeholder entry
          // so galleries can still show metadata + offer to archive the
          // orphaned attachment. (Same fallback as JobPhotoService.)
          return {
            ...attachment,
            downloadUrl: '',
            filename: '',
            contentType: '',
            sizeBytes: 0,
          };
        }
        const downloadUrl = await this.storage.generateDownloadUrl(
          file.storageBucket,
          file.storageKey
        );
        // RV-006: presign the pipeline-generated thumbnail when present
        // (same provider, same TTL as downloadUrl).
        const thumbnailUrl = file.thumbnailS3Key
          ? await this.storage.generateDownloadUrl(file.storageBucket, file.thumbnailS3Key)
          : undefined;
        return {
          ...attachment,
          downloadUrl,
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        };
      })
    );
  }

  async archive(tenantId: string, actor: AttachmentActor, id: string): Promise<Attachment> {
    const archived = await this.repo.archive(tenantId, id);
    if (!archived) throw new NotFoundError('Attachment', id);

    await this.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        eventType: 'attachment.archived',
        entityType: archived.entityType,
        entityId: archived.entityId,
        metadata: { attachmentId: archived.id, fileId: archived.fileId },
      })
    );

    return archived;
  }

  async setPortalVisibility(
    tenantId: string,
    actor: AttachmentActor,
    id: string,
    visible: boolean
  ): Promise<Attachment> {
    const updated = await this.repo.setPortalVisibility(tenantId, id, visible);
    if (!updated) throw new NotFoundError('Attachment', id);

    await this.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        eventType: 'attachment.visibility_changed',
        entityType: updated.entityType,
        entityId: updated.entityId,
        metadata: { attachmentId: updated.id, portalVisible: visible },
      })
    );

    return updated;
  }

  /**
   * Pair two attachments of the same entity as a before/after set. `role`
   * is assigned to `id`; `otherId` receives the opposite role. Generates a
   * fresh shared pair_group_id. Cross-tenant rows are unreachable
   * (tenant-scoped findById) and surface as NOT_FOUND.
   */
  async pair(
    tenantId: string,
    actor: AttachmentActor,
    id: string,
    otherId: string,
    role: AttachmentPairRole
  ): Promise<AttachmentPair> {
    if (id === otherId) {
      throw new ValidationError('Cannot pair an attachment with itself');
    }

    const attachment = await this.repo.findById(tenantId, id);
    if (!attachment) throw new NotFoundError('Attachment', id);
    const other = await this.repo.findById(tenantId, otherId);
    if (!other) throw new NotFoundError('Attachment', otherId);

    if (
      attachment.entityType !== other.entityType ||
      attachment.entityId !== other.entityId
    ) {
      throw new ValidationError(
        'Attachments must belong to the same entity to be paired',
        {
          attachment: { entityType: attachment.entityType, entityId: attachment.entityId },
          other: { entityType: other.entityType, entityId: other.entityId },
        }
      );
    }

    const pairGroupId = uuidv4();
    const otherRole: AttachmentPairRole = role === 'before' ? 'after' : 'before';

    let updated: Attachment;
    let updatedOther: Attachment;
    try {
      ({ attachment: updated, other: updatedOther } = await this.repo.pair(
        tenantId,
        id,
        role,
        otherId,
        otherRole,
        pairGroupId
      ));
    } catch (err) {
      // Catch ONLY the typed sentinel thrown when a target row is not found.
      // All other errors (DB failures, etc.) rethrow unchanged.
      if (err instanceof AttachmentPairTargetNotFoundError) {
        throw new NotFoundError('Attachment', err.attachmentId);
      }
      throw err;
    }

    await this.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.userId,
        actorRole: actor.role,
        eventType: 'attachment.paired',
        entityType: updated.entityType,
        entityId: updated.entityId,
        metadata: {
          pairGroupId,
          attachments: [
            { attachmentId: updated.id, pairRole: updated.pairRole },
            { attachmentId: updatedOther.id, pairRole: updatedOther.pairRole },
          ],
        },
      })
    );

    return { pairGroupId, attachment: updated, other: updatedOther };
  }

  private async assertEntityExists(
    tenantId: string,
    entityType: AttachmentEntityType,
    entityId: string
  ): Promise<void> {
    const lookup = this.entityLookups[entityType];
    if (!lookup) {
      throw new AppError(
        'NOT_SUPPORTED',
        `Attachments for entity type '${entityType}' are not supported yet`,
        400
      );
    }
    const exists = await lookup(tenantId, entityId);
    if (!exists) throw new NotFoundError(entityType, entityId);
  }
}
