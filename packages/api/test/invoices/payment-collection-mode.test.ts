/**
 * S5a-1 (U8, "Pick, don't build" plan) — the read side of
 * `payment_collection_mode`.
 *
 * One function decides what the stored key means at every pay surface
 * (`readPaymentCollectionMode`): an absent key is the D-039/D-040 default
 * (`pay_link`), a stored value is itself, and a read that THROWS is never
 * `pay_link` — defaulting there would mint or text a checkout link for an
 * owner who chose "Collect on the spot". Consumers fail closed on the link
 * and open on delivery.
 */
import { describe, it, expect, vi } from 'vitest';
import { AppError } from '../../src/shared/errors';
import { v4 as uuidv4 } from 'uuid';
import {
  InMemorySettingsRepository,
  type SettingsRepository,
  type TenantSettings,
} from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  readPaymentCollectionMode,
  auditPaymentModeUnavailable,
  renderCollectOnSiteInactiveMessage,
} from '../../src/invoices/payment-collection-mode';

const TENANT = 'tenant-pcm-1';

function seedSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
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
    ...overrides,
  };
}

/** A settings repository whose read throws — the "failed read" seam. */
function throwingSettingsRepo(error: Error = new Error('db down')): SettingsRepository {
  const base = new InMemorySettingsRepository();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'findByTenant') return async () => { throw error; };
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('readPaymentCollectionMode — the one place the key is read', () => {
  it('an absent key (successful read of an unset value) is the default pay_link', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(seedSettings());
    const result = await readPaymentCollectionMode(repo, TENANT);
    expect(result).toMatchObject({ ok: true, mode: 'pay_link', source: 'default' });
  });

  it('a tenant with no settings row at all is also the default pay_link', async () => {
    const repo = new InMemorySettingsRepository();
    const result = await readPaymentCollectionMode(repo, TENANT);
    expect(result).toMatchObject({ ok: true, mode: 'pay_link', source: 'default' });
    expect(result.ok && result.settings).toBeNull();
  });

  it('a stored value is returned as stored, with the settings row for the caller', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(seedSettings({ paymentCollectionMode: 'collect_on_site' }));
    const result = await readPaymentCollectionMode(repo, TENANT);
    expect(result).toMatchObject({ ok: true, mode: 'collect_on_site', source: 'stored' });
    expect(result.ok && result.settings?.businessName).toBe('Acme HVAC');

    await repo.update(TENANT, { paymentCollectionMode: 'pay_link' });
    expect(await readPaymentCollectionMode(repo, TENANT)).toMatchObject({
      ok: true,
      mode: 'pay_link',
      source: 'stored',
    });
  });

  it('a read that throws is NEVER pay_link — it is a failure the caller must handle', async () => {
    const error = new Error('relation "tenant_settings" does not exist');
    const result = await readPaymentCollectionMode(throwingSettingsRepo(error), TENANT);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('mode');
    expect(result.ok === false && result.error).toBe(error);
  });

  it('never caches: a repo that recovers is read again on the next call', async () => {
    const base = new InMemorySettingsRepository();
    await base.create(seedSettings({ paymentCollectionMode: 'collect_on_site' }));
    let fail = true;
    const flaky = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'findByTenant') {
          return async (tenantId: string) => {
            if (fail) throw new Error('timeout');
            return target.findByTenant(tenantId);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect((await readPaymentCollectionMode(flaky, TENANT)).ok).toBe(false);
    fail = false;
    expect(await readPaymentCollectionMode(flaky, TENANT)).toMatchObject({
      ok: true,
      mode: 'collect_on_site',
    });
  });
});

