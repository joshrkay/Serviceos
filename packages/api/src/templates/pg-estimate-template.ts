import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  EstimateTemplate,
  EstimateTemplateRepository,
  LineItemTemplate,
} from './estimate-template';
import { VerticalType } from '../verticals/registry';

function rowToTemplate(row: Record<string, unknown>): EstimateTemplate {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    verticalType: row.vertical_type as VerticalType,
    categoryId: row.category_id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    lineItemTemplates: (typeof row.line_item_templates === 'string'
      ? JSON.parse(row.line_item_templates)
      : row.line_item_templates) as LineItemTemplate[],
    defaultDiscountCents: Number(row.default_discount_cents),
    defaultTaxRateBps: Number(row.default_tax_rate_bps),
    defaultCustomerMessage: row.default_customer_message as string | undefined,
    isActive: row.is_active as boolean,
    usageCount: Number(row.usage_count),
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgEstimateTemplateRepository
  extends PgBaseRepository
  implements EstimateTemplateRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(template: EstimateTemplate): Promise<EstimateTemplate> {
    return this.withTenant(template.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO estimate_templates (
          id, tenant_id, vertical_type, category_id, name, description,
          line_item_templates, default_discount_cents, default_tax_rate_bps,
          default_customer_message, is_active, usage_count, created_by,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          template.id,
          template.tenantId,
          template.verticalType,
          template.categoryId,
          template.name,
          template.description ?? null,
          JSON.stringify(template.lineItemTemplates),
          template.defaultDiscountCents,
          template.defaultTaxRateBps,
          template.defaultCustomerMessage ?? null,
          template.isActive,
          template.usageCount,
          template.createdBy,
          template.createdAt,
          template.updatedAt,
        ]
      );
      return rowToTemplate(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<EstimateTemplate | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM estimate_templates WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string): Promise<EstimateTemplate[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM estimate_templates WHERE tenant_id = $1 ORDER BY name`,
        [tenantId]
      );
      return result.rows.map(rowToTemplate);
    });
  }

  async findByCategory(tenantId: string, categoryId: string): Promise<EstimateTemplate[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM estimate_templates WHERE tenant_id = $1 AND category_id = $2 ORDER BY name`,
        [tenantId, categoryId]
      );
      return result.rows.map(rowToTemplate);
    });
  }

  async findByVertical(tenantId: string, verticalType: VerticalType): Promise<EstimateTemplate[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM estimate_templates WHERE tenant_id = $1 AND vertical_type = $2 ORDER BY name`,
        [tenantId, verticalType]
      );
      return result.rows.map(rowToTemplate);
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<EstimateTemplate>
  ): Promise<EstimateTemplate | null> {
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
      if (updates.categoryId !== undefined) {
        setClauses.push(`category_id = $${paramIndex++}`);
        values.push(updates.categoryId);
      }
      if (updates.verticalType !== undefined) {
        setClauses.push(`vertical_type = $${paramIndex++}`);
        values.push(updates.verticalType);
      }
      if (updates.lineItemTemplates !== undefined) {
        setClauses.push(`line_item_templates = $${paramIndex++}`);
        values.push(JSON.stringify(updates.lineItemTemplates));
      }
      if (updates.defaultDiscountCents !== undefined) {
        setClauses.push(`default_discount_cents = $${paramIndex++}`);
        values.push(updates.defaultDiscountCents);
      }
      if (updates.defaultTaxRateBps !== undefined) {
        setClauses.push(`default_tax_rate_bps = $${paramIndex++}`);
        values.push(updates.defaultTaxRateBps);
      }
      if (updates.defaultCustomerMessage !== undefined) {
        setClauses.push(`default_customer_message = $${paramIndex++}`);
        values.push(updates.defaultCustomerMessage);
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
        `UPDATE estimate_templates SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}
         RETURNING *`,
        values
      );
      return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
    });
  }

  async incrementUsage(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE estimate_templates SET usage_count = usage_count + 1, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
    });
  }
}
