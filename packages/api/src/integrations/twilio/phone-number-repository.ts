/**
 * PhoneNumberRepository — maps an inbound Twilio "To" number to the tenant
 * that owns it.
 *
 * Backed by `tenant_integrations.provider_data->>'phoneE164'` (populated by
 * the Twilio provisioning worker). There is intentionally no dedicated
 * `phone_numbers` table at this time; the integration row IS the source of
 * truth for "which tenant owns this number".
 *
 * Cross-tenant note (D2-3):
 *   `findByNumber` is a **system-level / cross-tenant** lookup. Inbound
 *   Twilio webhooks arrive without a tenant context — we only know the
 *   dialed number — so we MUST look across all tenants. This deviates
 *   from `repository-conventions.md` which mandates `withTenant()` on
 *   every read; the lookup is documented here and uses `withClient()`
 *   plus the `app.system_lookup = 'true'` GUC to satisfy migration
 *   074's permissive RLS policy on `tenant_integrations`.
 */

import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';

export interface PhoneNumberLookup {
  tenantId: string;
}

export interface PhoneNumberRepository {
  /**
   * Look up which tenant owns the given E.164 phone number.
   *
   * Cross-tenant by design — see file header. Returns `null` when no
   * tenant claims the number (misconfigured DID or stale port).
   *
   * @param phoneNumber E.164-formatted string (e.g. "+15125550100").
   */
  findByNumber(phoneNumber: string): Promise<PhoneNumberLookup | null>;
}

/**
 * Normalize a Twilio-supplied "To" / "From" value to E.164. Twilio already
 * delivers E.164 in the standard inbound payload, but defensive trimming
 * + a leading '+' guarantee guards against accidental whitespace or a
 * future webhook variant that drops the '+'.
 */
export function normalizeE164(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('+')) return trimmed;
  return `+${trimmed.replace(/^\+*/, '')}`;
}

export class PgPhoneNumberRepository
  extends PgBaseRepository
  implements PhoneNumberRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async findByNumber(phoneNumber: string): Promise<PhoneNumberLookup | null> {
    const normalized = normalizeE164(phoneNumber);
    if (!normalized) return null;

    // Cross-tenant lookup — see file header. We set
    // `app.system_lookup = 'true'` LOCAL so migration 074's permissive
    // RLS policy on tenant_integrations allows the SELECT. The GUC is
    // scoped to this transaction only (the BEGIN/COMMIT bracket), so it
    // cannot leak to other connections in the pool.
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.system_lookup', 'true', true)");
        const { rows } = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM tenant_integrations
           WHERE provider = 'twilio'
             AND provider_data->>'phoneE164' = $1
           LIMIT 1`,
          [normalized],
        );
        await client.query('COMMIT');
        const row = rows[0];
        return row ? { tenantId: row.tenant_id } : null;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }
}

/**
 * In-memory implementation for dev/test (no `DATABASE_URL`) and unit tests.
 * Seed via the constructor map: `{ '+15125550100': 'tenant-abc', ... }`.
 */
export class InMemoryPhoneNumberRepository implements PhoneNumberRepository {
  private readonly numbers: Map<string, string>;

  constructor(seed: Record<string, string> = {}) {
    this.numbers = new Map(
      Object.entries(seed).map(([k, v]) => [normalizeE164(k), v]),
    );
  }

  async findByNumber(phoneNumber: string): Promise<PhoneNumberLookup | null> {
    const tenantId = this.numbers.get(normalizeE164(phoneNumber));
    return tenantId ? { tenantId } : null;
  }

  /** Test helper — register a number → tenant mapping at runtime. */
  set(phoneNumber: string, tenantId: string): void {
    this.numbers.set(normalizeE164(phoneNumber), tenantId);
  }
}
