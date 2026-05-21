import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  Customer,
  CustomerListOptions,
  CustomerListResult,
  CustomerRepository,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './customer';
import { normalizeEmail, normalizePhone } from './dedup';

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
    originatingLeadId: (row.originating_lead_id as string) ?? undefined,
    preferredLanguage:
      (row.preferred_language as 'en' | 'es' | null | undefined) ?? undefined,
    // P8-016 — additive vulnerability fields (migration 113).
    dateOfBirth: row.date_of_birth ? new Date(row.date_of_birth as string) : undefined,
    accountType:
      (row.account_type as 'residential' | 'b2b' | null | undefined) ?? undefined,
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
          communication_notes, is_archived, archived_at, originating_lead_id,
          date_of_birth, account_type,
          created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                  $15, $16, $17, $18, $19, $20)
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
          customer.originatingLeadId ?? null,
          customer.dateOfBirth ?? null,
          customer.accountType ?? null,
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

  /**
   * Build the parameterized WHERE clause used by both `findByTenant` and
   * `listWithMeta` so the data + count queries see identical filters.
   * tenant_id is always the FIRST predicate (defense-in-depth alongside RLS).
   */
  private buildListWhere(tenantId: string, options?: CustomerListOptions): {
    where: string;
    params: unknown[];
  } {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (!options?.includeArchived) {
      conditions.push('is_archived = false');
    }

    if (options?.search) {
      const searchParam = `%${options.search}%`;
      conditions.push(
        `(display_name ILIKE $${paramIndex} OR company_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex} OR primary_phone ILIKE $${paramIndex})`
      );
      params.push(searchParam);
      paramIndex++;
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  async findByTenant(tenantId: string, options?: CustomerListOptions): Promise<Customer[]> {
    return this.withTenant(tenantId, async (client) => {
      return this.queryListRows(client, tenantId, options);
    });
  }

  private async queryListRows(
    client: PoolClient,
    tenantId: string,
    options?: CustomerListOptions
  ): Promise<Customer[]> {
    const { where, params } = this.buildListWhere(tenantId, options);
    // P1-018: default sort = display_name ASC for customers per spec.
    const sortDirection = options?.sort === 'desc' ? 'DESC' : 'ASC';
    const usePagination = options?.limit !== undefined || options?.offset !== undefined;
    let sql = `SELECT * FROM customers ${where} ORDER BY display_name ${sortDirection}`;
    let queryParams = params;
    if (usePagination) {
      const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = options?.offset ?? 0;
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      queryParams = [...params, limit, offset];
    }
    const result = await client.query(sql, queryParams);
    return result.rows.map(mapRow);
  }

  async listWithMeta(
    tenantId: string,
    options?: CustomerListOptions
  ): Promise<CustomerListResult> {
    return this.withTenant(tenantId, async (client) => {
      const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = options?.offset ?? 0;
      const data = await this.queryListRows(client, tenantId, { ...options, limit, offset });
      const { where, params } = this.buildListWhere(tenantId, options);
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM customers ${where}`,
        params
      );
      return { data, total: countResult.rows[0].total as number };
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
        originatingLeadId: 'originating_lead_id',
        preferredLanguage: 'preferred_language',
        dateOfBirth: 'date_of_birth',
        accountType: 'account_type',
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

  /**
   * VQ-006 follow-up (PR #265 review): repository-side phone lookup.
   *
   * Replaces the previous "fetch every tenant row, filter in-memory by
   * last-10-digits" path used by the lookup_customer voice skill. The
   * stored generated column `phone_normalized` (migration
   * 053_p8_customers_phone_index) is digits-only, so the predicate is
   * a parameterized comparison against the trailing-10 substring.
   *
   * tenant_id is the first WHERE predicate (defense-in-depth alongside
   * RLS). Index `idx_customers_phone_normalized (tenant_id, phone_normalized)`
   * makes the equality fast; the trailing-10 fallback is bounded to a
   * single tenant so it's still tractable for the v1 row counts.
   *
   * Returns multiple rows when a phone is shared (e.g. household line)
   * — callers decide whether to ask "which person?". Archived rows are
   * included so the skill can confirm record info even on archived
   * customers.
   */
  async findByPhoneNormalized(
    tenantId: string,
    phoneNormalized: string
  ): Promise<Customer[]> {
    if (!phoneNormalized || phoneNormalized.length < 7) return [];
    const tail = phoneNormalized.slice(-10);
    return this.withTenant(tenantId, async (client) => {
      // Match either:
      //   (a) phone_normalized ends with the supplied tail (caller said
      //       a 10-digit number; record stored with country prefix), or
      //   (b) the supplied tail ends with phone_normalized (caller had
      //       a country prefix; record stored without).
      const result = await client.query(
        `SELECT * FROM customers
         WHERE tenant_id = $1
           AND phone_normalized IS NOT NULL
           AND phone_normalized <> ''
           AND (right(phone_normalized, 10) = $2 OR $2 LIKE '%' || phone_normalized)`,
        [tenantId, tail]
      );
      return result.rows.map(mapRow);
    });
  }

  /**
   * P1-019: Pg-backed dedup candidate query.
   *
   * Hard requirement (see /docs/superpowers/contracts/repository-conventions.md):
   *   tenant_id MUST be the FIRST predicate in the WHERE clause.
   *   RLS enforces this at the row level, but defense-in-depth means
   *   we also bind `tenant_id = $1` explicitly so a misconfigured RLS
   *   context can never leak cross-tenant rows.
   *
   * Phone matching strategy:
   *   The `primary_phone` column stores the user-provided string, not
   *   a normalized form. Existing data may include `(415) 555-1234`,
   *   `415-555-1234`, `+14155551234`, etc. To match across formats we
   *   strip non-digits in SQL via `regexp_replace(..., '\D', '', 'g')`
   *   and compare against the normalized input. This is a sequential
   *   scan within the tenant; for a v1 with low customer counts per
   *   tenant this is acceptable. See follow-up note in commit body
   *   re: a future expression index.
   *
   * Email matching strategy:
   *   `lower(trim(...))` on both sides, parameterized.
   *
   * All variables are bound via $N — never concatenated.
   */
  async findDuplicates(
    tenantId: string,
    criteria: { phone?: string; email?: string }
  ): Promise<Customer[]> {
    const normalizedPhone = criteria.phone ? normalizePhone(criteria.phone) : '';
    const normalizedEmail = criteria.email ? normalizeEmail(criteria.email) : '';

    // Phone shorter than 7 digits is too ambiguous for a high-confidence
    // match — skip the predicate (mirrors checkCustomerDuplicates).
    const includePhone = normalizedPhone.length >= 7;
    const includeEmail = normalizedEmail.length > 0;

    if (!includePhone && !includeEmail) return [];

    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1', 'is_archived = false'];
      const params: unknown[] = [tenantId];
      const matchClauses: string[] = [];
      let paramIndex = 2;

      if (includePhone) {
        // Strip non-digits server-side for tolerant matching.
        matchClauses.push(
          `regexp_replace(coalesce(primary_phone, ''), '\\D', '', 'g') = $${paramIndex}`
        );
        params.push(normalizedPhone);
        paramIndex++;
      }
      if (includeEmail) {
        matchClauses.push(`lower(trim(coalesce(email, ''))) = $${paramIndex}`);
        params.push(normalizedEmail);
        paramIndex++;
      }

      conditions.push(`(${matchClauses.join(' OR ')})`);

      const result = await client.query(
        `SELECT * FROM customers WHERE ${conditions.join(' AND ')}`,
        params
      );
      return result.rows.map(mapRow);
    });
  }
}
