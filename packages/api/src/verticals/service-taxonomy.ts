import { v4 as uuidv4 } from 'uuid';

export interface ServiceCategory {
  id: string;
  name: string;
  parentId?: string;
  description: string;
  tags: string[];
  sortOrder: number;
}

export interface ServiceTaxonomy {
  id: string;
  verticalSlug: string;
  version: string;
  categories: ServiceCategory[];
  createdAt: Date;
}

export interface CreateServiceTaxonomyInput {
  verticalSlug: string;
  version: string;
  categories: ServiceCategory[];
}

export interface ServiceTaxonomyRepository {
  create(taxonomy: ServiceTaxonomy): Promise<ServiceTaxonomy>;
  findById(id: string): Promise<ServiceTaxonomy | null>;
  findByVertical(verticalSlug: string): Promise<ServiceTaxonomy[]>;
  findLatestByVertical(verticalSlug: string): Promise<ServiceTaxonomy | null>;
}

export function validateServiceTaxonomyInput(input: CreateServiceTaxonomyInput): string[] {
  const errors: string[] = [];
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.version) errors.push('version is required');
  if (!Array.isArray(input.categories)) errors.push('categories must be an array');
  return errors;
}

export function createServiceTaxonomy(input: CreateServiceTaxonomyInput): ServiceTaxonomy {
  return {
    id: uuidv4(),
    verticalSlug: input.verticalSlug,
    version: input.version,
    categories: input.categories,
    createdAt: new Date(),
  };
}

export function findCategoryById(taxonomy: ServiceTaxonomy, categoryId: string): ServiceCategory | null {
  return taxonomy.categories.find((c) => c.id === categoryId) || null;
}

export function findCategoryByName(taxonomy: ServiceTaxonomy, name: string): ServiceCategory | null {
  const lower = name.toLowerCase();
  return taxonomy.categories.find((c) => c.name.toLowerCase() === lower) || null;
}

export function getCategoryPath(taxonomy: ServiceTaxonomy, categoryId: string): ServiceCategory[] {
  const path: ServiceCategory[] = [];
  let current = findCategoryById(taxonomy, categoryId);
  while (current) {
    path.unshift(current);
    current = current.parentId ? findCategoryById(taxonomy, current.parentId) : null;
  }
  return path;
}

export class InMemoryServiceTaxonomyRepository implements ServiceTaxonomyRepository {
  private taxonomies: Map<string, ServiceTaxonomy> = new Map();

  async create(taxonomy: ServiceTaxonomy): Promise<ServiceTaxonomy> {
    this.taxonomies.set(taxonomy.id, { ...taxonomy });
    return { ...taxonomy };
  }

  async findById(id: string): Promise<ServiceTaxonomy | null> {
    const taxonomy = this.taxonomies.get(id);
    return taxonomy ? { ...taxonomy } : null;
  }

  async findByVertical(verticalSlug: string): Promise<ServiceTaxonomy[]> {
    return Array.from(this.taxonomies.values())
      .filter((t) => t.verticalSlug === verticalSlug)
      .map((t) => ({ ...t }));
  }

  async findLatestByVertical(verticalSlug: string): Promise<ServiceTaxonomy | null> {
    const taxonomies = Array.from(this.taxonomies.values())
      .filter((t) => t.verticalSlug === verticalSlug)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return taxonomies.length > 0 ? { ...taxonomies[0] } : null;
  }
}
