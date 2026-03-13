import { v4 as uuidv4 } from 'uuid';
import { VerticalType, PackStatus, isValidVerticalType, isValidPackStatus } from './vertical-types';

export interface VerticalPack {
  id: string;
  packId: string;
  version: string;
  verticalType: VerticalType;
  status: PackStatus;
  displayName: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePackInput {
  packId: string;
  version: string;
  verticalType: VerticalType;
  status?: PackStatus;
  displayName: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export function validatePackInput(input: CreatePackInput): string[] {
  const errors: string[] = [];
  if (!input.packId) errors.push('packId is required');
  if (!input.version) errors.push('version is required');
  if (!input.verticalType) {
    errors.push('verticalType is required');
  } else if (!isValidVerticalType(input.verticalType)) {
    errors.push('Invalid verticalType');
  }
  if (!input.displayName) errors.push('displayName is required');
  if (input.status && !isValidPackStatus(input.status)) {
    errors.push('Invalid status');
  }
  return errors;
}

export interface VerticalPackRegistry {
  register(pack: VerticalPack): Promise<VerticalPack>;
  get(id: string): Promise<VerticalPack | null>;
  getByPackId(packId: string): Promise<VerticalPack | null>;
  findByVertical(verticalType: VerticalType): Promise<VerticalPack[]>;
  list(): Promise<VerticalPack[]>;
  update(id: string, updates: Partial<VerticalPack>): Promise<VerticalPack | null>;
}

export async function registerPack(
  input: CreatePackInput,
  registry: VerticalPackRegistry
): Promise<VerticalPack> {
  const pack: VerticalPack = {
    id: uuidv4(),
    packId: input.packId,
    version: input.version,
    verticalType: input.verticalType,
    status: input.status || 'draft',
    displayName: input.displayName,
    description: input.description,
    metadata: input.metadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return registry.register(pack);
}

export async function activatePackStatus(
  id: string,
  registry: VerticalPackRegistry
): Promise<VerticalPack | null> {
  return registry.update(id, { status: 'active', updatedAt: new Date() });
}

export async function deprecatePack(
  id: string,
  registry: VerticalPackRegistry
): Promise<VerticalPack | null> {
  return registry.update(id, { status: 'deprecated', updatedAt: new Date() });
}

export class InMemoryVerticalPackRegistry implements VerticalPackRegistry {
  private packs: Map<string, VerticalPack> = new Map();

  async register(pack: VerticalPack): Promise<VerticalPack> {
    this.packs.set(pack.id, JSON.parse(JSON.stringify(pack)));
    return JSON.parse(JSON.stringify(pack));
  }

  async get(id: string): Promise<VerticalPack | null> {
    const pack = this.packs.get(id);
    return pack ? { ...pack } : null;
  }

  async getByPackId(packId: string): Promise<VerticalPack | null> {
    const found = Array.from(this.packs.values()).find((p) => p.packId === packId);
    return found ? { ...found } : null;
  }

  async findByVertical(verticalType: VerticalType): Promise<VerticalPack[]> {
    return Array.from(this.packs.values())
      .filter((p) => p.verticalType === verticalType)
      .map((p) => ({ ...p }));
  }

  async list(): Promise<VerticalPack[]> {
    return Array.from(this.packs.values()).map((p) => ({ ...p }));
  }

  async update(id: string, updates: Partial<VerticalPack>): Promise<VerticalPack | null> {
    const pack = this.packs.get(id);
    if (!pack) return null;
    const updated = { ...pack, ...updates };
    this.packs.set(id, updated);
    return { ...updated };
  }
}
