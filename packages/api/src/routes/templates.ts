import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { createTemplateSchema, verticalTypeSchema } from '../shared/contracts';
import {
  EstimateTemplateRepository,
  createTemplate,
  instantiateTemplate,
} from '../templates/estimate-template';

export function createTemplateRouter(templateRepo: EstimateTemplateRepository): Router {
  const router = Router();

  // List templates for current tenant
  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const verticalType = req.query.verticalType as string | undefined;
        const categoryId = req.query.categoryId as string | undefined;

        if (verticalType) {
          const parsed = verticalTypeSchema.safeParse(verticalType);
          if (!parsed.success) {
            res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid verticalType' });
            return;
          }
        }

        let templates;
        if (categoryId) {
          templates = await templateRepo.findByCategory(req.auth!.tenantId, categoryId);
        } else if (verticalType) {
          templates = await templateRepo.findByVertical(
            req.auth!.tenantId,
            verticalType as 'hvac' | 'plumbing'
          );
        } else {
          templates = await templateRepo.findByTenant(req.auth!.tenantId);
        }

        res.json(templates);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Get template by ID
  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const template = await templateRepo.findById(req.auth!.tenantId, req.params.id);
        if (!template) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Template not found' });
          return;
        }
        res.json(template);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Create template
  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createTemplateSchema.parse(req.body);
        const result = await createTemplate(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
          },
          templateRepo
        );
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Instantiate template (preview what an estimate from this template would look like)
  router.post(
    '/:id/instantiate',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const template = await templateRepo.findById(req.auth!.tenantId, req.params.id);
        if (!template) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Template not found' });
          return;
        }
        const result = instantiateTemplate(template);
        await templateRepo.incrementUsage(req.auth!.tenantId, req.params.id);
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // Update template
  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { name, description, lineItemTemplates, defaultDiscountCents, defaultTaxRateBps, defaultCustomerMessage, isActive } = req.body;
        const result = await templateRepo.update(req.auth!.tenantId, req.params.id, {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(lineItemTemplates !== undefined && { lineItemTemplates }),
          ...(defaultDiscountCents !== undefined && { defaultDiscountCents }),
          ...(defaultTaxRateBps !== undefined && { defaultTaxRateBps }),
          ...(defaultCustomerMessage !== undefined && { defaultCustomerMessage }),
          ...(isActive !== undefined && { isActive }),
          updatedAt: new Date(),
        });
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Template not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
