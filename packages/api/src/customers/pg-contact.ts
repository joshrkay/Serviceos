import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { ContactRepository, CustomerContact } from './contact';

/**
 * U1 (CRM Jobber parity) — Postgres-backed customer-contact repository.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside RLS). The single-primary-per-customer invariant is enforced in
 * the same transaction as the write: when a contact becomes primary, every
 * sibling is demoted before the insert/update returns.
 */
function mapRow(row: Record<string, unknown>): CustomerContact {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    name: row.name as string,
    role: row.role as CustomerContact['role'],
    phone: (row.phone as string) ?? undefined,
    email: (row.email as string) ?? undefined,
    isPrimary: row.is_primary as boolean,
    notes: (row.notes as string) ?? undefined,
    isArchived: row.is_archived as boolean,
    archivedAt: row.archived_at ? new Date(row.archived_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgContactRepository extends PgBaseRepository implements ContactRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  private async demoteSiblings(
    client: PoolClient,
    tenantId: string,
    customerId: string,
    exceptId: string
  ): Promise<void> {
    await client.query(
      `UPDATE customer_contacts
       SET is_primary = false, updated_at = NOW()
       WHERE tenant_id = $1 AND customer_id = $2 AND id <> $3 AND is_primary = true`,
      [tenantId, customerId, exceptId]
    );
  }

  async create(contact: CustomerContact): Promise<CustomerContact> {
    return this.withTenantTransaction(contact.tenantId, async (client) => {
      if (contact.isPrimary) {
        await this.demoteSiblings(client, contact.tenantId, contact.customerId, contact.id);
      }
      const result = await client.query(
        `INSERT INTO customer_contacts (
          id, tenant_id, customer_id, name, role, phone, email, is_primary,
          notes, is_archived, archived_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          contact.id,
          contact.tenantId,
          contact.customerId,
          contact.name,
          contact.role,
          contact.phone ?? null,
          contact.email ?? null,
          contact.isPrimary,
          contact.notes ?? null,
          contact.isArchived,
          contact.archivedAt ?? null,
          contact.createdAt,
          contact.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<CustomerContact | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM customer_contacts WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByCustomer(
    tenantId: string,
    customerId: string,
    includeArchived = false
  ): Promise<CustomerContact[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions = ['tenant_id = $1', 'customer_id = $2'];
      if (!includeArchived) conditions.push('is_archived = false');
      const result = await client.query(
        `SELECT * FROM customer_contacts
         WHERE ${conditions.join(' AND ')}
         ORDER BY is_primary DESC,
           CASE role
             WHEN 'primary' THEN 0
             WHEN 'billing' THEN 1
             WHEN 'site' THEN 2
             ELSE 3
           END,
           name ASC`,
        [tenantId, customerId]
      );
      return result.rows.map(mapRow);
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<CustomerContact>
  ): Promise<CustomerContact | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const existing = await client.query(
        'SELECT customer_id FROM customer_contacts WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      if (existing.rows.length === 0) return null;
      const customerId = existing.rows[0].customer_id as string;

      if (updates.isPrimary === true) {
        await this.demoteSiblings(client, tenantId, customerId, id);
      }

      const fieldMap: Record<string, string> = {
        name: 'name',
        role: 'role',
        phone: 'phone',
        email: 'email',
        isPrimary: 'is_primary',
        notes: 'notes',
        isArchived: 'is_archived',
        archivedAt: 'archived_at',
        updatedAt: 'updated_at',
      };

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;
      for (const [key, value] of Object.entries(updates)) {
        const column = fieldMap[key];
        if (column) {
          setClauses.push(`${column} = $${paramIndex}`);
          params.push(value ?? null);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) {
        const current = await client.query(
          'SELECT * FROM customer_contacts WHERE tenant_id = $1 AND id = $2',
          [tenantId, id]
        );
        return current.rows.length > 0 ? mapRow(current.rows[0]) : null;
      }

      params.push(tenantId, id);
      const result = await client.query(
        `UPDATE customer_contacts SET ${setClauses.join(', ')}
         WHERE tenant_id = $${paramIndex} AND id = $${paramIndex + 1}
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
