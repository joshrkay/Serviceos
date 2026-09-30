/**
 * #1513 (§17 re-verify after #1506) — in an AST-07 "then" chain (customer →
 * estimate → create-and-send invoice) the invoice leg was either not drafted
 * at all (live B2: "I didn't draft "create the invoice"…") or drafted gated on
 * `customerId` (live D: an existing customer), so approving it failed
 * "unfilled required fields: customerId". The invoice leg's customer is the
 * chain's: the create_customer step's, or the linked estimate's.
 *
 * Seams: POST /api/assistant/chat with a scripted gateway; approveProposal +
 * ProposalExecutor (the real handler registry) for approving the chain in
 * order through to the invoice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter, type AssistantRouterDeps } from '../../src/routes/assistant';
import { InMemoryProposalRepository, missingFieldsFor, type Proposal } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityKind, EntityResolver, EntityResolverResult } from '../../src/ai/resolution/entity-resolver';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

type Classified = { intentType: string; entities?: Record<string, unknown> };

/** Classifier calls answered from `byText` (longest contained key); drafting calls from `drafts[<system prefix>]`. */
function scriptedGateway(byText: Record<string, Classified>, drafts: Record<string, string> = {}): LLMGateway {
  const complete = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    let content = JSON.stringify({ intentType: 'unknown', confidence: 0.2, reasoning: 'unscripted' });
    const draftKey = Object.keys(drafts).find((prefix) => system.startsWith(prefix));
    if (draftKey) {
      content = drafts[draftKey];
    } else {
      const key = Object.keys(byText)
        .filter((text) => user.includes(text))
        .sort((a, b) => b.length - a.length)[0];
      if (key) {
        const c = byText[key];
        content = JSON.stringify({
          intentType: c.intentType,
          confidence: c.intentType === 'unknown' ? 0.3 : 0.92,
          reasoning: 'scripted',
          extractedEntities: c.entities ?? {},
        });
      }
    }
    return {
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse;
  });
  return { complete } as unknown as LLMGateway;
}

function buildApp(deps: Partial<AssistantRouterDeps> & { gateway: LLMGateway; proposalRepo: InMemoryProposalRepository }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: TEST_USER, sessionId: 'sess-1513', tenantId: TEST_TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/assistant',
    createAssistantRouter({ tenantTimezoneResolver: async () => 'America/Phoenix', ...deps } as AssistantRouterDeps),
  );
  return app;
}

const chat = (app: ReturnType<typeof buildApp>, content: string) =>
  request(app)
    .post('/api/assistant/chat')
    .send({ messages: [{ role: 'user', content }], conversationId: CONVERSATION_ID });

const chainIndexOf = (p: Proposal) => (p.sourceContext as Record<string, number> | undefined)?.chainIndex ?? 0;
const byChainIndex = (proposals: Proposal[]) => [...proposals].sort((a, b) => chainIndexOf(a) - chainIndexOf(b));

