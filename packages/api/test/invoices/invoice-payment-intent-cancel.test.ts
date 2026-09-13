import { describe, expect, it } from 'vitest';
import {
  InMemoryInvoiceRepository,
  createInvoice,
  issueInvoice,
  transitionInvoiceStatus,
} from '../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem } from '../../src/shared/billing-engine';

// P0-1 completion — voiding/canceling an invoice already deactivates the
// hosted payment LINK, but a PaymentIntent client secret minted pre-void
// (public payment page / Terminal) stayed live: a customer holding it could
// still confirm and Stripe would capture money the invoice can no longer
// accept. These tests pin the residual fix: the void sweeps the invoice's
// minted PaymentIntents through the provider and cancels every one that is
// still cancelable — best-effort, audited, never blocking the void itself.

const TENANT = 'tenant-1';

interface FakeIntent {
  id: string;
  status: string;
}

function makeProvider(opts: {
  /** Key '' = platform scope; any other key = Connect account id. */
  intentsByScope?: Record<string, FakeIntent[]>;
  listError?: Error;
  cancelError?: Error;
}) {
  const listedScopes: Array<string | undefined> = [];
  const canceled: Array<{ id: string; account?: string }> = [];
  const provider = {
    generateLink: async () => {
      throw new Error('not used');
    },
    deactivateLink: async () => undefined,
    listInvoicePaymentIntents: async (
      _tenantId: string,
      _invoiceId: string,
      stripeAccountId?: string,
    ) => {
      listedScopes.push(stripeAccountId);
      if (opts.listError) throw opts.listError;
      return opts.intentsByScope?.[stripeAccountId ?? ''] ?? [];
    },
    cancelPaymentIntent: async (paymentIntentId: string, stripeAccountId?: string) => {
      if (opts.cancelError) throw opts.cancelError;
      canceled.push({ id: paymentIntentId, account: stripeAccountId });
    },
  };
  return { provider, listedScopes, canceled };
}

async function setupOpenInvoice() {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const auditRepo = new InMemoryAuditRepository();
  const invoice = await createInvoice(
    {
      tenantId: TENANT,
      jobId: 'job-1',
      invoiceNumber: 'INV-PI-VOID-1',
      lineItems: [buildLineItem('1', 'Service', 1, 10000, 1, true)],
      createdBy: 'u-1',
    },
    invoiceRepo,
  );
  await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);
  return { invoiceRepo, auditRepo, invoiceId: invoice.id };
}

describe('P0-1 completion — void cancels minted PaymentIntents', () => {
  it('voiding cancels each still-cancelable PI for the invoice and audits the cancellation', async () => {
    const { invoiceRepo, auditRepo, invoiceId } = await setupOpenInvoice();
    const { provider, canceled } = makeProvider({
      intentsByScope: {
        '': [
          { id: 'pi_open_1', status: 'requires_payment_method' },
          { id: 'pi_open_2', status: 'requires_action' },
        ],
      },
    });

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: 'u-1', actorRole: 'owner' },
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    expect(canceled).toEqual([
      { id: 'pi_open_1', account: undefined },
      { id: 'pi_open_2', account: undefined },
    ]);

    const events = auditRepo.getAll().filter((e) => e.eventType === 'invoice.payment_intent_canceled');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.metadata?.stripePaymentIntentId)).toEqual(['pi_open_1', 'pi_open_2']);
    expect(events[0].metadata).toMatchObject({ reason: 'voided' });
  });

  it('PIs already in a terminal state are skipped — a succeeded capture is never "canceled"', async () => {
    const { invoiceRepo, auditRepo, invoiceId } = await setupOpenInvoice();
    const { provider, canceled } = makeProvider({
      intentsByScope: {
        '': [
          { id: 'pi_done', status: 'succeeded' },
          { id: 'pi_dead', status: 'canceled' },
          { id: 'pi_live', status: 'requires_confirmation' },
        ],
      },
    });

    await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: { provider },
    });

    expect(canceled.map((c) => c.id)).toEqual(['pi_live']);
  });

  it('a provider cancel failure is audited with the PI id and never blocks the void', async () => {
    const { invoiceRepo, auditRepo, invoiceId } = await setupOpenInvoice();
    const { provider } = makeProvider({
      intentsByScope: { '': [{ id: 'pi_stuck', status: 'requires_payment_method' }] },
      cancelError: new Error('stripe 500'),
    });

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: 'u-1', actorRole: 'owner' },
      paymentLink: { provider },
    });

    // The void itself is never blocked…
    expect(result!.status).toBe('void');
    // …and the still-live client secret is durably visible to operators.
    const failures = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'invoice.payment_intent_cancel_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].metadata).toMatchObject({
      stripePaymentIntentId: 'pi_stuck',
      reason: 'voided',
      error: 'stripe 500',
    });
    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).not.toContain('invoice.payment_intent_canceled');
  });

  it('a listing failure is audited and never blocks the void', async () => {
    const { invoiceRepo, auditRepo, invoiceId } = await setupOpenInvoice();
    const { provider } = makeProvider({ listError: new Error('search down') });

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    const failures = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'invoice.payment_intent_cancel_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].metadata).toMatchObject({ reason: 'voided', error: 'search down' });
  });

  it('sweeps the tenant Connect scope in addition to platform — PIs can exist under both', async () => {
    const { invoiceRepo, auditRepo, invoiceId } = await setupOpenInvoice();
    const { provider, listedScopes, canceled } = makeProvider({
      intentsByScope: {
        // Public PI minted on the platform before Connect onboarding…
        '': [{ id: 'pi_platform', status: 'requires_payment_method' }],
        // …and a Terminal PI minted on the Connect account after.
        acct_123: [{ id: 'pi_connect', status: 'requires_payment_method' }],
      },
    });

    await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: {
        provider,
        connectAccountResolver: {
          resolveTenantConnectAccount: async () => ({ accountId: 'acct_123', chargesEnabled: true }),
        },
      },
    });

    expect(listedScopes).toEqual([undefined, 'acct_123']);
    expect(canceled).toEqual([
      { id: 'pi_platform', account: undefined },
      { id: 'pi_connect', account: 'acct_123' },
    ]);
  });

  it('a provider without PaymentIntent support (legacy shape) voids cleanly', async () => {
    const { invoiceRepo, auditRepo, invoiceId } = await setupOpenInvoice();
    const provider = {
      generateLink: async () => {
        throw new Error('not used');
      },
      deactivateLink: async () => undefined,
    };

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).not.toContain('invoice.payment_intent_canceled');
    expect(events).not.toContain('invoice.payment_intent_cancel_failed');
  });

  it('canceling a draft invoice sweeps too (reason: canceled)', async () => {
    // A draft can't mint a PI through the payable-gated routes, but a mint
    // that raced an un-issue/cancel could leave one behind — the sweep is
    // cheap and closes that residue with the same audit trail.
    const invoiceRepo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-PI-CXL-1',
        lineItems: [buildLineItem('1', 'Service', 1, 5000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    const { provider, canceled } = makeProvider({
      intentsByScope: { '': [{ id: 'pi_orphan', status: 'requires_payment_method' }] },
    });

    const result = await transitionInvoiceStatus(TENANT, invoice.id, 'canceled', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: { provider },
    });

    expect(result!.status).toBe('canceled');
    expect(canceled.map((c) => c.id)).toEqual(['pi_orphan']);
    const events = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'invoice.payment_intent_canceled');
    expect(events[0].metadata).toMatchObject({ reason: 'canceled' });
  });
});
