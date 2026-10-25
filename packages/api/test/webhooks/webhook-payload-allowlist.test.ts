/**
 * U7-05+ — the per-source allowlist that decides what a `webhook_events`
 * receipt keeps (src/webhooks/webhook-payload-allowlist.ts).
 *
 * Pins, per source: the exact stored shape; that no personal value survives;
 * that the keys money-reconciliation reads survive; that minimizing twice
 * changes nothing (the backfill relies on it); and that every receipt writer in
 * src names a source with a policy (with a planted negative control).
 */
import { describe, it, expect } from 'vitest';
import {
  WEBHOOK_RECEIPT_SOURCES,
  UnclassifiedWebhookSourceError,
  hasWebhookPayloadPolicy,
  minimizeWebhookPayload,
  stripeObjectKind,
} from '../../src/webhooks/webhook-payload-allowlist';
import {
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
import { API_SRC, listSourceFiles, plantTree, removeTree, type SourceFile } from '../support/structural-scan';

const TENANT = '11111111-1111-1111-1111-111111111111';
const INVOICE = '22222222-2222-2222-2222-222222222222';
const ids = { tenantId: TENANT, invoiceId: INVOICE };

/** [source, eventType, body] for every fixture: the PII and idempotence sweeps run over all of them. */
const ALL_FIXTURES: Array<[string, string, Record<string, unknown>]> = [
  ['stripe', 'checkout.session.completed', stripeCheckoutSessionData({ ...ids, amountTotal: 30000, paymentIntent: 'pi_1' })],
  ['stripe', 'checkout.session.completed', stripeCheckoutSessionData({ ...ids, amountTotal: 30000, paymentIntent: { id: 'pi_2', receipt_email: 'x' } })],
  ['stripe', 'payment_intent.payment_failed', stripePaymentIntentData(ids)],
  ['stripe', 'charge.refunded', stripeChargeRefundedData({ ...ids, paymentId: 'pay_1' })],
  ['stripe', 'charge.refund.updated', stripeRefundUpdatedData(ids)],
  ['stripe', 'charge.dispute.created', stripeDisputeCreatedData(ids)],
  ['stripe', 'setup_intent.succeeded', stripeSetupIntentSucceededData({ tenantId: TENANT, customerId: 'cust_1' })],
  ['stripe', 'invoice.payment_failed', stripeInvoicePaymentFailedData(TENANT)],
  ['stripe', 'customer.subscription.updated', stripeSubscriptionUpdatedData(TENANT)],
  ['stripe', 'account.updated', stripeAccountUpdatedData()],
  ['stripe', 'account.external_account.created', stripeAccountUpdatedData()],
  ['stripe', 'customer.updated', stripeCustomerUpdatedData()],
  ['clerk', 'user.created', clerkUserEvent('user.created', 'user_1')],
  ['twilio', 'sms', twilioInboundSmsBody('SM1', 'AC1')],
  ['twilio', 'voice', twilioVoiceBody('CA1', 'AC1')],
  ['twilio', 'status', twilioStatusBody('SM2', 'AC1')],
  ['sendgrid', 'event', { events: sendGridEventBatch('sg1') }],
  ['vapi', 'call.ended', { tenantId: TENANT, fromE164: '+15125550147' }],
];

describe('every source: no personal data survives, and minimizing is idempotent', () => {
  it.each(ALL_FIXTURES)('%s %s', (source, eventType, body) => {
    expect(findPii(body).length).toBeGreaterThan(0); // the fixture really carries PII
    const once = minimizeWebhookPayload(source, eventType, body);
    expect(findPii(once)).toEqual([]);
    expect(minimizeWebhookPayload(source, eventType, once)).toEqual(once);
  });
});

describe('Stripe: per-event-type allowlist of event.data', () => {
  it('maps event types to object families (account.updated only is an Account)', () => {
    expect(stripeObjectKind('checkout.session.async_payment_succeeded')).toBe('checkout_session');
    expect(stripeObjectKind('payment_intent.succeeded')).toBe('payment_intent');
    expect(stripeObjectKind('charge.dispute.funds_withdrawn')).toBe('dispute');
    expect(stripeObjectKind('charge.refund.updated')).toBe('refund');
    expect(stripeObjectKind('charge.refunded')).toBe('charge');
    expect(stripeObjectKind('setup_intent.succeeded')).toBe('setup_intent');
    expect(stripeObjectKind('invoice.created')).toBe('invoice');
    expect(stripeObjectKind('invoiceitem.created')).toBe('other');
    expect(stripeObjectKind('customer.subscription.deleted')).toBe('subscription');
    expect(stripeObjectKind('account.updated')).toBe('account');
    expect(stripeObjectKind('account.external_account.created')).toBe('other');
    expect(stripeObjectKind('customer.updated')).toBe('other');
  });

  it('checkout.session.completed keeps ids, amounts, statuses and our metadata ids', () => {
    const out = minimizeWebhookPayload(
      'stripe',
      'checkout.session.completed',
      stripeCheckoutSessionData({ ...ids, amountTotal: 30000, paymentIntent: 'pi_1' }),
    );
    expect(out).toEqual({
      object: {
        id: `cs_test_${INVOICE.slice(0, 8)}`,
        object: 'checkout.session',
        amount_subtotal: 30000,
        amount_total: 30000,
        currency: 'usd',
        created: 1_790_000_000,
        expires_at: 1_790_086_400,
        livemode: false,
        mode: 'payment',
        payment_status: 'paid',
        status: 'complete',
        customer: null,
        payment_intent: 'pi_1',
        metadata: { tenant_id: TENANT, invoice_id: INVOICE },
      },
    });
  });

  it('keeps every key the money-reconciliation L5 reader uses, for each payment_intent shape', () => {
    const shapes: Array<[unknown, unknown]> = [
      ['pi_str', 'pi_str'],
      [{ id: 'pi_obj', object: 'payment_intent', receipt_email: 'x@y.z', shipping: { name: 'n' } }, { id: 'pi_obj' }],
      [null, null],
    ];
    for (const [given, kept] of shapes) {
      const body = stripeCheckoutSessionData({ ...ids, amountTotal: 12345, paymentIntent: given as string });
      (body.object as Record<string, unknown>).metadata = {
        tenant_id: TENANT,
        invoice_id: INVOICE,
        deposit_for_job_id: 'job_1',
      };
      const object = minimizeWebhookPayload('stripe', 'checkout.session.completed', body).object as Record<string, unknown>;
      expect(object.amount_total).toBe(12345);
      expect(object.payment_status).toBe('paid');
      expect(object.payment_intent).toEqual(kept);
      expect(object.metadata).toEqual({ tenant_id: TENANT, invoice_id: INVOICE, deposit_for_job_id: 'job_1' });
    }
    const noIntent = minimizeWebhookPayload(
      'stripe',
      'checkout.session.completed',
      stripeCheckoutSessionData({ ...ids, amountTotal: 1 }),
    ).object as Record<string, unknown>;
    expect(noIntent).not.toHaveProperty('payment_intent');
  });

  it('payment_intent: an expanded customer keeps its id; last_payment_error keeps codes, not the message or card', () => {
    const object = minimizeWebhookPayload('stripe', 'payment_intent.payment_failed', stripePaymentIntentData(ids)).object;
    expect(object).toEqual({
      id: 'pi_fixture_1',
      object: 'payment_intent',
      amount: 45000,
      amount_received: 45000,
      created: 1_790_000_100,
      currency: 'usd',
      livemode: false,
      status: 'requires_payment_method',
      customer: { id: 'cus_fixture_1' },
      latest_charge: 'ch_fixture_1',
      payment_method: 'pm_fixture_1',
      metadata: { tenant_id: TENANT, invoice_id: INVOICE },
      last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', type: 'card_error' },
    });
  });

  it('charge.refunded keeps amounts and the refund metadata ids; drops billing_details, card details and refunds list', () => {
    const out = minimizeWebhookPayload('stripe', 'charge.refunded', stripeChargeRefundedData({ ...ids, paymentId: 'pay_1' }));
    expect(out).toEqual({
      object: {
        id: 'ch_fixture_1',
        object: 'charge',
        amount: 45000,
        amount_captured: 45000,
        amount_refunded: 10000,
        captured: true,
        created: 1_790_000_200,
        currency: 'usd',
        livemode: false,
        paid: true,
        refunded: false,
        status: 'succeeded',
        payment_intent: 'pi_fixture_1',
        payment_method: 'pm_fixture_1',
        metadata: { tenant_id: TENANT, invoice_id: INVOICE, payment_id: 'pay_1' },
      },
    });
  });

  it('refund, dispute, setup_intent, invoice, subscription and account keep their id/amount/status keys', () => {
    expect(minimizeWebhookPayload('stripe', 'charge.refund.updated', stripeRefundUpdatedData(ids)).object).toEqual({
      id: 're_fixture_1',
      object: 'refund',
      amount: 10000,
      created: 1_790_000_300,
      currency: 'usd',
      reason: 'requested_by_customer',
      status: 'succeeded',
      charge: 'ch_fixture_1',
      payment_intent: 'pi_fixture_1',
      metadata: { tenant_id: TENANT },
    });
    expect(minimizeWebhookPayload('stripe', 'charge.dispute.created', stripeDisputeCreatedData(ids)).object).toEqual({
      id: 'dp_fixture_1',
      object: 'dispute',
      amount: 45000,
      created: 1_790_000_400,
      currency: 'usd',
      is_charge_refundable: true,
      livemode: false,
      reason: 'fraudulent',
      status: 'needs_response',
      charge: 'ch_fixture_1',
      payment_intent: 'pi_fixture_1',
      metadata: { tenant_id: TENANT },
    });
    expect(
      minimizeWebhookPayload('stripe', 'setup_intent.succeeded', stripeSetupIntentSucceededData({ tenantId: TENANT, customerId: 'c1' }))
        .object,
    ).toEqual({
      id: 'seti_fixture_1',
      object: 'setup_intent',
      created: 1_790_000_500,
      livemode: false,
      status: 'succeeded',
      usage: 'off_session',
      customer: 'cus_fixture_1',
      payment_method: { id: 'pm_fixture_2' },
      metadata: { tenant_id: TENANT, customer_id: 'c1' },
    });
    expect(minimizeWebhookPayload('stripe', 'invoice.payment_failed', stripeInvoicePaymentFailedData(TENANT)).object).toEqual({
      id: 'in_fixture_1',
      object: 'invoice',
      amount_due: 9900,
      amount_paid: 0,
      amount_remaining: 9900,
      attempt_count: 1,
      attempted: true,
      billing_reason: 'subscription_cycle',
      created: 1_790_000_600,
      currency: 'usd',
      status: 'open',
      total: 9900,
      customer: 'cus_platform_1',
      subscription: 'sub_fixture_1',
      metadata: { tenant_id: TENANT },
    });
    expect(
      minimizeWebhookPayload('stripe', 'customer.subscription.updated', stripeSubscriptionUpdatedData(TENANT)),
    ).toEqual({
      object: {
        id: 'sub_fixture_1',
        object: 'subscription',
        status: 'past_due',
        customer: 'cus_platform_1',
        created: 1_790_000_700,
        current_period_start: 1_790_000_000,
        current_period_end: 1_792_592_000,
        cancel_at_period_end: false,
        metadata: { tenant_id: TENANT, plan_id: 'plan_pro' },
      },
    });
    expect(minimizeWebhookPayload('stripe', 'account.updated', stripeAccountUpdatedData()).object).toEqual({
      id: 'acct_fixture_1',
      object: 'account',
      type: 'standard',
      created: 1_790_000_800,
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
  });

  it('an unhandled event type keeps only the object id, type, created and livemode', () => {
    expect(minimizeWebhookPayload('stripe', 'customer.updated', stripeCustomerUpdatedData())).toEqual({
      object: { id: 'cus_fixture_1', object: 'customer', created: 1_790_000_900, livemode: false },
    });
  });

  it('drops metadata keys our code never sets (free text a dashboard user could type)', () => {
    const out = minimizeWebhookPayload('stripe', 'charge.refunded', {
      object: { id: 'ch_1', metadata: { tenant_id: TENANT, note: 'call Jane at 512', payment_id: 7 } },
    });
    expect(out).toEqual({ object: { id: 'ch_1', metadata: { tenant_id: TENANT } } });
  });

  it('a body with no object stores {}', () => {
    expect(minimizeWebhookPayload('stripe', 'ping', {})).toEqual({});
    expect(minimizeWebhookPayload('stripe', 'ping', { object: 'nope' })).toEqual({});
  });
});

describe('Clerk, Twilio, SendGrid and the id-only sources', () => {
  it('Clerk keeps the envelope and the user id; drops names, emails, phones, metadata and event_attributes', () => {
    expect(minimizeWebhookPayload('clerk', 'user.created', clerkUserEvent('user.created', 'user_1'))).toEqual({
      type: 'user.created',
      object: 'event',
      timestamp: 1_790_001_000_000,
      instance_id: 'ins_fixture_1',
      data: { id: 'user_1', object: 'user', created_at: 1_790_001_000_000, updated_at: 1_790_001_000_000 },
    });
    expect(
      minimizeWebhookPayload('clerk', 'user.deleted', { type: 'user.deleted', data: { id: 'user_2', deleted: true } }),
    ).toEqual({ type: 'user.deleted', data: { id: 'user_2', deleted: true } });
  });

  it('Twilio keeps SIDs, statuses and counts for SMS, voice and status callbacks', () => {
    expect(minimizeWebhookPayload('twilio', 'sms', twilioInboundSmsBody('SM1', 'AC1'))).toEqual({
      AccountSid: 'AC1',
      ApiVersion: '2010-04-01',
      MessageSid: 'SM1',
      SmsSid: 'SM1',
      SmsMessageSid: 'SM1',
      MessagingServiceSid: 'MGfixture',
      SmsStatus: 'received',
      NumMedia: '1',
      NumSegments: '1',
    });
    expect(minimizeWebhookPayload('twilio', 'voice', twilioVoiceBody('CA1', 'AC1'))).toEqual({
      AccountSid: 'AC1',
      ApiVersion: '2010-04-01',
      CallSid: 'CA1',
      CallStatus: 'ringing',
      Direction: 'inbound',
    });
    expect(minimizeWebhookPayload('twilio', 'status', twilioStatusBody('SM2', 'AC1'))).toEqual({
      AccountSid: 'AC1',
      ApiVersion: '2010-04-01',
      MessageSid: 'SM2',
      SmsSid: 'SM2',
      MessageStatus: 'undelivered',
      SmsStatus: 'undelivered',
      ErrorCode: '30006',
    });
  });

  it('SendGrid keeps sg ids, event and timestamp, from a parsed batch, a Buffer or a legacy serialized Buffer', () => {
    const batch = sendGridEventBatch('sg1');
    const expected = {
      events: [{ sg_event_id: 'sg1', sg_message_id: 'sgmsg_fixture_1.filter0001', event: 'bounce', timestamp: 1_790_002_000 }],
    };
    const raw = Buffer.from(JSON.stringify(batch));
    expect(minimizeWebhookPayload('sendgrid', 'event', { events: batch })).toEqual(expected);
    expect(minimizeWebhookPayload('sendgrid', 'event', { events: raw })).toEqual(expected);
    // What `JSON.stringify({ events: req.body })` wrote for the raw-mounted route.
    const legacy = JSON.parse(JSON.stringify({ events: raw })) as Record<string, unknown>;
    expect(findPii(legacy).length).toBeGreaterThan(0);
    expect(minimizeWebhookPayload('sendgrid', 'event', legacy)).toEqual(expected);
    expect(minimizeWebhookPayload('sendgrid', 'event', { events: batch[0] })).toEqual(expected);
    expect(minimizeWebhookPayload('sendgrid', 'event', { events: Buffer.from('not json') })).toEqual({ events: [] });
    expect(minimizeWebhookPayload('sendgrid', 'event', {})).toEqual({ events: [] });
  });

  it('Vapi keeps tenantId and callId only (a legacy receipt loses fromE164)', () => {
    expect(minimizeWebhookPayload('vapi', 'call.ended', { tenantId: TENANT, callId: 'call_1', fromE164: '+1' })).toEqual({
      tenantId: TENANT,
      callId: 'call_1',
    });
  });

  it('LSA, the voicemail legs and the one-tap nonces keep their existing id-only shapes', () => {
    expect(minimizeWebhookPayload('lsa', 'lead.received', { tenantId: TENANT, leadId: 'l1' })).toEqual({ tenantId: TENANT, leadId: 'l1' });
    expect(minimizeWebhookPayload('twilio_voicemail_lead', 'voicemail_lead', { callSid: 'CA', recordingSid: 'RE' })).toEqual({
      callSid: 'CA',
      recordingSid: 'RE',
    });
    expect(
      minimizeWebhookPayload('twilio_voicemail_transcription', 'voicemail_transcription', {
        callSid: 'CA',
        recordingSid: 'RE',
        voiceRecordingId: 'vr',
      }),
    ).toEqual({ callSid: 'CA', recordingSid: 'RE', voiceRecordingId: 'vr' });
    const orphanedCopy = {
      tenantId: TENANT,
      callSid: 'CA',
      recordingSid: 'RE',
      recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE',
      reason: 'no_credentials',
    };
    expect(
      minimizeWebhookPayload('twilio_voicemail_orphaned_copy', 'voicemail_twilio_copy_orphaned', {
        ...orphanedCopy,
        From: '+15125550147',
      }),
    ).toEqual(orphanedCopy);
    expect(minimizeWebhookPayload('one_tap_approve', 'one_tap_approve_nonce', { leaked: 'x' })).toEqual({});
    expect(minimizeWebhookPayload('one_tap_undo', 'one_tap_undo_nonce', {})).toEqual({});
  });

  it('a non-object payload stores the empty shape', () => {
    expect(minimizeWebhookPayload('twilio', 'sms', null)).toEqual({});
    expect(minimizeWebhookPayload('stripe', 'charge.refunded', 'x')).toEqual({});
  });

  it('a source with no policy throws instead of storing an unreviewed body', () => {
    expect(hasWebhookPayloadPolicy('stripe')).toBe(true);
    expect(hasWebhookPayloadPolicy('toString')).toBe(false);
    expect(() => minimizeWebhookPayload('toString', 't', {})).toThrow(UnclassifiedWebhookSourceError);
    expect(() => minimizeWebhookPayload('brand_new', 't', { email: 'a@b.c' })).toThrow(/brand_new/);
  });
});

// ---------- every writer is covered ----------

/** First argument of each receipt-writing call: `recordReceipt(` or `handleWebhookEvent(`. */
const WRITER_CALL = /\b(recordReceipt|handleWebhookEvent)\(\s*([^,)]*)/g;

interface WriterSite {
  readonly at: string;
  readonly source: string | null;
  readonly raw: string;
}

/**
 * Resolves each writer call's source: a string literal, or an identifier bound
 * to a string literal by a `const` in the scanned tree. A typed parameter
 * (`provider: string`) is a declaration, not a call, and is skipped.
 */
function writerSites(files: readonly SourceFile[]): WriterSite[] {
  const constants = new Map<string, string>();
  for (const f of files) {
    for (const m of f.code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g)) constants.set(m[1], m[2]);
  }
  const sites: WriterSite[] = [];
  for (const f of files) {
    for (const m of f.code.matchAll(WRITER_CALL)) {
      const raw = m[2].trim();
      if (raw.includes(':')) continue; // declaration: `provider: string`
      const line = f.code.slice(0, m.index).split('\n').length;
      const literal = /^'([^']+)'$/.exec(raw);
      const source = literal ? literal[1] : (constants.get(raw) ?? null);
      sites.push({ at: `${f.rel}:${line}`, source, raw });
    }
  }
  return sites;
}

