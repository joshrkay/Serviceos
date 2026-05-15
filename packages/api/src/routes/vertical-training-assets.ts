import { Router, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, ValidationError } from '../shared/errors';
import type { KnownEntities } from '../ai/training/scrub';
import { trainingAssetInputSchema } from '../verticals/training-assets';
import type { TrainingAssetService } from '../verticals/training-asset-service';

const knownEntitiesSchema = z.object({
  phones: z.array(z.string()).optional(),
  emails: z.array(z.string()).optional(),
  names: z.array(z.string()).optional(),
  addresses: z.array(z.string()).optional(),
});

const createTrainingAssetRequestSchema = trainingAssetInputSchema.extend({
  knownEntities: knownEntitiesSchema.optional(),
});

type TrainingAsset = Awaited<ReturnType<TrainingAssetService['list']>>[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeAsset(asset: TrainingAsset) {
  const { rawText: _rawText, ...safe } = asset;
  return safe;
}

function parseAssetId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new ValidationError('Invalid training asset id', { id });
  }
  return id;
}

export function createVerticalTrainingAssetsRouter(service: TrainingAssetService): Router {
  const router = Router();

  router.use(requireAuth, requireTenant, requirePermission('settings:update'));

  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const assets = await service.list(req.auth!.tenantId);
      res.json({ data: assets.map(serializeAsset) });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { knownEntities, ...input } = createTrainingAssetRequestSchema.parse(req.body);
      const asset = await service.create({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        input,
        knownEntities: knownEntities as KnownEntities | undefined,
      });
      res.status(201).json(serializeAsset(asset));
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:id/approve', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const asset = await service.approve({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        assetId: parseAssetId(req.params.id),
      });
      res.json(serializeAsset(asset));
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:id/activate', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const asset = await service.activate({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        assetId: parseAssetId(req.params.id),
      });
      res.json(serializeAsset(asset));
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
