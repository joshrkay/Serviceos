/**
 * Negotiation guardrail — real-Postgres proofs for both decision branches.
 *
 * - **ALLOW branch (row 7.12, §8.7 G1 audit / #1012)**: an in-policy discount
 *   ask persists a capture-class, confidence-capped owner-callback proposal
 *   AND its `negotiation.discount_evaluated` audit event, via the voice-task
 *   surface (`NegotiationGuardrailTaskHandler`, `ai/tasks/negotiation-task.ts`).
 *   Landed on `main` via PR #1035.
 * - **REFUSE branch (row 2.11, #1014)**: a below-floor discount ask never
 *   quotes the customer's price — it hands off to the owner with a
 *   REJECT_WITH_COUNTER recommendation and its `negotiation_guardrail
 *   .sms_routed` audit event, via the inbound-SMS surface
 *   (`createInboundNegotiationHandler`, `sms/negotiation/inbound-negotiation
 *   -handler.ts`). Drives the real chain — no literal `DiscountDecision`
 *   handed in: real `PgSettingsRepository` (the tenant's discount floor) →
 *   real `DefaultCurrentQuoteResolver` (`PgJobRepository` +
 *   `PgEstimateRepository`, a real 'sent' catalog-grounded estimate) → real
 *   `parseDiscountTarget` → real `evaluateDiscountAsk` (the pure
 *   money-correctness core — untouched) → `createInboundNegotiationHandler`
 *   (real `PgProposalRepository` + `PgAuditRepository`).
 *
 * Both surfaces call the same underlying `evaluateNegotiationDiscount` /
 * `evaluateDiscountAsk` decision engine and the shared
 * `buildNegotiationCallbackContent` owner-callback builder, so together
 * these two describe blocks cover ALLOW and REFUSE without duplicating
 * either — see PR #1043's body for the "not done" note this once left
 * (written before PR #1035, which added the ALLOW-branch block below,
 * landed on `main`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { NegotiationGuardrailTaskHandler } from '../../src/ai/tasks/negotiation-task';
import { ensureTenantSettings } from '../../src/settings/settings';
import type { CurrentQuoteResolver } from '../../src/conversations/negotiation/current-quote-resolver';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import { createInboundNegotiationHandler } from '../../src/sms/negotiation/inbound-negotiation-handler';
import { evaluateNegotiationDiscount } from '../../src/proposals/guardrails/negotiation-guardrail';
import { DefaultCurrentQuoteResolver } from '../../src/conversations/negotiation/current-quote-resolver';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { InboundSmsContext } from '../../src/sms/inbound-dispatch';

describe('Postgres integration — negotiation guardrail owner-callback persistence (7.12)', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    // createTestTenant only inserts tenants/users — tenant_settings.update()
    // is a bare UPDATE (no upsert; see PgSettingsRepository.update), so a
    // fresh tenant needs its settings row created first, exactly as the real
    // bootstrap flow (auth/clerk.ts) and the estimate/invoice number
    // safety-net (getNextEstimateNumber/getNextInvoiceNumber) both do via
    // this same idempotent helper.
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    await settingsRepo.update(tenant.tenantId, {
      discountMaxBps: 1000, // 10% cap
      discountFloorCents: 15000,
      discountNeverBelowCatalog: true,
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('an in-policy discount ask persists a capture-class, confidence-capped callback proposal AND its audit event', async () => {
    const quoteResolver: CurrentQuoteResolver = {
      resolve: async () => ({ estimateId: 'est-1', quotedCents: 25000, catalogGrounded: true }),
    };
    const handler = new NegotiationGuardrailTaskHandler(undefined, {
      settingsRepo,
      quoteResolver,
      auditRepo,
    });

    const context: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'can you do $230?',
      existingEntities: { customerId: 'c-1' },
    };
    const { proposal, taskType } = await handler.handle(context);
    expect(taskType).toBe('callback');
    // Capture-class: no sourceTrustTier, and the confidence cap below forces
    // 'draft' regardless — the AI never auto-applies a discount.
    expect(proposal.status).toBe('draft');
    const meta = proposal.payload._meta as { overallConfidence: string };
    expect(meta.overallConfidence).toBe('low');
    expect(proposal.payload.approvedDiscountBps).toBe(800); // $250 → $230 = 8% (< 10% cap)

    // Persist through the REAL repo — the row, not just the in-memory object
    // handle() returns. A new file that never opens a pool would not count.
    const persisted = await proposalRepo.create(proposal);
    const reloaded = await proposalRepo.findById(tenant.tenantId, persisted.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe('draft');
    expect(reloaded!.proposalType).toBe('callback');

    // The discount evaluation's audit event landed for real. No
    // recordingId/conversationId was supplied, so auditDecision's entityId
    // falls back to the tenantId (see NegotiationGuardrailTaskHandler.auditDecision).
    const events = await auditRepo.findByEntity(tenant.tenantId, 'proposal', tenant.tenantId);
    expect(events.map((e) => e.eventType)).toContain('negotiation.discount_evaluated');

    // T1 — cross-tenant isolation: a second, wholly separate tenant cannot
    // read the persisted callback proposal, and sees none of its audit trail.
    const otherTenant = await createTestTenant(pool);
    expect(await proposalRepo.findById(otherTenant.tenantId, persisted.id)).toBeNull();
    const otherEvents = await auditRepo.findByEntity(otherTenant.tenantId, 'proposal', tenant.tenantId);
    expect(otherEvents).toHaveLength(0);
  });
});

/**
 * #1014 row 2.11 — refuse to quote a firm price / haggle, at real Postgres.
 * See the file-level docstring above: this is the REFUSE-branch counterpart
 * to the ALLOW-branch block above (row 7.12, PR #1035).
 */
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
    addressType: 'service',
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
