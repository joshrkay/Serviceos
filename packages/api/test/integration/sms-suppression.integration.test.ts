/**
 * WS1 — SMS suppression, end to end against real Postgres.
 *
 * Proves the single consent + DNC gate (GatedMessageDelivery) suppresses a
 * customer SMS using a REAL PgDncRepository row and writes a REAL audit_events
 * row — the two DB-touching behaviors a mocked-Pool unit test can't pin (per
 * CLAUDE.md: "Tests that mock the DB are never the only proof a query works").
 *
 * Runs under the default (role-off) integration run and under
 * `npm run test:integration:rls` (RLS_RUNTIME_ROLE=true) — the DNC add and
 * audit insert both go through withTenant, so they exercise the RLS policies
 * on tenant_dnc_list + audit_events when the role is on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  GatedMessageDelivery,
  SmsSuppressedError,
} from '../../src/notifications/gated-message-delivery';
import type {
  DeliveryResult,
  EmailMessage,
  MessageDeliveryProvider,
  SmsMessage,
} from '../../src/notifications/delivery-provider';

/** Base provider that records what would have been sent (no bytes leave). */
class RecordingBase implements MessageDeliveryProvider {
  readonly sent: SmsMessage[] = [];
  async sendSms(m: SmsMessage): Promise<DeliveryResult> {
    this.sent.push(m);
    return { providerMessageId: 'rec-sms', provider: 'recording', channel: 'sms' };
  }
  async sendEmail(_m: EmailMessage): Promise<DeliveryResult> {
    return { providerMessageId: 'rec-email', provider: 'recording', channel: 'email' };
  }
}

const DNC_PHONE = '+15557770000';

describe('WS1 SMS suppression (real DNC row + real audit event)', () => {
  let pool: Pool;
  let dnc: PgDncRepository;
  let audit: PgAuditRepository;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    dnc = new PgDncRepository(pool);
    audit = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    // Real DNC row (goes through withTenant → RLS policy when the role is on).
    await dnc.addToDnc(tenant.tenantId, normalizePhone(DNC_PHONE), 'test');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function gate(base: RecordingBase): GatedMessageDelivery {
    return new GatedMessageDelivery({ base, dnc, auditRepo: audit, enforcement: 'block' });
  }

  async function suppressionRows(reason: string): Promise<Array<Record<string, unknown>>> {
    const res = await pool.query(
      `SELECT metadata FROM audit_events
       WHERE tenant_id = $1 AND event_type = 'sms.suppressed' AND metadata->>'reason' = $2`,
      [tenant.tenantId, reason],
    );
    return res.rows.map((r) => r.metadata as Record<string, unknown>);
  }

  it('blocks a DNC-listed customer number and writes a real sms.suppressed/dnc audit row', async () => {
    const base = new RecordingBase();
    await expect(
      gate(base).sendSms({
        to: DNC_PHONE,
        body: 'hi',
        tenantId: tenant.tenantId,
        recipientClass: 'customer',
        consent: { smsConsent: true, customerId: 'cust-dnc' },
      }),
    ).rejects.toBeInstanceOf(SmsSuppressedError);

    expect(base.sent).toHaveLength(0);

    const rows = await suppressionRows('dnc');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].phoneLast4).toBe('0000');
    expect(rows[0].recipientClass).toBe('customer');
  });

  it('blocks a no-consent customer and writes a real sms.suppressed/no_consent audit row', async () => {
    const base = new RecordingBase();
    await expect(
      gate(base).sendSms({
        to: '+15551119999',
        body: 'hi',
        tenantId: tenant.tenantId,
        recipientClass: 'customer',
        consent: { smsConsent: false },
      }),
    ).rejects.toMatchObject({ reason: 'no_consent' });

    expect(base.sent).toHaveLength(0);
    expect(await suppressionRows('no_consent')).not.toHaveLength(0);
  });

  it('allows a consented customer on a clean number (real DNC lookup returns false)', async () => {
    const base = new RecordingBase();
    await gate(base).sendSms({
      to: '+15552223333',
      body: 'hi',
      tenantId: tenant.tenantId,
      recipientClass: 'customer',
      consent: { smsConsent: true, customerId: 'cust-ok' },
    });
    expect(base.sent).toHaveLength(1);
  });
});
