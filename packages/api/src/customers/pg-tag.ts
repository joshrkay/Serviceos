import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { TagRepository } from './tag';

/**
 * U2 (CRM Jobber parity) — Postgres-backed customer tags.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside RLS). Add is idempotent via ON CONFLICT DO NOTHING against the
 * customer_tags_unique constraint (migration 187).
 */
export class PgTagRepository extends PgBaseRepository implements TagRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async addTag(tenantId: string, customerId: string, tag: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO customer_tags (tenant_id, customer_id, tag)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, customer_id, tag) DO NOTHING
         RETURNING id`,
        [tenantId, customerId, tag]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async removeTag(tenantId: string, customerId: string, tag: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        'DELETE FROM customer_tags WHERE tenant_id = $1 AND customer_id = $2 AND tag = $3',
        [tenantId, customerId, tag]
      );
    });
  }

  async listForCustomer(tenantId: string, customerId: string): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT tag FROM customer_tags WHERE tenant_id = $1 AND customer_id = $2 ORDER BY tag ASC',
        [tenantId, customerId]
      );
      return result.rows.map((r) => r.tag as string);
    });
  }

  async listCustomerIdsByTag(tenantId: string, tag: string): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT DISTINCT customer_id FROM customer_tags WHERE tenant_id = $1 AND tag = $2',
        [tenantId, tag]
      );
      return result.rows.map((r) => r.customer_id as string);
    });
  }

  async listDistinctTags(tenantId: string): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT DISTINCT tag FROM customer_tags WHERE tenant_id = $1 ORDER BY tag ASC',
        [tenantId]
      );
      return result.rows.map((r) => r.tag as string);
    });
  }
}
