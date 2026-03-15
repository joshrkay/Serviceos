import { v4 as uuidv4 } from 'uuid';

export interface LineItemTemplate {
  description: string;
  defaultQuantity?: number;
  defaultUnitPrice?: number;
  category?: string;
  isOptional: boolean;
  sortOrder: number;
}

export interface EstimateTemplate {
  id: string;
  tenantId: string | null;
  verticalSlug: string;
  categoryId: string;
  name: string;
  description: string;
  version: number;
  lineItemTemplates: LineItemTemplate[];
  promptHints: string[];
  metadata?: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
}

export interface CreateEstimateTemplateInput {
  tenantId?: string;
  verticalSlug: string;
  categoryId: string;
  name: string;
  description: string;
  lineItemTemplates: LineItemTemplate[];
  promptHints?: string[];
  metadata?: Record<string, unknown>;
}

export interface EstimateTemplateRepository {
  create(template: EstimateTemplate): Promise<EstimateTemplate>;
  findById(id: string): Promise<EstimateTemplate | null>;
  findByVerticalAndCategory(verticalSlug: string, categoryId: string): Promise<EstimateTemplate[]>;
  findActive(verticalSlug: string): Promise<EstimateTemplate[]>;
  findByTenant(tenantId: string): Promise<EstimateTemplate[]>;
}

export function validateEstimateTemplateInput(input: CreateEstimateTemplateInput): string[] {
  const errors: string[] = [];
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.categoryId) errors.push('categoryId is required');
  if (!input.name) errors.push('name is required');
  if (!input.description) errors.push('description is required');
  if (!Array.isArray(input.lineItemTemplates)) errors.push('lineItemTemplates must be an array');
  return errors;
}

export function createEstimateTemplate(input: CreateEstimateTemplateInput): EstimateTemplate {
  return {
    id: uuidv4(),
    tenantId: input.tenantId || null,
    verticalSlug: input.verticalSlug,
    categoryId: input.categoryId,
    name: input.name,
    description: input.description,
    version: 1,
    lineItemTemplates: input.lineItemTemplates,
    promptHints: input.promptHints || [],
    metadata: input.metadata,
    isActive: true,
    createdAt: new Date(),
  };
}

export class InMemoryEstimateTemplateRepository implements EstimateTemplateRepository {
  private templates: Map<string, EstimateTemplate> = new Map();

  async create(template: EstimateTemplate): Promise<EstimateTemplate> {
    this.templates.set(template.id, { ...template });
    return { ...template };
  }

  async findById(id: string): Promise<EstimateTemplate | null> {
    const template = this.templates.get(id);
    return template ? { ...template } : null;
  }

  async findByVerticalAndCategory(verticalSlug: string, categoryId: string): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.verticalSlug === verticalSlug && t.categoryId === categoryId && t.isActive)
      .map((t) => ({ ...t }));
  }

  async findActive(verticalSlug: string): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.verticalSlug === verticalSlug && t.isActive)
      .map((t) => ({ ...t }));
  }

  async findByTenant(tenantId: string): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.tenantId === tenantId)
      .map((t) => ({ ...t }));
  }
}
