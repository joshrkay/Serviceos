import { Router, Request, Response } from 'express';
import { AppConfig } from '../shared/config';
import { verifyWebhookSignature, handleWebhookEvent, InMemoryWebhookRepository } from './webhook-handler';
import { createLogger } from '../logging/logger';
import { bootstrapTenant, TenantRepository } from '../auth/clerk';
import { SettingsRepository } from '../settings/settings';
import { InvoiceRepository } from '../invoices/invoice';
import { PaymentRepository, recordPayment } from '../invoices/payment';
import { ValidationError } from '../shared/errors';
import { verifyTwilioSignature, reconstructWebhookUrl } from '../telephony/twilio-signature';
import { verifySendGridSignature } from './sendgrid-signature';
import { createAuditEvent, AuditRepository } from '../audit/audit';
import { AuditRepository, createAuditEvent } from '../audit/audit';

const logger = createLogger({ service: 'webhooks', environment: process.env.NODE_ENV || 'dev' });

// Shared in-memory repo for dev — swap for DB-backed repo in production
const webhookRepo = new InMemoryWebhookRepository();

export interface WebhookRouterDeps {
  tenantRepo?: TenantRepository;
  settingsRepo?: SettingsRepository;
  invoiceRepo?: InvoiceRepository;
  paymentRepo?: PaymentRepository;
  stripeWebhookSecret?: string;
  webhookEventRepo?: {
    recordReceipt(provider: string, eventId: string, eventType: string, payload: Record<string, unknown>): Promise<{ inserted: boolean }>;
    markProcessed(provider: string, eventId: string): Promise<void>;
  };
  auditRepo?: AuditRepository;
  integrationResolver?: (tenantId: string) => Promise<{
    tenantId: string;
    provider: 'twilio' | 'sendgrid';
    subaccountSid?: string;
    authTokenPrimary?: string;
    authTokenSecondary?: string;
    sendgridPublicKeyPem?: string;
  } | null>;
  provisioningQueue?: {
    send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string>;
  };
  auditRepo?: AuditRepository;
}

