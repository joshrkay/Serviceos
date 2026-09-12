/**
 * #1014 row 2.11 — refuse to quote a firm price / haggle, at real Postgres.
 *
 * Correction on this ticket's own text: it cites a sibling
 * `test/integration/negotiation-guardrail.test.ts` proof for the ALLOW
 * branch "from PR #1035" — no such file exists anywhere in this repo's
 * history on `origin/main` (checked: no integration or unit test anywhere
 * exercises `evaluateNegotiationDiscount`/`evaluateDiscountAsk` against real
 * data). This file is therefore new, not an addition to an existing proof,
 * and covers the REFUSE branch (`REJECT_WITH_COUNTER`) the row asks for —
 * see the PR body's "not done / judgment calls" for the ALLOW-branch gap
 * this leaves.
 *
 * Drives the REAL chain — no literal `DiscountDecision` handed in:
 *   real `PgSettingsRepository` (the tenant's discount floor) →
 *   real `DefaultCurrentQuoteResolver` (`PgJobRepository` + `PgEstimateRepository`,
 *   a real 'sent' catalog-grounded estimate) →
 *   real `parseDiscountTarget` (the customer's literal words) →
 *   real `evaluateDiscountAsk` (the pure money-correctness core — untouched) →
 *   `createInboundNegotiationHandler` (real `PgProposalRepository` +
 *   `PgAuditRepository`).
 *
 * Asserts: the AI never quotes the discounted price or commits to a number,
 * a `callback` proposal (capture-class, 'draft') hands the ask to the owner
 * with the REJECT_WITH_COUNTER framing (floor + counter price), and the
 * `negotiation_guardrail.sms_routed` audit event is read back through
 * PgAuditRepository — plus T1 (a second tenant's floor never governs the
 * first tenant's counter price).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { createInboundNegotiationHandler } from '../../src/sms/negotiation/inbound-negotiation-handler';
import { evaluateNegotiationDiscount } from '../../src/proposals/guardrails/negotiation-guardrail';
import { DefaultCurrentQuoteResolver } from '../../src/conversations/negotiation/current-quote-resolver';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { InboundSmsContext } from '../../src/sms/inbound-dispatch';

async function seedSentEstimate(
  pool: Pool,
  tenant: TestTenant,
  customerRepo: PgCustomerRepository,
  locationRepo: PgLocationRepository,
  jobRepo: PgJobRepository,
  estimateRepo: PgEstimateRepository,
  quotedCents: number,
): Promise<{ customerId: string }> {
  const customerId = crypto.randomUUID();
  await customerRepo.create({
    id: customerId,
    tenantId: tenant.tenantId,
    firstName: 'Nora',
    lastName: 'Negotiator',
    displayName: 'Nora Negotiator',
    primaryPhone: '+15125550777',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: tenant.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const locationId = crypto.randomUUID();
  await locationRepo.create({
    id: locationId,
    tenantId: tenant.tenantId,
    customerId,
    street1: '1 Haggle Way',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'USA',
    isPrimary: true,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const jobId = crypto.randomUUID();
  await jobRepo.create({
    id: jobId,
    tenantId: tenant.tenantId,
    customerId,
    locationId,
    jobNumber: `JOB-NEG-${jobId.slice(0, 8)}`,
    summary: 'Drain repair',
    status: 'scheduled',
    priority: 'normal',
    createdBy: tenant.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const lineItems = [
    buildLineItem(crypto.randomUUID(), 'Drain repair', 1, quotedCents, 1, true, 'labor', 'catalog'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  await estimateRepo.create({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    jobId,
    estimateNumber: `EST-NEG-${jobId.slice(0, 8)}`,
    status: 'sent',
    lineItems,
    totals,
    version: 1,
    createdBy: tenant.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);

  return { customerId };
}

describe('Postgres integration — negotiation guardrail REFUSE branch (REJECT_WITH_COUNTER)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let jobRepo: PgJobRepository;
  let estimateRepo: PgEstimateRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    jobRepo = new PgJobRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function makeEvaluateDiscount(customerId: string) {
    const quoteResolver = new DefaultCurrentQuoteResolver({ jobRepo, estimateRepo });
    return (tenantId: string, _phoneE164: string, askText: string) =>
      evaluateNegotiationDiscount({
        tenantId,
        customerId,
        askText,
        settingsRepo,
        quoteResolver,
      });
  }

  it('refuses a discount below the tenant floor: hands off to the owner with a counter price, never quotes the ask, and audits the routing', async () => {
    // $100.00 quote, $60.00 absolute floor — a $50 discount ask lands at
    // $50.00, BELOW the floor, so evaluateDiscountAsk (untouched, pure) must
    // return REJECT_WITH_COUNTER at the $60.00 floor.
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      businessName: 'Tenant A Plumbing',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      activeVerticalPacks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await settingsRepo.update(tenantA.tenantId, {
      discountMaxBps: 5000,
      discountFloorCents: 6000,
      discountNeverBelowCatalog: false,
    });

    const { customerId } = await seedSentEstimate(
      pool,
      tenantA,
      customerRepo,
      locationRepo,
      jobRepo,
      estimateRepo,
      10000,
    );

    const handler = createInboundNegotiationHandler({
      proposalRepo,
      sendSms: vi.fn(async () => {}),
      auditRepo,
      evaluateDiscount: makeEvaluateDiscount(customerId),
    });

    const ctx: InboundSmsContext = {
      tenantId: tenantA.tenantId,
      fromE164: '+15125550777',
      body: 'Can you knock $50 off?',
      messageSid: `SM-neg-${crypto.randomUUID()}`,
    };

    const result = await handler.handle(ctx);
    expect(result.handled).toBe(true);

    // The proposal is the REFUSAL handed to the owner — capture-class,
    // never auto-executed, carrying the REJECT_WITH_COUNTER framing.
    const proposals = await proposalRepo.findByTenant(tenantA.tenantId);
    const proposal = proposals.find(
      (p) => (p.sourceContext as { messageSid?: string } | undefined)?.messageSid === ctx.messageSid,
    );
    expect(proposal).toBeDefined();
    expect(proposal!.proposalType).toBe('callback');
    expect(proposal!.status).toBe('draft');
    const recommendation = String((proposal!.payload as Record<string, unknown>).recommendation);
    // The AI's recommendation counters at the FLOOR ($60.00) — it never
    // hands the customer their asked-for $50.00 price.
    expect(recommendation).toMatch(/counter at \$60/);
    expect(recommendation).not.toMatch(/\$50 off/);

    // The audit leg — read back through PgAuditRepository, not the
    // in-process handler result.
    const events = await auditRepo.findByEntity(tenantA.tenantId, 'sms_message', ctx.messageSid);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.eventType === 'negotiation_guardrail.sms_routed')).toBe(true);
    const routed = events.find((e) => e.eventType === 'negotiation_guardrail.sms_routed');
    expect((routed!.metadata as Record<string, unknown>)?.askType).toBe('discount');
  });

  it("T1: tenant B's own (looser) discount floor never governs tenant A's counter price", async () => {
    // Tenant B has NO floor configured at all (fail-closed default: 0) and a
    // generous maxDiscountBps — if tenant A's evaluation ever read tenant
    // B's settings row, the $50 ask would ALLOW instead of refuse.
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantB.tenantId,
      businessName: 'Tenant B Plumbing',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      activeVerticalPacks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await settingsRepo.update(tenantB.tenantId, { discountMaxBps: 9000, discountFloorCents: 0 });

    const { customerId: customerIdA } = await seedSentEstimate(
      pool,
      tenantA,
      customerRepo,
      locationRepo,
      jobRepo,
      estimateRepo,
      10000,
    );

    const handler = createInboundNegotiationHandler({
      proposalRepo,
      sendSms: vi.fn(async () => {}),
      auditRepo,
      evaluateDiscount: makeEvaluateDiscount(customerIdA),
    });

    const ctx: InboundSmsContext = {
      tenantId: tenantA.tenantId,
      fromE164: '+15125550777',
      body: 'Can you knock $50 off?',
      messageSid: `SM-neg-t1-${crypto.randomUUID()}`,
    };
    await handler.handle(ctx);

    const proposals = await proposalRepo.findByTenant(tenantA.tenantId);
    const proposal = proposals.find(
      (p) => (p.sourceContext as { messageSid?: string } | undefined)?.messageSid === ctx.messageSid,
    );
    expect(proposal).toBeDefined();
    // Still refused at tenant A's OWN $60.00 floor — tenant B's looser
    // policy never leaked in, even though both settings rows exist.
    const recommendation = String((proposal!.payload as Record<string, unknown>).recommendation);
    expect(recommendation).toMatch(/counter at \$60/);
  });
});
