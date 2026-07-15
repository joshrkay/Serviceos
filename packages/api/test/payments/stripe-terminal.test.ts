import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import {
  createTerminalConnectionToken,
  createTerminalPaymentIntent,
  createTerminalSession,
  ensureTerminalLocation,
  fetchConnectAccountBusinessAddress,
} from '../../src/payments/stripe-terminal';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';

function makeOkFetcher(bodyJson: unknown): MockedFunction<StripeFetch> {
  const spy = vi.fn() as MockedFunction<StripeFetch>;
  spy.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => bodyJson,
  });
  return spy;
}

describe('stripe-terminal', () => {
  const config = { apiKey: 'sk_test', stripeAccountId: 'acct_field_1' };

  it('createTerminalConnectionToken sends Stripe-Account header', async () => {
    const spy = makeOkFetcher({ secret: 'pst_test_secret' });
    const result = await createTerminalConnectionToken(config, spy);
    expect(result.secret).toBe('pst_test_secret');
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain('/v1/terminal/connection_tokens');
    expect(init.headers['Stripe-Account']).toBe('acct_field_1');
  });

  it('ensureTerminalLocation reuses an existing id without calling Stripe', async () => {
    const spy = makeOkFetcher({ id: 'tml_new' });
    const result = await ensureTerminalLocation(
      config,
      {
        displayName: 'Shop',
        address: {
          line1: '1 Main',
          city: 'Austin',
          postalCode: '78701',
          country: 'US',
        },
        existingLocationId: 'tml_existing',
      },
      spy,
    );
    expect(result.locationId).toBe('tml_existing');
    expect(spy).not.toHaveBeenCalled();
  });

  it('ensureTerminalLocation creates a location on Connect', async () => {
    const spy = makeOkFetcher({ id: 'tml_created' });
    const result = await ensureTerminalLocation(
      config,
      {
        displayName: 'Shop',
        address: {
          line1: '1 Main',
          city: 'Austin',
          postalCode: '78701',
          country: 'US',
        },
      },
      spy,
    );
    expect(result.locationId).toBe('tml_created');
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain('/v1/terminal/locations');
    expect(init.headers['Stripe-Account']).toBe('acct_field_1');
    expect(init.body).toContain('address%5Bline1%5D=1+Main');
  });

  it('fetchConnectAccountBusinessAddress reads company address', async () => {
    const spy = makeOkFetcher({
      company: {
        address: {
          line1: '9 Oak',
          city: 'Denver',
          postal_code: '80202',
          country: 'US',
          state: 'CO',
        },
      },
    });
    const address = await fetchConnectAccountBusinessAddress('sk_test', 'acct_x', spy);
    expect(address).toEqual({
      line1: '9 Oak',
      line2: undefined,
      city: 'Denver',
      state: 'CO',
      postalCode: '80202',
      country: 'US',
    });
  });

  it('createTerminalSession reuses location and returns token + locationId', async () => {
    const spy = makeOkFetcher({ secret: 'pst_sess' });
    const result = await createTerminalSession(
      config,
      { displayName: 'Shop', existingLocationId: 'tml_cached' },
      spy,
    );
    expect(result).toEqual({
      secret: 'pst_sess',
      locationId: 'tml_cached',
      locationCreated: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('connection_tokens');
  });

  it('createTerminalSession creates location when missing and address exists', async () => {
    const spy = vi.fn(async (url: string) => {
      if (url.includes('/v1/accounts/')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            company: {
              address: {
                line1: '1 Main',
                city: 'Austin',
                postal_code: '78701',
                country: 'US',
              },
            },
          }),
        };
      }
      if (url.includes('/terminal/locations')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ id: 'tml_new' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ secret: 'pst_new' }),
      };
    }) as MockedFunction<StripeFetch>;

    const result = await createTerminalSession(
      config,
      { displayName: 'Shop', existingLocationId: null },
      spy,
    );
    expect(result.locationId).toBe('tml_new');
    expect(result.locationCreated).toBe(true);
    expect(result.secret).toBe('pst_new');
  });

  it('createTerminalSession errors when Connect address is missing', async () => {
    const spy = makeOkFetcher({ company: { address: {} } });
    await expect(
      createTerminalSession(config, { displayName: 'Shop' }, spy),
    ).rejects.toMatchObject({ code: 'TERMINAL_LOCATION_ADDRESS_REQUIRED' });
  });

  it('createTerminalPaymentIntent uses card_present only and Connect header', async () => {
    const spy = makeOkFetcher({ id: 'pi_term_1', client_secret: 'pi_term_1_secret' });
    const result = await createTerminalPaymentIntent(
      config,
      {
        amount: 9900,
        currency: 'usd',
        tenantId: 'tenant-1',
        invoiceId: '11111111-1111-4111-8111-111111111111',
        purpose: 'invoice',
      },
      spy,
    );
    expect(result.paymentIntentId).toBe('pi_term_1');
    const [, init] = spy.mock.calls[0];
    expect(init.headers['Stripe-Account']).toBe('acct_field_1');
    expect(init.headers['Idempotency-Key']).toContain('acct_field_1');
    expect(init.body).toContain('payment_method_types');
    expect(init.body).toContain('card_present');
    expect(init.body).not.toContain('automatic_payment_methods');
    expect(init.body).toContain('invoice_id');
  });

  it('rejects missing Connect account id', async () => {
    await expect(
      createTerminalConnectionToken({ apiKey: 'sk_test', stripeAccountId: '' }),
    ).rejects.toThrow(/stripeAccountId/);
  });

  it('rejects non-positive amount', async () => {
    await expect(
      createTerminalPaymentIntent(config, {
        amount: 0,
        currency: 'usd',
        tenantId: 't1',
        invoiceId: '11111111-1111-4111-8111-111111111111',
        purpose: 'invoice',
      }),
    ).rejects.toThrow(/positive integer/);
  });
});
