import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PgEntityAliasRepository } from '../../../src/learning/entity-aliases/pg-entity-alias';
import { ConflictError, ValidationError } from '../../../src/shared/errors';

type QueryValues = readonly unknown[] | undefined;
interface FakeQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}
type QueryHandler = (sql: string, values: QueryValues) => FakeQueryResult;

class FakeClient {
  readonly queries: Array<{ sql: string; values: QueryValues }> = [];

  constructor(private readonly handler: QueryHandler) {}

  async query(sql: string, values?: readonly unknown[]): Promise<FakeQueryResult> {
    this.queries.push({ sql, values });
    if (
      ['BEGIN', 'COMMIT', 'ROLLBACK', 'RESET ROLE', 'RESET app.current_tenant_id'].includes(sql) ||
      sql.includes("set_config('app.current_tenant_id'")
    ) {
      return { rows: [], rowCount: 0 };
    }
    return this.handler(sql, values);
  }

  release(): void {}
}

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherTenantActorId = '77777777-7777-4777-8777-777777777777';
const approvalProposalId = '33333333-3333-4333-8333-333333333333';
const groundedProposalId = '44444444-4444-4444-8444-444444444444';
const entityId = '55555555-5555-4555-8555-555555555555';
const aliasId = '66666666-6666-4666-8666-666666666666';
const now = new Date('2026-07-22T06:00:00.000Z');

const proposalPayload = {
  alias: '  ＫＨＡＮ  ',
  entityKind: 'customer',
  entityId,
  source: 'entity_picker',
  groundedProposalId,
};

function aliasRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: aliasId,
    tenant_id: tenantId,
    entity_kind: 'customer',
    entity_id: entityId,
    normalized_alias: 'khan',
    source_alias: 'ＫＨＡＮ',
    source: 'entity_picker',
    source_proposal_id: approvalProposalId,
    active: true,
    created_by: actorId,
    created_at: now,
    updated_at: now,
    deactivated_at: null,
    deactivated_by: null,
    ...overrides,
  };
}

function repository(handler: QueryHandler): { repo: PgEntityAliasRepository; client: FakeClient } {
  const client = new FakeClient(handler);
  const pool = { connect: async () => client } as unknown as Pool;
  return { repo: new PgEntityAliasRepository(pool), client };
}

