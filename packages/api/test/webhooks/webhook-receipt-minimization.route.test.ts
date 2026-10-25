/**
 * U7-05+ — every provider route stores a minimized receipt in
 * `webhook_events`: the ids, types, amounts and statuses the readers and the
 * dedup need, never the customer's (or, for Clerk, the staff member's) name,
 * email, phone, address, message body or media.
 *
 * Route-level: each request goes through `createWebhookRouter` with the
 * in-memory receipt stores, which apply the same allowlist as the Pg
 * repositories (pinned against real Postgres in
 * test/integration/webhook-events-minimized-receipts.test.ts). Twilio
 * signature verification is mocked; the SendGrid and Stripe signatures and
 * the Clerk svix signature are real.
 */
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/telephony/twilio-signature', async () => {
  const actual = await vi.importActual<typeof import('../../src/telephony/twilio-signature')>(
    '../../src/telephony/twilio-signature',
  );
  return { ...actual, verifyTwilioSignature: () => true, reconstructWebhookUrl: () => 'http://test.local/x' };
});

import { createWebhookRouter } from '../../src/webhooks/routes';
import { InMemoryWebhookEventRepository } from '../../src/webhooks/in-memory-webhook-event';
import { InMemoryWebhookRepository, createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { __resetKeywordRegistryForTests } from '../../src/sms/inbound-dispatch';
import type { AppConfig } from '../../src/shared/config';
import {
  PII,
  findPii,
  clerkUserEvent,
  sendGridEventBatch,
  stripeAccountUpdatedData,
  stripeChargeRefundedData,
  stripeCheckoutSessionData,
  stripeCustomerUpdatedData,
  stripeDisputeCreatedData,
  stripeInvoicePaymentFailedData,
  stripePaymentIntentData,
  stripeRefundUpdatedData,
  stripeSetupIntentSucceededData,
  stripeSubscriptionUpdatedData,
  twilioInboundSmsBody,
  twilioStatusBody,
  twilioVoiceBody,
} from '../support/webhook-pii-fixtures';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_SID = 'AC-real';

beforeEach(() => {
  __resetKeywordRegistryForTests();
});

describe('Twilio receipts keep ids and statuses only', () => {
  function buildTwilioApp(webhookEventRepo: InMemoryWebhookEventRepository) {
    const app = express();
    app.use('/webhooks/twilio', express.urlencoded({ extended: false }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as AppConfig, {
        integrationResolver: async () => ({
          tenantId: TENANT_ID,
          provider: 'twilio',
          subaccountSid: ACCOUNT_SID,
          authTokenPrimary: 'token',
        }),
        webhookEventRepo,
        auditRepo: new InMemoryAuditRepository(),
      }),
    );
    return app;
  }

  it('an inbound SMS leaves no From, To, Body, location or MediaUrl in its receipt', async () => {
    const repo = new InMemoryWebhookEventRepository();
    const res = await request(buildTwilioApp(repo))
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .type('form')
      .send(twilioInboundSmsBody('SMpii1', ACCOUNT_SID));
    expect(res.status).toBe(200);

    const stored = await repo.findById('twilio', 'SMpii1');
    expect(findPii(stored?.payload)).toEqual([]);
    expect(stored?.payload).toEqual({
      AccountSid: ACCOUNT_SID,
      ApiVersion: '2010-04-01',
      MessageSid: 'SMpii1',
      MessagingServiceSid: 'MGfixture',
      NumMedia: '1',
      NumSegments: '1',
      SmsMessageSid: 'SMpii1',
      SmsSid: 'SMpii1',
      SmsStatus: 'received',
    });
    // markProcessed still lands, so a redelivery is a duplicate.
    expect(stored?.processedAt).toBeInstanceOf(Date);
    const replay = await request(buildTwilioApp(repo))
      .post(`/webhooks/twilio/sms/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .type('form')
      .send(twilioInboundSmsBody('SMpii1', ACCOUNT_SID));
    expect(replay.body).toEqual({ received: true, duplicate: true });
  });

  it('a voice webhook and a status callback keep only call/message SIDs and statuses', async () => {
    const repo = new InMemoryWebhookEventRepository();
    const app = buildTwilioApp(repo);
    await request(app)
      .post(`/webhooks/twilio/voice/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .type('form')
      .send(twilioVoiceBody('CApii1', ACCOUNT_SID))
      .expect(200);
    await request(app)
      .post(`/webhooks/twilio/status/${TENANT_ID}`)
      .set('x-twilio-signature', 'ok')
      .type('form')
      .send(twilioStatusBody('SMpii2', ACCOUNT_SID))
      .expect(200);

    const voice = await repo.findById('twilio', 'CApii1');
    expect(voice?.payload).toEqual({
      AccountSid: ACCOUNT_SID,
      ApiVersion: '2010-04-01',
      CallSid: 'CApii1',
      CallStatus: 'ringing',
      Direction: 'inbound',
    });
    const status = await repo.findById('twilio', 'SMpii2');
    expect(status?.payload).toEqual({
      AccountSid: ACCOUNT_SID,
      ApiVersion: '2010-04-01',
      ErrorCode: '30006',
      MessageSid: 'SMpii2',
      MessageStatus: 'undelivered',
      SmsSid: 'SMpii2',
      SmsStatus: 'undelivered',
    });
  });
});

describe('SendGrid receipts keep event ids only', () => {
  let publicKeyPem: string;
  let privateKey: crypto.KeyObject;

  beforeAll(() => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateKey = pair.privateKey;
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  it('stores the parsed batch reduced to sg ids, event and timestamp (no email, reason, IP or URL)', async () => {
    const repo = new InMemoryWebhookEventRepository();
    const app = express();
    app.use('/webhooks/sendgrid', express.raw({ type: 'application/json' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as AppConfig, {
        integrationResolver: async (tenantId: string) => ({
          tenantId,
          provider: 'sendgrid' as const,
          sendgridPublicKeyPem: publicKeyPem,
        }),
        webhookEventRepo: repo,
        auditRepo: new InMemoryAuditRepository(),
      }),
    );
    const raw = Buffer.from(JSON.stringify(sendGridEventBatch('sgevt-pii-1')));
    const ts = String(Math.floor(Date.now() / 1000));
    const signer = crypto.createSign('sha256');
    signer.update(ts);
    signer.update(raw);
    signer.end();
    const res = await request(app)
      .post(`/webhooks/sendgrid/${TENANT_ID}`)
      .set('content-type', 'application/json')
      .set('x-twilio-email-event-webhook-timestamp', ts)
      .set('x-twilio-email-event-webhook-signature', signer.sign(privateKey).toString('base64'))
      .send(raw.toString('utf8'));
    expect(res.status).toBe(200);

    const stored = await repo.findById('sendgrid', 'sgevt-pii-1');
    expect(findPii(stored?.payload)).toEqual([]);
    expect(stored?.payload).toEqual({
      events: [
        {
          sg_event_id: 'sgevt-pii-1',
          sg_message_id: 'sgmsg_fixture_1.filter0001',
          event: 'bounce',
          timestamp: 1_790_002_000,
        },
      ],
    });
  });
});

describe('Stripe receipts keep the per-type allowlist of event.data', () => {
  const SECRET = 'whsec_minimization';

  function buildStripeApp(webhookRepo: InMemoryWebhookRepository) {
    const app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use('/webhooks', createWebhookRouter({} as never, { webhookRepo, stripeWebhookSecret: SECRET }));
    return app;
  }

  const ids = { tenantId: TENANT_ID, invoiceId: INVOICE_ID };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['checkout.session.completed', stripeCheckoutSessionData({ ...ids, amountTotal: 30000, paymentIntent: 'pi_1' })],
    ['payment_intent.payment_failed', stripePaymentIntentData(ids)],
    ['charge.refunded', stripeChargeRefundedData({ ...ids, paymentId: 'pay_1' })],
    ['charge.refund.updated', stripeRefundUpdatedData(ids)],
    ['charge.dispute.created', stripeDisputeCreatedData(ids)],
    ['setup_intent.succeeded', stripeSetupIntentSucceededData({ tenantId: TENANT_ID, customerId: 'cust_1' })],
    ['invoice.payment_failed', stripeInvoicePaymentFailedData(TENANT_ID)],
    ['customer.subscription.updated', stripeSubscriptionUpdatedData(TENANT_ID)],
    ['account.updated', stripeAccountUpdatedData()],
    ['customer.updated', stripeCustomerUpdatedData()],
  ];

  it.each(cases)('%s: the stored receipt holds no personal data', async (type, data) => {
    const repo = new InMemoryWebhookRepository();
    const eventId = `evt_${type.replace(/\W/g, '_')}`;
    const raw = JSON.stringify({ id: eventId, type, account: 'acct_fixture_1', data });
    await request(buildStripeApp(repo))
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, SECRET))
      .set('content-type', 'application/json')
      .send(raw);
    // The receipt is written before any handler runs, so it exists whatever
    // the handler (with these minimal deps) decided.
    const stored = await repo.findByIdempotencyKey('stripe', eventId);
    expect(stored).not.toBeNull();
    expect(findPii(stored?.payload)).toEqual([]);
    const object = (stored?.payload as { object?: Record<string, unknown> }).object;
    expect(object?.id).toBe((data.object as { id: string }).id);
    expect(stored?.payload).not.toHaveProperty('previous_attributes');
  });

  it('checkout.session.completed keeps every key money-reconciliation reads', async () => {
    const repo = new InMemoryWebhookRepository();
    const raw = JSON.stringify({
      id: 'evt_recon_keys',
      type: 'checkout.session.completed',
      data: stripeCheckoutSessionData({ ...ids, amountTotal: 30000, paymentIntent: 'pi_recon' }),
    });
    await request(buildStripeApp(repo))
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, SECRET))
      .set('content-type', 'application/json')
      .send(raw);
    const stored = await repo.findByIdempotencyKey('stripe', 'evt_recon_keys');
    expect(stored?.payload).toMatchObject({
      object: {
        amount_total: 30000,
        payment_intent: 'pi_recon',
        payment_status: 'paid',
        metadata: { tenant_id: TENANT_ID, invoice_id: INVOICE_ID },
      },
    });
    expect((stored?.payload.object as { metadata: object }).metadata).not.toHaveProperty('free_text_note');
  });
});

