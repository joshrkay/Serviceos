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
import { ConnectAccountResolver } from '../invoices/public-invoice-service';
import {
  createPaymentIntent,
  StripeFetch,
  StripePaymentIntentConfig,
} from '../payments/stripe-payment-intent';
import { asyncRoute } from '../middleware/async-route';

const requestSchema = z.object({
  invoiceId: z.string().min(1, 'invoiceId is required'),
  viewToken: z.string().min(16, 'viewToken is too short'),
});

export interface PublicPaymentsDeps {
  invoiceRepo: InvoiceRepository;
  stripeConfig: StripePaymentIntentConfig | null;
  /**
   * ISO 4217 currency code (lowercase per Stripe convention) used when
   * creating PaymentIntents. Defaults to `'usd'`. Surfaced on the deps
   * interface so a tenant- or env-driven default can be threaded in
   * later without re-touching the route handler — see PR #203 review.
   * Multi-currency support proper (per-invoice currency) is a separate
   * follow-up that requires a `currency` column on `invoices`.
   */
  defaultCurrency?: string;
  /** Optional fetch override — used to mock Stripe in tests. */
  stripeFetch?: StripeFetch;
  /**
   * When present and the tenant has charges enabled, PaymentIntents are
   * created as Connect direct charges (`Stripe-Account` header).
   */
  connectAccountResolver?: ConnectAccountResolver;
}

export function createPublicPaymentsRouter(deps: PublicPaymentsDeps): Router {
  const router = Router();

  router.post('/create-payment-intent', asyncRoute(async (req: Request, res: Response) => {
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
    // Constant-ish behavior: same 404 for "no invoice", "wrong invoice id",
    // and "token expired" so the endpoint can't be used to enumerate ids by
    // probing. findByViewToken's SECURITY DEFINER function does NOT filter on
    // expiry, so enforce it here (mirrors PublicInvoiceService.lookupByToken) —
    // otherwise an expired pay link keeps minting Stripe payment intents.
    if (
      !invoice ||
      invoice.id !== invoiceId ||
      (invoice.viewTokenExpiresAt && invoice.viewTokenExpiresAt < new Date())
    ) {
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

    const connect = deps.connectAccountResolver
      ? await deps.connectAccountResolver
          .resolveTenantConnectAccount(invoice.tenantId)
          .catch(() => null)
      : null;
    const stripeAccountId =
      connect && connect.chargesEnabled ? connect.accountId : null;

    const { clientSecret, paymentIntentId } = await createPaymentIntent(
      deps.stripeConfig,
      {
        amount: invoice.amountDueCents,
        currency: deps.defaultCurrency ?? 'usd',
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        ...(stripeAccountId ? { stripeAccountId } : {}),
      },
      deps.stripeFetch,
    );

    res.status(200).json({ clientSecret, paymentIntentId, stripeAccountId });
  }));

  /**
   * P5-018 — Public invoice-status polling endpoint.
   *
   * View-token gated (the same secret used to render the public payment
   * page). Lets the customer's browser poll for status transitions while
   * an async payment (ACH / processing intent) settles via the Stripe
   * webhook. Response is intentionally minimal — it never exposes
   * sensitive fields like payment-method details, customer PII, or
   * line items.
   *
   * Already-paid invoices return 200 with `status: 'paid'` so the page
   * can short-circuit polling without needing a 4xx-aware retry loop.
   */
  const statusQuerySchema = z.object({
    token: z.string().min(16, 'token is too short'),
  });

  router.get('/status/:invoiceId', asyncRoute(async (req: Request, res: Response) => {
    const { invoiceId } = req.params;
    const { token: viewToken } = statusQuerySchema.parse(req.query);

    if (!deps.invoiceRepo.findByViewToken) {
      res.status(503).json({
        error: 'NOT_SUPPORTED',
        message: 'Token lookup not supported',
      });
      return;
    }

    const invoice = await deps.invoiceRepo.findByViewToken(viewToken);
    // Same opacity model as create-payment-intent: a token mismatch, an id
    // mismatch, and an expired token all return identical 404s so the
    // endpoint can't be used to enumerate ids. findByViewToken does not
    // enforce expiry, so check it here too.
    if (
      !invoice ||
      invoice.id !== invoiceId ||
      (invoice.viewTokenExpiresAt && invoice.viewTokenExpiresAt < new Date())
    ) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Invoice not found',
      });
      return;
    }

    res.status(200).json({
      status: invoice.status,
      amountDueCents: invoice.amountDueCents,
      amountPaidCents: invoice.amountPaidCents,
      // `paidAt` is reserved for a future schema column. Surfaced as
      // `null` today so the frontend hook contract is stable across
      // the rollout.
      paidAt: null,
    });
  }));

  return router;
}
