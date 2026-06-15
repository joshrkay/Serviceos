import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CustomFieldDef,
  CustomFieldRepository,
  CustomFieldValueRow,
} from './custom-field';

/**
 * U2 (CRM Jobber parity) — Postgres-backed customer custom fields.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside RLS). `setValue` upserts against the customer_cfv_unique
 * constraint (migration 187); a null value deletes the row.
 */
function mapDef(row: Record<string, unknown>): CustomFieldDef {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    key: row.key as string,
    label: row.label as string,
    fieldType: row.field_type as CustomFieldDef['fieldType'],
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    sortOrder: row.sort_order as number,
    isArchived: row.is_archived as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgCustomFieldRepository extends PgBaseRepository implements CustomFieldRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async createDef(def: CustomFieldDef): Promise<CustomFieldDef> {
    return this.withTenant(def.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO customer_custom_field_defs (
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

  async findDefById(tenantId: string, id: string): Promise<CustomFieldDef | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM customer_custom_field_defs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapDef(result.rows[0]) : null;
    });
  }

  async findDefByKey(tenantId: string, key: string): Promise<CustomFieldDef | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM customer_custom_field_defs WHERE tenant_id = $1 AND key = $2',
        [tenantId, key]
      );
      return result.rows.length > 0 ? mapDef(result.rows[0]) : null;
    });
  }

  async listDefs(tenantId: string, includeArchived = false): Promise<CustomFieldDef[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions = ['tenant_id = $1'];
      if (!includeArchived) conditions.push('is_archived = false');
      const result = await client.query(
        `SELECT * FROM customer_custom_field_defs
         WHERE ${conditions.join(' AND ')}
         ORDER BY sort_order ASC, label ASC`,
        [tenantId]
      );
      return result.rows.map(mapDef);
    });
  }

  async archiveDef(tenantId: string, id: string): Promise<CustomFieldDef | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE customer_custom_field_defs
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
    customerId: string,
    fieldDefId: string,
    value: string | null
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      if (value === null) {
        await client.query(
          `DELETE FROM customer_custom_field_values
           WHERE tenant_id = $1 AND customer_id = $2 AND field_def_id = $3`,
          [tenantId, customerId, fieldDefId]
        );
        return;
      }
      await client.query(
        `INSERT INTO customer_custom_field_values (tenant_id, customer_id, field_def_id, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, customer_id, field_def_id)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [tenantId, customerId, fieldDefId, value]
      );
    });
  }

  async listValues(tenantId: string, customerId: string): Promise<CustomFieldValueRow[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT field_def_id, value FROM customer_custom_field_values
         WHERE tenant_id = $1 AND customer_id = $2`,
        [tenantId, customerId]
      );
      return result.rows.map((r) => ({
        fieldDefId: r.field_def_id as string,
        value: (r.value as string) ?? null,
      }));
    });
  }
}
