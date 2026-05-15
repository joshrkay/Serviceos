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

function clonePack(pack: VerticalPack): VerticalPack {
  return {
    ...pack,
    metadata: pack.metadata ? JSON.parse(JSON.stringify(pack.metadata)) : undefined,
    createdAt: new Date(pack.createdAt),
    updatedAt: new Date(pack.updatedAt),
  };
}

function isCanonicalSeededPack(pack: VerticalPack): boolean {
  return pack.metadata?.canonical === true || pack.metadata?.seededBy === 'createApp';
}

export class InMemoryVerticalPackRegistry implements VerticalPackRegistry {
  private packs: Map<string, VerticalPack> = new Map();

  async register(pack: VerticalPack): Promise<VerticalPack> {
    const existing = Array.from(this.packs.values()).find((p) => p.packId === pack.packId);
    if (existing) {
      if (isCanonicalSeededPack(existing) && isCanonicalSeededPack(pack)) {
        const refreshed = {
          ...clonePack(pack),
          id: existing.id,
          createdAt: new Date(existing.createdAt),
        };
        this.packs.set(existing.id, refreshed);
        return clonePack(refreshed);
      }
      return clonePack(existing);
    }

    this.packs.set(pack.id, clonePack(pack));
    return clonePack(pack);
  }

  async get(id: string): Promise<VerticalPack | null> {
    const pack = this.packs.get(id);
    return pack ? clonePack(pack) : null;
  }

  async getByPackId(packId: string): Promise<VerticalPack | null> {
    const found = Array.from(this.packs.values()).find((p) => p.packId === packId);
    return found ? clonePack(found) : null;
  }

  async findByVertical(verticalType: VerticalType): Promise<VerticalPack[]> {
    return Array.from(this.packs.values())
      .filter((p) => p.verticalType === verticalType)
      .map(clonePack);
  }

  async list(): Promise<VerticalPack[]> {
    return Array.from(this.packs.values()).map(clonePack);
  }

  async update(id: string, updates: Partial<VerticalPack>): Promise<VerticalPack | null> {
    const pack = this.packs.get(id);
    if (!pack) return null;
    const { id: _id, packId: _pid, createdAt: _ca, ...safeUpdates } = updates;
    const updated = { ...pack, ...safeUpdates };
    this.packs.set(id, updated);
    return clonePack(updated);
  }
}
