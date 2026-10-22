import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import {
  SmsDeferredError,
  SmsSuppressedError,
} from '../../src/notifications/gated-message-delivery';
import type { MessageDeliveryProvider, SmsMessage } from '../../src/notifications/delivery-provider';
import type { ConsentLedgerEventLike } from '../../src/compliance/resolve-outbound-consent';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import {
  createOutboundMessaging,
  type OutboundText,
} from '../../src/notifications/outbound-messaging';

const TENANT = 'tenant-om-1';
const NOW = new Date('2026-10-22T15:00:00Z');

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Mary',
    lastName: 'Johnson',
    displayName: 'Mary Johnson',
    primaryPhone: '+15551234567',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('outbound messaging', () => {
  let customerRepo: InMemoryCustomerRepository;
  let dncRepo: InMemoryDncRepository;
  let sent: SmsMessage[];
  let sendSms: ReturnType<typeof vi.fn>;
  let ledger: ConsentLedgerEventLike[];
  let dispatches: InMemoryDispatchRepository;
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
    dncRepo = new InMemoryDncRepository();
    sent = [];
    ledger = [];
    dispatches = new InMemoryDispatchRepository();
    logger.warn.mockClear();
    sendSms = vi.fn(async (message: SmsMessage) => {
      sent.push(message);
      return { provider: 'test', providerMessageId: `m-${sent.length}`, channel: 'sms' as const };
    });
  });

  function messaging(overrideSend?: (message: SmsMessage) => Promise<never>) {
    const delivery = {
      sendSms: overrideSend ?? sendSms,
      sendEmail: vi.fn(),
    } as unknown as MessageDeliveryProvider;
    return createOutboundMessaging({
      delivery,
      customerRepo,
      dncRepo,
      consentLedger: { listByPhone: async () => ledger },
      dispatchRepo: dispatches,
      pool: null,
      logger,
    });
  }

  const toCustomer = (purpose: OutboundText['purpose']): OutboundText => ({
    tenantId: TENANT,
    recipient: { kind: 'customer', customerId: 'cust-1' },
    purpose,
    dedupe: { messageKind: 'test_message', recordId: 'job-1' },
    about: { entityType: 'thank_you', entityId: 'job-1', jobId: 'job-1' },
    body: 'Hello',
  });

  it('sends a transactional text now, with the consent it looked up and the dedupe key', async () => {
    await customerRepo.create(makeCustomer());

    const outcome = await messaging().sendText(toCustomer('transactional'));

    expect(outcome).toEqual({
      status: 'sent',
      delivery: { provider: 'test', providerMessageId: 'm-1', channel: 'sms' },
    });
    expect(sent[0]).toEqual({
      to: '+15551234567',
      body: 'Hello',
      tenantId: TENANT,
      recipientClass: 'customer',
      consent: { smsConsent: true, customerId: 'cust-1' },
      idempotencyKey: 'test_message:job-1',
    });
  });

  it('leaves a transactional text to the gate even without stored consent', async () => {
    await customerRepo.create(makeCustomer({ smsConsent: false }));

    const outcome = await messaging().sendText(toCustomer('transactional'));

    expect(outcome.status).toBe('sent');
    expect(sent[0].consent).toEqual({ smsConsent: false, customerId: 'cust-1' });
  });

  it.each(['automated_nudge', 'marketing'] as const)(
    'holds a %s text for the daytime window',
    async (purpose) => {
      await customerRepo.create(makeCustomer());
      ledger = [{ kind: 'marketing', state: 'granted' }];

      await messaging().sendText(toCustomer(purpose));

      expect(sent[0].quietHours).toBe('defer');
    },
  );

  it('blocks a nudge to a customer who has not said yes, without calling the provider', async () => {
    await customerRepo.create(makeCustomer({ smsConsent: false }));

    const outcome = await messaging().sendText(toCustomer('automated_nudge'));

    expect(outcome).toEqual({ status: 'blocked', reason: 'no_consent', permanent: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('blocks a nudge to a number on the tenant DNC list', async () => {
    await customerRepo.create(makeCustomer());
    dncRepo.add(TENANT, '+15551234567');

    const outcome = await messaging().sendText(toCustomer('automated_nudge'));

    expect(outcome).toEqual({ status: 'blocked', reason: 'dnc', permanent: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('blocks marketing without a standing marketing grant; SMS consent alone is not one', async () => {
    await customerRepo.create(makeCustomer());

    const none = await messaging().sendText(toCustomer('marketing'));
    ledger = [
      { kind: 'marketing', state: 'revoked' },
      { kind: 'marketing', state: 'granted' },
    ];
    const revokedSinceGrant = await messaging().sendText(toCustomer('marketing'));

    expect(none).toEqual({ status: 'blocked', reason: 'no_marketing_consent', permanent: true });
    expect(revokedSinceGrant).toEqual({ status: 'blocked', reason: 'no_marketing_consent', permanent: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('turns a failed recipient lookup into a retryable block, never a throw', async () => {
    customerRepo.findById = async () => {
      throw new Error('connection reset');
    };

    const outcome = await messaging().sendText(toCustomer('transactional'));

    expect(outcome).toEqual({
      status: 'blocked',
      reason: 'send_failed',
      permanent: false,
      detail: 'connection reset',
    });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('blocks when the customer is missing or has no number', async () => {
    expect(await messaging().sendText(toCustomer('transactional'))).toEqual({
      status: 'blocked',
      reason: 'customer_not_found',
      permanent: true,
    });
    await customerRepo.create(makeCustomer({ primaryPhone: undefined }));
    expect(await messaging().sendText(toCustomer('transactional'))).toEqual({
      status: 'blocked',
      reason: 'no_phone',
      permanent: true,
    });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('sends a reply with the consent the inbound message gave', async () => {
    await messaging().sendText({
      tenantId: TENANT,
      recipient: { kind: 'reply', phone: '+15559876543' },
      purpose: 'reply',
      dedupe: { messageKind: 'reply', recordId: 'inbound-1' },
      about: { entityType: 'conversation_reply', entityId: 'conv-1' },
      body: 'Thanks, see you at 3',
    });

    expect(sent[0]).toMatchObject({
      to: '+15559876543',
      recipientClass: 'customer',
      consent: { smsConsent: true },
    });
    expect(sent[0].quietHours).toBeUndefined();
  });

  it('refuses a reply recipient for anything but a reply', async () => {
    const outcome = await messaging().sendText({
      tenantId: TENANT,
      recipient: { kind: 'reply', phone: '+15559876543' },
      purpose: 'marketing',
      dedupe: { messageKind: 'promo', recordId: 'inbound-1' },
      about: { entityType: 'conversation_reply', entityId: 'conv-1' },
      body: 'Fall special',
    } as unknown as OutboundText);

    expect(outcome).toEqual({ status: 'blocked', reason: 'no_consent', permanent: true });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('sends to the owner as owner-class, carrying a life-safety tag', async () => {
    await messaging().sendText({
      tenantId: TENANT,
      recipient: { kind: 'owner', phone: '+15550001111', alertClass: 'life_safety' },
      purpose: 'transactional',
      dedupe: { messageKind: 'e1_alert', recordId: 'call-1' },
      body: 'Gas leak reported',
    });

    expect(sent[0]).toMatchObject({ recipientClass: 'owner', alertClass: 'life_safety' });
    expect(sent[0].consent).toBeUndefined();
  });

  it('reports a quiet-hours deferral as scheduled, with the time the window opens', async () => {
    await customerRepo.create(makeCustomer());
    const opens = new Date('2026-10-23T15:00:00Z');

    const outcome = await messaging(async () => {
      throw new SmsDeferredError(opens);
    }).sendText(toCustomer('automated_nudge'));

    expect(outcome).toEqual({ status: 'scheduled', at: opens, reason: 'quiet_hours' });
  });

  it('marks a gate revocation permanent and the kill switch retryable', async () => {
    await customerRepo.create(makeCustomer());

    const revoked = await messaging(async () => {
      throw new SmsSuppressedError('revoked');
    }).sendText(toCustomer('transactional'));
    const switchedOff = await messaging(async () => {
      throw new SmsSuppressedError('channel_disabled');
    }).sendText(toCustomer('transactional'));

    expect(revoked).toEqual({ status: 'blocked', reason: 'revoked', permanent: true });
    expect(switchedOff).toEqual({ status: 'blocked', reason: 'channel_disabled', permanent: false });
  });

  it('reports an already-sent key as sent before looking up the recipient', async () => {
    // The customer is gone since the first send; a retry must still learn it went out.
    const pool = {
      query: vi.fn(async (sql: string) =>
        sql.includes('SELECT status') ? { rows: [{ status: 'sent' }], rowCount: 1 } : { rows: [], rowCount: 0 },
      ),
    } as unknown as Pool;
    const outbound = createOutboundMessaging({
      delivery: { sendSms, sendEmail: vi.fn() } as unknown as MessageDeliveryProvider,
      customerRepo,
      dncRepo,
      consentLedger: { listByPhone: async () => [] },
      dispatchRepo: dispatches,
      pool,
      logger,
    });

    expect(await outbound.sendText(toCustomer('automated_nudge'))).toEqual({
      status: 'sent',
      duplicate: 'sent',
    });
    expect(sendSms).not.toHaveBeenCalled();
  });

  function finalizeFailingPool(failures: number) {
    let finalizeCalls = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("status = 'sent'")) {
          finalizeCalls++;
          if (finalizeCalls <= failures) throw new Error('connection reset');
        }
        return { rows: [{ claim_key: 'k' }], rowCount: 1 };
      }),
    } as unknown as Pool;
    return { pool, finalizeCalls: () => finalizeCalls };
  }

  it('retries the sent tombstone after a delivered text, so a later retry can reconcile', async () => {
    await customerRepo.create(makeCustomer());
    const { pool, finalizeCalls } = finalizeFailingPool(1);
    const outbound = createOutboundMessaging({
      delivery: { sendSms, sendEmail: vi.fn() } as unknown as MessageDeliveryProvider,
      customerRepo,
      dncRepo,
      consentLedger: { listByPhone: async () => [] },
      dispatchRepo: dispatches,
      pool,
      logger,
    });

    const outcome = await outbound.sendText(toCustomer('transactional'));

    expect(outcome.status).toBe('sent');
    expect(finalizeCalls()).toBe(2);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('reports a delivered text as sent even when finalizing its dedupe claim keeps failing', async () => {
    await customerRepo.create(makeCustomer());
    // Wins the claim; every "mark sent" write fails.
    const { pool } = finalizeFailingPool(Infinity);
    const outbound = createOutboundMessaging({
      delivery: { sendSms, sendEmail: vi.fn() } as unknown as MessageDeliveryProvider,
      customerRepo,
      dncRepo,
      consentLedger: { listByPhone: async () => [] },
      dispatchRepo: dispatches,
      pool,
      logger,
    });

    const outcome = await outbound.sendText(toCustomer('transactional'));

    expect(outcome).toEqual({
      status: 'sent',
      delivery: { provider: 'test', providerMessageId: 'm-1', channel: 'sms' },
    });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('turns a provider error into a retryable block with the reason, never a throw', async () => {
    await customerRepo.create(makeCustomer());

    const outcome = await messaging(async () => {
      throw new Error('Twilio 503');
    }).sendText(toCustomer('transactional'));

    expect(outcome).toEqual({
      status: 'blocked',
      reason: 'send_failed',
      permanent: false,
      detail: 'Twilio 503',
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  describe('message record', () => {
    const recorded = async () => (await dispatches.listByTenant(TENANT)).dispatches;

    it('records a sent text with the provider id, customer, job and purpose', async () => {
      await customerRepo.create(makeCustomer());

      await messaging().sendText(toCustomer('transactional'));

      expect(await recorded()).toMatchObject([
        {
          status: 'sent',
          idempotencyKey: 'test_message:job-1',
          entityType: 'thank_you',
          entityId: 'job-1',
          channel: 'sms',
          recipient: '+15551234567',
          provider: 'test',
          providerMessageId: 'm-1',
          customerId: 'cust-1',
          jobId: 'job-1',
          purpose: 'transactional',
        },
      ]);
    });

    it('records a blocked text with its reason and the number it would have gone to', async () => {
      await customerRepo.create(makeCustomer({ smsConsent: false }));

      await messaging().sendText(toCustomer('automated_nudge'));

      expect(await recorded()).toMatchObject([
        {
          status: 'blocked',
          blockReason: 'no_consent',
          blockPermanent: true,
          recipient: '+15551234567',
          customerId: 'cust-1',
          provider: 'none',
        },
      ]);
    });

    it('records a blocked send failure with the error, as retryable', async () => {
      await customerRepo.create(makeCustomer());

      await messaging(async () => {
        throw new Error('Twilio 503');
      }).sendText(toCustomer('transactional'));

      expect(await recorded()).toMatchObject([
        { status: 'blocked', blockReason: 'send_failed', blockPermanent: false, errorMessage: 'Twilio 503' },
      ]);
    });

    it('keeps one record per message: a held text is replaced when it goes out', async () => {
      await customerRepo.create(makeCustomer());
      const opens = new Date('2026-10-23T15:00:00Z');

      await messaging(async () => {
        throw new SmsDeferredError(opens);
      }).sendText(toCustomer('automated_nudge'));
      expect(await recorded()).toMatchObject([{ status: 'scheduled', scheduledFor: opens }]);

      await messaging().sendText(toCustomer('automated_nudge'));
      const rows = await recorded();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'sent', providerMessageId: 'm-1' });
      expect(rows[0].scheduledFor).toBeUndefined();
    });

    it('never replaces a sent record with a later block', async () => {
      await customerRepo.create(makeCustomer());
      await messaging().sendText(toCustomer('transactional'));

      // Without a claim ledger the second attempt goes to the gate, which refuses it.
      await messaging(async () => {
        throw new SmsSuppressedError('channel_disabled');
      }).sendText(toCustomer('transactional'));

      expect(await recorded()).toMatchObject([{ status: 'sent' }]);
    });

    it('backfills a missing record when a retry finds the text already sent, and keeps a recorded one', async () => {
      // The claim says sent; the first attempt's record write never landed.
      const pool = {
        query: vi.fn(async (sql: string) =>
          sql.includes('SELECT status') ? { rows: [{ status: 'sent' }], rowCount: 1 } : { rows: [], rowCount: 0 },
        ),
      } as unknown as Pool;
      const outbound = createOutboundMessaging({
        delivery: { sendSms, sendEmail: vi.fn() } as unknown as MessageDeliveryProvider,
        customerRepo,
        dncRepo,
        consentLedger: { listByPhone: async () => [] },
        dispatchRepo: dispatches,
        pool,
        logger,
      });

      expect(await outbound.sendText(toCustomer('transactional'))).toEqual({ status: 'sent', duplicate: 'sent' });
      expect(await recorded()).toMatchObject([
        { status: 'sent', idempotencyKey: 'test_message:job-1', customerId: 'cust-1', jobId: 'job-1', recipient: '' },
      ]);

      // A record that did land is never replaced by the backfill.
      dispatches = new InMemoryDispatchRepository();
      await customerRepo.create(makeCustomer());
      await messaging().sendText(toCustomer('transactional'));
      await createOutboundMessaging({
        delivery: { sendSms, sendEmail: vi.fn() } as unknown as MessageDeliveryProvider,
        customerRepo,
        dncRepo,
        consentLedger: { listByPhone: async () => [] },
        dispatchRepo: dispatches,
        pool,
        logger,
      }).sendText(toCustomer('transactional'));
      expect(await recorded()).toMatchObject([{ status: 'sent', recipient: '+15551234567', providerMessageId: 'm-1' }]);
    });

    it('does not record a text to the owner', async () => {
      await messaging().sendText({
        tenantId: TENANT,
        recipient: { kind: 'owner', phone: '+15550001111' },
        purpose: 'transactional',
        dedupe: { messageKind: 'digest', recordId: 'd-1' },
        body: 'Your day',
      });

      expect(await recorded()).toEqual([]);
    });

    it('reports a sent text as sent when the record write fails, and logs it', async () => {
      await customerRepo.create(makeCustomer());
      dispatches.recordOutcome = async () => {
        throw new Error('db down');
      };

      const outcome = await messaging().sendText(toCustomer('transactional'));

      expect(outcome.status).toBe('sent');
      expect(logger.warn).toHaveBeenCalledWith(
        'Outbound text outcome was not recorded',
        expect.objectContaining({ error: 'db down', status: 'sent' }),
      );
    });
  });
});
