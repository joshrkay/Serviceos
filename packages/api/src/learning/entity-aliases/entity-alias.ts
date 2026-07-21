import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { EntityKind } from '../../ai/resolution/entity-resolver';
import { ValidationError } from '../../shared/errors';

export const ENTITY_ALIAS_MAX_LENGTH = 120;

const aliasInputSchema = z
  .string()
  .max(ENTITY_ALIAS_MAX_LENGTH)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), 'Alias contains control characters');

/**
 * Canonical lookup key for an approved tenant entity alias. This is deliberately
 * presentation-neutral: the original phrase remains provenance, while matching
 * uses a bounded, Unicode-normalized key.
 */
export function normalizeEntityAlias(alias: string): string {
  const parsed = aliasInputSchema.safeParse(alias);
  if (!parsed.success) {
    throw new ValidationError('Invalid entity alias', {
      errors: parsed.error.issues.map((issue) => issue.message),
    });
  }
  const normalized = parsed.data.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!normalized) {
    throw new ValidationError('Invalid entity alias', { errors: ['Alias cannot be empty'] });
  }
  return normalized;
}

export type EntityAliasSource = 'entity_picker' | 'proposal_edit';

export interface EntityAliasCandidate {
  tenantId: string;
  entityKind: EntityKind;
  entityId: string;
  alias: string;
  source: EntityAliasSource;
  sourceProposalId: string;
  createdBy: string;
}

export interface TenantEntityAlias extends EntityAliasCandidate {
  id: string;
  normalizedAlias: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
}

export interface EntityAliasRepository {
  activate(candidate: EntityAliasCandidate): Promise<TenantEntityAlias>;
  findActive(
    tenantId: string,
    entityKind: EntityKind,
    alias: string,
  ): Promise<TenantEntityAlias | null>;
  deactivate(
    tenantId: string,
    entityKind: EntityKind,
    alias: string,
    actorId: string,
  ): Promise<TenantEntityAlias | null>;
}

export class InMemoryEntityAliasRepository implements EntityAliasRepository {
  private readonly aliases: TenantEntityAlias[] = [];

  async activate(candidate: EntityAliasCandidate): Promise<TenantEntityAlias> {
    const normalizedAlias = normalizeEntityAlias(candidate.alias);
    const existing = await this.findActive(candidate.tenantId, candidate.entityKind, normalizedAlias);
    if (existing) return existing;
    const now = new Date();
    const alias: TenantEntityAlias = {
      ...candidate,
      id: uuidv4(),
      normalizedAlias,
      active: true,
      createdAt: now,
      updatedAt: now,
      deactivatedAt: null,
      deactivatedBy: null,
    };
    this.aliases.push(alias);
    return alias;
  }

  async findActive(tenantId: string, entityKind: EntityKind, alias: string): Promise<TenantEntityAlias | null> {
    const normalizedAlias = normalizeEntityAlias(alias);
    return this.aliases.find(
      (entry) =>
        entry.active &&
        entry.tenantId === tenantId &&
        entry.entityKind === entityKind &&
        entry.normalizedAlias === normalizedAlias,
    ) ?? null;
  }

  async deactivate(tenantId: string, entityKind: EntityKind, alias: string, actorId: string): Promise<TenantEntityAlias | null> {
    const entry = await this.findActive(tenantId, entityKind, alias);
    if (!entry) return null;
    entry.active = false;
    entry.deactivatedAt = new Date();
    entry.deactivatedBy = actorId;
    entry.updatedAt = entry.deactivatedAt;
    return entry;
  }
}