const LINES = JSON.stringify({
  lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 120000 }],
  confidence_score: 0.9,
});

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1513 — the chained invoice leg carries the chain\'s customer', () => {
  // The literal QA matrix AST-07 row. Live, the bare "create the invoice."
  // leg classified as nothing, so no invoice was drafted.
  it('AST-07 literal: all four legs are drafted, and the invoice is for the customer step 1 creates, ungated', async () => {
    const turn =
      'New customer Jane Smith, phone 555-0101, then draft an estimate for her for a water heater install at $1200, then create and send the invoice.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'create_customer', entities: { displayName: 'Jane Smith', phone: '555-0101' } },
          'New customer Jane Smith, phone 555-0101': {
            intentType: 'create_customer',
            entities: { displayName: 'Jane Smith', phone: '555-0101' },
          },
          'draft an estimate for her for a water heater install at $1200': {
            intentType: 'draft_estimate',
            entities: { customerName: 'her', lineItemDescriptions: ['water heater install'] },
          },
          // What the live classifier made of the bare leg (evidence B2).
          'create the invoice.': { intentType: 'unknown' },
        },
        {
          'You are an estimate generation assistant': LINES,
          'You are an invoice generation assistant': LINES,
        },
      ),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const steps = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect(steps.map((p) => p.proposalType)).toEqual(['create_customer', 'draft_estimate', 'draft_invoice', 'send_invoice']);
    const invoice = steps[2];
    expect(invoice.payload.customerId).toBe('$ref:chain[0].customerId');
    expect(missingFieldsFor(invoice)).toEqual([]);
    expect(res.body.message.content).not.toMatch(/didn't draft/i);
  });

  // Live chain D: an EXISTING customer. The estimate leg resolved her; the
  // invoice leg ("create the invoice") names nobody, so it was gated on a
  // customerId the estimate step already had.
  it('existing customer: the invoice leg takes the customer the estimate leg resolved, ungated', async () => {
    const turn = 'Draft an estimate for Dana Reyes for a water heater install at $1200, then create and send the invoice.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      entityResolver: scriptedResolver((kind, reference) =>
        kind === 'customer' && /dana reyes/i.test(reference)
          ? { kind: 'resolved', candidate: { id: DANA_ID, kind: 'customer', label: 'Dana Reyes', score: 1 } }
          : undefined,
      ),
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'draft_estimate', entities: { customerName: 'Dana Reyes' } },
          'Draft an estimate for Dana Reyes for a water heater install at $1200': {
            intentType: 'draft_estimate',
            entities: { customerName: 'Dana Reyes', lineItemDescriptions: ['water heater install'] },
          },
          'create the invoice.': { intentType: 'create_invoice', entities: {} },
        },
        {
          'You are an estimate generation assistant': LINES,
          'You are an invoice generation assistant': LINES,
        },
      ),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const steps = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect(steps.map((p) => p.proposalType)).toEqual(['draft_estimate', 'draft_invoice', 'send_invoice']);
    expect(steps[0].payload.customerId).toBe(DANA_ID);
    expect(steps[1].payload.customerId).toBe(DANA_ID);
    expect(steps[1].payload.estimateId).toBe('$ref:chain[0].estimateId');
    expect(missingFieldsFor(steps[1])).toEqual([]);
  });

  // Inheritance is for a leg that names nobody (or "her"). A leg that names a
  // DIFFERENT customer keeps its own, unresolved, gated reference.
  it('a leg that names a different customer is never re-pointed at the chain\'s customer', async () => {
    const turn = 'Draft an estimate for Dana Reyes for a water heater install at $1200, then create an invoice for Omar Haddad.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      entityResolver: scriptedResolver((kind, reference) =>
        kind === 'customer' && /dana reyes/i.test(reference)
          ? { kind: 'resolved', candidate: { id: DANA_ID, kind: 'customer', label: 'Dana Reyes', score: 1 } }
          : undefined,
      ),
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'draft_estimate', entities: { customerName: 'Dana Reyes' } },
          'Draft an estimate for Dana Reyes for a water heater install at $1200': {
            intentType: 'draft_estimate',
            entities: { customerName: 'Dana Reyes', lineItemDescriptions: ['water heater install'] },
          },
          'create an invoice for Omar Haddad.': { intentType: 'create_invoice', entities: { customerName: 'Omar Haddad' } },
        },
        {
          'You are an estimate generation assistant': LINES,
          'You are an invoice generation assistant': LINES,
        },
      ),
    });

    expect((await chat(app, turn)).status).toBe(200);
    const invoice = (await proposalRepo.findByTenant(TEST_TENANT)).find((p) => p.proposalType === 'draft_invoice')!;
    expect(invoice.payload.customerId).not.toBe(DANA_ID);
    expect(missingFieldsFor(invoice)).toContain('customerId');
  });
});

const DANA_ID = '55555555-5555-4555-8555-555555555555';

/** A resolver scripted per (kind, reference); anything unscripted is not_found. */
function scriptedResolver(
  script: (kind: EntityKind, reference: string) => EntityResolverResult | undefined,
): EntityResolver {
  return {
    resolve: vi.fn(async ({ kind, reference }: { kind: EntityKind; reference: string }) =>
      script(kind, reference) ?? { kind: 'not_found' as const, reference },
    ),
  } as unknown as EntityResolver;
}

