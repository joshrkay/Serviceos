/**
 * Invoice photos router — mirrors job-photos.ts.
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
import { InvoicePhotoService } from '../invoices/invoice-photo-service';
import { isValidJobPhotoCategory } from '../invoices/invoice-photo';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { MAX_JOB_PHOTO_SIZE } from './job-photos';

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
  clientVisible?: boolean;
}

export interface InvoicePhotosRouterDeps {
  service: InvoicePhotoService;
  fileRepo: FileRepository;
  storage: StorageProvider;
  bucket: string;
  auditRepo: AuditRepository;
}

export function createInvoicePhotosRouter(deps: InvoicePhotosRouterDeps): Router {
  const { service, fileRepo, storage, bucket, auditRepo } = deps;
  const router = Router();

  router.post(
    '/:id/photos/presign-upload',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as PresignBody;
        const invoiceId = req.params.id;
        const tenantId = req.auth!.tenantId;

        const uploadRequest = {
          tenantId,
          uploadedBy: req.auth!.userId,
          filename: body.filename ?? '',
          contentType: body.contentType ?? '',
          sizeBytes: Number(body.sizeBytes ?? 0),
          entityType: 'invoice' as const,
          entityId: invoiceId,
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

        if (
          isNaN(uploadRequest.sizeBytes) ||
          uploadRequest.sizeBytes <= 0 ||
          uploadRequest.sizeBytes > MAX_JOB_PHOTO_SIZE
        ) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message:
              uploadRequest.sizeBytes > MAX_JOB_PHOTO_SIZE
                ? `Photo exceeds maximum allowed size of ${MAX_JOB_PHOTO_SIZE} bytes`
                : 'Photo size must be a positive number',
          });
          return;
        }

        const fileRecord = createFileRecord(uploadRequest, bucket);
        const created = await fileRepo.create(fileRecord);
        const uploadUrl = await storage.generateUploadUrl(
          created.storageBucket,
          created.storageKey,
          created.contentType,
        );

        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            eventType: 'invoice.photo.upload_requested',
            entityType: 'invoice',
            entityId: invoiceId,
            metadata: {
              fileId: created.id,
              filename: created.filename,
              contentType: created.contentType,
              sizeBytes: created.sizeBytes,
            },
          }),
        );

        res.status(201).json({
          fileId: created.id,
          uploadUrl,
          fileRecord: created,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/:id/photos',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as AttachBody;
        const invoiceId = req.params.id;
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

        const photo = await service.attachPhotoToInvoice(
          tenantId,
          invoiceId,
          body.fileId,
          body.category,
          body.notes,
          takenAt,
          req.auth!.userId,
          body.clientVisible === true,
        );

        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            eventType: 'invoice.photo.attached',
            entityType: 'invoice',
            entityId: invoiceId,
            metadata: {
              photoId: photo.id,
              fileId: photo.fileId,
              category: photo.category,
            },
          }),
        );

        res.status(201).json(photo);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/:id/photos',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const photos = await service.listInvoicePhotos(tenantId, req.params.id);
        res.json(photos);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.patch(
    '/:id/photos/:photoId',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const clientVisible = (req.body as { clientVisible?: boolean }).clientVisible;
        if (typeof clientVisible !== 'boolean') {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'clientVisible boolean required' });
          return;
        }
        const photo = await service.setClientVisible(
          tenantId,
          req.params.id,
          req.params.photoId,
          clientVisible,
        );
        if (!photo) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice photo not found' });
          return;
        }
        res.json(photo);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.delete(
    '/:id/photos/:photoId',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const removed = await service.deleteInvoicePhoto(
          tenantId,
          req.params.id,
          req.params.photoId,
        );
        if (!removed) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice photo not found' });
          return;
        }

        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            eventType: 'invoice.photo.deleted',
            entityType: 'invoice',
            entityId: req.params.id,
            metadata: { photoId: req.params.photoId },
          }),
        );

        res.status(204).send();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
