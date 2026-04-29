import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { AppConfig } from '../shared/config';
import { verifyWebhookSignature, handleWebhookEvent, InMemoryWebhookRepository } from './webhook-handler';
import { createLogger } from '../logging/logger';
import { bootstrapTenant, TenantRepository } from '../auth/clerk';
import { SettingsRepository } from '../settings/settings';
import { InvoiceRepository } from '../invoices/invoice';
import { PaymentRepository, recordPayment } from '../invoices/payment';

const logger = createLogger({ service: 'webhooks', environment: process.env.NODE_ENV || 'dev' });

// Shared in-memory repo for dev — swap for DB-backed repo in production
const webhookRepo = new InMemoryWebhookRepository();

export interface WebhookRouterDeps {
  tenantRepo?: TenantRepository;
  settingsRepo?: SettingsRepository;
  invoiceRepo?: InvoiceRepository;
  paymentRepo?: PaymentRepository;
  stripeWebhookSecret?: string;
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
          logger.info('Tenant bootstrap complete', {
            tenantId: result.tenantId,
            created: result.created,
            settingsSeeded: Boolean(deps.settingsRepo),
          });

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

    // req.body is a Buffer when mounted with express.raw() — coerce to string for hashing.
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    // Stripe signature format: t=<timestamp>,v1=<sig>[,v1=<sig>...]
    const parts = Object.fromEntries(
      signatureHeader.split(',').map((p) => p.split('=') as [string, string])
    );
    const timestamp = parts['t'];
    const v1Sig = parts['v1'];

    if (!timestamp || !v1Sig) {
      return res.status(400).json({ error: 'Malformed stripe-signature header' });
    }

    // Reject stale webhooks (Stripe recommends 5-minute tolerance).
    const MAX_AGE_SECONDS = 300;
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > MAX_AGE_SECONDS) {
      return res.status(400).json({ error: 'Webhook timestamp too old' });
    }

    const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1Sig, 'hex'))) {
      logger.warn('Stripe webhook signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let event: { type: string; data: { object: Record<string, unknown> } };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    logger.info('Stripe webhook received', { type: event.type });

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as {
          metadata?: { tenant_id?: string; invoice_id?: string };
          amount_total?: number;
          payment_status?: string;
        };

        const tenantId = session.metadata?.tenant_id;
        const invoiceId = session.metadata?.invoice_id;
        const amountTotal = session.amount_total; // already in cents

        if (!tenantId || !invoiceId || !amountTotal) {
          logger.warn('Stripe checkout.session.completed missing metadata', {
            tenantId, invoiceId, amountTotal,
          });
          return res.status(200).json({ received: true, skipped: true });
        }

        if (!deps.invoiceRepo || !deps.paymentRepo) {
          logger.error('Invoice/payment repos not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Payment processing not configured' });
        }

        await recordPayment(
          {
            tenantId,
            invoiceId,
            amountCents: amountTotal,
            method: 'credit_card',
            providerReference: `stripe_checkout`,
            processedBy: 'stripe_webhook',
          },
          deps.invoiceRepo,
          deps.paymentRepo,
        );

        logger.info('Invoice marked paid via Stripe checkout', { tenantId, invoiceId, amountTotal });
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Stripe webhook processing failed', { type: event.type, error: message });
      return res.status(500).json({ error: 'Processing failed' });
    }
  });

  return router;
}
