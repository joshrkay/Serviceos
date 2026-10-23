import { describe, expect, it } from 'vitest';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { MockPaymentLinkProvider } from '../../src/payments/payment-link-provider';
import { createInvoicePaymentLink } from '../../src/invoices/invoice-payment-link';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';
import { InMemorySettingsRepository } from '../../src/settings/settings';

// S5a-1 — the mint reads `payment_collection_mode` first; an empty settings
// repo is a successful read of an unset key, i.e. the D-039/D-040 default
// (`pay_link`), so every case below behaves exactly as before the gate.
const settingsRepo = new InMemorySettingsRepository();

describe('createInvoicePaymentLink (INV-04)', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const jobId = '00000000-0000-4000-8000-000000000002';

  it('returns existing url when stripePaymentLinkUrl is set', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000010',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0001',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 5000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 5000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 5000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      stripePaymentLinkUrl: 'https://checkout.stripe.com/c/pay/existing',
    });

    const provider = new MockPaymentLinkProvider();
    const result = await createInvoicePaymentLink(tenantId, invoice.id, { invoiceRepo: repo, provider, settingsRepo });
    expect(result.url).toBe('https://checkout.stripe.com/c/pay/existing');
  });

  it('mints link and persists url for open invoice', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000011',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0002',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 8000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 8000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 8000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const provider = new MockPaymentLinkProvider();
    const result = await createInvoicePaymentLink(tenantId, invoice.id, { invoiceRepo: repo, provider, settingsRepo });
    expect(result.url).toMatch(/^https:\/\/pay\.mock\.com\//);

    const updated = await repo.findById(tenantId, invoice.id);
    expect(updated?.stripePaymentLinkUrl).toBe(result.url);
  });

  it('passes stripeAccountId to the provider when Connect charges are enabled', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000013',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0004',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 2000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 2000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 2000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const seen: Array<{ stripeAccountId?: string }> = [];
    const provider = {
      generateLink: async (req: { stripeAccountId?: string }) => {
        seen.push({ stripeAccountId: req.stripeAccountId });
        return {
          linkId: 'plink_1',
          linkUrl: 'https://pay.mock.com/plink_1',
          providerReference: 'mock_plink_1',
        };
      },
      deactivateLink: async () => undefined,
    };

    await createInvoicePaymentLink(tenantId, invoice.id, {
      invoiceRepo: repo,
      provider,
      settingsRepo,
      connectAccountResolver: {
        resolveTenantConnectAccount: async () => ({
          accountId: 'acct_op_link',
          chargesEnabled: true,
        }),
      },
    });

    expect(seen[0]?.stripeAccountId).toBe('acct_op_link');
  });

  // U9 invariant (absent side): the operator link must NOT route to Connect
  // unless charges are enabled — otherwise a half-onboarded tenant's operator
  // link would 500 (Connect account can't accept charges) or, worse, a stale
  // account id would misroute funds. Mirrors the platform-fallback guard the
  // public invoice link already proves in public-invoice-connect.test.ts.
  async function seenAccountFor(
    resolver: Parameters<typeof createInvoicePaymentLink>[4],
  ): Promise<string | undefined> {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000014',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0005',
      status: 'open',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 3000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 3000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 3000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const seen: Array<{ stripeAccountId?: string }> = [];
    const provider = {
      generateLink: async (req: { stripeAccountId?: string }) => {
        seen.push({ stripeAccountId: req.stripeAccountId });
        return { linkId: 'plink_x', linkUrl: 'https://pay.mock.com/plink_x', providerReference: 'mock_x' };
      },
      deactivateLink: async () => undefined,
    };
    await createInvoicePaymentLink(tenantId, invoice.id, { invoiceRepo: repo, provider, settingsRepo, connectAccountResolver: resolver });
    return seen[0]?.stripeAccountId;
  }

  it('does NOT pass stripeAccountId when Connect charges are not enabled (KYC incomplete)', async () => {
    const account = await seenAccountFor({
      resolveTenantConnectAccount: async () => ({ accountId: 'acct_pending', chargesEnabled: false }),
    });
    expect(account).toBeUndefined();
  });

  it('does NOT pass stripeAccountId when the tenant has no Connect account (resolver returns null)', async () => {
    const account = await seenAccountFor({
      resolveTenantConnectAccount: async () => null,
    });
    expect(account).toBeUndefined();
  });

  it('falls back to platform (no stripeAccountId) when the resolver throws', async () => {
    const account = await seenAccountFor({
      resolveTenantConnectAccount: async () => {
        throw new Error('db hiccup');
      },
    });
    expect(account).toBeUndefined();
  });

  it('rejects draft invoice with 409-class error', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await repo.create({
      id: '00000000-0000-4000-8000-000000000012',
      tenantId,
      jobId,
      invoiceNumber: 'INV-0003',
      status: 'draft',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 1000, taxable: true }],
      totals: calculateDocumentTotals([{ description: 'Labor', quantity: 1, unitPriceCents: 1000, taxable: true }]),
      amountPaidCents: 0,
      amountDueCents: 1000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const provider = new MockPaymentLinkProvider();
    await expect(
      createInvoicePaymentLink(tenantId, invoice.id, { invoiceRepo: repo, provider, settingsRepo }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('P0-1 — void/cancel deactivates the hosted payment link', () => {
  const TENANT = 'tenant-1';

  async function setup() {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice, transitionInvoiceStatus } =
      await import('../../src/invoices/invoice');
    const { InMemoryAuditRepository } = await import('../../src/audit/audit');
    const { buildLineItem } = await import('../../src/shared/billing-engine');

    const invoiceRepo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-LINK-1',
        lineItems: [buildLineItem('1', 'Service', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);
    await invoiceRepo.update(TENANT, invoice.id, {
      stripePaymentLinkId: 'plink_void_1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/plink_void_1',
      updatedAt: new Date(),
    });
    return { invoiceRepo, auditRepo, invoiceId: invoice.id, transitionInvoiceStatus };
  }

  it('voiding an invoice deactivates its link, clears the columns, and audits both', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    const deactivated: Array<{ linkId: string; account?: string }> = [];
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async (linkId: string, account?: string) => {
        deactivated.push({ linkId, account });
      },
    };

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: 'u-1', actorRole: 'owner' },
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    expect(deactivated).toEqual([{ linkId: 'plink_void_1', account: undefined }]);

    const reloaded = await invoiceRepo.findById(TENANT, invoiceId);
    expect(reloaded!.stripePaymentLinkId).toBeUndefined();
    expect(reloaded!.stripePaymentLinkUrl).toBeUndefined();

    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).toContain('invoice.status_changed');
    expect(events).toContain('invoice.payment_link_deactivated');
  });

  it('a Stripe deactivation failure keeps the link columns (exposure stays visible) and audits the failure', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async () => { throw new Error('stripe 500'); },
    };

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      actor: { actorId: 'u-1', actorRole: 'owner' },
      paymentLink: { provider },
    });

    // The void itself is never blocked…
    expect(result!.status).toBe('void');
    // …but the live-link exposure is not hidden, and the failure is audited.
    const reloaded = await invoiceRepo.findById(TENANT, invoiceId);
    expect(reloaded!.stripePaymentLinkId).toBe('plink_void_1');
    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).toContain('invoice.payment_link_deactivation_failed');
    expect(events).not.toContain('invoice.payment_link_deactivated');
  });

  it('a Connect-minted link is deactivated with the tenant account header', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    const deactivated: Array<{ linkId: string; account?: string }> = [];
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async (linkId: string, account?: string) => {
        deactivated.push({ linkId, account });
      },
    };

    await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: {
        provider,
        connectAccountResolver: {
          resolveTenantConnectAccount: async () => ({ accountId: 'acct_123', chargesEnabled: true }),
        },
      },
    });

    expect(deactivated).toEqual([{ linkId: 'plink_void_1', account: 'acct_123' }]);
  });

  it('an invoice with no link voids cleanly with no provider call', async () => {
    const { invoiceRepo, auditRepo, invoiceId, transitionInvoiceStatus } = await setup();
    await invoiceRepo.update(TENANT, invoiceId, {
      stripePaymentLinkId: null,
      stripePaymentLinkUrl: null,
      updatedAt: new Date(),
    });
    let calls = 0;
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async () => { calls += 1; },
    };

    const result = await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo, undefined, {
      auditRepo,
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    expect(calls).toBe(0);
  });
});

