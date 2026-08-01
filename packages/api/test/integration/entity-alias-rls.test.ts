import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { PgEntityAliasRepository } from '../../src/learning/entity-aliases/pg-entity-alias';
import { ConflictError, ValidationError } from '../../src/shared/errors';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';

interface TenantFixture {
  tenantId: string;
  userId: string;
  customerId: string;
}

let pool: Pool;
let repo: PgEntityAliasRepository;
let auditRepo: PgAuditRepository;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
const originalRlsFlag = process.env.RLS_RUNTIME_ROLE;

async function insertCustomer(tenantId: string, userId: string): Promise<string> {
  const customerId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers
       (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, 'Alias', 'Target', 'Alias Target', $3)`,
    [customerId, tenantId, userId],
  );
  return customerId;
}

async function createTenantFixture(): Promise<TenantFixture> {
  const tenant = await createTestTenant(pool);
  const customerId = await insertCustomer(tenant.tenantId, tenant.userId);
  return { ...tenant, customerId };
}

async function insertProposal(input: {
  tenant: TenantFixture;
  proposalType: string;
  status: 'executed' | 'approved';
  payload?: Record<string, unknown>;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO proposals
       (id, tenant_id, proposal_type, status, payload, summary, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'Entity alias integration fixture', $6)`,
    [
      id,
      input.tenant.tenantId,
      input.proposalType,
      input.status,
      JSON.stringify(input.payload ?? {}),
      input.tenant.userId,
    ],
  );
  return id;
}

async function insertApprovedAliasProposal(input: {
  tenant: TenantFixture;
  alias: string;
  entityKind?: 'customer' | 'technician';
  entityId?: string;
  groundedTenant?: TenantFixture;
}): Promise<string> {
  const groundedTenant = input.groundedTenant ?? input.tenant;
  const groundedProposalId = await insertProposal({
    tenant: groundedTenant,
    proposalType: 'voice_clarification',
    status: 'executed',
  });
  return insertProposal({
    tenant: input.tenant,
    proposalType: 'adopt_entity_alias',
    status: 'approved',
    payload: {
      alias: input.alias,
      entityKind: input.entityKind ?? 'customer',
      entityId: input.entityId ?? input.tenant.customerId,
      source: 'entity_picker',
      groundedProposalId,
    },
  });
}

beforeAll(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  pool = await getSharedTestDb();
  repo = new PgEntityAliasRepository(pool);
  auditRepo = new PgAuditRepository(pool);
  tenantA = await createTenantFixture();
  tenantB = await createTenantFixture();
});

