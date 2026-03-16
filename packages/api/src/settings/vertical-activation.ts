import { v4 as uuidv4 } from 'uuid';

export interface VerticalActivation {
  id: string;
  tenantId: string;
  verticalPackId: string;
  verticalSlug: string;
  activatedAt: Date;
  activatedBy: string;
  config?: Record<string, unknown>;
  isActive: boolean;
}

export interface CreateVerticalActivationInput {
  tenantId: string;
  verticalPackId: string;
  verticalSlug: string;
  activatedBy: string;
  config?: Record<string, unknown>;
}

export interface VerticalActivationRepository {
  create(activation: VerticalActivation): Promise<VerticalActivation>;
  findByTenant(tenantId: string): Promise<VerticalActivation[]>;
  findByTenantAndSlug(tenantId: string, verticalSlug: string): Promise<VerticalActivation | null>;
  deactivate(tenantId: string, id: string): Promise<VerticalActivation | null>;
}

export function validateVerticalActivationInput(input: CreateVerticalActivationInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.verticalPackId) errors.push('verticalPackId is required');
  if (!input.verticalSlug) errors.push('verticalSlug is required');
  if (!input.activatedBy) errors.push('activatedBy is required');
  return errors;
}

export function createVerticalActivation(input: CreateVerticalActivationInput): VerticalActivation {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    verticalPackId: input.verticalPackId,
    verticalSlug: input.verticalSlug,
    activatedAt: new Date(),
    activatedBy: input.activatedBy,
    config: input.config,
    isActive: true,
  };
}

export function deactivateVertical(activation: VerticalActivation): VerticalActivation {
  return {
    ...activation,
    isActive: false,
  };
}

export async function getActiveVerticals(
  tenantId: string,
  repo: VerticalActivationRepository
): Promise<VerticalActivation[]> {
  const all = await repo.findByTenant(tenantId);
  return all.filter((a) => a.isActive);
}

export class InMemoryVerticalActivationRepository implements VerticalActivationRepository {
  private activations: Map<string, VerticalActivation> = new Map();

  async create(activation: VerticalActivation): Promise<VerticalActivation> {
    this.activations.set(activation.id, { ...activation });
    return { ...activation };
  }

  async findByTenant(tenantId: string): Promise<VerticalActivation[]> {
    return Array.from(this.activations.values())
      .filter((a) => a.tenantId === tenantId)
      .map((a) => ({ ...a }));
  }

  async findByTenantAndSlug(tenantId: string, verticalSlug: string): Promise<VerticalActivation | null> {
    for (const a of this.activations.values()) {
      if (a.tenantId === tenantId && a.verticalSlug === verticalSlug && a.isActive) {
        return { ...a };
      }
    }
    return null;
  }

  async deactivate(tenantId: string, id: string): Promise<VerticalActivation | null> {
    const activation = this.activations.get(id);
    if (!activation || activation.tenantId !== tenantId) return null;
    activation.isActive = false;
    this.activations.set(id, activation);
    return { ...activation };
  }
}
