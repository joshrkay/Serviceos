import { Router, Request, Response } from 'express';
import { AppConfig } from '../shared/config';
import { verifyWebhookSignature, handleWebhookEvent, InMemoryWebhookRepository } from './webhook-handler';
import { createLogger } from '../logging/logger';

const logger = createLogger({ service: 'webhooks', environment: process.env.NODE_ENV || 'dev' });

// Shared in-memory repo for dev — swap for DB-backed repo in production
const webhookRepo = new InMemoryWebhookRepository();

export function createWebhookRouter(config: AppConfig): Router {
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

        // TODO: call bootstrapTenant() and write tenant_id back to Clerk
        // public_metadata via Clerk Backend API once DB is connected.
        // For now, log the event — the tenant bootstrap logic is wired and ready.
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

  return router;
}
