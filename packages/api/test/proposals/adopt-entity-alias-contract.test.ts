import { describe, expect, it } from 'vitest';
import { adoptEntityAliasPayloadSchema } from '../../src/proposals/contracts/adopt-entity-alias';
import {
  PROPOSAL_TYPE_SCHEMAS,
  validateProposalPayload,
} from '../../src/proposals/contracts';

const validPayload = {
  alias: 'Khan',
  entityKind: 'customer',
  entityId: '11111111-1111-4111-8111-111111111111',
  source: 'entity_picker',
  groundedProposalId: '22222222-2222-4222-8222-222222222222',
} as const;

describe('adopt_entity_alias proposal contract', () => {
  it('is registered at the proposal parsing choke point', () => {
    expect(PROPOSAL_TYPE_SCHEMAS.adopt_entity_alias).toBe(adoptEntityAliasPayloadSchema);
    expect(validateProposalPayload('adopt_entity_alias', validPayload)).toEqual({ valid: true });
  });

  it('rejects ungrounded, cross-vocabulary, and raw transcript fields', () => {
    expect(
      validateProposalPayload('adopt_entity_alias', {
        ...validPayload,
        entityKind: 'pending_proposal',
      }).valid,
    ).toBe(false);
    expect(
      validateProposalPayload('adopt_entity_alias', {
        ...validPayload,
        entityId: 'Khan',
      }).valid,
    ).toBe(false);
    expect(
      validateProposalPayload('adopt_entity_alias', {
        ...validPayload,
        transcript: 'raw call transcript must not survive the contract',
      }).valid,
    ).toBe(false);
  });

  it('accepts the existing confidence metadata envelope without relaxing other fields', () => {
    expect(
      validateProposalPayload('adopt_entity_alias', {
        ...validPayload,
        _meta: { overallConfidence: 'high' },
      }).valid,
    ).toBe(true);
    expect(
      validateProposalPayload('adopt_entity_alias', {
        ...validPayload,
        _meta: { overallConfidence: 'guess' },
      }).valid,
    ).toBe(false);
  });
});
