/**
 * U7-05+ — webhook_events stores a minimized receipt, at REAL Postgres.
 *
 * Every receipt writer goes through one of two repositories:
 * `PgWebhookEventRepository.recordReceipt` (Twilio, SendGrid, Vapi, LSA, the
 * voicemail legs, the one-tap nonces) and `PgWebhookRepository.create`, reached
 * through `handleWebhookEvent` (Stripe, Clerk). This suite writes a real-shaped
 * body with personal data through each, reads the `payload` column back, and
 * pins that:
 *   - none of the personal values is stored, and the stored shape is exactly
 *     the allowlist;
 *   - the money-reconciliation L5 gate still matches (pass AND violation) on
 *     a checkout receipt written through the real path — its SQL reads
 *     `payload->'object'->…` on these real columns;
 *   - dedup is unchanged: a redelivery after markProcessed / updateStatus is a
 *     duplicate, and a failed row is still claimable for retry.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts \
 *     test/integration/webhook-events-minimized-receipts.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant, type TestTenant } from './shared';
import { seedPaidInvoice } from './money-reconciliation-seed';
import { PgWebhookEventRepository } from '../../src/webhooks/pg-webhook-event';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { handleWebhookEvent } from '../../src/webhooks/webhook-handler';
import { PgMoneyReconciliationReader, runMoneyReconciliationSweep } from '../../src/workers/money-reconciliation';
import { createLogger } from '../../src/logging/logger';
import {
  findPii,
  clerkUserEvent,
  sendGridEventBatch,
  stripeChargeRefundedData,
  stripeCheckoutSessionData,
  stripeDisputeCreatedData,
  stripePaymentIntentData,
  twilioInboundSmsBody,
} from '../support/webhook-pii-fixtures';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

describe('webhook_events receipts are minimized at write time (real Postgres)', () => {
  let pool: Pool;
  let receipts: PgWebhookEventRepository;
  let webhooks: PgWebhookRepository;
  let tenant: TestTenant;

  async function storedPayload(source: string, key: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `SELECT payload FROM webhook_events WHERE source = $1 AND idempotency_key = $2`,
      [source, key],
    );
    expect(rows).toHaveLength(1);
    return rows[0].payload as Record<string, unknown>;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    receipts = new PgWebhookEventRepository(pool);
    webhooks = new PgWebhookRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('Twilio: an inbound SMS receipt holds SIDs and status only; redelivery dedups after markProcessed', async () => {
    const sid = `SM${crypto.randomUUID().replace(/-/g, '')}`;
    const first = await receipts.recordReceipt('twilio', sid, 'sms', twilioInboundSmsBody(sid, 'ACint'));
    expect(first.inserted).toBe(true);
    const payload = await storedPayload('twilio', sid);
    expect(findPii(payload)).toEqual([]);
    expect(payload).toEqual({
      AccountSid: 'ACint',
      ApiVersion: '2010-04-01',
      MessageSid: sid,
      MessagingServiceSid: 'MGfixture',
      NumMedia: '1',
      NumSegments: '1',
      SmsMessageSid: sid,
      SmsSid: sid,
      SmsStatus: 'received',
    });

    await receipts.markProcessed('twilio', sid);
    const replay = await receipts.recordReceipt('twilio', sid, 'sms', twilioInboundSmsBody(sid, 'ACint'));
    expect(replay.inserted).toBe(false);
    expect(replay.record.processedAt).toBeInstanceOf(Date);
    expect(replay.record.payload).toEqual(payload);
  });

  it('SendGrid: a batch receipt holds sg ids, event and timestamp only', async () => {
    const id = `sg_${crypto.randomUUID()}`;
    await receipts.recordReceipt('sendgrid', id, 'event', { events: sendGridEventBatch(id) });
    const payload = await storedPayload('sendgrid', id);
    expect(findPii(payload)).toEqual([]);
    expect(payload).toEqual({
      events: [{ sg_event_id: id, sg_message_id: 'sgmsg_fixture_1.filter0001', event: 'bounce', timestamp: 1_790_002_000 }],
    });
  });

  it('Vapi, LSA, voicemail legs and one-tap nonces keep their id-only shapes', async () => {
    const callId = `call_${crypto.randomUUID()}`;
    // A pre-U7-05+ writer stored the caller's number: the allowlist drops it.
    await receipts.recordReceipt('vapi', callId, 'call.ended', {
      tenantId: tenant.tenantId,
      callId,
      fromE164: '+15125550147',
    });
    expect(await storedPayload('vapi', callId)).toEqual({ tenantId: tenant.tenantId, callId });

    const lsaKey = `${tenant.tenantId}:lead_${crypto.randomUUID()}`;
    await receipts.recordReceipt('lsa', lsaKey, 'lead.received', { tenantId: tenant.tenantId, leadId: 'lead_1' });
    expect(await storedPayload('lsa', lsaKey)).toEqual({ tenantId: tenant.tenantId, leadId: 'lead_1' });

    const vmKey = `${tenant.tenantId}:RE${crypto.randomUUID().replace(/-/g, '')}`;
    await receipts.recordReceipt('twilio_voicemail_lead', vmKey, 'voicemail_lead', { callSid: 'CA1', recordingSid: 'RE1' });
    await receipts.recordReceipt('twilio_voicemail_transcription', vmKey, 'voicemail_transcription', {
      callSid: 'CA1',
      recordingSid: 'RE1',
      voiceRecordingId: 'vr_1',
    });
    expect(await storedPayload('twilio_voicemail_lead', vmKey)).toEqual({ callSid: 'CA1', recordingSid: 'RE1' });
    expect(await storedPayload('twilio_voicemail_transcription', vmKey)).toEqual({
      callSid: 'CA1',
      recordingSid: 'RE1',
      voiceRecordingId: 'vr_1',
    });

    const nonce = crypto.randomUUID();
    expect((await receipts.recordReceipt('one_tap_approve', nonce, 'one_tap_approve_nonce', {})).inserted).toBe(true);
    expect((await receipts.recordReceipt('one_tap_approve', nonce, 'one_tap_approve_nonce', {})).inserted).toBe(false);
    expect(await storedPayload('one_tap_approve', nonce)).toEqual({});
  });

  it('Stripe: payment, refund and dispute receipts hold no billing_details, email, shipping or evidence', async () => {
    const ids = { tenantId: tenant.tenantId, invoiceId: crypto.randomUUID() };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['payment_intent.payment_failed', stripePaymentIntentData(ids)],
      ['charge.refunded', stripeChargeRefundedData({ ...ids, paymentId: crypto.randomUUID() })],
      ['charge.dispute.created', stripeDisputeCreatedData(ids)],
    ];
    for (const [type, data] of cases) {
      const eventId = `evt_${crypto.randomUUID()}`;
      const { duplicate } = await handleWebhookEvent('stripe', type, data, eventId, webhooks);
      expect(duplicate).toBe(false);
      const payload = await storedPayload('stripe', eventId);
      expect(findPii(payload), type).toEqual([]);
      expect(Object.keys(payload)).toEqual(['object']);
    }
  });

  it('Stripe: the money-reconciliation L5 gate still matches (and still flags) minimized checkout receipts', async () => {
    const recon = await createTestTenant(pool);
    const matchedIntent = `pi_${crypto.randomUUID()}`;
    const mismatchIntent = `pi_${crypto.randomUUID()}`;
    const invMatch = await seedPaidInvoice(pool, recon, { amountCents: 30000, paymentIntent: matchedIntent });
    const invMismatch = await seedPaidInvoice(pool, recon, { amountCents: 20000, paymentIntent: mismatchIntent });

    async function settle(invoiceId: string, amountTotal: number, paymentIntent: unknown): Promise<string> {
      const eventId = `evt_${crypto.randomUUID()}`;
      const { event } = await handleWebhookEvent(
        'stripe',
        'checkout.session.completed',
        stripeCheckoutSessionData({
          tenantId: recon.tenantId,
          invoiceId,
          amountTotal,
          paymentIntent: paymentIntent as string,
        }),
        eventId,
        webhooks,
      );
      await webhooks.updateStatus(event.id, 'processed');
      const payload = await storedPayload('stripe', eventId);
      expect(findPii(payload)).toEqual([]);
      return event.id;
    }
    // Expanded payment_intent object: the receipt keeps only its id, which
    // the reader's `payment_intent->>'id'` branch still resolves.
    const matched = await settle(invMatch, 30000, { id: matchedIntent, object: 'payment_intent', receipt_email: 'x@y.z' });
    const mismatched = await settle(invMismatch, 30000, mismatchIntent);

    const summary = await runMoneyReconciliationSweep({
      reader: new PgMoneyReconciliationReader(pool),
      listTenantIds: async () => [recon.tenantId],
      logger,
    });
    expect(summary.failedTenants).toBe(0);
    expect(summary.gates.l5).toEqual({ checked: 2, violations: 1, unverifiable: 0 });
    expect(summary.violatingEventIds).toEqual([mismatched]);
    expect(summary.violatingEventIds).not.toContain(matched);
  });

  it('Stripe: dedup and retry claim are unchanged on a minimized receipt', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const data = stripeChargeRefundedData({ tenantId: tenant.tenantId, invoiceId: crypto.randomUUID(), paymentId: 'p' });
    const first = await handleWebhookEvent('stripe', 'charge.refunded', data, eventId, webhooks);
    await webhooks.updateStatus(first.event.id, 'failed', 'charge.refunded before checkout');
    // A failed row is retry-eligible: exactly one claim, same row id.
    const retry = await handleWebhookEvent('stripe', 'charge.refunded', data, eventId, webhooks);
    expect(retry.duplicate).toBe(false);
    expect(retry.event.id).toBe(first.event.id);
    await webhooks.updateStatus(first.event.id, 'processed');
    const replay = await handleWebhookEvent('stripe', 'charge.refunded', data, eventId, webhooks);
    expect(replay.duplicate).toBe(true);
    expect(findPii(await storedPayload('stripe', eventId))).toEqual([]);
  });

  it('Clerk: a user.created receipt holds the user id only (staff PII dropped)', async () => {
    const svixId = `msg_${crypto.randomUUID()}`;
    const userId = `user_${crypto.randomUUID()}`;
    await handleWebhookEvent('clerk', 'user.created', clerkUserEvent('user.created', userId), svixId, webhooks);
    const payload = await storedPayload('clerk', svixId);
    expect(findPii(payload)).toEqual([]);
    expect(payload).toEqual({
      type: 'user.created',
      object: 'event',
      timestamp: 1_790_001_000_000,
      instance_id: 'ins_fixture_1',
      data: { id: userId, object: 'user', created_at: 1_790_001_000_000, updated_at: 1_790_001_000_000 },
    });
  });
});
