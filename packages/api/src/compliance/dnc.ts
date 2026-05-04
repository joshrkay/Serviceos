import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

/**
 * Normalize a phone number to digits only for DNC comparison.
 *
 * Strips all non-digit characters so E.164 (+15551234567) and local
 * formats (555-123-4567) both reduce to the same key (15551234567 vs
 * 5551234567). The tenant_dnc_list stores phones in this normalized form.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export interface DncCheckResult {
  isOnDnc: boolean;
  phone: string;
}

export interface DncRepository {
  isOnDnc(tenantId: string, normalizedPhone: string): Promise<boolean>;
}

export class PgDncRepository extends PgBaseRepository implements DncRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  /**
   * Check whether `normalizedPhone` appears in the tenant's DNC list.
   *
   * The tenant_dnc_list table stores phones in digits-only form (populated
   * by the add-to-DNC flow which must also call normalizePhone). We do a
   * suffix match on normalizedPhone to tolerate leading country codes:
   * a stored "5551234567" will match an inbound "+15551234567" (normalised
   * to "15551234567") via LIKE '%5551234567'.
   *
   * For an exact-match implementation (when all stored values include
   * country code), replace the LIKE with `phone = $2`.
   */
  async isOnDnc(tenantId: string, normalizedPhone: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM tenant_dnc_list
           WHERE tenant_id = $1
             AND ($2 LIKE '%' || phone OR phone LIKE '%' || $2)
         ) AS exists`,
        [tenantId, normalizedPhone]
      );
      return result.rows[0]?.exists ?? false;
    });
  }
}

export class InMemoryDncRepository implements DncRepository {
  /** phone values stored here should already be normalized */
  private readonly entries: Map<string, Set<string>> = new Map();

  /** Add a phone to the in-memory DNC list (for tests) */
  add(tenantId: string, normalizedPhone: string): void {
    if (!this.entries.has(tenantId)) {
      this.entries.set(tenantId, new Set());
    }
    this.entries.get(tenantId)!.add(normalizedPhone);
  }

  async isOnDnc(tenantId: string, normalizedPhone: string): Promise<boolean> {
    const set = this.entries.get(tenantId);
    if (!set) return false;

    // Suffix match: check if either value ends with the other
    for (const stored of set) {
      if (normalizedPhone.endsWith(stored) || stored.endsWith(normalizedPhone)) {
        return true;
      }
    }
    return false;
  }
}
