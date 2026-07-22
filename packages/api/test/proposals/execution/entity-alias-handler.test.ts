import { describe, expect, it, vi } from 'vitest';
import type { EntityAliasRepository } from '../../../src/learning/entity-aliases/entity-alias';
import { EntityAliasExecutionHandler } from '../../../src/proposals/execution/entity-alias-handler';
import { createProposal, type Proposal } from '../../../src/proposals/proposal';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const GROUNDING_PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const ALIAS_ID = '66666666-6666-4666-8666-666666666666';

function aliasProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: TENANT_ID,
      proposalType: 'adopt_entity_alias',
      payload: {
        alias: 'Khan',
        entityKind: 'customer',
        entityId: CUSTOMER_ID,
        source: 'entity_picker',
        groundedProposalId: GROUNDING_PROPOSAL_ID,
      },
      summary: 'Learn Khan as a customer alias',
      createdBy: OWNER_ID,
    }),
    id: PROPOSAL_ID,
    status: 'approved',
    ...overrides,
  };
}

function repository(): EntityAliasRepository {
  return {
    findActiveByAlias: vi.fn(),
    activateFromApprovedProposal: vi.fn().mockResolvedValue({
      id: ALIAS_ID,
      tenantId: TENANT_ID,
      entityKind: 'customer',
      entityId: CUSTOMER_ID,
      normalizedAlias: 'khan',
      sourceAlias: 'Khan',
      source: 'entity_picker',
      sourceProposalId: PROPOSAL_ID,
      active: true,
      createdBy: OWNER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      deactivatedAt: null,
      deactivatedBy: null,
    }),
    deactivate: vi.fn(),
  };
}

describe('EntityAliasExecutionHandler', () => {
  it('activates through the repository with the owner approval actor', async () => {
    const repo = repository();
    const handler = new EntityAliasExecutionHandler(repo);

    const result = await handler.execute(aliasProposal(), {
      tenantId: TENANT_ID,
      executedBy: OWNER_ID,
    });

    expect(result).toEqual({ success: true, resultEntityId: ALIAS_ID });
    expect(repo.activateFromApprovedProposal).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      approvalProposalId: PROPOSAL_ID,
      activatedBy: OWNER_ID,
      actorRole: 'owner',
    });
  });

  it('short-circuits an executor retry that already has a resultEntityId', async () => {
    const repo = repository();
    const handler = new EntityAliasExecutionHandler(repo);

    const result = await handler.execute(
      aliasProposal({ resultEntityId: ALIAS_ID, status: 'executed' }),
      { tenantId: TENANT_ID, executedBy: OWNER_ID },
    );

    expect(result).toEqual({ success: true, resultEntityId: ALIAS_ID });
    expect(repo.activateFromApprovedProposal).not.toHaveBeenCalled();
  });

  it('fails closed when the repository is absent or the payload is invalid', async () => {
    const unwired = new EntityAliasExecutionHandler();
    expect(unwired.isFullyWired()).toBe(false);
    await expect(
      unwired.execute(aliasProposal(), { tenantId: TENANT_ID, executedBy: OWNER_ID }),
    ).resolves.toEqual({
      success: false,
      error: 'handler_not_wired:entityAliasRepo',
    });

    const repo = repository();
    const handler = new EntityAliasExecutionHandler(repo);
    const invalid = await handler.execute(
      aliasProposal({ payload: { alias: 'Khan', entityId: CUSTOMER_ID } }),
      { tenantId: TENANT_ID, executedBy: OWNER_ID },
    );
    expect(invalid.success).toBe(false);
    expect(invalid.error).toMatch(/payload/i);
    expect(repo.activateFromApprovedProposal).not.toHaveBeenCalled();
  });
});
