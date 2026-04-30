import type { Pool } from 'pg';

export interface IdentifyCallerInput {
  tenantId: string;
  /** Raw phone number as received from Twilio (e.g. '+15125550100' or '5125550100') */
  fromPhone: string;
  pool: Pool;
}

export type IdentifyCallerResult =
  | { status: 'matched'; customerId: string; customerName: string; displayName: string }
  | { status: 'multiple'; candidates: Array<{ customerId: string; customerName: string }> }
  | { status: 'unknown' };

/** Strip all non-digit characters. Used for index lookup. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  // Strip leading 1 from 11-digit numbers (North American +1 country code)
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

export async function identifyCaller(input: IdentifyCallerInput): Promise<IdentifyCallerResult> {
  const { tenantId, fromPhone, pool } = input;

  const normalized = normalizePhone(fromPhone);

  // Empty or suspiciously short phone — return unknown without querying
  if (normalized.length < 7) {
    return { status: 'unknown' };
  }

  const result = await pool.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM customers WHERE tenant_id = $1 AND phone_normalized = $2',
    [tenantId, normalized]
  );

  if (result.rows.length === 0) {
    return { status: 'unknown' };
  }

  if (result.rows.length === 1) {
    const row = result.rows[0];
    return {
      status: 'matched',
      customerId: row.id,
      customerName: row.display_name,
      displayName: row.display_name,
    };
  }

  // Multiple matches
  return {
    status: 'multiple',
    candidates: result.rows.map((row) => ({
      customerId: row.id,
      customerName: row.display_name,
    })),
  };
}