function uncovered(sites: readonly WriterSite[]): string[] {
  return sites
    .filter((s) => s.source === null || !hasWebhookPayloadPolicy(s.source))
    .map((s) => `${s.at}  ${s.raw}`);
}

describe('every webhook_events writer in src has a payload policy', () => {
  const sites = writerSites(listSourceFiles([API_SRC]));

  it('finds the known writers', () => {
    const sources = new Set(sites.map((s) => s.source));
    for (const source of WEBHOOK_RECEIPT_SOURCES) expect(sources, source).toContain(source);
  });

  it('no writer names a source without a policy (or a source the scan cannot resolve)', () => {
    expect(uncovered(sites)).toEqual([]);
  });

  it('negative control: a planted writer with an unregistered source is flagged', () => {
    const dir = plantTree('webhook-allowlist', {
      'src/planted.ts': [
        "const ORPHAN_SOURCE = 'twilio_orphan_copy';",
        'export async function a(repo: any) {',
        "  await repo.recordReceipt(ORPHAN_SOURCE, 'k', 't', { recordingUrl: 'u' });",
        "  await repo.recordReceipt('twilio', 'k', 't', {});",
        '}',
        'export async function b(repo: any, s: string) {',
        '  await handleWebhookEvent(s, "t", {}, "k", repo);',
        '}',
      ].join('\n'),
    });
    try {
      const flagged = uncovered(writerSites(listSourceFiles([`${dir}/src`])));
      expect(flagged).toEqual(['src/planted.ts:3  ORPHAN_SOURCE', 'src/planted.ts:7  s']);
    } finally {
      removeTree(dir);
    }
  });
});
