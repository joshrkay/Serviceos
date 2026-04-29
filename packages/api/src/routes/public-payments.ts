/**
 * P5-016 — Public payments router.
 *
 * Unauthenticated, view-token gated endpoint that returns a Stripe
 * PaymentIntent `client_secret` so the customer's browser can render
 * `<PaymentElement>` and confirm the payment directly with Stripe — card
 * data never touches our server.
 *
 * Auth model: the public payment page receives a long view-token at the
 * end of an SMS/email link. We resolve the invoice by token (NOT by
 * tenant) and then enforce that:
 *   1. the body's `invoiceId` matches the row found by token
 *   2. the invoice is in a payable state (open / partially_paid)
 * Stripe is configured at the app level and may be `null` in dev/test —
 * in that case we return 503 so the frontend can show a clear message.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { InvoiceRepository } from '../invoices/invoice';
import {
  createPaymentIntent,
  StripeFetch,
  StripePaymentIntentConfig,
} from '../payments/stripe-payment-intent';
import { toErrorResponse } from '../shared/errors';

const requestSchema = z.object({
  invoiceId: z.string().min(1, 'invoiceId is required'),
  viewToken: z.string().min(16, 'viewToken is too short'),
});

export interface PublicPaymentsDeps {
  invoiceRepo: InvoiceRepository;
  stripeConfig: StripePaymentIntentConfig | null;
  /** Optional fetch override — used to mock Stripe in tests. */
  stripeFetch?: StripeFetch;
}

export function createPublicPaymentsRouter(deps: PublicPaymentsDeps): Router {
  const router = Router();

  router.post('/create-payment-intent', async (req: Request, res: Response) => {
    try {
      const { invoiceId, viewToken } = requestSchema.parse(req.body);

      // Public path — no tenant context. The view-token is the secret.
      if (!deps.invoiceRepo.findByViewToken) {
        res.status(503).json({
          error: 'NOT_SUPPORTED',
          message: 'Token lookup not supported',
        });
        return;
      }

      const invoice = await deps.invoiceRepo.findByViewToken(viewToken);
      // Constant-ish behavior: same 404 for "no invoice" and "wrong invoice id"
      // so the endpoint can't be used to enumerate ids by probing.
      if (!invoice || invoice.id !== invoiceId) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: 'Invoice not found',
        });
        return;
      }

      // Reject already-paid / voided / canceled invoices so we don't create
      // a payment intent that can't be reconciled.
      const PAYABLE = ['open', 'partially_paid'];
      if (!PAYABLE.includes(invoice.status)) {
        res.status(409).json({
          error: 'INVALID_STATE',
          message: `Invoice is ${invoice.status}`,
        });
        return;
      }

      if (invoice.amountDueCents <= 0) {
        res.status(409).json({
          error: 'INVALID_STATE',
          message: 'Invoice has no outstanding balance',
        });
        return;
      }

      if (!deps.stripeConfig) {
        // Dev/test fallback when STRIPE_SECRET_KEY is unset. Surface a
        // clear, distinct error rather than a 500 so the frontend's
        // "Stripe not configured" branch can fire.
        res.status(503).json({
          error: 'STRIPE_NOT_CONFIGURED',
          message: 'Stripe is not configured in this environment',
        });
        return;
      }

      const { clientSecret, paymentIntentId } = await createPaymentIntent(
        deps.stripeConfig,
        {
          amount: invoice.amountDueCents,
          currency: 'usd',
          invoiceId: invoice.id,
          tenantId: invoice.tenantId,
        },
        deps.stripeFetch,
      );

      res.status(200).json({ clientSecret, paymentIntentId });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
