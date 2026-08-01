import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { SettingsRepository } from './settings';

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

/**
 * Single-source-of-truth reconciliation for active vertical packs.
 *
 * Packs are tracked in two places:
 *   (a) the `pack_activations` table — the authoritative source, written
 *       by every activate/deactivate path; and
 *   (b) `tenant_settings.terminology_preferences._activeVerticalPacks` —
 *       a read mirror consumed by the Templates page (LiveTemplatesSection)
 *       and the public intake form (routes/public-intake.ts).
 *
 * Nothing kept them in sync, so any activate/deactivate through the
 * Vertical Packs settings sheet (routes/pack-activation.ts) left the
 * mirror stale — the Templates page and public intake showed the wrong
 * packs (drift). This derives the mirror from the authoritative table and
 * writes it back, so a single call after any pack_activations write keeps
 * both in lock-step. In the request scope both writes share the same
 * tenant transaction (see PgBaseRepository.withTenantTransaction), so the
 * mirror update commits or rolls back atomically with the table write.
 *
 * No-op (returns false) when the tenant has no settings row yet — the
 * mirror is materialized when that row is first created (onboarding seeds
 * `activeVerticalPacks` at creation time), and `settingsRepo.update`
 * returns null for a missing row rather than creating a partial one.
 */
export async function syncActiveVerticalPacksMirror(
  tenantId: string,
  packActivationRepo: PackActivationRepository,
  settingsRepo: Pick<SettingsRepository, 'update'>
): Promise<boolean> {
  const active = await getActivePacks(tenantId, packActivationRepo);
  const packIds = active
    .sort((a, b) => b.activatedAt.getTime() - a.activatedAt.getTime())
    .map((a) => a.packId);
  // `activeVerticalPacks: []` is an explicit clear (defined, not undefined),
  // so a tenant with every pack deactivated correctly empties the mirror.
  const updated = await settingsRepo.update(tenantId, { activeVerticalPacks: packIds });
  return updated !== null;
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