function baseQueryHandler(sql: string): FakeQueryResult {
  if (sql.includes('FROM users')) {
    return { rows: [{ id: actorId }], rowCount: 1 };
  }
  if (sql.includes("proposal_type = 'adopt_entity_alias'")) {
    return {
      rows: [{ id: approvalProposalId, status: 'approved', payload: proposalPayload }],
      rowCount: 1,
    };
  }
  if (sql.includes('FROM proposals') && sql.includes('id = $2')) {
    return { rows: [{ id: groundedProposalId }], rowCount: 1 };
  }
  if (sql.includes('FROM customers')) {
    return { rows: [{ id: entityId }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

describe('PgEntityAliasRepository', () => {
  it('activates from an approved grounded proposal and audits in the same transaction', async () => {
    const { repo, client } = repository((sql) => {
      const base = baseQueryHandler(sql);
      if (base.rowCount > 0) return base;
      if (sql.includes('INSERT INTO tenant_entity_aliases')) {
        return { rows: [aliasRow()], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const activated = await repo.activateFromApprovedProposal({
      tenantId,
      approvalProposalId,
      activatedBy: actorId,
      actorRole: 'owner',
    });

    expect(activated).toMatchObject({
      id: aliasId,
      tenantId,
      entityKind: 'customer',
      entityId,
      normalizedAlias: 'khan',
      sourceAlias: 'ＫＨＡＮ',
      sourceProposalId: approvalProposalId,
      active: true,
    });
    const insertIndex = client.queries.findIndex((query) =>
      query.sql.includes('INSERT INTO tenant_entity_aliases'),
    );
    const auditIndex = client.queries.findIndex((query) =>
      query.sql.includes('INSERT INTO audit_events'),
    );
    const commitIndex = client.queries.findIndex((query) => query.sql === 'COMMIT');
    expect(insertIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(insertIndex);
    expect(commitIndex).toBeGreaterThan(auditIndex);
    expect(client.queries[auditIndex].values).toContain('entity_alias.activated');
  });

  it('rejects activation by an actor outside the tenant before any write', async () => {
    const { repo, client } = repository((sql) => {
      if (sql.includes('FROM users')) return { rows: [], rowCount: 0 };
      return baseQueryHandler(sql);
    });

    await expect(
      repo.activateFromApprovedProposal({
        tenantId,
        approvalProposalId,
        activatedBy: otherTenantActorId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const actorQuery = client.queries.find((query) => query.sql.includes('FROM users'));
    expect(actorQuery?.values).toEqual([tenantId, otherTenantActorId]);
    expect(
      client.queries.some(
        (query) =>
          query.sql.includes('INSERT INTO tenant_entity_aliases') ||
          query.sql.includes('INSERT INTO audit_events'),
      ),
    ).toBe(false);
  });

  it('returns the prior row on an execution retry without a second mutation or audit', async () => {
    const { repo, client } = repository((sql) => {
      const base = baseQueryHandler(sql);
      if (base.rowCount > 0) return base;
      if (sql.includes('source_proposal_id = $2')) {
        return { rows: [aliasRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const retry = await repo.activateFromApprovedProposal({
      tenantId,
      approvalProposalId,
      activatedBy: actorId,
      actorRole: 'owner',
    });

    expect(retry.id).toBe(aliasId);
    expect(client.queries.some((query) => query.sql.includes('INSERT INTO tenant_entity_aliases'))).toBe(
      false,
    );
    expect(client.queries.some((query) => query.sql.includes('INSERT INTO audit_events'))).toBe(
      false,
    );
  });

  it('rejects unapproved proposals, invalid targets, and active target conflicts', async () => {
    const unapproved = repository((sql) => {
      if (sql.includes("proposal_type = 'adopt_entity_alias'")) {
        return {
          rows: [{ id: approvalProposalId, status: 'draft', payload: proposalPayload }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }).repo;
    await expect(
      unapproved.activateFromApprovedProposal({
        tenantId,
        approvalProposalId,
        activatedBy: actorId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const invalidTarget = repository((sql) => {
      const base = baseQueryHandler(sql);
      if (sql.includes('FROM customers')) return { rows: [], rowCount: 0 };
      return base;
    }).repo;
    await expect(
      invalidTarget.activateFromApprovedProposal({
        tenantId,
        approvalProposalId,
        activatedBy: actorId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const conflict = repository((sql) => {
      const base = baseQueryHandler(sql);
      if (base.rowCount > 0) return base;
      if (sql.includes('normalized_alias = $3') && sql.includes('active = true')) {
        return {
          rows: [aliasRow({ entity_id: '77777777-7777-4777-8777-777777777777' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }).repo;
    await expect(
      conflict.activateFromApprovedProposal({
        tenantId,
        approvalProposalId,
        activatedBy: actorId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('soft-deactivates once and audits only the mutation', async () => {
    let active = true;
    const { repo, client } = repository((sql) => {
      if (sql.includes('FROM users')) {
        return { rows: [{ id: actorId }], rowCount: 1 };
      }
      if (sql.includes('UPDATE tenant_entity_aliases') && active) {
        active = false;
        return {
          rows: [
            aliasRow({
              active: false,
              deactivated_at: now,
              deactivated_by: actorId,
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM tenant_entity_aliases') && sql.includes('id = $2')) {
        return {
          rows: [
            aliasRow({
              active: false,
              deactivated_at: now,
              deactivated_by: actorId,
            }),
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO audit_events')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const input = {
      tenantId,
      aliasId,
      deactivatedBy: actorId,
      actorRole: 'owner' as const,
    };
    expect(await repo.deactivate(input)).toMatchObject({ active: false });
    expect(await repo.deactivate(input)).toMatchObject({ active: false });
    expect(
      client.queries.filter((query) => query.sql.includes('INSERT INTO audit_events')),
    ).toHaveLength(1);
  });

  it('rejects deactivation by an actor outside the tenant before any write', async () => {
    const { repo, client } = repository((sql) => {
      if (sql.includes('FROM users')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    await expect(
      repo.deactivate({
        tenantId,
        aliasId,
        deactivatedBy: otherTenantActorId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const actorQuery = client.queries.find((query) => query.sql.includes('FROM users'));
    expect(actorQuery?.values).toEqual([tenantId, otherTenantActorId]);
    expect(
      client.queries.some(
        (query) =>
          query.sql.includes('UPDATE tenant_entity_aliases') ||
          query.sql.includes('INSERT INTO audit_events'),
      ),
    ).toBe(false);
  });
});
