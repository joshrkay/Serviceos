import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { createCatalogItemSchema, updateCatalogItemSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import { z } from 'zod';
import {
  CatalogCategory,
  CatalogItem,
  CatalogItemRepository,
  createCatalogItem,
  updateCatalogItem,
} from '../catalog/catalog-item';

const listCatalogItemsQuerySchema = z.object({
  search: z.string().trim().optional(),
  category: z.enum(['Labor', 'Parts', 'Materials']).optional(),
  includeArchived: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(200),
});

function toApiModel(item: CatalogItem) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    unit: item.unit,
    unitPriceCents: item.unitPriceCents,
    productServiceType: item.productServiceType,
    productServiceTable: item.productServiceType === 'service' ? 'services' : 'products',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function createCatalogItemsRouter(catalogRepo: CatalogItemRepository): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const query = listCatalogItemsQuerySchema.parse(req.query);
        const items = await catalogRepo.listByTenant(req.auth!.tenantId, {
          search: query.search,
          category: query.category as CatalogCategory | undefined,
          includeArchived: query.includeArchived,
        });

        const page = query.page;
        const pageSize = query.pageSize;
        const start = (page - 1) * pageSize;
        const data = items.slice(start, start + pageSize).map(toApiModel);

        res.json({ data, total: items.length, page, pageSize });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createCatalogItemSchema.parse(req.body);
        const created = await catalogRepo.create(createCatalogItem({
          tenantId: req.auth!.tenantId,
          ...parsed,
        }));

        res.status(201).json(toApiModel(created));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = updateCatalogItemSchema.parse(req.body);
        if (Object.keys(parsed).length === 0) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'At least one field is required' });
          return;
        }
        const updated = await updateCatalogItem(catalogRepo, req.auth!.tenantId, req.params.id, parsed);

        if (!updated) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Catalog item not found' });
          return;
        }

        res.json(toApiModel(updated));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.delete(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const archived = await catalogRepo.archive(req.auth!.tenantId, req.params.id);
        if (!archived) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Catalog item not found' });
          return;
        }
        res.status(204).send();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
