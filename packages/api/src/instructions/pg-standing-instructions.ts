import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  MAX_ACTIVE_STANDING_INSTRUCTIONS,
  StandingInstruction,
  StandingInstructionLimitError,
  StandingInstructionRepository,
  StandingInstructionScope,
  StandingInstructionSource,
} from './standing-instructions';

/**
 * UB-A1 (agent wave) — Postgres-backed standing instructions (migration 229).
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside FORCE RLS). The 20-active-per-tenant cap is checked inside the
 * insert transaction so a burst of creates can't overshoot it past the
 * transaction boundary.
 */
function mapInstruction(row: Record<string, unknown>): StandingInstruction {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    instruction: row.instruction as string,
    scope: (row.scope as StandingInstructionScope | null) ?? {},
    active: row.active as boolean,
    source: row.source as StandingInstructionSource,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at as string) : null,
    deactivatedBy: (row.deactivated_by as string | null) ?? null,
  };
}

export class PgStandingInstructionRepository
  extends PgBaseRepository
  implements StandingInstructionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(instruction: StandingInstruction): Promise<StandingInstruction> {
    return this.withTenantTransaction(instruction.tenantId, async (client) => {
      const count = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM standing_instructions
          WHERE tenant_id = $1 AND active = true`,
        [instruction.tenantId]
      );
      if (count.rows[0].n >= MAX_ACTIVE_STANDING_INSTRUCTIONS) {
        throw new StandingInstructionLimitError();
      }
      const result = await client.query(
        `INSERT INTO standing_instructions (
          id, tenant_id, instruction, scope, active, source,
          created_by, created_at, updated_at, deactivated_at, deactivated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          instruction.id,
          instruction.tenantId,
          instruction.instruction,
          JSON.stringify(instruction.scope),
          instruction.active,
          instruction.source,
          instruction.createdBy,
          instruction.createdAt,
          instruction.updatedAt,
          instruction.deactivatedAt,
          instruction.deactivatedBy,
        ]
      );
      return mapInstruction(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<StandingInstruction | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM standing_instructions WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapInstruction(result.rows[0]) : null;
    });
  }

  async listActive(tenantId: string): Promise<StandingInstruction[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM standing_instructions
          WHERE tenant_id = $1 AND active = true
          ORDER BY created_at DESC, id DESC`,
        [tenantId]
      );
      return result.rows.map(mapInstruction);
    });
  }

  async listAll(tenantId: string): Promise<StandingInstruction[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM standing_instructions
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC`,
        [tenantId]
      );
      return result.rows.map(mapInstruction);
    });
  }

  async deactivate(
    tenantId: string,
    id: string,
    deactivatedBy: string
  ): Promise<StandingInstruction | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE standing_instructions
            SET active = false, deactivated_at = NOW(), deactivated_by = $3, updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2 AND active = true
          RETURNING *`,
        [tenantId, id, deactivatedBy]
      );
      return result.rows.length > 0 ? mapInstruction(result.rows[0]) : null;
    });
  }
}
