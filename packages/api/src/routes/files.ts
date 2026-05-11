import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  FileRepository,
  MAX_FILE_SIZE,
  StorageProvider,
  UploadRequest,
  createFileRecord,
  validateUpload,
} from '../files/file-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { AppError } from '../shared/errors';

interface UploadUrlBody {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  entityType?: string;
  entityId?: string;
}

export interface FilesRouterDeps {
  fileRepo: FileRepository;
  storage: StorageProvider;
  bucket: string;
  auditRepo: AuditRepository;
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { fileRepo, storage, bucket, auditRepo } = deps;
  const router = Router();

  const uploadHandler = asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const body = (req.body ?? {}) as UploadUrlBody;
    const uploadRequest: UploadRequest = {
      tenantId: req.auth!.tenantId,
      uploadedBy: req.auth!.userId,
      filename: body.filename ?? '',
      contentType: body.contentType ?? '',
      sizeBytes: Number(body.sizeBytes ?? 0),
      entityType: body.entityType,
      entityId: body.entityId,
    };

    const errors = validateUpload(uploadRequest);
    if (errors.length > 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join(', ') });
      return;
    }

    const record = createFileRecord(uploadRequest, bucket);
    const saved = await fileRepo.create(record);

    const [uploadUrl, downloadUrl] = await Promise.all([
      storage.generateUploadUrl(saved.storageBucket, saved.storageKey, saved.contentType),
      storage.generateDownloadUrl(saved.storageBucket, saved.storageKey),
    ]);

    await auditRepo.create(
      createAuditEvent({
        tenantId: saved.tenantId,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role,
        eventType: 'file.upload_requested',
        entityType: 'file',
        entityId: saved.id,
        metadata: {
          filename: saved.filename,
          contentType: saved.contentType,
          sizeBytes: saved.sizeBytes,
          entityType: saved.entityType,
          entityId: saved.entityId,
        },
      })
    );

    res.status(201).json({
      fileId: saved.id,
      uploadUrl,
      downloadUrl,
      fileRecord: saved,
    });
  });

  router.post(
    '/upload-url',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    uploadHandler
  );

  router.post(
    '/upload',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    uploadHandler
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('files:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const record = await fileRepo.findById(req.auth!.tenantId, req.params.id);
      if (!record) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
        return;
      }
      res.json(record);
    })
  );

  // Reconciles the declared sizeBytes against what was actually uploaded.
  // Closes the "client lies about size" hole: the presigned URL does not
  // bind size, so an authenticated user could claim sizeBytes=100 and
  // upload 100MB. HEAD the real object and either update the row or
  // reject+delete if it exceeds MAX_FILE_SIZE. When the storage provider
  // cannot introspect (dev mode), the record is left unchanged.
  router.post(
    '/:id/verify',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const record = await fileRepo.findById(req.auth!.tenantId, req.params.id);
      if (!record) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
        return;
      }

      const metadata = await storage.getObjectMetadata(record.storageBucket, record.storageKey);

      if (metadata === null) {
        res.status(200).json({
          fileRecord: record,
          verified: false,
          reason: 'metadata_unavailable',
        });
        return;
      }

      if (metadata.contentLength > MAX_FILE_SIZE) {
        await storage.deleteObject(record.storageBucket, record.storageKey);
        await fileRepo.delete(req.auth!.tenantId, record.id);
        throw new AppError(
          'PAYLOAD_TOO_LARGE',
          `Uploaded size ${metadata.contentLength} exceeds maximum ${MAX_FILE_SIZE}`,
          413
        );
      }

      const updated =
        metadata.contentLength !== record.sizeBytes
          ? await fileRepo.updateSize(req.auth!.tenantId, record.id, metadata.contentLength)
          : record;

      await auditRepo.create(
        createAuditEvent({
          tenantId: record.tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'file.upload_verified',
          entityType: 'file',
          entityId: record.id,
          metadata: {
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
    })
  );

  return router;
}

// Dev-only receiver that accepts PUTs from the DevStorageProvider upload URLs.
// Keeps uploaded bytes in an in-memory map so later GETs (e.g. the
// transcription worker fetching audio before sending to Whisper) see the
// actual bytes, not a 204 empty body. Mounted outside /api so it bypasses
// Clerk auth — the signed URL itself is the authorization in prod; in dev
// this is best-effort and gated by NODE_ENV in createApp.
export function createDevStorageRouter(): Router {
  const router = Router();
  const store = new Map<string, { bytes: Buffer; contentType: string }>();

  router.put('/*', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const key = req.path;
      const bytes = Buffer.concat(chunks);
      const contentType = (req.headers['content-type'] as string) || 'application/octet-stream';
      store.set(key, { bytes, contentType });
      res.status(200).end();
    });
    req.on('error', () => res.status(500).end());
  });

  router.get('/*', (req, res) => {
    const entry = store.get(req.path);
    if (!entry) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Content-Length', String(entry.bytes.length));
    res.status(200).end(entry.bytes);
  });

  return router;
}
