// #1564 — Postgres-backed A2pRegistrationStore (`a2p_registrations`,
// migration 303). Tenant-scoped via PgBaseRepository (FORCE RLS).

import { PgBaseRepository } from '../../../db/pg-base';
import type {
  A2pBusinessIndustry,
  A2pBusinessType,
  A2pJobPosition,
  A2pRegistrationProgress,
  A2pRegistrationStatus,
  A2pTwilioRefs,
} from './registration';
import type { A2pRegistrationRecord, A2pRegistrationStore, A2pStoredDetails } from './store';

function mapRow(row: Record<string, unknown>): A2pRegistrationRecord {
  const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
  return {
    tenantId: row.tenant_id as string,
    details: {
      legalBusinessName: row.legal_business_name as string,
      businessType: row.business_type as A2pBusinessType,
      businessIndustry: row.business_industry as A2pBusinessIndustry,
      websiteUrl: (row.website_url as string | null) ?? null,
      address: {
        street: row.street as string,
        street2: (row.street2 as string | null) ?? null,
        city: row.city as string,
        region: row.region as string,
        postalCode: row.postal_code as string,
      },
      contact: {
        firstName: row.contact_first_name as string,
        lastName: row.contact_last_name as string,
        email: row.contact_email as string,
        phone: row.contact_phone as string,
        title: row.contact_title as string,
        jobPosition: row.contact_job_position as A2pJobPosition,
      },
    },
    einEnc: row.ein_enc as string,
    einLast4: row.ein_last4 as string,
    progress: {
      status: row.status as A2pRegistrationStatus,
      refs: (row.twilio_refs as A2pTwilioRefs) ?? {},
      failureReasons: (row.failure_reasons as string[]) ?? [],
    },
    submittedAt: new Date(row.submitted_at as string),
    approvedAt: date(row.approved_at),
    lastCheckedAt: date(row.last_checked_at),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgA2pRegistrationStore extends PgBaseRepository implements A2pRegistrationStore {
  async get(tenantId: string): Promise<A2pRegistrationRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM a2p_registrations WHERE tenant_id = $1`, [tenantId]);
      return rows[0] ? mapRow(rows[0]) : null;
    });
  }

  async saveSubmission(
    tenantId: string,
    input: { details: A2pStoredDetails; einEnc: string; einLast4: string },
  ): Promise<A2pRegistrationRecord> {
    const d = input.details;
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO a2p_registrations (
           tenant_id, legal_business_name, ein_enc, ein_last4, business_type, business_industry,
           website_url, street, street2, city, region, postal_code,
           contact_first_name, contact_last_name, contact_email, contact_phone, contact_title,
           contact_job_position, status, twilio_refs, failure_reasons, submitted_at,
           approved_at, last_checked_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           'submitted', '{}'::jsonb, '[]'::jsonb, NOW(), NULL, NULL, NOW()
         )
         ON CONFLICT (tenant_id) DO UPDATE SET
           legal_business_name = EXCLUDED.legal_business_name,
           ein_enc = EXCLUDED.ein_enc,
           ein_last4 = EXCLUDED.ein_last4,
           business_type = EXCLUDED.business_type,
           business_industry = EXCLUDED.business_industry,
           website_url = EXCLUDED.website_url,
           street = EXCLUDED.street,
           street2 = EXCLUDED.street2,
           city = EXCLUDED.city,
           region = EXCLUDED.region,
           postal_code = EXCLUDED.postal_code,
           contact_first_name = EXCLUDED.contact_first_name,
           contact_last_name = EXCLUDED.contact_last_name,
           contact_email = EXCLUDED.contact_email,
           contact_phone = EXCLUDED.contact_phone,
           contact_title = EXCLUDED.contact_title,
           contact_job_position = EXCLUDED.contact_job_position,
           status = 'submitted',
           twilio_refs = '{}'::jsonb,
           failure_reasons = '[]'::jsonb,
           submitted_at = NOW(),
           approved_at = NULL,
           last_checked_at = NULL,
           updated_at = NOW()
         RETURNING *`,
        [
          tenantId,
          d.legalBusinessName,
          input.einEnc,
          input.einLast4,
          d.businessType,
          d.businessIndustry,
          d.websiteUrl,
          d.address.street,
          d.address.street2,
          d.address.city,
          d.address.region,
          d.address.postalCode,
          d.contact.firstName,
          d.contact.lastName,
          d.contact.email,
          d.contact.phone,
          d.contact.title,
          d.contact.jobPosition,
        ],
      );
      return mapRow(rows[0]);
    });
  }

  async saveProgress(tenantId: string, progress: A2pRegistrationProgress): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE a2p_registrations
            SET status = $2,
                twilio_refs = $3::jsonb,
                failure_reasons = $4::jsonb,
                approved_at = CASE WHEN $2 = 'approved' THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
                last_checked_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1`,
        [tenantId, progress.status, JSON.stringify(progress.refs), JSON.stringify(progress.failureReasons)],
      );
    });
  }
}
