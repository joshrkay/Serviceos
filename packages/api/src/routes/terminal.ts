/**
 * Authenticated Stripe Terminal routes for field collection.
 *
 * POST /connection-token — mint a Terminal connection token on Connect
 * POST /payment-intents  — create card_present PI for an open invoice
 *
 * Connect with charges_enabled is required; otherwise CONNECT_REQUIRED
 * so the mobile client can fall back to pay link / cash.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { InvoiceRepository } from '../invoices/invoice';
import { ConnectAccountResolver } from '../invoices/public-invoice-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  createTerminalConnectionToken,
  createTerminalPaymentIntent,
} from '../payments/stripe-terminal';
import { StripeFetch } from '../payments/stripe-payment-intent';
import { asyncRoute } from '../middleware/async-route';

const PAYABLE = new Set(['open', 'partially_paid']);

const paymentIntentBodySchema = z.object({
  invoiceId: z.string().uuid(),
});

export interface TerminalRouterDeps {
  invoiceRepo: InvoiceRepository;
  connectAccountResolver?: ConnectAccountResolver;
  stripeApiKey?: string | null;
  stripeFetch?: StripeFetch;
  auditRepo?: AuditRepository;
  defaultCurrency?: string;
}

async function requireConnectAccount(
  resolver: ConnectAccountResolver | undefined,
  tenantId: string,
): Promise<{ accountId: string }> {
  if (!resolver) {
    throw new AppError(
      'CONNECT_REQUIRED',
      'Stripe Connect is not configured for in-person payments',
      409,
    );
  }
  const connect = await resolver.resolveTenantConnectAccount(tenantId).catch(() => null);
  if (!connect?.chargesEnabled || !connect.accountId) {
    throw new AppError(
      'CONNECT_REQUIRED',
      'Enable Stripe Connect payouts before collecting card-present payments',
      409,
    );
  }
  return { accountId: connect.accountId };
}

export function createTerminalRouter(deps: TerminalRouterDeps): Router {
  const router = Router();

  router.post(
    '/connection-token',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (!deps.stripeApiKey) {
        res.status(503).json({
          error: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured in this environment',
        });
        return;
      }
      const tenantId = req.auth!.tenantId;
      const { accountId } = await requireConnectAccount(deps.connectAccountResolver, tenantId);
      const result = await createTerminalConnectionToken(
        { apiKey: deps.stripeApiKey, stripeAccountId: accountId },
        deps.stripeFetch,
      );
      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role ?? 'technician',
            eventType: 'terminal.connection_token_minted',
            entityType: 'tenant',
            entityId: tenantId,
            metadata: { stripeAccountId: accountId },
          }),
        );
      }
      res.status(200).json({ secret: result.secret, stripeAccountId: accountId });
    }),
  );

  router.post(
    '/payment-intents',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (!deps.stripeApiKey) {
        res.status(503).json({
          error: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured in this environment',
        });
        return;
      }
      const body = paymentIntentBodySchema.parse(req.body);
      const tenantId = req.auth!.tenantId;
      const { accountId } = await requireConnectAccount(deps.connectAccountResolver, tenantId);

      const invoice = await deps.invoiceRepo.findById(tenantId, body.invoiceId);
      if (!invoice) throw new NotFoundError('Invoice', body.invoiceId);
      if (!PAYABLE.has(invoice.status)) {
        throw new ConflictError(`Invoice is not payable (status: ${invoice.status})`);
      }
      if (invoice.amountDueCents <= 0) {
        throw new ValidationError('Invoice has no outstanding balance');
      }

      const result = await createTerminalPaymentIntent(
        { apiKey: deps.stripeApiKey, stripeAccountId: accountId },
        {
          amount: invoice.amountDueCents,
          currency: deps.defaultCurrency ?? 'usd',
          tenantId,
          invoiceId: invoice.id,
          purpose: 'invoice',
        },
        deps.stripeFetch,
      );

      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role ?? 'technician',
            eventType: 'terminal.payment_intent_created',
            entityType: 'invoice',
            entityId: invoice.id,
            metadata: {
              stripeAccountId: accountId,
              paymentIntentId: result.paymentIntentId,
              amountCents: invoice.amountDueCents,
            },
          }),
        );
      }

      res.status(200).json({
        clientSecret: result.clientSecret,
        paymentIntentId: result.paymentIntentId,
        stripeAccountId: accountId,
        amountCents: invoice.amountDueCents,
        currency: deps.defaultCurrency ?? 'usd',
        invoiceId: invoice.id,
      });
    }),
  );

  return router;
}
