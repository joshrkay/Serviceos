/**
 * §8.2 — the invoice bills EXACTLY the tier the customer chose.
 *
 * "As M, I want the invoice to bill exactly the tier the customer chose, so I
 * don't bill for options they declined." The accept half (the customer's
 * selection is validated and `accepted_selection` is persisted) is proven in
 * estimate-phases.test.ts Phase 3. What had no proof at all was the BILLING
 * half: that `convertEstimateToInvoice` (invoices/convert-estimate.ts:66,
 * `resolveSelectedLineItems(estimate.lineItems, estimate.acceptedSelection)`)
 * carries that selection onto the persisted invoice — the declined tiers
 * absent as ROWS, not merely absent from a recomputed total.
 *
 * The estimate here is a real good/better/best: an always-billed diagnostic,
 * a three-option tier group whose DEFAULT is the cheapest, and an optional
 * add-on that is not pre-checked. The customer upgrades to Better and adds the
 * add-on, so every wrong answer is a different number:
 *
 *   every option summed  82500   (billing the whole sheet)
 *   default selection    15000   (billing what they were shown, not what they chose)
 *   chosen               32500   ← the only correct total
 *
 * Runs only under the integration harness (globalSetup starts the Postgres
 * testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PublicEstimateService } from '../../src/estimates/public-estimate-service';
import { convertEstimateToInvoice } from '../../src/invoices/convert-estimate';
import {
  buildLineItem,
  calculateSelectedDocumentTotals,
  LineItem,
} from '../../src/shared/billing-engine';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const DIAGNOSTIC_CENTS = 5_000;
const GOOD_CENTS = 10_000;
const BETTER_CENTS = 25_000;
const BEST_CENTS = 40_000;
const ADDON_CENTS = 2_500;

interface TieredEstimate {
  tenantId: string;
  userId: string;
  jobId: string;
  estimateId: string;
  token: string;
  ids: { diagnostic: string; good: string; better: string; best: string; addon: string };
}

describe('Postgres integration — the invoice bills exactly the chosen tier (§8.2)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let service: PublicEstimateService;

  /** A sent good/better/best estimate on its own tenant. */
  async function seedTieredEstimate(): Promise<TieredEstimate> {
    const { tenantId, userId } = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: uuidv4(),
      tenantId,
      businessName: 'Tier Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST',
      invoicePrefix: 'INV',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });

    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Tier',
      lastName: 'Chooser',
      displayName: 'Tier Chooser',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = uuidv4();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Choice Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `J-${jobId.slice(0, 8)}`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    const ids = {
      diagnostic: uuidv4(),
      good: uuidv4(),
      better: uuidv4(),
      best: uuidv4(),
      addon: uuidv4(),
    };
    const lineItems: LineItem[] = [
      buildLineItem(ids.diagnostic, 'Diagnostic', 1, DIAGNOSTIC_CENTS, 0, true),
      {
        ...buildLineItem(ids.good, 'Good — builder heater', 1, GOOD_CENTS, 1, true),
        groupKey: 'heater',
        groupLabel: 'Water heater',
        isOptional: true,
        isDefaultSelected: true,
      },
      {
        ...buildLineItem(ids.better, 'Better — mid heater', 1, BETTER_CENTS, 2, true),
        groupKey: 'heater',
        groupLabel: 'Water heater',
        isOptional: true,
      },
      {
        ...buildLineItem(ids.best, 'Best — premium heater', 1, BEST_CENTS, 3, true),
        groupKey: 'heater',
        groupLabel: 'Water heater',
        isOptional: true,
      },
      {
        ...buildLineItem(ids.addon, 'Haul away old unit', 1, ADDON_CENTS, 4, true),
        isOptional: true,
      },
    ];
    // EE-1: the headline the customer is shown totals the DEFAULT selection.
    const totals = calculateSelectedDocumentTotals(lineItems, 0, 0);
    const estimate = await estimateRepo.create({
      id: uuidv4(),
      tenantId,
      jobId,
      estimateNumber: `EST-${uuidv4().slice(0, 8)}`,
      status: 'draft',
      lineItems,
      totals,
      version: 1,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const token = `tiertoken-${uuidv4()}`;
    await estimateRepo.update(tenantId, estimate.id, {
      status: 'sent',
      viewToken: token,
      sentAt: now,
    });
    return { tenantId, userId, jobId, estimateId: estimate.id, token, ids };
  }

  const convert = (seeded: TieredEstimate) =>
    convertEstimateToInvoice(seeded.tenantId, seeded.estimateId, {
      estimateRepo,
      invoiceRepo,
      jobRepo,
      settingsRepo,
      auditRepo,
      actorId: seeded.userId,
      logger,
    });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    service = new PublicEstimateService({
      estimateRepo,
      jobRepo,
      customerRepo,
      locationRepo,
      settingsRepo,
      auditRepo,
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('bills the upgraded tier and the chosen add-on — the declined tiers are absent as invoice rows', async () => {
    const seeded = await seedTieredEstimate();

    // The customer upgrades from the pre-selected Good to Better, and takes
    // the add-on that was NOT pre-checked.
    const view = await service.approve({
      token: seeded.token,
      acceptedByName: 'Dana Rivera',
      selectedLineItemIds: [seeded.ids.diagnostic, seeded.ids.better, seeded.ids.addon],
    });
    expect(view.status).toBe('accepted');

    const invoice = await convert(seeded);
    expect(invoice).not.toBeNull();
    expect(invoice!.estimateId).toBe(seeded.estimateId);

    // Exactly the three chosen lines, at their exact amounts.
    expect(invoice!.lineItems.map((li) => li.totalCents).sort((a, b) => a - b)).toEqual([
      ADDON_CENTS,
      DIAGNOSTIC_CENTS,
      BETTER_CENTS,
    ].sort((a, b) => a - b));
    expect(invoice!.totals.totalCents).toBe(DIAGNOSTIC_CENTS + BETTER_CENTS + ADDON_CENTS);
    expect(invoice!.amountDueCents).toBe(32_500);
    // Not the whole option sheet, and not the tier they were shown by default.
    expect(invoice!.totals.totalCents).not.toBe(82_500);
    expect(invoice!.totals.totalCents).not.toBe(15_000);

    // The declined tiers are absent as ROWS in Postgres, not just absent from
    // a recomputed total — read straight off invoice_line_items.
    const { rows } = await pool.query<{ description: string; total_cents: string }>(
      `SELECT description, total_cents FROM invoice_line_items
       WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY sort_order`,
      [seeded.tenantId, invoice!.id],
    );
    const descriptions = rows.map((r) => r.description);
    expect(descriptions).toContain('Better — mid heater');
    expect(descriptions).not.toContain('Good — builder heater');
    expect(descriptions).not.toContain('Best — premium heater');
    expect(rows.reduce((sum, r) => sum + Number(r.total_cents), 0)).toBe(32_500);

    // Audit leg, through the production repository.
    const events = await auditRepo.findByEntity(seeded.tenantId, 'estimate', seeded.estimateId);
    const converted = events.filter((e) => e.eventType === 'estimate.converted');
    expect(converted).toHaveLength(1);
    expect(converted[0].metadata).toMatchObject({
      invoiceId: invoice!.id,
      totalCents: 32_500,
    });
  });

  it('bills the DOWN-tier choice too — a customer who keeps the cheapest option is not billed the upgrade', async () => {
    const seeded = await seedTieredEstimate();

    await service.approve({
      token: seeded.token,
      acceptedByName: 'Sam Okafor',
      selectedLineItemIds: [seeded.ids.diagnostic, seeded.ids.good],
    });

    const invoice = await convert(seeded);
    expect(invoice!.totals.totalCents).toBe(DIAGNOSTIC_CENTS + GOOD_CENTS);
    expect(invoice!.lineItems.map((li) => li.description).sort()).toEqual([
      'Diagnostic',
      'Good — builder heater',
    ]);
    // The add-on they declined is not billed.
    expect(invoice!.lineItems.some((li) => li.description === 'Haul away old unit')).toBe(false);
  });

  it('T1 — two tenants choose different tiers in the same run; each invoice bills its own choice', async () => {
    const tenantA = await seedTieredEstimate();
    const tenantB = await seedTieredEstimate();

    await service.approve({
      token: tenantA.token,
      acceptedByName: 'Tenant A Customer',
      selectedLineItemIds: [tenantA.ids.diagnostic, tenantA.ids.best],
    });
    await service.approve({
      token: tenantB.token,
      acceptedByName: 'Tenant B Customer',
      selectedLineItemIds: [tenantB.ids.diagnostic, tenantB.ids.good],
    });

    const aInvoice = await convert(tenantA);
    const bInvoice = await convert(tenantB);

    expect(aInvoice!.totals.totalCents).toBe(DIAGNOSTIC_CENTS + BEST_CENTS);
    expect(bInvoice!.totals.totalCents).toBe(DIAGNOSTIC_CENTS + GOOD_CENTS);
    expect(aInvoice!.lineItems.some((li) => li.description === 'Best — premium heater')).toBe(true);
    expect(bInvoice!.lineItems.some((li) => li.description === 'Best — premium heater')).toBe(false);

    // Converting tenant B's estimate left tenant A's invoice untouched.
    const aReloaded = await invoiceRepo.findById(tenantA.tenantId, aInvoice!.id);
    expect(aReloaded!.totals.totalCents).toBe(45_000);

    // Cross-tenant: neither tenant's scoped repo can read the other's rows.
    expect(await invoiceRepo.findById(tenantB.tenantId, aInvoice!.id)).toBeNull();
    expect(await estimateRepo.findById(tenantB.tenantId, tenantA.estimateId)).toBeNull();
    expect(
      await auditRepo.findByEntity(tenantB.tenantId, 'estimate', tenantA.estimateId),
    ).toEqual([]);
  });
});
