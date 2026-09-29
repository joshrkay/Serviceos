/**
 * #1402 §18 — per-recipient SMS volume cap, enforced in the single gated SMS
 * path on top of consent/DNC. Seam: GatedMessageDelivery.sendSms.
 */
import { describe, it, expect } from 'vitest';
import {
  GatedMessageDelivery,
  SmsSuppressedError,
  type SmsEnforcementMode,
} from '../../src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider, type SmsMessage } from '../../src/notifications/delivery-provider';
import { InMemoryRecipientSmsVolumeLedger } from '../../src/notifications/recipient-sms-volume';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PHONE = '+15551230000';

function build(opts: { cap: number; windowHours?: number; enforcement?: SmsEnforcementMode }) {
  const base = new InMemoryDeliveryProvider();
  const auditRepo = new InMemoryAuditRepository();
  const ledger = new InMemoryRecipientSmsVolumeLedger();
  const gate = new GatedMessageDelivery({
    base,
    dnc: new InMemoryDncRepository(),
    auditRepo,
    enforcement: opts.enforcement ?? 'block',
    recipientVolumeCap: { ledger, maxPerWindow: opts.cap, windowHours: opts.windowHours ?? 24 },
  });
  return { gate, base, auditRepo, ledger };
}

function customerMsg(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    to: PHONE,
    body: 'Your appointment is confirmed',
    tenantId: TENANT,
    recipientClass: 'customer',
    consent: { smsConsent: true, customerId: 'cust-1' },
    ...over,
  };
}

describe('GatedMessageDelivery — per-recipient SMS volume cap (#1402 §18)', () => {
  it('sends up to the cap, then suppresses the next customer text to that number', async () => {
    const { gate, base } = build({ cap: 3 });

    for (let i = 0; i < 3; i += 1) await gate.sendSms(customerMsg());
    const fourth = gate.sendSms(customerMsg());

    await expect(fourth).rejects.toBeInstanceOf(SmsSuppressedError);
    await expect(fourth).rejects.toMatchObject({ reason: 'recipient_volume_cap' });
    expect(base.sentSms).toHaveLength(3);
  });

  it('audits every capped send (never a silent drop), with only the last 4 digits', async () => {
    const { gate, auditRepo } = build({ cap: 1 });
    await gate.sendSms(customerMsg());

    await expect(gate.sendSms(customerMsg())).rejects.toBeInstanceOf(SmsSuppressedError);

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT,
      eventType: 'sms.suppressed',
      entityId: 'cust-1',
      metadata: {
        reason: 'recipient_volume_cap',
        phoneLast4: '0000',
        maxPerWindow: 1,
        windowHours: 24,
      },
    });
    expect(JSON.stringify(events[0])).not.toContain('5551230000');
  });

  it('a send the carrier rejects does not use up the recipient’s allowance', async () => {
    const { gate, base } = build({ cap: 1 });
    const realSend = base.sendSms.bind(base);
    base.sendSms = async () => {
      throw new Error('carrier 500');
    };
    await expect(gate.sendSms(customerMsg())).rejects.toThrow('carrier 500');
    base.sendSms = realSend;

    await gate.sendSms(customerMsg());

    expect(base.sentSms).toHaveLength(1);
  });

  it('never caps owner-class sends (E1 emergency pages, digests, approval links)', async () => {
    const { gate, base } = build({ cap: 1 });
    await gate.sendSms(customerMsg());

    for (let i = 0; i < 5; i += 1) {
      await gate.sendSms({ to: PHONE, body: 'EMERGENCY: gas leak reported', tenantId: TENANT, recipientClass: 'owner' });
    }

    expect(base.sentSms).toHaveLength(6);
  });

  it('counts per number and per tenant: another number, or another tenant, is unaffected', async () => {
    const { gate, base } = build({ cap: 1 });
    await gate.sendSms(customerMsg());

    await gate.sendSms(customerMsg({ to: '+15557654321' }));
    await gate.sendSms(customerMsg({ tenantId: '22222222-2222-2222-2222-222222222222' }));

    expect(base.sentSms).toHaveLength(3);
  });

  it('is a rolling window: once the oldest send ages out, the number can be texted again', async () => {
    let now = new Date('2026-09-28T12:00:00Z');
    const base = new InMemoryDeliveryProvider();
    const gate = new GatedMessageDelivery({
      base,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
      recipientVolumeCap: {
        ledger: new InMemoryRecipientSmsVolumeLedger(() => now),
        maxPerWindow: 1,
        windowHours: 24,
      },
    });
    await gate.sendSms(customerMsg());

    now = new Date('2026-09-29T11:59:00Z');
    await expect(gate.sendSms(customerMsg())).rejects.toMatchObject({ reason: 'recipient_volume_cap' });
    now = new Date('2026-09-29T12:01:00Z');
    await gate.sendSms(customerMsg());

    expect(base.sentSms).toHaveLength(2);
  });

  it.each<SmsEnforcementMode>(['off', 'warn'])(
    'still caps in consent-enforcement mode %s (it is a volume control, not a consent check)',
    async (enforcement) => {
      const { gate, base } = build({ cap: 1, enforcement });
      await gate.sendSms(customerMsg());

      await expect(gate.sendSms(customerMsg())).rejects.toMatchObject({ reason: 'recipient_volume_cap' });
      expect(base.sentSms).toHaveLength(1);
    },
  );

  it('a cap of 0 disables the control', async () => {
    const { gate, base } = build({ cap: 0 });
    for (let i = 0; i < 4; i += 1) await gate.sendSms(customerMsg());
    expect(base.sentSms).toHaveLength(4);
  });
});
