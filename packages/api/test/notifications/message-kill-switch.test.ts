/**
 * Runtime outbound kill switch — per-channel, enforced at the single
 * GatedMessageDelivery chokepoint.
 *
 * The bar these tests hold:
 *   - TELEPHONY_ENABLED=false stops SMS and ONLY SMS; EMAIL_ENABLED=false
 *     stops email and ONLY email.
 *   - An owner-class SMS is stopped too. The consent gate deliberately lets
 *     owner sends bypass; the kill switch deliberately does not. This is the
 *     regression guard for that carve-out.
 *   - Unset flags behave exactly as before the switch existed, so dev/QA/test
 *     are untouched.
 *   - Suppression is OBSERVABLE (greppable reason + redacted recipient +
 *     counter), because a disabled channel must not look like zero traffic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GatedMessageDelivery,
  EmailSuppressedError,
  SmsSuppressedError,
  isOutboundChannelEnabled,
} from '../../src/notifications/gated-message-delivery';
import {
  InMemoryDeliveryProvider,
  type EmailMessage,
  type SmsMessage,
} from '../../src/notifications/delivery-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PHONE = '+15551230000';
const DNC_PHONE = '+15559998888';
const EMAIL = 'owner@acmehvac.com';

interface CapturedLog {
  message: string;
  meta?: Record<string, unknown>;
}

function build(env: NodeJS.ProcessEnv, opts: { dncPhone?: string } = {}) {
  // `true` = allowInProduction. This is a test double, and the shells this
  // suite runs in can carry NODE_ENV=production, which the provider otherwise
  // refuses (the same reason gated-message-delivery.test.ts fails there).
  const base = new InMemoryDeliveryProvider(true);
  const dnc = new InMemoryDncRepository();
  const auditRepo = new InMemoryAuditRepository();
  const logs: CapturedLog[] = [];
  if (opts.dncPhone) dnc.add(TENANT, normalizePhone(opts.dncPhone));
  const gate = new GatedMessageDelivery({
    base,
    dnc,
    auditRepo,
    enforcement: 'block',
    env,
    logger: { info: (message, meta) => logs.push({ message, meta }) },
  });
  return { gate, base, auditRepo, logs };
}

function customerSms(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    to: PHONE,
    body: 'your tech is on the way',
    tenantId: TENANT,
    recipientClass: 'customer',
    consent: { smsConsent: true, customerId: 'cust-1' },
    ...over,
  };
}

function ownerSms(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    to: PHONE,
    body: 'end of day digest',
    tenantId: TENANT,
    recipientClass: 'owner',
    ...over,
  };
}

function email(over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: EMAIL,
    subject: 'Your invoice',
    text: 'invoice body',
    tenantId: TENANT,
    ...over,
  };
}

describe('kill switch — flag semantics', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env.TELEPHONY_ENABLED = original.TELEPHONY_ENABLED;
    process.env.EMAIL_ENABLED = original.EMAIL_ENABLED;
    if (original.TELEPHONY_ENABLED === undefined) delete process.env.TELEPHONY_ENABLED;
    if (original.EMAIL_ENABLED === undefined) delete process.env.EMAIL_ENABLED;
  });

  it('unset = enabled (matches shared/config.ts `!== \'false\'`)', () => {
    expect(isOutboundChannelEnabled('sms', {})).toBe(true);
    expect(isOutboundChannelEnabled('email', {})).toBe(true);
  });

  it('only the literal string \'false\' disables a channel', () => {
    expect(isOutboundChannelEnabled('sms', { TELEPHONY_ENABLED: 'false' })).toBe(false);
    expect(isOutboundChannelEnabled('sms', { TELEPHONY_ENABLED: 'true' })).toBe(true);
    expect(isOutboundChannelEnabled('sms', { TELEPHONY_ENABLED: '0' })).toBe(true);
    expect(isOutboundChannelEnabled('sms', { TELEPHONY_ENABLED: 'FALSE' })).toBe(true);
    expect(isOutboundChannelEnabled('sms', { TELEPHONY_ENABLED: '' })).toBe(true);
  });

  it('defaults to process.env when no env is injected', () => {
    delete process.env.TELEPHONY_ENABLED;
    expect(isOutboundChannelEnabled('sms')).toBe(true);
    process.env.TELEPHONY_ENABLED = 'false';
    expect(isOutboundChannelEnabled('sms')).toBe(false);
  });
});

describe('kill switch — channels are independent', () => {
  it('TELEPHONY_ENABLED=false stops SMS but email still sends', async () => {
    const { gate, base } = build({ TELEPHONY_ENABLED: 'false' });

    await expect(gate.sendSms(customerSms())).rejects.toBeInstanceOf(SmsSuppressedError);
    expect(base.sentSms).toHaveLength(0);

    const result = await gate.sendEmail(email());
    expect(result.channel).toBe('email');
    expect(base.sentEmails).toHaveLength(1);
  });

  it('EMAIL_ENABLED=false stops email but SMS still sends', async () => {
    const { gate, base } = build({ EMAIL_ENABLED: 'false' });

    await expect(gate.sendEmail(email())).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(base.sentEmails).toHaveLength(0);

    const result = await gate.sendSms(customerSms());
    expect(result.channel).toBe('sms');
    expect(base.sentSms).toHaveLength(1);
  });

  it('both flags off stops both channels', async () => {
    const { gate, base } = build({ TELEPHONY_ENABLED: 'false', EMAIL_ENABLED: 'false' });
    await expect(gate.sendSms(customerSms())).rejects.toBeInstanceOf(SmsSuppressedError);
    await expect(gate.sendEmail(email())).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(base.sentSms).toHaveLength(0);
    expect(base.sentEmails).toHaveLength(0);
  });
});

describe('kill switch — owner-class is NOT exempt (consent-bypass regression guard)', () => {
  it('suppresses an owner SMS when TELEPHONY_ENABLED=false', async () => {
    const { gate, base } = build({ TELEPHONY_ENABLED: 'false' });
    await expect(gate.sendSms(ownerSms())).rejects.toMatchObject({
      reason: 'channel_disabled',
      recipientClass: 'owner',
    });
    expect(base.sentSms).toHaveLength(0);
  });

  it('suppresses an owner SMS that would otherwise bypass the DNC gate', async () => {
    // Same message the consent gate lets through unconditionally today.
    const { gate, base } = build({ TELEPHONY_ENABLED: 'false' }, { dncPhone: DNC_PHONE });
    await expect(gate.sendSms(ownerSms({ to: DNC_PHONE }))).rejects.toBeInstanceOf(
      SmsSuppressedError,
    );
    expect(base.sentSms).toHaveLength(0);
  });

  it('the owner bypass is still intact when the channel is enabled', async () => {
    const { gate, base } = build({}, { dncPhone: DNC_PHONE });
    await gate.sendSms(ownerSms({ to: DNC_PHONE }));
    expect(base.sentSms).toHaveLength(1);
  });
});

describe('kill switch — unset flags change nothing', () => {
  it('customer SMS, owner SMS and email all behave exactly as before', async () => {
    const { gate, base, auditRepo, logs } = build({});

    await gate.sendSms(customerSms());
    await gate.sendSms(ownerSms());
    await gate.sendEmail(email());

    expect(base.sentSms).toHaveLength(2);
    expect(base.sentEmails).toHaveLength(1);
    // No kill-switch noise and no new audit rows on the happy path.
    expect(logs).toHaveLength(0);
    expect(auditRepo.getAll()).toHaveLength(0);
    expect(gate.killSwitchSuppressionCounts()).toEqual({ sms: 0, email: 0 });
  });

  it('the consent gate still blocks a non-consented customer (unchanged)', async () => {
    const { gate } = build({});
    await expect(
      gate.sendSms(customerSms({ consent: { smsConsent: false } })),
    ).rejects.toMatchObject({ reason: 'no_consent' });
  });
});

describe('kill switch — observability', () => {
  it('logs a greppable channel_disabled reason with a REDACTED phone', async () => {
    const { gate, logs } = build({ TELEPHONY_ENABLED: 'false' });
    await expect(gate.sendSms(customerSms())).rejects.toBeInstanceOf(SmsSuppressedError);

    expect(logs).toHaveLength(1);
    const meta = logs[0].meta as Record<string, unknown>;
    expect(meta.reason).toBe('channel_disabled');
    expect(meta.channel).toBe('sms');
    expect(meta.tenantId).toBe(TENANT);
    expect(meta.recipientClass).toBe('customer');
    expect(meta.killSwitchEnvVar).toBe('TELEPHONY_ENABLED');
    // Last 4 only — the full number must never reach the log.
    expect(meta.phoneLast4).toBe('0000');
    expect(JSON.stringify(logs)).not.toContain(PHONE);
    expect(JSON.stringify(logs)).not.toContain('5551230000');
  });

  it('logs a REDACTED email (domain only, never the local part)', async () => {
    const { gate, logs } = build({ EMAIL_ENABLED: 'false' });
    await expect(gate.sendEmail(email())).rejects.toBeInstanceOf(EmailSuppressedError);

    expect(logs).toHaveLength(1);
    const meta = logs[0].meta as Record<string, unknown>;
    expect(meta.reason).toBe('channel_disabled');
    expect(meta.channel).toBe('email');
    expect(meta.killSwitchEnvVar).toBe('EMAIL_ENABLED');
    expect(meta.emailDomain).toBe('acmehvac.com');
    expect(JSON.stringify(logs)).not.toContain(EMAIL);
    expect(JSON.stringify(logs)).not.toContain('owner@');
  });

  it('counts suppressions per channel so an operator can see the volume', async () => {
    const { gate } = build({ TELEPHONY_ENABLED: 'false', EMAIL_ENABLED: 'false' });

    await expect(gate.sendSms(customerSms())).rejects.toThrow();
    await expect(gate.sendSms(ownerSms())).rejects.toThrow();
    await expect(gate.sendEmail(email())).rejects.toThrow();

    expect(gate.killSwitchSuppressionCounts()).toEqual({ sms: 2, email: 1 });
  });

  it('does not write consent-gate audit rows for a kill-switch suppression', async () => {
    // The kill switch is an operator action, not a compliance event — mixing
    // it into sms.suppressed would corrupt the consent audit trail.
    const { gate, auditRepo } = build({ TELEPHONY_ENABLED: 'false' });
    await expect(gate.sendSms(customerSms())).rejects.toThrow();
    expect(auditRepo.getAll()).toHaveLength(0);
  });
});

describe('kill switch — caller contract', () => {
  it('SMS reuses SmsSuppressedError, so existing callers need no change', async () => {
    const { gate } = build({ TELEPHONY_ENABLED: 'false' });
    const err = await gate.sendSms(customerSms()).catch((e) => e);
    expect(err).toBeInstanceOf(SmsSuppressedError);
    expect(err.suppressed).toBe(true);
    expect(err.reason).toBe('channel_disabled');
  });

  it('email suppression is a suppression, not a hard provider failure', async () => {
    const { gate } = build({ EMAIL_ENABLED: 'false' });
    const err = await gate.sendEmail(email()).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSuppressedError);
    expect(err.suppressed).toBe(true);
    expect(err.reason).toBe('channel_disabled');
  });
});
