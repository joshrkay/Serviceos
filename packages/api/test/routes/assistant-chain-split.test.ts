/**
 * #1480 item 4 — compound / chained operator asks in chat are split into
 * LINKED proposals (one chainId), not one card plus a "didn't draft" note.
 * Pinned at the chat SURFACE: POST /api/assistant/chat with a scripted
 * gateway replaying the classifier shapes the live turns produced (QA matrix
 * AST-04 / AST-07 / C23), and at approveProposal for the linked-step unlock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAssistantRouter, type AssistantRouterDeps } from '../../src/routes/assistant';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { buildJob } from '../factories/job.factory';
import { approveProposal } from '../../src/proposals/actions';
import {
  invoiceReferenceCheck,
  invoiceSendableReferenceCheck,
  estimateInvoicedReferenceCheck,
} from '../../src/proposals/approval-reference-checks';
import { buildInvoice } from '../factories/invoice.factory';
import { buildEstimate } from '../factories/estimate.factory';
import { buildLineItem } from '../factories/line-item.factory';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../src/locations/location';
import { createJob } from '../../src/jobs/job';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';

const TEST_TENANT = '11111111-1111-4111-8111-111111111111';
const TEST_USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

type Classified = { intentType: string; entities?: Record<string, unknown> };

/**
 * Classifier calls are answered from `byText` (longest scripted text the
 * classified input contains); drafting calls from `drafts[<system prefix>]`.
 */
function scriptedGateway(byText: Record<string, Classified>, drafts: Record<string, string> = {}) {
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
          confidence: 0.92,
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
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER,
      sessionId: 'sess-1480',
      tenantId: TEST_TENANT,
      role: 'owner',
    };
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

beforeEach(() => {
  setSupervisorPresenceLoader(async () => true);
});
afterEach(() => {
  _resetSupervisorPresenceCache();
  vi.restoreAllMocks();
});

describe('#1480 item 4 — "X, and <verb> …" drafts every step as linked proposals', () => {
  // C23: no "then", so only the customer was drafted and the booking was
  // reported as "didn't draft".
  it('C23: add customer … and book her Thursday 9am → create_customer + linked create_appointment for that customer', async () => {
    const turn = 'Add customer Priya Nandakumar, phone 555-201-4411, and book her for an AC check Thursday at 9am.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway({
        [turn]: { intentType: 'create_customer', entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' } },
        'Add customer Priya Nandakumar, phone 555-201-4411': {
          intentType: 'create_customer',
          entities: { displayName: 'Priya Nandakumar', phone: '555-201-4411' },
        },
        'book her for an AC check Thursday at 9am': {
          intentType: 'create_appointment',
          entities: { customerName: 'her', dateTimeDescription: 'Thursday at 9am', jobTitle: 'AC check' },
        },
      }),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const persisted = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect(persisted.map((p) => p.proposalType)).toEqual(['create_customer', 'create_appointment']);
    expect(persisted[0].chainId).toBeTruthy();
    expect(persisted[1].chainId).toBe(persisted[0].chainId);
    // The booking is for the customer step 1 creates — filled when it runs.
    expect(persisted[1].payload.customerId).toBe('$ref:chain[0].customerId');
    const content: string = res.body.message.content;
    expect(content).toMatch(/2 linked steps/i);
    expect(content).not.toMatch(/didn't draft/i);
  });
});

describe('#1480 item 4 — a visit mentioned as context is not a booking step', () => {
  const ESTIMATE_LINES = JSON.stringify({
    lineItems: [
      { description: 'Blower motor', quantity: 1, unitPrice: 42500 },
      { description: 'Diagnostic visit', quantity: 1, unitPrice: 8900 },
    ],
    confidence_score: 0.9,
  });

  // "add a diagnostic visit" is a LINE on the estimate being drafted, not a
  // new appointment. Split on it, and the fragment classified on its own
  // reads like a booking.
  it('"draft an estimate … and add a diagnostic visit" is ONE estimate, with no appointment step', async () => {
    const turn = 'Draft an estimate for the Patel job for a blower motor and add a diagnostic visit.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'draft_estimate', entities: { customerName: 'Patel' } },
          'Draft an estimate for the Patel job for a blower motor': {
            intentType: 'draft_estimate',
            entities: { customerName: 'Patel' },
          },
          // What the fragment alone classifies as.
          'add a diagnostic visit': { intentType: 'create_appointment', entities: { jobTitle: 'diagnostic visit' } },
        },
        { 'You are an estimate generation assistant': ESTIMATE_LINES },
      ),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect((await proposalRepo.findByTenant(TEST_TENANT)).map((p) => p.proposalType)).toEqual(['draft_estimate']);
    expect(res.body.message.content).not.toMatch(/linked steps|didn't draft/i);
  });

  // A note ABOUT a visit is a note: it may be its own step, never a booking.
  it('"… and add a note about the visit" never becomes an appointment', async () => {
    const turn = 'Create an estimate for the Patel job and add a note about the visit.';
    const proposalRepo = new InMemoryProposalRepository();
    const app = buildApp({
      proposalRepo,
      gateway: scriptedGateway(
        {
          [turn]: { intentType: 'draft_estimate', entities: { customerName: 'Patel' } },
          'Create an estimate for the Patel job': { intentType: 'draft_estimate', entities: { customerName: 'Patel' } },
          'add a note about the visit': { intentType: 'add_note', entities: { noteText: 'about the visit' } },
        },
        { 'You are an estimate generation assistant': ESTIMATE_LINES },
      ),
    });

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    expect((await proposalRepo.findByTenant(TEST_TENANT)).map((p) => p.proposalType)).not.toContain(
      'create_appointment',
    );
  });
});

