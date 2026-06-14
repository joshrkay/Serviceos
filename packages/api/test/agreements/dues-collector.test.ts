import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { StripeDuesCollector, DuesInvoiceOps } from '../../src/agreements/dues-collector';
import { InMemoryCustomerPaymentMethodRepository } from '../../src/payments/customer-payment-method';
import { StripeFetch } from '../../src/payments/stripe-payment-intent';

function jsonRes(ok: boolean, status: number, body: unknown) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body };
}

const TENANT = uuidv4();
const CUSTOMER = uuidv4();

function makeInvoiceOps() {
  return {
    ensureIssued: vi.fn(async () => {}),
    recordPayment: vi.fn(async () => {}),
  } satisfies DuesInvoiceOps;
}

async function seedCard(repo: InMemoryCustomerPaymentMethodRepository) {
  await repo.create({
    id: uuidv4(),
    tenantId: TENANT,
    customerId: CUSTOMER,
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const input = {
  tenantId: TENANT,
  customerId: CUSTOMER,
  invoiceId: 'inv_1',
  amountCents: 5000,
  agreementId: 'agr_1',
  scheduledFor: '2026-06-01',
  createdBy: 'system',
};

describe('StripeDuesCollector', () => {
  it('returns no_card without issuing or charging when there is no default card', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    const invoiceOps = makeInvoiceOps();
    const stripeFetch = vi.fn();
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch: stripeFetch as unknown as StripeFetch,
    });
    const r = await collector.collect(input);
    expect(r.status).toBe('no_card');
    expect(invoiceOps.ensureIssued).not.toHaveBeenCalled();
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it('issues the invoice and records payment on a successful charge', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo);
    const invoiceOps = makeInvoiceOps();
    const stripeFetch: StripeFetch = async () => jsonRes(true, 200, { id: 'pi_ok', status: 'succeeded' });
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch,
    });
    const r = await collector.collect(input);
    expect(r).toEqual({ status: 'collected', paymentIntentId: 'pi_ok' });
    expect(invoiceOps.ensureIssued).toHaveBeenCalledWith(TENANT, 'inv_1');
    expect(invoiceOps.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_1', amountCents: 5000, providerReference: 'pi_ok' }),
    );
  });

  it('issues the invoice but does NOT record payment on a decline', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo);
    const invoiceOps = makeInvoiceOps();
    const stripeFetch: StripeFetch = async () =>
      jsonRes(false, 402, {
        error: {
          decline_code: 'insufficient_funds',
          payment_intent: { id: 'pi_no', status: 'requires_payment_method' },
        },
      });
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch,
    });
    const r = await collector.collect(input);
    expect(r.status).toBe('failed');
    expect(r.declineCode).toBe('insufficient_funds');
    expect(invoiceOps.ensureIssued).toHaveBeenCalled();
    expect(invoiceOps.recordPayment).not.toHaveBeenCalled();
  });

  it('maps off-session authentication_required to requires_action without recording', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo);
    const invoiceOps = makeInvoiceOps();
    const stripeFetch: StripeFetch = async () =>
      jsonRes(false, 402, {
        error: { code: 'authentication_required', payment_intent: { id: 'pi_act', status: 'requires_action' } },
      });
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch,
    });
    const r = await collector.collect(input);
    expect(r.status).toBe('requires_action');
    expect(invoiceOps.recordPayment).not.toHaveBeenCalled();
  });
});
