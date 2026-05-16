import { Router } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { ValidationError } from '../shared/errors';
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

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const MAX_IDEMPOTENCY_KEY_LEN = 200;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:\-]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ListAsset = Awaited<ReturnType<TrainingAssetService['list']>>['data'][number];

function serializeAsset(asset: ListAsset) {
  const { rawText: _rawText, ...safe } = asset;
  return safe;
}

function parseAssetId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new ValidationError('Invalid training asset id', { id });
  }
  return id;
}

function readIdempotencyKey(req: AuthenticatedRequest): string | undefined {
  const header = req.headers['idempotency-key'];
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LEN || !IDEMPOTENCY_KEY_RE.test(trimmed)) {
    throw new ValidationError('Invalid Idempotency-Key header', {
      reason: 'must be 1-200 chars of [A-Za-z0-9._:-]',
    });
  }
  return trimmed;
}

export function createVerticalTrainingAssetsRouter(service: TrainingAssetService): Router {
  const router = Router();

  router.use(requireAuth, requireTenant);

  router.get(
    '/',
    requirePermission('settings:view'),
    asyncRoute(async (req, res) => {
      const { limit, offset } = listQuerySchema.parse(req.query);
      const page = await service.list(req.auth!.tenantId, { limit, offset });
      res.json({
        data: page.data.map(serializeAsset),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      });
    }),
  );

  router.post(
    '/',
    requirePermission('settings:update'),
    asyncRoute(async (req, res) => {
      const idempotencyKey = readIdempotencyKey(req);
      const { knownEntities, ...input } = createTrainingAssetRequestSchema.parse(req.body);
      const asset = await service.create({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        input,
        knownEntities: knownEntities as KnownEntities | undefined,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      res.status(201).json(serializeAsset(asset));
    }),
  );

  router.post(
    '/:id/approve',
    requirePermission('vertical_training_assets:approve'),
    asyncRoute(async (req, res) => {
      const asset = await service.approve({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        assetId: parseAssetId(req.params.id),
      });
      res.json(serializeAsset(asset));
    }),
  );

  router.post(
    '/:id/activate',
    requirePermission('vertical_training_assets:approve'),
    asyncRoute(async (req, res) => {
      const asset = await service.activate({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        assetId: parseAssetId(req.params.id),
      });
      res.json(serializeAsset(asset));
    }),
  );

  router.post(
    '/:id/archive',
    requirePermission('vertical_training_assets:approve'),
    asyncRoute(async (req, res) => {
      const asset = await service.archive({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        assetId: parseAssetId(req.params.id),
      });
      res.json(serializeAsset(asset));
    }),
  );

  return router;
}