describe('R2/R3 — deactivation scope fallback and CAS-guarded clear', () => {
  const TENANT = 'tenant-1';

  it('falls back to the platform scope when the Connect-scoped call fails (mint-time scope drift)', async () => {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice } =
      await import('../../src/invoices/invoice');
    const { deactivateInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');

    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-R2',
        lineItems: [(await import('../../src/shared/billing-engine')).buildLineItem('1', 'S', 1, 1000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);
    await invoiceRepo.update(TENANT, invoice.id, {
      stripePaymentLinkId: 'plink_platform_minted',
      stripePaymentLinkUrl: 'https://pay.stripe.com/x',
      updatedAt: new Date(),
    });

    // Link was minted on the PLATFORM before the tenant onboarded to
    // Connect; the current resolution is Connect-scoped and fails.
    const attempts: Array<string | undefined> = [];
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async (_id: string, account?: string) => {
        attempts.push(account);
        if (account) throw new Error('resource_missing');
      },
    };

    const fresh = await invoiceRepo.findById(TENANT, invoice.id);
    const result = await deactivateInvoicePaymentLink({
      tenantId: TENANT,
      invoice: fresh!,
      reason: 'voided',
      invoiceRepo,
      provider,
      connectAccountResolver: {
        resolveTenantConnectAccount: async () => ({ accountId: 'acct_now', chargesEnabled: true }),
      },
    });

    expect(result.deactivated).toBe(true);
    expect(attempts).toEqual(['acct_now', undefined]); // Connect first, then platform fallback
    expect((await invoiceRepo.findById(TENANT, invoice.id))!.stripePaymentLinkId).toBeUndefined();
  });

  it('a deactivation holding a stale snapshot never clears a re-minted link (CAS)', async () => {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice } =
      await import('../../src/invoices/invoice');
    const { deactivateInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
    const { buildLineItem } = await import('../../src/shared/billing-engine');

    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-R3',
        lineItems: [buildLineItem('1', 'S', 1, 1000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);
    await invoiceRepo.update(TENANT, invoice.id, {
      stripePaymentLinkId: 'plink_L1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/L1',
      updatedAt: new Date(),
    });
    const staleSnapshot = await invoiceRepo.findById(TENANT, invoice.id);

    // Concurrent flow: L1 deactivated+cleared, then L2 re-minted.
    await invoiceRepo.update(TENANT, invoice.id, {
      stripePaymentLinkId: 'plink_L2',
      stripePaymentLinkUrl: 'https://pay.stripe.com/L2',
      updatedAt: new Date(),
    });

    // Our late deactivation still holds the L1 snapshot; Stripe's
    // deactivate on the already-dead L1 succeeds idempotently.
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async () => {},
    };
    await deactivateInvoicePaymentLink({
      tenantId: TENANT,
      invoice: staleSnapshot!,
      reason: 'repriced',
      invoiceRepo,
      provider,
    });

    // L2's columns survive — no invisible live link.
    const fresh = await invoiceRepo.findById(TENANT, invoice.id);
    expect(fresh!.stripePaymentLinkId).toBe('plink_L2');
    expect(fresh!.stripePaymentLinkUrl).toBe('https://pay.stripe.com/L2');
  });
});

