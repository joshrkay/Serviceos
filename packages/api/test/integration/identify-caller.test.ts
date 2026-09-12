/**
 * Postgres integration — identifyCaller against the real generated
 * `customers.phone_normalized` column.
 *
 * The unit tests for identifyCaller mock the pg Pool, so they never
 * exercised the divergence between the app-side `normalizePhone` (which
 * strips the leading country-code 1, producing a 10-digit bare key) and
 * the generated column `regexp_replace(primary_phone, '[^0-9]', '', 'g')`
 * (migration 053_p8_customers_phone_index) which KEEPS the leading 1.
 * A customer saved in +1 E.164 form (`+15125550111`) therefore stored
 * `15125550111` and was invisible to a plain `phone_normalized = $2`
 * equality lookup — every such caller was treated as unknown.
 *
 * This test inserts real rows and drives the real SQL to prove the
 * generated column and the lookup now agree for BOTH storage forms.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { identifyCaller } from '../../src/ai/skills/identify-caller';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';

async function insertCustomer(
  pool: Pool,
  tenantId: string,
  userId: string,
  displayName: string,
  primaryPhone: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, primary_phone, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, tenantId, displayName, 'Test', displayName, primaryPhone, userId],
  );
  return id;
}

describe('Postgres integration — identifyCaller phone_normalized reconciliation', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    // Clean up the customer rows this suite inserted so a re-run against the
    // same DB (EXTERNAL_TEST_DB_URL / shared container) starts clean — mirrors
    // voice-proposal-ai-run-fk.test.ts.
    await pool.query('DELETE FROM customers WHERE tenant_id = $1', [tenant.tenantId]);
    await closeSharedTestDb();
  });

  it('matches a customer stored in +1 E.164 form (generated column keeps the leading 1)', async () => {
    const id = await insertCustomer(
      pool,
      tenant.tenantId,
      tenant.userId,
      'E164 Ellen',
      '+15125550111',
    );

    // Sanity: the generated column really does keep the leading 1.
    const col = await pool.query<{ phone_normalized: string }>(
      'SELECT phone_normalized FROM customers WHERE id = $1',
      [id],
    );
    expect(col.rows[0].phone_normalized).toBe('15125550111');

    // Inbound caller-ID arrives from Twilio as +1 E.164.
    const result = await identifyCaller({
      tenantId: tenant.tenantId,
      fromPhone: '+15125550111',
      pool,
    });

    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.customerId).toBe(id);
      expect(result.displayName).toBe('E164 Ellen');
    }
  });

  it('still matches a customer stored in bare 10-digit form', async () => {
    const id = await insertCustomer(
      pool,
      tenant.tenantId,
      tenant.userId,
      'TenDigit Tom',
      '5125550222',
    );

    const col = await pool.query<{ phone_normalized: string }>(
      'SELECT phone_normalized FROM customers WHERE id = $1',
      [id],
    );
    expect(col.rows[0].phone_normalized).toBe('5125550222');

    const result = await identifyCaller({
      tenantId: tenant.tenantId,
      fromPhone: '+15125550222',
      pool,
    });

    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.customerId).toBe(id);
    }
  });

  it('returns unknown for a caller with no stored customer', async () => {
    const result = await identifyCaller({
      tenantId: tenant.tenantId,
      fromPhone: '+15125559999',
      pool,
    });
    expect(result).toEqual({ status: 'unknown' });
  });

  it('does NOT match a US customer when a non-NANP international caller shares the last 10 digits', async () => {
    // A US customer stored as the bare 10-digit form `5125550777` (valid NANP).
    const usId = await insertCustomer(
      pool,
      tenant.tenantId,
      tenant.userId,
      'Collision US',
      '5125550777',
    );
    const col = await pool.query<{ phone_normalized: string }>(
      'SELECT phone_normalized FROM customers WHERE id = $1',
      [usId],
    );
    expect(col.rows[0].phone_normalized).toBe('5125550777');

    // A non-NANP international caller `+445125550777` whose trailing 10 digits
    // (`5125550777`) collide with the US customer. It must NOT attach.
    const result = await identifyCaller({
      tenantId: tenant.tenantId,
      fromPhone: '+445125550777',
      pool,
    });
    expect(result).toEqual({ status: 'unknown' });

    // Control: the same US customer is still reachable by its real NANP caller-ID.
    const nanp = await identifyCaller({
      tenantId: tenant.tenantId,
      fromPhone: '5125550777',
      pool,
    });
    expect(nanp.status).toBe('matched');
    if (nanp.status === 'matched') expect(nanp.customerId).toBe(usId);
  });
});

/**
 * #1014 row 2.3 — the voice UNKNOWN → LEAD leg at real Postgres. Only the SMS
 * caller path (`inbound-sms-capture.test.ts`) had this proven.
 *
 * Review finding (xhawk-ai, PR #1043): the original version of this block
 * called `findOrCreateLeadByPhone` directly — it would keep passing even if
 * the voice adapter's unknown-caller branch (twilio-adapter.ts) stopped
 * calling that skill, stopped passing `auditRepo`, or were constructed
 * without `leadRepo`. That WIRING is exactly what this row is supposed to
 * prove. Fixed: drives the real `TwilioGatherAdapter.handleInbound` (the
 * same production entry Twilio's POST /voice route calls), with
 * `leadRepo`/`auditRepo` wired, for a phone `identifyCaller` cannot match —
 * the lead + `lead.created` audit row are then read back from Postgres.
 */