describe('auditPaymentModeUnavailable — one audit row per occurrence', () => {
  it('writes invoice.payment_mode_unavailable against the invoice with the surface', async () => {
    const audit = new InMemoryAuditRepository();
    await auditPaymentModeUnavailable(audit, {
      tenantId: TENANT,
      invoiceId: 'inv-1',
      surface: 'send',
      error: new Error('db down'),
    });
    const rows = await audit.findByEntity(TENANT, 'invoice', 'inv-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('invoice.payment_mode_unavailable');
    expect(rows[0].actorId).toBe('system');
    expect(rows[0].metadata).toMatchObject({
      reason: 'payment_mode_unavailable',
      surface: 'send',
      error: 'db down',
    });
  });

  it('a tenant-level occurrence (no invoice id) lands on the tenant entity', async () => {
    const audit = new InMemoryAuditRepository();
    await auditPaymentModeUnavailable(audit, { tenantId: TENANT, surface: 'portal', error: 'x' });
    const rows = await audit.findByEntity(TENANT, 'tenant', TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ surface: 'portal', reason: 'payment_mode_unavailable' });
  });

  it('is best-effort: an audit write failure never throws into the pay surface', async () => {
    const audit = new InMemoryAuditRepository();
    const failing = new Proxy(audit, {
      get(target, prop, receiver) {
        if (prop === 'create') return async () => { throw new Error('audit down'); };
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      auditPaymentModeUnavailable(failing, { tenantId: TENANT, surface: 'checkout', error: 'x' }),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invoice send (notifications/send-service.ts#sendInvoice). The send
// never mints a Payment Link; it texts/emails the view URL with a pay CTA.
// Under collect_on_site — or an unreadable mode — the CTA is view-only and
// the note says the business collects in person.
// ─────────────────────────────────────────────────────────────────────────────
import { SendService } from '../../src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryCustomerRepository, type Customer } from '../../src/customers/customer';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, type Invoice } from '../../src/invoices/invoice';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Sarah',
    lastName: 'Johnson',
    displayName: 'Sarah Johnson',
    primaryPhone: '+15555550199',
    email: 'sarah@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeJob(customerId: string): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId,
    locationId: 'loc-1',
    jobNumber: 'JOB-001',
    summary: 'AC repair',
    status: 'completed',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeInvoice(jobId: string, overrides: Partial<Invoice> = {}): Invoice {
  const lineItems = [
    {
      id: uuidv4(),
      description: 'Service call',
      quantity: 1,
      unitPriceCents: 125000,
      totalCents: 125000,
      sortOrder: 0,
      taxable: false,
    },
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    invoiceNumber: 'INV-2042',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface SendHarness {
  send: SendService;
  delivery: InMemoryDeliveryProvider;
  settings: InMemorySettingsRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  audit: InMemoryAuditRepository;
  invoice: Invoice;
}

async function buildSendHarness(opts: {
  mode?: 'pay_link' | 'collect_on_site' | null;
  settingsRepo?: SettingsRepository;
  ensureInvoicePayLink?: (tenantId: string, invoiceId: string) => Promise<unknown>;
} = {}): Promise<SendHarness> {
  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const settings = new InMemorySettingsRepository();
  const delivery = new InMemoryDeliveryProvider();
  const audit = new InMemoryAuditRepository();
  await settings.create(seedSettings({ paymentCollectionMode: opts.mode ?? null }));
  const customer = makeCustomer();
  await customerRepo.create(customer);
  const job = makeJob(customer.id);
  await jobRepo.create(job);
  const invoice = makeInvoice(job.id);
  await invoiceRepo.create(invoice);
  const send = new SendService(withOutbound({
    delivery,
    estimateRepo: new InMemoryEstimateRepository(),
    invoiceRepo,
    jobRepo,
    customerRepo,
    settingsRepo: opts.settingsRepo ?? settings,
    dispatchRepo: new InMemoryDispatchRepository(),
    auditRepo: audit,
    publicBaseUrl: 'https://app.example.com',
    ensureInvoicePayLink: opts.ensureInvoicePayLink ?? (async () => undefined),
  }));
  return { send, delivery, settings, invoiceRepo, audit, invoice };
}

describe('sendInvoice honours payment_collection_mode', () => {
  it('collect_on_site → the text carries the view URL and the in-person note, no pay CTA; the email too', async () => {
    const h = await buildSendHarness({ mode: 'collect_on_site' });
    const result = await h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'both' });

    expect(result.paymentCollectionMode).toBe('collect_on_site');
    expect(h.delivery.sentSms).toHaveLength(1);
    const sms = h.delivery.sentSms[0].body;
    expect(sms).toContain(`See your invoice: ${result.viewUrl}`);
    expect(sms).toContain('Acme HVAC collects payment in person. Settle up when the work is done.');
    expect(sms).not.toMatch(/pay online/i);

    expect(h.delivery.sentEmails).toHaveLength(1);
    const email = h.delivery.sentEmails[0];
    expect(email.text).toContain(`See your invoice here: ${result.viewUrl}`);
    expect(email.text).toContain('Acme HVAC collects payment in person. Settle up when the work is done.');
    expect(email.text).not.toMatch(/pay online/i);
    expect(email.html).toContain('View Invoice');
    expect(email.html).not.toContain('Pay Invoice Online');

    // No link anywhere on the row either.
    const stored = await h.invoiceRepo.findById(TENANT, h.invoice.id);
    expect(stored?.stripePaymentLinkUrl).toBeUndefined();
    expect(stored?.stripePaymentLinkId).toBeUndefined();
    expect(stored?.sentAt).toBeInstanceOf(Date);
  });

  it('pay_link → the message is byte-identical to today (pay CTA, no note)', async () => {
    const stored = await buildSendHarness({ mode: 'pay_link' });
    const unset = await buildSendHarness({ mode: null });
    for (const h of [stored, unset]) {
      const result = await h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'both' });
      expect(result.paymentCollectionMode).toBe('pay_link');
      const sms = h.delivery.sentSms[0].body;
      expect(sms).toBe(
        [
          'Hi Sarah Johnson — your invoice from Acme HVAC is ready.',
          'Invoice INV-2042: $1250.00',
          `Pay online: ${result.viewUrl}`,
        ].join('\n'),
      );
      expect(sms).not.toContain('collects payment in person');
      expect(h.delivery.sentEmails[0].text).toContain(`Pay online here: ${result.viewUrl}`);
      expect(h.delivery.sentEmails[0].html).toContain('Pay Invoice Online');
    }
  });

  it('mode changed between issue and send → the value at send time wins', async () => {
    const h = await buildSendHarness({ mode: 'pay_link' });
    // The invoice was issued while the tenant texted pay links; the owner
    // then switched to collecting on site before anyone sent it.
    await h.settings.update(TENANT, { paymentCollectionMode: 'collect_on_site' });
    const result = await h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'sms' });
    expect(result.paymentCollectionMode).toBe('collect_on_site');
    expect(h.delivery.sentSms[0].body).not.toMatch(/pay online/i);
    expect(h.delivery.sentSms[0].body).toContain('collects payment in person');
  });

  it('settings read throws → D-045: nothing is sent, the owner gets the reason, one audit row (surface send)', async () => {
    const h = await buildSendHarness({ settingsRepo: throwingSettingsRepo(new Error('pool exhausted')) });

    await expect(
      h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'both' }),
    ).rejects.toMatchObject({
      code: 'PAY_LINK_UNAVAILABLE',
      statusCode: 503,
      message: expect.stringContaining("its pay link couldn't be made"),
    });
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);

    const rows = await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id);
    const unavailable = rows.filter((r) => r.eventType === 'invoice.payment_mode_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].metadata).toMatchObject({
      reason: 'payment_mode_unavailable',
      surface: 'send',
      error: 'pool exhausted',
    });
  });

  it('pay_link → the pay link is made before anything is sent', async () => {
    const order: string[] = [];
    const h = await buildSendHarness({
      mode: 'pay_link',
      ensureInvoicePayLink: async (tenantId, invoiceId) => {
        order.push(`link:${tenantId}:${invoiceId}`);
      },
    });
    await h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'sms' });
    expect(order).toEqual([`link:${TENANT}:${h.invoice.id}`]);
    expect(h.delivery.sentSms).toHaveLength(1);
  });

  it('pay_link, but the link cannot be made → D-045: nothing is sent and the reason is named', async () => {
    const h = await buildSendHarness({
      mode: 'pay_link',
      ensureInvoicePayLink: async () => {
        throw new Error('Stripe is not answering');
      },
    });
    await expect(
      h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'both' }),
    ).rejects.toMatchObject({
      code: 'PAY_LINK_UNAVAILABLE',
      message: expect.stringContaining('the payment provider did not answer'),
    });
    // The provider's own words (an HTTP body, ids) never reach the owner.
    await expect(
      h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'both' }),
    ).rejects.not.toMatchObject({ message: expect.stringContaining('Stripe is not answering') });
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);
  });

  it('pay_link, refused by our own check (an AppError) → its owner-facing reason is shown', async () => {
    const h = await buildSendHarness({
      mode: 'pay_link',
      ensureInvoicePayLink: async () => {
        throw new AppError('PAYMENTS_NOT_CONNECTED', 'online payments are not set up for this business', 409);
      },
    });
    await expect(
      h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'sms' }),
    ).rejects.toMatchObject({
      code: 'PAY_LINK_UNAVAILABLE',
      message: expect.stringContaining('online payments are not set up for this business'),
    });
    expect(h.delivery.sentSms).toHaveLength(0);
  });

  it('collect_on_site, or nothing left to pay → no pay link is asked for', async () => {
    const ensure = vi.fn(async () => undefined);
    const onSite = await buildSendHarness({ mode: 'collect_on_site', ensureInvoicePayLink: ensure });
    await onSite.send.sendInvoice({ tenantId: TENANT, invoiceId: onSite.invoice.id, channel: 'sms' });

    const paid = await buildSendHarness({ mode: 'pay_link', ensureInvoicePayLink: ensure });
    await paid.invoiceRepo.update(TENANT, paid.invoice.id, { amountDueCents: 0 });
    await paid.send.sendInvoice({ tenantId: TENANT, invoiceId: paid.invoice.id, channel: 'sms' });

    expect(ensure).not.toHaveBeenCalled();
    expect(onSite.delivery.sentSms).toHaveLength(1);
    expect(paid.delivery.sentSms).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The operator mint — POST /api/invoices/:id/payment-link →
// createInvoicePaymentLink. The mode is read BEFORE generateLink: the
// provider fake must never be asked for a link on a collect-on-site tenant,
// nor when the policy cannot be read.
// ─────────────────────────────────────────────────────────────────────────────
import { createInvoicePaymentLink } from '../../src/invoices/invoice-payment-link';
import { MockPaymentLinkProvider } from '../../src/payments/payment-link-provider';
import type { PaymentLinkRequest, PaymentLinkResult } from '../../src/payments/payment-link-provider';

/** The repo's provider fake, plus a count of mint requests. */
class CountingProvider extends MockPaymentLinkProvider {
  mintRequests: PaymentLinkRequest[] = [];
  override async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
    this.mintRequests.push(request);
    return super.generateLink(request);
  }
}

async function seededSettings(mode: 'pay_link' | 'collect_on_site' | null): Promise<InMemorySettingsRepository> {
  const repo = new InMemorySettingsRepository();
  await repo.create(seedSettings({ paymentCollectionMode: mode }));
  return repo;
}

async function openInvoice(repo: InMemoryInvoiceRepository, overrides: Partial<Invoice> = {}): Promise<Invoice> {
  return repo.create(makeInvoice(uuidv4(), overrides));
}

describe('createInvoicePaymentLink honours payment_collection_mode', () => {
  it('collect_on_site → 409 COLLECT_ON_SITE, generateLink never called, nothing stored', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await openInvoice(invoiceRepo);
    const provider = new CountingProvider();
    await expect(
      createInvoicePaymentLink(TENANT, invoice.id, {
        invoiceRepo,
        provider,
        settingsRepo: await seededSettings('collect_on_site'),
      }),
    ).rejects.toMatchObject({ code: 'COLLECT_ON_SITE', statusCode: 409 });
    expect(provider.mintRequests).toHaveLength(0);
    const stored = await invoiceRepo.findById(TENANT, invoice.id);
    expect(stored?.stripePaymentLinkId).toBeUndefined();
  });

  it('collect_on_site → even a link already on the row is not served', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await openInvoice(invoiceRepo, {
      stripePaymentLinkId: 'plink_old',
      stripePaymentLinkUrl: 'https://pay.mock.com/plink_old',
    });
    await expect(
      createInvoicePaymentLink(TENANT, invoice.id, {
        invoiceRepo,
        provider: new CountingProvider(),
        settingsRepo: await seededSettings('collect_on_site'),
      }),
    ).rejects.toMatchObject({ code: 'COLLECT_ON_SITE' });
  });

  it('pay_link and an unset key → mints exactly as today', async () => {
    for (const mode of ['pay_link', null] as const) {
      const invoiceRepo = new InMemoryInvoiceRepository();
      const invoice = await openInvoice(invoiceRepo);
      const provider = new CountingProvider();
      const result = await createInvoicePaymentLink(TENANT, invoice.id, {
        invoiceRepo,
        provider,
        settingsRepo: await seededSettings(mode),
      });
      expect(result.url).toMatch(/^https:\/\/pay\.mock\.com\//);
      expect(provider.mintRequests).toHaveLength(1);
      expect((await invoiceRepo.findById(TENANT, invoice.id))?.stripePaymentLinkUrl).toBe(result.url);
    }
  });

  it('settings read throws → 503 PAYMENT_MODE_UNAVAILABLE, no mint, audited (surface checkout); recovers next call only when pay_link', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await openInvoice(invoiceRepo);
    const provider = new CountingProvider();
    const audit = new InMemoryAuditRepository();
    await expect(
      createInvoicePaymentLink(TENANT, invoice.id, {
        invoiceRepo,
        provider,
        settingsRepo: throwingSettingsRepo(new Error('db down')),
        auditRepo: audit,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_MODE_UNAVAILABLE', statusCode: 503 });
    expect(provider.mintRequests).toHaveLength(0);
    const rows = (await audit.findByEntity(TENANT, 'invoice', invoice.id)).filter(
      (r) => r.eventType === 'invoice.payment_mode_unavailable',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ surface: 'checkout', error: 'db down' });

    // The repo recovers, but the stored policy is collect-on-site: still no link.
    await expect(
      createInvoicePaymentLink(TENANT, invoice.id, {
        invoiceRepo,
        provider,
        settingsRepo: await seededSettings('collect_on_site'),
        auditRepo: audit,
      }),
    ).rejects.toMatchObject({ code: 'COLLECT_ON_SITE' });
    expect(provider.mintRequests).toHaveLength(0);

    // Recovered AND pay_link: a link is minted.
    const result = await createInvoicePaymentLink(TENANT, invoice.id, {
      invoiceRepo,
      provider,
      settingsRepo: await seededSettings('pay_link'),
      auditRepo: audit,
    });
    expect(result.url).toMatch(/^https:\/\/pay\.mock\.com\//);
    expect(provider.mintRequests).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The public invoice page — PublicInvoiceService: `getOrCreateCheckoutUrl`
// (provider-fallback path and direct-Stripe path) and the view `toView`
// builds for /pay/:token.
// ─────────────────────────────────────────────────────────────────────────────
import { PublicInvoiceService } from '../../src/invoices/public-invoice-service';

const VIEW_TOKEN = 'a-very-long-and-unguessable-token-9876';

async function buildPublicService(opts: {
  mode?: 'pay_link' | 'collect_on_site' | null;
  settingsRepo?: SettingsRepository;
  direct?: boolean;
  invoiceOverrides?: Partial<Invoice>;
}) {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const jobRepo = new InMemoryJobRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const audit = new InMemoryAuditRepository();
  const customer = makeCustomer();
  await customerRepo.create(customer);
  const job = makeJob(customer.id);
  await jobRepo.create(job);
  const invoice = await invoiceRepo.create(
    makeInvoice(job.id, { viewToken: VIEW_TOKEN, ...opts.invoiceOverrides }),
  );
  const provider = new CountingProvider();
  const stripeCalls: string[] = [];
  const stripeFetch = (async (url: string) => {
    stripeCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ id: 'plink_direct', url: 'https://buy.stripe.com/test_direct' }),
    };
  }) as unknown as typeof fetch;
  const service = new PublicInvoiceService({
    invoiceRepo,
    jobRepo,
    customerRepo,
    settingsRepo: opts.settingsRepo ?? (await seededSettings(opts.mode ?? null)),
    auditRepo: audit,
    ...(opts.direct
      ? { stripeConfig: { apiKey: 'sk_test_x' }, stripeFetch }
      : { paymentLinkProvider: provider }),
  });
  return { service, invoiceRepo, invoice, provider, stripeCalls, audit };
}

describe('PublicInvoiceService honours payment_collection_mode', () => {
  for (const direct of [false, true]) {
    const path = direct ? 'direct-Stripe path' : 'provider-fallback path';

    it(`${path}: collect_on_site → COLLECT_ON_SITE and nothing is minted`, async () => {
      const h = await buildPublicService({ mode: 'collect_on_site', direct });
      await expect(h.service.getOrCreateCheckoutUrl(VIEW_TOKEN)).rejects.toMatchObject({
        code: 'COLLECT_ON_SITE',
        statusCode: 409,
      });
      expect(h.provider.mintRequests).toHaveLength(0);
      expect(h.stripeCalls).toHaveLength(0);
      expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
    });

    it(`${path}: unreadable → PAYMENT_MODE_UNAVAILABLE (503), nothing minted, audited (surface checkout)`, async () => {
      const h = await buildPublicService({ settingsRepo: throwingSettingsRepo(new Error('db down')), direct });
      await expect(h.service.getOrCreateCheckoutUrl(VIEW_TOKEN)).rejects.toMatchObject({
        code: 'PAYMENT_MODE_UNAVAILABLE',
        statusCode: 503,
      });
      expect(h.provider.mintRequests).toHaveLength(0);
      expect(h.stripeCalls).toHaveLength(0);
      const rows = (await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id)).filter(
        (r) => r.eventType === 'invoice.payment_mode_unavailable',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ surface: 'checkout' });
    });

    it(`${path}: pay_link / unset → mints as today`, async () => {
      for (const mode of ['pay_link', null] as const) {
        const h = await buildPublicService({ mode, direct });
        const { url } = await h.service.getOrCreateCheckoutUrl(VIEW_TOKEN);
        expect(url).toMatch(direct ? /^https:\/\/buy\.stripe\.com\// : /^https:\/\/pay\.mock\.com\//);
        expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkUrl).toBe(url);
      }
    });
  }

  it('collect_on_site: a stored link is not served by checkout either', async () => {
    const h = await buildPublicService({
      mode: 'collect_on_site',
      invoiceOverrides: { stripePaymentLinkId: 'plink_old', stripePaymentLinkUrl: 'https://pay.mock.com/old' },
    });
    await expect(h.service.getOrCreateCheckoutUrl(VIEW_TOKEN)).rejects.toMatchObject({ code: 'COLLECT_ON_SITE' });
  });

  it('the view carries paymentCollectionMode and hides a leftover link under collect_on_site', async () => {
    const h = await buildPublicService({
      mode: 'collect_on_site',
      invoiceOverrides: { stripePaymentLinkId: 'plink_old', stripePaymentLinkUrl: 'https://pay.mock.com/old' },
    });
    const view = await h.service.getByToken(VIEW_TOKEN);
    expect(view.paymentCollectionMode).toBe('collect_on_site');
    expect(view.stripePaymentLinkUrl).toBeUndefined();
    expect(view.businessName).toBe('Acme HVAC');
    expect(view.amountDueCents).toBe(125000);

    const payLink = await buildPublicService({ mode: null, invoiceOverrides: { stripePaymentLinkUrl: 'https://pay.mock.com/x' } });
    const asToday = await payLink.service.getByToken(VIEW_TOKEN);
    expect(asToday.paymentCollectionMode).toBe('pay_link');
    expect(asToday.stripePaymentLinkUrl).toBe('https://pay.mock.com/x');
  });

  it('the view still renders when settings cannot be read: unavailable, no link, audited (surface public_page)', async () => {
    const h = await buildPublicService({
      settingsRepo: throwingSettingsRepo(new Error('db down')),
      invoiceOverrides: { stripePaymentLinkUrl: 'https://pay.mock.com/old' },
    });
    const view = await h.service.getByToken(VIEW_TOKEN);
    expect(view.paymentCollectionMode).toBe('unavailable');
    expect(view.stripePaymentLinkUrl).toBeUndefined();
    expect(view.businessName).toBe('Service team');
    expect(view.invoiceNumber).toBe('INV-2042');
    const rows = (await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id)).filter(
      (r) => r.eventType === 'invoice.payment_mode_unavailable',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ surface: 'public_page' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route level — supertest over the real routers. /pay/:token really pays
// through POST /api/public-payments/create-payment-intent (<PaymentElement>),
// so that route gets the same gate as the Payment Link checkout.
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
import request from 'supertest';
import { createPublicPaymentsRouter } from '../../src/routes/public-payments';
import { createPublicInvoicesRouter } from '../../src/routes/public-invoices';
import type { StripeFetch } from '../../src/payments/stripe-payment-intent';

describe('POST /api/public-payments/create-payment-intent honours payment_collection_mode', () => {
  async function buildPaymentsApp(opts: { mode?: 'pay_link' | 'collect_on_site' | null; settingsRepo?: SettingsRepository }) {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const invoice = await invoiceRepo.create(makeInvoice(uuidv4(), { viewToken: 'b'.repeat(32) }));
    const audit = new InMemoryAuditRepository();
    const stripeCalls: string[] = [];
    const stripeFetch = (async (url: string) => {
      stripeCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: 'pi_test_123', client_secret: 'pi_test_123_secret_abc' }),
      };
    }) as unknown as StripeFetch;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/public-payments',
      createPublicPaymentsRouter({
        invoiceRepo,
        settingsRepo: opts.settingsRepo ?? (await seededSettings(opts.mode ?? null)),
        auditRepo: audit,
        stripeConfig: { apiKey: 'sk_test_x' },
        stripeFetch,
      }),
    );
    return { app, invoice, stripeCalls, audit };
  }

  it('collect_on_site → 409 COLLECT_ON_SITE and no PaymentIntent is created', async () => {
    const h = await buildPaymentsApp({ mode: 'collect_on_site' });
    const res = await request(h.app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: h.invoice.id, viewToken: 'b'.repeat(32) });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'COLLECT_ON_SITE' });
    expect(h.stripeCalls).toHaveLength(0);
  });

  it('unreadable → 503 PAYMENT_MODE_UNAVAILABLE, no PaymentIntent, audited (surface payment_intent)', async () => {
    const h = await buildPaymentsApp({ settingsRepo: throwingSettingsRepo(new Error('db down')) });
    const res = await request(h.app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: h.invoice.id, viewToken: 'b'.repeat(32) });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'PAYMENT_MODE_UNAVAILABLE' });
    expect(h.stripeCalls).toHaveLength(0);
    const rows = (await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id)).filter(
      (r) => r.eventType === 'invoice.payment_mode_unavailable',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ surface: 'payment_intent' });
  });

  it('pay_link / unset → the PaymentIntent is created as today', async () => {
    for (const mode of ['pay_link', null] as const) {
      const h = await buildPaymentsApp({ mode });
      const res = await request(h.app)
        .post('/api/public-payments/create-payment-intent')
        .send({ invoiceId: h.invoice.id, viewToken: 'b'.repeat(32) });
      expect(res.status).toBe(200);
      expect(res.body.clientSecret).toBe('pi_test_123_secret_abc');
      expect(h.stripeCalls).toHaveLength(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The portal list — GET /api/public/portal/:token/invoices. A GET cannot 409:
// under collect_on_site (or an unreadable policy) every row carries
// `payNowUrl: null, collectOnSite: true` and nothing is minted or stored.
// ─────────────────────────────────────────────────────────────────────────────
import { createPublicPortalRouter } from '../../src/routes/public-portal';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import { hashPortalToken } from '../../src/portal/portal-service';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryLeadRepository } from '../../src/leads/lead';

describe('GET /api/public/portal/:token/invoices honours payment_collection_mode', () => {
  const PORTAL_TOKEN = 'c'.repeat(64);

  async function buildPortalApp(opts: { mode?: 'pay_link' | 'collect_on_site' | null; settingsRepo?: SettingsRepository }) {
    const portalRepo = new InMemoryPortalSessionRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const jobRepo = new InMemoryJobRepository();
    const audit = new InMemoryAuditRepository();
    const provider = new CountingProvider();
    const customer = makeCustomer();
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);
    const invoice = await invoiceRepo.create(makeInvoice(job.id));
    await portalRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      customerId: customer.id,
      tokenHash: hashPortalToken(PORTAL_TOKEN),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdBy: 'user-1',
      createdAt: new Date(),
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/public/portal',
      createPublicPortalRouter({
        portalRepo,
        customerRepo,
        estimateRepo: new InMemoryEstimateRepository(),
        invoiceRepo,
        jobRepo,
        agreementRepo: new InMemoryAgreementRepository(),
        appointmentRepo: new InMemoryAppointmentRepository(),
        leadRepo: new InMemoryLeadRepository(),
        auditRepo: audit,
        settingsRepo: opts.settingsRepo ?? (await seededSettings(opts.mode ?? null)),
        paymentLinkProvider: provider,
      }),
    );
    return { app, invoice, invoiceRepo, provider, audit };
  }

  it('collect_on_site → payNowUrl null, collectOnSite true, nothing minted or stored', async () => {
    const h = await buildPortalApp({ mode: 'collect_on_site' });
    const res = await request(h.app).get(`/api/public/portal/${PORTAL_TOKEN}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0]).toMatchObject({ id: h.invoice.id, payNowUrl: null, collectOnSite: true });
    expect(h.provider.mintRequests).toHaveLength(0);
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
  });

  it('unreadable → the same rows, nothing minted, one tenant-level audit row (surface portal)', async () => {
    const h = await buildPortalApp({ settingsRepo: throwingSettingsRepo(new Error('db down')) });
    const res = await request(h.app).get(`/api/public/portal/${PORTAL_TOKEN}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.invoices[0]).toMatchObject({ payNowUrl: null, collectOnSite: true });
    expect(h.provider.mintRequests).toHaveLength(0);
    const rows = (await h.audit.findByEntity(TENANT, 'tenant', TENANT)).filter(
      (r) => r.eventType === 'invoice.payment_mode_unavailable',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ surface: 'portal', error: 'db down' });
  });

  it('pay_link / unset → a link is minted and persisted as today, collectOnSite false', async () => {
    for (const mode of ['pay_link', null] as const) {
      const h = await buildPortalApp({ mode });
      const res = await request(h.app).get(`/api/public/portal/${PORTAL_TOKEN}/invoices`);
      expect(res.status).toBe(200);
      expect(res.body.invoices[0].payNowUrl).toMatch(/^https:\/\/pay\.mock\.com\//);
      expect(res.body.invoices[0].collectOnSite).toBe(false);
      expect(h.provider.mintRequests).toHaveLength(1);
    }
  });
});

describe('public invoices router honours payment_collection_mode', () => {
  async function buildInvoicesApp(opts: { mode?: 'pay_link' | 'collect_on_site' | null; settingsRepo?: SettingsRepository }) {
    const h = await buildPublicService({ mode: opts.mode, settingsRepo: opts.settingsRepo });
    const app = express();
    app.use(express.json());
    app.use('/public/invoices', createPublicInvoicesRouter(h.service));
    return { ...h, app };
  }

  it('POST /public/invoices/:token/checkout → 409 COLLECT_ON_SITE for collect_on_site', async () => {
    const h = await buildInvoicesApp({ mode: 'collect_on_site' });
    const res = await request(h.app).post(`/public/invoices/${VIEW_TOKEN}/checkout`).send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'COLLECT_ON_SITE', message: 'This business collects payment in person.' });
    expect(h.provider.mintRequests).toHaveLength(0);
  });

  it('POST /public/invoices/:token/checkout → 503 PAYMENT_MODE_UNAVAILABLE when unreadable', async () => {
    const h = await buildInvoicesApp({ settingsRepo: throwingSettingsRepo() });
    const res = await request(h.app).post(`/public/invoices/${VIEW_TOKEN}/checkout`).send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'PAYMENT_MODE_UNAVAILABLE',
      message: 'Payment options are not available right now. Try again in a moment.',
    });
    expect(h.provider.mintRequests).toHaveLength(0);
  });

  it('GET /public/invoices/:token carries paymentCollectionMode on every outcome', async () => {
    for (const [opts, expected] of [
      [{ mode: 'collect_on_site' as const }, 'collect_on_site'],
      [{ mode: null }, 'pay_link'],
      [{ settingsRepo: throwingSettingsRepo() }, 'unavailable'],
    ] as const) {
      const h = await buildInvoicesApp(opts);
      const res = await request(h.app).get(`/public/invoices/${VIEW_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.paymentCollectionMode).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The owner routes — POST /api/invoices/:id/send audits the mode it applied;
// POST /api/invoices/:id/payment-link surfaces the refusal as its code.
// ─────────────────────────────────────────────────────────────────────────────
import type { Request, Response, NextFunction } from 'express';
import { createInvoiceRouter } from '../../src/routes/invoices';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('owner invoice routes honour payment_collection_mode', () => {
  // The request-transaction middleware rolls back any >=400 response unless
  // the route sets res.locals.forceCommit; captured at response time.
  let lastForceCommit: unknown;

  async function buildOwnerApp(
    mode: 'pay_link' | 'collect_on_site' | null,
    settingsRepo?: SettingsRepository,
    customerOverrides: Partial<Customer> = {},
  ) {
    lastForceCommit = undefined;
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const settings = settingsRepo ?? (await seededSettings(mode));
    const delivery = new InMemoryDeliveryProvider();
    const audit = new InMemoryAuditRepository();
    const provider = new CountingProvider();
    const customer = makeCustomer(customerOverrides);
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);
    const invoice = await invoiceRepo.create(makeInvoice(job.id));
    const sendService = new SendService(withOutbound({
      delivery,
      estimateRepo: new InMemoryEstimateRepository(),
      invoiceRepo,
      jobRepo,
      customerRepo,
      settingsRepo: settings,
      dispatchRepo: new InMemoryDispatchRepository(),
      auditRepo: audit,
      publicBaseUrl: 'https://app.example.com',
      ensureInvoicePayLink: (tenantId, invoiceId) =>
        createInvoicePaymentLink(tenantId, invoiceId, { invoiceRepo, provider, settingsRepo: settings, auditRepo: audit }),
    }));
    const app = express();
    app.use(express.json());
    app.use((req: Request, res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'user-1', sessionId: 's', tenantId: TENANT, role: 'owner' };
      res.on('finish', () => {
        lastForceCommit = res.locals.forceCommit;
      });
      next();
    });
    app.use(
      '/api/invoices',
      createInvoiceRouter(
        invoiceRepo,
        settings,
        audit,
        permissiveTenantOwnership(),
        undefined,
        sendService,
        jobRepo,
        undefined,
        provider,
      ),
    );
    return { app, invoice, invoiceRepo, audit, provider, delivery };
  }

  it('POST /:id/send records the send-time mode on invoice.sent', async () => {
    for (const [mode, expected] of [
      ['collect_on_site', 'collect_on_site'],
      ['pay_link', 'pay_link'],
      [null, 'pay_link'],
    ] as const) {
      const h = await buildOwnerApp(mode);
      const res = await request(h.app).post(`/api/invoices/${h.invoice.id}/send`).send({ channel: 'sms' });
      expect(res.status).toBe(202);
      expect(res.body.paymentCollectionMode).toBe(expected);
      const sent = (await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id)).filter(
        (r) => r.eventType === 'invoice.sent',
      );
      expect(sent).toHaveLength(1);
      expect(sent[0].metadata).toMatchObject({ channels: ['sms'], paymentCollectionMode: expected });
    }
  });

  it('POST /:id/send on an unreadable policy → D-045: 503 with the reason, nothing sent, the occurrence audited', async () => {
    const h = await buildOwnerApp(null, throwingSettingsRepo(new Error('db down')));
    const res = await request(h.app).post(`/api/invoices/${h.invoice.id}/send`).send({ channel: 'sms' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'PAY_LINK_UNAVAILABLE' });
    expect(res.body.message).toContain('was not sent');
    expect(h.delivery.sentSms).toHaveLength(0);
    const rows = await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id);
    expect(rows.find((r) => r.eventType === 'invoice.sent')).toBeUndefined();
    expect(rows.filter((r) => r.eventType === 'invoice.payment_mode_unavailable')).toHaveLength(1);
    // The 503 commits, or the request transaction would roll the audit row back.
    expect(lastForceCommit).toBe(true);
  });

  it('POST /:id/send with no recipient on file → 400 before any pay link is made', async () => {
    const h = await buildOwnerApp('pay_link', undefined, { primaryPhone: undefined, email: undefined });
    const res = await request(h.app).post(`/api/invoices/${h.invoice.id}/send`).send({ channel: 'sms' });
    expect(res.status).toBe(400);
    expect(h.provider.mintRequests).toHaveLength(0);
    expect(lastForceCommit).toBeUndefined();
  });

  it('POST /:id/send: every channel fails after the link was made → the response commits, so the link stays on the invoice', async () => {
    const h = await buildOwnerApp('pay_link');
    vi.spyOn(h.delivery, 'sendSms').mockRejectedValue(new Error('carrier down'));
    const res = await request(h.app).post(`/api/invoices/${h.invoice.id}/send`).send({ channel: 'sms' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/failed on all channels/);
    expect(h.provider.mintRequests).toHaveLength(1);
    expect(lastForceCommit).toBe(true);
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkUrl).toMatch(/^https:\/\/pay\.mock\.com\//);
  });

  it('POST /:id/send in pay_link mode mints the pay link before the text goes out', async () => {
    const h = await buildOwnerApp('pay_link');
    const res = await request(h.app).post(`/api/invoices/${h.invoice.id}/send`).send({ channel: 'sms' });
    expect(res.status).toBe(202);
    expect(h.provider.mintRequests).toHaveLength(1);
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkUrl).toMatch(/^https:\/\/pay\.mock\.com\//);
    expect(h.delivery.sentSms).toHaveLength(1);
  });

  it('POST /:id/payment-link → 409 COLLECT_ON_SITE / 503 PAYMENT_MODE_UNAVAILABLE, never a mint', async () => {
    const collect = await buildOwnerApp('collect_on_site');
    const r1 = await request(collect.app).post(`/api/invoices/${collect.invoice.id}/payment-link`).send({});
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ error: 'COLLECT_ON_SITE' });
    expect(collect.provider.mintRequests).toHaveLength(0);

    const broken = await buildOwnerApp(null, throwingSettingsRepo());
    const r2 = await request(broken.app).post(`/api/invoices/${broken.invoice.id}/payment-link`).send({});
    expect(r2.status).toBe(503);
    expect(r2.body).toMatchObject({ error: 'PAYMENT_MODE_UNAVAILABLE' });
    expect(broken.provider.mintRequests).toHaveLength(0);

    const asToday = await buildOwnerApp(null);
    const r3 = await request(asToday.app).post(`/api/invoices/${asToday.invoice.id}/payment-link`).send({});
    expect(r3.status).toBe(200);
    expect(r3.body.url).toMatch(/^https:\/\/pay\.mock\.com\//);
  });
});

describe('renderCollectOnSiteInactiveMessage — what an already-sent link shows (S5a-3)', () => {
  it('with the owner\'s first name: the plan\'s sentence', () => {
    expect(
      renderCollectOnSiteInactiveMessage({ businessName: 'Acme HVAC', ownerFirstName: 'Dana' }),
    ).toBe('Acme HVAC collects payment in person. Please settle up with Dana when the work is done.');
  });

  it('without a first name (absent, empty or blank): the business-name-only sentence, never a placeholder', () => {
    const expected = 'Acme HVAC collects payment in person. Please settle up when the work is done.';
    expect(renderCollectOnSiteInactiveMessage({ businessName: 'Acme HVAC' })).toBe(expected);
    expect(renderCollectOnSiteInactiveMessage({ businessName: 'Acme HVAC', ownerFirstName: '' })).toBe(expected);
    expect(renderCollectOnSiteInactiveMessage({ businessName: ' Acme HVAC ', ownerFirstName: '   ' })).toBe(expected);
  });

  it('stays within Stripe\'s 500-character inactive_message limit for any business or owner name', () => {
    const longName = 'B'.repeat(800);
    const longOwner = 'O'.repeat(800);
    for (const msg of [
      renderCollectOnSiteInactiveMessage({ businessName: longName, ownerFirstName: 'Dana' }),
      renderCollectOnSiteInactiveMessage({ businessName: longName }),
      renderCollectOnSiteInactiveMessage({ businessName: 'Acme HVAC', ownerFirstName: longOwner }),
    ]) {
      expect(msg.length).toBeLessThanOrEqual(500);
      expect(msg).toContain('collects payment in person.');
      expect(msg.endsWith('when the work is done.')).toBe(true);
    }
  });

  it('an empty business name falls back to plain words, not a blank subject', () => {
    expect(renderCollectOnSiteInactiveMessage({ businessName: '  ' })).toBe(
      'Your service team collects payment in person. Please settle up when the work is done.',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S5a-4 (U8) — attach-time revalidation. A checkout reads `pay_link`, stalls
// in the provider mint, and the owner's switch to "Collect on the spot"
// commits meanwhile. The guarded attach re-reads the mode (in Pg under the
// per-tenant payment-mode lock), so the fresh link is never stored: every
// mint site deactivates it (reason `payment_mode_changed_during_checkout`)
// and answers 409 COLLECT_ON_SITE — not "invoice changed", and never a
// competing mint's link. An attach that throws is an unreadable mode: the
// link dies too and the answer is 503 with `invoice.payment_mode_unavailable`.
// The in-memory twin takes the mode through an injected `modeLookup`.
// ─────────────────────────────────────────────────────────────────────────────
import { paymentModeLockKey } from '../../src/invoices/payment-collection-mode';
import { withOutbound } from '../helpers/outbound-messaging';

/** modeLookup over a settings repo: the in-memory stand-in for the attach's own read. */
function modeFrom(settings: SettingsRepository) {
  return async (tenantId: string) => (await settings.findByTenant(tenantId))?.paymentCollectionMode ?? 'pay_link';
}

/**
 * A provider whose mint "stalls across the switch": while Stripe is minting,
 * the owner's settings write to collect_on_site commits. Records every mint.
 */
class SwitchDuringMintProvider extends CountingProvider {
  constructor(private readonly settings: InMemorySettingsRepository) {
    super();
  }
  override async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
    const link = await super.generateLink(request);
    await this.settings.update(request.tenantId, { paymentCollectionMode: 'collect_on_site' });
    return link;
  }
}

class FailingDeactivationProvider extends SwitchDuringMintProvider {
  override async deactivateLink(linkId: string, stripeAccountId?: string): Promise<void> {
    this.deactivations.push({ linkId, stripeAccountId });
    throw new Error('stripe down');
  }
}

function auditOf(audit: InMemoryAuditRepository, invoiceId: string, eventType: string) {
  return audit.findByEntity(TENANT, 'invoice', invoiceId).then((rows) => rows.filter((r) => r.eventType === eventType));
}

describe('paymentModeLockKey — the one key the attach, the claim and the settings write share', () => {
  it('is payment_mode:<tenantId>', () => {
    expect(paymentModeLockKey('t-1')).toBe('payment_mode:t-1');
  });
});

describe('InMemoryInvoiceRepository.attachPaymentLink — the guarded attach re-checks the mode', () => {
  const link = { linkId: 'plink_x', linkUrl: 'https://pay.mock.com/plink_x' };

  it('an unset lookup (default) and pay_link attach as today', async () => {
    for (const repo of [
      new InMemoryInvoiceRepository(),
      new InMemoryInvoiceRepository({ modeLookup: async () => 'pay_link' }),
    ]) {
      const invoice = await openInvoice(repo);
      const result = await repo.attachPaymentLink(TENANT, invoice.id, link, invoice.amountDueCents, new Date());
      expect(result.ok).toBe(true);
      expect(result.ok && result.invoice.stripePaymentLinkId).toBe('plink_x');
    }
  });

  it('collect_on_site → refused with mode_not_pay_link, nothing stored', async () => {
    const repo = new InMemoryInvoiceRepository({ modeLookup: async () => 'collect_on_site' });
    const invoice = await openInvoice(repo);
    expect(await repo.attachPaymentLink(TENANT, invoice.id, link, invoice.amountDueCents, new Date())).toEqual({
      ok: false,
      reason: 'mode_not_pay_link',
    });
    expect((await repo.findById(TENANT, invoice.id))?.stripePaymentLinkId).toBeUndefined();
  });

  it('a lookup that throws propagates (the caller treats it as unreadable), nothing stored', async () => {
    const repo = new InMemoryInvoiceRepository({ modeLookup: async () => { throw new Error('db down'); } });
    const invoice = await openInvoice(repo);
    await expect(repo.attachPaymentLink(TENANT, invoice.id, link, invoice.amountDueCents, new Date())).rejects.toThrow('db down');
    expect((await repo.findById(TENANT, invoice.id))?.stripePaymentLinkId).toBeUndefined();
  });

  it('a void, a changed balance or another link still lose as not_payable', async () => {
    const repo = new InMemoryInvoiceRepository();
    const voided = await openInvoice(repo, { status: 'void' });
    const linked = await openInvoice(repo, { stripePaymentLinkId: 'plink_other', stripePaymentLinkUrl: 'https://x/o' });
    const open = await openInvoice(repo);
    for (const [inv, due] of [[voided, voided.amountDueCents], [linked, linked.amountDueCents], [open, open.amountDueCents - 1]] as const) {
      expect(await repo.attachPaymentLink(TENANT, inv.id, link, due, new Date())).toEqual({ ok: false, reason: 'not_payable' });
    }
  });
});

describe('createInvoicePaymentLink — a checkout that stalls across the switch stores no link', () => {
  async function harness(provider: (s: InMemorySettingsRepository) => CountingProvider, lookup?: () => Promise<'pay_link'>) {
    const settingsRepo = await seededSettings('pay_link');
    const invoiceRepo = new InMemoryInvoiceRepository({ modeLookup: lookup ?? modeFrom(settingsRepo) });
    const invoice = await openInvoice(invoiceRepo);
    const audit = new InMemoryAuditRepository();
    return { settingsRepo, invoiceRepo, invoice, audit, provider: provider(settingsRepo) };
  }

  it('the switch commits during the mint → 409 COLLECT_ON_SITE, the fresh link is deactivated and audited, nothing stored', async () => {
    const h = await harness((s) => new SwitchDuringMintProvider(s));
    const err = await createInvoicePaymentLink(TENANT, h.invoice.id, {
      invoiceRepo: h.invoiceRepo,
      provider: h.provider,
      settingsRepo: h.settingsRepo,
      auditRepo: h.audit,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'COLLECT_ON_SITE', statusCode: 409 });
    expect(String(err.message)).not.toMatch(/Invoice changed/);
    const minted = (h.provider.deactivations[0] ?? {}).linkId;
    expect(h.provider.mintRequests).toHaveLength(1);
    expect(h.provider.deactivations).toEqual([{ linkId: minted, stripeAccountId: undefined, inactiveMessage: undefined }]);
    expect(h.provider.isActive(minted)).toBe(false);
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
    const rows = await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivated');
    expect(rows.map((r) => r.metadata)).toEqual([
      { stripePaymentLinkId: minted, reason: 'payment_mode_changed_during_checkout' },
    ]);
  });

  it('a failing deactivation of that link is audited with the link id; still 409', async () => {
    const h = await harness((s) => new FailingDeactivationProvider(s));
    await expect(
      createInvoicePaymentLink(TENANT, h.invoice.id, {
        invoiceRepo: h.invoiceRepo, provider: h.provider, settingsRepo: h.settingsRepo, auditRepo: h.audit,
      }),
    ).rejects.toMatchObject({ code: 'COLLECT_ON_SITE' });
    const rows = await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivation_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      stripePaymentLinkId: h.provider.deactivations[0].linkId,
      reason: 'payment_mode_changed_during_checkout',
      error: 'stripe down',
    });
  });

  it('the mode read inside the attach throws → 503, the fresh link is deactivated, audited (surface checkout), never read as pay_link', async () => {
    const h = await harness(() => new CountingProvider(), async () => { throw new Error('settings unreadable'); });
    await expect(
      createInvoicePaymentLink(TENANT, h.invoice.id, {
        invoiceRepo: h.invoiceRepo, provider: h.provider, settingsRepo: h.settingsRepo, auditRepo: h.audit,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_MODE_UNAVAILABLE', statusCode: 503 });
    expect(h.provider.mintRequests).toHaveLength(1);
    expect(h.provider.deactivations).toHaveLength(1);
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
    const unavailable = await auditOf(h.audit, h.invoice.id, 'invoice.payment_mode_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].metadata).toMatchObject({ surface: 'checkout', error: 'settings unreadable' });
    expect((await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivated'))[0]?.metadata).toMatchObject({
      reason: 'payment_mode_changed_during_checkout',
    });
  });

  it('pay_link throughout → attaches as today, no deactivation', async () => {
    const h = await harness(() => new CountingProvider());
    const result = await createInvoicePaymentLink(TENANT, h.invoice.id, {
      invoiceRepo: h.invoiceRepo, provider: h.provider, settingsRepo: h.settingsRepo, auditRepo: h.audit,
    });
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkUrl).toBe(result.url);
    expect(h.provider.deactivations).toHaveLength(0);
  });
});

describe('PublicInvoiceService — a checkout that stalls across the switch stores no link (both paths)', () => {
  async function stallHarness(opts: { direct: boolean; throwing?: boolean; deactivationFails?: boolean }) {
    const settingsRepo = await seededSettings('pay_link');
    const invoiceRepo = new InMemoryInvoiceRepository({
      modeLookup: opts.throwing ? async () => { throw new Error('settings unreadable'); } : modeFrom(settingsRepo),
    });
    const jobRepo = new InMemoryJobRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const audit = new InMemoryAuditRepository();
    const customer = makeCustomer();
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);
    const invoice = await invoiceRepo.create(makeInvoice(job.id, { viewToken: VIEW_TOKEN }));
    const provider = opts.deactivationFails
      ? new FailingDeactivationProvider(settingsRepo)
      : new SwitchDuringMintProvider(settingsRepo);
    const stripeCalls: Array<{ url: string; body: string }> = [];
    const stripeFetch = (async (url: string, init?: { body?: URLSearchParams }) => {
      stripeCalls.push({ url: String(url), body: String(init?.body ?? '') });
      if (String(url).endsWith('/v1/payment_links')) {
        await settingsRepo.update(TENANT, { paymentCollectionMode: 'collect_on_site' });
        return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'plink_direct', url: 'https://buy.stripe.com/test_direct' }) };
      }
      return { ok: !opts.deactivationFails, status: opts.deactivationFails ? 500 : 200, text: async () => '', json: async () => ({}) };
    }) as unknown as typeof fetch;
    const service = new PublicInvoiceService({
      invoiceRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      auditRepo: audit,
      ...(opts.direct ? { stripeConfig: { apiKey: 'sk_test_x' }, stripeFetch } : { paymentLinkProvider: provider }),
    });
    return { service, invoiceRepo, invoice, provider, stripeCalls, audit };
  }

  for (const direct of [false, true]) {
    const path = direct ? 'direct-Stripe path' : 'provider-fallback path';
    const linkIdOf = (h: Awaited<ReturnType<typeof stallHarness>>) =>
      direct ? 'plink_direct' : h.provider.deactivations[0]?.linkId;

    it(`${path}: switch during the mint → 409 COLLECT_ON_SITE, link deactivated + audited, nothing stored`, async () => {
      const h = await stallHarness({ direct });
      const err = await h.service.getOrCreateCheckoutUrl(VIEW_TOKEN).catch((e) => e);
      expect(err).toMatchObject({ code: 'COLLECT_ON_SITE', statusCode: 409 });
      expect(String(err.message)).not.toMatch(/Invoice changed/);
      if (direct) {
        expect(h.stripeCalls.map((c) => c.url)).toEqual([
          'https://api.stripe.com/v1/payment_links',
          'https://api.stripe.com/v1/payment_links/plink_direct',
        ]);
        expect(h.stripeCalls[1].body).toBe('active=false');
      } else {
        expect(h.provider.deactivations).toHaveLength(1);
        expect(h.provider.isActive(linkIdOf(h)!)).toBe(false);
      }
      expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
      const rows = await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivated');
      expect(rows.map((r) => r.metadata)).toEqual([
        { stripePaymentLinkId: linkIdOf(h), reason: 'payment_mode_changed_during_checkout' },
      ]);
      expect(await auditOf(h.audit, h.invoice.id, 'public_invoice.checkout_created')).toHaveLength(0);
    });

    it(`${path}: a failing deactivation is audited with the link id`, async () => {
      const h = await stallHarness({ direct, deactivationFails: true });
      await expect(h.service.getOrCreateCheckoutUrl(VIEW_TOKEN)).rejects.toMatchObject({ code: 'COLLECT_ON_SITE' });
      const rows = await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivation_failed');
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({
        stripePaymentLinkId: linkIdOf(h),
        reason: 'payment_mode_changed_during_checkout',
      });
    });

    it(`${path}: the attach's mode read throws → 503, link deactivated, audited (surface checkout)`, async () => {
      const h = await stallHarness({ direct, throwing: true });
      await expect(h.service.getOrCreateCheckoutUrl(VIEW_TOKEN)).rejects.toMatchObject({
        code: 'PAYMENT_MODE_UNAVAILABLE',
        statusCode: 503,
      });
      expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
      const unavailable = await auditOf(h.audit, h.invoice.id, 'invoice.payment_mode_unavailable');
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0].metadata).toMatchObject({ surface: 'checkout' });
      const deactivated = await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivated');
      expect(deactivated.map((r) => r.metadata?.reason)).toEqual(['payment_mode_changed_during_checkout']);
    });
  }
});

