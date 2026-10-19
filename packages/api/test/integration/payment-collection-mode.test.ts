/**
 * Postgres integration — S5a-1 (U8): `payment_collection_mode` at the pay
 * surfaces, against real Postgres through the REAL repositories and routes.
 *
 * Pins by column name: `tenant_settings.payment_collection_mode` (migration
 * 312, written through `PgSettingsRepository.update`), and
 * `invoices.stripe_payment_link_id` / `stripe_payment_link_url` (which must
 * stay NULL on a collect-on-site tenant and on a failed policy read).
 *
 * What is proven here, and what is NOT:
 *
 *  - PROVEN at real Postgres: the stored key is read by the production
 *    `PgSettingsRepository`, the send goes out through the production
 *    `SendService` over Pg repos with the collect-on-site copy, the mint
 *    refuses (409) and writes no link columns, the public routes answer
 *    409 / 503 with the real routers, the `invoice.payment_mode_unavailable`
 *    row lands in `audit_events` through `PgAuditRepository`, and a
 *    neighbour tenant on `pay_link` is unaffected in the same run (T3).
 *  - The read-FAILURE leg runs the real error path: a second pool whose
 *    `search_path` resolves `tenant_settings` to a view over a plpgsql
 *    function that RAISEs, so the repo's own `SELECT * FROM tenant_settings`
 *    raises a real Postgres error inside the real `withTenant` transaction.
 *    (A dropped-column view would NOT throw under `SELECT *` — the mapper
 *    would read `undefined` — so it cannot prove this path.) The fault
 *    schema is pool-local and dropped in afterAll; no shared grant changes.
 *  - NOT proven: Stripe. The provider seam is the repo's
 *    `MockPaymentLinkProvider`, and the SMS/email seam is the
 *    `InMemoryDeliveryProvider` — both record, never verify, exactly as the
 *    sibling payment-link suites do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { SendService } from '../../src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { createInvoicePaymentLink } from '../../src/invoices/invoice-payment-link';
import { PublicInvoiceService } from '../../src/invoices/public-invoice-service';
import { createPublicInvoicesRouter } from '../../src/routes/public-invoices';
import { createPublicPaymentsRouter } from '../../src/routes/public-payments';
import { readPaymentCollectionMode } from '../../src/invoices/payment-collection-mode';
import {
  MockPaymentLinkProvider,
  type PaymentLinkRequest,
  type PaymentLinkResult,
} from '../../src/payments/payment-link-provider';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const FAULT_SCHEMA = 's5a_fault';
const FAULT_MESSAGE = 'S5a-1 injected fault: tenant_settings unreadable';

class CountingProvider extends MockPaymentLinkProvider {
  mintRequests: PaymentLinkRequest[] = [];
  override async generateLink(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
    this.mintRequests.push(request);
    return super.generateLink(request);
  }
}

describe('Postgres integration — payment_collection_mode at the pay surfaces (S5a-1 / U8)', () => {
  let pool: Pool;
  let faultPool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let faultSettingsRepo: PgSettingsRepository;
  let delivery: InMemoryDeliveryProvider;
  let sendService: SendService;
  let collectTenant: { tenantId: string; userId: string };
  let payLinkTenant: { tenantId: string; userId: string };
  let collectJobId: string;
  let payLinkJobId: string;

  function buildSendService(settings: PgSettingsRepository): SendService {
    return new SendService({
      delivery,
      estimateRepo: new PgEstimateRepository(pool),
      invoiceRepo,
      jobRepo: new PgJobRepository(pool),
      customerRepo: new PgCustomerRepository(pool),
      settingsRepo: settings,
      dispatchRepo: new PgDispatchRepository(pool),
      auditRepo,
      publicBaseUrl: 'https://app.example.com',
    });
  }

  async function seedJobChain(t: { tenantId: string; userId: string }, label: string): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Pay',
      lastName: label,
      displayName: `Pay ${label}`,
      primaryPhone: '+15555550199',
      email: `pay-${label.toLowerCase()}@example.com`,
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1 Collect Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label}`,
      summary: 'Collect-on-site job',
      status: 'completed',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  async function seedOpenInvoice(
    t: { tenantId: string; userId: string },
    jobId: string,
    label: string,
  ): Promise<{ id: string; viewToken: string }> {
    const id = crypto.randomUUID();
    const viewToken = crypto.randomBytes(24).toString('base64url');
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 40000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id,
      tenantId: t.tenantId,
      jobId,
      invoiceNumber: `INV-${label}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The view token is stamped by `update`, exactly as the send path does
    // (`create` never writes `view_token`).
    await invoiceRepo.update(t.tenantId, id, {
      viewToken,
      viewTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });
    return { id, viewToken };
  }

  /** Raw column read — the persisted truth, by column NAME. */
  async function linkColumns(tenantId: string, invoiceId: string) {
    const { rows } = await pool.query<{
      stripe_payment_link_id: string | null;
      stripe_payment_link_url: string | null;
    }>(
      `SELECT stripe_payment_link_id, stripe_payment_link_url
         FROM invoices WHERE tenant_id = $1 AND id = $2`,
      [tenantId, invoiceId],
    );
    return rows[0];
  }

  async function unavailableRows(tenantId: string, entityId: string) {
    const { rows } = await pool.query<{
      entity_type: string;
      entity_id: string;
      actor_id: string;
      surface: string;
      reason: string;
      error: string;
    }>(
      `SELECT entity_type, entity_id, actor_id,
              metadata->>'surface' AS surface,
              metadata->>'reason' AS reason,
              metadata->>'error' AS error
         FROM audit_events
        WHERE tenant_id = $1 AND entity_id = $2
          AND event_type = 'invoice.payment_mode_unavailable'
        ORDER BY created_at`,
      [tenantId, entityId],
    );
    return rows;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    delivery = new InMemoryDeliveryProvider();
    sendService = buildSendService(settingsRepo);

    collectTenant = await createTestTenant(pool);
    payLinkTenant = await createTestTenant(pool);
    for (const [t, name] of [
      [collectTenant, 'Collect HVAC'],
      [payLinkTenant, 'Pay Link Plumbing'],
    ] as const) {
      await settingsRepo.create({
        id: crypto.randomUUID(),
        tenantId: t.tenantId,
        businessName: name,
        timezone: 'America/Chicago',
        estimatePrefix: 'EST',
        invoicePrefix: 'INV',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    // The onboarding card's write, through the production repository: pins
    // the real column.
    await settingsRepo.update(collectTenant.tenantId, { paymentCollectionMode: 'collect_on_site' });
    await settingsRepo.update(payLinkTenant.tenantId, { paymentCollectionMode: 'pay_link' });

    collectJobId = await seedJobChain(collectTenant, 'COLLECT');
    payLinkJobId = await seedJobChain(payLinkTenant, 'PAYLINK');

    // Read-failure fixture: a schema ahead of `public` on the fault pool's
    // search_path whose `tenant_settings` raises on every read.
    await pool.query(`DROP SCHEMA IF EXISTS ${FAULT_SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${FAULT_SCHEMA}`);
    await pool.query(`
      CREATE FUNCTION ${FAULT_SCHEMA}.unreadable_tenant_settings()
      RETURNS SETOF public.tenant_settings LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '${FAULT_MESSAGE}';
      END $$;
      CREATE VIEW ${FAULT_SCHEMA}.tenant_settings AS
        SELECT * FROM ${FAULT_SCHEMA}.unreadable_tenant_settings();
      GRANT USAGE ON SCHEMA ${FAULT_SCHEMA} TO rls_app_runtime;
      GRANT SELECT ON ${FAULT_SCHEMA}.tenant_settings TO rls_app_runtime;
      GRANT EXECUTE ON FUNCTION ${FAULT_SCHEMA}.unreadable_tenant_settings() TO rls_app_runtime;
    `);
    faultPool = new Pool({
      connectionString: process.env.TEST_DB_URL,
      options: `-c search_path=${FAULT_SCHEMA},public`,
      max: 2,
    });
    faultSettingsRepo = new PgSettingsRepository(faultPool);
  });

  afterAll(async () => {
    await faultPool?.end();
    await pool.query(`DROP SCHEMA IF EXISTS ${FAULT_SCHEMA} CASCADE`);
    await closeSharedTestDb();
  });

  it('the stored key is read by the real repository: stored → itself, unset → the pay_link default', async () => {
    const { rows } = await pool.query<{ payment_collection_mode: string | null }>(
      `SELECT payment_collection_mode FROM tenant_settings WHERE tenant_id = $1`,
      [collectTenant.tenantId],
    );
    expect(rows[0].payment_collection_mode).toBe('collect_on_site');

    expect(await readPaymentCollectionMode(settingsRepo, collectTenant.tenantId)).toMatchObject({
      ok: true,
      mode: 'collect_on_site',
      source: 'stored',
    });
    expect(await readPaymentCollectionMode(settingsRepo, payLinkTenant.tenantId)).toMatchObject({
      ok: true,
      mode: 'pay_link',
      source: 'stored',
    });
    const unanswered = await createTestTenant(pool);
    expect(await readPaymentCollectionMode(settingsRepo, unanswered.tenantId)).toMatchObject({
      ok: true,
      mode: 'pay_link',
      source: 'default',
    });
  });

  it('collect_on_site: the sent text carries no pay CTA and the in-person note; the neighbour on pay_link is unchanged (T3)', async () => {
    const mine = await seedOpenInvoice(collectTenant, collectJobId, 'SEND-C');
    const theirs = await seedOpenInvoice(payLinkTenant, payLinkJobId, 'SEND-P');

    const mineResult = await sendService.sendInvoice({
      tenantId: collectTenant.tenantId,
      invoiceId: mine.id,
      channel: 'sms',
    });
    const theirResult = await sendService.sendInvoice({
      tenantId: payLinkTenant.tenantId,
      invoiceId: theirs.id,
      channel: 'sms',
    });

    expect(mineResult.paymentCollectionMode).toBe('collect_on_site');
    const mineSms = delivery.sentSms.find((m) => m.body.includes('INV-SEND-C'))!;
    expect(mineSms.body).toContain(`See your invoice: ${mineResult.viewUrl}`);
    expect(mineSms.body).toContain('Collect HVAC collects payment in person. Settle up when the work is done.');
    expect(mineSms.body).not.toMatch(/pay online/i);
    expect(await linkColumns(collectTenant.tenantId, mine.id)).toEqual({
      stripe_payment_link_id: null,
      stripe_payment_link_url: null,
    });

    expect(theirResult.paymentCollectionMode).toBe('pay_link');
    const theirSms = delivery.sentSms.find((m) => m.body.includes('INV-SEND-P'))!;
    expect(theirSms.body).toContain(`Pay online: ${theirResult.viewUrl}`);
    expect(theirSms.body).not.toContain('collects payment in person');

    // Both sends stamped sent_at through the real repo.
    const { rows } = await pool.query<{ sent_at: Date | null }>(
      `SELECT sent_at FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY invoice_number`,
      [[mine.id, theirs.id]],
    );
    expect(rows.map((r) => r.sent_at instanceof Date)).toEqual([true, true]);
  });

  it('collect_on_site: the operator mint refuses with COLLECT_ON_SITE and writes no link columns; the neighbour mints', async () => {
    const mine = await seedOpenInvoice(collectTenant, collectJobId, 'MINT-C');
    const theirs = await seedOpenInvoice(payLinkTenant, payLinkJobId, 'MINT-P');
    const provider = new CountingProvider();

    await expect(
      createInvoicePaymentLink(collectTenant.tenantId, mine.id, { invoiceRepo, provider, settingsRepo, auditRepo }),
    ).rejects.toMatchObject({ code: 'COLLECT_ON_SITE', statusCode: 409 });
    expect(provider.mintRequests).toHaveLength(0);
    expect(await linkColumns(collectTenant.tenantId, mine.id)).toEqual({
      stripe_payment_link_id: null,
      stripe_payment_link_url: null,
    });

    const minted = await createInvoicePaymentLink(payLinkTenant.tenantId, theirs.id, {
      invoiceRepo,
      provider,
      settingsRepo,
      auditRepo,
    });
    const cols = await linkColumns(payLinkTenant.tenantId, theirs.id);
    expect(cols.stripe_payment_link_url).toBe(minted.url);
    expect(cols.stripe_payment_link_id).not.toBeNull();
  });

  it('the real public routes: checkout 409, the view carries the mode, create-payment-intent 409', async () => {
    const mine = await seedOpenInvoice(collectTenant, collectJobId, 'ROUTE-C');
    const provider = new CountingProvider();
    const service = new PublicInvoiceService({
      paymentLinkProvider: provider,
      invoiceRepo,
      jobRepo: new PgJobRepository(pool),
      customerRepo: new PgCustomerRepository(pool),
      settingsRepo,
      auditRepo,
    });
    const app = express();
    app.use(express.json());
    app.use('/public/invoices', createPublicInvoicesRouter(service));
    app.use(
      '/api/public-payments',
      createPublicPaymentsRouter({
        invoiceRepo,
        settingsRepo,
        auditRepo,
        stripeConfig: { apiKey: 'sk_test_never_called' },
        stripeFetch: (async () => {
          throw new Error('Stripe must not be called on a collect-on-site tenant');
        }) as never,
      }),
    );

    const view = await request(app).get(`/public/invoices/${mine.viewToken}`);
    expect(view.status).toBe(200);
    expect(view.body.paymentCollectionMode).toBe('collect_on_site');
    expect(view.body.businessName).toBe('Collect HVAC');
    expect(view.body.stripePaymentLinkUrl).toBeUndefined();

    const checkout = await request(app).post(`/public/invoices/${mine.viewToken}/checkout`).send({});
    expect(checkout.status).toBe(409);
    expect(checkout.body.error).toBe('COLLECT_ON_SITE');
    expect(provider.mintRequests).toHaveLength(0);

    const intent = await request(app)
      .post('/api/public-payments/create-payment-intent')
      .send({ invoiceId: mine.id, viewToken: mine.viewToken });
    expect(intent.status).toBe(409);
    expect(intent.body.error).toBe('COLLECT_ON_SITE');

    expect(await linkColumns(collectTenant.tenantId, mine.id)).toEqual({
      stripe_payment_link_id: null,
      stripe_payment_link_url: null,
    });
  });

  it('read failure (real Postgres error): the send still goes out fail-closed, the mint 503s, nothing stored, the audit row is pinned', async () => {
    // The fault really is a Postgres error from the repo's own query.
    const faulted = await readPaymentCollectionMode(faultSettingsRepo, payLinkTenant.tenantId);
    expect(faulted.ok).toBe(false);
    expect(String((faulted as { error: unknown }).error)).toContain(FAULT_MESSAGE);

    // Even the pay_link tenant: a failed read is never read as pay_link.
    const invoice = await seedOpenInvoice(payLinkTenant, payLinkJobId, 'FAULT-P');
    const faultSend = buildSendService(faultSettingsRepo);
    const result = await faultSend.sendInvoice({
      tenantId: payLinkTenant.tenantId,
      invoiceId: invoice.id,
      channel: 'sms',
    });
    expect(result.paymentCollectionMode).toBe('unavailable');
    const sms = delivery.sentSms.find((m) => m.body.includes('INV-FAULT-P'))!;
    expect(sms.body).toContain(`See your invoice: ${result.viewUrl}`);
    expect(sms.body).toContain('Your service team collects payment in person.');
    expect(sms.body).not.toMatch(/pay online/i);

    const provider = new CountingProvider();
    await expect(
      createInvoicePaymentLink(payLinkTenant.tenantId, invoice.id, {
        invoiceRepo,
        provider,
        settingsRepo: faultSettingsRepo,
        auditRepo,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_MODE_UNAVAILABLE', statusCode: 503 });
    expect(provider.mintRequests).toHaveLength(0);
    expect(await linkColumns(payLinkTenant.tenantId, invoice.id)).toEqual({
      stripe_payment_link_id: null,
      stripe_payment_link_url: null,
    });

    // The audit row shape, through the real PgAuditRepository: one per
    // occurrence, surfaces `send` then `checkout`, the Postgres error text.
    const rows = await unavailableRows(payLinkTenant.tenantId, invoice.id);
    expect(rows.map((r) => r.surface)).toEqual(['send', 'checkout']);
    for (const row of rows) {
      expect(row).toMatchObject({
        entity_type: 'invoice',
        entity_id: invoice.id,
        actor_id: 'system',
        reason: 'payment_mode_unavailable',
      });
      expect(row.error).toContain(FAULT_MESSAGE);
    }

    // Nothing cached: the shared pool reads the stored policy and mints.
    const recovered = await createInvoicePaymentLink(payLinkTenant.tenantId, invoice.id, {
      invoiceRepo,
      provider,
      settingsRepo,
      auditRepo,
    });
    expect((await linkColumns(payLinkTenant.tenantId, invoice.id)).stripe_payment_link_url).toBe(recovered.url);
    expect(await unavailableRows(payLinkTenant.tenantId, invoice.id)).toHaveLength(2);
  });
});
