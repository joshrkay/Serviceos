import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Customer, CustomerListOptions, CustomerRepository } from './customer';

function mapRow(row: Record<string, unknown>): Customer {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    displayName: row.display_name as string,
    companyName: (row.company_name as string) ?? undefined,
    primaryPhone: (row.primary_phone as string) ?? undefined,
    secondaryPhone: (row.secondary_phone as string) ?? undefined,
    email: (row.email as string) ?? undefined,
    preferredChannel: row.preferred_channel as Customer['preferredChannel'],
    smsConsent: row.sms_consent as boolean,
    communicationNotes: (row.communication_notes as string) ?? undefined,
    isArchived: row.is_archived as boolean,
    archivedAt: row.archived_at ? new Date(row.archived_at as string) : undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgCustomerRepository extends PgBaseRepository implements CustomerRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(customer: Customer): Promise<Customer> {
    return this.withTenant(customer.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO customers (
          id, tenant_id, first_name, last_name, display_name, company_name,
          primary_phone, secondary_phone, email, preferred_channel, sms_consent,
          communication_notes, is_archived, archived_at, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *`,
        [
          customer.id,
          customer.tenantId,
          customer.firstName,
          customer.lastName,
          customer.displayName,
          customer.companyName ?? null,
          customer.primaryPhone ?? null,
          customer.secondaryPhone ?? null,
          customer.email ?? null,
          customer.preferredChannel,
          customer.smsConsent,
          customer.communicationNotes ?? null,
          customer.isArchived,
          customer.archivedAt ?? null,
          customer.createdBy,
          customer.createdAt,
          customer.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Customer | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM customers WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string, options?: CustomerListOptions): Promise<Customer[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let paramIndex = 2;

      if (!options?.includeArchived) {
        conditions.push('is_archived = false');
      }

      if (options?.search) {
        const searchParam = `%${options.search}%`;
        conditions.push(
          `(display_name ILIKE $${paramIndex} OR company_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`
        );
        params.push(searchParam);
        paramIndex++;
      }

      const result = await client.query(
        `SELECT * FROM customers WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
        params
      );
      return result.rows.map(mapRow);
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Customer>): Promise<Customer | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        firstName: 'first_name',
        lastName: 'last_name',
        displayName: 'display_name',
        companyName: 'company_name',
        primaryPhone: 'primary_phone',
        secondaryPhone: 'secondary_phone',
        email: 'email',
        preferredChannel: 'preferred_channel',
        smsConsent: 'sms_consent',
        communicationNotes: 'communication_notes',
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

      if (setClauses.length === 0) return this.findById(tenantId, id);

      params.push(tenantId, id);
      const result = await client.query(
        `UPDATE customers SET ${setClauses.join(', ')}
         WHERE tenant_id = $${paramIndex} AND id = $${paramIndex + 1}
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async search(tenantId: string, query: string): Promise<Customer[]> {
    return this.withTenant(tenantId, async (client) => {
      const searchParam = `%${query}%`;
      const result = await client.query(
        `SELECT * FROM customers
         WHERE tenant_id = $1 AND is_archived = false
           AND (display_name ILIKE $2 OR company_name ILIKE $2 OR email ILIKE $2 OR primary_phone ILIKE $2)
         ORDER BY display_name ASC`,
        [tenantId, searchParam]
      );
      return result.rows.map(mapRow);
    });
  }
}
