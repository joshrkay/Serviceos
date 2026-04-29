import { describe, it, expect, vi } from 'vitest';
import {
  createPaymentLinkProvider,
  MockPaymentLinkProvider,
} from '../../src/payments/payment-link-provider';
import { StripePaymentLinkProvider } from '../../src/payments/stripe-payment-link';
import { InMemoryPaymentReadinessRepository } from '../../src/invoices/payment-readiness';

describe('P5-017: MockPaymentLinkProvider production guard', () => {
  function makeDeps(logger?: { warn: ReturnType<typeof vi.fn> }) {
    return {
      readinessRepo: new InMemoryPaymentReadinessRepository(),
      logger: logger ?? { warn: vi.fn() },
    };
  }

  describe('Production guard', () => {
    it('throws when NODE_ENV=production and STRIPE_SECRET_KEY is missing', () => {
      expect(() =>
        createPaymentLinkProvider({ NODE_ENV: 'production' }, makeDeps()),
      ).toThrow(/MockPaymentLinkProvider is forbidden in production/);
    });

    it('throws when NODE_ENV=prod (alias) and STRIPE_SECRET_KEY is missing', () => {
      expect(() =>
        createPaymentLinkProvider({ NODE_ENV: 'prod' }, makeDeps()),
      ).toThrow(/forbidden in production/);
    });

    it('does not log a dev warning when throwing in production', () => {
      const logger = { warn: vi.fn() };
      expect(() =>
        createPaymentLinkProvider({ NODE_ENV: 'production' }, makeDeps(logger)),
      ).toThrow();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Real provider — Stripe', () => {
    it('returns StripePaymentLinkProvider when STRIPE_SECRET_KEY is present (production)', () => {
      const provider = createPaymentLinkProvider(
        { NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_test123' },
        makeDeps(),
      );
      expect(provider).toBeInstanceOf(StripePaymentLinkProvider);
    });

    it('returns StripePaymentLinkProvider when STRIPE_SECRET_KEY is present (development)', () => {
      const provider = createPaymentLinkProvider(
        { NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_test123' },
        makeDeps(),
      );
      expect(provider).toBeInstanceOf(StripePaymentLinkProvider);
    });

    it('accepts STRIPE_API_KEY as a legacy alias for STRIPE_SECRET_KEY', () => {
      const provider = createPaymentLinkProvider(
        { NODE_ENV: 'production', STRIPE_API_KEY: 'sk_live_legacy' },
        makeDeps(),
      );
      expect(provider).toBeInstanceOf(StripePaymentLinkProvider);
    });

    it('does not log a dev warning when the real provider is selected', () => {
      const logger = { warn: vi.fn() };
      createPaymentLinkProvider(
        { NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_x' },
        makeDeps(logger),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Dev fallback — Mock', () => {
    it('returns MockPaymentLinkProvider in development without a Stripe key', () => {
      const provider = createPaymentLinkProvider(
        { NODE_ENV: 'development' },
        makeDeps(),
      );
      expect(provider).toBeInstanceOf(MockPaymentLinkProvider);
    });

    it('returns MockPaymentLinkProvider in dev (alias) without a Stripe key', () => {
      const provider = createPaymentLinkProvider({ NODE_ENV: 'dev' }, makeDeps());
      expect(provider).toBeInstanceOf(MockPaymentLinkProvider);
    });

    it('returns MockPaymentLinkProvider in test without a Stripe key', () => {
      const provider = createPaymentLinkProvider({ NODE_ENV: 'test' }, makeDeps());
      expect(provider).toBeInstanceOf(MockPaymentLinkProvider);
    });

    it('returns MockPaymentLinkProvider when NODE_ENV is undefined (defaults to non-prod)', () => {
      const provider = createPaymentLinkProvider({}, makeDeps());
      expect(provider).toBeInstanceOf(MockPaymentLinkProvider);
    });
  });

  describe('Dev mode warning', () => {
    it('logs a warning in development when using the mock provider', () => {
      const logger = { warn: vi.fn() };
      createPaymentLinkProvider({ NODE_ENV: 'development' }, makeDeps(logger));
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [message] = logger.warn.mock.calls[0];
      expect(message).toMatch(/MockPaymentLinkProvider/);
      expect(message).toMatch(/STRIPE_SECRET_KEY/);
    });

    it('logs a warning in test when using the mock provider', () => {
      const logger = { warn: vi.fn() };
      createPaymentLinkProvider({ NODE_ENV: 'test' }, makeDeps(logger));
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('falls back to console.warn when no logger is provided', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        createPaymentLinkProvider(
          { NODE_ENV: 'development' },
          { readinessRepo: new InMemoryPaymentReadinessRepository() },
        );
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
});