describe('Codex P1 — a failed column clear after successful deactivation is audited, not hidden', () => {
  it('emits payment_link_clear_failed (never the success event) when the DB clear throws', async () => {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice } =
      await import('../../src/invoices/invoice');
    const { deactivateInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
    const { InMemoryAuditRepository } = await import('../../src/audit/audit');
    const { buildLineItem } = await import('../../src/shared/billing-engine');

    const inner = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-CLR-1',
        lineItems: [buildLineItem('1', 'S', 1, 1000, 1, true)],
        createdBy: 'u-1',
      },
      inner,
    );
    await issueInvoice('tenant-1', invoice.id, 30, inner);
    await inner.update('tenant-1', invoice.id, {
      stripePaymentLinkId: 'plink_clr_1',
      stripePaymentLinkUrl: 'https://pay.stripe.com/clr1',
      updatedAt: new Date(),
    });

    // Stripe deactivation succeeds; the DB clear throws (transient outage).
    const failingClear = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'clearPaymentLinkIfMatches') {
          return async () => { throw new Error('db down'); };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async () => {},
    };

    const fresh = await inner.findById('tenant-1', invoice.id);
    const result = await deactivateInvoicePaymentLink({
      tenantId: 'tenant-1',
      invoice: fresh!,
      reason: 'repriced',
      invoiceRepo: failingClear,
      provider,
      auditRepo,
    });

    // The link IS dead at Stripe...
    expect(result.deactivated).toBe(true);
    // ...but the stranded column is surfaced as its own actionable event,
    // never masked by the success event.
    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).toContain('invoice.payment_link_clear_failed');
    expect(events).not.toContain('invoice.payment_link_deactivated');
  });
});

