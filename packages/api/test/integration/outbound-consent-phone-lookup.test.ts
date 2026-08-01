/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration` (or an
 * EXTERNAL_TEST_DB_URL with the full schema applied).
 *
 * PR #664 finding B — checkOutboundConsent phone-normalization mismatch.
 *
 * FK-PATH-COVERAGE: src/voice/outbound-consent.ts
 *
 * `customers.phone_normalized` (migration 053) is
 * `regexp_replace(primary_phone, '[^0-9]', '', 'g')` — digits only, KEEPING
 * the leading country-code 1, so a customer saved as "+15551112222" stores
 * "15551112222". The gate previously looked up consent with
 * `phone_normalized = $2` while callers pass the E.164 DISPLAY form
 * ("+15551112222"). That equality NEVER matched a +1 customer: a
 * `consent_status = 'granted'` customer was reported `customer_not_found`
 * and (in block mode) the outbound call was false-refused.
 *
 * The unit suite mocks the pg client, so the real predicate was never
 * exercised — exactly why this class of bug survives mocked tests. These
 * tests pin the REAL query against a REAL generated column:
 *
 *   1. A granted customer stored in E.164 form ("+15551112222") is FOUND
 *      and the call is ALLOWED.
 *   2. A granted customer stored WITHOUT the country code ("(555) 111-3333")
 *      is also FOUND (the digit-convention reconciliation is symmetric).
 *   3. A revoked customer stored in E.164 form is FOUND and REFUSED with the
 *      correct reason (proves we didn't turn the lookup into an allow-all).
 *   4. A genuinely unknown number still fails closed (customer_not_found).
 *   5. The E.164 format gate is preserved — a malformed number is rejected
 *      before any DB hop.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  type TestTenant,
} from './shared';
import { checkOutboundConsent } from '../../src/voice/outbound-consent';

const ACTOR = { actorId: 'voice-worker-1', actorRole: 'system' as const };

async function insertCustomer(
  pool: Pool,
  tenantId: string,
  primaryPhone: string,
  consentStatus: 'not_requested' | 'granted' | 'revoked' | 'expired',
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, primary_phone, consent_status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, tenantId, 'Consent Test Customer', primaryPhone, consentStatus, 'test'],
  );
  return id;
}

describe('Postgres integration — checkOutboundConsent phone lookup (PR #664 finding B)', () => {
  let pool: Pool;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.query('DELETE FROM customers WHERE tenant_id = $1', [tenant.tenantId]);
    await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [tenant.tenantId]);
    await closeSharedTestDb();
  });

  it('FINDS a granted customer stored in E.164 form and ALLOWS the call', async () => {
    // phone_normalized => "15551112222"; caller passes the E.164 display form.
    await insertCustomer(pool, tenant.tenantId, '+15551112222', 'granted');

    const res = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: '+15551112222', ...ACTOR },
    );

    expect(res.allowed).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it('FINDS a granted customer stored WITHOUT country code (symmetric reconciliation)', async () => {
    // phone_normalized => "5551113333"; caller still passes +1 E.164.
    await insertCustomer(pool, tenant.tenantId, '(555) 111-3333', 'granted');

    const res = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: '+15551113333', ...ACTOR },
    );

    expect(res.allowed).toBe(true);
  });

  it('FINDS a revoked customer (E.164 form) and REFUSES — lookup is not allow-all', async () => {
    await insertCustomer(pool, tenant.tenantId, '+15551114444', 'revoked');

    const res = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: '+15551114444', ...ACTOR },
    );

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('consent_revoked');
  });

  it('still fails closed for a genuinely unknown number', async () => {
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: '+15559998888', ...ACTOR },
    );

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('customer_not_found');
  });

  it('preserves the E.164 format gate (malformed rejected before any lookup)', async () => {
    const res = await checkOutboundConsent(
      { pool },
      { tenantId: tenant.tenantId, phoneE164: 'not a number', ...ACTOR },
    );

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('malformed');
  });
});
