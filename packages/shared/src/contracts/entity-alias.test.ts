import { describe, expect, it } from 'vitest';
import {
  ENTITY_ALIAS_ENTITY_KINDS,
  ENTITY_ALIAS_MAX_LENGTH,
  adoptEntityAliasPayloadSchema,
  entityAliasEntityKindSchema,
} from '../index.js';

const entityId = '11111111-1111-4111-8111-111111111111';
const groundedProposalId = '22222222-2222-4222-8222-222222222222';

describe('entity alias shared contract', () => {
  it('uses the aliasable subset of the existing EntityKind vocabulary', () => {
    expect(ENTITY_ALIAS_ENTITY_KINDS).toEqual([
      'customer',
      'job',
      'appointment',
      'invoice',
      'estimate',
      'technician',
    ]);
    expect(entityAliasEntityKindSchema.safeParse('pending_proposal').success).toBe(false);
  });

  it('parses bounded grounded proposal data', () => {
    expect(
      adoptEntityAliasPayloadSchema.parse({
        alias: '  ＫＨＡＮ Family  ',
        entityKind: 'customer',
        entityId,
        source: 'entity_picker',
        groundedProposalId,
      }),
    ).toEqual({
      alias: '  ＫＨＡＮ Family  ',
      entityKind: 'customer',
      entityId,
      source: 'entity_picker',
      groundedProposalId,
    });
  });

  it('rejects ungrounded targets and unbounded, control, or format-character aliases', () => {
    const base = {
      alias: 'Khan',
      entityKind: 'customer',
      entityId,
      source: 'proposal_edit',
      groundedProposalId,
    } as const;

    expect(
      adoptEntityAliasPayloadSchema.safeParse({ ...base, entityId: 'customer-name' }).success,
    ).toBe(false);
    expect(
      adoptEntityAliasPayloadSchema.safeParse({ ...base, groundedProposalId: 'draft-ref' })
        .success,
    ).toBe(false);
    expect(
      adoptEntityAliasPayloadSchema.safeParse({
        ...base,
        alias: 'a'.repeat(ENTITY_ALIAS_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(adoptEntityAliasPayloadSchema.safeParse({ ...base, alias: 'Khan\u0085' }).success).toBe(
      false,
    );
    expect(adoptEntityAliasPayloadSchema.safeParse({ ...base, alias: 'Kh\u200ban' }).success).toBe(
      false,
    );
    expect(adoptEntityAliasPayloadSchema.safeParse({ ...base, alias: 'Khan\u202e' }).success).toBe(
      false,
    );
  });

  it('rejects raw transcript and unknown provenance fields', () => {
    const result = adoptEntityAliasPayloadSchema.safeParse({
      alias: 'Khan',
      entityKind: 'customer',
      entityId,
      source: 'entity_picker',
      groundedProposalId,
      transcript: 'the entire unbounded call transcript',
    });

    expect(result.success).toBe(false);
  });
});
