import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../auth/clerk';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { JobFileRepository } from '../files/job-file-repository';
import {
  MAX_FILE_SIZE,
  StorageProvider,
  validateUpload,
  UploadRequest,
} from '../files/file-service';
import { AppError, toErrorResponse } from '../shared/errors';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';

interface JobFileUploadBody {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

interface CreateJobFilesRouterDeps {
  repo: JobFileRepository;
  storage: StorageProvider;
  bucket: string;
  auditRepo: AuditRepository;
}

export function createJobFilesRouter(deps: CreateJobFilesRouterDeps): Router {
  const { repo, storage, bucket, auditRepo } = deps;
  const router = Router();

  const createUploadHandler = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as JobFileUploadBody;
      const uploadRequest: UploadRequest = {
        tenantId: req.auth!.tenantId,
        uploadedBy: req.auth!.userId,
        filename: body.filename ?? '',
        contentType: body.contentType ?? '',
        sizeBytes: Number(body.sizeBytes ?? 0),
        entityType: 'job',
        entityId: req.params.jobId,
      };

      const errors = validateUpload(uploadRequest);
      if (errors.length > 0) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join(', ') });
        return;
      }

      const id = uuidv4();
      const createdAt = new Date();
      const storageKey = `${uploadRequest.tenantId}/jobs/${req.params.jobId}/${id}/${uploadRequest.filename}`;
      const record = await repo.create({
        id,
        tenantId: uploadRequest.tenantId,
        filename: uploadRequest.filename,
        contentType: uploadRequest.contentType,
        sizeBytes: uploadRequest.sizeBytes,
        storageBucket: bucket,
        storageKey,
        entityType: 'job',
        entityId: req.params.jobId,
        uploadedBy: uploadRequest.uploadedBy,
        createdAt,
        updatedAt: createdAt,
      });

      const [uploadUrl, downloadUrl] = await Promise.all([
        storage.generateUploadUrl(record.storageBucket, record.storageKey, record.contentType),
        storage.generateDownloadUrl(record.storageBucket, record.storageKey),
      ]);

      await auditRepo.create(
        createAuditEvent({
          tenantId: record.tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'job.file.upload_requested',
          entityType: 'job',
          entityId: req.params.jobId,
          metadata: {
            fileId: record.id,
            filename: record.filename,
            contentType: record.contentType,
            sizeBytes: record.sizeBytes,
          },
        })
      );

      res.status(201).json({ fileId: record.id, uploadUrl, downloadUrl, fileRecord: record });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  };

  router.post('/:jobId/files/upload-url', requireAuth, requireTenant, requirePermission('files:upload'), createUploadHandler);
  router.post('/:jobId/files/upload', requireAuth, requireTenant, requirePermission('files:upload'), createUploadHandler);

  router.get('/:jobId/files', requireAuth, requireTenant, requirePermission('files:view'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const records = await repo.findByJob(req.auth!.tenantId, req.params.jobId);
      res.json(records);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:jobId/files/:id', requireAuth, requireTenant, requirePermission('files:view'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const record = await repo.findById(req.auth!.tenantId, req.params.id);
      if (!record || record.entityId !== req.params.jobId) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
        return;
      }
      res.json(record);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:jobId/files/:id/verify', requireAuth, requireTenant, requirePermission('files:upload'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const record = await repo.findById(req.auth!.tenantId, req.params.id);
      if (!record || record.entityId !== req.params.jobId) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
        return;
      }

      const metadata = await storage.getObjectMetadata(record.storageBucket, record.storageKey);
      if (metadata === null) {
        res.status(200).json({ fileRecord: record, verified: false, reason: 'metadata_unavailable' });
        return;
      }

      if (metadata.contentLength > MAX_FILE_SIZE) {
        await storage.deleteObject(record.storageBucket, record.storageKey);
        await repo.delete(req.auth!.tenantId, record.id);
        throw new AppError(
          'PAYLOAD_TOO_LARGE',
          `Uploaded size ${metadata.contentLength} exceeds maximum ${MAX_FILE_SIZE}`,
          413
        );
      }

      const updated = metadata.contentLength !== record.sizeBytes
        ? await repo.updateSize(req.auth!.tenantId, record.id, metadata.contentLength)
        : record;

      await auditRepo.create(
        createAuditEvent({
          tenantId: record.tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'job.file.upload_verified',
          entityType: 'job',
          entityId: req.params.jobId,
          metadata: {
            fileId: record.id,
            declaredSizeBytes: record.sizeBytes,
            actualSizeBytes: metadata.contentLength,
            contentType: metadata.contentType,
          },
        })
      );

      res.status(200).json({
        fileRecord: updated ?? record,
        verified: true,
        actualSizeBytes: metadata.contentLength,
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
