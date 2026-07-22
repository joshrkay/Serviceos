import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EntityAliasRepository } from '../../../src/learning/entity-aliases/entity-alias';
import { AliasFirstEntityResolver } from '../../../src/ai/resolution/alias-first-entity-resolver';
import type { EntityResolver, EntityResolverResult } from '../../../src/ai/resolution/entity-resolver';

vi.mock('../../../src/db/tenant-transaction', () => ({
  withTenantConnection: vi.fn(async (_pool, _tenantId, fn) =>
    fn({
      query: vi.fn().mockResolvedValue({ rows: [{ label: 'Khan Plumbing' }] }),
    }),
  ),
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

function aliasRepo(
  alias: Awaited<ReturnType<EntityAliasRepository['findActiveByAlias']>> = null,
): EntityAliasRepository {
  return {
    findActiveByAlias: vi.fn().mockResolvedValue(alias),
    activateFromApprovedProposal: vi.fn(),
    deactivate: vi.fn(),
  };
}

function delegate(result: EntityResolverResult): EntityResolver {
  return {
    resolve: vi.fn().mockResolvedValue(result),
  };
}

describe('AliasFirstEntityResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a grounded alias hit at score 1.0 before delegating', async () => {
    const repo = aliasRepo({
      id: 'alias-1',
      tenantId: TENANT_ID,
      entityKind: 'customer',
      entityId: CUSTOMER_ID,
      normalizedAlias: 'khan',
      sourceAlias: 'Khan',
      source: 'entity_picker',
      sourceProposalId: '33333333-3333-4333-8333-333333333333',
      active: true,
      createdBy: '44444444-4444-4444-8444-444444444444',
      createdAt: new Date(),
      updatedAt: new Date(),
      deactivatedAt: null,
      deactivatedBy: null,
    });
    const inner = delegate({ kind: 'not_found', reference: 'Khan' });
    const resolver = new AliasFirstEntityResolver(repo, inner, {} as never);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Khan',
      kind: 'customer',
    });

    expect(result).toEqual({
      kind: 'resolved',
      candidate: {
        id: CUSTOMER_ID,
        kind: 'customer',
        label: 'Khan Plumbing',
        score: 1.0,
      },
    });
    expect(inner.resolve).not.toHaveBeenCalled();
  });

  it('delegates when no active alias exists', async () => {
    const repo = aliasRepo(null);
    const expected: EntityResolverResult = {
      kind: 'ambiguous',
      candidates: [
        { id: 'a', kind: 'customer', label: 'Bob Smith', score: 0.9 },
        { id: 'b', kind: 'customer', label: 'Bob Jones', score: 0.88 },
      ],
    };
    const inner = delegate(expected);
    const resolver = new AliasFirstEntityResolver(repo, inner, {} as never);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Bob',
      kind: 'customer',
    });

    expect(result).toEqual(expected);
    expect(inner.resolve).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      reference: 'Bob',
      kind: 'customer',
    });
  });
});
