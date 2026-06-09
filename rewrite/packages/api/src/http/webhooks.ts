import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from './deps';
import { defineCommand } from '../core/commands';
import {
  ingestWebhook,
  markWebhookProcessed,
  verifyHmacSignature,
  verifyStripeSignature,
} from '../modules/webhooks/base';
import { handleInboundSms, verifyTwilioSignature } from '../modules/comms/inbound';
import { recordInboundMessageCommand } from '../modules/comms/messages';

const stripeEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({
    object: z.object({
      id: z.string(),
      amount_received: z.number().int().optional(),
      metadata: z.record(z.string()).optional(),
    }),
  }),
});

const voiceEventSchema = z.object({
  callId: z.string().min(1),
  to: z.string().min(1),
  from: z.string().min(1),
  transcript: z.string().min(1).max(50_000),
});

/**
 * Webhook surface. Pattern per provider: verify signature -> dedup via the
 * webhook_events ledger -> hand off to a job / command. Handlers never do
 * heavy work inline.
 */
export async function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config, db, jobs, bus } = deps;

  app.post('/webhooks/stripe', async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    const rawBody = request.rawBody ?? '';
    const signatureValid = Boolean(
      config.stripeWebhookSecret &&
        typeof signature === 'string' &&
        verifyStripeSignature(config.stripeWebhookSecret, rawBody, signature),
    );
    if (config.stripeWebhookSecret && !signatureValid) {
      return reply.status(401).send({ message: 'invalid signature' });
    }
    const parsed = stripeEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: 'malformed event' });

    const ingestion = await ingestWebhook(db, {
      provider: 'stripe',
      externalId: parsed.data.id,
      signatureValid,
      payload: parsed.data,
    });
    if (!ingestion.fresh) return reply.status(200).send({ received: true, duplicate: true });

    if (parsed.data.type === 'payment_intent.succeeded') {
      const intent = parsed.data.data.object;
      const tenantId = intent.metadata?.tenant_id;
      const invoiceId = intent.metadata?.invoice_id;
      if (tenantId && invoiceId && intent.amount_received) {
        await jobs.send(
          'money.record-stripe-payment',
          {
            tenantId,
            invoiceId,
            amountCents: intent.amount_received,
            externalRef: intent.id,
          },
          { singletonKey: intent.id },
        );
        await markWebhookProcessed(db, ingestion.webhookEventId!, { status: 'processed' });
        return reply.status(200).send({ received: true });
      }
    }
    await markWebhookProcessed(db, ingestion.webhookEventId!, { status: 'skipped' });
    return reply.status(200).send({ received: true });
  });

  app.post('/webhooks/twilio/sms', async (request, reply) => {
    const params = request.body as Record<string, string>;
    if (config.twilioAuthToken) {
      const signature = request.headers['x-twilio-signature'];
      const url = `${request.protocol}://${request.headers.host}${request.url}`;
      if (
        typeof signature !== 'string' ||
        !verifyTwilioSignature(config.twilioAuthToken, url, params, signature)
      ) {
        return reply.status(401).send({ message: 'invalid signature' });
      }
    }
    const from = params.From;
    const to = params.To;
    const body = params.Body;
    const messageSid = params.MessageSid;
    if (!from || !to || !body) return reply.status(400).send({ message: 'missing fields' });

    const result = await handleInboundSms(
      { db, bus, undoWindowSeconds: config.undoWindowSeconds },
      { from, to, body, externalId: messageSid },
    );
    if (!result) return reply.status(404).send({ message: 'unknown number' });

    reply.header('content-type', 'text/xml');
    const twiml = result.reply
      ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(result.reply)}</Message></Response>`
      : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
    return reply.status(200).send(twiml);
  });

  app.post('/webhooks/voice/completed', async (request, reply) => {
    const rawBody = request.rawBody ?? '';
    const signature = request.headers['x-voice-signature'];
    const signatureValid = Boolean(
      config.voiceWebhookSecret &&
        typeof signature === 'string' &&
        verifyHmacSignature(config.voiceWebhookSecret, rawBody, signature),
    );
    if (config.voiceWebhookSecret && !signatureValid) {
      return reply.status(401).send({ message: 'invalid signature' });
    }
    const parsed = voiceEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: 'malformed event' });

    const ingestion = await ingestWebhook(db, {
      provider: 'voice',
      externalId: parsed.data.callId,
      signatureValid,
      payload: parsed.data,
    });
    if (!ingestion.fresh) return reply.status(200).send({ received: true, duplicate: true });

    const tenant = await db.admin.query<{ id: string }>(`SELECT id FROM tenants WHERE phone = $1`, [
      parsed.data.to,
    ]);
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) {
      await markWebhookProcessed(db, ingestion.webhookEventId!, { status: 'skipped', error: 'unknown number' });
      return reply.status(200).send({ received: true });
    }

    await bus.execute(
      processInboundVoiceCommand,
      { tenantId, actor: { type: 'system', id: 'voice-inbound' } },
      {
        from: parsed.data.from,
        to: parsed.data.to,
        transcript: parsed.data.transcript,
        callId: parsed.data.callId,
      },
    );
    await markWebhookProcessed(db, ingestion.webhookEventId!, { status: 'processed' });
    return reply.status(200).send({ received: true });
  });
}

const processInboundVoiceCommand = defineCommand({
  name: 'comms.process_inbound_voice',
  input: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    transcript: z.string().min(1).max(50_000),
    callId: z.string().min(1),
  }),
  async run(ctx, input) {
    const recorded = await ctx.invoke(recordInboundMessageCommand, {
      channel: 'voice' as const,
      from: input.from,
      to: input.to,
      body: input.transcript,
      externalId: `call:${input.callId}`,
    });
    if (!recorded.duplicate) {
      ctx.enqueue({
        topic: 'ai.extract-intent',
        payload: { messageId: recorded.messageId, source: 'voice' },
        dedupeKey: `extract-intent:${recorded.messageId}`,
      });
    }
    return recorded;
  },
});

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
