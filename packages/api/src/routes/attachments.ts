/**
 * RV-005 — Attachments router.
 *
 * Generalized photo/document attachment surface, mounted at
 * `/api/attachments`. Mirrors the job-photos presign → PUT → attach
 * 3-step pattern:
 *   POST /api/attachments/presign          → files row + presigned PUT URL
 *   POST /api/attachments                  → link a files row to an entity
 *   GET  /api/attachments?entityType=&entityId=
 *   POST /api/attachments/:id/archive
 *   POST /api/attachments/:id/visibility
 *   POST /api/attachments/:id/pair
 */
import { Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  FileRecord,
  FileRepository,
  StorageProvider,
  sanitizeFilename,
  validateUpload,
} from '../files/file-service';
import {
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_ENTITY_TYPES,
  ATTACHMENT_KINDS,
  ATTACHMENT_PAIR_ROLES,
  ATTACHMENT_SOURCES,
} from '../attachments/attachment';
import { AttachmentActor, AttachmentService } from '../attachments/attachment-service';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';

// Presign is restricted to the entity types that have wired entity-existence
// lookups today. Extend this tuple alongside the service entityLookups map
// in app.ts when later tasks add support for more entity types.
const PRESIGN_ENTITY_TYPES = ['job', 'invoice', 'estimate'] as const;

const presignSchema = z.object({
  entityType: z.enum(PRESIGN_ENTITY_TYPES),
  entityId: z.string().uuid(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

const attachSchema = z.object({
  fileId: z.string().uuid(),
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  kind: z.enum(ATTACHMENT_KINDS),
  caption: z.string().optional(),
  category: z.enum(ATTACHMENT_CATEGORIES).optional(),
  source: z.enum(ATTACHMENT_SOURCES).optional(),
});

const listQuerySchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().uuid(),
  // NOT z.coerce.boolean(): query params arrive as strings and
  // Boolean('false') === true. Accept the two literal strings instead
  // (compared against 'true' in the handler).
  includeArchived: z.enum(['true', 'false']).optional(),
});

const visibilitySchema = z.object({
  visible: z.boolean(),
});

const pairSchema = z.object({
  otherId: z.string().uuid(),
  role: z.enum(ATTACHMENT_PAIR_ROLES),
});

export interface AttachmentsRouterDeps {
  service: AttachmentService;
  fileRepo: FileRepository;
  storage: StorageProvider;
  bucket: string;
  auditRepo: AuditRepository;
}

function actorOf(req: AuthenticatedRequest): AttachmentActor {
  return { userId: req.auth!.userId, role: req.auth!.role };
}

export function createAttachmentsRouter(deps: AttachmentsRouterDeps): Router {
  const { service, fileRepo, storage, bucket, auditRepo } = deps;
  const router = Router();

  // Step 1 of upload: client requests a presigned PUT URL. We create the
  // `files` row eagerly so the subsequent attach call only needs the
  // fileId — same shape as the job-photos presign step.
  router.post(
    '/presign',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = validate(presignSchema, req.body ?? {});
        const tenantId = req.auth!.tenantId;

        const uploadRequest = {
          tenantId,
          uploadedBy: req.auth!.userId,
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
          entityType: body.entityType,
          entityId: body.entityId,
        };
        const errors = validateUpload(uploadRequest);
        if (errors.length > 0) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join(', ') });
          return;
        }

        // Tenant-prefixed key, namespaced under attachments/ so objects are
        // grepable by entity in the bucket.
        const fileId = uuidv4();
        const safeName = sanitizeFilename(body.filename);
        const now = new Date();
        const fileRecord: FileRecord = {
          id: fileId,
          tenantId,
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
          storageBucket: bucket,
          storageKey: `${tenantId}/attachments/${body.entityType}/${body.entityId}/${fileId}-${safeName}`,
          entityType: body.entityType,
          entityId: body.entityId,
          uploadedBy: req.auth!.userId,
          createdAt: now,
          updatedAt: now,
        };
        const created = await fileRepo.create(fileRecord);
        const uploadUrl = await storage.generateUploadUrl(
          created.storageBucket,
          created.storageKey,
          created.contentType
        );

        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            eventType: 'attachment.upload_requested',
            entityType: body.entityType,
            entityId: body.entityId,
            metadata: {
              fileId: created.id,
              filename: created.filename,
              contentType: created.contentType,
              sizeBytes: created.sizeBytes,
            },
          })
        );

        res.status(201).json({ fileId: created.id, uploadUrl, fileRecord: created });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Step 2 of upload: client confirms the PUT succeeded and asks us to
  // attach the file to an entity.
  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = validate(attachSchema, req.body ?? {});
        const tenantId = req.auth!.tenantId;

        const attachment = await service.attach(tenantId, actorOf(req), {
          fileId: body.fileId,
          entityType: body.entityType,
          entityId: body.entityId,
          kind: body.kind,
          caption: body.caption,
          category: body.category,
          source: body.source,
        });

        res.status(201).json(attachment);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('files:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const query = validate(listQuerySchema, req.query ?? {});
        const attachments = await service.listForEntity(
          req.auth!.tenantId,
          query.entityType,
          query.entityId,
          { includeArchived: query.includeArchived === 'true' }
        );
        res.json(attachments);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Soft delete: only sets archived_at — the files row + S3 object remain
  // (mirrors the job-photos delete semantics).
  router.post(
    '/:id/archive',
    requireAuth,
    requireTenant,
    requirePermission('files:delete'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const archived = await service.archive(req.auth!.tenantId, actorOf(req), req.params.id);
        res.json(archived);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/visibility',
    requireAuth,
    requireTenant,
    requirePermission('attachments:visibility'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = validate(visibilitySchema, req.body ?? {});
        const updated = await service.setPortalVisibility(
          req.auth!.tenantId,
          actorOf(req),
          req.params.id,
          body.visible
        );
        res.json(updated);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/pair',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = validate(pairSchema, req.body ?? {});
        const result = await service.pair(
          req.auth!.tenantId,
          actorOf(req),
          req.params.id,
          body.otherId,
          body.role
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
