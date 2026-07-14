import { describe, it, expect, vi } from 'vitest';
import {
  prepareTerminalCollect,
  TerminalApiError,
  createTerminalPaymentIntent,
} from './terminal';
import type { AuthedFetch } from './me';

function mockClient(handlers: Record<string, { status: number; body: unknown }>): AuthedFetch {
  return (async (path: string) => {
    const key = Object.keys(handlers).find((k) => path.includes(k));
    const h = key ? handlers[key] : { status: 404, body: { error: 'NOT_FOUND' } };
    return {
      ok: h.status >= 200 && h.status < 300,
      status: h.status,
      json: async () => h.body,
    } as Response;
  }) as AuthedFetch;
}

describe('mobile terminal API', () => {
  it('prepareTerminalCollect returns connection + payment', async () => {
    const client = mockClient({
      'connection-token': {
        status: 200,
        body: { secret: 'pst_x', stripeAccountId: 'acct_1' },
      },
      'payment-intents': {
        status: 200,
        body: {
          clientSecret: 'pi_secret',
          paymentIntentId: 'pi_1',
          stripeAccountId: 'acct_1',
          amountCents: 5000,
          currency: 'usd',
          invoiceId: 'inv-1',
        },
      },
    });
    const prepared = await prepareTerminalCollect(client, 'inv-1');
    expect(prepared.connection.secret).toBe('pst_x');
    expect(prepared.payment.amountCents).toBe(5000);
  });

  it('maps CONNECT_REQUIRED from the API', async () => {
    const client = mockClient({
      'payment-intents': {
        status: 409,
        body: { error: 'CONNECT_REQUIRED', message: 'Enable Connect' },
      },
    });
    await expect(createTerminalPaymentIntent(client, 'inv-1')).rejects.toMatchObject({
      code: 'CONNECT_REQUIRED',
      status: 409,
    } satisfies Partial<TerminalApiError>);
  });
});
