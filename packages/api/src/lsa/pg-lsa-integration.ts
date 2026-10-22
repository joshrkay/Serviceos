import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { decrypt, encrypt } from '../integrations/crypto';
import {
  generateLsaWebhookSecret,
  secretHint,
  type LinkLsaInput,
  type LsaDisposition,
  type LsaIntegration,
  type LsaIntegrationRepository,
  type LsaLeadRecord,
  type LsaLeadType,
} from './lsa-integration';

function mapIntegration(row: Record<string, unknown>): LsaIntegration {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    enabled: row.enabled as boolean,
    autoRespond: row.auto_respond as boolean,
    secretHint: row.secret_hint as string,
    accountId: (row.account_id as string | null) ?? undefined,
    linkedBy: row.linked_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapLead(row: Record<string, unknown>): LsaLeadRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    externalLeadId: row.external_lead_id as string,
    leadId: row.lead_id as string,
    leadType: row.lead_type as LsaLeadType,
    receivedAt: new Date(row.received_at as string),
    speedToLeadOutcome: (row.speed_to_lead_outcome as string | null) ?? undefined,
    disposition: (row.disposition as LsaDisposition | null) ?? undefined,
    dispositionReportedAt: row.disposition_reported_at
      ? new Date(row.disposition_reported_at as string)
      : undefined,
  };
}

/**
 * Postgres LSA repository. Runs under the tenant's own RLS context (via
 * PgBaseRepository) both for owner requests and for the unauthenticated
 * webhook, which carries no request transaction.
 */
export class PgLsaIntegrationRepository extends PgBaseRepository implements LsaIntegrationRepository {
  constructor(
    pool: Pool,
    private readonly encryptionKey: string | undefined = process.env.TENANT_ENCRYPTION_KEY,
  ) {
    super(pool);
  }

  private requireKey(): string {
    if (!this.encryptionKey) throw new Error('TENANT_ENCRYPTION_KEY is not configured');
    return this.encryptionKey;
  }

  async get(tenantId: string): Promise<LsaIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM lsa_integrations WHERE tenant_id = $1`, [tenantId]);
      return rows[0] ? mapIntegration(rows[0]) : null;
    });
  }

  async getWebhookSecret(tenantId: string): Promise<string | null> {
    if (!this.encryptionKey) return null;
    const key = this.encryptionKey;
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ webhook_secret_enc: string }>(
        `SELECT webhook_secret_enc FROM lsa_integrations WHERE tenant_id = $1`,
        [tenantId],
      );
      return rows[0] ? decrypt(rows[0].webhook_secret_enc, key) : null;
    });
  }

  async link(input: LinkLsaInput) {
    const secret = generateLsaWebhookSecret();
    const enc = encrypt(secret, this.requireKey());
    const integration = await this.withTenant(input.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO lsa_integrations
           (tenant_id, enabled, webhook_secret_enc, secret_hint, account_id, linked_by)
         VALUES ($1, true, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE
           SET enabled = true,
               webhook_secret_enc = EXCLUDED.webhook_secret_enc,
               secret_hint = EXCLUDED.secret_hint,
               account_id = COALESCE(EXCLUDED.account_id, lsa_integrations.account_id),
               linked_by = EXCLUDED.linked_by,
               updated_at = NOW()
         RETURNING *`,
        [input.tenantId, enc, secretHint(secret), input.accountId ?? null, input.linkedBy],
      );
      return mapIntegration(rows[0]);
    });
    return { integration, webhookSecret: secret };
  }

  async update(
    tenantId: string,
    patch: { enabled?: boolean; autoRespond?: boolean; accountId?: string | null },
  ): Promise<LsaIntegration | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE lsa_integrations
            SET enabled = COALESCE($2::boolean, enabled),
                auto_respond = COALESCE($3::boolean, auto_respond),
                account_id = CASE WHEN $4::boolean THEN $5::text ELSE account_id END,
                updated_at = NOW()
          WHERE tenant_id = $1
          RETURNING *`,
        [
          tenantId,
          patch.enabled ?? null,
          patch.autoRespond ?? null,
          patch.accountId !== undefined,
          patch.accountId ?? null,
        ],
      );
      return rows[0] ? mapIntegration(rows[0]) : null;
    });
  }

  async unlink(tenantId: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query(`DELETE FROM lsa_integrations WHERE tenant_id = $1`, [tenantId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  async recordLead(rec: Omit<LsaLeadRecord, 'id' | 'receivedAt'>) {
    return this.withTenant(rec.tenantId, async (client) => {
      const ins = await client.query(
        `INSERT INTO lsa_leads (tenant_id, external_lead_id, lead_id, lead_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, external_lead_id) DO NOTHING
         RETURNING *`,
        [rec.tenantId, rec.externalLeadId, rec.leadId, rec.leadType],
      );
      if (ins.rows[0]) return { inserted: true, record: mapLead(ins.rows[0]) };
      const { rows } = await client.query(
        `SELECT * FROM lsa_leads WHERE tenant_id = $1 AND external_lead_id = $2`,
        [rec.tenantId, rec.externalLeadId],
      );
      return { inserted: false, record: mapLead(rows[0]) };
    });
  }

  async setSpeedToLeadOutcome(tenantId: string, externalLeadId: string, outcome: string): Promise<void> {
    await this.withTenant(tenantId, (client) =>
      client.query(
        `UPDATE lsa_leads SET speed_to_lead_outcome = $3 WHERE tenant_id = $1 AND external_lead_id = $2`,
        [tenantId, externalLeadId, outcome.slice(0, 200)],
      ),
    );
  }

  async findLeadByLeadId(tenantId: string, leadId: string): Promise<LsaLeadRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM lsa_leads WHERE tenant_id = $1 AND lead_id = $2 ORDER BY received_at DESC LIMIT 1`,
        [tenantId, leadId],
      );
      return rows[0] ? mapLead(rows[0]) : null;
    });
  }

  async markDisposition(
    tenantId: string,
    externalLeadId: string,
    disposition: LsaDisposition,
    reported: boolean,
  ): Promise<void> {
    await this.withTenant(tenantId, (client) =>
      client.query(
        `UPDATE lsa_leads
            SET disposition = $3,
                disposition_reported_at = CASE WHEN $4::boolean THEN NOW() ELSE disposition_reported_at END
          WHERE tenant_id = $1 AND external_lead_id = $2`,
        [tenantId, externalLeadId, disposition, reported],
      ),
    );
  }

  async listRecent(tenantId: string, limit: number): Promise<LsaLeadRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM lsa_leads WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT $2`,
        [tenantId, limit],
      );
      return rows.map(mapLead);
    });
  }
}
