import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  FileRepository,
  StorageProvider,
  UploadRequest,
  createFileRecord,
  validateUpload,
} from '../files/file-service';

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
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { fileRepo, storage, bucket } = deps;
  const router = Router();

  const uploadHandler = async (req: AuthenticatedRequest, res: Response) => {
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

    const [uploadUrl, audioUrl] = await Promise.all([
      storage.generateUploadUrl(saved.storageBucket, saved.storageKey, saved.contentType),
      storage.generateDownloadUrl(saved.storageBucket, saved.storageKey),
    ]);

    res.status(201).json({
      fileId: saved.id,
      uploadUrl,
      audioUrl,
      fileRecord: saved,
    });
  };

  router.post(
    '/upload-url',
    requireAuth,
    requireTenant,
    requirePermission('files:upload'),
    uploadHandler
  );

  // Legacy/fallback alias used by the web VoiceBar when /upload-url 404s.
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
    async (req: AuthenticatedRequest, res: Response) => {
      const record = await fileRepo.findById(req.auth!.tenantId, req.params.id);
      if (!record) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'File not found' });
        return;
      }
      res.json(record);
    }
  );

  return router;
}

// Dev-only receiver that accepts PUTs from the DevStorageProvider upload URLs.
// The payload is discarded — the dev transcription provider does not fetch
// audio bytes, so persistence is not required. Mounted outside /api so it
// bypasses Clerk auth (the signed URL itself is the authorization in prod;
// in dev this is best-effort and gated by NODE_ENV in createApp).
export function createDevStorageRouter(): Router {
  const router = Router();
  router.put('/*', (_req, res) => {
    res.status(200).end();
  });
  router.get('/*', (_req, res) => {
    res.status(204).end();
  });
  return router;
}