describe('Clerk receipts keep the user id only (staff PII)', () => {
  const WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ=';

  it('a user.updated receipt holds no name, email, phone, IP or user agent', async () => {
    const repo = new InMemoryWebhookRepository();
    const app = express();
    app.use('/webhooks/clerk', express.raw({ type: 'application/json' }));
    app.use(
      '/webhooks',
      createWebhookRouter({ CLERK_WEBHOOK_SECRET: WEBHOOK_SECRET } as unknown as AppConfig, {
        webhookRepo: repo,
      }),
    );
    const raw = JSON.stringify(clerkUserEvent('user.updated', 'user_pii_1'));
    const svixId = 'msg_pii_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
    const sig = crypto.createHmac('sha256', secretBytes).update(`${svixId}.${ts}.${raw}`).digest('base64');
    const res = await request(app)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', ts)
      .set('svix-signature', `v1,${sig}`)
      .set('content-type', 'application/json')
      .send(raw);
    expect(res.status).toBe(200);

    const stored = await repo.findByIdempotencyKey('clerk', svixId);
    expect(findPii(stored?.payload)).toEqual([]);
    expect(stored?.payload).toEqual({
      type: 'user.updated',
      object: 'event',
      timestamp: 1_790_001_000_000,
      instance_id: 'ins_fixture_1',
      data: { id: 'user_pii_1', object: 'user', created_at: 1_790_001_000_000, updated_at: 1_790_001_000_000 },
    });
    expect(JSON.stringify(stored?.payload)).not.toContain(PII.email);
  });
});