describe('P0-9 mint leg — link persist is guarded against concurrent invoice mutations', () => {
  const TENANT = 'tenant-1';

  async function setupOpenInvoice() {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice } =
      await import('../../src/invoices/invoice');
    const { buildLineItem } = await import('../../src/shared/billing-engine');
    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await createInvoice(
      {
        tenantId: TENANT,
        jobId: 'job-1',
        invoiceNumber: 'INV-MINT-1',
        lineItems: [buildLineItem('1', 'S', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice(TENANT, invoice.id, 30, invoiceRepo);
    return { invoiceRepo, invoiceId: invoice.id };
  }

  it('a link minted while a void lands is deactivated, never attached', async () => {
    const { invoiceRepo, invoiceId } = await setupOpenInvoice();
    const { createInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
    const { transitionInvoiceStatus } = await import('../../src/invoices/invoice');

    const deactivated: string[] = [];
    const provider = {
      // The void commits while Stripe is minting the link.
      generateLink: async () => {
        await transitionInvoiceStatus(TENANT, invoiceId, 'void', invoiceRepo);
        return {
          linkId: 'plink_mint_race',
          linkUrl: 'https://pay.stripe.com/mint-race',
          expiresAt: null as unknown as Date,
          providerReference: 'stripe_plink_mint_race',
        };
      },
      deactivateLink: async (linkId: string) => { deactivated.push(linkId); },
    };

    await expect(
      createInvoicePaymentLink(TENANT, invoiceId, { invoiceRepo, provider, settingsRepo }),
    ).rejects.toThrow(/Invoice changed while the payment link was being created/);

    // The fresh link died and nothing was attached to the voided invoice.
    expect(deactivated).toEqual(['plink_mint_race']);
    const reloaded = await invoiceRepo.findById(TENANT, invoiceId);
    expect(reloaded!.stripePaymentLinkId).toBeUndefined();
    expect(reloaded!.stripePaymentLinkUrl).toBeUndefined();
  });

  it('a link minted while a credit reprices the invoice is deactivated, never attached', async () => {
    const { invoiceRepo, invoiceId } = await setupOpenInvoice();
    const { createInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');

    const deactivated: string[] = [];
    const provider = {
      generateLink: async () => {
        // A partial payment lands mid-mint: the balance the link was priced
        // at (10000) no longer matches the live due (6000).
        await invoiceRepo.incrementAmountPaidAtomic(TENANT, invoiceId, 4000, new Date());
        return {
          linkId: 'plink_reprice_race',
          linkUrl: 'https://pay.stripe.com/reprice-race',
          expiresAt: null as unknown as Date,
          providerReference: 'stripe_plink_reprice_race',
        };
      },
      deactivateLink: async (linkId: string) => { deactivated.push(linkId); },
    };

    await expect(
      createInvoicePaymentLink(TENANT, invoiceId, { invoiceRepo, provider, settingsRepo }),
    ).rejects.toThrow(/Invoice changed while the payment link was being created/);
    expect(deactivated).toEqual(['plink_reprice_race']);
    const reloaded = await invoiceRepo.findById(TENANT, invoiceId);
    expect(reloaded!.stripePaymentLinkId).toBeUndefined();
  });

  it('losing to a COMPETING mint serves the winner link instead of erroring', async () => {
    const { invoiceRepo, invoiceId } = await setupOpenInvoice();
    const { createInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');

    const deactivated: string[] = [];
    const provider = {
      generateLink: async () => {
        // The competing mint persists its link first (same balance).
        await invoiceRepo.attachPaymentLink(
          TENANT,
          invoiceId,
          { linkId: 'plink_winner', linkUrl: 'https://pay.stripe.com/winner' },
          10000,
          new Date(),
        );
        return {
          linkId: 'plink_loser',
          linkUrl: 'https://pay.stripe.com/loser',
          expiresAt: null as unknown as Date,
          providerReference: 'stripe_plink_loser',
        };
      },
      deactivateLink: async (linkId: string) => { deactivated.push(linkId); },
    };

    const result = await createInvoicePaymentLink(TENANT, invoiceId, { invoiceRepo, provider, settingsRepo });

    expect(result.url).toBe('https://pay.stripe.com/winner');
    expect(deactivated).toEqual(['plink_loser']); // the loser's link died
    const reloaded = await invoiceRepo.findById(TENANT, invoiceId);
    expect(reloaded!.stripePaymentLinkId).toBe('plink_winner');
  });
});

describe('Codex P1 — a loser-link cleanup miss is audited with the link id', () => {
  it('deactivation failure on the mint-guard loser lands the link id on the audit trail', async () => {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice, transitionInvoiceStatus } =
      await import('../../src/invoices/invoice');
    const { createInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
    const { InMemoryAuditRepository } = await import('../../src/audit/audit');
    const { buildLineItem } = await import('../../src/shared/billing-engine');

    const invoiceRepo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-LOSER-1',
        lineItems: [buildLineItem('1', 'S', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice('tenant-1', invoice.id, 30, invoiceRepo);

    const provider = {
      generateLink: async () => {
        // Void lands mid-mint AND the loser cleanup will fail at Stripe.
        await transitionInvoiceStatus('tenant-1', invoice.id, 'void', invoiceRepo);
        return {
          linkId: 'plink_orphan_1',
          linkUrl: 'https://pay.stripe.com/orphan',
          expiresAt: null as unknown as Date,
          providerReference: 'stripe_plink_orphan_1',
        };
      },
      deactivateLink: async () => { throw new Error('stripe 500'); },
    };

    await expect(
      createInvoicePaymentLink('tenant-1', invoice.id, { invoiceRepo, provider, settingsRepo, auditRepo }),
    ).rejects.toThrow(/Invoice changed/);

    // The orphaned-but-live link id is durably traceable.
    const events = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'invoice.payment_link_deactivation_failed');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      stripePaymentLinkId: 'plink_orphan_1',
      reason: 'mint_guard_lost',
    });
  });
});

describe('Codex P1 — void deactivation uses the POST-transition snapshot', () => {
  it('kills a link that won its mint guard between the transition read and the status commit', async () => {
    const { InMemoryInvoiceRepository, createInvoice, issueInvoice, transitionInvoiceStatus } =
      await import('../../src/invoices/invoice');
    const { InMemoryAuditRepository } = await import('../../src/audit/audit');
    const { buildLineItem } = await import('../../src/shared/billing-engine');

    const inner = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: 'job-1',
        invoiceNumber: 'INV-SNAP-1',
        lineItems: [buildLineItem('1', 'S', 1, 10000, 1, true)],
        createdBy: 'u-1',
      },
      inner,
    );
    await issueInvoice('tenant-1', invoice.id, 30, inner);

    // The mint lands AFTER the transition's read (invoice had no link) but
    // BEFORE the status update commits — its payable guard legitimately
    // passes. The deactivation must therefore work from the POST-update
    // snapshot, which carries the fresh link.
    let mintInjected = false;
    const racingRepo = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'update' && !mintInjected) {
          return async (tenantId: string, id: string, updates: unknown) => {
            mintInjected = true;
            await inner.attachPaymentLink(
              tenantId,
              id,
              { linkId: 'plink_mid_transition', linkUrl: 'https://pay.stripe.com/mid' },
              10000,
              new Date(),
            );
            return inner.update(tenantId, id, updates as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const deactivated: string[] = [];
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async (linkId: string) => { deactivated.push(linkId); },
    };

    const result = await transitionInvoiceStatus('tenant-1', invoice.id, 'void', racingRepo, undefined, {
      auditRepo,
      paymentLink: { provider },
    });

    expect(result!.status).toBe('void');
    // The pre-transition snapshot had NO link; only the post-update snapshot
    // sees plink_mid_transition — and it must die.
    expect(deactivated).toEqual(['plink_mid_transition']);
    const reloaded = await inner.findById('tenant-1', invoice.id);
    expect(reloaded!.stripePaymentLinkId).toBeUndefined();
  });
});

describe('S5a-3 — mode-change deactivations: reasons, inactive message, cleanup claim', () => {
  const TENANT = '00000000-0000-4000-8000-0000000005a3';
  const MESSAGE = 'Acme HVAC collects payment in person. Please settle up with Dana when the work is done.';

  async function seedLinked(
    repo: InMemoryInvoiceRepository,
    id: string,
    overrides: Partial<import('../../src/invoices/invoice').Invoice> = {},
  ) {
    const items = [{ description: 'Labor', quantity: 1, unitPriceCents: 7000, taxable: true }];
    return repo.create({
      id,
      tenantId: TENANT,
      jobId: 'job-s5a3',
      invoiceNumber: `INV-${id.slice(-4)}`,
      status: 'open',
      lineItems: items as never,
      totals: calculateDocumentTotals(items as never),
      amountPaidCents: 0,
      amountDueCents: 7000,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      stripePaymentLinkId: `plink_${id.slice(-4)}`,
      stripePaymentLinkUrl: `https://pay.stripe.com/${id.slice(-4)}`,
      ...overrides,
    });
  }

  it.each(['payment_mode_changed', 'payment_mode_changed_during_checkout'] as const)(
    'reason %s lands in the deactivation audit metadata, the message reaches the provider, link and claim are cleared',
    async (reason) => {
      const { deactivateInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
      const { InMemoryAuditRepository } = await import('../../src/audit/audit');
      const repo = new InMemoryInvoiceRepository();
      const auditRepo = new InMemoryAuditRepository();
      const invoice = await seedLinked(repo, '00000000-0000-4000-8000-00000000a301', {
        cleanupClaimedAt: new Date(),
      });
      const provider = new MockPaymentLinkProvider();

      const result = await deactivateInvoicePaymentLink({
        tenantId: TENANT,
        invoice,
        reason,
        invoiceRepo: repo,
        provider,
        auditRepo,
        inactiveMessage: MESSAGE,
        claimed: true,
      });

      expect(result).toEqual({ deactivated: true });
      expect(provider.deactivations).toEqual([
        { linkId: invoice.stripePaymentLinkId, stripeAccountId: undefined, inactiveMessage: MESSAGE },
      ]);
      const fresh = await repo.findById(TENANT, invoice.id);
      expect(fresh!.stripePaymentLinkId).toBeUndefined();
      expect(fresh!.cleanupClaimedAt).toBeUndefined();
      const events = auditRepo.getAll();
      expect(events.map((e) => e.eventType)).toEqual(['invoice.payment_link_deactivated']);
      expect(events[0].metadata).toMatchObject({ reason, stripePaymentLinkId: invoice.stripePaymentLinkId });
    },
  );

  it('a failed provider call on a claimed invoice releases the claim and keeps the link columns', async () => {
    const { deactivateInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
    const { InMemoryAuditRepository } = await import('../../src/audit/audit');
    const repo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await seedLinked(repo, '00000000-0000-4000-8000-00000000a302', {
      cleanupClaimedAt: new Date(),
    });
    const provider = {
      generateLink: async () => { throw new Error('not used'); },
      deactivateLink: async () => { throw new Error('stripe down'); },
    };

    const result = await deactivateInvoicePaymentLink({
      tenantId: TENANT,
      invoice,
      reason: 'payment_mode_changed',
      invoiceRepo: repo,
      provider,
      auditRepo,
      claimed: true,
    });

    expect(result).toEqual({ deactivated: false });
    const fresh = await repo.findById(TENANT, invoice.id);
    expect(fresh!.stripePaymentLinkId).toBe(invoice.stripePaymentLinkId);
    expect(fresh!.cleanupClaimedAt).toBeUndefined();
    const [event] = auditRepo.getAll();
    expect(event.eventType).toBe('invoice.payment_link_deactivation_failed');
    expect(event.metadata).toMatchObject({ reason: 'payment_mode_changed', error: 'stripe down' });
  });

  it('a failed provider call WITHOUT claimed leaves any marker alone (existing callers unchanged)', async () => {
    const { deactivateInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
    const repo = new InMemoryInvoiceRepository();
    const claimedAt = new Date('2026-10-19T03:00:00Z');
    const invoice = await seedLinked(repo, '00000000-0000-4000-8000-00000000a303', { cleanupClaimedAt: claimedAt });
    const released: unknown[] = [];
    const spy = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'releaseCleanupClaim') {
          return async (...args: unknown[]) => { released.push(args); return true; };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await deactivateInvoicePaymentLink({
      tenantId: TENANT,
      invoice,
      reason: 'voided',
      invoiceRepo: spy,
      provider: {
        generateLink: async () => { throw new Error('not used'); },
        deactivateLink: async () => { throw new Error('stripe down'); },
      },
    });
    expect(released).toEqual([]);
    expect((await repo.findById(TENANT, invoice.id))!.cleanupClaimedAt).toEqual(claimedAt);
  });

  it('a release that throws is recorded on the failure event, never thrown', async () => {
    const { deactivateInvoicePaymentLink } = await import('../../src/invoices/invoice-payment-link');
    const { InMemoryAuditRepository } = await import('../../src/audit/audit');
    const repo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await seedLinked(repo, '00000000-0000-4000-8000-00000000a304', { cleanupClaimedAt: new Date() });
    const failingRelease = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'releaseCleanupClaim') return async () => { throw new Error('db down'); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = await deactivateInvoicePaymentLink({
      tenantId: TENANT,
      invoice,
      reason: 'payment_mode_changed',
      invoiceRepo: failingRelease,
      provider: {
        generateLink: async () => { throw new Error('not used'); },
        deactivateLink: async () => { throw new Error('stripe down'); },
      },
      auditRepo,
      claimed: true,
    });
    expect(result).toEqual({ deactivated: false });
    const [event] = auditRepo.getAll();
    expect(event.eventType).toBe('invoice.payment_link_deactivation_failed');
    expect(event.metadata).toMatchObject({ error: 'stripe down', claimReleaseError: 'db down' });
  });
});

describe('S5a-3 — InMemoryInvoiceRepository cleanup primitives mirror Pg', () => {
  const TENANT = '00000000-0000-4000-8000-0000000005a4';
  const OTHER = '00000000-0000-4000-8000-0000000005a5';

  function invoiceRow(
    id: string,
    tenantId: string,
    status: import('../../src/invoices/invoice').InvoiceStatus,
    linkId?: string,
    cleanupClaimedAt?: Date,
  ): import('../../src/invoices/invoice').Invoice {
    const items = [{ description: 'Labor', quantity: 1, unitPriceCents: 1000, taxable: true }];
    return {
      id,
      tenantId,
      jobId: 'job-1',
      invoiceNumber: `INV-${id.slice(-2)}`,
      status,
      lineItems: items as never,
      totals: calculateDocumentTotals(items as never),
      amountPaidCents: 0,
      amountDueCents: 1000,
      createdBy: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
      stripePaymentLinkId: linkId,
      stripePaymentLinkUrl: linkId ? `https://pay.stripe.com/${linkId}` : undefined,
      cleanupClaimedAt,
    };
  }

  it('findOpenWithPaymentLink: only open/partially_paid rows holding a link, this tenant, ordered by id, paged', async () => {
    const repo = new InMemoryInvoiceRepository();
    const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
    await repo.create(invoiceRow(id(5), TENANT, 'open', 'plink_5'));
    await repo.create(invoiceRow(id(1), TENANT, 'partially_paid', 'plink_1'));
    await repo.create(invoiceRow(id(3), TENANT, 'open', 'plink_3'));
    await repo.create(invoiceRow(id(2), TENANT, 'open')); // no link
    await repo.create(invoiceRow(id(4), TENANT, 'paid', 'plink_4'));
    await repo.create(invoiceRow(id(6), TENANT, 'void', 'plink_6'));
    await repo.create(invoiceRow(id(7), TENANT, 'draft', 'plink_7'));
    await repo.create(invoiceRow(id(8), OTHER, 'open', 'plink_8'));

    const first = await repo.findOpenWithPaymentLink(TENANT, null, 2);
    expect(first.map((i) => i.id)).toEqual([id(1), id(3)]);
    const second = await repo.findOpenWithPaymentLink(TENANT, id(3), 2);
    expect(second.map((i) => i.id)).toEqual([id(5)]);
    expect(await repo.findOpenWithPaymentLink(TENANT, id(5), 2)).toEqual([]);
    expect((await repo.findOpenWithPaymentLink(OTHER, null, 10)).map((i) => i.id)).toEqual([id(8)]);
  });

  it('releaseCleanupClaim clears the marker only while the row still holds that link', async () => {
    const repo = new InMemoryInvoiceRepository();
    const id = '00000000-0000-4000-8000-0000000000a1';
    const claimedAt = new Date();
    await repo.create(invoiceRow(id, TENANT, 'open', 'plink_A', claimedAt));
    expect(await repo.releaseCleanupClaim(TENANT, id, 'plink_B')).toBe(false);
    expect((await repo.findById(TENANT, id))!.cleanupClaimedAt).toEqual(claimedAt);
    expect(await repo.releaseCleanupClaim(OTHER, id, 'plink_A')).toBe(false);
    expect(await repo.releaseCleanupClaim(TENANT, id, 'plink_A')).toBe(true);
    const fresh = await repo.findById(TENANT, id);
    expect(fresh!.cleanupClaimedAt).toBeUndefined();
    expect(fresh!.stripePaymentLinkId).toBe('plink_A');
  });

  it('every write of the link columns drops the marker: CAS clear, guarded attach, plain update', async () => {
    const repo = new InMemoryInvoiceRepository();
    const a = '00000000-0000-4000-8000-0000000000b1';
    const b = '00000000-0000-4000-8000-0000000000b2';
    const c = '00000000-0000-4000-8000-0000000000b3';
    await repo.create(invoiceRow(a, TENANT, 'open', 'plink_a', new Date()));
    await repo.create(invoiceRow(b, TENANT, 'open', undefined, new Date()));
    await repo.create(invoiceRow(c, TENANT, 'open', 'plink_c', new Date()));

    expect(await repo.clearPaymentLinkIfMatches(TENANT, a, 'plink_a')).toBe(true);
    expect((await repo.findById(TENANT, a))!.cleanupClaimedAt).toBeUndefined();

    await repo.attachPaymentLink(TENANT, b, { linkId: 'plink_b', linkUrl: 'https://x/b' }, 1000, new Date());
    expect((await repo.findById(TENANT, b))!.cleanupClaimedAt).toBeUndefined();

    await repo.update(TENANT, c, { stripePaymentLinkId: 'plink_c2', stripePaymentLinkUrl: 'https://x/c2', updatedAt: new Date() });
    expect((await repo.findById(TENANT, c))!.cleanupClaimedAt).toBeUndefined();
  });
});