describe('#1480 item 4 — AST-04 "create an invoice for job X and send it"', () => {
  const JOB_ID = 'c73844bd-4928-4d1f-b8c5-f669ceb10018';
  const CUSTOMER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const INVOICE_DRAFT = JSON.stringify({
    lineItems: [{ description: 'Blower motor replacement', quantity: 1, unitPrice: 42500 }],
    confidence_score: 0.9,
  });
  const turn = 'Create an invoice for job JOB-0081 and send it.';

  async function draftCreateAndSend() {
    const proposalRepo = new InMemoryProposalRepository();
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    await jobRepo.create(buildJob({ id: JOB_ID, tenantId: TEST_TENANT, customerId: CUSTOMER_ID, jobNumber: 'JOB-0081' }));
    const app = buildApp({
      proposalRepo,
      jobRepo,
      invoiceRepo,
      gateway: scriptedGateway(
        {
          // The live C22/AST-04 turn classified as a send/issue of an invoice.
          [turn]: { intentType: 'issue_invoice', entities: { jobReference: 'JOB-0081' } },
          'Create an invoice for job JOB-0081': {
            intentType: 'create_invoice',
            entities: { jobReference: 'JOB-0081' },
          },
        },
        { 'You are an invoice generation assistant': INVOICE_DRAFT },
      ),
    });
    const res = await chat(app, turn);
    return { res, proposalRepo, invoiceRepo };
  }

  it('drafts the invoice on that job AND a linked send step for it, neither approved', async () => {
    const { res, proposalRepo } = await draftCreateAndSend();
    expect(res.status).toBe(200);
    const [invoice, send] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect([invoice?.proposalType, send?.proposalType]).toEqual(['draft_invoice', 'send_invoice']);
    expect(invoice.payload.jobId).toBe(JOB_ID);
    expect(send.chainId).toBe(invoice.chainId);
    expect(send.payload.invoiceId).toBe('$ref:chain[0].invoiceId');
    // Money / comms steps are never approved on the operator's behalf.
    expect(send.status).toBe('ready_for_review');
    expect(res.body.message.content).toMatch(/2 linked steps/i);
    expect(res.body.message.content).not.toMatch(/didn't draft/i);
  });

  it('the reply tells the operator what unlocks the send: approve the invoice, then issue it', async () => {
    const { res } = await draftCreateAndSend();
    expect(res.body.message.content).toMatch(/send unlocks once the invoice is approved and issued/i);
  });

  it('the send step cannot be approved while the invoice it sends does not exist yet', async () => {
    const { proposalRepo } = await draftCreateAndSend();
    const [, send] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    await expect(approveProposal(proposalRepo, TEST_TENANT, send.id, TEST_USER, 'owner')).rejects.toThrow(
      /approve step 1/i,
    );
    expect((await proposalRepo.findById(TEST_TENANT, send.id))?.status).toBe('ready_for_review');
  });

  /** Step 1 ran: its invoice exists (in `status`) and the proposal records it. */
  async function runInvoiceStep(
    proposalRepo: InMemoryProposalRepository,
    invoiceRepo: InMemoryInvoiceRepository,
    status: 'draft' | 'open',
  ) {
    const [invoiceStep, send] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    const invoice = await invoiceRepo.create(
      buildInvoice({ tenantId: TEST_TENANT, jobId: JOB_ID, estimateId: undefined, status }),
    );
    await proposalRepo.updateStatus(TEST_TENANT, invoiceStep.id, 'executed', { resultEntityId: invoice.id });
    return { send, invoice };
  }

  it('the send step unlocks once the invoice step has run and the invoice is issued', async () => {
    const { proposalRepo, invoiceRepo } = await draftCreateAndSend();
    const { send } = await runInvoiceStep(proposalRepo, invoiceRepo, 'open');
    const approved = await approveProposal(proposalRepo, TEST_TENANT, send.id, TEST_USER, 'owner', undefined, undefined, {
      referenceChecks: [invoiceReferenceCheck(invoiceRepo), invoiceSendableReferenceCheck(invoiceRepo)],
    });
    expect(approved.status).toBe('approved');
  });

  // Sending a draft invoice fails at execution ("still a draft — issue it"),
  // so the tap is refused with that next step instead (D-023: issuing is its
  // own approval).
  it('an invoice that exists but is still a draft keeps the send locked, and says to issue it', async () => {
    const { proposalRepo, invoiceRepo } = await draftCreateAndSend();
    const { send } = await runInvoiceStep(proposalRepo, invoiceRepo, 'draft');
    await expect(
      approveProposal(proposalRepo, TEST_TENANT, send.id, TEST_USER, 'owner', undefined, undefined, {
        referenceChecks: [invoiceReferenceCheck(invoiceRepo), invoiceSendableReferenceCheck(invoiceRepo)],
      }),
    ).rejects.toThrow(/still a draft.*issue it/i);
  });
});

describe('#1480 item 4 — AST-07 customer → estimate → create-and-send invoice', () => {
  const LINES = JSON.stringify({
    lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 120000 }],
    confidence_score: 0.9,
  });
  const turn =
    'New customer Jane Smith, phone 555-0101, then draft an estimate for her for a water heater install at $1200, then create and send the invoice.';

  function ast07App(proposalRepo: InMemoryProposalRepository) {
    const gateway = scriptedGateway(
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
        'create the invoice.': { intentType: 'create_invoice', entities: {} },
      },
      {
        'You are an estimate generation assistant': LINES,
        'You are an invoice generation assistant': LINES,
      },
    );
    return { app: buildApp({ proposalRepo, gateway, invoiceRepo: new InMemoryInvoiceRepository() }), gateway };
  }

  it('drafts the customer, the estimate, the invoice and its send as ONE chain, each wired to the step it needs', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const { app } = ast07App(proposalRepo);

    const res = await chat(app, turn);
    expect(res.status).toBe(200);
    const steps = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    expect(steps.map((p) => p.proposalType)).toEqual([
      'create_customer',
      'draft_estimate',
      'draft_invoice',
      'send_invoice',
    ]);
    expect(new Set(steps.map((p) => p.chainId)).size).toBe(1);
    // "for her" / "the invoice" are the customer step 1 creates, the
    // estimate step 2 drafts, and the invoice step 3 drafts.
    expect(steps[1].payload.customerId).toBe('$ref:chain[0].customerId');
    expect(steps[2].payload.customerId).toBe('$ref:chain[0].customerId');
    expect(steps[2].payload.estimateId).toBe('$ref:chain[1].estimateId');
    expect(steps[3].payload.invoiceId).toBe('$ref:chain[2].invoiceId');
    expect(res.body.message.content).toMatch(/4 linked steps/i);
    expect(res.body.message.content).not.toMatch(/didn't draft/i);
  });

  // Money correctness: the invoice step's own clause ("create the invoice")
  // names no work, so whatever the drafting model wrote for it is a guess.
  // Once the estimate step has run, the invoice bills THAT estimate — its
  // lines, discount and tax — exactly as convert-to-invoice would.
  it('executing the chained invoice bills the estimate the chain produced: its lines, discount and tax, not the drafted guess', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const jobRepo = new InMemoryJobRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const locationRepo = new InMemoryLocationRepository();
    const gateway = scriptedGateway(
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
        'create the invoice.': { intentType: 'create_invoice', entities: {} },
      },
      {
        'You are an estimate generation assistant': LINES,
        // The model's guess for a clause that names no work.
        'You are an invoice generation assistant': JSON.stringify({
          lineItems: [{ description: 'Service call', quantity: 1, unitPrice: 8900 }],
          confidence_score: 0.9,
        }),
      },
    );
    const app = buildApp({ proposalRepo, gateway, invoiceRepo, jobRepo });
    expect((await chat(app, turn)).status).toBe(200);
    const [customerStep, estimateStep, invoiceStep] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));

    // Steps 1 and 2 ran: the customer, the job the estimate opened, and the
    // estimate as it was saved — two lines, a $50 discount, 8.6% tax.
    const customer = await createCustomer(
      { tenantId: TEST_TENANT, firstName: 'Jane', lastName: 'Smith', createdBy: TEST_USER },
      customerRepo,
    );
    const location = await createLocation(
      { tenantId: TEST_TENANT, customerId: customer.id, street1: '1 Main St', city: 'Mesa', state: 'AZ', postalCode: '85201', isPrimary: true },
      locationRepo,
    );
    const job = await createJob(
      { tenantId: TEST_TENANT, customerId: customer.id, locationId: location.id, summary: 'Water heater install', createdBy: TEST_USER },
      jobRepo,
    );
    const estimateLines = [
      buildLineItem({ description: 'Water heater (50 gal)', quantity: 1, unitPriceCents: 95_000, totalCents: 95_000, sortOrder: 0 }),
      buildLineItem({ description: 'Install labor', quantity: 1, unitPriceCents: 25_000, totalCents: 25_000, sortOrder: 1 }),
    ];
    const estimate = await estimateRepo.create(
      buildEstimate({
        tenantId: TEST_TENANT,
        jobId: job.id,
        lineItems: estimateLines,
        totals: calculateDocumentTotals(estimateLines, 5_000, 860),
      }),
    );
    await proposalRepo.updateStatus(TEST_TENANT, customerStep.id, 'executed', { resultEntityId: customer.id });
    await proposalRepo.updateStatus(TEST_TENANT, estimateStep.id, 'executed', { resultEntityId: estimate.id });

    // Step 3: the operator approves the invoice; it executes past its undo window.
    await approveProposal(proposalRepo, TEST_TENANT, invoiceStep.id, TEST_USER, 'owner');
    const approved = await proposalRepo.updateStatus(TEST_TENANT, invoiceStep.id, 'approved', {
      approvedAt: new Date(Date.now() - 60_000),
    });
    const executor = new ProposalExecutor(
      createExecutionHandlerRegistry({ invoiceRepo, estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo: seededSettings() }),
      proposalRepo,
      new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo),
      new InMemoryAuditRepository(),
    );
    const { result } = await executor.execute(approved!, { tenantId: TEST_TENANT, executedBy: TEST_USER });

    expect(result.success).toBe(true);
    const invoice = await invoiceRepo.findById(TEST_TENANT, result.resultEntityId!);
    expect(invoice?.estimateId).toBe(estimate.id);
    expect(invoice?.jobId).toBe(job.id);
    expect(invoice?.lineItems.map((li) => [li.description, li.quantity, li.unitPriceCents])).toEqual([
      ['Water heater (50 gal)', 1, 95_000],
      ['Install labor', 1, 25_000],
    ]);
    // $1,200.00 − $50.00 = $1,150.00; 8.6% tax on that is $98.90.
    expect(invoice?.totals.discountCents).toBe(5_000);
    expect(invoice?.totals.taxRateBps).toBe(860);
    expect(invoice?.totals.totalCents).toBe(124_890);
  });

  // #1490/#1491 — one invoice per estimate. A chained invoice names its
  // estimate through a chain token, which the reference check skips; once the
  // estimate step has run, the tap must see the real estimate and refuse a
  // second invoice for it.
  it('an estimate that is already invoiced keeps the chained invoice from approving', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    const { app } = ast07App(proposalRepo);
    expect((await chat(app, turn)).status).toBe(200);
    const [customerStep, estimateStep, invoiceStep] = byChainIndex(await proposalRepo.findByTenant(TEST_TENANT));
    const JOB = 'abababab-abab-4bab-8bab-abababababab';
    const estimate = await estimateRepo.create(buildEstimate({ tenantId: TEST_TENANT, jobId: JOB }));
    await invoiceRepo.create(buildInvoice({ tenantId: TEST_TENANT, jobId: JOB, estimateId: estimate.id }));
    await proposalRepo.updateStatus(TEST_TENANT, customerStep.id, 'executed', {
      resultEntityId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    });
    await proposalRepo.updateStatus(TEST_TENANT, estimateStep.id, 'executed', { resultEntityId: estimate.id });

    await expect(
      approveProposal(proposalRepo, TEST_TENANT, invoiceStep.id, TEST_USER, 'owner', undefined, undefined, {
        referenceChecks: [estimateInvoicedReferenceCheck({ estimateRepo, invoiceRepo })],
      }),
    ).rejects.toThrow(/already invoiced/i);
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