export function createWebhookRouter(config: AppConfig, deps: WebhookRouterDeps = {}): Router {
  const router = Router();

  /**
   * POST /webhooks/clerk
   *
   * Receives Clerk user lifecycle events (user.created, user.updated, etc.).
   * Clerk signs the payload using svix — we verify with CLERK_WEBHOOK_SECRET.
   *
   * Events handled:
   *   user.created  → bootstrapTenant() to create tenant + set public_metadata
   */
  router.post('/clerk', async (req: Request, res: Response) => {
    const signingSecret = config.CLERK_WEBHOOK_SECRET;

    if (!signingSecret) {
      logger.warn('CLERK_WEBHOOK_SECRET not configured — rejecting webhook');
      return res.status(500).json({ error: 'Webhook not configured' });
    }

    // Svix signature format: svix-id, svix-timestamp, svix-signature headers
    const svixId = req.headers['svix-id'] as string;
    const svixTimestamp = req.headers['svix-timestamp'] as string;
    const svixSignature = req.headers['svix-signature'] as string;

    if (!svixId || !svixTimestamp || !svixSignature) {
      return res.status(400).json({ error: 'Missing svix headers' });
    }

    // Reconstruct the signed payload string svix uses: id.timestamp.body
    const rawBody = JSON.stringify(req.body);
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;

    // svix-signature contains comma-separated "v1,<base64sig>" values
    // Extract all v1 signatures and check if any match
    const signatures = svixSignature
      .split(' ')
      .map((s) => s.replace(/^v1,/, ''));

    const secret = Buffer.from(signingSecret.replace(/^whsec_/, ''), 'base64');

    const isValid = signatures.some((sig) =>
      verifyWebhookSignature(signedContent, `t=${svixTimestamp},v1=${sig}`, secret.toString('hex'))
    );

    if (!isValid) {
      logger.warn('Clerk webhook signature verification failed', { svixId });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const eventType = req.body.type as string;
    const payload = req.body as Record<string, unknown>;

    try {
      const { duplicate } = await handleWebhookEvent(
        'clerk',
        eventType,
        payload,
        svixId,
        webhookRepo
      );

      if (duplicate) {
        logger.info('Duplicate webhook event — skipping', { svixId, eventType });
        return res.status(200).json({ received: true, duplicate: true });
      }

      // ── Handle specific event types ─────────────────────────────────────────

      if (eventType === 'user.created') {
        const userData = payload.data as Record<string, unknown>;
        const userId = userData.id as string;
        const emailAddresses = userData.email_addresses as Array<{ email_address: string }>;
        const primaryEmail = emailAddresses?.[0]?.email_address;

        logger.info('user.created webhook received', { userId, email: primaryEmail });

        if (deps.tenantRepo && primaryEmail) {
          const result = await bootstrapTenant(userId, primaryEmail, deps.tenantRepo, {
            settingsRepository: deps.settingsRepo,
          });
          const signupCorrelationId = `signup:${svixId}`;
          logger.info('Tenant bootstrap complete', {
            tenantId: result.tenantId,
            created: result.created,
            settingsSeeded: Boolean(deps.settingsRepo),
            signupCorrelationId,
          });

          if (deps.auditRepo) {
            await deps.auditRepo.create(createAuditEvent({
              tenantId: result.tenantId,
              actorId: userId,
              actorRole: 'owner',
              eventType: 'tenant.signup.bootstrap.completed',
              entityType: 'tenant',
              entityId: result.tenantId,
              correlationId: signupCorrelationId,
              metadata: {
                svixId,
                clerkUserId: userId,
                email: primaryEmail,
                created: result.created,
              },
            }));
          }

          if (deps.provisioningQueue && result.created) {
            const queuePayload = {
              tenantId: result.tenantId,
              ownerId: userId,
              ownerEmail: primaryEmail,
              signupCorrelationId,
              webhookEventId: svixId,
            };

            void deps.provisioningQueue.send(
              'tenant.provisioning.root.requested',
              queuePayload,
              `tenant-provisioning:${result.tenantId}`
            ).then(async (queueMessageId) => {
              if (deps.auditRepo) {
                await deps.auditRepo.create(createAuditEvent({
                  tenantId: result.tenantId,
                  actorId: userId,
                  actorRole: 'owner',
                  eventType: 'tenant.signup.provisioning.enqueued',
                  entityType: 'tenant',
                  entityId: result.tenantId,
                  correlationId: signupCorrelationId,
                  metadata: {
                    queueMessageId,
                    queueType: 'tenant.provisioning.root.requested',
                  },
                }));
              }
              logger.info('Root provisioning orchestration enqueued', {
                tenantId: result.tenantId,
                queueMessageId,
                signupCorrelationId,
              });
            }).catch((err) => {
              logger.error('Failed to enqueue root provisioning orchestration', {
                tenantId: result.tenantId,
                signupCorrelationId,
                error: err instanceof Error ? err.message : 'Unknown error',
              });
            });
          }

          // Write tenant_id back to Clerk user's public_metadata (best-effort)
          if (config.CLERK_SECRET_KEY) {
            try {
              const clerkRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
                method: 'PATCH',
                headers: {
                  'Authorization': `Bearer ${config.CLERK_SECRET_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  public_metadata: { tenant_id: result.tenantId },
                }),
              });
              if (!clerkRes.ok) {
                const errBody = await clerkRes.text();
                logger.error('Failed to update Clerk user metadata', {
                  userId, tenantId: result.tenantId, status: clerkRes.status, body: errBody,
                });
              } else {
                logger.info('Clerk user metadata updated with tenant_id', {
                  userId, tenantId: result.tenantId,
                });
              }
            } catch (err) {
              logger.error('Clerk API call failed', {
                userId, tenantId: result.tenantId,
                error: err instanceof Error ? err.message : 'Unknown error',
              });
            }
          }
        } else if (!deps.tenantRepo) {
          logger.warn('No tenant repository configured — skipping tenant bootstrap');
        }
      }

      await webhookRepo.updateStatus(svixId, 'processed');
      return res.status(200).json({ received: true });

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Webhook processing failed', { svixId, eventType, error: message });
      await webhookRepo.updateStatus(svixId, 'failed', message);
      return res.status(500).json({ error: 'Processing failed' });
    }
  });

  /**
   * POST /webhooks/stripe
   *
   * Receives Stripe events for payment processing. Stripe signs the raw body
   * with HMAC-SHA256 — the route is mounted with express.raw() BEFORE the
   * global express.json() middleware so req.body is a Buffer here.
   *
   * Events handled:
   *   checkout.session.completed → recordPayment() to mark invoice paid
   */
  router.post('/stripe', async (req: Request, res: Response) => {
    const secret = deps.stripeWebhookSecret;
    if (!secret) {
      logger.warn('STRIPE_WEBHOOK_SECRET not configured — rejecting Stripe webhook');
      return res.status(500).json({ error: 'Stripe webhook not configured' });
    }

    const signatureHeader = req.headers['stripe-signature'] as string | undefined;
    if (!signatureHeader) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    // req.body is a Buffer when express.raw() is mounted before express.json().
    // Coerce to string for signature verification; do NOT re-serialize a parsed
    // object (key order changes → signature mismatch).
    const rawBodyStr: string = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : (() => { throw new Error('Body pre-parsed; mount /webhooks/stripe before express.json()'); })();

    // Re-use the existing verifyWebhookSignature() utility — handles timing-safe
    // comparison and the 5-minute timestamp tolerance.
    if (!verifyWebhookSignature(rawBodyStr, signatureHeader, secret)) {
      logger.warn('Stripe webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let event: { id: string; type: string; data: { object: Record<string, unknown> } };
    try {
      event = JSON.parse(rawBodyStr);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Idempotency guard: reject replays and concurrent deliveries of the same
    // Stripe event. webhookRepo is a module-level singleton so the dedup map
    // persists across requests. Uses the existing handleWebhookEvent() pattern.
    const { duplicate } = await handleWebhookEvent(
      'stripe',
      event.type,
      event.data as Record<string, unknown>,
      event.id,
      webhookRepo,
    );
    if (duplicate) {
      logger.info('Duplicate Stripe event — skipping', { eventId: event.id, type: event.type });
      return res.status(200).json({ received: true, duplicate: true });
    }

    logger.info('Stripe webhook received', { eventId: event.id, type: event.type });

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as {
          metadata?: { tenant_id?: string; invoice_id?: string };
          amount_total?: number;
          payment_status?: string;
        };

        // Only process fully-paid sessions. For ACH/bank transfers, Stripe can
        // fire checkout.session.completed with payment_status='unpaid' before
        // funds clear — skip those and wait for the subsequent payment event.
        if (session.payment_status !== 'paid') {
          logger.info('Skipping incomplete Stripe checkout session', {
            eventId: event.id, paymentStatus: session.payment_status,
          });
          await webhookRepo.updateStatus(event.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        const tenantId = session.metadata?.tenant_id;
        const invoiceId = session.metadata?.invoice_id;
        const amountTotal = session.amount_total; // already in cents

        if (!tenantId || !invoiceId || !amountTotal || amountTotal <= 0) {
          logger.warn('Stripe checkout.session.completed missing or invalid metadata', {
            eventId: event.id, tenantId, invoiceId, amountTotal,
          });
          await webhookRepo.updateStatus(event.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        if (!deps.invoiceRepo || !deps.paymentRepo) {
          logger.error('Invoice/payment repos not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Payment processing not configured' });
        }

        try {
          await recordPayment(
            {
              tenantId,
              invoiceId,
              amountCents: amountTotal,
              method: 'credit_card',
              providerReference: 'stripe_checkout',
              processedBy: 'stripe_webhook',
            },
            deps.invoiceRepo,
            deps.paymentRepo,
          );
          logger.info('Invoice marked paid via Stripe checkout', { tenantId, invoiceId, amountTotal });
        } catch (payErr) {
          if (payErr instanceof ValidationError) {
            if (payErr.message.includes('exceeds amount due')) {
              // Overpayment: cap to whatever is still owed and retry.
              const invoice = await deps.invoiceRepo.findById(tenantId, invoiceId);
              if (!invoice || invoice.amountDueCents <= 0) {
                logger.info('Invoice already fully paid (overpayment scenario)', { tenantId, invoiceId });
              } else {
                await recordPayment(
                  {
                    tenantId,
                    invoiceId,
                    amountCents: invoice.amountDueCents,
                    method: 'credit_card',
                    providerReference: 'stripe_checkout',
                    processedBy: 'stripe_webhook',
                  },
                  deps.invoiceRepo,
                  deps.paymentRepo,
                );
                logger.info('Invoice paid at capped amount', {
                  tenantId, invoiceId, requested: amountTotal, paid: invoice.amountDueCents,
                });
              }
            } else if (payErr.message.includes('status')) {
              // Invoice already settled (paid/void/canceled) — idempotent success.
              logger.info('Invoice already settled, ignoring Stripe payment', { tenantId, invoiceId });
            } else {
              throw payErr;
            }
          } else {
            throw payErr;
          }
        }
      }

      await webhookRepo.updateStatus(event.id, 'processed');
      return res.status(200).json({ received: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Stripe webhook processing failed', { eventId: event.id, type: event.type, error: message });
      await webhookRepo.updateStatus(event.id, 'failed', message);
      return res.status(500).json({ error: 'Processing failed' });
    }
  });

  const rejectBound = async (tenantId: string, reason: string, meta: Record<string, unknown>) => {
    if (deps.auditRepo) {
      await deps.auditRepo.create(createAuditEvent({
        tenantId,
        actorId: 'system:webhook',
        actorRole: 'system',
        eventType: 'webhook.auth_failed',
        entityType: 'webhook',
        entityId: reason,
        metadata: meta,
      }));
    }
  };
  const recordTwilio = async (kind: string, req: Request, res: Response) => {
    const tenantId = req.params.tenantId;
    const integration = await deps.integrationResolver?.(tenantId);
    if (!integration || integration.provider !== 'twilio' || integration.tenantId !== tenantId) {
      await rejectBound(tenantId, 'tenant_mismatch', { kind });
      return res.status(403).json({ error: 'Forbidden' });
    }
    const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    const url = reconstructWebhookUrl(req, process.env.PUBLIC_API_URL);
    const sig = req.header('x-twilio-signature');
    const validPrimary = integration.authTokenPrimary
      ? verifyTwilioSignature(sig, url, params, integration.authTokenPrimary)
      : false;
    const validSecondary = !validPrimary && integration.authTokenSecondary
      ? verifyTwilioSignature(sig, url, params, integration.authTokenSecondary)
      : false;
    if (!validPrimary && !validSecondary) {
      await rejectBound(tenantId, 'invalid_signature', { kind });
      return res.status(403).json({ error: 'Forbidden' });
    }
    if ((req.body?.AccountSid as string | undefined) !== integration.subaccountSid) {
      await rejectBound(tenantId, 'account_sid_mismatch', { kind, accountSid: req.body?.AccountSid });
      return res.status(403).json({ error: 'Forbidden' });
    }
    const eventId = (req.body?.MessageSid as string | undefined) ?? (req.body?.CallSid as string | undefined);
    if (!eventId) return res.status(400).json({ error: 'Missing MessageSid/CallSid' });
    if (deps.webhookEventRepo) {
      const rec = await deps.webhookEventRepo.recordReceipt('twilio', eventId, kind, req.body ?? {});
      if (!rec.inserted) return res.status(200).json({ received: true, duplicate: true });
      await deps.webhookEventRepo.markProcessed('twilio', eventId);
    }
    return res.status(200).json({ received: true });
  };
  router.post('/twilio/voice/:tenantId', (req: Request, res: Response) => void recordTwilio('voice', req, res));
  router.post('/twilio/sms/:tenantId', (req: Request, res: Response) => void recordTwilio('sms', req, res));
  router.post('/twilio/status/:tenantId', (req: Request, res: Response) => void recordTwilio('status', req, res));

  router.post('/sendgrid/:tenantId', async (req: Request, res: Response) => {
    const tenantId = req.params.tenantId;
    const integration = await deps.integrationResolver?.(tenantId);
    if (!integration || integration.provider !== 'sendgrid' || integration.tenantId !== tenantId) {
      await rejectBound(tenantId, 'tenant_mismatch', { kind: 'sendgrid' });
      return res.status(403).json({ error: 'Forbidden' });
    }
    const sig = req.header('x-twilio-email-event-webhook-signature');
    const ts = req.header('x-twilio-email-event-webhook-timestamp');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!verifySendGridSignature({ publicKeyPem: integration.sendgridPublicKeyPem ?? '', payload: raw, signatureBase64: sig, timestamp: ts })) {
      await rejectBound(tenantId, 'invalid_signature', { kind: 'sendgrid' });
      return res.status(403).json({ error: 'Forbidden' });
    }
    const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
    const first = Array.isArray(body) ? body[0] : body;
    const eventId = (first?.sg_event_id as string | undefined) ?? (first?.sg_message_id as string | undefined);
    if (deps.webhookEventRepo) {
      const rec = await deps.webhookEventRepo.recordReceipt('sendgrid', eventId, 'event', { events: req.body });
      if (!rec.inserted) return res.status(200).json({ received: true, duplicate: true });
      await deps.webhookEventRepo.markProcessed('sendgrid', eventId);
    }
    return res.status(200).json({ received: true });
  });

  return router;
}
