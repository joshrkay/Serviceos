/**
 * P12-001 — Job photos router.
 *
 * Mount at `/api/jobs` so the URL shape mirrors the existing
 * job-files router:
 *   POST   /api/jobs/:id/photos/presign-upload
 *   POST   /api/jobs/:id/photos
 *   GET    /api/jobs/:id/photos
 *   DELETE /api/jobs/:id/photos/:photoId
 */
import { Response, Router } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  FileRepository,
  StorageProvider,
  createFileRecord,
  validateUpload,
  normalizeContentType,
} from '../files/file-service';
import { JobPhotoService } from '../jobs/job-photo-service';
import { isValidJobPhotoCategory } from '../jobs/job-photo';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { asyncRoute } from '../middleware/async-route';

// Photos are bounded tighter than the generic 100MB file limit:
// mobile cameras commonly emit 4–8MB JPEGs; 10MB is a comfortable
// ceiling that still rejects accidental video uploads.
export const MAX_JOB_PHOTO_SIZE = 10 * 1024 * 1024;

const ALLOWED_PHOTO_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

interface PresignBody {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

interface AttachBody {
  fileId?: string;
  category?: string;
  notes?: string;
  takenAt?: string;
}

export interface JobPhotosRouterDeps {
  service: JobPhotoService;
  fileRepo: FileRepository;
  storage: StorageProvider;
  bucket: string;
  auditRepo: AuditRepository;
}

export function createJobPhotosRouter(deps: JobPhotosRouterDeps): Router {
  const { service, fileRepo, storage, bucket, auditRepo } = deps;
  const router = Router();

  // Step 1 of upload: client requests a presigned URL. We create the
  // `files` row eagerly so the subsequent attach call only needs the
  // fileId. Mirrors the job-files router's upload-url shape.
  router.post(
    '/:id/photos/presign-upload',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const body = (req.body ?? {}) as PresignBody;
      const jobId = req.params.id;
      const tenantId = req.auth!.tenantId;

      const uploadRequest = {
        tenantId,
        uploadedBy: req.auth!.userId,
        filename: body.filename ?? '',
        contentType: body.contentType ?? '',
        sizeBytes: Number(body.sizeBytes ?? 0),
        entityType: 'job' as const,
        entityId: jobId,
      };

      const errors = validateUpload(uploadRequest);
      if (errors.length > 0) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join(', ') });
        return;
      }

      const normalized = normalizeContentType(uploadRequest.contentType);
      if (!ALLOWED_PHOTO_CONTENT_TYPES.has(normalized)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Photo content type not allowed: ${uploadRequest.contentType}`,
        });
        return;
      }

      if (isNaN(uploadRequest.sizeBytes) || uploadRequest.sizeBytes <= 0 || uploadRequest.sizeBytes > MAX_JOB_PHOTO_SIZE) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: uploadRequest.sizeBytes > MAX_JOB_PHOTO_SIZE
            ? 'Photo exceeds maximum allowed size of ' + MAX_JOB_PHOTO_SIZE + ' bytes'
            : 'Photo size must be a positive number',
        });
        return;
      }

      const fileRecord = createFileRecord(uploadRequest, bucket);
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
          eventType: 'job.photo.upload_requested',
          entityType: 'job',
          entityId: jobId,
          metadata: {
            fileId: created.id,
            filename: created.filename,
            contentType: created.contentType,
            sizeBytes: created.sizeBytes,
          },
        })
      );

      res.status(201).json({
        fileId: created.id,
        uploadUrl,
        fileRecord: created,
      });
    })
  );

  // Step 2 of upload: client confirms the S3 PUT succeeded and asks
  // us to attach the file row to the job with category + notes.
  router.post(
    '/:id/photos',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const body = (req.body ?? {}) as AttachBody;
      const jobId = req.params.id;
      const tenantId = req.auth!.tenantId;

      if (!body.fileId) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'fileId is required' });
        return;
      }
      if (!isValidJobPhotoCategory(body.category)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Invalid category: ${String(body.category)}`,
        });
        return;
      }

      const takenAt = body.takenAt ? new Date(body.takenAt) : undefined;
      if (takenAt && Number.isNaN(takenAt.getTime())) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'takenAt is invalid' });
        return;
      }

      const photo = await service.attachPhotoToJob(
        tenantId,
        jobId,
        body.fileId,
        body.category,
        body.notes,
        takenAt,
        req.auth!.userId
      );

      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'job.photo.attached',
          entityType: 'job',
          entityId: jobId,
          metadata: {
            photoId: photo.id,
            fileId: photo.fileId,
            category: photo.category,
          },
        })
      );

      res.status(201).json(photo);
    })
  );

  router.get(
    '/:id/photos',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const photos = await service.listJobPhotos(tenantId, req.params.id);
      res.json(photos);
    })
  );

  // Removes only the join row: the underlying file + S3 object
  // intentionally remain so download URLs already shared in
  // (e.g.) audit metadata still resolve. A separate cleanup job
  // can reap orphaned files later.
  router.delete(
    '/:id/photos/:photoId',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const removed = await service.deleteJobPhoto(tenantId, req.params.id, req.params.photoId);
      if (!removed) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job photo not found' });
        return;
      }

      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'job.photo.deleted',
          entityType: 'job',
          entityId: req.params.id,
          metadata: { photoId: req.params.photoId },
        })
      );

      res.status(204).send();
    })
  );

  return router;
}
