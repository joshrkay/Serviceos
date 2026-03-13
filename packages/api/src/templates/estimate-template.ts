// P4-004A/004B/004C: Estimate Templates System
// Templates for common service types, seeded per vertical pack

import { v4 as uuidv4 } from 'uuid';
import { LineItem, buildLineItem, calculateDocumentTotals, DocumentTotals } from '../shared/billing-engine';
import { VerticalType } from '../verticals/registry';
import { ValidationError } from '../shared/errors';

export interface EstimateTemplate {
  id: string;
  tenantId: string;
  verticalType: VerticalType;
  categoryId: string;
  name: string;
  description?: string;
  lineItemTemplates: LineItemTemplate[];
  defaultDiscountCents: number;
  defaultTaxRateBps: number;
  defaultCustomerMessage?: string;
  isActive: boolean;
  usageCount: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LineItemTemplate {
  description: string;
  category: 'labor' | 'material' | 'equipment' | 'other';
  defaultQuantity: number;
  defaultUnitPriceCents: number;
  taxable: boolean;
  sortOrder: number;
  isOptional: boolean;
}

export interface CreateTemplateInput {
  tenantId: string;
  verticalType: VerticalType;
  categoryId: string;
  name: string;
  description?: string;
  lineItemTemplates: LineItemTemplate[];
  defaultDiscountCents?: number;
  defaultTaxRateBps?: number;
  defaultCustomerMessage?: string;
  createdBy: string;
}

export interface EstimateTemplateRepository {
  create(template: EstimateTemplate): Promise<EstimateTemplate>;
  findById(tenantId: string, id: string): Promise<EstimateTemplate | null>;
  findByTenant(tenantId: string): Promise<EstimateTemplate[]>;
  findByCategory(tenantId: string, categoryId: string): Promise<EstimateTemplate[]>;
  findByVertical(tenantId: string, verticalType: VerticalType): Promise<EstimateTemplate[]>;
  update(tenantId: string, id: string, updates: Partial<EstimateTemplate>): Promise<EstimateTemplate | null>;
  incrementUsage(tenantId: string, id: string): Promise<void>;
}

export function validateTemplateInput(input: CreateTemplateInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.verticalType) errors.push('verticalType is required');
  if (!input.categoryId) errors.push('categoryId is required');
  if (!input.name) errors.push('name is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.lineItemTemplates || input.lineItemTemplates.length === 0) {
    errors.push('at least one line item template is required');
  }
  if (input.lineItemTemplates) {
    for (let i = 0; i < input.lineItemTemplates.length; i++) {
      const item = input.lineItemTemplates[i];
      if (!item.description) errors.push(`lineItemTemplates[${i}].description is required`);
      if (item.defaultQuantity < 0) errors.push(`lineItemTemplates[${i}].defaultQuantity must be non-negative`);
      if (item.defaultUnitPriceCents < 0) errors.push(`lineItemTemplates[${i}].defaultUnitPriceCents must be non-negative`);
    }
  }
  return errors;
}

export async function createTemplate(
  input: CreateTemplateInput,
  repository: EstimateTemplateRepository
): Promise<EstimateTemplate> {
  const errors = validateTemplateInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const template: EstimateTemplate = {
    id: uuidv4(),
    tenantId: input.tenantId,
    verticalType: input.verticalType,
    categoryId: input.categoryId,
    name: input.name,
    description: input.description,
    lineItemTemplates: input.lineItemTemplates,
    defaultDiscountCents: input.defaultDiscountCents ?? 0,
    defaultTaxRateBps: input.defaultTaxRateBps ?? 0,
    defaultCustomerMessage: input.defaultCustomerMessage,
    isActive: true,
    usageCount: 0,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return repository.create(template);
}

export function instantiateTemplate(template: EstimateTemplate): {
  lineItems: LineItem[];
  totals: DocumentTotals;
} {
  const lineItems = template.lineItemTemplates
    .filter((t) => !t.isOptional)
    .map((t, index) =>
      buildLineItem(
        uuidv4(),
        t.description,
        t.defaultQuantity,
        t.defaultUnitPriceCents,
        t.sortOrder || index,
        t.taxable,
        t.category
      )
    );

  const totals = calculateDocumentTotals(
    lineItems,
    template.defaultDiscountCents,
    template.defaultTaxRateBps
  );

  return { lineItems, totals };
}

export function findBestTemplate(
  templates: EstimateTemplate[],
  categoryId: string,
  keywords: string[]
): EstimateTemplate | null {
  // Exact category match
  const categoryMatches = templates.filter(
    (t) => t.isActive && t.categoryId === categoryId
  );

  if (categoryMatches.length === 0) return null;
  if (categoryMatches.length === 1) return categoryMatches[0];

  // Score by keyword matches in name/description
  const normalizedKeywords = keywords.map((k) => k.toLowerCase());
  let bestMatch: EstimateTemplate | null = null;
  let bestScore = -1;

  for (const template of categoryMatches) {
    let score = 0;
    const searchText = `${template.name} ${template.description || ''}`.toLowerCase();
    for (const keyword of normalizedKeywords) {
      if (searchText.includes(keyword)) score++;
    }
    // Boost by usage count (more used templates are likely better)
    score += Math.min(template.usageCount * 0.1, 5);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  return bestMatch;
}

export class InMemoryEstimateTemplateRepository implements EstimateTemplateRepository {
  private templates: Map<string, EstimateTemplate> = new Map();

  async create(template: EstimateTemplate): Promise<EstimateTemplate> {
    this.templates.set(template.id, { ...template });
    return { ...template };
  }

  async findById(tenantId: string, id: string): Promise<EstimateTemplate | null> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return null;
    return { ...t };
  }

  async findByTenant(tenantId: string): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.tenantId === tenantId)
      .map((t) => ({ ...t }));
  }

  async findByCategory(tenantId: string, categoryId: string): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.tenantId === tenantId && t.categoryId === categoryId)
      .map((t) => ({ ...t }));
  }

  async findByVertical(tenantId: string, verticalType: VerticalType): Promise<EstimateTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.tenantId === tenantId && t.verticalType === verticalType)
      .map((t) => ({ ...t }));
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<EstimateTemplate>
  ): Promise<EstimateTemplate | null> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return null;
    const updated = { ...t, ...updates, updatedAt: new Date() };
    this.templates.set(id, updated);
    return { ...updated };
  }

  async incrementUsage(tenantId: string, id: string): Promise<void> {
    const t = this.templates.get(id);
    if (t && t.tenantId === tenantId) {
      t.usageCount += 1;
      this.templates.set(id, t);
    }
  }
}
