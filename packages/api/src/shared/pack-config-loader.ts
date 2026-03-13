import { VerticalType, ServiceCategory } from './vertical-types';
import { VerticalPackRegistry, VerticalPack } from './vertical-pack-registry';
import { PackActivationRepository } from '../settings/pack-activation';
import { TerminologyMap } from '../verticals/hvac/terminology';
import { HVAC_TERMINOLOGY } from '../verticals/hvac/terminology';
import { HVAC_CATEGORIES, ServiceCategoryDefinition } from '../verticals/hvac/categories';
import { PLUMBING_TERMINOLOGY } from '../verticals/plumbing/terminology';
import { PLUMBING_CATEGORIES, PlumbingCategoryDefinition } from '../verticals/plumbing/categories';

export interface VerticalPackConfig {
  verticalType: VerticalType;
  packId: string;
  version: string;
  terminology: TerminologyMap;
  categories: Array<{ id: string; name: string; description: string; sortOrder: number; typicalLineItems: string[] }>;
  promptContext?: Record<string, unknown>;
}

function getTerminology(verticalType: VerticalType): TerminologyMap {
  switch (verticalType) {
    case 'hvac':
      return HVAC_TERMINOLOGY;
    case 'plumbing':
      return PLUMBING_TERMINOLOGY;
  }
}

function getCategories(verticalType: VerticalType): VerticalPackConfig['categories'] {
  switch (verticalType) {
    case 'hvac':
      return HVAC_CATEGORIES.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        sortOrder: c.sortOrder,
        typicalLineItems: c.typicalLineItems,
      }));
    case 'plumbing':
      return PLUMBING_CATEGORIES.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        sortOrder: c.sortOrder,
        typicalLineItems: c.typicalLineItems,
      }));
  }
}

export async function loadPackConfig(
  packId: string,
  registry: VerticalPackRegistry
): Promise<VerticalPackConfig | null> {
  const pack = await registry.getByPackId(packId);
  if (!pack) return null;
  if (pack.status !== 'active') return null;

  return {
    verticalType: pack.verticalType,
    packId: pack.packId,
    version: pack.version,
    terminology: getTerminology(pack.verticalType),
    categories: getCategories(pack.verticalType),
    promptContext: (pack.metadata as Record<string, unknown>) || undefined,
  };
}

export async function loadActivePackConfigs(
  tenantId: string,
  activationRepo: PackActivationRepository,
  registry: VerticalPackRegistry
): Promise<VerticalPackConfig[]> {
  const activations = await activationRepo.findByTenant(tenantId);
  const activeActivations = activations.filter((a) => a.status === 'active');

  const configs: VerticalPackConfig[] = [];
  for (const activation of activeActivations) {
    const config = await loadPackConfig(activation.packId, registry);
    if (config) {
      configs.push(config);
    }
  }

  return configs;
}

export function validatePackConfig(config: VerticalPackConfig): string[] {
  const errors: string[] = [];
  if (!config.verticalType) errors.push('verticalType is required');
  if (!config.packId) errors.push('packId is required');
  if (!config.terminology || Object.keys(config.terminology).length === 0) {
    errors.push('terminology must not be empty');
  }
  if (!config.categories || config.categories.length === 0) {
    errors.push('categories must not be empty');
  }
  return errors;
}
