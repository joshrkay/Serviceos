import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  PublicInvoiceService,
  ConnectAccountResolver,
} from '../../src/invoices/public-invoice-service';
import {
  Invoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { Customer, InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemorySettingsRepository } from '../../src/settings/settings';

const TENANT = 'tenant-connect-invoice';
const VIEW_TOKEN = 'a-very-long-and-unguessable-token-1234';

/**
 * Tier 4 (Payment methods — PR 2). Asserts that getOrCreateCheckoutUrl
 * routes payments through the tenant's Connect Account when the
 * resolver returns one with charges_enabled. Falls back to the
 * platform charge in every other case.
 */
function jsonOk(body: unknown): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => body, text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeResolver(value: { accountId: string; chargesEnabled: boolean } | null): ConnectAccountResolver {
  return {
    resolveTenantConnectAccount: vi.fn(async () => value),
  };
}

async function setup(opts: { resolver?: ConnectAccountResolver; stripeFetch?: typeof fetch }) {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();
  const jobRepo = new InMemoryJobRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const settingsRepo = new InMemorySettingsRepository();

  await settingsRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Los_Angeles',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const customer: Customer = {
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Sarah',
    lastName: 'Johnson',
    displayName: 'Sarah Johnson',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await customerRepo.create(customer);

  await jobRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    customerId: customer.id,
    locationId: uuidv4(),
    jobNumber: 'JOB-1',
    summary: 'Service',
    status: 'completed',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const job = (await jobRepo.findByTenant(TENANT))[0];

  const invoice: Invoice = {
    id: uuidv4(),
    tenantId: TENANT,
    jobId: job.id,
    invoiceNumber: 'INV-0001',
    status: 'open',
    lineItems: [
      {
        id: uuidv4(),
        description: 'Service',
        quantity: 1,
        unitPriceCents: 50000,
        totalCents: 50000,
        sortOrder: 0,
        taxable: true,
      },
    ],
    totals: {
      subtotalCents: 50000,
      taxableSubtotalCents: 50000,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: 50000,
    },
    amountPaidCents: 0,
    amountDueCents: 50000,
    viewToken: VIEW_TOKEN,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await invoiceRepo.create(invoice);

  const service = new PublicInvoiceService({
    invoiceRepo,
    jobRepo,
    customerRepo,
    settingsRepo,
    paymentRepo,
    stripeConfig: { apiKey: 'sk_test_xxx' },
    connectAccountResolver: opts.resolver,
    stripeFetch: opts.stripeFetch,
  });
  return { service, invoice };
}

describe('PublicInvoiceService.getOrCreateCheckoutUrl — Connect routing (PR 2)', () => {
  it('adds the Stripe-Account header when resolver returns an active connected account', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonOk({ id: 'plink_x', url: 'https://checkout.stripe.com/c/plink_x' }),
    );
    const { service } = await setup({
      resolver: makeResolver({ accountId: 'acct_test_1', chargesEnabled: true }),
      stripeFetch: fetchMock as unknown as typeof fetch,
    });

    const result = await service.getOrCreateCheckoutUrl(VIEW_TOKEN);
    expect(result.url).toBe('https://checkout.stripe.com/c/plink_x');

    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Stripe-Account']).toBe('acct_test_1');
  });

  it('falls back to platform charge when resolver returns null (tenant not onboarded)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonOk({ id: 'plink_y', url: 'https://checkout.stripe.com/c/plink_y' }),
    );
    const { service } = await setup({
      resolver: makeResolver(null),
      stripeFetch: fetchMock as unknown as typeof fetch,
    });

    await service.getOrCreateCheckoutUrl(VIEW_TOKEN);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Stripe-Account']).toBeUndefined();
  });

  it('falls back when Connect account exists but charges are not enabled (KYC incomplete)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonOk({ id: 'plink_z', url: 'https://checkout.stripe.com/c/plink_z' }),
    );
    const { service } = await setup({
      resolver: makeResolver({ accountId: 'acct_test_2', chargesEnabled: false }),
      stripeFetch: fetchMock as unknown as typeof fetch,
    });

    await service.getOrCreateCheckoutUrl(VIEW_TOKEN);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Stripe-Account']).toBeUndefined();
  });

  it('falls back when no resolver is wired (legacy harness)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonOk({ id: 'plink_w', url: 'https://checkout.stripe.com/c/plink_w' }),
    );
    const { service } = await setup({
      stripeFetch: fetchMock as unknown as typeof fetch,
    });

    await service.getOrCreateCheckoutUrl(VIEW_TOKEN);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Stripe-Account']).toBeUndefined();
  });

  it('treats resolver errors as fallback (does not throw)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonOk({ id: 'plink_v', url: 'https://checkout.stripe.com/c/plink_v' }),
    );
    const { service } = await setup({
      resolver: {
        resolveTenantConnectAccount: async () => {
          throw new Error('db hiccup');
        },
      },
      stripeFetch: fetchMock as unknown as typeof fetch,
    });

    const result = await service.getOrCreateCheckoutUrl(VIEW_TOKEN);
    expect(result.url).toBe('https://checkout.stripe.com/c/plink_v');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Stripe-Account']).toBeUndefined();
  });
});
