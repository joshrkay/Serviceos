import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CustomerGroup,
  CustomerGroupRepository,
  CustomerGroupWithCount,
} from './customer-group';

/**
 * U8 (CRM Jobber parity) — Postgres-backed customer groups + membership.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside FORCE RLS, migration 227). Membership add is idempotent via
 * ON CONFLICT DO NOTHING against the customer_group_members_unique constraint.
 */
function mapGroup(row: Record<string, unknown>): CustomerGroup {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    color: (row.color as string | null) ?? null,
    isArchived: row.is_archived as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgCustomerGroupRepository extends PgBaseRepository implements CustomerGroupRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async createGroup(group: CustomerGroup): Promise<CustomerGroup> {
    return this.withTenant(group.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO customer_groups (
          id, tenant_id, name, description, color, is_archived, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          group.id,
          group.tenantId,
          group.name,
          group.description,
          group.color,
          group.isArchived,
          group.createdAt,
          group.updatedAt,
        ]
      );
      return mapGroup(result.rows[0]);
    });
  }

  async findGroupById(tenantId: string, id: string): Promise<CustomerGroup | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM customer_groups WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapGroup(result.rows[0]) : null;
    });
  }

  async findGroupByName(tenantId: string, name: string): Promise<CustomerGroup | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM customer_groups WHERE tenant_id = $1 AND LOWER(name) = LOWER($2)',
        [tenantId, name]
      );
      return result.rows.length > 0 ? mapGroup(result.rows[0]) : null;
    });
  }

  async listGroups(tenantId: string, includeArchived = false): Promise<CustomerGroupWithCount[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions = ['g.tenant_id = $1'];
      if (!includeArchived) conditions.push('g.is_archived = false');
      const result = await client.query(
        `SELECT g.*, COUNT(m.customer_id)::int AS member_count
           FROM customer_groups g
           LEFT JOIN customer_group_members m
             ON m.group_id = g.id AND m.tenant_id = g.tenant_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY g.id
          ORDER BY g.name ASC`,
        [tenantId]
      );
      return result.rows.map((r) => ({ ...mapGroup(r), memberCount: Number(r.member_count) }));
    });
  }

  async updateGroup(group: CustomerGroup): Promise<CustomerGroup> {
    return this.withTenant(group.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE customer_groups
         SET name = $3, description = $4, color = $5, is_archived = $6, updated_at = $7
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          group.tenantId,
          group.id,
          group.name,
          group.description,
          group.color,
          group.isArchived,
          group.updatedAt,
        ]
      );
      if (result.rows.length === 0) throw new Error('Customer group not found');
      return mapGroup(result.rows[0]);
    });
  }

  async archiveGroup(tenantId: string, id: string): Promise<CustomerGroup | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE customer_groups
         SET is_archived = true, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapGroup(result.rows[0]) : null;
    });
  }

  async addMember(tenantId: string, groupId: string, customerId: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO customer_group_members (tenant_id, group_id, customer_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, group_id, customer_id) DO NOTHING
         RETURNING customer_id`,
        [tenantId, groupId, customerId]
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async removeMember(tenantId: string, groupId: string, customerId: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `DELETE FROM customer_group_members
         WHERE tenant_id = $1 AND group_id = $2 AND customer_id = $3`,
        [tenantId, groupId, customerId]
      );
    });
  }

  async listMemberIds(tenantId: string, groupId: string): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT customer_id FROM customer_group_members WHERE tenant_id = $1 AND group_id = $2',
        [tenantId, groupId]
      );
      return result.rows.map((r) => r.customer_id as string);
    });
  }

  async listGroupsForCustomer(tenantId: string, customerId: string): Promise<CustomerGroup[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT g.* FROM customer_groups g
           JOIN customer_group_members m
             ON m.group_id = g.id AND m.tenant_id = g.tenant_id
          WHERE g.tenant_id = $1 AND m.customer_id = $2 AND g.is_archived = false
          ORDER BY g.name ASC`,
        [tenantId, customerId]
      );
      return result.rows.map(mapGroup);
    });
  }
}
