import {
  ENTITY_ALIAS_MAX_LENGTH,
  entityAliasTextSchema,
  type EntityAliasEntityKind,
  type EntityAliasSource,
} from '@ai-service-os/shared';
import type { Role } from '../../auth/rbac';
import type { EntityKind } from '../../ai/resolution/entity-resolver';
import { ValidationError } from '../../shared/errors';

export { ENTITY_ALIAS_MAX_LENGTH };
export type { EntityAliasSource };

type ExistingEntityKind<T extends EntityKind> = T;
export type EntityAliasKind = ExistingEntityKind<EntityAliasEntityKind>;

/**
 * Canonical lookup key for an approved tenant entity alias. This is deliberately
 * presentation-neutral: the original phrase remains provenance, while matching
 * uses a bounded, Unicode-normalized key.
 */
export function normalizeEntityAlias(alias: string): string {
  const parsed = entityAliasTextSchema.safeParse(alias);
  if (!parsed.success) {
    throw new ValidationError('Invalid entity alias', {
      errors: parsed.error.issues.map((issue) => issue.message),
    });
  }
  const normalized = parsed.data.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  if (!normalized) {
    throw new ValidationError('Invalid entity alias', { errors: ['Alias cannot be empty'] });
  }
  return normalized;
}

export interface EntityAliasCandidate {
  tenantId: string;
  entityKind: EntityAliasKind;
  entityId: string;
  alias: string;
  source: EntityAliasSource;
  sourceProposalId: string;
  createdBy: string;
}

export type EntityAliasActorRole = Role | 'system';

export interface EntityAlias {
  id: string;
  tenantId: string;
  entityKind: EntityAliasKind;
  entityId: string;
  normalizedAlias: string;
  sourceAlias: string;
  source: EntityAliasSource;
  sourceProposalId: string | null;
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
}

export interface ActivateEntityAliasInput {
  tenantId: string;
  approvalProposalId: string;
  activatedBy: string;
  actorRole: EntityAliasActorRole;
}

export interface FindActiveEntityAliasInput {
  tenantId: string;
  entityKind: EntityAliasKind;
  alias: string;
}

export interface DeactivateEntityAliasInput {
  tenantId: string;
  aliasId: string;
  deactivatedBy: string;
  actorRole: EntityAliasActorRole;
}

export interface EntityAliasRepository {
  findActiveByAlias(input: FindActiveEntityAliasInput): Promise<EntityAlias | null>;
  activateFromApprovedProposal(input: ActivateEntityAliasInput): Promise<EntityAlias>;
  deactivate(input: DeactivateEntityAliasInput): Promise<EntityAlias | null>;
}
