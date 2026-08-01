import { z } from 'zod';

export const ENTITY_ALIAS_MAX_LENGTH = 120;

/**
 * Entity kinds already supported by the canonical resolver that may be learned
 * as tenant aliases. `pending_proposal` is intentionally excluded because it
 * is workflow state, not a canonical tenant entity.
 */
export const ENTITY_ALIAS_ENTITY_KINDS = [
  'customer',
  'job',
  'appointment',
  'invoice',
  'estimate',
  'technician',
] as const;

export const entityAliasEntityKindSchema = z.enum(ENTITY_ALIAS_ENTITY_KINDS);
export type EntityAliasEntityKind = z.infer<typeof entityAliasEntityKindSchema>;

export const ENTITY_ALIAS_SOURCES = ['entity_picker', 'proposal_edit'] as const;
export const entityAliasSourceSchema = z.enum(ENTITY_ALIAS_SOURCES);
export type EntityAliasSource = z.infer<typeof entityAliasSourceSchema>;

/**
 * Bounded source reference accepted by the learning loop. Validation considers
 * Unicode code points (matching PostgreSQL char_length), rejects every Unicode
 * control or format character, and verifies the NFKC lookup form also fits the
 * DB limit.
 */
export const entityAliasTextSchema = z.string().superRefine((value, ctx) => {
  if (Array.from(value).length > ENTITY_ALIAS_MAX_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: ENTITY_ALIAS_MAX_LENGTH,
      inclusive: true,
      type: 'string',
      message: `Alias must be ${ENTITY_ALIAS_MAX_LENGTH} characters or fewer`,
    });
  }
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Alias contains control or format characters',
    });
  }

  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Alias cannot be empty' });
  } else if (Array.from(normalized).length > ENTITY_ALIAS_MAX_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: ENTITY_ALIAS_MAX_LENGTH,
      inclusive: true,
      type: 'string',
      message: `Alias must be ${ENTITY_ALIAS_MAX_LENGTH} characters or fewer after normalization`,
    });
  }
});

/**
 * Grounded data carried by an adoption proposal. No transcript or arbitrary
 * provenance is accepted: the source proposal ID points to the operator action
 * that grounded this alias.
 */
export const adoptEntityAliasPayloadSchema = z
  .object({
    alias: entityAliasTextSchema,
    entityKind: entityAliasEntityKindSchema,
    entityId: z.string().uuid(),
    source: entityAliasSourceSchema,
    groundedProposalId: z.string().uuid(),
  })
  .strict();

export type AdoptEntityAliasPayload = z.infer<typeof adoptEntityAliasPayloadSchema>;
