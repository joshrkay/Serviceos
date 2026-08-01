import { describe, it, expect } from 'vitest';
import { resolveInvoiceDeliveryProvider } from '../../../src/proposals/execution/invoice-delivery-factory';
import { resolveEstimateDeliveryProvider } from '../../../src/proposals/execution/estimate-delivery-factory';
import {
  NoopInvoiceDeliveryProvider,
  NoopEstimateDeliveryProvider,
} from '../../../src/proposals/execution/voice-extended-handlers';

describe('resolveInvoiceDeliveryProvider', () => {
  it('throws in production without SendService', () => {
    expect(() =>
      resolveInvoiceDeliveryProvider({ nodeEnv: 'production', sendService: undefined }),
    ).toThrow(/Invoice delivery requires SendService/);
  });

  it('allows noop in production when delivery is opted out', () => {
    const provider = resolveInvoiceDeliveryProvider({
      nodeEnv: 'production',
      sendService: undefined,
      allowNoopInProduction: true,
    });
    expect(provider).toBeInstanceOf(NoopInvoiceDeliveryProvider);
  });

  it('uses noop in development without SendService', () => {
    const provider = resolveInvoiceDeliveryProvider({
      nodeEnv: 'development',
      sendService: undefined,
    });
    expect(provider).toBeInstanceOf(NoopInvoiceDeliveryProvider);
  });
});

describe('resolveEstimateDeliveryProvider', () => {
  it('throws in production without SendService', () => {
    expect(() =>
      resolveEstimateDeliveryProvider({ nodeEnv: 'prod', sendService: undefined }),
    ).toThrow(/Estimate delivery requires SendService/);
  });

  it('allows noop in production when delivery is opted out', () => {
    const provider = resolveEstimateDeliveryProvider({
      nodeEnv: 'staging',
      sendService: undefined,
      allowNoopInProduction: true,
    });
    expect(provider).toBeInstanceOf(NoopEstimateDeliveryProvider);
  });
});
