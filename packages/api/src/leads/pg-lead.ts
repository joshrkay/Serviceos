import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DEFAULT_LIST_LIMIT,
  Lead,
  LeadListOptions,
  LeadListResult,
  LeadRepository,
  MAX_LIST_LIMIT,
} from './lead';
import { LeadSource, LeadStage } from './enums';

function mapRow(row: Record<string, unknown>): Lead {
  // BIGINT comes back as a string from node-pg unless parsed; coerce via Number
  // because we cap value at JS safe range upstream (Zod int + reasonable cap).
  const valueRaw = row.estimated_value_cents;
  const estimatedValueCents =
    valueRaw === null || valueRaw === undefined
      ? undefined
      : typeof valueRaw === 'string'
      ? Number(valueRaw)
      : (valueRaw as number);

  // node-pg parses JSONB -> object automatically; default '{}' means it's
  // never null, but we still guard for older rows that pre-date 059.
  const attributionRaw = row.attribution;
  const attribution =
    attributionRaw && typeof attributionRaw === 'object'
      ? (attributionRaw as Record<string, string>)
      : undefined;
  const attributionFinal =
    attribution && Object.keys(attribution).length > 0 ? attribution : undefined;

  // LC-1 — raw_payload defaults to '{}' (NOT NULL); surface as undefined when
  // empty so the entity stays clean for manually-created CRM leads.
  const rawPayloadRaw = row.raw_payload;
  const rawPayload =
    rawPayloadRaw && typeof rawPayloadRaw === 'object'
      ? (rawPayloadRaw as Record<string, unknown>)
      : undefined;
  const rawPayloadFinal =
    rawPayload && Object.keys(rawPayload).length > 0 ? rawPayload : undefined;

  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    companyName: (row.company_name as string) ?? undefined,
    primaryPhone: (row.primary_phone as string) ?? undefined,
    email: (row.email as string) ?? undefined,
    source: row.source as LeadSource,
    sourceDetail: (row.source_detail as string) ?? undefined,
    utmSource: (row.utm_source as string) ?? undefined,
    utmMedium: (row.utm_medium as string) ?? undefined,
    utmCampaign: (row.utm_campaign as string) ?? undefined,
    attribution: attributionFinal,
    rawPayload: rawPayloadFinal,
    stage: row.stage as LeadStage,
    estimatedValueCents,
    notes: (row.notes as string) ?? undefined,
    assignedUserId: (row.assigned_user_id as string) ?? undefined,
    convertedCustomerId: (row.converted_customer_id as string) ?? undefined,
    lostReason: (row.lost_reason as string) ?? undefined,
    preferredLanguage:
      (row.preferred_language as 'en' | 'es' | null | undefined) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgLeadRepository extends PgBaseRepository implements LeadRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(lead: Lead): Promise<Lead> {
    return this.withTenant(lead.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO leads (
          id, tenant_id, first_name, last_name, company_name, primary_phone, email,
          source, source_detail, utm_source, utm_medium, utm_campaign, attribution,
          raw_payload, stage, estimated_value_cents, notes, assigned_user_id,
          converted_customer_id, lost_reason, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
                  $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        RETURNING *`,
        [
          lead.id,
          lead.tenantId,
          lead.firstName,
          lead.lastName,
          lead.companyName ?? null,
          lead.primaryPhone ?? null,
          lead.email ?? null,
          lead.source,
          lead.sourceDetail ?? null,
          lead.utmSource ?? null,
          lead.utmMedium ?? null,
          lead.utmCampaign ?? null,
          JSON.stringify(lead.attribution ?? {}),
          JSON.stringify(lead.rawPayload ?? {}),
          lead.stage,
          lead.estimatedValueCents ?? null,
          lead.notes ?? null,
          lead.assignedUserId ?? null,
          lead.convertedCustomerId ?? null,
          lead.lostReason ?? null,
          lead.createdBy,
          lead.createdAt,
          lead.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Lead | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        // tenant_id = $1 is the FIRST predicate (defense-in-depth alongside RLS)
        'SELECT * FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByPhoneNormalized(
    tenantId: string,
    phoneNormalized: string
  ): Promise<Lead | null> {
    if (!phoneNormalized) return null;
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM leads
         WHERE tenant_id = $1 AND phone_normalized = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, phoneNormalized]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  private buildListWhere(
    tenantId: string,
    options?: LeadListOptions
  ): { where: string; params: unknown[] } {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (options?.stage) {
      conditions.push(`stage = $${paramIndex}`);
      params.push(options.stage);
      paramIndex++;
    }
    if (options?.source) {
      conditions.push(`source = $${paramIndex}`);
      params.push(options.source);
      paramIndex++;
    }
    if (options?.assignedUserId) {
      conditions.push(`assigned_user_id = $${paramIndex}`);
      params.push(options.assignedUserId);
      paramIndex++;
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  private async queryListRows(
    client: PoolClient,
    tenantId: string,
    options?: LeadListOptions
  ): Promise<Lead[]> {
    const { where, params } = this.buildListWhere(tenantId, options);
    const usePagination = options?.limit !== undefined || options?.offset !== undefined;
    let sql = `SELECT * FROM leads ${where} ORDER BY created_at DESC`;
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

  async findByTenant(tenantId: string, options?: LeadListOptions): Promise<Lead[]> {
    return this.withTenant(tenantId, async (client) => {
      return this.queryListRows(client, tenantId, options);
    });
  }

  async listWithMeta(tenantId: string, options?: LeadListOptions): Promise<LeadListResult> {
    return this.withTenant(tenantId, async (client) => {
      const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const offset = options?.offset ?? 0;
      const data = await this.queryListRows(client, tenantId, { ...options, limit, offset });
      const { where, params } = this.buildListWhere(tenantId, options);
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM leads ${where}`,
        params
      );
      return { data, total: countResult.rows[0].total as number };
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Lead>): Promise<Lead | null> {
    return this.withTenant(tenantId, async (client) => {
      return this.runUpdate(client, tenantId, id, updates);
    });
  }

  /**
   * Update implementation that takes an explicit client — used by
   * `lead-service.convertToCustomer` so the update participates in the
   * caller's transaction (atomic conversion).
   */
  async updateInTransaction(
    client: PoolClient,
    tenantId: string,
    id: string,
    updates: Partial<Lead>
  ): Promise<Lead | null> {
    return this.runUpdate(client, tenantId, id, updates);
  }

  private async runUpdate(
    client: PoolClient,
    tenantId: string,
    id: string,
    updates: Partial<Lead>
  ): Promise<Lead | null> {
    const fieldMap: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      companyName: 'company_name',
      primaryPhone: 'primary_phone',
      email: 'email',
      source: 'source',
      sourceDetail: 'source_detail',
      utmSource: 'utm_source',
      utmMedium: 'utm_medium',
      utmCampaign: 'utm_campaign',
      attribution: 'attribution',
      stage: 'stage',
      estimatedValueCents: 'estimated_value_cents',
      notes: 'notes',
      assignedUserId: 'assigned_user_id',
      convertedCustomerId: 'converted_customer_id',
      lostReason: 'lost_reason',
      preferredLanguage: 'preferred_language',
      updatedAt: 'updated_at',
    };

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const column = fieldMap[key];
      if (column) {
        if (key === 'attribution') {
          setClauses.push(`${column} = $${paramIndex}::jsonb`);
          params.push(JSON.stringify(value ?? {}));
        } else {
          setClauses.push(`${column} = $${paramIndex}`);
          params.push(value === undefined ? null : value);
        }
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      const result = await client.query(
        'SELECT * FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    }

    params.push(tenantId, id);
    const result = await client.query(
      `UPDATE leads SET ${setClauses.join(', ')}
       WHERE tenant_id = $${paramIndex} AND id = $${paramIndex + 1}
       RETURNING *`,
      params
    );
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
  }

  /**
   * Expose `withTenantTransaction` to the service layer so that
   * `convertToCustomer` can wrap multiple writes (customer insert +
   * lead update + audit events) in a single rollback boundary.
   */
  async withTransaction<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    return this.withTenantTransaction(tenantId, fn);
  }
}
