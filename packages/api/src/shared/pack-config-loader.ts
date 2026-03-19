import { VerticalType, ServiceCategory } from './vertical-types';
import { VerticalPackRegistry, VerticalPack } from './vertical-pack-registry';
import { PackActivationRepository } from '../settings/pack-activation';
import { TerminologyMap } from '../verticals/hvac/terminology';
import { HVAC_TERMINOLOGY } from '../verticals/hvac/terminology';
import { HVAC_CATEGORIES, ServiceCategoryDefinition } from '../verticals/hvac/categories';
import { PLUMBING_TERMINOLOGY } from '../verticals/plumbing/terminology';
import { PLUMBING_CATEGORIES, PlumbingCategoryDefinition } from '../verticals/plumbing/categories';

export interface PackTemplateLineItem {
  description: string;
  unitPriceCents: number;
}

export interface PackTemplateConfig {
  id: string;
  name: string;
  categoryId: string;
  lineItems: PackTemplateLineItem[];
}

export interface IntakeQuestionConfig {
  id: string;
  label: string;
  inputType: 'text' | 'multiline' | 'select';
  required: boolean;
  options?: string[];
}

export interface PackIntakeConfig {
  questions: IntakeQuestionConfig[];
}

export interface VerticalPackConfig {
  verticalType: VerticalType;
  packId: string;
  version: string;
  terminology: TerminologyMap;
  categories: Array<{ id: string; name: string; description: string; sortOrder: number; typicalLineItems: string[] }>;
  templates: PackTemplateConfig[];
  intakeConfig: PackIntakeConfig;
  promptContext?: Record<string, unknown>;
}

const HVAC_TEMPLATES: PackTemplateConfig[] = [
  {
    id: 'hvac-diagnostic-template',
    name: 'HVAC Diagnostic Visit',
    categoryId: 'diagnostic',
    lineItems: [
      { description: 'Diagnostic service call', unitPriceCents: 8900 },
      { description: 'System performance inspection', unitPriceCents: 4500 },
    ],
  },
  {
    id: 'hvac-maintenance-template',
    name: 'Seasonal HVAC Tune-Up',
    categoryId: 'maintenance',
    lineItems: [
      { description: 'Seasonal tune-up labor', unitPriceCents: 9900 },
      { description: 'Filter replacement', unitPriceCents: 2500 },
    ],
  },
];

const PLUMBING_TEMPLATES: PackTemplateConfig[] = [
  {
    id: 'plumbing-drain-template',
    name: 'Drain Cleaning Service',
    categoryId: 'drain',
    lineItems: [
      { description: 'Drain cleaning labor', unitPriceCents: 14900 },
      { description: 'Drain camera inspection', unitPriceCents: 7900 },
    ],
  },
  {
    id: 'plumbing-diagnostic-template',
    name: 'Plumbing Diagnostic Visit',
    categoryId: 'diagnostic',
    lineItems: [
      { description: 'Diagnostic service call', unitPriceCents: 7500 },
      { description: 'Leak detection', unitPriceCents: 6500 },
    ],
  },
];

const HVAC_INTAKE_CONFIG: PackIntakeConfig = {
  questions: [
    { id: 'problemSummary', label: 'Describe the HVAC issue', inputType: 'multiline', required: true },
    { id: 'equipmentType', label: 'Equipment type', inputType: 'select', required: true, options: ['AC', 'Furnace', 'Heat Pump', 'Other'] },
    { id: 'systemAge', label: 'Approximate system age', inputType: 'text', required: false },
  ],
};

const PLUMBING_INTAKE_CONFIG: PackIntakeConfig = {
  questions: [
    { id: 'problemSummary', label: 'Describe the plumbing issue', inputType: 'multiline', required: true },
    { id: 'leakSeverity', label: 'Leak severity', inputType: 'select', required: true, options: ['None', 'Slow leak', 'Active leak', 'Burst pipe'] },
    { id: 'waterShutoffAvailable', label: 'Water shut-off accessible?', inputType: 'select', required: false, options: ['Yes', 'No', 'Unknown'] },
  ],
};

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

function getTemplates(verticalType: VerticalType): VerticalPackConfig['templates'] {
  switch (verticalType) {
    case 'hvac':
      return HVAC_TEMPLATES.map((template) => ({
        ...template,
        lineItems: template.lineItems.map((lineItem) => ({ ...lineItem })),
      }));
    case 'plumbing':
      return PLUMBING_TEMPLATES.map((template) => ({
        ...template,
        lineItems: template.lineItems.map((lineItem) => ({ ...lineItem })),
      }));
    default: {
      const _exhaustive: never = verticalType;
      throw new Error(`Unknown vertical type: ${verticalType}`);
    }
  }
}

function getIntakeConfig(verticalType: VerticalType): VerticalPackConfig['intakeConfig'] {
  switch (verticalType) {
    case 'hvac':
      return {
        questions: HVAC_INTAKE_CONFIG.questions.map((question) => ({
          ...question,
          options: question.options ? [...question.options] : undefined,
        })),
      };
    case 'plumbing':
      return {
        questions: PLUMBING_INTAKE_CONFIG.questions.map((question) => ({
          ...question,
          options: question.options ? [...question.options] : undefined,
        })),
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
    for (const template of config.templates) {
      if (!template.id) errors.push('template id is required');
      if (!template.name) errors.push(`template "${template.id || 'unknown'}" name is required`);
      if (!template.categoryId) errors.push(`template "${template.id || 'unknown'}" categoryId is required`);
      if (!template.lineItems || template.lineItems.length === 0) {
        errors.push(`template "${template.id || 'unknown'}" must include at least one line item`);
      } else {
        for (const lineItem of template.lineItems) {
          if (!lineItem.description) {
            errors.push(`template "${template.id || 'unknown'}" line item description is required`);
          }
          if (lineItem.unitPriceCents < 0) {
            errors.push(`template "${template.id || 'unknown'}" line item unitPriceCents must be >= 0`);
          }
        }
      }
    }
  }
  if (!config.intakeConfig || !config.intakeConfig.questions || config.intakeConfig.questions.length === 0) {
    errors.push('intakeConfig.questions must not be empty');
  } else {
    for (const question of config.intakeConfig.questions) {
      if (!question.id) errors.push('intakeConfig question id is required');
      if (!question.label) errors.push(`intakeConfig question "${question.id || 'unknown'}" label is required`);
      if (!question.inputType) errors.push(`intakeConfig question "${question.id || 'unknown'}" inputType is required`);
      if (question.inputType === 'select' && (!question.options || question.options.length === 0)) {
        errors.push(`intakeConfig question "${question.id || 'unknown'}" select options must not be empty`);
      }
    }
  }
  return errors;
}