describe('#1513 — approving the AST-07 chain in order executes every leg through to the invoice', () => {
  it('customer → estimate → invoice all execute, and the invoice bills the estimate the chain produced', async () => {
    const turn =
      'New customer Riley Chainqa, phone 602-555-1990, 456 Oak St, Phoenix AZ 85002, then draft an estimate for her for a water heater install at $1200, then create and send the invoice.';
    const proposalRepo = new InMemoryProposalRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const locationRepo = new InMemoryLocationRepository();
    const jobRepo = new InMemoryJobRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const customerEntities = { displayName: 'Riley Chainqa', phone: '602-555-1990', address: '456 Oak St, Phoenix AZ 85002' };
    const app = buildApp({
      proposalRepo,
      jobRepo,
      invoiceRepo,
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'create_customer', entities: customerEntities },
          'New customer Riley Chainqa, phone 602-555-1990, 456 Oak St, Phoenix AZ 85002': {
            intentType: 'create_customer',
            entities: customerEntities,
          },
          'draft an estimate for her for a water heater install at $1200': {
            intentType: 'draft_estimate',
            entities: { customerName: 'her', lineItemDescriptions: ['water heater install'] },
          },
          'create the invoice.': { intentType: 'unknown' },
        },
        {
          'You are an estimate generation assistant': LINES,
          // The invoice leg's own drafted guess — never what gets billed.
          'You are an invoice generation assistant': JSON.stringify({
            lineItems: [{ description: 'Service call', quantity: 1, unitPrice: 8900 }],
            confidence_score: 0.9,
          }),
        },
      ),
    });
    expect((await chat(app, turn)).status).toBe(200);
    const [customerStep, estimateStep, invoiceStep] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));

    const executor = new ProposalExecutor(
      createExecutionHandlerRegistry({
        customerRepo,
        locationRepo,
        jobRepo,
        estimateRepo,
        invoiceRepo,
        settingsRepo: seededSettings(),
        auditRepo: new InMemoryAuditRepository(),
      }),
      proposalRepo,
      new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo),
      new InMemoryAuditRepository(),
    );
    const ctx = { tenantId: TEST_TENANT, executedBy: TEST_USER };
    /** The operator's tap, then the sweep once the undo window has passed. */
    async function approveAndRun(step: Proposal) {
      await approveProposal(proposalRepo, TEST_TENANT, step.id, TEST_USER, 'owner');
      const approved = await proposalRepo.updateStatus(TEST_TENANT, step.id, 'approved', {
        approvedAt: new Date(Date.now() - 60_000),
      });
      const { result } = await executor.execute(approved!, ctx);
      expect(result.success, `${step.proposalType}: ${result.error}`).toBe(true);
      return result.resultEntityId!;
    }

    const customerId = await approveAndRun(customerStep);
    const estimateId = await approveAndRun(estimateStep);
    const invoiceId = await approveAndRun(invoiceStep);

    const estimate = await estimateRepo.findById(TEST_TENANT, estimateId);
    const invoice = await invoiceRepo.findById(TEST_TENANT, invoiceId);
    expect((await jobRepo.findById(TEST_TENANT, estimate!.jobId))?.customerId).toBe(customerId);
    expect(invoice?.jobId).toBe(estimate!.jobId);
    expect(invoice?.estimateId).toBe(estimateId);
    expect(invoice?.lineItems.map((li) => [li.description, li.unitPriceCents])).toEqual([['Water heater install', 120_000]]);
    expect(invoice?.totals.totalCents).toBe(estimate!.totals.totalCents);
  });
});

function seededSettings(): InMemorySettingsRepository {
  const repo = new InMemorySettingsRepository();
  const seeded: TenantSettings = {
    id: 'settings-1',
    tenantId: TEST_TENANT,
    businessName: 'Test Co',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  void repo.create(seeded);
  return repo;
}
