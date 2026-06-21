import { Pool } from 'pg';

import { PgBaseRepository } from '../db/pg-base';
import {
  MessageTemplate,
  MessageTemplateCategory,
  MessageTemplateChannel,
  MessageTemplateFilter,
  MessageTemplateRepository,
  UpdateMessageTemplateInput,
} from './message-template';

function rowToTemplate(row: Record<string, unknown>): MessageTemplate {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    category: row.category as MessageTemplateCategory,
    channel: row.channel as MessageTemplateChannel,
    body: row.body as string,
    isActive: row.is_active as boolean,
    usageCount: Number(row.usage_count),
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgMessageTemplateRepository
  extends PgBaseRepository
  implements MessageTemplateRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(template: MessageTemplate): Promise<MessageTemplate> {
    return this.withTenant(template.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO message_templates (
          id, tenant_id, name, category, channel, body,
          is_active, usage_count, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          template.id,
          template.tenantId,
          template.name,
          template.category,
          template.channel,
          template.body,
          template.isActive,
          template.usageCount,
          template.createdBy,
          template.createdAt,
          template.updatedAt,
        ],
      );
      return rowToTemplate(result.rows[0]);
    });
  }

  async findById(
    tenantId: string,
    id: string,
  ): Promise<MessageTemplate | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM message_templates WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
    });
  }

  async findByTenant(
    tenantId: string,
    filter?: MessageTemplateFilter,
  ): Promise<MessageTemplate[]> {
    return this.withTenant(tenantId, async (client) => {
      const clauses: string[] = ['tenant_id = $1'];
      const values: unknown[] = [tenantId];
      let paramIndex = 2;

      if (filter?.channel) {
        clauses.push(`channel = $${paramIndex++}`);
        values.push(filter.channel);
      }
      if (filter?.category) {
        clauses.push(`category = $${paramIndex++}`);
        values.push(filter.category);
      }
      if (filter?.activeOnly) {
        clauses.push(`is_active = TRUE`);
      }

      const result = await client.query(
        `SELECT * FROM message_templates WHERE ${clauses.join(
          ' AND ',
        )} ORDER BY name`,
        values,
      );
      return result.rows.map(rowToTemplate);
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: UpdateMessageTemplateInput,
  ): Promise<MessageTemplate | null> {
    return this.withTenant(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.name !== undefined) {
        setClauses.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      if (updates.category !== undefined) {
        setClauses.push(`category = $${paramIndex++}`);
        values.push(updates.category);
      }
      if (updates.channel !== undefined) {
        setClauses.push(`channel = $${paramIndex++}`);
        values.push(updates.channel);
      }
      if (updates.body !== undefined) {
        setClauses.push(`body = $${paramIndex++}`);
        values.push(updates.body);
      }
      if (updates.isActive !== undefined) {
        setClauses.push(`is_active = $${paramIndex++}`);
        values.push(updates.isActive);
      }

      if (setClauses.length === 0) {
        // No-op update: read back on the SAME client rather than calling
        // findById, which would open a nested withTenant (a second pool
        // checkout). Keep the explicit tenant_id filter for consistency with
        // the file's other queries (belt-and-braces alongside RLS/GUC).
        const result = await client.query(
          `SELECT * FROM message_templates WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
        return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
      }

      setClauses.push(`updated_at = $${paramIndex++}`);
      values.push(new Date());

      values.push(id);
      values.push(tenantId);

      const result = await client.query(
        `UPDATE message_templates SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}
         RETURNING *`,
        values,
      );
      return result.rows.length > 0 ? rowToTemplate(result.rows[0]) : null;
    });
  }

  async incrementUsage(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE message_templates SET usage_count = usage_count + 1, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM message_templates WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