describe('GET /api/public/portal/:token/invoices — a mint that stalls across the switch', () => {
  const PORTAL_TOKEN = 'd'.repeat(64);

  async function buildStallPortal(opts: { throwing?: boolean }) {
    const settingsRepo = await seededSettings('pay_link');
    const portalRepo = new InMemoryPortalSessionRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const invoiceRepo = new InMemoryInvoiceRepository({
      modeLookup: opts.throwing ? async () => { throw new Error('settings unreadable'); } : modeFrom(settingsRepo),
    });
    const jobRepo = new InMemoryJobRepository();
    const audit = new InMemoryAuditRepository();
    const provider = new SwitchDuringMintProvider(settingsRepo);
    const customer = makeCustomer();
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);
    const invoice = await invoiceRepo.create(makeInvoice(job.id));
    await portalRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      customerId: customer.id,
      tokenHash: hashPortalToken(PORTAL_TOKEN),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdBy: 'user-1',
      createdAt: new Date(),
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/public/portal',
      createPublicPortalRouter({
        portalRepo,
        customerRepo,
        estimateRepo: new InMemoryEstimateRepository(),
        invoiceRepo,
        jobRepo,
        agreementRepo: new InMemoryAgreementRepository(),
        appointmentRepo: new InMemoryAppointmentRepository(),
        leadRepo: new InMemoryLeadRepository(),
        auditRepo: audit,
        settingsRepo,
        paymentLinkProvider: provider,
      }),
    );
    return { app, invoice, invoiceRepo, provider, audit };
  }

  it('the attach refuses → payNowUrl null, collectOnSite true, the fresh link deactivated and audited, nothing stored', async () => {
    const h = await buildStallPortal({});
    const res = await request(h.app).get(`/api/public/portal/${PORTAL_TOKEN}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.invoices[0]).toMatchObject({ id: h.invoice.id, payNowUrl: null, collectOnSite: true });
    expect(h.provider.mintRequests).toHaveLength(1);
    expect(h.provider.deactivations).toHaveLength(1);
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
    const rows = await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivated');
    expect(rows.map((r) => r.metadata?.reason)).toEqual(['payment_mode_changed_during_checkout']);
  });

  it('the attach throws → the same fail-closed row, the link deactivated, one portal audit of the unreadable mode', async () => {
    const h = await buildStallPortal({ throwing: true });
    const res = await request(h.app).get(`/api/public/portal/${PORTAL_TOKEN}/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.invoices[0]).toMatchObject({ payNowUrl: null, collectOnSite: true });
    expect(h.provider.deactivations).toHaveLength(1);
    expect((await h.invoiceRepo.findById(TENANT, h.invoice.id))?.stripePaymentLinkId).toBeUndefined();
    const unavailable = (await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id)).filter(
      (r) => r.eventType === 'invoice.payment_mode_unavailable',
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].metadata).toMatchObject({ surface: 'portal' });
  });

  it('a competing mint won (not_payable) → its link is served and ours is deactivated', async () => {
    const h = await buildStallPortal({});
    // The competing mint lands first, at the same balance, under pay_link.
    const winner = { linkId: 'plink_winner', linkUrl: 'https://pay.mock.com/plink_winner' };
    const inner = h.invoiceRepo;
    const original = inner.attachPaymentLink.bind(inner);
    inner.attachPaymentLink = async (...args) => {
      await inner.update(TENANT, h.invoice.id, { stripePaymentLinkId: winner.linkId, stripePaymentLinkUrl: winner.linkUrl, updatedAt: new Date() });
      return original(...args);
    };
    // The mode stays pay_link for this case: undo the provider's switch.
    h.provider.generateLink = CountingProvider.prototype.generateLink.bind(h.provider);
    const res = await request(h.app).get(`/api/public/portal/${PORTAL_TOKEN}/invoices`);
    expect(res.body.invoices[0]).toMatchObject({ payNowUrl: winner.linkUrl, collectOnSite: false });
    expect(h.provider.deactivations).toHaveLength(1);
    expect(h.provider.deactivations[0].linkId).not.toBe(winner.linkId);
  });

  it('a competing mint won and our link will not die at Stripe → its id is audited (mint_guard_lost), the winner is still served', async () => {
    const h = await buildStallPortal({});
    const winner = { linkId: 'plink_winner_2', linkUrl: 'https://pay.mock.com/plink_winner_2' };
    const inner = h.invoiceRepo;
    const original = inner.attachPaymentLink.bind(inner);
    inner.attachPaymentLink = async (...args) => {
      await inner.update(TENANT, h.invoice.id, { stripePaymentLinkId: winner.linkId, stripePaymentLinkUrl: winner.linkUrl, updatedAt: new Date() });
      return original(...args);
    };
    const minted: string[] = [];
    const counting = CountingProvider.prototype.generateLink.bind(h.provider);
    h.provider.generateLink = async (req) => {
      const result = await counting(req);
      minted.push(result.linkId);
      return result;
    };
    h.provider.deactivateLink = async () => {
      throw new Error('stripe deactivate unavailable');
    };
    const res = await request(h.app).get(`/api/public/portal/${PORTAL_TOKEN}/invoices`);
    expect(res.body.invoices[0]).toMatchObject({ payNowUrl: winner.linkUrl, collectOnSite: false });
    const failed = await auditOf(h.audit, h.invoice.id, 'invoice.payment_link_deactivation_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].metadata).toMatchObject({ reason: 'mint_guard_lost', error: 'stripe deactivate unavailable' });
    expect(minted).toHaveLength(1);
    expect(failed[0].metadata?.stripePaymentLinkId).toBe(minted[0]);
    expect(minted[0]).not.toBe(winner.linkId);
  });
});
