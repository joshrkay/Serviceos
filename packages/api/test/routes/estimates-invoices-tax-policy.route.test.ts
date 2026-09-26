/**
 * #1288 — tax on estimates and invoices (owner decision 2026-09-26).
 *
 *   1. A tenant DEFAULT tax rate (`tenant_settings.default_tax_rate_bps`)
 *      applies when a create omits `taxRateBps`; an explicit rate (0 included)
 *      always wins.
 *   2. Q12 = FAIL CLOSED. The engine subtracts the whole discount from the
 *      taxable base (PRD §12.3), which under-taxes any document that mixes
 *      taxable and non-taxable lines. Until proportional allocation lands, such
 *      a document with a discount AND a tax rate is refused with a typed 422
 *      (`DISCOUNT_TAX_ALLOCATION_UNSUPPORTED`) instead of persisting a wrong tax.
 *
 * Proven at the public route seam (supertest over the real routers, in-memory
 * repos); the Postgres column leg lives in
 * test/integration/tenant-default-tax-rate.test.ts.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { buildTestApp, TEST_TENANT_ID, type TestApp } from './test-app';
import { createSettingsRouter } from '../../src/routes/settings';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TAXABLE = {
  id: 'li-t',
  description: 'Water heater',
  quantity: 1,
  unitPriceCents: 10000,
  totalCents: 10000,
  category: 'material',
  sortOrder: 0,
  taxable: true,
};
const NON_TAXABLE = {
  id: 'li-n',
  description: 'Install labor',
  quantity: 1,
  unitPriceCents: 10000,
  totalCents: 10000,
  category: 'labor',
  sortOrder: 1,
  taxable: false,
};

function postEstimate(app: Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/estimates')
    .send({ jobId: 'job-1', estimateNumber: 'PLACEHOLDER', ...body });
}
function postInvoice(app: Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/invoices')
    .send({ jobId: 'job-1', invoiceNumber: 'PLACEHOLDER', ...body });
}

describe('#1288 Q12 — fail closed on a discounted mixed-taxability document', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('refuses an estimate mixing taxable + non-taxable lines with a discount and a tax rate', async () => {
    const res = await postEstimate(app, {
      lineItems: [TAXABLE, NON_TAXABLE],
      discountCents: 10000,
      taxRateBps: 1000,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('DISCOUNT_TAX_ALLOCATION_UNSUPPORTED');
    expect(res.body.details).toMatchObject({
      taxableSubtotalCents: 10000,
      nonTaxableSubtotalCents: 10000,
      discountCents: 10000,
    });
  });

  it('refuses the same invoice', async () => {
    const res = await postInvoice(app, {
      lineItems: [TAXABLE, NON_TAXABLE],
      discountCents: 10000,
      taxRateBps: 1000,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('DISCOUNT_TAX_ALLOCATION_UNSUPPORTED');
  });

  it('refuses an update that adds a discount to a mixed, taxed draft estimate', async () => {
    const created = await postEstimate(app, {
      lineItems: [TAXABLE, NON_TAXABLE],
      taxRateBps: 1000,
    });
    expect(created.status).toBe(201);
    const res = await request(app)
      .put(`/api/estimates/${created.body.id}`)
      .send({ discountCents: 500 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('DISCOUNT_TAX_ALLOCATION_UNSUPPORTED');
  });

  it('does not over-block: all-taxable + discount, mixed without discount, and mixed at 0% tax all compute', async () => {
    const allTaxable = await postEstimate(app, {
      lineItems: [TAXABLE, { ...NON_TAXABLE, taxable: true }],
      discountCents: 10000,
      taxRateBps: 1000,
    });
    expect(allTaxable.status).toBe(201);
    // (20000 − 10000) × 10% = 1000 tax; 20000 − 10000 + 1000 = 11000.
    expect(allTaxable.body.totals.taxCents).toBe(1000);
    expect(allTaxable.body.totals.totalCents).toBe(11000);

    const mixedNoDiscount = await postInvoice(app, {
      lineItems: [TAXABLE, NON_TAXABLE],
      taxRateBps: 1000,
    });
    expect(mixedNoDiscount.status).toBe(201);
    expect(mixedNoDiscount.body.totals.taxCents).toBe(1000);
    expect(mixedNoDiscount.body.totals.totalCents).toBe(21000);

    const mixedZeroTax = await postEstimate(app, {
      lineItems: [TAXABLE, NON_TAXABLE],
      discountCents: 10000,
      taxRateBps: 0,
    });
    expect(mixedZeroTax.status).toBe(201);
    expect(mixedZeroTax.body.totals.totalCents).toBe(10000);
  });
});

describe('#1288 — PUT /api/settings carries defaultTaxRateBps', () => {
  async function buildSettingsApp() {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-tax-owner',
        sessionId: 'sess-tax',
        tenantId: 'tenant-tax-1288',
        role: 'owner',
      };
      next();
    });
    const settingsRepo = new InMemorySettingsRepository();
    await createSettings({ tenantId: 'tenant-tax-1288', businessName: 'Tax Co' }, settingsRepo);
    app.use('/api/settings', createSettingsRouter(settingsRepo));
    return { app, settingsRepo };
  }

  it('saves an owner-set default and returns it', async () => {
    const { app, settingsRepo } = await buildSettingsApp();
    const res = await request(app).put('/api/settings').send({ defaultTaxRateBps: 825 });
    expect(res.status).toBe(200);
    expect(res.body.defaultTaxRateBps).toBe(825);
    expect((await settingsRepo.findByTenant('tenant-tax-1288'))!.defaultTaxRateBps).toBe(825);
  });

  it('rejects a default above 100% or a fractional bps', async () => {
    const { app } = await buildSettingsApp();
    expect((await request(app).put('/api/settings').send({ defaultTaxRateBps: 10001 })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ defaultTaxRateBps: 8.5 })).status).toBe(400);
  });
});

describe('#1288 — tenant default tax rate', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
    await t.settingsRepo.update(TEST_TENANT_ID, { defaultTaxRateBps: 825 });
  });

  it('an estimate created without taxRateBps takes the tenant default', async () => {
    const res = await postEstimate(t.app, { lineItems: [TAXABLE] });
    expect(res.status).toBe(201);
    expect(res.body.totals.taxRateBps).toBe(825);
    // 10000 × 8.25% = 825.
    expect(res.body.totals.taxCents).toBe(825);
    expect(res.body.totals.totalCents).toBe(10825);
  });

  it('an invoice created without taxRateBps takes the tenant default', async () => {
    const res = await postInvoice(t.app, { lineItems: [TAXABLE] });
    expect(res.status).toBe(201);
    expect(res.body.totals.taxRateBps).toBe(825);
    expect(res.body.totals.taxCents).toBe(825);
  });

  it('an explicit rate — including 0 — wins over the default', async () => {
    const zero = await postEstimate(t.app, { lineItems: [TAXABLE], taxRateBps: 0 });
    expect(zero.status).toBe(201);
    expect(zero.body.totals.taxRateBps).toBe(0);
    expect(zero.body.totals.taxCents).toBe(0);

    const explicit = await postInvoice(t.app, { lineItems: [TAXABLE], taxRateBps: 500 });
    expect(explicit.body.totals.taxRateBps).toBe(500);
  });

  it('the default feeds the Q12 refusal too (mixed + discount, no explicit rate)', async () => {
    const res = await postInvoice(t.app, {
      lineItems: [TAXABLE, NON_TAXABLE],
      discountCents: 1000,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('DISCOUNT_TAX_ALLOCATION_UNSUPPORTED');
  });
});
