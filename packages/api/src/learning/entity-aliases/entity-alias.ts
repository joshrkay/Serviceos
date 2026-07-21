import { z } from 'zod';
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
