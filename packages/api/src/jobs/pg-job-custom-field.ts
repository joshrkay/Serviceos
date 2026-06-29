import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  JobCustomFieldDef,
  JobCustomFieldRepository,
  JobCustomFieldValueRow,
} from './job-custom-field';

/**
 * J-CF (Jobber parity) — Postgres-backed job custom fields.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside FORCE RLS, migration 224). `setValue` upserts against the
 * job_cfv_unique constraint; a null value deletes the row. Mirrors
 * pg-custom-field.ts (customer twin).
 */
function mapDef(row: Record<string, unknown>): JobCustomFieldDef {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    key: row.key as string,
    label: row.label as string,
    fieldType: row.field_type as JobCustomFieldDef['fieldType'],
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    sortOrder: row.sort_order as number,
    isArchived: row.is_archived as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgJobCustomFieldRepository extends PgBaseRepository implements JobCustomFieldRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async createDef(def: JobCustomFieldDef): Promise<JobCustomFieldDef> {
    return this.withTenant(def.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO job_custom_field_defs (
          id, tenant_id, key, label, field_type, options, sort_order,
          is_archived, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
        RETURNING *`,
        [
          def.id,
          def.tenantId,
          def.key,
          def.label,
          def.fieldType,
          JSON.stringify(def.options),
          def.sortOrder,
          def.isArchived,
          def.createdAt,
          def.updatedAt,
        ]
      );
      return mapDef(result.rows[0]);
    });
  }

  async findDefById(tenantId: string, id: string): Promise<JobCustomFieldDef | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM job_custom_field_defs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapDef(result.rows[0]) : null;
    });
  }

  async findDefByKey(tenantId: string, key: string): Promise<JobCustomFieldDef | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM job_custom_field_defs WHERE tenant_id = $1 AND key = $2',
        [tenantId, key]
      );
      return result.rows.length > 0 ? mapDef(result.rows[0]) : null;
    });
  }

  async listDefs(tenantId: string, includeArchived = false): Promise<JobCustomFieldDef[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions = ['tenant_id = $1'];
      if (!includeArchived) conditions.push('is_archived = false');
      const result = await client.query(
        `SELECT * FROM job_custom_field_defs
         WHERE ${conditions.join(' AND ')}
         ORDER BY sort_order ASC, label ASC`,
        [tenantId]
      );
      return result.rows.map(mapDef);
    });
  }

  async archiveDef(tenantId: string, id: string): Promise<JobCustomFieldDef | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE job_custom_field_defs
         SET is_archived = true, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapDef(result.rows[0]) : null;
    });
  }

  async setValue(
    tenantId: string,
    jobId: string,
    fieldDefId: string,
    value: string | null
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      if (value === null) {
        await client.query(
          `DELETE FROM job_custom_field_values
           WHERE tenant_id = $1 AND job_id = $2 AND field_def_id = $3`,
          [tenantId, jobId, fieldDefId]
        );
        return;
      }
      await client.query(
        `INSERT INTO job_custom_field_values (tenant_id, job_id, field_def_id, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, job_id, field_def_id)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [tenantId, jobId, fieldDefId, value]
      );
    });
  }

  async listValues(tenantId: string, jobId: string): Promise<JobCustomFieldValueRow[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT field_def_id, value FROM job_custom_field_values
         WHERE tenant_id = $1 AND job_id = $2`,
        [tenantId, jobId]
      );
      return result.rows.map((r) => ({
        fieldDefId: r.field_def_id as string,
        value: (r.value as string) ?? null,
      }));
    });
  }
}
