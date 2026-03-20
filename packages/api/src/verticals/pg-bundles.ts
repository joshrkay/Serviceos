import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { ServiceBundle, ServiceBundleRepository } from './bundles';
import { VerticalType } from './registry';
import { LineItemTemplate } from '../templates/estimate-template';

function rowToBundle(row: Record<string, unknown>): ServiceBundle {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    verticalType: row.vertical_type as VerticalType,
    name: row.name as string,
    description: row.description as string | undefined,
    categoryIds: (typeof row.category_ids === 'string'
      ? JSON.parse(row.category_ids)
      : row.category_ids) as string[],
    lineItemTemplates: (typeof row.line_item_templates === 'string'
      ? JSON.parse(row.line_item_templates)
      : row.line_item_templates) as LineItemTemplate[],
    triggerKeywords: (typeof row.trigger_keywords === 'string'
      ? JSON.parse(row.trigger_keywords)
      : row.trigger_keywords) as string[],
    isActive: row.is_active as boolean,
    usageCount: Number(row.usage_count),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgServiceBundleRepository
  extends PgBaseRepository
  implements ServiceBundleRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(bundle: ServiceBundle): Promise<ServiceBundle> {
    return this.withTenant(bundle.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO service_bundles (
          id, tenant_id, vertical_type, name, description,
          category_ids, line_item_templates, trigger_keywords,
          is_active, usage_count, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          bundle.id,
          bundle.tenantId,
          bundle.verticalType,
          bundle.name,
          bundle.description ?? null,
          JSON.stringify(bundle.categoryIds),
          JSON.stringify(bundle.lineItemTemplates),
          JSON.stringify(bundle.triggerKeywords),
          bundle.isActive,
          bundle.usageCount,
          bundle.createdAt,
          bundle.updatedAt,
        ]
      );
      return rowToBundle(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<ServiceBundle | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM service_bundles WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      return result.rows.length > 0 ? rowToBundle(result.rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string): Promise<ServiceBundle[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM service_bundles WHERE tenant_id = $1 ORDER BY name`,
        [tenantId]
      );
      return result.rows.map(rowToBundle);
    });
  }

  async findByVertical(tenantId: string, verticalType: VerticalType): Promise<ServiceBundle[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM service_bundles WHERE tenant_id = $1 AND vertical_type = $2 ORDER BY name`,
        [tenantId, verticalType]
      );
      return result.rows.map(rowToBundle);
    });
  }

  async findByKeyword(tenantId: string, keyword: string): Promise<ServiceBundle[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM service_bundles
         WHERE tenant_id = $1
           AND is_active = true
           AND trigger_keywords @> $2::jsonb
         ORDER BY name`,
        [tenantId, JSON.stringify([keyword.toLowerCase()])]
      );
      return result.rows.map(rowToBundle);
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<ServiceBundle>
  ): Promise<ServiceBundle | null> {
    return this.withTenant(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.name !== undefined) {
        setClauses.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      if (updates.description !== undefined) {
        setClauses.push(`description = $${paramIndex++}`);
        values.push(updates.description);
      }
      if (updates.verticalType !== undefined) {
        setClauses.push(`vertical_type = $${paramIndex++}`);
        values.push(updates.verticalType);
      }
      if (updates.categoryIds !== undefined) {
        setClauses.push(`category_ids = $${paramIndex++}`);
        values.push(JSON.stringify(updates.categoryIds));
      }
      if (updates.lineItemTemplates !== undefined) {
        setClauses.push(`line_item_templates = $${paramIndex++}`);
        values.push(JSON.stringify(updates.lineItemTemplates));
      }
      if (updates.triggerKeywords !== undefined) {
        setClauses.push(`trigger_keywords = $${paramIndex++}`);
        values.push(JSON.stringify(updates.triggerKeywords));
      }
      if (updates.isActive !== undefined) {
        setClauses.push(`is_active = $${paramIndex++}`);
        values.push(updates.isActive);
      }

      if (setClauses.length === 0) {
        return this.findById(tenantId, id);
      }

      setClauses.push(`updated_at = $${paramIndex++}`);
      values.push(new Date());

      values.push(id);
      values.push(tenantId);

      const result = await client.query(
        `UPDATE service_bundles SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}
         RETURNING *`,
        values
      );
      return result.rows.length > 0 ? rowToBundle(result.rows[0]) : null;
    });
  }

  async incrementUsage(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE service_bundles SET usage_count = usage_count + 1, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
    });
  }
}
