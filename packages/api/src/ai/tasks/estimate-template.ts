import { VerticalType, ServiceCategory } from '../../shared/vertical-types';
import { LineItemCategory } from '../../shared/billing-engine';
import { ValidationError } from '../../shared/errors';
import { createProposal, type Proposal } from '../../proposals/proposal';
import type { OnboardingEstimateTemplatePayload } from './onboarding/types';

export interface TemplateLineItem {
  description: string;
  category?: LineItemCategory;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  sortOrder: number;
}

export interface EstimateTemplate {
  id: string;
  packId: string;
  verticalType: VerticalType;
  serviceCategory: ServiceCategory;
  name: string;
  defaultLineItems: TemplateLineItem[];
  defaultNotes?: string;
  sortOrder: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateTemplateInput {
  packId: string;
  verticalType: VerticalType;
  serviceCategory: ServiceCategory;
  name: string;
  defaultLineItems: TemplateLineItem[];
  defaultNotes?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

export function validateTemplateInput(input: CreateTemplateInput): string[] {
  const errors: string[] = [];
  if (!input.packId) errors.push('packId is required');
  if (!input.verticalType) errors.push('verticalType is required');
  if (!input.serviceCategory) errors.push('serviceCategory is required');
  if (!input.name) errors.push('name is required');
  if (!input.defaultLineItems || input.defaultLineItems.length === 0) {
    errors.push('At least one default line item is required');
  } else {
    for (let i = 0; i < input.defaultLineItems.length; i++) {
      const item = input.defaultLineItems[i];
      if (!item.description) errors.push(`Line item ${i} is missing description`);
      if (item.quantity === undefined || item.quantity < 0) errors.push(`Line item ${i} has invalid quantity`);
      if (item.unitPriceCents === undefined || item.unitPriceCents < 0) errors.push(`Line item ${i} has invalid unitPriceCents`);
      if (item.category && !['labor', 'material', 'equipment', 'other'].includes(item.category)) {
        errors.push(`Line item ${i} has invalid category`);
      }
    }
  }
  return errors;
}

/**
 * Template repository is intentionally NOT tenant-scoped.
 * Templates belong to vertical packs and are shared across all tenants
 * that activate a given pack. Access control is enforced at the
 * pack-activation layer (see pack-activation.ts).
 */
export interface EstimateTemplateRepository {
  create(template: EstimateTemplate): Promise<EstimateTemplate>;
  findById(id: string): Promise<EstimateTemplate | null>;
  findByVerticalAndCategory(verticalType: VerticalType, category: ServiceCategory): Promise<EstimateTemplate | null>;
  findByVertical(verticalType: VerticalType): Promise<EstimateTemplate[]>;
  list(): Promise<EstimateTemplate[]>;
}

/**
 * #1066 / D-033 — the AI never writes an estimate template. A template is
 * priced and flows into every future estimate, so it is drafted as an
 * `onboarding_estimate_template` PROPOSAL and written only by that type's
 * deterministic handler after a human approves it
 * (proposals/execution/onboarding-handlers.ts, which calls the same
 * templates/estimate-template.ts `createTemplate` the templates route uses).
 * This used to be `createTemplate(input, repository)`, which wrote the
 * template from an AI module with no proposal — the sixth I1′ site.
 *
 * No trust tier is passed, so the proposal is always created as `draft`
 * (never auto-approved).
 */
export function draftEstimateTemplateProposal(
  input: CreateTemplateInput,
  ctx: { tenantId: string; createdBy: string },
): Proposal {
  const errors = validateTemplateInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`, { errors });
  }

  const payload: OnboardingEstimateTemplatePayload = {
    verticalType: input.verticalType,
    categoryId: input.serviceCategory,
    templateName: input.name,
    lineItems: input.defaultLineItems.map((item) => ({
      description: item.description,
      ...(item.category ? { category: item.category } : {}),
      defaultQuantity: item.quantity,
      defaultUnitPriceCents: item.unitPriceCents,
      taxable: item.taxable,
      sortOrder: item.sortOrder,
    })),
    ...(input.defaultNotes !== undefined ? { defaultNotes: input.defaultNotes } : {}),
  };

  return createProposal({
    tenantId: ctx.tenantId,
    proposalType: 'onboarding_estimate_template',
    payload: payload as unknown as Record<string, unknown>,
    summary: `Estimate template: ${input.name} (${input.verticalType})`,
    sourceContext: { packId: input.packId },
    createdBy: ctx.createdBy,
  });
}

export async function findTemplate(
  verticalType: VerticalType,
  serviceCategory: ServiceCategory,
  repository: EstimateTemplateRepository
): Promise<EstimateTemplate | null> {
  // Exact match: verticalType + serviceCategory
  const exact = await repository.findByVerticalAndCategory(verticalType, serviceCategory);
  if (exact) return exact;

  // Fallback: lowest-sortOrder template for the vertical (vertical-only default)
  const verticalTemplates = await repository.findByVertical(verticalType);
  if (verticalTemplates.length > 0) {
    const sorted = verticalTemplates.sort((a, b) => a.sortOrder - b.sortOrder);
    return sorted[0];
  }

  return null;
}

export class InMemoryEstimateTemplateRepository implements EstimateTemplateRepository {
  private templates: Map<string, EstimateTemplate> = new Map();

  async create(template: EstimateTemplate): Promise<EstimateTemplate> {
    this.templates.set(template.id, { ...template, defaultLineItems: template.defaultLineItems.map(li => ({ ...li })) });
    return { ...template, defaultLineItems: template.defaultLineItems.map(li => ({ ...li })) };
  }

  async findById(id: string): Promise<EstimateTemplate | null> {
    const t = this.templates.get(id);
    return t ? { ...t, defaultLineItems: t.defaultLineItems.map(li => ({ ...li })) } : null;
  }

  async findByVerticalAndCategory(verticalType: VerticalType, category: ServiceCategory): Promise<EstimateTemplate | null> {
    const found = Array.from(this.templates.values()).find(
      (t) => t.verticalType === verticalType && t.serviceCategory === category
    );
    return found ? { ...found, defaultLineItems: found.defaultLineItems.map(li => ({ ...li })) } : null;
  }

  async findByVertical(verticalType: VerticalType): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.verticalType === verticalType)
      .map((t) => ({ ...t, defaultLineItems: t.defaultLineItems.map(li => ({ ...li })) }));
  }

  async list(): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .map((t) => ({ ...t, defaultLineItems: t.defaultLineItems.map(li => ({ ...li })) }));
  }
}
