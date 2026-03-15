import { v4 as uuidv4 } from 'uuid';

export interface VerticalPack {
  id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  terminologyMapId: string;
  taxonomyId: string;
  templateIds: string[];
  isActive: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateVerticalPackInput {
  slug: string;
  name: string;
  version: string;
  description: string;
  terminologyMapId: string;
  taxonomyId: string;
  templateIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface VerticalPackRepository {
  create(pack: VerticalPack): Promise<VerticalPack>;
  findById(id: string): Promise<VerticalPack | null>;
  findBySlug(slug: string): Promise<VerticalPack | null>;
  findAll(): Promise<VerticalPack[]>;
  findActive(): Promise<VerticalPack[]>;
}

export function validateVerticalPackInput(input: CreateVerticalPackInput): string[] {
  const errors: string[] = [];
  if (!input.slug) errors.push('slug is required');
  if (!input.name) errors.push('name is required');
  if (!input.version) errors.push('version is required');
  if (!input.description) errors.push('description is required');
  if (!input.terminologyMapId) errors.push('terminologyMapId is required');
  if (!input.taxonomyId) errors.push('taxonomyId is required');
  return errors;
}

export function createVerticalPack(input: CreateVerticalPackInput): VerticalPack {
  return {
    id: uuidv4(),
    slug: input.slug,
    name: input.name,
    version: input.version,
    description: input.description,
    terminologyMapId: input.terminologyMapId,
    taxonomyId: input.taxonomyId,
    templateIds: input.templateIds || [],
    isActive: true,
    metadata: input.metadata,
    createdAt: new Date(),
  };
}

export class InMemoryVerticalPackRepository implements VerticalPackRepository {
  private packs: Map<string, VerticalPack> = new Map();

  async create(pack: VerticalPack): Promise<VerticalPack> {
    this.packs.set(pack.id, { ...pack });
    return { ...pack };
  }

  async findById(id: string): Promise<VerticalPack | null> {
    const pack = this.packs.get(id);
    return pack ? { ...pack } : null;
  }

  async findBySlug(slug: string): Promise<VerticalPack | null> {
    for (const pack of this.packs.values()) {
      if (pack.slug === slug) return { ...pack };
    }
    return null;
  }

  async findAll(): Promise<VerticalPack[]> {
    return Array.from(this.packs.values()).map((p) => ({ ...p }));
  }

  async findActive(): Promise<VerticalPack[]> {
    return Array.from(this.packs.values())
      .filter((p) => p.isActive)
      .map((p) => ({ ...p }));
  }
}
