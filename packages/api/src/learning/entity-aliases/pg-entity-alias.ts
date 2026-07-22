import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createAuditEvent, type AuditEvent } from '../../audit/audit';
import { PgBaseRepository } from '../../db/pg-base';
import { adoptEntityAliasPayloadSchema } from '../../proposals/contracts/adopt-entity-alias';
import { ConflictError, ValidationError } from '../../shared/errors';
import { uuidSchema } from '../../shared/validation';
import {
  type ActivateEntityAliasInput,
  type DeactivateEntityAliasInput,
  type EntityAlias,
  type EntityAliasKind,
  type EntityAliasRepository,
  type FindActiveEntityAliasInput,
  normalizeEntityAlias,
} from './entity-alias';

interface EntityAliasRow {
  id: string;
  tenant_id: string;
  entity_kind: EntityAliasKind;
  entity_id: string;
  normalized_alias: string;
  source_alias: string;
  source: EntityAlias['source'];
  source_proposal_id: string | null;
  active: boolean;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  deactivated_at: Date | string | null;
  deactivated_by: string | null;
}

interface ApprovalProposalRow {
  id: string;
  status: string;
  payload: unknown;
}

const ACTIVATABLE_PROPOSAL_STATUSES = new Set(['approved', 'executing', 'executed']);

const ENTITY_TABLE_BY_KIND: Record<EntityAliasKind, string> = {
  customer: 'customers',
  job: 'jobs',
  appointment: 'appointments',
  invoice: 'invoices',
  estimate: 'estimates',
  technician: 'users',
};

function mapRow(row: EntityAliasRow): EntityAlias {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    normalizedAlias: row.normalized_alias,
    sourceAlias: row.source_alias,
    source: row.source,
    sourceProposalId: row.source_proposal_id,
    active: row.active,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at) : null,
    deactivatedBy: row.deactivated_by,
  };
}

function parsePayload(payload: unknown) {
  const value =
    typeof payload === 'string'
      ? (() => {
          try {
            return JSON.parse(payload) as unknown;
          } catch {
            return payload;
          }
        })()
      : payload;
  const parsed = adoptEntityAliasPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('Approved entity alias proposal has an invalid payload', {
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return parsed.data;
}

async function insertAudit(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, tenant_id, actor_id, actor_role, event_type, entity_type,
        entity_id, correlation_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      event.id,
      event.tenantId,
      event.actorId,
      event.actorRole,
      event.eventType,
      event.entityType,
      event.entityId,
      event.correlationId ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.createdAt,
    ],
  );
}

async function assertTenantActor(
  client: PoolClient,
  tenantId: string,
  actorId: string,
): Promise<void> {
  if (!uuidSchema.safeParse(actorId).success) {
    throw new ValidationError('Entity alias actor is not a canonical user for this tenant');
  }
  const actorResult = await client.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, actorId],
  );
  if (!actorResult.rows[0]) {
    throw new ValidationError('Entity alias actor is not a canonical user for this tenant');
  }
}

/**
 * Canonical writer for migration 261's tenant_entity_aliases table.
 *
 * Every statement is tenant-filtered in addition to FORCE RLS. Activation
 * reads the approved proposal inside the same tenant transaction, verifies its
 * grounded source and canonical target, and writes its audit event atomically.
 */
