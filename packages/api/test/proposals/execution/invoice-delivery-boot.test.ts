import { describe, it, expect } from 'vitest';
import { resolveInvoiceDeliveryProvider } from '../../../src/proposals/execution/invoice-delivery-factory';

describe('invoice delivery provider', () => {
  it('throws in production when SendService is not configured', () => {
    expect(() =>
      resolveInvoiceDeliveryProvider({
        nodeEnv: 'production',
        sendService: undefined,
      }),
    ).toThrow(/SendService|delivery/i);
  });

  it('returns noop in test env when SendService is not configured', () => {
    const provider = resolveInvoiceDeliveryProvider({
      nodeEnv: 'test',
      sendService: undefined,
    });
    expect(provider.constructor.name).toContain('Noop');
  });
});
