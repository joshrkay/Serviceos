import { v4 as uuidv4 } from 'uuid';
import { StripePaymentLinkProvider } from './stripe-payment-link';
import type { PaymentReadinessRepository } from '../invoices/payment-readiness';

export interface PaymentLinkRequest {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  customerEmail?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentLinkResult {
  linkId: string;
  linkUrl: string;
  expiresAt?: Date;
  providerReference: string;
}

export interface PaymentLinkProvider {
  generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult>;
  deactivateLink(linkId: string): Promise<void>;
}

export function validatePaymentLinkRequest(request: PaymentLinkRequest): string[] {
  const errors: string[] = [];
  if (!request.tenantId) errors.push('tenantId is required');
  if (!request.invoiceId) errors.push('invoiceId is required');
  if (!request.amountCents || request.amountCents <= 0) errors.push('amountCents must be positive');
  if (!Number.isInteger(request.amountCents)) errors.push('amountCents must be an integer');
  if (!request.currency) errors.push('currency is required');
  return errors;
}

// Mock provider for testing
export class MockPaymentLinkProvider implements PaymentLinkProvider {
  private links: Map<string, PaymentLinkResult & { active: boolean }> = new Map();

  async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
    const errors = validatePaymentLinkRequest(request);
    if (errors.length > 0) throw new Error(`Invalid request: ${errors.join(', ')}`);

    const linkId = uuidv4();
    const result: PaymentLinkResult = {
      linkId,
      linkUrl: `https://pay.mock.com/${linkId}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      providerReference: `mock_${linkId}`,
    };

    this.links.set(linkId, { ...result, active: true });
    return result;
  }

  async deactivateLink(linkId: string): Promise<void> {
    const link = this.links.get(linkId);
    if (link) link.active = false;
  }

  isActive(linkId: string): boolean {
    return this.links.get(linkId)?.active ?? false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P5-017 — Production guard for MockPaymentLinkProvider.
//
// `MockPaymentLinkProvider` returns synthetic `https://pay.mock.com/...` URLs
// that look real but route nowhere. If we ever booted a production process
// without `STRIPE_SECRET_KEY`, the silent fallback would accept payments via
// these synthetic URLs — money would be lost, and the failure mode is silent.
//
// The factory below fails fast at boot:
//   - Stripe key set            → real `StripePaymentLinkProvider`
//   - dev/test, key missing     → `MockPaymentLinkProvider` + dev-mode warning
//   - prod/staging, key missing → throws (refuses to boot)
//
// `app.ts` calls this factory once during `createApp()`, so the throw
// happens at boot before any route is mounted. A follow-up may also extend
// `validateProductionConfig` in `shared/config.ts` to require the key —
// this factory is the canonical guard regardless.
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentLinkProviderEnv {
  NODE_ENV?: string;
  STRIPE_SECRET_KEY?: string;
  // Legacy alias still read by `StripePaymentLinkProvider` directly.
  STRIPE_API_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export interface PaymentLinkProviderDeps {
  readinessRepo: PaymentReadinessRepository;
  // Logger is optional so the factory remains usable from places that don't
  // have the structured logger wired (e.g. unit tests). Defaults to console.
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

function isProduction(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production' || nodeEnv === 'prod';
}

/**
 * Resolves the active `PaymentLinkProvider` for the given environment.
 *
 * @throws Error in production when no Stripe key is present — refuses to
 *   silently fall back to the mock provider.
 */
export function createPaymentLinkProvider(
  env: PaymentLinkProviderEnv,
  deps: PaymentLinkProviderDeps,
): PaymentLinkProvider {
  const stripeKey = env.STRIPE_SECRET_KEY ?? env.STRIPE_API_KEY;

  if (stripeKey) {
    return new StripePaymentLinkProvider(
      { apiKey: stripeKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '' },
      deps.readinessRepo,
    );
  }

  if (isProduction(env.NODE_ENV)) {
    throw new Error(
      'MockPaymentLinkProvider is forbidden in production. ' +
        'Set STRIPE_SECRET_KEY (or STRIPE_API_KEY) to use the real Stripe provider.',
    );
  }

  const logger = deps.logger ?? {
    warn: (msg: string, meta?: Record<string, unknown>) => {
      // eslint-disable-next-line no-console
      console.warn(msg, meta ?? '');
    },
  };
  logger.warn(
    '[payments] ⚠️  STRIPE_SECRET_KEY missing — using MockPaymentLinkProvider. ' +
      'Generated payment URLs (https://pay.mock.com/...) are synthetic and route nowhere. ' +
      'Set STRIPE_SECRET_KEY before deploying outside of dev/test.',
  );
  return new MockPaymentLinkProvider();
}
