import { v4 as uuidv4 } from 'uuid';

export interface BundleItem {
  description: string;
  typicalQuantity?: number;
  typicalUnitPrice?: number;
  isRequired: boolean;
  sortOrder: number;
}

export interface LineItemBundle {
  id: string;
  tenantId: string;
  verticalSlug: string;
  categoryId?: string;
  name: string;
  description: string;
  items: BundleItem[];
  frequency: number;
  confidence: number;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface CreateBundleInput {
  tenantId: string;
  verticalSlug: string;
  categoryId?: string;
  name: string;
  description: string;
  items: BundleItem[];
}

export interface LineItemBundleRepository {
  create(bundle: LineItemBundle): Promise<LineItemBundle>;
  findById(tenantId: string, id: string): Promise<LineItemBundle | null>;
  findByTenant(tenantId: string): Promise<LineItemBundle[]>;
  findByVerticalAndCategory(tenantId: string, verticalSlug: string, categoryId?: string): Promise<LineItemBundle[]>;
  updateFrequency(tenantId: string, id: string, frequency: number): Promise<LineItemBundle | null>;
}

export function validateBundleInput(input: CreateBundleInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.name) errors.push('name is required');
  if (!input.description) errors.push('description is required');
  if (!Array.isArray(input.items)) errors.push('items must be an array');
  return errors;
}

export function createLineItemBundle(input: CreateBundleInput): LineItemBundle {
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    verticalSlug: input.verticalSlug,
    categoryId: input.categoryId,
    name: input.name,
    description: input.description,
    items: input.items,
    frequency: 1,
    confidence: 0,
    lastSeenAt: now,
    createdAt: now,
  };
}

export function incrementBundleFrequency(bundle: LineItemBundle): LineItemBundle {
  return {
    ...bundle,
    frequency: bundle.frequency + 1,
    lastSeenAt: new Date(),
  };
}

export function calculateBundleConfidence(bundle: LineItemBundle, totalEstimates: number): number {
  if (totalEstimates === 0) return 0;
  return Math.min(bundle.frequency / totalEstimates, 1);
}

export class InMemoryLineItemBundleRepository implements LineItemBundleRepository {
  private bundles: Map<string, LineItemBundle> = new Map();

  async create(bundle: LineItemBundle): Promise<LineItemBundle> {
    this.bundles.set(bundle.id, { ...bundle });
    return { ...bundle };
  }

  async findById(tenantId: string, id: string): Promise<LineItemBundle | null> {
    const bundle = this.bundles.get(id);
    if (!bundle || bundle.tenantId !== tenantId) return null;
    return { ...bundle };
  }

  async findByTenant(tenantId: string): Promise<LineItemBundle[]> {
    return Array.from(this.bundles.values())
      .filter((b) => b.tenantId === tenantId)
      .map((b) => ({ ...b }));
  }

  async findByVerticalAndCategory(tenantId: string, verticalSlug: string, categoryId?: string): Promise<LineItemBundle[]> {
    return Array.from(this.bundles.values())
      .filter((b) => {
        if (b.tenantId !== tenantId) return false;
        if (b.verticalSlug !== verticalSlug) return false;
        if (categoryId && b.categoryId !== categoryId) return false;
        return true;
      })
      .map((b) => ({ ...b }));
  }

  async updateFrequency(tenantId: string, id: string, frequency: number): Promise<LineItemBundle | null> {
    const bundle = this.bundles.get(id);
    if (!bundle || bundle.tenantId !== tenantId) return null;
    bundle.frequency = frequency;
    bundle.lastSeenAt = new Date();
    this.bundles.set(id, bundle);
    return { ...bundle };
  }
}
