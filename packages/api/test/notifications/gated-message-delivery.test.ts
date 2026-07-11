/**
 * WS1 — GatedMessageDelivery matrix. The single consent + DNC gate for
 * outbound SMS: owner bypass, customer allow/block, missing-context fail-closed,
 * warn observability, and off-mode legacy passthrough — plus the suppression
 * audit trail.
 */
import { describe, it, expect } from 'vitest';
import {
  GatedMessageDelivery,
  SmsSuppressedError,
  type SmsEnforcementMode,
} from '../../src/notifications/gated-message-delivery';
import {
  InMemoryDeliveryProvider,
  type SmsMessage,
} from '../../src/notifications/delivery-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLEAN_PHONE = '+15551230000';
const DNC_PHONE = '+15559998888';

function build(enforcement: SmsEnforcementMode, opts: { dncPhone?: string } = {}) {
  const base = new InMemoryDeliveryProvider();
  const dnc = new InMemoryDncRepository();
  const auditRepo = new InMemoryAuditRepository();
  if (opts.dncPhone) dnc.add(TENANT, normalizePhone(opts.dncPhone));
  const gate = new GatedMessageDelivery({ base, dnc, auditRepo, enforcement });
  return { gate, base, dnc, auditRepo };
}

function customerMsg(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    to: CLEAN_PHONE,
    body: 'hi',
    tenantId: TENANT,
    recipientClass: 'customer',
    consent: { smsConsent: true, customerId: 'cust-1' },
    ...over,
  };
}

describe('GatedMessageDelivery — owner bypass', () => {
  it('owner send always goes through, even when the number is on DNC', async () => {
    const { gate, base, auditRepo } = build('block', { dncPhone: DNC_PHONE });
    await gate.sendSms({ to: DNC_PHONE, body: 'digest', tenantId: TENANT, recipientClass: 'owner' });
    expect(base.sentSms).toHaveLength(1);
    expect(auditRepo.getAll()).toHaveLength(0);
  });
});

describe('GatedMessageDelivery — enforcement off', () => {
  it('customer send goes through with no audit, even without consent (not on DNC)', async () => {
    const { gate, base, auditRepo } = build('off');
    await gate.sendSms(customerMsg({ consent: { smsConsent: false } }));
    expect(base.sentSms).toHaveLength(1);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('DNC is a hard floor even in off: a DNC-listed customer is suppressed + audited', async () => {
    // Regression: 'off' must NOT drop the tenant-DNC block the legacy inline
    // gates applied unconditionally. DNC hit → suppress + audit in every mode.
    const { gate, base, auditRepo } = build('off', { dncPhone: DNC_PHONE });
    await expect(
      gate.sendSms(customerMsg({ to: DNC_PHONE })),
    ).rejects.toMatchObject({ reason: 'dnc' });
    expect(base.sentSms).toHaveLength(0);
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('sms.suppressed');
    expect(events[0].metadata?.reason).toBe('dnc');
    // The audit records the real enforcement mode, not one inferred from the event.
    expect(events[0].metadata?.mode).toBe('off');
  });

  it('customer send with no tenantId still sends in off (previously-ungated path, not newly failed)', async () => {
    const { gate, base, auditRepo } = build('off');
    const msg = customerMsg({ consent: { smsConsent: false } });
    delete (msg as { tenantId?: unknown }).tenantId;
    await gate.sendSms(msg);
    expect(base.sentSms).toHaveLength(1);
    expect(auditRepo.getAll()).toHaveLength(0);
  });
});

describe('GatedMessageDelivery — enforcement block', () => {
  it('allows a consented customer on a clean number', async () => {
    const { gate, base, auditRepo } = build('block');
    await gate.sendSms(customerMsg());
    expect(base.sentSms).toHaveLength(1);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('blocks a customer with sms_consent=false (no_consent) and audits', async () => {
    const { gate, base, auditRepo } = build('block');
    await expect(gate.sendSms(customerMsg({ consent: { smsConsent: false } }))).rejects.toBeInstanceOf(
      SmsSuppressedError,
    );
    expect(base.sentSms).toHaveLength(0);
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('sms.suppressed');
    expect(events[0].metadata?.reason).toBe('no_consent');
    expect(events[0].metadata?.phoneLast4).toBe('0000');
  });

  it('blocks a DNC-listed number (dnc) even with consent', async () => {
    const { gate, base, auditRepo } = build('block', { dncPhone: DNC_PHONE });
    await expect(
      gate.sendSms(customerMsg({ to: DNC_PHONE })),
    ).rejects.toMatchObject({ reason: 'dnc' });
    expect(base.sentSms).toHaveLength(0);
    expect(auditRepo.getAll()[0].metadata?.reason).toBe('dnc');
  });

  it('fails closed (missing_consent_context) when a customer send has no consent object', async () => {
    const { gate, base, auditRepo } = build('block');
    const msg = customerMsg();
    delete (msg as { consent?: unknown }).consent;
    await expect(gate.sendSms(msg)).rejects.toMatchObject({ reason: 'missing_consent_context' });
    expect(base.sentSms).toHaveLength(0);
    expect(auditRepo.getAll()[0].metadata?.reason).toBe('missing_consent_context');
  });

  it('fails closed when a customer send carries no tenantId (cannot DNC-check)', async () => {
    const { gate, base } = build('block');
    const msg = customerMsg();
    delete (msg as { tenantId?: unknown }).tenantId;
    await expect(gate.sendSms(msg)).rejects.toMatchObject({ reason: 'missing_consent_context' });
    expect(base.sentSms).toHaveLength(0);
  });
});

describe('GatedMessageDelivery — enforcement warn', () => {
  it('sends a would-block message but audits sms.suppressed-would-block', async () => {
    const { gate, base, auditRepo } = build('warn');
    await gate.sendSms(customerMsg({ consent: { smsConsent: false } }));
    expect(base.sentSms).toHaveLength(1); // still sent
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('sms.suppressed-would-block');
    expect(events[0].metadata?.reason).toBe('no_consent');
    expect(events[0].metadata?.mode).toBe('warn');
  });

  it('sends an allowed message with no audit', async () => {
    const { gate, base, auditRepo } = build('warn');
    await gate.sendSms(customerMsg());
    expect(base.sentSms).toHaveLength(1);
    expect(auditRepo.getAll()).toHaveLength(0);
  });
});

describe('GatedMessageDelivery — email', () => {
  it('delegates sendEmail untouched (no gate)', async () => {
    const { gate, base } = build('block');
    await gate.sendEmail({ to: 'a@b.com', subject: 's', text: 't', tenantId: TENANT });
    expect(base.sentEmails).toHaveLength(1);
  });
});
