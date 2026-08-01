import {
  adoptEntityAliasPayloadSchema as sharedAdoptEntityAliasPayloadSchema,
} from '@ai-service-os/shared';
import { z } from 'zod';

export type { AdoptEntityAliasPayload } from '@ai-service-os/shared';

const ADOPT_ENTITY_ALIAS_KEYS = new Set([
  'alias',
  'entityKind',
  'entityId',
  'source',
  'groundedProposalId',
  '_meta',
]);

/**
 * API proposal wrapper for the strict shared contract. `_meta` remains
 * available to the proposal-wide confidence envelope; every other extra field
 * (especially transcript text) is rejected instead of silently retained.
 */
export const adoptEntityAliasPayloadSchema = sharedAdoptEntityAliasPayloadSchema
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!ADOPT_ENTITY_ALIAS_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.unrecognized_keys,
          keys: [key],
          path: [],
          message: `Unrecognized key: "${key}"`,
        });
      }
    }
  });