describe('Postgres integration — voice unknown-caller lead capture (findOrCreateLeadByPhone)', () => {
  let pool: Pool;
  let leadRepo: PgLeadRepository;
  let auditRepo: PgAuditRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    leadRepo = new PgLeadRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM leads WHERE tenant_id = ANY($1)', [
      [tenantA.tenantId, tenantB.tenantId],
    ]);
    await closeSharedTestDb();
  });

  /** Drives the real production inbound-call establishment path. */
  async function driveInboundCall(tenantId: string, callSid: string, fromPhone: string): Promise<void> {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: { complete: vi.fn() } as never,
      pool,
      leadRepo,
      auditRepo,
      businessName: 'Test Co',
    });
    await adapter.handleInbound({ callSid, from: fromPhone, to: '+15125550000', tenantId });
  }

  it('a stranger calling in creates a real lead row and an audited lead.created event', async () => {
    const strangerPhone = '+15125550301';

    await driveInboundCall(tenantA.tenantId, 'CA-unknown-lead-1', strangerPhone);

    // The row is real — read it back straight from Postgres.
    const persisted = await leadRepo.findByPhoneNormalized(tenantA.tenantId, '5125550301');
    expect(persisted).not.toBeNull();
    expect(persisted?.source).toBe('phone_call');

    // The audit leg — read back through PgAuditRepository.
    const events = await auditRepo.findByEntity(tenantA.tenantId, 'lead', persisted!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      eventType: 'lead.created',
      entityType: 'lead',
      entityId: persisted!.id,
    });
  });

  it('a repeat call from the same unknown number reuses the lead instead of duplicating it', async () => {
    const strangerPhone = '+15125550302';

    await driveInboundCall(tenantA.tenantId, 'CA-unknown-lead-2a', strangerPhone);
    const first = await leadRepo.findByPhoneNormalized(tenantA.tenantId, '5125550302');
    expect(first).not.toBeNull();

    await driveInboundCall(tenantA.tenantId, 'CA-unknown-lead-2b', strangerPhone);

    // Only ONE lead row and ONE audit event exist for this phone — the
    // second inbound call did not re-create or re-audit.
    const rows = await pool.query('SELECT id FROM leads WHERE tenant_id = $1 AND phone_normalized = $2', [
      tenantA.tenantId,
      '5125550302',
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(first!.id);
    const events = await auditRepo.findByEntity(tenantA.tenantId, 'lead', first!.id);
    expect(events).toHaveLength(1);
  });

  it("T1: a number known to tenant B (an existing customer) is still a STRANGER to tenant A", async () => {
    const sharedPhone = '+15125550303';

    // Tenant B already knows this caller as a customer.
    const customerId = await insertCustomer(
      pool,
      tenantB.tenantId,
      tenantB.userId,
      'Known To B',
      sharedPhone,
    );
    const bIdentify = await identifyCaller({
      tenantId: tenantB.tenantId,
      fromPhone: sharedPhone,
      pool,
    });
    expect(bIdentify.status).toBe('matched');
    if (bIdentify.status === 'matched') expect(bIdentify.customerId).toBe(customerId);

    // Tenant A has never seen this number — the real inbound-call path must
    // create a LEAD for tenant A rather than silently resolving tenant B's
    // customer.
    await driveInboundCall(tenantA.tenantId, 'CA-unknown-lead-t1', sharedPhone);

    // Tenant A's lead never leaks into tenant B's leads, and tenant B's
    // customer is never visible as a lead under tenant A.
    const tenantALead = await leadRepo.findByPhoneNormalized(tenantA.tenantId, '5125550303');
    expect(tenantALead).not.toBeNull();
    const tenantBLead = await leadRepo.findByPhoneNormalized(tenantB.tenantId, '5125550303');
    expect(tenantBLead).toBeNull();
  });
});
