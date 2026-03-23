import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

export type ActivationStatus = 'active' | 'deactivated';

export interface TenantPackActivation {
  id: string;
  tenantId: string;
  packId: string;
  activatedAt: Date;
  deactivatedAt?: Date;
  status: ActivationStatus;
}

export interface ActivatePackInput {
  tenantId: string;
  packId: string;
}

export interface PackActivationRepository {
  create(activation: TenantPackActivation): Promise<TenantPackActivation>;
  findByTenant(tenantId: string): Promise<TenantPackActivation[]>;
  findByTenantAndPack(tenantId: string, packId: string): Promise<TenantPackActivation | null>;
  update(id: string, updates: Partial<TenantPackActivation>): Promise<TenantPackActivation | null>;
}

export function validateActivationInput(input: ActivatePackInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.packId) errors.push('packId is required');
  return errors;
}

export async function activatePack(
  input: ActivatePackInput,
  repository: PackActivationRepository
): Promise<TenantPackActivation> {
  const errors = validateActivationInput(input);
  if (errors.length > 0) {
    throw new ValidationError('Invalid activation input', { errors });
  }

  const existing = await repository.findByTenantAndPack(input.tenantId, input.packId);
  if (existing && existing.status === 'active') {
    throw new Error('Pack already activated for this tenant');
  }

  if (existing && existing.status === 'deactivated') {
    const reactivated = await repository.update(existing.id, {
      status: 'active',
      activatedAt: new Date(),
      deactivatedAt: undefined,
    });
    if (!reactivated) throw new Error('Failed to reactivate pack');
    return reactivated;
  }

  const activation: TenantPackActivation = {
    id: uuidv4(),
    tenantId: input.tenantId,
    packId: input.packId,
    activatedAt: new Date(),
    status: 'active',
  };

  return repository.create(activation);
}

export async function deactivatePack(
  tenantId: string,
  packId: string,
  repository: PackActivationRepository
): Promise<TenantPackActivation | null> {
  const existing = await repository.findByTenantAndPack(tenantId, packId);
  if (!existing) return null;
  if (existing.status === 'deactivated') return { ...existing };

  return repository.update(existing.id, {
    status: 'deactivated',
    deactivatedAt: new Date(),
  });
}

export async function getActivePacks(
  tenantId: string,
  repository: PackActivationRepository
): Promise<TenantPackActivation[]> {
  const all = await repository.findByTenant(tenantId);
  return all.filter((a) => a.status === 'active');
}

export class InMemoryPackActivationRepository implements PackActivationRepository {
  private activations: Map<string, TenantPackActivation> = new Map();

  async create(activation: TenantPackActivation): Promise<TenantPackActivation> {
    this.activations.set(activation.id, { ...activation });
    return { ...activation };
  }

  async findByTenant(tenantId: string): Promise<TenantPackActivation[]> {
    return Array.from(this.activations.values())
      .filter((a) => a.tenantId === tenantId)
      .map((a) => ({ ...a }));
  }

  async findByTenantAndPack(tenantId: string, packId: string): Promise<TenantPackActivation | null> {
    const found = Array.from(this.activations.values()).find(
      (a) => a.tenantId === tenantId && a.packId === packId
    );
    return found ? { ...found } : null;
  }

  async update(id: string, updates: Partial<TenantPackActivation>): Promise<TenantPackActivation | null> {
    const existing = this.activations.get(id);
    if (!existing) return null;
    const { id: _id, tenantId: _tid, packId: _pid, ...safeUpdates } = updates;
    const updated = { ...existing, ...safeUpdates };
    this.activations.set(id, updated);
    return { ...updated };
  }
}
