import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant } from '../middleware/auth';
import { getServiceCategories, isValidVerticalType, VerticalType } from '../shared/vertical-types';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { HVAC_CATEGORIES } from '../verticals/hvac/categories';
import { PLUMBING_CATEGORIES } from '../verticals/plumbing/categories';
import { HVAC_TERMINOLOGY, TerminologyMap } from '../verticals/hvac/terminology';
import { PLUMBING_TERMINOLOGY } from '../verticals/plumbing/terminology';

function getVerticalCategories(verticalType: VerticalType) {
  switch (verticalType) {
    case 'hvac':
      return HVAC_CATEGORIES;
    case 'plumbing':
      return PLUMBING_CATEGORIES;
    case 'electrical':
      return getServiceCategories('electrical').map((category, index) => ({
        id: category,
        name: titleCaseCategory(category),
        description: `Electrical ${category} service`,
        parentId: undefined,
        sortOrder: index + 1,
        typicalLineItems: [] as string[],
      }));
    case 'painting':
      return getServiceCategories('painting').map((category, index) => ({
        id: category,
        name: titleCaseCategory(category),
        description: `Painting ${category} service`,
        parentId: undefined,
        sortOrder: index + 1,
        typicalLineItems: [] as string[],
      }));
  }
}

function getVerticalTerminology(verticalType: VerticalType) {
  switch (verticalType) {
    case 'hvac':
      return HVAC_TERMINOLOGY;
    case 'plumbing':
      return PLUMBING_TERMINOLOGY;
    case 'electrical':
      return getElectricalTerminology();
    case 'painting':
      return getPaintingTerminology();
  }
}

function titleCaseCategory(category: string): string {
  return category
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getElectricalTerminology(): TerminologyMap {
  return Object.fromEntries(
    getServiceCategories('electrical').map((category) => [
      category,
      {
        canonical: category,
        displayLabel: titleCaseCategory(category),
        promptHint: `Electrical ${category} service`,
        aliases: [category],
      },
    ])
  );
}

function getPaintingTerminology(): TerminologyMap {
  return Object.fromEntries(
    getServiceCategories('painting').map((category) => [
      category,
      {
        canonical: category,
        displayLabel: titleCaseCategory(category),
        promptHint: `Painting ${category} service`,
        aliases: [category],
      },
    ])
  );
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

  router.get(
    '/',
    requireAuth,
    requireTenant,
    asyncRoute(async (_req: AuthenticatedRequest, res: Response) => {
      const packs = await verticalPackRegistry.list();
      res.json(packs.filter((pack) => pack.status === 'active'));
    })
  );

  router.get(
    '/:type',
    requireAuth,
    requireTenant,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
    })
  );

  router.get(
    '/:type/categories',
    requireAuth,
    requireTenant,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
    })
  );

  router.get(
    '/:type/terminology/:term',
    requireAuth,
    requireTenant,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
    })
  );

  return router;
}
