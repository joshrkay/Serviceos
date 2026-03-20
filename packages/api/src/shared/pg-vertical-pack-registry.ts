import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  VerticalPack,
  VerticalPackRegistry,
} from './vertical-pack-registry';
import { VerticalType, PackStatus } from './vertical-types';

function statusToIsActive(status: PackStatus): boolean {
  return status === 'active';
}

function isActiveToStatus(isActive: boolean): PackStatus {
  return isActive ? 'active' : 'draft';
}

function rowToPack(row: Record<string, unknown>): VerticalPack {
  return {
    id: row.id as string,
    packId: row.type as string,
    version: row.version as string,
    verticalType: row.description as string as VerticalType, // verticalType stored alongside
    status: isActiveToStatus(row.is_active as boolean),
    displayName: row.name as string,
    description: row.description as string | undefined,
    metadata: row.terminology
      ? (typeof row.terminology === 'string'
          ? JSON.parse(row.terminology)
          : row.terminology) as Record<string, unknown>
      : undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// The vertical_packs table stores verticalType in the terminology JSONB
// under a known key, or we need a dedicated column. Based on the schema
// provided, we'll store verticalType inside the terminology JSONB as
// _verticalType and read it back from there. The `description` column
// holds the description field.
function rowToPackV2(row: Record<string, unknown>): VerticalPack {
  const terminology = row.terminology
    ? (typeof row.terminology === 'string'
        ? JSON.parse(row.terminology)
        : row.terminology) as Record<string, unknown>
    : {};

  // Extract verticalType from terminology metadata, then remove the internal key
  const verticalType = (terminology._verticalType as string) ?? '';
  const metadata = { ...terminology };
  delete metadata._verticalType;

  return {
    id: row.id as string,
    packId: row.type as string,
    version: row.version as string,
    verticalType: verticalType as VerticalType,
    status: isActiveToStatus(row.is_active as boolean),
    displayName: row.name as string,
    description: row.description as string | undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function buildTerminology(
  verticalType: VerticalType,
  metadata?: Record<string, unknown>
): string {
  return JSON.stringify({
    _verticalType: verticalType,
    ...(metadata ?? {}),
  });
}

export class PgVerticalPackRegistry
  extends PgBaseRepository
  implements VerticalPackRegistry
{
  constructor(pool: Pool) {
    super(pool);
  }

  async register(pack: VerticalPack): Promise<VerticalPack> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO vertical_packs (
          id, type, name, version, description, is_active,
          categories, terminology, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          pack.id,
          pack.packId,
          pack.displayName,
          pack.version,
          pack.description ?? null,
          statusToIsActive(pack.status),
          JSON.stringify([]),
          buildTerminology(pack.verticalType, pack.metadata),
          pack.createdAt,
          pack.updatedAt,
        ]
      );
      return rowToPackV2(result.rows[0]);
    });
  }

  async get(id: string): Promise<VerticalPack | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_packs WHERE id = $1`,
        [id]
      );
      return result.rows.length > 0 ? rowToPackV2(result.rows[0]) : null;
    });
  }

  async getByPackId(packId: string): Promise<VerticalPack | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_packs WHERE type = $1`,
        [packId]
      );
      return result.rows.length > 0 ? rowToPackV2(result.rows[0]) : null;
    });
  }

  async findByVertical(verticalType: VerticalType): Promise<VerticalPack[]> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_packs
         WHERE terminology->>'_verticalType' = $1
         ORDER BY name`,
        [verticalType]
      );
      return result.rows.map(rowToPackV2);
    });
  }

  async list(): Promise<VerticalPack[]> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM vertical_packs ORDER BY name`
      );
      return result.rows.map(rowToPackV2);
    });
  }

  async update(
    id: string,
    updates: Partial<VerticalPack>
  ): Promise<VerticalPack | null> {
    return this.withClient(async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.displayName !== undefined) {
        setClauses.push(`name = $${paramIndex++}`);
        values.push(updates.displayName);
      }
      if (updates.version !== undefined) {
        setClauses.push(`version = $${paramIndex++}`);
        values.push(updates.version);
      }
      if (updates.description !== undefined) {
        setClauses.push(`description = $${paramIndex++}`);
        values.push(updates.description);
      }
      if (updates.status !== undefined) {
        setClauses.push(`is_active = $${paramIndex++}`);
        values.push(statusToIsActive(updates.status));
      }
      if (updates.metadata !== undefined || updates.verticalType !== undefined) {
        // Need to read current terminology to merge
        const current = await client.query(
          `SELECT terminology FROM vertical_packs WHERE id = $1`,
          [id]
        );
        if (current.rows.length === 0) return null;

        const existingTerminology = current.rows[0].terminology
          ? (typeof current.rows[0].terminology === 'string'
              ? JSON.parse(current.rows[0].terminology)
              : current.rows[0].terminology) as Record<string, unknown>
          : {};

        const newTerminology = {
          ...existingTerminology,
          ...(updates.metadata ?? {}),
        };
        if (updates.verticalType !== undefined) {
          newTerminology._verticalType = updates.verticalType;
        }

        setClauses.push(`terminology = $${paramIndex++}`);
        values.push(JSON.stringify(newTerminology));
      }

      if (setClauses.length === 0) {
        return this.get(id);
      }

      setClauses.push(`updated_at = $${paramIndex++}`);
      values.push(updates.updatedAt ?? new Date());

      values.push(id);

      const result = await client.query(
        `UPDATE vertical_packs SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *`,
        values
      );
      return result.rows.length > 0 ? rowToPackV2(result.rows[0]) : null;
    });
  }
}
