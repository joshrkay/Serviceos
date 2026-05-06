import { describe, it, expect, vi } from 'vitest';
import {
  createPaymentLinkProvider,
  MockPaymentLinkProvider,
} from '../../src/payments/payment-link-provider';
import { StripePaymentLinkProvider } from '../../src/payments/stripe-payment-link';

describe('P5-017: MockPaymentLinkProvider production guard', () => {
  function makeDeps(logger?: { warn: ReturnType<typeof vi.fn> }) {
    return {
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
        createPaymentLinkProvider({ NODE_ENV: 'development' });
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('Production-like environments (P5-017 review follow-up)', () => {
    it('throws in NODE_ENV=staging without a Stripe key (treated production-like)', () => {
      expect(() =>
        createPaymentLinkProvider({ NODE_ENV: 'staging' }, makeDeps()),
      ).toThrow(/MockPaymentLinkProvider is forbidden|STRIPE_SECRET_KEY/);
    });

    it('returns StripePaymentLinkProvider in staging when STRIPE_SECRET_KEY is set', () => {
      const provider = createPaymentLinkProvider(
        { NODE_ENV: 'staging', STRIPE_SECRET_KEY: 'sk_test_x' },
        makeDeps(),
      );
      expect(provider).toBeInstanceOf(StripePaymentLinkProvider);
    });

    it('treats empty-string STRIPE_SECRET_KEY as missing and falls back to STRIPE_API_KEY', () => {
      const provider = createPaymentLinkProvider(
        {
          NODE_ENV: 'production',
          STRIPE_SECRET_KEY: '',
          STRIPE_API_KEY: 'sk_legacy_x',
        },
        makeDeps(),
      );
      expect(provider).toBeInstanceOf(StripePaymentLinkProvider);
    });

    it('treats whitespace-only STRIPE_SECRET_KEY as missing in production', () => {
      // Both keys whitespace -> throw, not silent mock.
      expect(() =>
        createPaymentLinkProvider(
          { NODE_ENV: 'production', STRIPE_SECRET_KEY: '   ', STRIPE_API_KEY: '' },
          makeDeps(),
        ),
      ).toThrow(/MockPaymentLinkProvider is forbidden|STRIPE_SECRET_KEY/);
    });
  });
});
