// P4-006A/006B: Bundle Patterns
// Common service bundles for estimate generation (e.g., "AC tune-up + filter replacement")

import { v4 as uuidv4 } from 'uuid';
import { VerticalType } from './registry';
import { LineItemTemplate } from '../templates/estimate-template';

export interface ServiceBundle {
  id: string;
  tenantId: string;
  verticalType: VerticalType;
  name: string;
  description?: string;
  categoryIds: string[];
  lineItemTemplates: LineItemTemplate[];
  triggerKeywords: string[];
  isActive: boolean;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBundleInput {
  tenantId: string;
  verticalType: VerticalType;
  name: string;
  description?: string;
  categoryIds: string[];
  lineItemTemplates: LineItemTemplate[];
  triggerKeywords: string[];
}

export interface ServiceBundleRepository {
  create(bundle: ServiceBundle): Promise<ServiceBundle>;
  findById(tenantId: string, id: string): Promise<ServiceBundle | null>;
  findByTenant(tenantId: string): Promise<ServiceBundle[]>;
  findByVertical(tenantId: string, verticalType: VerticalType): Promise<ServiceBundle[]>;
  findByKeyword(tenantId: string, keyword: string): Promise<ServiceBundle[]>;
  update(tenantId: string, id: string, updates: Partial<ServiceBundle>): Promise<ServiceBundle | null>;
  incrementUsage(tenantId: string, id: string): Promise<void>;
}

export function validateBundleInput(input: CreateBundleInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.verticalType) errors.push('verticalType is required');
  if (!input.name) errors.push('name is required');
  if (!input.categoryIds || input.categoryIds.length === 0) {
    errors.push('at least one categoryId is required');
  }
  if (!input.lineItemTemplates || input.lineItemTemplates.length === 0) {
    errors.push('at least one line item template is required');
  }
  if (!input.triggerKeywords || input.triggerKeywords.length === 0) {
    errors.push('at least one trigger keyword is required');
  }
  return errors;
}

export async function createBundle(
  input: CreateBundleInput,
  repository: ServiceBundleRepository
): Promise<ServiceBundle> {
  const errors = validateBundleInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const bundle: ServiceBundle = {
    id: uuidv4(),
    tenantId: input.tenantId,
    verticalType: input.verticalType,
    name: input.name,
    description: input.description,
    categoryIds: input.categoryIds,
    lineItemTemplates: input.lineItemTemplates,
    triggerKeywords: input.triggerKeywords.map((k) => k.toLowerCase()),
    isActive: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return repository.create(bundle);
}

export function matchBundles(
  bundles: ServiceBundle[],
  text: string
): ServiceBundle[] {
  const normalizedText = text.toLowerCase();
  const matched: Array<{ bundle: ServiceBundle; score: number }> = [];

  for (const bundle of bundles) {
    if (!bundle.isActive) continue;
    let score = 0;
    for (const keyword of bundle.triggerKeywords) {
      if (normalizedText.includes(keyword)) {
        score += keyword.split(' ').length; // Multi-word matches score higher
      }
    }
    if (score > 0) {
      matched.push({ bundle, score });
    }
  }

  return matched
    .sort((a, b) => b.score - a.score)
    .map((m) => m.bundle);
}

export class InMemoryServiceBundleRepository implements ServiceBundleRepository {
  private bundles: Map<string, ServiceBundle> = new Map();

  async create(bundle: ServiceBundle): Promise<ServiceBundle> {
    this.bundles.set(bundle.id, { ...bundle });
    return { ...bundle };
  }

  async findById(tenantId: string, id: string): Promise<ServiceBundle | null> {
    const b = this.bundles.get(id);
    if (!b || b.tenantId !== tenantId) return null;
    return { ...b };
  }

  async findByTenant(tenantId: string): Promise<ServiceBundle[]> {
    return Array.from(this.bundles.values())
      .filter((b) => b.tenantId === tenantId)
      .map((b) => ({ ...b }));
  }

  async findByVertical(tenantId: string, verticalType: VerticalType): Promise<ServiceBundle[]> {
    return Array.from(this.bundles.values())
      .filter((b) => b.tenantId === tenantId && b.verticalType === verticalType)
      .map((b) => ({ ...b }));
  }

  async findByKeyword(tenantId: string, keyword: string): Promise<ServiceBundle[]> {
    const normalizedKeyword = keyword.toLowerCase();
    return Array.from(this.bundles.values())
      .filter(
        (b) =>
          b.tenantId === tenantId &&
          b.isActive &&
          b.triggerKeywords.some((k) => k.includes(normalizedKeyword))
      )
      .map((b) => ({ ...b }));
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<ServiceBundle>
  ): Promise<ServiceBundle | null> {
    const b = this.bundles.get(id);
    if (!b || b.tenantId !== tenantId) return null;
    const updated = { ...b, ...updates, updatedAt: new Date() };
    this.bundles.set(id, updated);
    return { ...updated };
  }

  async incrementUsage(tenantId: string, id: string): Promise<void> {
    const b = this.bundles.get(id);
    if (b && b.tenantId === tenantId) {
      b.usageCount += 1;
      this.bundles.set(id, b);
    }
  }
}
