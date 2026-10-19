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
import { describe, it, expect } from 'vitest';
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
  const send = new SendService({
    delivery,
    estimateRepo: new InMemoryEstimateRepository(),
    invoiceRepo,
    jobRepo,
    customerRepo,
    settingsRepo: opts.settingsRepo ?? settings,
    dispatchRepo: new InMemoryDispatchRepository(),
    auditRepo: audit,
    publicBaseUrl: 'https://app.example.com',
  });
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

  it('settings read throws → delivery still happens with no pay CTA, the note, and one audit row (surface send)', async () => {
    const seeded = new InMemorySettingsRepository();
    await seeded.create(seedSettings({ paymentCollectionMode: 'pay_link' }));
    const h = await buildSendHarness({ settingsRepo: throwingSettingsRepo(new Error('pool exhausted')) });

    const result = await h.send.sendInvoice({ tenantId: TENANT, invoiceId: h.invoice.id, channel: 'both' });
    expect(result.paymentCollectionMode).toBe('unavailable');
    expect(result.channelsSent.map((c) => c.channel).sort()).toEqual(['email', 'sms']);
    const sms = h.delivery.sentSms[0].body;
    expect(sms).toContain(`See your invoice: ${result.viewUrl}`);
    expect(sms).not.toMatch(/pay online/i);
    // The business name is unknown when settings cannot be read — the note
    // still reads as plain words, never a placeholder.
    expect(sms).toContain('Your service team collects payment in person.');
    expect(h.delivery.sentEmails[0].html).not.toContain('Pay Invoice Online');

    const rows = await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id);
    const unavailable = rows.filter((r) => r.eventType === 'invoice.payment_mode_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].metadata).toMatchObject({
      reason: 'payment_mode_unavailable',
      surface: 'send',
      error: 'pool exhausted',
    });
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
  async function buildOwnerApp(mode: 'pay_link' | 'collect_on_site' | null, settingsRepo?: SettingsRepository) {
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const settings = settingsRepo ?? (await seededSettings(mode));
    const delivery = new InMemoryDeliveryProvider();
    const audit = new InMemoryAuditRepository();
    const provider = new CountingProvider();
    const customer = makeCustomer();
    await customerRepo.create(customer);
    const job = makeJob(customer.id);
    await jobRepo.create(job);
    const invoice = await invoiceRepo.create(makeInvoice(job.id));
    const sendService = new SendService({
      delivery,
      estimateRepo: new InMemoryEstimateRepository(),
      invoiceRepo,
      jobRepo,
      customerRepo,
      settingsRepo: settings,
      dispatchRepo: new InMemoryDispatchRepository(),
      auditRepo: audit,
      publicBaseUrl: 'https://app.example.com',
    });
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'user-1', sessionId: 's', tenantId: TENANT, role: 'owner' };
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
    return { app, invoice, audit, provider, delivery };
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

  it('POST /:id/send on an unreadable policy still 202s, records unavailable, and audits the occurrence', async () => {
    const h = await buildOwnerApp(null, throwingSettingsRepo(new Error('db down')));
    const res = await request(h.app).post(`/api/invoices/${h.invoice.id}/send`).send({ channel: 'sms' });
    expect(res.status).toBe(202);
    expect(res.body.paymentCollectionMode).toBe('unavailable');
    expect(h.delivery.sentSms[0].body).not.toMatch(/pay online/i);
    const rows = await h.audit.findByEntity(TENANT, 'invoice', h.invoice.id);
    expect(rows.find((r) => r.eventType === 'invoice.sent')?.metadata).toMatchObject({ paymentCollectionMode: 'unavailable' });
    expect(rows.filter((r) => r.eventType === 'invoice.payment_mode_unavailable')).toHaveLength(1);
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
