/**
 * Recipient quiet hours — the send window for NON-transactional customer
 * texts (thank-you, review request, automated estimate reminder).
 *
 * A message tagged `quietHours: 'defer'` that would land outside the
 * recipient-local window is DEFERRED, not dropped: the gate throws
 * `SmsDeferredError` (deliberately NOT an `SmsSuppressedError`, so no caller
 * mistakes it for a terminal consent verdict) before anything reaches the
 * provider, the suppression audit or the per-recipient volume cap.
 */
import { describe, it, expect } from 'vitest';
import {
  GatedMessageDelivery,
  SmsDeferredError,
  type SmsEnforcementMode,
} from '../../src/notifications/gated-message-delivery';
import {
  InMemoryDeliveryProvider,
  type SmsMessage,
} from '../../src/notifications/delivery-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { InMemoryRecipientSmsVolumeLedger } from '../../src/notifications/recipient-sms-volume';
import type { RecipientLocale } from '../../src/compliance/jurisdiction';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PHONE = '+16025550100';

/** America/Phoenix is UTC-7 all year (no DST) — keeps the instants obvious. */
const PHOENIX: RecipientLocale = { tenantTimezone: 'America/Phoenix', serviceStates: ['AZ'], areaCodeState: 'AZ' };

function build(opts: {
  now: Date;
  locale?: RecipientLocale;
  enforcement?: SmsEnforcementMode;
}) {
  const base = new InMemoryDeliveryProvider();
  const auditRepo = new InMemoryAuditRepository();
  const ledger = new InMemoryRecipientSmsVolumeLedger();
  const gate = new GatedMessageDelivery({
    base,
    dnc: new InMemoryDncRepository(),
    auditRepo,
    enforcement: opts.enforcement ?? 'block',
    recipientVolumeCap: { ledger, maxPerWindow: 5, windowHours: 24 },
    quietHours: {
      resolveRecipientLocale: async () => opts.locale ?? PHOENIX,
      now: () => opts.now,
    },
    logger: { info: () => undefined },
  });
  return { gate, base, auditRepo, ledger };
}

function customerText(over: Partial<SmsMessage> = {}): SmsMessage {
  return {
    to: PHONE,
    body: 'Thanks for choosing Acme!',
    tenantId: TENANT,
    recipientClass: 'customer',
    consent: { smsConsent: true, customerId: 'cust-1' },
    ...over,
  };
}

describe('GatedMessageDelivery — recipient quiet hours', () => {
  it('defers a non-transactional customer text at 22:30 recipient-local: nothing sent, no audit, no cap slot', async () => {
    // 2026-10-14T05:30Z = 22:30 MST on Oct 13.
    const { gate, base, auditRepo, ledger } = build({ now: new Date('2026-10-14T05:30:00Z') });

    const err = await gate.sendSms(customerText({ quietHours: 'defer' })).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
    // Next allowed instant: 08:00 MST on Oct 14.
    expect((err as SmsDeferredError).nextAllowedAt.toISOString()).toBe('2026-10-14T15:00:00.000Z');
    expect(auditRepo.getAll()).toHaveLength(0);
    expect(await ledger.sentInWindow(TENANT, normalizePhone(PHONE), 24)).toBe(0);
  });

  it('sends the same text at 10:00 recipient-local', async () => {
    // 2026-10-13T17:00Z = 10:00 MST.
    const { gate, base } = build({ now: new Date('2026-10-13T17:00:00Z') });

    await gate.sendSms(customerText({ quietHours: 'defer' }));

    expect(base.sentSms).toHaveLength(1);
  });

  it('never delays an untagged (transactional / conversational) customer text, even at 03:00', async () => {
    // 2026-10-13T10:00Z = 03:00 MST.
    const { gate, base } = build({ now: new Date('2026-10-13T10:00:00Z') });

    await gate.sendSms(customerText());

    expect(base.sentSms).toHaveLength(1);
  });

  it('never delays an owner-class alert at 03:00, even one tagged to defer', async () => {
    const { gate, base } = build({ now: new Date('2026-10-13T10:00:00Z') });

    await gate.sendSms({
      to: '+16025550199',
      body: 'EMERGENCY call just came in',
      tenantId: TENANT,
      recipientClass: 'owner',
      quietHours: 'defer',
    });

    expect(base.sentSms).toHaveLength(1);
  });
});

describe('GatedMessageDelivery — quiet hours in warn mode', () => {
  it('a deferred attempt writes no would-block audit row (one row per real send, not per retry)', async () => {
    const { gate, base, auditRepo } = build({ now: new Date('2026-10-14T05:30:00Z'), enforcement: 'warn' });

    const err = await gate
      .sendSms(customerText({ quietHours: 'defer', consent: { smsConsent: false, customerId: 'cust-1' } }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SmsDeferredError);
    expect(base.sentSms).toHaveLength(0);
    expect(auditRepo.getAll()).toHaveLength(0);
  });
});

describe('GatedMessageDelivery — stricter state windows (FL / OK / MD / WA close at 20:00)', () => {
  // 2026-10-14T00:30Z = 20:30 EDT on Oct 13.
  const EVENING = new Date('2026-10-14T00:30:00Z');

  it('defers a text to a Florida recipient at 20:30 local until the next morning', async () => {
    const { gate, base } = build({
      now: EVENING,
      locale: { tenantTimezone: 'America/New_York', serviceStates: ['FL'], areaCodeState: null },
    });

    const err = await gate.sendSms(customerText({ quietHours: 'defer' })).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
    // 08:00 Central (09:00 Eastern): Florida's panhandle is on Central time.
    expect((err as SmsDeferredError).nextAllowedAt.toISOString()).toBe('2026-10-14T13:00:00.000Z');
  });

  it('still sends to a Georgia recipient at 20:30 local (federal 21:00 close)', async () => {
    const { gate, base } = build({
      now: EVENING,
      locale: { tenantTimezone: 'America/New_York', serviceStates: ['GA'], areaCodeState: null },
    });

    await gate.sendSms(customerText({ quietHours: 'defer' }));

    expect(base.sentSms).toHaveLength(1);
  });

  it('applies the 20:00 close when the recipient state is unknown (conservative)', async () => {
    const { gate, base } = build({
      now: EVENING,
      locale: { tenantTimezone: 'America/New_York', serviceStates: [], areaCodeState: null },
    });

    const err = await gate.sendSms(customerText({ quietHours: 'defer' })).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
  });
});

describe('GatedMessageDelivery — unknown recipient timezone', () => {
  it('requires the window to be open in EVERY US zone (Eastern through Hawaii), never a guessed Eastern', async () => {
    // 2026-10-13T16:00Z = 12:00 EDT but 06:00 HST: an Eastern guess would send.
    const { gate, base } = build({
      now: new Date('2026-10-13T16:00:00Z'),
      locale: { tenantTimezone: null, serviceStates: [], areaCodeState: null },
    });

    const err = await gate.sendSms(customerText({ quietHours: 'defer' })).catch((e: unknown) => e);

    expect(base.sentSms).toHaveLength(0);
    expect(err).toBeInstanceOf(SmsDeferredError);
    // 18:00Z = 08:00 HST, 14:00 EDT — the first instant every zone allows.
    expect((err as SmsDeferredError).nextAllowedAt.toISOString()).toBe('2026-10-13T18:00:00.000Z');
  });
});
