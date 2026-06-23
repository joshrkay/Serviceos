import { Response, Router } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { MAX_FILE_SIZE, StorageProvider, UploadRequest, validateUpload } from '../files/file-service';
import { JobFileRepository } from '../files/job-file-repository';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';

interface UploadBody {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface JobFilesRouterDeps {
  jobFileRepo: JobFileRepository;
  storage: StorageProvider;
  bucket: string;
  auditRepo: AuditRepository;
}

export function createJobFilesRouter(deps: JobFilesRouterDeps): Router {
  const { jobFileRepo, storage, bucket, auditRepo } = deps;
  const router = Router();

  const createUploadUrl = asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const body = (req.body ?? {}) as UploadBody;
    const jobId = req.params.id;
    const uploadRequest: UploadRequest = {
      tenantId: req.auth!.tenantId,
      uploadedBy: req.auth!.userId,
      filename: body.filename ?? '',
      contentType: body.contentType ?? '',
      sizeBytes: Number(body.sizeBytes ?? 0),
      entityType: 'job',
      entityId: jobId,
    };

    const errors = validateUpload(uploadRequest);
    if (errors.length > 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join(', ') });
      return;
    }

    if (uploadRequest.sizeBytes > MAX_FILE_SIZE) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'File size exceeds maximum allowed' });
      return;
    }

    const file = await jobFileRepo.create({
      tenantId: req.auth!.tenantId,
      jobId,
      filename: uploadRequest.filename,
      contentType: uploadRequest.contentType,
      sizeBytes: uploadRequest.sizeBytes,
      storageBucket: bucket,
      uploadedBy: req.auth!.userId,
    });

    const [uploadUrl, downloadUrl] = await Promise.all([
      storage.generateUploadUrl(file.storageBucket, file.storageKey, file.contentType),
      storage.generateDownloadUrl(file.storageBucket, file.storageKey),
    ]);

    await auditRepo.create(
      createAuditEvent({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role,
        eventType: 'job.file.upload_requested',
        entityType: 'job',
        entityId: jobId,
        metadata: {
          fileId: file.id,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        },
      })
    );

    res.status(201).json({
      fileId: file.id,
      uploadUrl,
      downloadUrl,
      fileRecord: file,
    });
  });

  router.post(
    '/:id/files/upload-url',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    createUploadUrl
  );

  router.post(
    '/:id/files/upload',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    createUploadUrl
  );

  router.get(
    '/:id/files',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const files = await jobFileRepo.listByJob(req.auth!.tenantId, req.params.id);
      const withUrls = await Promise.all(
        files.map(async (file) => ({
          ...file,
          downloadUrl: await storage.generateDownloadUrl(file.storageBucket, file.storageKey),
        }))
      );
      res.json(withUrls);
    })
  );

  router.delete(
    '/:id/files/:fileId',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const file = await jobFileRepo.findById(req.auth!.tenantId, req.params.fileId);
      if (!file || file.jobId !== req.params.id) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job file not found' });
        return;
      }

      await storage.deleteObject(file.storageBucket, file.storageKey);
      await jobFileRepo.delete(req.auth!.tenantId, file.id);

      await auditRepo.create(
        createAuditEvent({
          tenantId: req.auth!.tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'job.file.deleted',
          entityType: 'job',
          entityId: req.params.id,
          metadata: { fileId: file.id },
        })
      );

      res.status(204).send();
    })
  );

  return router;
}
