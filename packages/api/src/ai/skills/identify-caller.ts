import type { Pool } from 'pg';
import { normalizePhone } from '../../shared/phone';

export { normalizePhone };

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

export async function identifyCaller(input: IdentifyCallerInput): Promise<IdentifyCallerResult> {
  const { tenantId, fromPhone, pool } = input;

  const normalized = normalizePhone(fromPhone);

  // Empty or suspiciously short phone — return unknown without querying
  if (normalized.length < 7) {
    return { status: 'unknown' };
  }

  // The `customers.phone_normalized` generated column (migration
  // 053_p8_customers_phone_index) is `regexp_replace(primary_phone,
  // '[^0-9]', '', 'g')` — it strips punctuation but KEEPS the leading
  // country-code 1, so a customer saved as "+15125550111" stores
  // "15125550111" while one saved as "5125550111" stores "5125550111".
  // `normalizePhone` above drops the leading 1 (10-digit bare key), so a
  // plain `phone_normalized = $2` equality misses every +1 E.164
  // customer. Match on the trailing-10 digits from BOTH sides so the two
  // conventions reconcile, mirroring the proven predicate in
  // PgCustomerRepository.findByPhoneNormalized. The `length >= 7` floor
  // avoids the empty-suffix `LIKE '%'` over-match; tenant_id stays the
  // first predicate and the query still targets the indexed column.
  const tail = normalized.slice(-10);
  const result = await pool.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM customers
      WHERE tenant_id = $1
        AND phone_normalized IS NOT NULL
        AND length(phone_normalized) >= 7
        AND (right(phone_normalized, 10) = $2 OR $2 LIKE '%' || phone_normalized)`,
    [tenantId, tail]
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
