import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Campaign, CampaignRepository, CampaignStatus } from './campaign';

/**
 * MKT (Jobber parity) — Postgres-backed email campaigns.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside FORCE RLS, migration 226).
 */
function mapRow(row: Record<string, unknown>): Campaign {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    subject: row.subject as string,
    bodyText: row.body_text as string,
    bodyHtml: (row.body_html as string | null) ?? null,
    segmentTag: (row.segment_tag as string | null) ?? null,
    status: row.status as CampaignStatus,
    recipientCount: Number(row.recipient_count),
    sentCount: Number(row.sent_count),
    failedCount: Number(row.failed_count),
    createdBy: row.created_by as string,
    sentAt: row.sent_at ? new Date(row.sent_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgCampaignRepository extends PgBaseRepository implements CampaignRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(campaign: Campaign): Promise<Campaign> {
    return this.withTenant(campaign.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO marketing_campaigns (
          id, tenant_id, name, subject, body_text, body_html, segment_tag,
          status, recipient_count, sent_count, failed_count, created_by,
          sent_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          campaign.id,
          campaign.tenantId,
          campaign.name,
          campaign.subject,
          campaign.bodyText,
          campaign.bodyHtml,
          campaign.segmentTag,
          campaign.status,
          campaign.recipientCount,
          campaign.sentCount,
          campaign.failedCount,
          campaign.createdBy,
          campaign.sentAt,
          campaign.createdAt,
          campaign.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Campaign | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM marketing_campaigns WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async list(tenantId: string): Promise<Campaign[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM marketing_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId]
      );
      return result.rows.map(mapRow);
    });
  }

  async update(campaign: Campaign): Promise<Campaign> {
    return this.withTenant(campaign.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE marketing_campaigns
         SET name = $3, subject = $4, body_text = $5, body_html = $6, segment_tag = $7,
             status = $8, recipient_count = $9, sent_count = $10, failed_count = $11,
             sent_at = $12, updated_at = $13
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          campaign.tenantId,
          campaign.id,
          campaign.name,
          campaign.subject,
          campaign.bodyText,
          campaign.bodyHtml,
          campaign.segmentTag,
          campaign.status,
          campaign.recipientCount,
          campaign.sentCount,
          campaign.failedCount,
          campaign.sentAt,
          campaign.updatedAt,
        ]
      );
      if (result.rows.length === 0) throw new Error('Campaign not found');
      return mapRow(result.rows[0]);
    });
  }
}
