/**
 * Shared Stripe.js loader that optionally scopes Elements to a Connect
 * account (direct charges). Call after the server returns `stripeAccountId`
 * so the client secret and Stripe.js account context match.
 */
import { loadStripe, type Stripe } from '@stripe/stripe-js';

export function loadStripeForAccount(
  publishableKey: string,
  stripeAccountId: string | null | undefined,
): Promise<Stripe | null> {
  if (!publishableKey) return Promise.resolve(null);
  const account = stripeAccountId?.trim();
  return account
    ? loadStripe(publishableKey, { stripeAccount: account })
    : loadStripe(publishableKey);
}
