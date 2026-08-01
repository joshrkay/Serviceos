import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadStripeForAccount } from './stripeConnect';

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(() => Promise.resolve({ id: 'stripe' })),
}));

describe('loadStripeForAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls loadStripe with stripeAccount when account id is set', async () => {
    const stripeJs = await import('@stripe/stripe-js');
    await loadStripeForAccount('pk_test_x', 'acct_123');
    expect(stripeJs.loadStripe).toHaveBeenCalledWith('pk_test_x', { stripeAccount: 'acct_123' });
  });

  it('calls loadStripe without options for platform charges', async () => {
    const stripeJs = await import('@stripe/stripe-js');
    await loadStripeForAccount('pk_test_x', null);
    expect(stripeJs.loadStripe).toHaveBeenCalledWith('pk_test_x');
  });

  it('returns null when publishable key is empty', async () => {
    const result = await loadStripeForAccount('', 'acct_123');
    expect(result).toBeNull();
  });
});
