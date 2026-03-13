import { v4 as uuidv4 } from 'uuid';
import { VerticalType, ServiceCategory } from '../../shared/vertical-types';
import { LineItemCategory } from '../../shared/billing-engine';

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

export interface EstimateTemplateRepository {
  create(template: EstimateTemplate): Promise<EstimateTemplate>;
  findById(id: string): Promise<EstimateTemplate | null>;
  findByVerticalAndCategory(verticalType: VerticalType, category: ServiceCategory): Promise<EstimateTemplate | null>;
  findByVertical(verticalType: VerticalType): Promise<EstimateTemplate[]>;
  list(): Promise<EstimateTemplate[]>;
}

export async function createTemplate(
  input: CreateTemplateInput,
  repository: EstimateTemplateRepository
): Promise<EstimateTemplate> {
  const template: EstimateTemplate = {
    id: uuidv4(),
    packId: input.packId,
    verticalType: input.verticalType,
    serviceCategory: input.serviceCategory,
    name: input.name,
    defaultLineItems: input.defaultLineItems,
    defaultNotes: input.defaultNotes,
    sortOrder: input.sortOrder ?? 0,
    metadata: input.metadata,
    createdAt: new Date(),
  };

  return repository.create(template);
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
    this.templates.set(template.id, { ...template, defaultLineItems: [...template.defaultLineItems] });
    return { ...template, defaultLineItems: [...template.defaultLineItems] };
  }
    this.templates.set(template.id, { ...template, defaultLineItems: template.defaultLineItems.map(li => ({ ...li })) });
    return { ...template, defaultLineItems: template.defaultLineItems.map(li => ({ ...li })) };
    const t = this.templates.get(id);
    return t ? { ...t, defaultLineItems: [...t.defaultLineItems] } : null;
  }

  async findByVerticalAndCategory(verticalType: VerticalType, category: ServiceCategory): Promise<EstimateTemplate | null> {
    const found = Array.from(this.templates.values()).find(
      (t) => t.verticalType === verticalType && t.serviceCategory === category
    );
    return found ? { ...found, defaultLineItems: [...found.defaultLineItems] } : null;
  }

  async findByVertical(verticalType: VerticalType): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.verticalType === verticalType)
      .map((t) => ({ ...t, defaultLineItems: [...t.defaultLineItems] }));
  }

  async list(): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .map((t) => ({ ...t, defaultLineItems: [...t.defaultLineItems] }));
  }
}
