/**
 * Offline Stripe stubs for Playwright E2E.
 *
 * W1-4 proves `/pay/:id` status polling (open → paid in place) without
 * real Stripe Elements / js.stripe.com. We fulfill Vite's prebundled
 * `@stripe/*` deps with minimal ESM modules that:
 *   - `loadStripe` resolves to a fake Stripe object
 *   - `<Elements>` / `<PaymentElement>` render placeholders
 *   - `useStripe().confirmPayment` returns a controllable result
 *
 * Call `installStripeStub` before the first `page.goto`. Override the
 * confirm result with `setStripeConfirmResult` after the page boots.
 */

import type { Page } from '@playwright/test';

export type StripeConfirmResult =
  | { paymentIntent: { id: string; status: string } }
  | { error: { message: string } };

const STRIPE_JS_STUB = `
export function loadStripe() {
  return Promise.resolve({
    confirmPayment: async () => {
      const fn = globalThis.__stripeConfirmPayment;
      if (typeof fn === 'function') return fn();
      return { paymentIntent: { id: 'pi_e2e_stub', status: 'succeeded' } };
    },
  });
}
`;

const REACT_STRIPE_STUB = `
import React from ${JSON.stringify('/node_modules/.vite/deps/react.js')};

export function Elements({ children }) {
  return React.createElement('div', { 'data-testid': 'stripe-elements' }, children);
}

export function PaymentElement() {
  return React.createElement(
    'div',
    { 'data-testid': 'stripe-payment-element' },
    '[card fields stub]',
  );
}

export function useStripe() {
  return {
    confirmPayment: async (opts) => {
      const fn = globalThis.__stripeConfirmPayment;
      if (typeof fn === 'function') return fn(opts);
      return { paymentIntent: { id: 'pi_e2e_stub', status: 'succeeded' } };
    },
  };
}

export function useElements() {
  return {};
}
`;

function isStripeViteDep(url: URL): boolean {
  const path = url.pathname;
  return (
    path.includes('/@stripe_stripe-js') ||
    path.includes('/@stripe_react-stripe-js') ||
    path.endsWith('/@stripe/stripe-js') ||
    path.endsWith('/@stripe/react-stripe-js') ||
    /\/node_modules\/@stripe\//.test(path)
  );
}

/**
 * Install Stripe stubs + a publishable-key runtime override so the pay
 * page does not take the "Stripe not configured" branch.
 */
export async function installStripeStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const existing =
      (window as unknown as { __APP_CONFIG__?: Record<string, string | undefined> })
        .__APP_CONFIG__ ?? {};
    (window as unknown as { __APP_CONFIG__: Record<string, string | undefined> }).__APP_CONFIG__ = {
      ...existing,
      VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_e2e_stub',
    };
    (globalThis as unknown as { __stripeConfirmPayment?: () => unknown }).__stripeConfirmPayment =
      async () => ({ paymentIntent: { id: 'pi_e2e_stub', status: 'processing' } });
  });

  await page.route(isStripeViteDep, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const isReact = path.includes('react-stripe');
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: isReact ? REACT_STRIPE_STUB : STRIPE_JS_STUB,
    });
  });
}

/** Override confirmPayment result after the document has loaded. */
export async function setStripeConfirmResult(
  page: Page,
  result: StripeConfirmResult,
): Promise<void> {
  await page.evaluate((r) => {
    (globalThis as unknown as { __stripeConfirmPayment: () => unknown }).__stripeConfirmPayment =
      async () => r;
  }, result);
}