afterAll(async () => {
  if (originalRlsFlag === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = originalRlsFlag;
  await closeSharedTestDb();
});

describe('tenant entity aliases (real Postgres)', () => {
  it('creates, reads, deactivates, and recreates an audited alias version', async () => {
    const firstProposalId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias: '  ＫＨＡＮ  ',
    });
    const first = await repo.activateFromApprovedProposal({
      tenantId: tenantA.tenantId,
      approvalProposalId: firstProposalId,
      activatedBy: tenantA.userId,
      actorRole: 'owner',
    });

    expect(first.active).toBe(true);
    expect(first.normalizedAlias).toBe('khan');
    expect(first.sourceAlias).toBe('ＫＨＡＮ');
    expect(first.sourceProposalId).toBe(firstProposalId);
    expect(
      await repo.findActiveByAlias({
        tenantId: tenantA.tenantId,
        entityKind: 'customer',
        alias: ' Khan ',
      }),
    ).toMatchObject({ id: first.id, entityId: tenantA.customerId });

    const retry = await repo.activateFromApprovedProposal({
      tenantId: tenantA.tenantId,
      approvalProposalId: firstProposalId,
      activatedBy: tenantA.userId,
      actorRole: 'owner',
    });
    expect(retry.id).toBe(first.id);

    const deactivated = await repo.deactivate({
      tenantId: tenantA.tenantId,
      aliasId: first.id,
      deactivatedBy: tenantA.userId,
      actorRole: 'owner',
    });
    expect(deactivated).toMatchObject({
      id: first.id,
      active: false,
      deactivatedBy: tenantA.userId,
    });
    expect(
      await repo.findActiveByAlias({
        tenantId: tenantA.tenantId,
        entityKind: 'customer',
        alias: 'khan',
      }),
    ).toBeNull();

    const secondProposalId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias: 'Khan',
    });
    const second = await repo.activateFromApprovedProposal({
      tenantId: tenantA.tenantId,
      approvalProposalId: secondProposalId,
      activatedBy: tenantA.userId,
      actorRole: 'owner',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.active).toBe(true);

    const versions = await pool.query<{ id: string; active: boolean }>(
      `SELECT id, active
         FROM tenant_entity_aliases
        WHERE tenant_id = $1 AND entity_kind = 'customer' AND normalized_alias = 'khan'
        ORDER BY created_at`,
      [tenantA.tenantId],
    );
    expect(versions.rows).toEqual([
      { id: first.id, active: false },
      { id: second.id, active: true },
    ]);

    const firstAudits = await auditRepo.findByEntity(tenantA.tenantId, 'entity_alias', first.id);
    expect(firstAudits.map((event) => event.eventType).sort()).toEqual([
      'entity_alias.activated',
      'entity_alias.deactivated',
    ]);
    const secondAudits = await auditRepo.findByEntity(tenantA.tenantId, 'entity_alias', second.id);
    expect(secondAudits.map((event) => event.eventType)).toEqual(['entity_alias.activated']);
  });

  it('conflicts only within one active tenant/kind key and validates grounded targets', async () => {
    const alias = `shared-${crypto.randomUUID()}`;
    const firstProposalId = await insertApprovedAliasProposal({ tenant: tenantA, alias });
    const first = await repo.activateFromApprovedProposal({
      tenantId: tenantA.tenantId,
      approvalProposalId: firstProposalId,
      activatedBy: tenantA.userId,
      actorRole: 'owner',
    });

    const conflictingProposalId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias: alias.toUpperCase(),
      entityId: crypto.randomUUID(),
    });
    await expect(
      repo.activateFromApprovedProposal({
        tenantId: tenantA.tenantId,
        approvalProposalId: conflictingProposalId,
        activatedBy: tenantA.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const otherKindProposalId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias,
      entityKind: 'technician',
      entityId: tenantA.userId,
    });
    const otherKind = await repo.activateFromApprovedProposal({
      tenantId: tenantA.tenantId,
      approvalProposalId: otherKindProposalId,
      activatedBy: tenantA.userId,
      actorRole: 'owner',
    });
    expect(otherKind.entityKind).toBe('technician');

    const otherTenantProposalId = await insertApprovedAliasProposal({ tenant: tenantB, alias });
    const otherTenant = await repo.activateFromApprovedProposal({
      tenantId: tenantB.tenantId,
      approvalProposalId: otherTenantProposalId,
      activatedBy: tenantB.userId,
      actorRole: 'owner',
    });
    expect(otherTenant.tenantId).toBe(tenantB.tenantId);
    expect(first.id).not.toBe(otherTenant.id);

    const secondCustomerId = await insertCustomer(tenantA.tenantId, tenantA.userId);
    const sameKindConflictId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias,
      entityId: secondCustomerId,
    });
    await expect(
      repo.activateFromApprovedProposal({
        tenantId: tenantA.tenantId,
        approvalProposalId: sameKindConflictId,
        activatedBy: tenantA.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const crossTenantGroundingId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias: `cross-grounding-${crypto.randomUUID()}`,
      groundedTenant: tenantB,
    });
    await expect(
      repo.activateFromApprovedProposal({
        tenantId: tenantA.tenantId,
        approvalProposalId: crossTenantGroundingId,
        activatedBy: tenantA.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const unapprovedId = await insertProposal({
      tenant: tenantA,
      proposalType: 'adopt_entity_alias',
      status: 'executed',
      payload: {
        alias: `unapproved-${crypto.randomUUID()}`,
        entityKind: 'customer',
        entityId: tenantA.customerId,
        source: 'entity_picker',
        groundedProposalId: firstProposalId,
      },
    });
    await pool.query(`UPDATE proposals SET status = 'draft' WHERE id = $1`, [unapprovedId]);
    await expect(
      repo.activateFromApprovedProposal({
        tenantId: tenantA.tenantId,
        approvalProposalId: unapprovedId,
        activatedBy: tenantA.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a tenant-B actor before activating or deactivating tenant-A aliases', async () => {
    const rejectedProposalId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias: `cross-actor-activate-${crypto.randomUUID()}`,
    });

    await expect(
      repo.activateFromApprovedProposal({
        tenantId: tenantA.tenantId,
        approvalProposalId: rejectedProposalId,
        activatedBy: tenantB.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const rejectedActivation = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM tenant_entity_aliases
        WHERE tenant_id = $1 AND source_proposal_id = $2`,
      [tenantA.tenantId, rejectedProposalId],
    );
    expect(rejectedActivation.rows[0].count).toBe('0');

    const validProposalId = await insertApprovedAliasProposal({
      tenant: tenantA,
      alias: `cross-actor-deactivate-${crypto.randomUUID()}`,
    });
    const activeAlias = await repo.activateFromApprovedProposal({
      tenantId: tenantA.tenantId,
      approvalProposalId: validProposalId,
      activatedBy: tenantA.userId,
      actorRole: 'owner',
    });

    await expect(
      repo.deactivate({
        tenantId: tenantA.tenantId,
        aliasId: activeAlias.id,
        deactivatedBy: tenantB.userId,
        actorRole: 'owner',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const unchangedAlias = await pool.query<{
      active: boolean;
      deactivated_at: Date | null;
      deactivated_by: string | null;
    }>(
      `SELECT active, deactivated_at, deactivated_by
         FROM tenant_entity_aliases
        WHERE tenant_id = $1 AND id = $2`,
      [tenantA.tenantId, activeAlias.id],
    );
    expect(unchangedAlias.rows[0]).toEqual({
      active: true,
      deactivated_at: null,
      deactivated_by: null,
    });

    const audits = await auditRepo.findByEntity(
      tenantA.tenantId,
      'entity_alias',
      activeAlias.id,
    );
    expect(audits.map((event) => event.eventType)).toEqual(['entity_alias.activated']);
  });

  it('runtime role cannot read or mutate another tenant alias', async () => {
    const alias = `rls-${crypto.randomUUID()}`;
    const proposalA = await insertApprovedAliasProposal({ tenant: tenantA, alias });
    const proposalB = await insertApprovedAliasProposal({ tenant: tenantB, alias });
    const aliasA = await repo.activateFromApprovedProposal({
      tenantId: tenantA.tenantId,
      approvalProposalId: proposalA,
      activatedBy: tenantA.userId,
      actorRole: 'owner',
    });
    const aliasB = await repo.activateFromApprovedProposal({
      tenantId: tenantB.tenantId,
      approvalProposalId: proposalB,
      activatedBy: tenantB.userId,
      actorRole: 'owner',
    });

    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await applyTenantContext(client, tenantA.tenantId, { transactional: true });

      const filterless = await client.query<{ id: string; tenant_id: string }>(
        'SELECT id, tenant_id FROM tenant_entity_aliases',
      );
      expect(filterless.rows.some((row) => row.id === aliasA.id)).toBe(true);
      expect(filterless.rows.some((row) => row.id === aliasB.id)).toBe(false);
      expect(filterless.rows.every((row) => row.tenant_id === tenantA.tenantId)).toBe(true);

      const crossTenantUpdate = await client.query(
        'UPDATE tenant_entity_aliases SET active = false WHERE id = $1',
        [aliasB.id],
      );
      expect(crossTenantUpdate.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      if (client) {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }

    expect(
      await repo.findActiveByAlias({
        tenantId: tenantB.tenantId,
        entityKind: 'customer',
        alias,
      }),
    ).toMatchObject({ id: aliasB.id, active: true });
  });
});