export class PgEntityAliasRepository
  extends PgBaseRepository
  implements EntityAliasRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async findActiveByAlias(input: FindActiveEntityAliasInput): Promise<EntityAlias | null> {
    const normalizedAlias = normalizeEntityAlias(input.alias);
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<EntityAliasRow>(
        `SELECT *
           FROM tenant_entity_aliases
          WHERE tenant_id = $1
            AND entity_kind = $2
            AND normalized_alias = $3
            AND active = true`,
        [input.tenantId, input.entityKind, normalizedAlias],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async activateFromApprovedProposal(input: ActivateEntityAliasInput): Promise<EntityAlias> {
    return this.withTenantTransaction(input.tenantId, async (client) => {
      await assertTenantActor(client, input.tenantId, input.activatedBy);

      const proposalResult = await client.query<ApprovalProposalRow>(
        `SELECT id, status, payload
           FROM proposals
          WHERE tenant_id = $1
            AND id = $2
            AND proposal_type = 'adopt_entity_alias'
          FOR SHARE`,
        [input.tenantId, input.approvalProposalId],
      );
      const proposal = proposalResult.rows[0];
      if (!proposal) {
        throw new ValidationError('Approved entity alias proposal was not found for this tenant');
      }
      if (!ACTIVATABLE_PROPOSAL_STATUSES.has(proposal.status)) {
        throw new ValidationError('Entity aliases can only be activated from an approved proposal');
      }
      const payload = parsePayload(proposal.payload);

      // The adoption proposal ID is the durable idempotency key. Returning an
      // inactive prior row is intentional: replaying an old approval must not
      // silently reactivate an alias an owner explicitly deactivated.
      const priorResult = await client.query<EntityAliasRow>(
        `SELECT *
           FROM tenant_entity_aliases
          WHERE tenant_id = $1 AND source_proposal_id = $2
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
        [input.tenantId, input.approvalProposalId],
      );
      if (priorResult.rows[0]) return mapRow(priorResult.rows[0]);

      const groundedResult = await client.query<{ id: string }>(
        `SELECT id
           FROM proposals
          WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, payload.groundedProposalId],
      );
      if (!groundedResult.rows[0]) {
        throw new ValidationError('Entity alias grounding proposal was not found for this tenant');
      }

      const targetTable = ENTITY_TABLE_BY_KIND[payload.entityKind];
      const targetResult = await client.query<{ id: string }>(
        `SELECT id FROM ${targetTable} WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, payload.entityId],
      );
      if (!targetResult.rows[0]) {
        throw new ValidationError(
          `Entity alias target is not a tenant ${payload.entityKind} record`,
        );
      }

      const normalizedAlias = normalizeEntityAlias(payload.alias);
      const sourceAlias = payload.alias.trim().replace(/\s+/gu, ' ');
      const activeResult = await client.query<EntityAliasRow>(
        `SELECT *
           FROM tenant_entity_aliases
          WHERE tenant_id = $1
            AND entity_kind = $2
            AND normalized_alias = $3
            AND active = true`,
        [input.tenantId, payload.entityKind, normalizedAlias],
      );
      const active = activeResult.rows[0];
      if (active) {
        throw new ConflictError(
          `Active ${payload.entityKind} alias "${normalizedAlias}" already exists`,
        );
      }

      const aliasId = crypto.randomUUID();
      const insertedResult = await client.query<EntityAliasRow>(
        `INSERT INTO tenant_entity_aliases
           (id, tenant_id, entity_kind, entity_id, normalized_alias, source_alias,
            source, source_proposal_id, active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
         ON CONFLICT (tenant_id, entity_kind, normalized_alias) WHERE active = true
         DO NOTHING
         RETURNING *`,
        [
          aliasId,
          input.tenantId,
          payload.entityKind,
          payload.entityId,
          normalizedAlias,
          sourceAlias,
          payload.source,
          input.approvalProposalId,
          input.activatedBy,
        ],
      );

      let activated: EntityAlias;
      if (insertedResult.rows[0]) {
        activated = mapRow(insertedResult.rows[0]);
      } else {
        const racedResult = await client.query<EntityAliasRow>(
          `SELECT *
             FROM tenant_entity_aliases
            WHERE tenant_id = $1
              AND entity_kind = $2
              AND normalized_alias = $3
              AND active = true`,
          [input.tenantId, payload.entityKind, normalizedAlias],
        );
        const raced = racedResult.rows[0];
        if (
          !raced ||
          raced.entity_id !== payload.entityId ||
          raced.source_proposal_id !== input.approvalProposalId
        ) {
          throw new ConflictError(
            `Active ${payload.entityKind} alias "${normalizedAlias}" already exists`,
          );
        }
        return mapRow(raced);
      }

      await insertAudit(
        client,
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.activatedBy,
          actorRole: input.actorRole,
          eventType: 'entity_alias.activated',
          entityType: 'entity_alias',
          entityId: activated.id,
          correlationId: input.approvalProposalId,
          metadata: {
            entityKind: activated.entityKind,
            entityId: activated.entityId,
            normalizedAlias: activated.normalizedAlias,
            source: activated.source,
            groundedProposalId: payload.groundedProposalId,
            approvalProposalId: input.approvalProposalId,
          },
        }),
      );
      return activated;
    });
  }

  async deactivate(input: DeactivateEntityAliasInput): Promise<EntityAlias | null> {
    return this.withTenantTransaction(input.tenantId, async (client) => {
      await assertTenantActor(client, input.tenantId, input.deactivatedBy);

      const result = await client.query<EntityAliasRow>(
        `UPDATE tenant_entity_aliases
            SET active = false,
                updated_at = NOW(),
                deactivated_at = NOW(),
                deactivated_by = $3
          WHERE tenant_id = $1 AND id = $2 AND active = true
          RETURNING *`,
        [input.tenantId, input.aliasId, input.deactivatedBy],
      );
      if (!result.rows[0]) {
        const existing = await client.query<EntityAliasRow>(
          `SELECT *
             FROM tenant_entity_aliases
            WHERE tenant_id = $1 AND id = $2`,
          [input.tenantId, input.aliasId],
        );
        return existing.rows[0] ? mapRow(existing.rows[0]) : null;
      }

      const deactivated = mapRow(result.rows[0]);
      await insertAudit(
        client,
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.deactivatedBy,
          actorRole: input.actorRole,
          eventType: 'entity_alias.deactivated',
          entityType: 'entity_alias',
          entityId: deactivated.id,
          metadata: {
            entityKind: deactivated.entityKind,
            entityId: deactivated.entityId,
            normalizedAlias: deactivated.normalizedAlias,
          },
        }),
      );
      return deactivated;
    });
  }
}
