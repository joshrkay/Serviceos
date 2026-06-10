import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';

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

export interface PackActivationAuditContext {
  actorId: string;
  actorRole?: string;
}

export async function activatePack(
  input: ActivatePackInput,
  repository: PackActivationRepository,
  auditRepo?: AuditRepository,
  auditCtx?: PackActivationAuditContext
): Promise<TenantPackActivation> {
  const existing = await repository.findByTenantAndPack(input.tenantId, input.packId);
  if (existing && existing.status === 'active') {
    // QA-2026-06-04: PUT /:packId/activate is an idempotent verb — an
    // already-active pack is a no-op success, not an error. The previous
    // `throw new Error(...)` surfaced as 500 INTERNAL_ERROR on every
    // re-activation (asyncRoute maps untyped errors to 500), which broke
    // PROV-01/02 re-runs. No audit event: nothing mutated.
    return existing;
  }

  let result: TenantPackActivation;
  let reactivated = false;

  if (existing && existing.status === 'deactivated') {
    const updated = await repository.update(existing.id, {
      status: 'active',
      activatedAt: new Date(),
      deactivatedAt: undefined,
    });
    if (!updated) throw new Error('Failed to reactivate pack');
    result = updated;
    reactivated = true;
  } else {
    const activation: TenantPackActivation = {
      id: uuidv4(),
      tenantId: input.tenantId,
      packId: input.packId,
      activatedAt: new Date(),
      status: 'active',
    };
    result = await repository.create(activation);
  }

  // D2-1e — all mutations emit audit events
  if (auditRepo && auditCtx?.actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: auditCtx.actorId,
        actorRole: auditCtx.actorRole ?? 'unknown',
        eventType: 'pack_activation.activated',
        entityType: 'pack_activation',
        entityId: result.id,
        metadata: { packId: result.packId, reactivated },
      })
    );
  }

  return result;
}

export async function deactivatePack(
  tenantId: string,
  packId: string,
  repository: PackActivationRepository,
  auditRepo?: AuditRepository,
  auditCtx?: PackActivationAuditContext
): Promise<TenantPackActivation | null> {
  const existing = await repository.findByTenantAndPack(tenantId, packId);
  if (!existing) return null;
  if (existing.status === 'deactivated') return { ...existing };

  const updated = await repository.update(existing.id, {
    status: 'deactivated',
    deactivatedAt: new Date(),
  });

  // D2-1e — all mutations emit audit events
  if (updated && auditRepo && auditCtx?.actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: auditCtx.actorId,
        actorRole: auditCtx.actorRole ?? 'unknown',
        eventType: 'pack_activation.deactivated',
        entityType: 'pack_activation',
        entityId: updated.id,
        metadata: { packId: updated.packId },
      })
    );
  }

  return updated;
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
