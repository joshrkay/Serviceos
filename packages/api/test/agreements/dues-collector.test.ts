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

function makeInvoiceOps(amountDue = 5000) {
  return {
    ensureIssuedAmountDue: vi.fn(async () => amountDue),
    recordPayment: vi.fn(async () => {}),
  } satisfies DuesInvoiceOps;
}

async function seedCard(repo: InMemoryCustomerPaymentMethodRepository, stripeAccountId?: string) {
  await repo.create({
    id: uuidv4(),
    tenantId: TENANT,
    customerId: CUSTOMER,
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    stripeAccountId,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const input = {
  tenantId: TENANT,
  customerId: CUSTOMER,
  invoiceId: 'inv_1',
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
    expect(invoiceOps.ensureIssuedAmountDue).not.toHaveBeenCalled();
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it('charges the invoice amount due (not the raw price) and records that exact amount', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo);
    const invoiceOps = makeInvoiceOps(7777); // invoice owes 7777, e.g. price + tax
    let chargedBody = '';
    const stripeFetch: StripeFetch = async (_url, init) => {
      chargedBody = init.body;
      return jsonRes(true, 200, { id: 'pi_ok', status: 'succeeded' });
    };
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch,
    });
    const r = await collector.collect(input);
    expect(r).toEqual({ status: 'collected', paymentIntentId: 'pi_ok' });
    expect(invoiceOps.ensureIssuedAmountDue).toHaveBeenCalledWith(TENANT, 'inv_1');
    expect(chargedBody).toContain('amount=7777');
    expect(invoiceOps.recordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_1', amountCents: 7777, providerReference: 'pi_ok' }),
    );
  });

  it('charges on the exact Stripe account the card was saved on', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo, 'acct_connected'); // card lives on the connected account
    const invoiceOps = makeInvoiceOps(5000);
    let headers: Record<string, string> = {};
    const stripeFetch: StripeFetch = async (_url, init) => {
      headers = init.headers;
      return jsonRes(true, 200, { id: 'pi_ok', status: 'succeeded' });
    };
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch,
    });
    const r = await collector.collect(input);
    expect(r.status).toBe('collected');
    expect(headers['Stripe-Account']).toBe('acct_connected');
  });

  it('omits the connect header for a platform card (no stored account)', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo); // no stripeAccountId → platform
    const invoiceOps = makeInvoiceOps(5000);
    let headers: Record<string, string> = {};
    const stripeFetch: StripeFetch = async (_url, init) => {
      headers = init.headers;
      return jsonRes(true, 200, { id: 'pi_ok', status: 'succeeded' });
    };
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch,
    });
    await collector.collect(input);
    expect(headers['Stripe-Account']).toBeUndefined();
  });

  it('does not charge when the issued invoice owes nothing', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo);
    const invoiceOps = makeInvoiceOps(0);
    const stripeFetch = vi.fn();
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch: stripeFetch as unknown as StripeFetch,
    });
    const r = await collector.collect(input);
    expect(r.status).toBe('collected');
    expect(stripeFetch).not.toHaveBeenCalled();
    expect(invoiceOps.recordPayment).not.toHaveBeenCalled();
  });

  it('returns collected_unrecorded (with the PI id) when recording fails after a successful charge', async () => {
    const repo = new InMemoryCustomerPaymentMethodRepository();
    await seedCard(repo);
    const invoiceOps = makeInvoiceOps(5000);
    invoiceOps.recordPayment = vi.fn(async () => {
      throw new Error('db down');
    });
    const stripeFetch: StripeFetch = async () => jsonRes(true, 200, { id: 'pi_charged', status: 'succeeded' });
    const collector = new StripeDuesCollector({
      customerPaymentMethodRepo: repo,
      stripeConfig: { apiKey: 'sk' },
      invoiceOps,
      stripeFetch,
    });
    const r = await collector.collect(input);
    expect(r.status).toBe('collected_unrecorded');
    expect(r.paymentIntentId).toBe('pi_charged');
    expect(r.recordError).toContain('db down');
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
    expect(invoiceOps.ensureIssuedAmountDue).toHaveBeenCalled();
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
