import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { isValidVerticalType, VerticalType } from '../shared/vertical-types';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { HVAC_CATEGORIES } from '../verticals/hvac/categories';
import { PLUMBING_CATEGORIES } from '../verticals/plumbing/categories';
import { HVAC_TERMINOLOGY } from '../verticals/hvac/terminology';
import { PLUMBING_TERMINOLOGY } from '../verticals/plumbing/terminology';

function getVerticalCategories(verticalType: VerticalType) {
  return verticalType === 'hvac' ? HVAC_CATEGORIES : PLUMBING_CATEGORIES;
}

function getVerticalTerminology(verticalType: VerticalType) {
  return verticalType === 'hvac' ? HVAC_TERMINOLOGY : PLUMBING_TERMINOLOGY;
}

function resolveTerminology(terminology: ReturnType<typeof getVerticalTerminology>, term: string) {
  const normalizedTerm = term.toLowerCase().trim();

  const byKey = terminology[normalizedTerm];
  if (byKey) {
    return {
      displayName: byKey.displayLabel,
      description: byKey.promptHint,
    };
  }

  for (const entry of Object.values(terminology)) {
    if (entry.aliases.some((alias) => alias.toLowerCase() === normalizedTerm)) {
      return {
        displayName: entry.displayLabel,
        description: entry.promptHint,
      };
    }
  }

  return null;
}

async function getActivePackByVerticalType(registry: VerticalPackRegistry, verticalType: VerticalType) {
  const packs = await registry.findByVertical(verticalType);
  return packs.find((pack) => pack.status === 'active') || null;
}

export function createVerticalRouter(verticalPackRegistry: VerticalPackRegistry): Router {
  const router = Router();

  router.get('/', requireAuth, requireTenant, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const packs = await verticalPackRegistry.list();
      res.json(packs.filter((pack) => pack.status === 'active'));
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:type', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const verticalType = req.params.type;
      if (!isValidVerticalType(verticalType)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid vertical type' });
        return;
      }

      const pack = await getActivePackByVerticalType(verticalPackRegistry, verticalType);
      if (!pack) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Vertical pack not found' });
        return;
      }

      res.json(pack);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:type/categories', requireAuth, requireTenant, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const verticalType = req.params.type;
      if (!isValidVerticalType(verticalType)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid vertical type' });
        return;
      }

      const pack = await getActivePackByVerticalType(verticalPackRegistry, verticalType);
      if (!pack) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Vertical pack not found' });
        return;
      }

      const parentId = req.query.parentId as string | undefined;
      const categories = getVerticalCategories(verticalType)
        .filter((category) => category.parentId === parentId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      res.json(categories);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get(
    '/:type/terminology/:term',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const verticalType = req.params.type;
        if (!isValidVerticalType(verticalType)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid vertical type' });
          return;
        }

        const pack = await getActivePackByVerticalType(verticalPackRegistry, verticalType);
        if (!pack) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Vertical pack not found' });
          return;
        }

        const resolved = resolveTerminology(getVerticalTerminology(verticalType), req.params.term);
        if (!resolved) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Term not found' });
          return;
        }

        res.json(resolved);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
