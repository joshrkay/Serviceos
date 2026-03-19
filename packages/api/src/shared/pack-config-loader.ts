import { VerticalType, ServiceCategory } from './vertical-types';
import { VerticalPackRegistry } from './vertical-pack-registry';
import { PackActivationRepository } from '../settings/pack-activation';
import { TerminologyMap } from '../verticals/hvac/terminology';
import { HVAC_TERMINOLOGY } from '../verticals/hvac/terminology';
import { HVAC_CATEGORIES } from '../verticals/hvac/categories';
import { PLUMBING_TERMINOLOGY } from '../verticals/plumbing/terminology';
import { PLUMBING_CATEGORIES } from '../verticals/plumbing/categories';

export interface VerticalTemplateConfig {
  id: string;
  name: string;
  serviceCategory: ServiceCategory;
  defaultLineItems: string[];
  defaultNotes?: string;
}

export interface VerticalIntakeConfig {
  requiredFields: string[];
  optionalFields: string[];
  followUpQuestions: string[];
}

export interface VerticalPackConfig {
  verticalType: VerticalType;
  packId: string;
  version: string;
  terminology: TerminologyMap;
  categories: Array<{ id: string; name: string; description: string; sortOrder: number; typicalLineItems: string[] }>;
  templates: VerticalTemplateConfig[];
  intakeConfig: VerticalIntakeConfig;
  promptContext?: Record<string, unknown>;
}

function getTerminology(verticalType: VerticalType): TerminologyMap {
  switch (verticalType) {
    case 'hvac':
      return HVAC_TERMINOLOGY;
    case 'plumbing':
      return PLUMBING_TERMINOLOGY;
    default: {
      const _exhaustive: never = verticalType;
      throw new Error(`Unknown vertical type: ${verticalType}`);
    }
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
    default: {
      const _exhaustive: never = verticalType;
      throw new Error(`Unknown vertical type: ${verticalType}`);
    }
  }
}

function getTemplates(verticalType: VerticalType): VerticalTemplateConfig[] {
  switch (verticalType) {
    case 'hvac':
      return [
        {
          id: 'hvac-diagnostic-template',
          name: 'HVAC Diagnostic Visit',
          serviceCategory: 'diagnostic',
          defaultLineItems: ['Diagnostic service call', 'System inspection'],
          defaultNotes: 'Capture symptoms and verify operating conditions.',
        },
        {
          id: 'hvac-maintenance-template',
          name: 'HVAC Seasonal Maintenance',
          serviceCategory: 'maintenance',
          defaultLineItems: ['Seasonal tune-up', 'Filter inspection'],
        },
      ];
    case 'plumbing':
      return [
        {
          id: 'plumbing-diagnostic-template',
          name: 'Plumbing Diagnostic Visit',
          serviceCategory: 'diagnostic',
          defaultLineItems: ['Service call / diagnostic fee', 'Leak detection'],
          defaultNotes: 'Identify fixture and isolate leak source before quoting repairs.',
        },
        {
          id: 'plumbing-drain-template',
          name: 'Drain Service',
          serviceCategory: 'drain',
          defaultLineItems: ['Drain cleaning', 'Snake / auger service'],
        },
      ];
    default: {
      const _exhaustive: never = verticalType;
      throw new Error(`Unknown vertical type: ${verticalType}`);
    }
  }
}

function getIntakeConfig(verticalType: VerticalType): VerticalIntakeConfig {
  switch (verticalType) {
    case 'hvac':
      return {
        requiredFields: ['serviceAddress', 'equipmentType', 'symptomDescription'],
        optionalFields: ['systemAgeYears', 'lastServiceDate', 'thermostatType'],
        followUpQuestions: [
          'Is the system currently running?',
          'When did the issue start?',
          'Are there unusual noises or odors?',
        ],
      };
    case 'plumbing':
      return {
        requiredFields: ['serviceAddress', 'fixtureType', 'issueDescription'],
        optionalFields: ['waterShutoffAccessible', 'issueDuration', 'recentRepairs'],
        followUpQuestions: [
          'Is water currently leaking or flooding?',
          'Is the issue isolated to one fixture or multiple fixtures?',
          'Has this issue happened before?',
        ],
      };
    default: {
      const _exhaustive: never = verticalType;
      throw new Error(`Unknown vertical type: ${verticalType}`);
    }
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
    templates: getTemplates(pack.verticalType),
    intakeConfig: getIntakeConfig(pack.verticalType),
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
  if (!config.templates || config.templates.length === 0) {
    errors.push('templates must not be empty');
  } else {
    for (const [index, template] of config.templates.entries()) {
      if (!template.id) errors.push(`templates[${index}].id is required`);
      if (!template.name) errors.push(`templates[${index}].name is required`);
      if (!template.serviceCategory) errors.push(`templates[${index}].serviceCategory is required`);
      if (!Array.isArray(template.defaultLineItems) || template.defaultLineItems.length === 0) {
        errors.push(`templates[${index}].defaultLineItems must not be empty`);
      }
    }
  }

  if (!config.intakeConfig) {
    errors.push('intakeConfig is required');
  } else {
    if (!Array.isArray(config.intakeConfig.requiredFields) || config.intakeConfig.requiredFields.length === 0) {
      errors.push('intakeConfig.requiredFields must not be empty');
    }
    if (!Array.isArray(config.intakeConfig.optionalFields)) {
      errors.push('intakeConfig.optionalFields must be an array');
    }
    if (!Array.isArray(config.intakeConfig.followUpQuestions) || config.intakeConfig.followUpQuestions.length === 0) {
      errors.push('intakeConfig.followUpQuestions must not be empty');
    }
  }
  return errors;
}
