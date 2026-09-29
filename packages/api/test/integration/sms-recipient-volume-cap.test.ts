/**
 * #1402 §18 — the per-recipient SMS volume cap at real Postgres
 * (`sms_recipient_sends`, migration 300).
 *
 * Seam: GatedMessageDelivery.sendSms over PgRecipientSmsVolumeLedger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider, type SmsMessage } from '../../src/notifications/delivery-provider';
import { PgRecipientSmsVolumeLedger } from '../../src/notifications/recipient-sms-volume';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';

describe('Postgres integration — per-recipient SMS volume cap (#1402 §18)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function gateWith(maxPerWindow: number) {
    const base = new InMemoryDeliveryProvider();
    const gate = new GatedMessageDelivery({
      base,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
      recipientVolumeCap: {
        ledger: new PgRecipientSmsVolumeLedger(pool),
        maxPerWindow,
        windowHours: 24,
      },
    });
    return { gate, base };
  }

  function msg(tenantId: string, to = '+15551230000'): SmsMessage {
    return {
      to,
      body: 'Your tech is on the way',
      tenantId,
      recipientClass: 'customer',
      consent: { smsConsent: true, customerId: 'cust-1' },
    };
  }

  it('sends up to the cap, then suppresses', async () => {
    const { tenantId } = await createTestTenant(pool);
    const { gate, base } = gateWith(2);

    await gate.sendSms(msg(tenantId));
    await gate.sendSms(msg(tenantId));
    await expect(gate.sendSms(msg(tenantId))).rejects.toMatchObject({
      reason: 'recipient_volume_cap',
    });

    expect(base.sentSms).toHaveLength(2);
  });

  it('concurrent sends can never overshoot the last slot', async () => {
    const { tenantId } = await createTestTenant(pool);
    const { gate, base } = gateWith(1);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => gate.sendSms(msg(tenantId))),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(base.sentSms).toHaveLength(1);
  });

  it('only sends inside the rolling window count', async () => {
    const { tenantId } = await createTestTenant(pool);
    const { gate, base } = gateWith(1);
    await gate.sendSms(msg(tenantId));
    // Age the recorded send past the 24h window.
    await pool.query(
      `UPDATE sms_recipient_sends SET sent_at = NOW() - INTERVAL '25 hours' WHERE tenant_id = $1`,
      [tenantId],
    );

    await gate.sendSms(msg(tenantId));

    expect(base.sentSms).toHaveLength(2);
  });

  it('a failed carrier send gives the slot back', async () => {
    const { tenantId } = await createTestTenant(pool);
    const { gate, base } = gateWith(1);
    const realSend = base.sendSms.bind(base);
    base.sendSms = async () => {
      throw new Error('carrier 500');
    };
    await expect(gate.sendSms(msg(tenantId))).rejects.toThrow('carrier 500');
    base.sendSms = realSend;

    await gate.sendSms(msg(tenantId));

    expect(base.sentSms).toHaveLength(1);
  });

  it('tenants are isolated: one tenant’s volume never caps another’s', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const { gate, base } = gateWith(1);

    await gate.sendSms(msg(a.tenantId));
    await gate.sendSms(msg(b.tenantId));

    expect(base.sentSms).toHaveLength(2);
  });
});
