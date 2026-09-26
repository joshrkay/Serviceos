import type { Pool } from 'pg';

/** Weekday 08:00–17:00, the provisioning CLI's starting business hours. */
const PROVISION_BUSINESS_HOURS = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
};

/**
 * Step 2 of `provision-tenant.ts` — business identity (mirrors PUT
 * /api/onboarding/identity). Extracted so the write is testable against
 * real Postgres.
 *
 * #1201 — no job buffer is written: the CLI never asks for one, and NULL
 * means "not configured" (migration 277; readers apply the 30-minute
 * default). A re-run leaves any buffer the tenant has since chosen alone.
 */
export async function seedProvisionIdentity(
  pool: Pool,
  tenantId: string,
  businessName: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (
       id, tenant_id, business_name, business_hours, hourly_rate_cents,
       timezone, estimate_prefix, invoice_prefix, next_estimate_number,
       next_invoice_number, default_payment_term_days
     )
     VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4,
             'America/New_York', 'EST-', 'INV-', 1001, 1001, 30)
     ON CONFLICT (tenant_id) DO UPDATE SET
       business_name      = EXCLUDED.business_name,
       business_hours     = EXCLUDED.business_hours,
       hourly_rate_cents  = EXCLUDED.hourly_rate_cents,
       updated_at         = now()`,
    [tenantId, businessName, JSON.stringify(PROVISION_BUSINESS_HOURS), 12500],
  );
}
